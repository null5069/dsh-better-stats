// dsh-better-stats — host half: proxy DeepSeek account balance and provide a
// USD→CNY reference rate so the client can show cost in the same currency as
// the provider balance.
//
// Serves GET /plugins/better-stats/balance:
//   { configured, status, provider, displayName, amount, currency,
//     usdCnyRate, queriedAt }
// The API key is resolved through the DSH credentials seam (DEEPSEEK_API_KEY:
// env / .credentials.yaml / .env) and never leaves the server. Responses are
// cached 60s; failures are reported as status:"error" instead of throwing.
// The rate comes from a free no-key endpoint, cached 1h, falling back to a
// fixed constant when unreachable.

const BALANCE_URL = "https://api.deepseek.com/user/balance";
// Free no-key USD→CNY rate sources, tried in order.
const RATE_SOURCES = [
  "https://api.frankfurter.dev/v1/latest?base=USD&symbols=CNY",
  "https://open.er-api.com/v6/latest/USD",
  "https://api.frankfurter.app/latest?from=USD&to=CNY"
];
const API_KEY_ENV = "DEEPSEEK_API_KEY";
const CACHE_TTL_MS = 15000;
const RATE_TTL_MS = 3600000;
const RATE_FALLBACK_TTL_MS = 300000;
const FALLBACK_USD_CNY = 7.2;
const PROVIDER_LABELS = {
  deepseek: "DeepSeek",
  "deepseek-official": "DeepSeek 官方"
};

let cached = null; // { at, data }
let rateCache = null; // { at, rate }
let costCache = null; // { at, sessionId, data }

async function queryBalance(key) {
  const response = await fetch(BALANCE_URL, {
    headers: { Authorization: "Bearer " + key, Accept: "application/json" },
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) throw new Error("provider http " + response.status);
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error("provider returned invalid json");
  }
  const infos = payload && Array.isArray(payload.balance_infos) ? payload.balance_infos : [];
  const first = infos.find((item) => item && Number(item.total_balance) !== void 0 && Number.isFinite(Number(item.total_balance)));
  if (first === void 0) throw new Error("provider returned no balance");
  const toNumOrNull = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  return {
    provider: "deepseek-official",
    displayName: PROVIDER_LABELS["deepseek-official"],
    amount: Number(first.total_balance),
    currency: typeof first.currency === "string" && first.currency !== "" ? first.currency : "CNY",
    // P1-4: granted/topped-up split (missing fields degrade gracefully).
    grantedBalance: toNumOrNull(first.granted_balance),
    toppedUpBalance: toNumOrNull(first.topped_up_balance)
  };
}

async function queryUsdCnyRate() {
  let lastError;
  for (const url of RATE_SOURCES) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(4000) });
      if (!response.ok) throw new Error("rate http " + response.status);
      const payload = await response.json();
      const rate = Number(payload?.rates?.CNY);
      if (!Number.isFinite(rate) || rate <= 0) throw new Error("rate missing");
      return rate;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error("no rate source");
}

async function usdCnyRate() {
  const now = Date.now();
  if (rateCache !== null) {
    const ttl = rateCache.fallback ? RATE_FALLBACK_TTL_MS : RATE_TTL_MS;
    if (now - rateCache.at < ttl) return rateCache.rate;
  }
  try {
    const rate = await queryUsdCnyRate();
    rateCache = { at: now, rate };
    return rate;
  } catch {
    // Cache the fallback too (short TTL) so an unreachable rate source is
    // not re-probed on every request — that would stall responses and make
    // the client time out.
    rateCache = { at: now, rate: FALLBACK_USD_CNY, fallback: true };
    return FALLBACK_USD_CNY;
  }
}

// ── tree-merged token usage (host side) ────────────────────────────────────
// The client-side merge only sees sessions THIS browser has opened, so
// subagent usage was silently undercounted. Here we fold every descendant
// session's log directly from the store, so the displayed cost covers the
// whole subagent tree regardless of what the client ever loaded.

// ── Official DeepSeek pricing, CNY per 1M tokens ───────────────────────────
// Source: https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
// Two models in the current lineup; v4-pro is exactly 3× v4-flash:
//   deepseek-v4-flash: 输入(缓存命中) ¥0.05/¥0.10, 输入(未命中) ¥1.5/¥3.0,
//                      输出 ¥4.5/¥9.0
//   deepseek-v4-pro:   输入(缓存命中) ¥0.15/¥0.30, 输入(未命中) ¥4.5/¥9.0,
//                      输出 ¥13.5/¥27.0
// 高峰(北京 9:00-12:00 / 14:00-18:00) 为两倍, 其余为空闲. Each step is
// priced by the MODEL that produced it (assistant/message source model), so
// switching models mid-session is accounted per message.
// The provider bills in CNY; the balance endpoint also reports CNY, so cost
// and balance share one currency and one price table.
// Since v20 the tables are no longer hard-coded: the host re-parses the
// official pricing page every 6h (fetchOfficialPricing); on any parse/network
// failure it keeps the last good tables (source "stale") or falls back to the
// builtin table below (source "builtin"). Every route response carries a
// `pricing` payload so the client can show the source and never needs its own
// copy of the numbers.
const BUILTIN_TABLES = {
  "deepseek-v4-flash": { miss: 1.5, read: 0.05, out: 4.5, missPeak: 3.0, readPeak: 0.1, outPeak: 9.0 },
  "deepseek-v4-pro": { miss: 4.5, read: 0.15, out: 13.5, missPeak: 9.0, readPeak: 0.3, outPeak: 27.0 }
};
const DEFAULT_MODEL = "deepseek-v4-flash";
const PRICING_URL = "https://api-docs.deepseek.com/zh-cn/quick_start/pricing/";
const PRICING_TTL_MS = 6 * 3600 * 1000;
const PRICING_FETCH_TIMEOUT_MS = 8000;

// Row order on the official page (one table, models as columns):
//   百万tokens输入（缓存命中） 空闲时段 0.05元 0.15元 高峰时段 0.10元 0.30元
//   百万tokens输入（缓存未命中） 空闲时段 1.5元 4.5元   高峰时段 3.0元 9.0元
//   百万tokens输出            空闲时段 4.5元 13.5元 高峰时段 9.0元 27.0元
// Columns are flash then pro; captures are
//   readOff(flash,pro) readPeak(flash,pro) missOff(flash,pro) missPeak(flash,pro)
//   outOff(flash,pro) outPeak(flash,pro).
const PRICING_RE = /百万tokens输入（缓存命中）\s*空闲时段\s*([\d.]+)元\s*([\d.]+)元\s*高峰时段\s*([\d.]+)元\s*([\d.]+)元\s*百万tokens输入（缓存未命中）\s*空闲时段\s*([\d.]+)元\s*([\d.]+)元\s*高峰时段\s*([\d.]+)元\s*([\d.]+)元\s*百万tokens输出\s*空闲时段\s*([\d.]+)元\s*([\d.]+)元\s*高峰时段\s*([\d.]+)元\s*([\d.]+)元/;

// pricing state: tables = null until the first successful official fetch.
let pricingState = {
  tables: null, // official tables once fetched; null = builtin fallback
  fetchedAt: 0,
  lastErrorAt: 0,
  inFlight: null
};

// Extract the twelve official numbers from the pricing page's article text.
// Returns the tables object, or null on any structural surprise (never
// throws) — the caller falls back to the builtin table.
function parsePricingHtml(html) {
  try {
    if (typeof html !== "string" || html === "") return null;
    const article = html.match(/<article[\s\S]*?<\/article>/);
    const scope = article !== null ? article[0] : html;
    const text = scope
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;|&#160;/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    // The page must still list the two models we price; otherwise bail.
    if (text.indexOf("deepseek-v4-flash") === -1 || text.indexOf("deepseek-v4-pro") === -1) return null;
    const got = text.match(PRICING_RE);
    if (got === null) return null;
    const nums = got.slice(1).map(Number);
    if (nums.length !== 12 || nums.some((n) => !Number.isFinite(n) || n <= 0)) return null;
    const [readOffF, readOffP, readPeakF, readPeakP, missOffF, missOffP, missPeakF, missPeakP, outOffF, outOffP, outPeakF, outPeakP] = nums;
    const tables = {
      "deepseek-v4-flash": { miss: missOffF, read: readOffF, out: outOffF, missPeak: missPeakF, readPeak: readPeakF, outPeak: outPeakF },
      "deepseek-v4-pro": { miss: missOffP, read: readOffP, out: outOffP, missPeak: missPeakP, readPeak: readPeakP, outPeak: outPeakP }
    };
    // sanity: 命中 < 未命中 < 输出, and peak is (roughly) 2× off-peak
    const sane = (t) =>
      t.read > 0 && t.miss > t.read && t.out > t.miss &&
      Math.abs(t.readPeak - t.read * 2) < 1e-9 &&
      Math.abs(t.missPeak - t.miss * 2) < 1e-9 &&
      Math.abs(t.outPeak - t.out * 2) < 1e-9;
    if (!sane(tables["deepseek-v4-flash"]) || !sane(tables["deepseek-v4-pro"])) return null;
    return tables;
  } catch {
    return null;
  }
}

async function fetchOfficialPricing() {
  const response = await fetch(PRICING_URL, {
    headers: { Accept: "text/html" },
    signal: AbortSignal.timeout(PRICING_FETCH_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error("pricing http " + response.status);
  const html = await response.text();
  const tables = parsePricingHtml(html);
  if (tables === null) throw new Error("pricing page changed structure");
  return tables;
}

// Background refresh (never awaited by request handlers — the response always
// carries the current best tables). On failure the last good tables are kept
// and the payload reports source "stale" instead of "official".
function refreshPricing() {
  if (pricingState.inFlight !== null) return pricingState.inFlight;
  pricingState.inFlight = (async () => {
    try {
      const tables = await fetchOfficialPricing();
      pricingState.tables = tables;
      pricingState.fetchedAt = Date.now();
      pricingState.lastErrorAt = 0;
    } catch {
      pricingState.lastErrorAt = Date.now();
    } finally {
      pricingState.inFlight = null;
    }
  })();
  return pricingState.inFlight;
}

// Kick a refresh when the cached tables are missing or older than the TTL;
// requests never wait for it.
function ensurePricing() {
  const now = Date.now();
  const fresh = pricingState.tables !== null && now - pricingState.fetchedAt < PRICING_TTL_MS;
  const due = pricingState.tables === null || now - pricingState.fetchedAt >= PRICING_TTL_MS;
  if (!fresh && due) refreshPricing();
  return pricingPayload();
}

function pricingPayload() {
  if (pricingState.tables === null) {
    return { source: "builtin", fetchedAt: null, tables: BUILTIN_TABLES };
  }
  const stale = pricingState.lastErrorAt > pricingState.fetchedAt &&
    Date.now() - pricingState.fetchedAt >= PRICING_TTL_MS;
  return {
    source: stale ? "stale" : "official",
    fetchedAt: new Date(pricingState.fetchedAt).toISOString(),
    tables: pricingState.tables
  };
}

// Three-state model classification (v20): an unrecognized/missing model is
// "unknown" — its tokens still count toward the usage totals but are NOT
// priced, and every such step is counted in foldUsage's unpricedSteps so the
// UI can mark the amount as approximate.
function modelKeyOf(model) {
  if (typeof model === "string") {
    if (model.indexOf("v4-pro") !== -1) return "deepseek-v4-pro";
    if (model.indexOf("v4-flash") !== -1) return "deepseek-v4-flash";
  }
  return "unknown";
}

function beijingPeak(epochMs) {
  const d = new Date((epochMs || Date.now()) + 8 * 3600 * 1000);
  const h = d.getUTCHours();
  return (h >= 9 && h < 12) || (h >= 14 && h < 18);
}

// CNY cost of a usage bucket at a given moment's tier; unknown models (and
// models missing from the active table) price at 0 — they are counted by the
// caller's unpricedSteps instead.
function priceBuckets(buckets, time, model, tables) {
  const peak = beijingPeak(time);
  const table = (tables || BUILTIN_TABLES)[modelKeyOf(model)];
  if (table === void 0 || table === null) return 0;
  const miss = peak ? table.missPeak : table.miss;
  const read = peak ? table.readPeak : table.read;
  const out = peak ? table.outPeak : table.out;
  return (
    ((buckets.uncachedInputTokens + buckets.cacheWriteTokens) * miss +
      buckets.cacheReadTokens * read +
      buckets.outputTokens * out) / 1e6
  );
}

// Mirrors @deepseek-ai/dsh-token-meter's tokenUsage projection fold: per
// turn/step the LATEST usage sample replaces the earlier one (no double
// counting), summed across the log. Also prices each step's final sample at
// its OWN event time (peak/off-peak) and model, so the CNY cost is exact per
// step even across mid-session model switches.
// opts.sinceMs: only samples at/after that timestamp are counted (used by the
// "today" fold). Unknown-model samples count into `totals` but price at 0 and
// increment `unpricedSteps`.
function foldUsage(events, opts) {
  const sinceMs = opts !== void 0 && typeof opts.sinceMs === "number" ? opts.sinceMs : 0;
  const tables = pricingState.tables !== null ? pricingState.tables : BUILTIN_TABLES;
  const totals = { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
  const samples = new Map(); // "turn:step" → { buckets, time, model }
  for (const e of events) {
    if (e === void 0 || typeof e !== "object" || e === null) continue;
    let turn;
    let step;
    let usage;
    let model;
    if (e.type === "assistant/chunk" && e.data && e.data.chunk && e.data.chunk.type === "usage") {
      turn = e.data.turn;
      step = e.data.step;
      usage = e.data.chunk.usage;
    } else if (e.type === "assistant/message" && e.data && e.data.usage !== void 0) {
      turn = e.data.turn;
      step = e.data.step;
      usage = e.data.usage;
      model = e.data.message && e.data.message.source ? e.data.message.source.model : void 0;
    } else {
      continue;
    }
    if (usage === void 0 || typeof usage !== "object" || usage === null) continue;
    if (sinceMs > 0 && (!Number.isFinite(e.time) || e.time < sinceMs)) continue;
    const buckets = {
      uncachedInputTokens: Number(usage.inputTokens) || 0,
      outputTokens: Number(usage.outputTokens) || 0,
      cacheReadTokens: Number(usage.cacheReadTokens) || 0,
      cacheWriteTokens: Number(usage.cacheWriteTokens) || 0
    };
    samples.set(turn + ":" + step, { buckets, time: e.time, model });
  }
  const byModel = new Map(); // model key → { usage: totals, costCny }
  let unpricedSteps = 0;
  for (const sample of samples.values()) {
    mergeTotals(totals, sample.buckets);
    const key = modelKeyOf(sample.model);
    if (key === "unknown") unpricedSteps += 1;
    const entry = byModel.get(key) ?? { usage: { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }, costCny: 0 };
    mergeTotals(entry.usage, sample.buckets);
    entry.costCny += priceBuckets(sample.buckets, sample.time, sample.model, tables);
    byModel.set(key, entry);
  }
  let costCny = 0;
  for (const entry of byModel.values()) costCny += entry.costCny;
  return { totals, costCny, byModel, unpricedSteps };
}

function mergeTotals(target, source) {
  target.uncachedInputTokens += source.uncachedInputTokens;
  target.cacheReadTokens += source.cacheReadTokens;
  target.cacheWriteTokens += source.cacheWriteTokens;
  target.outputTokens += source.outputTokens;
  return target;
}

// Descendant session ids via header.parentSession links (BFS; defensive).
function collectDescendantIds(byId, rootId) {
  const out = [];
  const stack = [];
  for (const id in byId) {
    const entry = byId[id];
    if (entry !== void 0 && entry.parentId === rootId) stack.push(id);
  }
  const seen = new Set();
  while (stack.length > 0) {
    const cid = stack.pop();
    if (seen.has(cid)) continue;
    seen.add(cid);
    out.push(cid);
    for (const gid in byId) {
      const gentry = byId[gid];
      if (gentry !== void 0 && gentry.parentId === cid) stack.push(gid);
    }
  }
  return out;
}

// Read one session's events: live store first, persisted store as fallback.
async function sessionEvents(ctx, persistence, id, signal) {
  const live = ctx.sessions.get(id);
  if (live !== void 0 && Array.isArray(live.events)) return live.events;
  if (persistence === null) return [];
  const loaded = await persistence.inspect(id, signal);
  if (loaded === void 0 || !Array.isArray(loaded.events)) return [];
  return loaded.events;
}

async function queryTreeCost(ctx, persistence, sessionId, signal) {
  // id → { parentId }
  const byId = {};
  for (const s of ctx.sessions.list()) {
    const header = s.header !== void 0 && s.header !== null ? s.header : {};
    byId[s.id] = { parentId: header.parentSession };
  }
  let persistedHeaders = [];
  if (persistence !== null) {
    try {
      persistedHeaders = await persistence.list(signal);
    } catch {
      persistedHeaders = [];
    }
  }
  for (const h of persistedHeaders) {
    if (h === void 0 || h === null || typeof h.id !== "string") continue;
    if (!(h.id in byId)) byId[h.id] = { parentId: h.parentSession };
  }
  const root = byId[sessionId];
  if (root === void 0) {
    const live = ctx.sessions.get(sessionId);
    if (live === void 0) return { found: false };
    byId[sessionId] = { parentId: live.header && live.header.parentSession };
  }
  const ids = [sessionId, ...collectDescendantIds(byId, sessionId)];
  const merged = { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
  let costCny = 0;
  let unpricedSteps = 0;
  const byModel = new Map(); // model key → { usage, costCny }
  for (const id of ids) {
    try {
      const events = await sessionEvents(ctx, persistence, id, signal);
      if (Array.isArray(events) && events.length > 0) {
        const folded = foldUsage(events);
        mergeTotals(merged, folded.totals);
        costCny += folded.costCny;
        unpricedSteps += folded.unpricedSteps;
        for (const [key, entry] of folded.byModel.entries()) {
          const acc = byModel.get(key) ?? { usage: { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }, costCny: 0 };
          mergeTotals(acc.usage, entry.usage);
          acc.costCny += entry.costCny;
          byModel.set(key, acc);
        }
      }
    } catch {
      // skip this session; never fail the whole tree for one bad log
    }
  }
  const models = [...byModel.entries()].map(([model, entry]) => ({ model, usage: entry.usage, costCny: entry.costCny }));
  return { found: true, merged, costCny, models, unpricedSteps, descendantCount: ids.length - 1 };
}

// ── "today" fold: every session's samples since Asia/Shanghai midnight ────
// Folds ALL sessions (live + persisted), filtered by the sample timestamp,
// so the budget display covers the whole workspace, not just this tab.
const TODAY_CACHE_TTL_MS = 60000;
let todayCache = null; // { at, data }

function todayStartBeijing(now) {
  const shifted = now + 8 * 3600 * 1000;
  return Math.floor(shifted / 86400000) * 86400000 - 8 * 3600 * 1000;
}

// Asia/Shanghai month start (00:00 Beijing on the 1st of the Beijing month).
function monthStartBeijing(now) {
  const shifted = new Date(now + 8 * 3600 * 1000);
  return Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), 1) - 8 * 3600 * 1000;
}

function beijingDate(now) {
  return new Date(now + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

async function queryToday(ctx, persistence, signal) {
  const now = Date.now();
  const since = todayStartBeijing(now);
  const monthSince = monthStartBeijing(now);
  const ids = new Set();
  try {
    for (const s of ctx.sessions.list()) {
      if (s !== void 0 && s !== null && typeof s.id === "string") ids.add(s.id);
    }
  } catch { /* live list best-effort */ }
  if (persistence !== null) {
    try {
      const headers = await persistence.list(signal);
      for (const h of headers) {
        if (h !== void 0 && h !== null && typeof h.id === "string") ids.add(h.id);
      }
    } catch { /* persisted list best-effort */ }
  }
  let costCny = 0;
  let monthCostCny = 0;
  let unpricedSteps = 0;
  let sessionCount = 0;
  for (const id of ids) {
    try {
      const events = await sessionEvents(ctx, persistence, id, signal);
      if (!Array.isArray(events) || events.length === 0) continue;
      const folded = foldUsage(events, { sinceMs: since });
      costCny += folded.costCny;
      unpricedSteps += folded.unpricedSteps;
      sessionCount += 1;
      if (monthSince !== since) {
        monthCostCny += foldUsage(events, { sinceMs: monthSince }).costCny;
      } else {
        monthCostCny += folded.costCny;
      }
    } catch {
      // skip this session; never fail the day total for one bad log
    }
  }
  return { date: beijingDate(now), since, costCny, monthCostCny, unpricedSteps, sessionCount };
}

export { foldLive, foldUsage, parsePricingHtml, modelKeyOf, beijingPeak };

export const inject = ["webServer", "credentials", "sessions"];

export function apply(ctx) {
  let persistence = null;
  // P1-3: optional budget config from the bundle patch row
  // (cordis.patch.yml: config: { dailyBudgetCny, monthlyBudgetCny }).
  const pluginConfig = ctx.config !== void 0 && ctx.config !== null ? ctx.config : {};
  const budgetPayload = (() => {
    const daily = Number(pluginConfig.dailyBudgetCny);
    const monthly = Number(pluginConfig.monthlyBudgetCny);
    const out = {};
    if (Number.isFinite(daily) && daily > 0) out.daily = daily;
    if (Number.isFinite(monthly) && monthly > 0) out.monthly = monthly;
    return Object.keys(out).length > 0 ? out : null;
  })();
  ctx.inject(["sessionPersistence"], (childCtx) => {
    const service = childCtx.sessionPersistence;
    persistence = service;
    childCtx.effect(() => () => {
      if (persistence === service) persistence = null;
    }, "dsh-better-stats: optional sessionPersistence binding");
  });
  // Kick off the first official-pricing fetch at startup (never awaited —
  // routes serve the builtin table until it lands).
  ctx.effect(() => {
    refreshPricing();
    return () => { /* background refresh needs no teardown */ };
  }, "dsh-better-stats: initial pricing refresh");
  ctx.effect(() => ctx.webServer.register({
    path: "/plugins/better-stats/balance",
    handler: async (_req, res) => {
      const now = Date.now();
      let body;
      if (cached !== null && now - cached.at < CACHE_TTL_MS) {
        // Fresh cache hit: no upstream call.
        body = { ...cached.data, queriedAt: new Date(cached.at).toISOString() };
      } else {
        try {
          const hit = await ctx.credentials.resolve(API_KEY_ENV);
          if (!hit) {
            body = { configured: false, ref: API_KEY_ENV, queriedAt: new Date().toISOString() };
          } else {
            const data = await queryBalance(hit.value);
            cached = { at: now, data };
            body = { configured: true, status: "ok", ...data, queriedAt: new Date(now).toISOString() };
          }
        } catch {
          // Stale-while-error: serve the last successful snapshot instead of
          // failing, so transient upstream hiccups never surface as "余额查询
          // 失败". Only the very first failure (no cache yet) reports error.
          if (cached !== null) {
            body = { ...cached.data, stale: true, queriedAt: new Date(cached.at).toISOString() };
          } else {
            body = { configured: true, status: "error", error: "unavailable", queriedAt: new Date().toISOString() };
          }
        }
      }
      const rate = await usdCnyRate();
      body = { ...body, usdCnyRate: rate, pricing: ensurePricing(), budget: budgetPayload };
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store"
      });
      res.end(JSON.stringify(body));
    }
  }), "dsh-better-stats: /plugins/better-stats/balance route");
  ctx.effect(() => ctx.webServer.register({
    path: "/plugins/better-stats/cost",
    handler: async (req, res) => {
      const COST_TTL_MS = 10000;
      const url = new URL(req.url, "http://dsh.local");
      const sessionId = url.searchParams.get("sessionId");
      const write = (payload, status = 200) => {
        res.writeHead(status, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store"
        });
        res.end(JSON.stringify(payload));
      };
      if (typeof sessionId !== "string" || sessionId === "") {
        write({ error: "missing sessionId" }, 400);
        return;
      }
      const now = Date.now();
      const meta = { pricing: ensurePricing(), budget: budgetPayload };
      if (costCache !== null && costCache.sessionId === sessionId && now - costCache.at < COST_TTL_MS) {
        write({ ...costCache.data, cached: true, queriedAt: new Date(costCache.at).toISOString(), ...meta });
        return;
      }
      try {
        const result = await queryTreeCost(ctx, persistence, sessionId, AbortSignal.timeout(15000));
        if (result.found !== true) {
          write({ error: "session not found", sessionId }, 404);
          return;
        }
        costCache = { at: now, sessionId, data: { sessionId, merged: result.merged, costCny: result.costCny, models: result.models, unpricedSteps: result.unpricedSteps, descendantCount: result.descendantCount } };
        write({ ...costCache.data, cached: false, queriedAt: new Date(now).toISOString(), ...meta });
      } catch {
        // stale-while-error: serve the last successful snapshot for this session
        if (costCache !== null && costCache.sessionId === sessionId) {
          write({ ...costCache.data, stale: true, cached: false, queriedAt: new Date(costCache.at).toISOString(), ...meta });
        } else {
          write({ error: "cost query failed", sessionId }, 500);
        }
      }
    }
  }), "dsh-better-stats: /plugins/better-stats/cost route");
  ctx.effect(() => ctx.webServer.register({
    path: "/plugins/better-stats/live",
    handler: (req, res) => {
      const url = new URL(req.url, "http://dsh.local");
      const sessionId = url.searchParams.get("sessionId");
      const write = (payload, status = 200) => {
        res.writeHead(status, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store"
        });
        res.end(JSON.stringify(payload));
      };
      if (typeof sessionId !== "string" || sessionId === "") {
        write({ error: "missing sessionId" }, 400);
        return;
      }
      const session = ctx.sessions.get(sessionId);
      if (session === void 0) {
        write({ error: "session not found", sessionId }, 404);
        return;
      }
      const live = foldLive(session.events);
      let costCny = 0;
      let modelBreakdown = [];
      let unpricedSteps = 0;
      try {
        const usage = foldUsage(session.events);
        costCny = usage.costCny;
        unpricedSteps = usage.unpricedSteps;
        modelBreakdown = [...usage.byModel.entries()].map(([model, entry]) => ({ model, usage: entry.usage, costCny: entry.costCny }));
      } catch {
        // cost settlement is best-effort; never fail the live route
      }
      write({
        sessionId,
        ...live,
        costCny,
        models: modelBreakdown,
        unpricedSteps,
        pricing: ensurePricing(),
        budget: budgetPayload,
        queriedAt: new Date().toISOString()
      });
    }
  }), "dsh-better-stats: /plugins/better-stats/live route");
  ctx.effect(() => ctx.webServer.register({
    path: "/plugins/better-stats/today",
    handler: async (req, res) => {
      const write = (payload, status = 200) => {
        res.writeHead(status, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store"
        });
        res.end(JSON.stringify(payload));
      };
      const now = Date.now();
      if (todayCache !== null && now - todayCache.at < TODAY_CACHE_TTL_MS) {
        write({ ...todayCache.data, cached: true, queriedAt: new Date(todayCache.at).toISOString() });
        return;
      }
      try {
        const result = await queryToday(ctx, persistence, AbortSignal.timeout(15000));
        todayCache = { at: now, data: result };
        write({ ...result, cached: false, queriedAt: new Date(now).toISOString() });
      } catch {
        if (todayCache !== null) {
          write({ ...todayCache.data, stale: true, cached: false, queriedAt: new Date(todayCache.at).toISOString() });
        } else {
          write({ error: "today query failed" }, 500);
        }
      }
    }
  }), "dsh-better-stats: /plugins/better-stats/today route");
}

// ── live step timing (host side) ───────────────────────────────────────────
// The client session stream does NOT carry tool/call / tool/result events, so
// live tool timing is impossible client-side. The host holds the full log:
// fold it here (mirroring the official sessionStats reducer, PLUS the open
// step and in-flight tool calls) and expose the live edges.

function isTokenDeltaChunk(chunk) {
  switch (chunk.type) {
    case "text-delta":
    case "reasoning-delta": return chunk.text !== "";
    case "tool-call-delta": return chunk.argumentsDelta !== "" || chunk.name !== void 0;
    default: return false;
  }
}

function foldLive(events) {
  const state = {
    turns: 0,
    steps: 0,
    llmMs: 0,
    toolMs: 0,
    ttftMs: 0,
    ttftSteps: 0,
    decodeMs: 0,
    decodeTokens: 0,
    lastTurn: null,
    openStep: null,
    pendingCalls: {},
    toolPhaseStart: null
  };
  for (const e of events) {
    if (e === void 0 || typeof e !== "object" || e === null) continue;
    switch (e.type) {
      case "step/start":
        state.openStep = {
          turn: e.data && e.data.turn,
          step: e.data && e.data.step,
          startTime: e.time,
          firstTokenTime: null
        };
        break;
      case "assistant/chunk": {
        const open = state.openStep;
        if (open !== null && e.data !== void 0 && open.turn === e.data.turn && open.step === e.data.step &&
            open.firstTokenTime === null && e.data.chunk !== void 0 && isTokenDeltaChunk(e.data.chunk)) {
          open.firstTokenTime = e.time;
        }
        break;
      }
      case "assistant/message": {
        const open = state.openStep;
        if (open !== null && e.data !== void 0 && open.turn === e.data.turn && open.step === e.data.step) {
          state.llmMs += Math.max(0, e.time - open.startTime);
          if (open.firstTokenTime !== null) {
            state.ttftMs += Math.max(0, open.firstTokenTime - open.startTime);
            state.ttftSteps += 1;
            const out = e.data.usage && typeof e.data.usage.outputTokens === "number" ? e.data.usage.outputTokens : null;
            if (out !== null) {
              state.decodeMs += Math.max(0, e.time - open.firstTokenTime);
              state.decodeTokens += out;
            }
          }
          // The tool phase starts at the model's tool-call DECISION message:
          // tool/call + tool/result events only land in the log AFTER the
          // tool completes, so the message's timestamp is the only live
          // start signal. (A step whose message has no tool-call block stays
          // a pure LLM step.)
          const blocks = e.data.message && e.data.message.content;
          if (Array.isArray(blocks)) {
            for (const b of blocks) {
              if (b !== null && typeof b === "object" && b.type === "tool-call") {
                state.toolPhaseStart = e.time;
                break;
              }
            }
          }
          state.openStep = null;
        }
        break;
      }
      case "tool/call":
        if (e.data !== void 0 && typeof e.data.callId === "string") state.pendingCalls[e.data.callId] = e.time;
        break;
      case "tool/result": {
        const callId = e.data && e.data.message && e.data.message.source ? e.data.message.source.callId : void 0;
        if (typeof callId === "string" && state.pendingCalls[callId] !== void 0) {
          state.toolMs += Math.max(0, e.time - state.pendingCalls[callId]);
          delete state.pendingCalls[callId];
        }
        break;
      }
      case "step/end":
        if (e.data !== void 0) {
          state.turns = state.lastTurn === e.data.turn ? state.turns : state.turns + 1;
          state.steps += 1;
          state.lastTurn = e.data.turn;
        }
        state.openStep = null;
        state.toolPhaseStart = null;
        break;
      case "turn/end":
        if (Object.keys(state.pendingCalls).length > 0) state.pendingCalls = {};
        state.toolPhaseStart = null;
        break;
      default:
        break;
    }
  }
  let pendingMin = null;
  for (const t of Object.values(state.pendingCalls)) {
    if (pendingMin === null || t < pendingMin) pendingMin = t;
  }
  return {
    completed: {
      turns: state.turns,
      steps: state.steps,
      llmMs: state.llmMs,
      toolMs: state.toolMs,
      ttftMs: state.ttftMs,
      ttftSteps: state.ttftSteps,
      decodeMs: state.decodeMs,
      decodeTokens: state.decodeTokens
    },
    openStepStart: state.openStep !== null ? state.openStep.startTime : null,
    pendingMin,
    toolPhaseStart: state.toolPhaseStart
  };
}
