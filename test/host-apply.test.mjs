// Cordis host-entry smoke test. In real DSH, plugin configuration is passed as
// apply(ctx, config); ctx.config is an injected service accessor and reading it
// without declaring an injection aborts the whole plugin tree.
// Covers: route registration, balance schema (ok/stale/error — one shape),
// singleflight concurrency, cost snapshot shape (root/descendants/partial),
// the legal costCny === 0, and the removal of the USD/CNY third-party rate.
import { apply } from "../lib/index.js";

let failures = 0;
function check(name, condition, detail = "") {
  console.log(`${condition ? "PASS" : "FAIL"}: ${name}${!condition && detail ? ` — ${detail}` : ""}`);
  if (!condition) failures += 1;
}

const routes = new Map();
const smokeSession = { events: [], header: { id: "session-smoke" } };
let sessionListCalls = 0;
const ctx = {
  get config() {
    throw new Error("ctx.config must never be read");
  },
  credentials: { resolve: async () => null },
  sessions: {
    list: () => { sessionListCalls += 1; return []; },
    get: (id) => id === "session-smoke" ? smokeSession : void 0,
  },
  webServer: {
    register(route) {
      routes.set(route.path, route.handler);
      return () => routes.delete(route.path);
    },
  },
  inject() {
    // sessionPersistence is optional; the smoke test leaves it absent.
  },
  effect(factory, label) {
    // Avoid the startup pricing fetch; execute only deterministic route setup.
    if (label.includes(" route")) return factory();
    return () => {};
  },
};

apply(ctx, { dailyBudgetCny: 20, monthlyBudgetCny: 100 });
check("host apply does not read uninjected ctx.config", true);
check("all host routes register", routes.size === 4, JSON.stringify([...routes.keys()]));

// No third-party rate endpoint may be touched anymore: /balance needs only
// the provider upstream.
globalThis.fetch = async () => {
  throw new Error("unexpected fetch — the USD/CNY rate sources were removed");
};

async function callRoute(path, query = "") {
  return new Promise((resolve) => {
    let status = null;
    let body = null;
    const handler = routes.get(path);
    handler(
      { url: path + query },
      {
        writeHead(s) { status = s; },
        end(payload) { body = JSON.parse(payload); resolve({ status, body }); },
      },
    );
  });
}

const live = await callRoute("/plugins/better-stats/live", "?sessionId=session-smoke");
check("live route responds", live.status === 200, String(live.status));
check(
  "Cordis config reaches budget payload",
  live.body?.budget?.daily === 20 && live.body?.budget?.monthly === 100,
  JSON.stringify(live.body?.budget),
);
check("balance alert defaults to two tiers (warn 20 / critical 5)",
  live.body?.budget?.balanceWarnCny === 20 && live.body?.budget?.balanceCriticalCny === 5,
  JSON.stringify(live.body?.budget));
check("live route carries pricing + rootCostCny + invalidSteps",
  live.body?.pricing?.source === "builtin" && live.body?.rootCostCny === 0 &&
  live.body?.rootUsage?.outputTokens === 0 && live.body?.eventRevision === 0 &&
  live.body?.unpricedSteps === 0 && live.body?.invalidSteps === 0,
  JSON.stringify({ pricing: live.body?.pricing, rootCostCny: live.body?.rootCostCny }));

sessionListCalls = 0;
const [cost, concurrentCost] = await Promise.all([
  callRoute("/plugins/better-stats/cost", "?sessionId=session-smoke"),
  callRoute("/plugins/better-stats/cost", "?sessionId=session-smoke")
]);
check("concurrent cost requests share one versioned tree query",
  concurrentCost.status === 200 && sessionListCalls === 1 &&
  concurrentCost.body?.pricingVersion === concurrentCost.body?.pricing?.version,
  JSON.stringify({ listCalls: sessionListCalls, version: concurrentCost.body?.pricingVersion, pricing: concurrentCost.body?.pricing?.version }));
check("cost route responds for an empty session (legal costCny === 0)",
  cost.status === 200 && cost.body?.costCny === 0 && cost.body?.descendantCount === 0,
  JSON.stringify({ status: cost.status, costCny: cost.body?.costCny }));
check("cost route carries the root/descendants split",
  cost.body?.root?.costCny === 0 && cost.body?.descendants?.costCny === 0 &&
  Array.isArray(cost.body?.models) && cost.body?.merged?.outputTokens === 0,
  JSON.stringify({ root: cost.body?.root, desc: cost.body?.descendants }));
check("cost route accounting fields",
  cost.body?.partial === false && cost.body?.failedSessionCount === 0 &&
  cost.body?.persistenceAvailable === false && cost.body?.foldedSessionCount === 1 &&
  typeof cost.body?.pricingVersion === "number" && typeof cost.body?.eventRevision === "number" &&
  cost.body?.rootEventRevision === 0 && cost.body?.eventRevision === 0 &&
  cost.body?.pricingVersion === cost.body?.pricing?.version && typeof cost.body?.queriedAt === "string",
  JSON.stringify({ partial: cost.body?.partial, persistenceAvailable: cost.body?.persistenceAvailable }));
check("cost route carries pricing + budget",
  cost.body?.pricing?.source === "builtin" && cost.body?.budget?.daily === 20,
  JSON.stringify({ pricing: cost.body?.pricing, budget: cost.body?.budget }));

sessionListCalls = 0;
const [today, concurrentToday] = await Promise.all([
  callRoute("/plugins/better-stats/today"),
  callRoute("/plugins/better-stats/today")
]);
check("concurrent today requests share one date/version query",
  concurrentToday.status === 200 && sessionListCalls === 1 &&
  concurrentToday.body?.pricingVersion === concurrentToday.body?.pricing?.version,
  JSON.stringify({ listCalls: sessionListCalls, version: concurrentToday.body?.pricingVersion, pricing: concurrentToday.body?.pricing?.version }));
check("today route responds with zero spend",
  today.status === 200 && today.body?.costCny === 0 && today.body?.monthCostCny === 0,
  JSON.stringify(today));
check("today route reports the Beijing date + pricing/budget metadata",
  /^\d{4}-\d{2}-\d{2}$/.test(today.body?.date ?? "") &&
  today.body?.pricing?.source === "builtin" && today.body?.budget?.daily === 20,
  JSON.stringify({ date: today.body?.date, pricing: today.body?.pricing, budget: today.body?.budget }));

const realDateNow = Date.now;
let fakeNow = Date.UTC(2026, 7, 19, 15, 59, 59); // 2026-08-19 23:59:59 Beijing
Date.now = () => fakeNow;
try {
  sessionListCalls = 0;
  const beforeMidnight = callRoute("/plugins/better-stats/today");
  fakeNow += 2000; // 2026-08-20 00:00:01 Beijing, while the first promise is pending
  const afterMidnight = callRoute("/plugins/better-stats/today");
  const [before, after] = await Promise.all([beforeMidnight, afterMidnight]);
  check("today singleflight is isolated across Beijing midnight",
    before.body?.date === "2026-08-19" && after.body?.date === "2026-08-20" && sessionListCalls === 2,
    JSON.stringify({ before: before.body?.date, after: after.body?.date, listCalls: sessionListCalls }));
} finally {
  Date.now = realDateNow;
}
const todayBeforeReapply = await callRoute("/plugins/better-stats/today");
check("today cache returns to the current Beijing date after the rollover test",
  todayBeforeReapply.body?.date === new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10) &&
  todayBeforeReapply.body?.cached === false,
  JSON.stringify({ date: todayBeforeReapply.body?.date, cached: todayBeforeReapply.body?.cached }));

const balance = await callRoute("/plugins/better-stats/balance");
check("balance route degrades without a key (status ok, unified schema)",
  balance.status === 200 && balance.body?.configured === false && balance.body?.status === "ok" &&
  balance.body?.amount === null && balance.body?.amountDecimals === null && balance.body?.currency === null &&
  balance.body?.pricing?.source === "builtin" && balance.body?.budget?.daily === 20 &&
  balance.body?.usdCnyRate === void 0,
  JSON.stringify(balance.body));

// Force-refresh path with singleflight: two CONCURRENT first misses must share
// ONE upstream query; ?force=1 bypasses the cache with a 2s anti-flood
// cooldown between forced queries.
const realResolve = ctx.credentials.resolve;
let upstreamCalls = 0;
let activeKey = "test-key";
const seenAuthorization = [];
ctx.credentials.resolve = async () => ({ value: activeKey });
globalThis.fetch = async (url, options) => {
  if (String(url).includes("user/balance")) {
    upstreamCalls += 1;
    const authorization = options?.headers?.Authorization;
    seenAuthorization.push(authorization);
    if (authorization === "Bearer bad-key") {
      return { ok: true, json: async () => ({ balance_infos: [{ currency: "CNY", total_balance: null }] }) };
    }
    const info = authorization === "Bearer other-key"
      ? { currency: "CNY", total_balance: "9.875", granted_balance: "0.125", topped_up_balance: "9.750" }
      : { currency: "CNY", total_balance: "42.50", granted_balance: "2.50", topped_up_balance: "40.00" };
    return { ok: true, json: async () => ({ balance_infos: [info] }) };
  }
  throw new Error("unexpected fetch " + url);
};
{
  const [a, b] = await Promise.all([
    callRoute("/plugins/better-stats/balance"),
    callRoute("/plugins/better-stats/balance"),
  ]);
  check("concurrent first balance requests share ONE upstream call (singleflight)",
    a.body?.status === "ok" && b.body?.status === "ok" && a.body?.amount === 42.5 &&
    a.body?.amountDecimals === 2 && b.body?.amountDecimals === 2 &&
    a.body?.pricing?.source === "builtin" && a.body?.budget?.daily === 20 && upstreamCalls === 1,
    `upstreamCalls=${upstreamCalls}`);
}
const forced = await callRoute("/plugins/better-stats/balance", "?force=1");
check("force=1 queries upstream",
  forced.body?.status === "ok" && forced.body?.amount === 42.5 && forced.body?.amountDecimals === 2 && upstreamCalls === 2,
  JSON.stringify(forced.body));
const forced2 = await callRoute("/plugins/better-stats/balance", "?force=1");
check("force cooldown serves the cache as status stale (same schema)",
  forced2.body?.status === "stale" && forced2.body?.configured === true &&
  forced2.body?.amount === 42.5 && forced2.body?.provider === "deepseek-official" &&
  typeof forced2.body?.queriedAt === "string" && upstreamCalls === 2,
  JSON.stringify(forced2.body));
const cached2 = await callRoute("/plugins/better-stats/balance");
check("plain balance reuses the fresh cache",
  cached2.body?.status === "ok" && cached2.body?.amount === 42.5 && upstreamCalls === 2,
  "upstreamCalls=" + upstreamCalls);

activeKey = "other-key";
const other = await callRoute("/plugins/better-stats/balance");
check("balance cache is isolated when credentials change",
  other.body?.status === "ok" && other.body?.amount === 9.875 && other.body?.amountDecimals === 3 &&
  upstreamCalls === 3 && seenAuthorization.at(-1) === "Bearer other-key",
  JSON.stringify({ body: other.body, upstreamCalls, seenAuthorization }));
const otherForced = await callRoute("/plugins/better-stats/balance", "?force=1");
check("force cooldown is isolated per credential",
  otherForced.body?.status === "ok" && otherForced.body?.amount === 9.875 && upstreamCalls === 4,
  JSON.stringify({ body: otherForced.body, upstreamCalls, seenAuthorization }));

activeKey = "test-key";
const firstCredentialAgain = await callRoute("/plugins/better-stats/balance");
check("switching back reuses only that credential's own cache",
  firstCredentialAgain.body?.status === "ok" && firstCredentialAgain.body?.amount === 42.5 &&
  firstCredentialAgain.body?.amountDecimals === 2 && upstreamCalls === 4,
  JSON.stringify({ body: firstCredentialAgain.body, upstreamCalls }));

activeKey = "bad-key";
const invalidBalance = await callRoute("/plugins/better-stats/balance");
check("null provider balances are errors, never coerced to zero",
  invalidBalance.body?.status === "error" && invalidBalance.body?.amount === null &&
  invalidBalance.body?.amountDecimals === null && invalidBalance.body?.pricing?.source === "builtin" &&
  upstreamCalls === 5,
  JSON.stringify(invalidBalance.body));
ctx.credentials.resolve = realResolve;

const OFF_PEAK = Date.UTC(2026, 7, 18, 0, 59);
smokeSession.events.push(
  { type: "request/context", time: OFF_PEAK - 1, data: { provider: "deepseek", model: "deepseek-v4-pro" } },
  { type: "assistant/chunk", time: OFF_PEAK, data: { turn: 1, step: 1, chunk: { type: "usage", usage: { outputTokens: 1000 } } } }
);
const liveUpdated = await callRoute("/plugins/better-stats/live", "?sessionId=session-smoke");
check("live revision and root usage/cost move together after an append",
  liveUpdated.body?.eventRevision === 2 && liveUpdated.body?.rootUsage?.outputTokens === 1000 &&
  Math.abs(liveUpdated.body?.rootCostCny - 0.0135) < 1e-12 &&
  liveUpdated.body?.models?.[0]?.model === "deepseek-v4-pro",
  JSON.stringify({ revision: liveUpdated.body?.eventRevision, usage: liveUpdated.body?.rootUsage, cost: liveUpdated.body?.rootCostCny, models: liveUpdated.body?.models }));

// Re-apply with custom tiers: routes re-register (Map upsert), the new
// config must win; tiers can also be disabled with 0.
apply(ctx, { balanceWarnCny: 30, balanceCriticalCny: 0 });
const live2 = await callRoute("/plugins/better-stats/live", "?sessionId=session-smoke");
check("custom balance tiers override the defaults",
  live2.body?.budget?.balanceWarnCny === 30 && live2.body?.budget?.balanceCriticalCny === 0 &&
  live2.body?.budget?.daily === void 0 && live2.body?.budget?.monthly === void 0,
  JSON.stringify(live2.body?.budget));
sessionListCalls = 0;
const todayAfterReapply = await callRoute("/plugins/better-stats/today");
check("a new plugin instance does not inherit the previous today cache",
  todayAfterReapply.body?.cached === false && sessionListCalls === 1,
  JSON.stringify({ cached: todayAfterReapply.body?.cached, listCalls: sessionListCalls }));
const balanceAfterReapply = await callRoute("/plugins/better-stats/balance");
check("a new plugin instance does not inherit the previous balance cache",
  balanceAfterReapply.body?.configured === false && balanceAfterReapply.body?.amount === null &&
  balanceAfterReapply.body?.amountDecimals === null,
  JSON.stringify(balanceAfterReapply.body));

if (failures > 0) {
  console.error(`\n${failures} HOST APPLY CHECK(S) FAILED`);
  process.exit(1);
}
console.log("\nALL HOST APPLY CHECKS PASSED");
