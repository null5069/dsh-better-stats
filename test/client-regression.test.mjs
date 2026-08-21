// Regression harness for dsh-better-stats client.js (no browser needed).
// Verifies: module load via the ModuleLoader protocol, dock registration,
// the strip/popover rendering, the P1 accounting contract (output/reasoning
// subset, unknown models + legal zeros, snapshot merging without max()),
// session-switch rebuild, dedupe, i18n (zh + en, no Chinese leak), and the
// 100ms ticker gating.
//
// The harness emulates React hooks. Hook indices (documented, stable):
//   OUTER (workspace scope):
//     1=balance 2=hovered 3=anchor 4=etaRef 5=balanceRefreshRef 6=refreshPulse
//     7=workspaceMetaRef 8=balance-effect 9=hideTimerRef
//   INNER (session scope, key={sessionId}):
//     10=merged(useMemo) 11=estimateRef 12=pricingRef 13=budgetRef
//     14=todayState 15=costState 16=cost-effect 17=liveState 18=live-effect
//     19=today-effect 20=tickState 21=runningRef 22=ticker-effect
//     23=sessionModelRef 24=layoutState 25=layoutRef 26=prevUsageRef
//     27=turnCostRef 28=sepState 29=trailingCache 30=itemRefs 31=sepProbeRef
//     32=measureRef 33=lineRef 34=ellideState 35=ellideRef 36=widthsRef
//     37=useLayoutEffect 38=resize-effect
import { readFileSync } from "node:fs";

// Locale determinism: the bundle captures navigator.language at load time.
// Pin it to zh-CN here (override with BS_LANG for a fully-English run) so the
// zh assertions never depend on the machine's locale — scenario 25 explicitly
// re-loads the bundle with en-US for the English half of the suite.
{
  const forced = process.env.BS_LANG || "zh-CN";
  try {
    Object.defineProperty(globalThis.navigator, "language", { value: forced, configurable: true });
  } catch (e) { /* keep whatever the runtime reports */ }
  console.log("client suite locale:", forced);
}

const code = readFileSync(
  new URL("../lib/client.js", import.meta.url),
  "utf8"
);

let failures = 0;
function check(name, cond, detail) {
  console.log((cond ? "PASS: " : "FAIL: ") + name + (detail && !cond ? " — " + detail : ""));
  if (!cond) failures++;
}

// ── dynamic react proxy: hooks resolve against the current render env ────
let currentEnv = null; // { states, cursor, effects, callSetState }

function reactProxy() {
  return {
    useState(initial) {
      const env = currentEnv;
      const i = env.cursor++;
      if (!(i in env.states)) env.states[i] = { value: initial };
      const setter = (next) => {
        const updater = typeof next === "function" ? next : () => next;
        env.states[i].value = updater(env.states[i].value);
        env.rerender = true;
      };
      env.states[i].set = setter;
      return [env.states[i].value, setter];
    },
    useRef(initial) {
      const env = currentEnv;
      const i = env.cursor++;
      if (!(i in env.states)) env.states[i] = { current: initial };
      return env.states[i];
    },
    useMemo(factory, deps) {
      const env = currentEnv;
      const i = env.cursor++;
      const prev = env.states[i];
      if (!prev || prev.deps.some((d, j) => !Object.is(d, deps[j]))) {
        env.states[i] = { value: factory(), deps };
      }
      return env.states[i].value;
    },
    useEffect(callback, deps) {
      const env = currentEnv;
      const i = env.cursor++;
      const prev = env.states[i];
      const changed = !prev || prev.deps.some((d, j) => !Object.is(d, deps[j]));
      env.states[i] = { callback, deps };
      if (changed) env.effects.push(callback);
    },
    createElement(type, props, ...children) {
      // render function components immediately (like React reconciliation),
      // so nested components — the keyed session subcomponent — run in the
      // same hook environment
      if (typeof type === "function") {
        const env = currentEnv;
        if (props && props.key !== void 0) {
          if (!Array.isArray(env.lastKeys)) env.lastKeys = [];
          env.lastKeys.push(props.key);
        }
        return type({ ...(props || {}), children });
      }
      return { type, props: props || {}, children };
    },
  };
}

// ── load the plugin through the ModuleLoader protocol ────────────────────
let factory = null;
globalThis.window = {
  __ModuleLoader__: {
    load(handoff) { factory = handoff.factory; },
  },
};
new Function("window", "require", code)(
  globalThis.window,
  (spec) => {
    if (spec === "react") return reactProxy();
    throw new Error("unexpected require: " + spec);
  }
);
const module = { exports: {} };
const plugin = factory((spec) => {
  if (spec === "react") return reactProxy();
  throw new Error("unexpected require: " + spec);
});
console.log("exports:", Object.keys(plugin), "| inject:", JSON.stringify(plugin.inject));

// ── default fetch mock: every route answers so effects never throw ────────
function defaultBody(url) {
  const u = String(url);
  if (u.indexOf("/plugins/better-stats/balance") !== -1) {
    return { configured: false, status: "ok", provider: null, amount: null, currency: null, queriedAt: new Date().toISOString() };
  }
  if (u.indexOf("/plugins/better-stats/cost") !== -1) {
    return {
      sessionId: "session-test", found: true,
      merged: { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0 },
      costCny: 0,
      root: { costCny: 0, unpricedSteps: 0, invalidSteps: 0 },
      descendants: { costCny: 0, unpricedSteps: 0, invalidSteps: 0, descendantCount: 0 },
      models: [], unpricedSteps: 0, invalidSteps: 0, partial: false,
      failedSessionCount: 0, persistenceAvailable: false, descendantCount: 0,
      pricingVersion: 0, queriedAt: new Date().toISOString()
    };
  }
  if (u.indexOf("/plugins/better-stats/live") !== -1) {
    // openStepStart intentionally absent → the client keeps its previous value
    return { sessionId: "session-test", completed: null, rootCostCny: 0, unpricedSteps: 0, invalidSteps: 0 };
  }
  if (u.indexOf("/plugins/better-stats/today") !== -1) {
    return { date: "2026-08-18", since: 0, costCny: 0, monthCostCny: 0, unpricedSteps: 0, invalidSteps: 0, sessionCount: 0 };
  }
  return {};
}
globalThis.fetch = (url) => Promise.resolve({ ok: true, json: () => Promise.resolve(defaultBody(url)) });

// ── apply with fake ctx (sessions swappable per scenario) ─────────────────
let Comp = null;
let options = null;
function applyWith(sessions) {
  Comp = null;
  options = null;
  const plugin2 = factory((spec) => {
    if (spec === "react") return reactProxy();
    throw new Error("unexpected require: " + spec);
  });
  plugin2.apply({
    sessions,
    slots: {
      inject(name, cb) { [options, Comp] = cb(); },
      register(o, c) { return [o, c]; },
    },
  });
}
applyWith({});
console.log("registered:", options.id, "order:", options.order, "name:", options.name);

// ── tiny render loop ─────────────────────────────────────────────────────
function makeEnv() {
  return { states: [], cursor: 0, effects: [], rerender: false, lastKeys: [] };
}

function render(env, props) {
  currentEnv = env;
  env.cursor = 0;
  env.effects = [];
  env.rerender = false;
  let el;
  try {
    el = Comp(props);
  } catch (err) {
    currentEnv = null;
    throw err;
  }
  const effects = env.effects;
  currentEnv = null;
  for (const cb of effects) {
    try {
      cb();
    } catch (err) {
      // effect errors are REAL failures — never console noise
      check("effect ran without throwing (" + (err && err.message ? err.message : String(err)) + ")", false);
    }
  }
  return el;
}

// Harness slot INDICES (0-based): hook #N lives at env.states[N-1].
// OUTER: 1=balance 2=hovered 3=anchor 4=etaRef 5=balanceRefreshRef
// 6=refreshPulse 7=workspaceMetaRef 8=balance-effect 9=hideTimerRef
// INNER: 10=merged 11=estimateRef 12=pricingRef 13=budgetRef 14=todayState
// 15=costState 16=cost-effect 17=liveState 18=live-effect 19=today-effect
// 20=tickState 21=runningRef 22=ticker-effect 23=sessionModelRef
// 24=layoutState 25=layoutRef 26=prevUsageRef 27=turnCostRef 28=sepState
// 29=trailingCache 30=itemRefs 31=sepProbeRef 32=measureRef 33=lineRef
// 34=ellideState 35=ellideRef 36=widthsRef 37=layout-effect 38=resize-effect
const HOOK = {
  balance: 0, hovered: 1, anchor: 2,
  today: 13, cost: 14, live: 16,
  sepState: 27, itemRefs: 29, probe: 30, measure: 31, lineRef: 32
};
function seedLive(env, body) { env.states[HOOK.live] = { value: body }; }
function seedCost(env, body) { env.states[HOOK.cost] = { value: body }; }
function seedToday(env, body) { env.states[HOOK.today] = { value: body }; }
function seedBalance(env, body) { env.states[HOOK.balance] = { value: body }; }

const TOKEN_USAGE = { uncachedInputTokens: 1000, cacheReadTokens: 500, cacheWriteTokens: 0, outputTokens: 200 };
const SESSION_STATS = { turns: 3, steps: 12, llmMs: 45200, toolMs: 12300, ttftMs: 1400, ttftSteps: 1, decodeMs: 1000, decodeTokens: 25 };
const propsWithData = {
  useProjection: (key) => (key === "tokenUsage" ? TOKEN_USAGE : SESSION_STATS),
  useSessions: () => ({ byId: {} }),
  sessionId: "session-test",
};
const propsNoData = {
  useProjection: () => void 0,
  useSessions: () => null,
  sessionId: "session-test",
};

// ── element helpers ───────────────────────────────────────────────────────
function allEls(node, out) {
  if (node === null || typeof node !== "object") return;
  if (typeof node.props !== "undefined" && typeof node.props.className === "string") out.push(node);
  if (Array.isArray(node)) { for (const c of node) allEls(c, out); return; }
  if (typeof node.children !== "undefined") allEls(node.children, out);
}
function flatEls(el) {
  const out = [];
  allEls(el.children, out);
  return out;
}
function groupTextsOf(el) {
  const flat = flatEls(el);
  return flat.filter((c) => c && c.props && c.props["data-bs"] === void 0 && typeof c.props.className === "string" && c.props.className.indexOf("item") !== -1)
    .map((g) => (g.children || []).join ? g.children.join("") : g.children).join(" ");
}
function cnyOf(text) {
  const m = String(text).match(/本轮 ¥([\d.]+)/);
  return m ? Number(m[1]) : NaN;
}
function collectStrings(node, out) {
  if (typeof node === "string") { out.push(node); return; }
  if (node === null || node === void 0 || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const c of node) collectStrings(c, out);
    return;
  }
  if (typeof node.children !== "undefined") collectStrings(node.children, out);
}
function popTextOf(el) {
  const flat = flatEls(el);
  const pop = flat.find((c) => c && typeof c === "object" && c.props && typeof c.props.className === "string" && c.props.className.indexOf("dsh-better-stats-pop") !== -1 && c.props.className.indexOf("pop-row") === -1);
  if (!pop) return "";
  const out = [];
  collectStrings(pop.children, out);
  // empty grid cells join as stray spaces — collapse runs so cell adjacency
  // is asserted on single spaces
  return out.join(" ").replace(/\s+/g, " ");
}
const HOST_TABLES = {
  "deepseek-v4-flash": { miss: 1.5, read: 0.05, out: 4.5, missPeak: 3.0, readPeak: 0.1, outPeak: 9.0 },
  "deepseek-v4-pro": { miss: 4.5, read: 0.15, out: 13.5, missPeak: 9.0, readPeak: 0.3, outPeak: 27.0 }
};
function peakAt(now) {
  const d = new Date(now + 8 * 3600 * 1000);
  const h = d.getUTCHours();
  return (h >= 9 && h < 12) || (h >= 14 && h < 18);
}
function flashOut(now) { return peakAt(now) ? 9.0 : 4.5; }
function flashMiss(now) { return peakAt(now) ? 3.0 : 1.5; }
function flashRead(now) { return peakAt(now) ? 0.1 : 0.05; }

// ── hook-index sanity (documents the stable map) ──────────────────────────
// Harness slot INDICES are 0-based: hook #N lives at env.states[N-1]
// (see the HOOK map above).
{
  applyWith({});
  const env = makeEnv();
  render(env, propsWithData);
  check("hook map: balance state at index 0", env.states[0] !== void 0 && env.states[0].value !== void 0);
  check("hook map: liveState at index 16 (object seeded-able)", typeof env.states[16] === "object");
  check("hook map: costState at index 14", typeof env.states[14] === "object");
  check("hook map: todayState at index 13", typeof env.states[13] === "object");
  check("hook map: 38 hooks total (refs exercised by scenarios 6/9/21)",
    env.states.length === 38 && typeof env.states[31].current === "function" &&
    Array.isArray(env.states[29].current),
    "len=" + env.states.length + " 29=" + JSON.stringify(env.states[29] && env.states[29].current) + " 31=" + typeof (env.states[31] && env.states[31].current));
}

// Scenario 1: no data at all → every group still renders with placeholders
// (dash / legal zeros) instead of waiting for data to appear
{
  const env = makeEnv();
  const el = render(env, propsNoData);
  const texts0 = groupTextsOf(el);
  check("no-data still renders the line with the 峰谷 group",
    !!(el && el.props && el.props["data-bs"] === "v20") && /^(高峰中|空闲中) /.test(texts0),
    JSON.stringify(el).slice(0, 140) + " texts=" + texts0);
  check("no-data shows ALL groups with dash placeholders",
    texts0.indexOf("本轮 - · 会话 -") !== -1 &&
    texts0.indexOf("0 轮 · 0 步") !== -1 &&
    texts0.indexOf("LLM - · 工具 -") !== -1 &&
    texts0.indexOf("--") !== -1,
    "texts=" + texts0);
}

// Scenario 1b: fresh-chat shape — projections exist but are all zeros →
// every group shows legal zeros (spend ¥0.0000, 缓存 0 · 命中 0.00%,
// 输入 0 · 输出 0) instead of hiding until data arrives
{
  const env = makeEnv();
  const zeroUsage = { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0 };
  const zeroStats = { turns: 0, steps: 0, llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0 };
  const el = render(env, {
    useProjection: (key) => (key === "tokenUsage" ? zeroUsage : zeroStats),
    useSessions: () => ({ byId: {} }),
    sessionId: "session-test",
  });
  const texts = groupTextsOf(el);
  check("fresh chat shows 缓存 with legal zero hit",
    /缓存 0 · 命中 0\.00%/.test(texts), texts);
  check("fresh chat shows 输入/输出 zeros",
    /输入 0 · 输出 0/.test(texts), texts);
  check("fresh chat shows 本轮/会话 zero spend",
    /本轮 ¥0\.0000 · 会话 ¥0\.0000/.test(texts), texts);
  check("fresh chat shows 0 轮 · 0 步 and dash durations",
    texts.indexOf("0 轮 · 0 步") !== -1 && texts.indexOf("LLM - · 工具 -") !== -1, texts);
}

// Scenario 2: data present, no balance yet → full line with groups
{
  const env = makeEnv();
  const el = render(env, propsWithData);
  const flat = flatEls(el);
  const groups = flat.filter((c) => c && c.props && c.props["data-bs"] === void 0 && typeof c.props.className === "string" && c.props.className.indexOf("item") !== -1);
  check("data line renders (data-bs=v20)", !!(el && el.props && el.props["data-bs"] === "v20"), JSON.stringify(el).slice(0, 140));
  check("data line has group items", groups.length >= 3, "items=" + groups.length);
  const text = groups.map((g) => (g.children || []).join ? g.children.join("") : g.children).join(" ");
  console.log("  line text:", text);
  check("line shows turns/steps", /3 轮 · 12 步/.test(text), text);
  check("line shows tokens", /输入/.test(text), text);
}

// Scenario 2b: token groups split — 缓存命中 second-to-last, 输入输出 last
{
  const env = makeEnv();
  const el = render(env, propsWithData);
  const flat = flatEls(el);
  const texts = flat.filter((c) => c && c.props && c.props["data-bs"] === void 0 && typeof c.props.className === "string" && c.props.className.indexOf("item") !== -1)
    .map((g) => (g.children || []).join ? g.children.join("") : g.children);
  const lastTwo = texts.slice(-2);
  check("缓存命中 group is second-to-last", /^缓存 .*命中 \d+\.\d+%$/.test(lastTwo[0]), JSON.stringify(lastTwo));
  check("输入输出 group is last", /^输入 .* · 输出 /.test(lastTwo[1]), JSON.stringify(lastTwo));
  check("token text no longer mixes cache into 输入输出", !/输入 .*缓存/.test(lastTwo[1]), JSON.stringify(lastTwo));
}

// Scenario 3: balance arrives → re-render (same env) keeps the line alive
{
  const env = makeEnv();
  const el1 = render(env, propsWithData);
  check("balance-less line already renders groups", !!(el1 && el1.props && el1.props["data-bs"] === "v20"));
}

// Scenario 4: THE crash condition — measureSeps with refs full of undefined.
// Effect errors now FAIL the test, so this scenario is a real assertion:
// measureSeps ran inside the effects with unattached refs and must not throw.
{
  const env = makeEnv();
  const el = render(env, propsWithData);
  check("measureSeps survived undefined refs (effects ran, none threw)",
    !!(el && el.props && el.props["data-bs"] === "v20"));
}

// Scenario 5: repeated re-renders (hover toggles) don't crash
{
  const env = makeEnv();
  const el = render(env, propsWithData);
  const el2 = render(env, propsWithData);
  check("re-render stable", !!(el2 && el2.props && el2.props["data-bs"] === "v20"));
}

// Scenario 6: deterministic wrap calculation (natural widths, no feedback loop)
{
  const env = makeEnv();
  render(env, propsWithData);
  const lineRef = env.states[HOOK.lineRef];
  const itemRef = env.states[HOOK.itemRefs];
  const probeRef = env.states[HOOK.probe];
  const measure = env.states[HOOK.measure].current;
  const hidden = () => env.states[HOOK.sepState].value;

  lineRef.current = { clientWidth: 300 };
  probeRef.current = { offsetWidth: 20 };
  [80, 90, 70, 60, 50, 40, 30].forEach((width, i) => {
    itemRef.current[i] = { offsetWidth: width, idx: i };
  });
  measure();
  check("width simulation hides only the row-boundary separator",
    JSON.stringify(hidden()) === "[false,false,true,false,false,false]",
    JSON.stringify(hidden()));

  const stable = hidden();
  measure();
  check("same geometry does not schedule a toggling state", hidden() === stable);

  lineRef.current.clientWidth = 1000;
  measure();
  check("re-flow restores separators", JSON.stringify(hidden()) === "[false,false,false,false,false,false]", JSON.stringify(hidden()));
}

// Scenario 9: ref-index capture — every group keeps its own natural-width ref
{
  applyWith({});
  const env = makeEnv();
  const el = render(env, propsWithData);
  const flat = flatEls(el);
  const itemRef = env.states[HOOK.itemRefs];
  const lineRef = env.states[HOOK.lineRef];
  const probeRef = env.states[HOOK.probe];
  const groupSpans = flat.filter((c) => c && c.props && c.props["data-bs"] === void 0 && typeof c.props.className === "string" && c.props.className.indexOf("item") !== -1);
  const probeSpan = flat.find((c) => c && c.props && typeof c.props.className === "string" && c.props.className.indexOf("sep-probe") !== -1);
  groupSpans.forEach((sp, i) => sp.props.ref({ offsetWidth: 50, idx: i }));
  probeSpan.props.ref({ offsetWidth: 20, probe: true });
  check("group refs capture per-index elements and probe is isolated",
    itemRef.current.length === groupSpans.length &&
    itemRef.current.every((e, i) => e !== void 0 && e.idx === i && e.offsetWidth === 50) &&
    probeRef.current && probeRef.current.probe === true,
    "itemRef=" + JSON.stringify(itemRef.current.map((e) => e && e.idx)));
}

// Scenario 10: the strip caps at two rows with an ellipsis marker
check("stats line caps at two rows with ellipsis style",
  code.includes("max-height:48px;overflow:hidden") && code.includes("dsh-better-stats-ellipsis") &&
  !code.includes("max-height:none;overflow:visible"));

// Scenario 12: the projection-diff fallback with an UNKNOWN initial model —
// new usage is never silently priced at the flash rate.
{
  applyWith({});
  const env = makeEnv();
  const usageState = { value: { ...TOKEN_USAGE } };
  const props = { ...propsWithData, useProjection: (key) => key === "tokenUsage" ? usageState.value : SESSION_STATS };
  const t0 = groupTextsOf(render(env, props));
  check("本轮 baseline is 0", /本轮 ¥0\.00/.test(t0), t0);
  usageState.value = { ...usageState.value, outputTokens: usageState.value.outputTokens + 100000 };
  const t1 = groupTextsOf(render(env, props));
  check("unknown initial model never prices at flash (本轮 stays 0)", /本轮 ¥0\.00/.test(t1), t1);
  const t2 = groupTextsOf(render(env, props));
  check("本轮 unchanged when usage unchanged", t1 === t2, t2);
}

// Scenario 13: unknown-model steps — session amount gets ≈, an 未计价 row,
// and the cost share is labelled as priced-cost share; token shares include
// the unknown tokens in the denominator.
{
  applyWith({});
  const env = makeEnv();
  seedLive(env, {
    completed: null, openStepStart: null, pendingMin: null, toolPhaseStart: null,
    rootCostCny: 0.05, unpricedSteps: 3, invalidSteps: 0, pricing: null, budget: null
  });
  seedCost(env, {
    merged: { ...TOKEN_USAGE, reasoningTokens: 0 },
    costCny: 0.05,
    root: { costCny: 0.05 },
    descendants: { costCny: 0 },
    models: [
      { model: "deepseek-v4-flash", usage: TOKEN_USAGE, costCny: 0.04 },
      { model: "unknown", usage: TOKEN_USAGE, costCny: 0 }
    ],
    unpricedSteps: 3, invalidSteps: 0, partial: false, failedSessionCount: 0,
    persistenceAvailable: false, descendantCount: 0, pricing: null, stale: false
  });
  env.states[HOOK.hovered] = { value: true };
  env.states[HOOK.anchor] = { value: { left: 100, top: 100 } };
  const el = render(env, propsWithData);
  const text = groupTextsOf(el);
  const pop = popTextOf(el);
  check("unknown steps: no ≈ on the session amount", text.indexOf("会话 ¥0.0500") !== -1 && text.indexOf("≈") === -1, text);
  check("unpriced popover note present", pop.indexOf("含 3 步未定价 · 模型未知") !== -1, pop);
  check("unknown model row shows 未计价", pop.indexOf("unknown 未计价") !== -1, pop);
  check("模型 group is the LAST popover group (below Tok)", pop.lastIndexOf("模型") > pop.indexOf("Tok 会话"), pop);
  check("per-model rows show priced-cost share", pop.indexOf("v4-flash 花费 ¥0.040000 (100.00%)") !== -1, pop);
  // token shares include unknown in the denominator: flash = 1000/2000 = 50%
  check("模型 token row includes unknown tokens (50.00%)",
    pop.indexOf("输入 1000 (50.00%) 输出 200 (50.00%)") !== -1, pop);
}

// Scenario 14: budget warn/over — amber ⚠ at ≥80%, red ⚠ over budget.
{
  applyWith({});
  const env = makeEnv();
  seedLive(env, {
    completed: null, openStepStart: null, pendingMin: null, toolPhaseStart: null,
    rootCostCny: 0.05, unpricedSteps: 0, invalidSteps: 0, pricing: null,
    budget: { daily: 20, monthly: 100 }
  });
  seedToday(env, { costCny: 18, monthCostCny: 60, sessionCount: 4 });
  env.states[HOOK.hovered] = { value: true };
  env.states[HOOK.anchor] = { value: { left: 100, top: 100 } };
  const el = render(env, propsWithData);
  const flat = flatEls(el);
  const spendSpan = flat.find((c) => c && c.props && typeof c.props.className === "string" &&
    c.props.className.indexOf("item") !== -1 && String((c.children || []).join ? (c.children || []).join("") : "").indexOf("本轮") !== -1);
  const spendText = (spendSpan && spendSpan.children || []).join("");
  check("budget warn: ⚠ prefix at 90%", /^⚠ /.test(spendText), spendText);
  check("budget warn: amber color", !!(spendSpan && spendSpan.props.style && spendSpan.props.style.color === "#f59e0b"), JSON.stringify(spendSpan && spendSpan.props.style));
  const pop = popTextOf(el);
  check("budget hover shows 今日 vs 日预算", pop.indexOf("今日 ¥18.0000 · 日预算 ¥20.00 (90%)") !== -1, pop);
  check("budget hover shows 本月 vs 月预算", pop.indexOf("本月 ¥60.0000 · 月预算 ¥100.00 (60%)") !== -1, pop);

  const env2 = makeEnv();
  seedLive(env2, env.states[HOOK.live].value);
  seedToday(env2, { costCny: 21, monthCostCny: 60, sessionCount: 4 });
  const el2 = render(env2, propsWithData);
  const flat2 = flatEls(el2);
  const spendSpan2 = flat2.find((c) => c && c.props && typeof c.props.className === "string" &&
    c.props.className.indexOf("item") !== -1 && String((c.children || []).join ? (c.children || []).join("") : "").indexOf("本轮") !== -1);
  const spendText2 = (spendSpan2 && spendSpan2.children || []).join("");
  check("budget over: ⚠ prefix and red color", /^⚠ /.test(spendText2) && spendSpan2.props.style.color === "#ef4444", spendText2 + " " + JSON.stringify(spendSpan2 && spendSpan2.props.style));
}

// Scenario 15: balance split + peak countdown in the 余额 hover
{
  applyWith({});
  const env = makeEnv();
  seedBalance(env, { text: "DeepSeek ¥8.6700", label: "DeepSeek", amount: 8.67, currency: "CNY", granted: 3.2, toppedUp: 5.47 });
  env.states[HOOK.hovered] = { value: true };
  env.states[HOOK.anchor] = { value: { left: 100, top: 100 } };
  const el = render(env, propsWithData);
  const pop = popTextOf(el);
  check("balance row in hover: amount + recharge", pop.indexOf("余额 ¥8.67") !== -1 && pop.indexOf("充值 ↗") !== -1, pop);
  check("peak countdown line in hover", /(高峰中|空闲中).*?(高峰|空闲) \d{2}:00 开始 \(.+后\)/.test(pop), pop);
  // balance refresh is a REAL <button>
  const flat = flatEls(el);
  const btn = flat.find((c) => c && c.type === "button" && typeof c.props.className === "string" && c.props.className.indexOf("dsh-better-stats-refresh") !== -1);
  check("balance refresh renders a real button", !!btn && btn.props.type === "button" && typeof btn.props.onClick === "function", JSON.stringify(btn && btn.props.className));
}

// Scenario 16: official price-source label
{
  applyWith({});
  const env = makeEnv();
  seedLive(env, {
    completed: null, openStepStart: null, pendingMin: null, toolPhaseStart: null,
    rootCostCny: 0.05, unpricedSteps: 0, invalidSteps: 0,
    pricing: { source: "official", fetchedAt: new Date().toISOString(), tables: HOST_TABLES },
    budget: null
  });
  env.states[HOOK.hovered] = { value: true };
  env.states[HOOK.anchor] = { value: { left: 100, top: 100 } };
  const el = render(env, propsWithData);
  const pop = popTextOf(el);
  check("价源 row with YYYY-MM-DD HH:MM", /价源 DeepSeek 官网 \d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(pop), pop);
  check("价源 row after 峰谷, before 花费", pop.indexOf("价源") !== -1 && pop.indexOf("价源") > pop.indexOf("峰谷") && pop.indexOf("价源") < pop.indexOf("花费"), pop);
}

// Scenario 17: streaming estimate — the CORRECTED total-output estimate
// (raw × estAccuracy) feeds 金额; settle hands over to the exact fold.
{
  const events = [
    { type: "turn/start", data: { turn: 1 } },
    { type: "step/start", data: { turn: 1, step: 1 } },
    { type: "reasoning-chunks", data: { turn: 1, step: 1, texts: ["x".repeat(3500), "y".repeat(500)] } },
    { type: "tool-call-chunks", data: { turn: 1, step: 1, id: "c1", name: "read", args: ["{\"a\":", "1}"] } }
  ];
  applyWith({ binding: () => ({ session: { events } }) });
  const env = makeEnv();
  seedLive(env, {
    completed: null, openStepStart: Date.now() - 1000, pendingMin: null, toolPhaseStart: null,
    rootCostCny: 0.05, unpricedSteps: 0, invalidSteps: 0, pricing: null, budget: null
  });
  const runningProps = {
    ...propsWithData,
    useSessions: () => ({ byId: { "session-test": { running: true } } })
  };
  env.states[HOOK.hovered] = { value: true };
  env.states[HOOK.anchor] = { value: { left: 100, top: 100 } };
  const now = Date.now();
  const outP = flashOut(now);
  // acc starts at 1 (no localStorage calib in this harness). The initial
  // model is UNKNOWN: the streaming estimate exists (tokens tick) but its
  // PRICE is 0 until the first message identifies the model — never a
  // silent flash default.
  const t1 = groupTextsOf(render(env, runningProps));
  check("unknown initial model: streaming estimate unpriced (¥0, not flash)",
    t1.indexOf("本轮 ¥0.0000") !== -1 && t1.indexOf("(估)") === -1, t1);
  const pop1 = popTextOf(render(env, runningProps));
  check("popover shows the unpriced estimate while the model is unknown",
    pop1.indexOf("¥0.000000 含估算 ¥0.000000") !== -1,
    pop1);
  events.push({ type: "text-chunks", data: { turn: 1, step: 1, texts: ["y".repeat(4000)] } });
  const t2 = groupTextsOf(render(env, runningProps));
  check("estimate stays unpriced while the model is unknown",
    t2.indexOf("本轮 ¥0.0000") !== -1 && t2.indexOf("(估)") === -1, t2);
  // usage chunk lands → exact fold takes over; estAccuracy self-calibrates
  // (real 8000 ÷ est 2745.657 ≈ 2.9137 → EMA 0.3 → acc ≈ 1.5741)
  events.push({ type: "assistant/chunk", data: { turn: 1, step: 1, chunk: { type: "usage", usage: { inputTokens: 100, outputTokens: 8000, cacheReadTokens: 5000 } } } });
  events.push({ type: "assistant/message", data: { turn: 1, step: 1, usage: { inputTokens: 100, outputTokens: 8000, cacheReadTokens: 5000 }, message: { source: { model: "deepseek-v4-flash" } } } });
  const step1Exact = (100 * flashMiss(now) + 5000 * flashRead(now) + 8000 * outP) / 1e6;
  const t3 = groupTextsOf(render(env, runningProps));
  check("estimate removed after usage lands (exact turn fold shown)", t3.indexOf("(估)") === -1 && Math.abs(cnyOf(t3) - step1Exact) < 0.0051, t3 + " expected " + step1Exact.toFixed(2));
  const pop3 = popTextOf(render(env, runningProps));
  check("running keeps the 本轮 bracket (含估算 ¥0.000000, no flicker)",
    pop3.indexOf("¥" + step1Exact.toFixed(6) + " 含估算 ¥0.000000") !== -1,
    pop3);
  events.push({ type: "step/end", data: { turn: 1, step: 1 } });
  events.push({ type: "step/start", data: { turn: 1, step: 2 } });
  events.push({ type: "reasoning-chunks", data: { turn: 1, step: 2, texts: ["z".repeat(700)] } });
  const acc17 = 1 + (8000 / (4000 / 3.5 + 7 / 2.5 + 4000 / 2.5) - 1) * 0.5;
  const inputCny = (100 * flashMiss(now) + 5000 * flashRead(now)) / 1e6;
  const est4 = step1Exact + inputCny + 700 / 3.5 * acc17 * outP / 1e6;
  const t4 = groupTextsOf(render(env, runningProps));
  check("turn base persists across steps (exact + carry + corrected new estimate)", t4.indexOf("(估)") === -1 && Math.abs(cnyOf(t4) - est4) < 0.0051, t4 + " expected " + est4.toFixed(2));
}

// Scenario 18: 本轮 is TURN-scoped (density calibration, no acc change —
// settle came via assistant/message without a usage chunk)
{
  const events = [
    { type: "turn/start", data: { turn: 1 } },
    { type: "step/start", data: { turn: 1, step: 1 } },
    { type: "reasoning-chunks", data: { turn: 1, step: 1, texts: ["a".repeat(3500)] } },
    { type: "assistant/message", data: { turn: 1, step: 1, usage: { inputTokens: 100, outputTokens: 4000, cacheReadTokens: 500 }, message: { source: { model: "deepseek-v4-flash" } } } },
    { type: "step/end", data: { turn: 1, step: 1 } },
    { type: "step/start", data: { turn: 1, step: 2 } },
    { type: "reasoning-chunks", data: { turn: 1, step: 2, texts: ["b".repeat(700)] } }
  ];
  applyWith({ binding: () => ({ session: { events } }) });
  const env = makeEnv();
  seedLive(env, {
    completed: null, openStepStart: Date.now() - 1000, pendingMin: null, toolPhaseStart: null,
    rootCostCny: 0.05, unpricedSteps: 0, invalidSteps: 0, pricing: null, budget: null
  });
  const runningProps = {
    ...propsWithData,
    useSessions: () => ({ byId: { "session-test": { running: true } } })
  };
  const now = Date.now();
  const missP = flashMiss(now);
  const readP = flashRead(now);
  const outP = flashOut(now);
  const step1 = (100 * missP + 500 * readP + 4000 * outP) / 1e6;
  const inputCarry = (100 * missP + 500 * readP) / 1e6;
  const turn1Shown = step1 + inputCarry + 200 * outP / 1e6;
  const t1 = groupTextsOf(render(env, runningProps));
  check("multi-step turn accumulates (exact step1 + estimate step2)", t1.indexOf("(估)") === -1 && Math.abs(cnyOf(t1) - turn1Shown) < 0.0051, t1 + " expected " + turn1Shown.toFixed(2));
  events.push({ type: "step/end", data: { turn: 1, step: 2 } });
  events.push({ type: "turn/end", data: { turn: 1 } });
  const tEnd = groupTextsOf(render(env, runningProps));
  check("turn/end keeps the final turn cost (no reset to 0)", Math.abs(cnyOf(tEnd) - step1) < 0.0051 && tEnd.indexOf("(估)") === -1, tEnd + " expected " + step1.toFixed(2));
  events.push({ type: "turn/start", data: { turn: 2 } });
  events.push({ type: "step/start", data: { turn: 2, step: 1 } });
  events.push({ type: "reasoning-chunks", data: { turn: 2, step: 1, texts: ["c".repeat(700)] } });
  const turn2Shown = inputCarry + 200 * outP / 1e6;
  const t2 = groupTextsOf(render(env, runningProps));
  check("turn/start resets the exact base (本轮 = new turn only)", t2.indexOf("(估)") === -1 && Math.abs(cnyOf(t2) - turn2Shown) < 0.0051, t2 + " expected " + turn2Shown.toFixed(2));
  const histEvents = [
    { type: "step/start", data: { turn: 9, step: 1 } },
    { type: "assistant/message", data: { turn: 9, step: 1, usage: { inputTokens: 9000, outputTokens: 9000, cacheReadTokens: 9000 }, message: { source: { model: "deepseek-v4-pro" } } } },
    { type: "step/end", data: { turn: 9, step: 1 } }
  ];
  applyWith({ binding: () => ({ session: { events: histEvents } }) });
  const envH = makeEnv();
  seedLive(envH, env.states[HOOK.live].value);
  const tH = groupTextsOf(render(envH, runningProps));
  check("pre-loaded history stays out of 本轮 (fold starts at turn/start)", /本轮 ¥0\.00/.test(tH) && tH.indexOf("(估)") === -1, tH);
}

// Scenario 19: two-tier low-balance alert — amber ≤ warn, red ≤ critical
{
  const liveWith = (budget) => ({
    value: {
      completed: null, openStepStart: null, pendingMin: null, toolPhaseStart: null,
      rootCostCny: 0.05, unpricedSteps: 0, invalidSteps: 0, pricing: null,
      budget: budget
    }
  });
  const renderWith = (amount, budget) => {
    applyWith({});
    const env = makeEnv();
    seedBalance(env, { text: "DeepSeek ¥" + amount, label: "DeepSeek", amount, currency: "CNY", granted: null, toppedUp: null });
    seedLive(env, liveWith(budget).value);
    env.states[HOOK.hovered] = { value: true };
    env.states[HOOK.anchor] = { value: { left: 100, top: 100 } };
    return render(env, propsWithData);
  };
  const balSpanOf = (el) => {
    const flat = flatEls(el);
    return flat.find((c) => c && c.props && typeof c.props.className === "string" &&
      c.props.className.indexOf("item") !== -1 && String((c.children || []).join ? (c.children || []).join("") : "").indexOf("余额") !== -1);
  };
  const defaults = { balanceWarnCny: 20, balanceCriticalCny: 5 };

  const elWarn = renderWith(8.67, defaults);
  const warnSpan = balSpanOf(elWarn);
  const warnText = (warnSpan && warnSpan.children || []).join("");
  check("balance ≤ warn → amber ⚠", /^⚠ /.test(warnText) && warnSpan.props.style.color === "#f59e0b", warnText + " " + JSON.stringify(warnSpan && warnSpan.props.style));

  const elCrit = renderWith(4, defaults);
  const critSpan = balSpanOf(elCrit);
  const critText = (critSpan && critSpan.children || []).join("");
  check("balance ≤ critical → red ⚠", /^⚠ /.test(critText) && critSpan.props.style.color === "#ef4444", critText + " " + JSON.stringify(critSpan && critSpan.props.style));
  check("critical popover still shows recharge (bold)", popTextOf(elCrit).indexOf("充值 ↗") !== -1, popTextOf(elCrit));

  const elOk = renderWith(25, defaults);
  const okText = (balSpanOf(elOk) && balSpanOf(elOk).children || []).join("");
  check("balance above warn → no alert", !/^⚠ /.test(okText), okText);

  const elOff = renderWith(4, { balanceWarnCny: 0, balanceCriticalCny: 0 });
  const offText = (balSpanOf(elOff) && balSpanOf(elOff).children || []).join("");
  check("alerts disabled with 0", !/^⚠ /.test(offText), offText);

  // a ZERO balance is a legal value (alert + recharge, not "no answer")
  const elZero = renderWith(0, defaults);
  const zeroText = (balSpanOf(elZero) && balSpanOf(elZero).children || []).join("");
  check("balance 0 is accepted (red alert, ¥0 shown)", /^⚠ /.test(zeroText) && zeroText.indexOf("¥0") !== -1, zeroText);
}

// Scenario 20: streaming densities self-calibrate from settled steps (EMA)
{
  const events = [
    { type: "turn/start", data: { turn: 1 } },
    { type: "step/start", data: { turn: 1, step: 1 } },
    { type: "reasoning-chunks", data: { turn: 1, step: 1, texts: ["q".repeat(7000)] } },
    { type: "assistant/chunk", data: { turn: 1, step: 1, chunk: { type: "usage", usage: { inputTokens: 100, outputTokens: 0, cacheReadTokens: 500, reasoningTokens: 1000 } } } },
    { type: "assistant/message", data: { turn: 1, step: 1, usage: { inputTokens: 100, outputTokens: 0, cacheReadTokens: 500, reasoningTokens: 1000 }, message: { source: { model: "deepseek-v4-flash" } } } },
    { type: "step/end", data: { turn: 1, step: 1 } },
    { type: "step/start", data: { turn: 1, step: 2 } },
    { type: "reasoning-chunks", data: { turn: 1, step: 2, texts: ["r".repeat(700)] } }
  ];
  applyWith({ binding: () => ({ session: { events } }) });
  const env = makeEnv();
  seedLive(env, {
    completed: null, openStepStart: Date.now() - 1000, pendingMin: null, toolPhaseStart: null,
    rootCostCny: 0.05, unpricedSteps: 0, invalidSteps: 0, pricing: null, budget: null
  });
  const runningProps = {
    ...propsWithData,
    useSessions: () => ({ byId: { "session-test": { running: true } } })
  };
  const now = Date.now();
  const missP = flashMiss(now);
  const readP = flashRead(now);
  const outP = flashOut(now);
  // EMA density: 0.7*3.5 + 0.3*(7000/1000) = 4.55
  const adaptedDensity = 0.5 * 3.5 + 0.5 * (7000 / 1000);
  // reasoning 1000 billed at output rate — output=0 reasoning=1000 is the
  // illegal subset the OLD contract billed; new contract: outputTokens is
  // billed (0 here), reasoning is display-only → step cost = input only
  const step1Exact = (100 * missP + 500 * readP + 0 * outP) / 1e6;
  const inputCarry = (100 * missP + 500 * readP) / 1e6;
  const expected = step1Exact + inputCarry + 700 / adaptedDensity * outP / 1e6;
  const t = groupTextsOf(render(env, runningProps));
  check("densities adapt after a settled step (EMA; reasoning subset not billed)", t.indexOf("(估)") === -1 && Math.abs(cnyOf(t) - expected) < 0.0051, t + " expected " + expected.toFixed(2));
}

// Scenario 21: two-row layout with MID-ellipsis
{
  applyWith({});
  const env = makeEnv();
  render(env, propsWithData);
  const lineRef = env.states[HOOK.lineRef];
  const itemRef = env.states[HOOK.itemRefs];
  const probeRef = env.states[HOOK.probe];
  const measure = env.states[HOOK.measure].current;
  lineRef.current = { clientWidth: 120 };
  probeRef.current = { offsetWidth: 20 };
  for (let i = 0; i < 7; i++) itemRef.current[i] = { offsetWidth: 60, idx: i };
  measure();
  const el1 = render(env, propsWithData);
  const flat1 = flatEls(el1);
  const rendered1 = flat1.filter((c) => c && c.props && typeof c.props.className === "string" && c.props.className.indexOf("item") !== -1);
  const texts1 = rendered1.map((g) => (g.children || []).join ? g.children.join("") : g.children).join(" | ");
  const marker1 = flat1.find((c) => c && c.props && typeof c.props.className === "string" && c.props.className.indexOf("ellipsis") !== -1);
  check("trailing ⋯: order preserved, overflow falls into ⋯",
    !!marker1 && texts1.indexOf("⋯") !== -1 &&
    /^(高峰中|空闲中)/.test(texts1) && texts1.indexOf("本轮") !== -1 &&
    texts1.indexOf("LLM 45s") === -1 && texts1.indexOf("输入 1000 · 输出 200") === -1,
    texts1);
  const seps1 = flat1.filter((c) => c && c.props && typeof c.props.className === "string" &&
    c.props.className.indexOf("dsh-better-stats-sep") !== -1 && c.props.className.indexOf("probe") === -1);
  const sepTexts1 = seps1.map((s) => s.props.className.indexOf("sep-hidden") !== -1 ? "hidden" : ((s.children || []).join ? s.children.join("") : s.children));
  check("ellide: no | at row start or before ⋯", sepTexts1.length <= 1 && sepTexts1.every((t) => t === "hidden"), JSON.stringify(sepTexts1));

  const env2 = makeEnv();
  render(env2, propsWithData);
  const lineRef2 = env2.states[HOOK.lineRef];
  const itemRef2 = env2.states[HOOK.itemRefs];
  const probeRef2 = env2.states[HOOK.probe];
  lineRef2.current = { clientWidth: 1000 };
  probeRef2.current = { offsetWidth: 20 };
  for (let i = 0; i < 7; i++) itemRef2.current[i] = { offsetWidth: 60, idx: i };
  env2.states[HOOK.measure].current();
  const el2 = render(env2, propsWithData);
  const flat2 = flatEls(el2);
  check("no ⋯ when everything fits",
    !flat2.some((c) => c && c.props && typeof c.props.className === "string" && c.props.className.indexOf("ellipsis") !== -1),
    "marker present");
}

// Scenario 22: the FIRST step of a turn — its usage chunk arrives before any
// model is known → it stays UNKNOWN/unpriced (never silently priced at
// flash); the message that follows (with usage) corrects the fold.
{
  const events = [
    { type: "turn/start", data: { turn: 1 } },
    { type: "step/start", data: { turn: 1, step: 1 } },
    { type: "reasoning-chunks", data: { turn: 1, step: 1, texts: ["s".repeat(700)] } },
    { type: "assistant/chunk", data: { turn: 1, step: 1, chunk: { type: "usage", usage: { inputTokens: 100, outputTokens: 4000, cacheReadTokens: 500, reasoningTokens: 200 } } } }
  ];
  applyWith({ binding: () => ({ session: { events } }) });
  const env = makeEnv();
  seedLive(env, {
    completed: null, openStepStart: null, pendingMin: null, toolPhaseStart: null,
    rootCostCny: 0.05, unpricedSteps: 0, invalidSteps: 0, pricing: null, budget: null
  });
  const runningProps = {
    ...propsWithData,
    useSessions: () => ({ byId: { "session-test": { running: true } } })
  };
  const t = groupTextsOf(render(env, runningProps));
  check("first-step chunk with no known model stays unpriced (¥0)",
    /本轮 ¥0\.00/.test(t) && t.indexOf("(估)") === -1, t);
  // the message (with usage + model) lands → same turn:step re-folds at the
  // model's price; reasoning is a subset of output and is NOT billed again
  events.push({ type: "assistant/message", data: { turn: 1, step: 1, usage: { inputTokens: 100, outputTokens: 4000, cacheReadTokens: 500, reasoningTokens: 200 }, message: { source: { model: "deepseek-v4-flash" } } } });
  const now = Date.now();
  const step1 = (100 * flashMiss(now) + 500 * flashRead(now) + 4000 * flashOut(now)) / 1e6;
  const t2 = groupTextsOf(render(env, runningProps));
  check("message corrects the fold (output-only billing, 4000 not 4200)",
    Math.abs(cnyOf(t2) - step1) < 0.0051 && t2.indexOf("本轮 ¥" + step1.toFixed(4)) !== -1,
    t2 + " expected " + step1.toFixed(4));
}

// Scenario 23: ETA days-left row with basis/update/confidence, force-refresh
// button, and recharge link. localStorage + /today fetch are mocked.
{
  const storage = {};
  globalThis.localStorage = {
    getItem: (k) => (k in storage ? storage[k] : null),
    setItem: (k, v) => { storage[k] = String(v); },
    removeItem: (k) => { delete storage[k]; },
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url) => {
    if (String(url).indexOf("/plugins/better-stats/today") !== -1) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ date: "2026-08-18", since: 0, costCny: 0.5, monthCostCny: 3, unpricedSteps: 0, invalidSteps: 0, sessionCount: 1 }),
      });
    }
    if (String(url).indexOf("/plugins/better-stats/balance") !== -1) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ configured: true, status: "ok", provider: "deepseek-official", displayName: "DeepSeek", amount: 15, currency: "CNY", grantedBalance: 0, toppedUpBalance: 15, queriedAt: new Date().toISOString() }),
      });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve(defaultBody(url)) });
  };
  (async () => {
    try {
      applyWith({});
      const env = makeEnv();
      seedBalance(env, { text: "DeepSeek ¥15.00", label: "DeepSeek", amount: 15, currency: "CNY", decimals: 2, granted: 0, toppedUp: 15 });
      env.states[HOOK.hovered] = { value: true };
      env.states[HOOK.anchor] = { value: { left: 100, top: 100 } };
      render(env, propsWithData);
      await new Promise((r) => setTimeout(r, 0));
      const el2 = render(env, propsWithData);
      const pop = popTextOf(el2);
      check("ETA days-left row (dd hh format)", /约可用 \d+ 天 \d{1,2} 小时|约可用 \d+ 小时/.test(pop), pop);
      check("ETA cell shows ONLY the duration (no basis/update/confidence)",
        /\(约可用 \d+ 天 \d{1,2} 小时\)|\(约可用 \d+ 小时\)/.test(pop) &&
        pop.indexOf("按本工作区") === -1 && pop.indexOf("更新于") === -1 && pop.indexOf("置信度") === -1,
        pop);
      const etaPos = pop.indexOf("约可用");
      const rechargePos = pop.indexOf("充值 ↗");
      check("recharge link after ETA in one line", rechargePos !== -1 && etaPos !== -1 && etaPos < rechargePos, pop);
      const flat2 = flatEls(el2);
      const refreshItem = flat2.find((c) => c && c.props && typeof c.props.className === "string" && c.props.className.indexOf("dsh-better-stats-refresh") !== -1);
      check("balance group is a real button with native title",
        !!refreshItem && refreshItem.type === "button" && typeof refreshItem.props.onClick === "function" &&
        refreshItem.props.title === "点击余额可强制刷新" &&
        (refreshItem.children || []).length === 1 && typeof refreshItem.children[0] === "string",
        JSON.stringify(refreshItem && { type: refreshItem.type, title: refreshItem.props.title, children: refreshItem.children }));
      if (refreshItem && typeof refreshItem.props.onClick === "function") {
        refreshItem.props.onClick({ stopPropagation() {} });
        const el3 = render(env, propsWithData);
        const flat3 = flatEls(el3);
        const pulsing = flat3.some((c) => c && c.props && typeof c.props.className === "string" && c.props.className.indexOf("dsh-better-stats-refreshing") !== -1);
        check("click flashes the balance group", pulsing, "no refreshing class after click");
      }
      const etaStored = JSON.parse(storage["dsh-better-stats:eta"] || "null");
      check("ETA sample persisted (rate > 0, updatedAt, historyDays)",
        etaStored !== null && Number(etaStored.rate) > 0 &&
        typeof etaStored.updatedAt === "number" && typeof etaStored.historyDays === "number",
        JSON.stringify(etaStored));
    } finally {
      globalThis.fetch = realFetch;
      delete globalThis.localStorage;
    }
  })();
  await new Promise((r) => setTimeout(r, 20));
}

// Scenario 24: low-balance recharge link tiers
{
  applyWith({});
  const env = makeEnv();
  seedBalance(env, { text: "DeepSeek ¥3.00", label: "DeepSeek", amount: 3, currency: "CNY", decimals: 2, granted: 0, toppedUp: 3 });
  env.states[HOOK.hovered] = { value: true };
  env.states[HOOK.anchor] = { value: { left: 100, top: 100 } };
  const el = render(env, propsWithData);
  const pop = popTextOf(el);
  check("critical balance shows recharge link", pop.indexOf("充值 ↗") !== -1, pop);
}
{
  applyWith({});
  const env = makeEnv();
  seedBalance(env, { text: "DeepSeek ¥15.00", label: "DeepSeek", amount: 15, currency: "CNY", decimals: 2, granted: 0, toppedUp: 15 });
  env.states[HOOK.hovered] = { value: true };
  env.states[HOOK.anchor] = { value: { left: 100, top: 100 } };
  const el = render(env, propsWithData);
  const pop = popTextOf(el);
  check("warn-tier balance shows recharge link", pop.indexOf("充值 ↗") !== -1, pop);
}
{
  applyWith({});
  const env = makeEnv();
  seedBalance(env, { text: "DeepSeek ¥100.00", label: "DeepSeek", amount: 100, currency: "CNY", decimals: 2, granted: 40, toppedUp: 60 });
  env.states[HOOK.hovered] = { value: true };
  env.states[HOOK.anchor] = { value: { left: 100, top: 100 } };
  const el = render(env, propsWithData);
  const pop = popTextOf(el);
  check("balance above warn tier still shows recharge (always-on)", pop.indexOf("充值 ↗") !== -1, pop);
}

// Scenario 25: English UI — reload the bundle with navigator.language en-US
{
  try {
    Object.defineProperty(globalThis.navigator, "language", { value: "en-US", configurable: true });
  } catch (e) { /* keep zh */ }
  let enFactory = null;
  globalThis.window.__ModuleLoader__.load = (handoff) => { enFactory = handoff.factory; };
  new Function("window", "require", code)(globalThis.window, (spec) => {
    if (spec === "react") return reactProxy();
    throw new Error("unexpected require: " + spec);
  });
  if (enFactory) {
    let enComp = null;
    let enOpts = null;
    enFactory((spec) => {
      if (spec === "react") return reactProxy();
      throw new Error("unexpected require: " + spec);
    }).apply({
      sessions: {},
      slots: {
        inject(name, cb) { [enOpts, enComp] = cb(); },
        register(o, c) { return [o, c]; },
      },
    });
    Comp = enComp;
    options = enOpts;
    try {
      Object.defineProperty(globalThis.navigator, "language", { value: "zh-CN", configurable: true });
    } catch (e) { /* ignore */ }
    const env = makeEnv();
    const el = render(env, propsWithData);
    const flat = flatEls(el);
    const texts = flat.filter((c) => c && c.props && c.props["data-bs"] === void 0 && typeof c.props.className === "string" && c.props.className.indexOf("item") !== -1)
      .map((g) => (g.children || []).join ? g.children.join("") : g.children).join(" ");
    check("English UI: Turn/Session labels", texts.indexOf("Turn ") !== -1 && texts.indexOf("Session ") !== -1, texts);
    check("English UI: peak/off-peak label", /(Peak|Off-peak)/.test(texts), texts);
    check("English UI: In/Out token labels", /In \d/.test(texts) && /Out \d/.test(texts), texts);
    check("English strip has no Chinese leakage", !/[\u4e00-\u9fff]/.test(texts), texts);
    // full English popover: no Chinese characters may leak
    env.states[HOOK.hovered] = { value: true };
    env.states[HOOK.anchor] = { value: { left: 100, top: 100 } };
    const el2 = render(env, propsWithData);
    const pop = popTextOf(el2);
    check("English popover has no Chinese leakage", !/[\u4e00-\u9fff]/.test(pop), pop);
    check("English popover renders populated groups", pop.indexOf("Turn") !== -1 && pop.indexOf("Session") !== -1, pop);
  }
}

// Scenario 26: per-model cost appears instantly from the live event stream
{
  const events = [
    { type: "turn/start", data: { turn: 1 } },
    { type: "step/start", data: { turn: 1, step: 1 } },
    { type: "assistant/chunk", data: { turn: 1, step: 1, chunk: { type: "usage", usage: { inputTokens: 1000, outputTokens: 10000, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } } } },
    { type: "assistant/message", data: { turn: 1, step: 1, usage: { inputTokens: 1000, outputTokens: 10000, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }, message: { source: { model: "deepseek-v4-pro" } } } },
    { type: "step/end", data: { turn: 1, step: 1 } },
  ];
  applyWith({ binding: () => ({ session: { events } }) });
  const env = makeEnv();
  seedLive(env, {
    completed: null, openStepStart: null, pendingMin: null, toolPhaseStart: null,
    rootCostCny: 0, unpricedSteps: 0, invalidSteps: 0, pricing: null, budget: null
  });
  env.states[HOOK.hovered] = { value: true };
  env.states[HOOK.anchor] = { value: { left: 100, top: 100 } };
  const el = render(env, propsWithData);
  const pop = popTextOf(el);
  check("per-model row appears from the live stream (no host lag)", /v4-pro 花费 ¥0\.[0-9]{3,}/.test(pop), pop);
  check("cache popover splits turn vs total",
    pop.indexOf("本轮 缓存 0 命中 0.00%") !== -1 &&
    pop.indexOf("会话 缓存 500 命中 33.33%") !== -1,
    pop);
  check("speed popover session row", pop.indexOf("会话 首 token 平均 1.4s 25.00tok/s") !== -1, pop);
  check("Tok row from client fold usage (no host lag)",
    /输入 1000 \(100\.00%\) 输出 10\.00K \(\d+\.\d+%\)/.test(pop), pop);
  check("turns popover turn+session", pop.indexOf("本轮 1 轮 1 步") !== -1 && pop.indexOf("会话 3 轮 12 步") !== -1, pop);
  check("duration popover session row", pop.indexOf("会话 LLM 45.2s 工具 12.3s") !== -1, pop);
}

// Scenario 27: pro multi-step turn WITH a live streaming estimate
{
  const liveEvents = [];
  applyWith({ binding: () => ({ session: { events: liveEvents } }) });
  const env = makeEnv();
  seedLive(env, {
    completed: null, openStepStart: 1700000000000, pendingMin: null, toolPhaseStart: null,
    rootCostCny: 0, unpricedSteps: 0, invalidSteps: 0, pricing: null, budget: null
  });
  env.states[HOOK.hovered] = { value: true };
  env.states[HOOK.anchor] = { value: { left: 100, top: 100 } };
  const props = {
    useProjection: (key) => (key === "tokenUsage" ? TOKEN_USAGE : SESSION_STATS),
    useSessions: () => ({ byId: { "session-test": { running: true } } }),
    sessionId: "session-test",
  };
  const steps = [
    { type: "turn/start", data: { turn: 1 } },
    { type: "step/start", data: { turn: 1, step: 1 } },
    { type: "assistant/chunk", data: { turn: 1, step: 1, chunk: { type: "usage", usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } } } },
    { type: "assistant/message", data: { turn: 1, step: 1, usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }, message: { source: { model: "deepseek-v4-flash" } } } },
    { type: "step/end", data: { turn: 1, step: 1 } },
    { type: "turn/end", data: { turn: 1 } },
    { type: "turn/start", data: { turn: 2 } },
    { type: "step/start", data: { turn: 2, step: 1 } },
    { type: "text-chunks", data: { texts: ["hello world, first step streaming now"] } },
    { type: "assistant/chunk", data: { turn: 2, step: 1, chunk: { type: "usage", usage: { inputTokens: 300, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } } } },
    { type: "assistant/message", data: { turn: 2, step: 1, usage: { inputTokens: 300, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }, message: { source: { model: "deepseek-v4-pro" } } } },
    { type: "step/end", data: { turn: 2, step: 1 } },
    { type: "step/start", data: { turn: 2, step: 2 } },
    { type: "text-chunks", data: { texts: ["second step still streaming along nicely"] } },
    { type: "assistant/chunk", data: { turn: 2, step: 2, chunk: { type: "usage", usage: { inputTokens: 350, outputTokens: 60, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } } } },
    { type: "assistant/message", data: { turn: 2, step: 2, usage: { inputTokens: 350, outputTokens: 60, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }, message: { source: { model: "deepseek-v4-pro" } } } },
    { type: "step/end", data: { turn: 2, step: 2 } },
    { type: "turn/end", data: { turn: 2 } },
  ];
  let pop = "";
  for (let n = 1; n <= steps.length; n++) {
    liveEvents.push(steps[n - 1]);
    const el = render(env, props);
    pop = popTextOf(el);
    if (n === 13) {
      check("mid-turn estimate keeps settled Tok usage",
        pop.indexOf("输入 435 (30.31%) 输出 50 (33.33%)") !== -1, pop);
      check("session Tok row ticks with the live totals",
        pop.indexOf("会话 输入 1435 输出 150") !== -1, pop);
    }
    if (n === 15) {
      check("step-2 chunk lands: settled Tok usage grows",
        pop.indexOf("输入 650 (39.39%)") !== -1, pop);
      check("no model share exceeds 100%",
        !/\((1[0-9][0-9]|[2-9][0-9][0-9])(\.[0-9]+)?%\)/.test(pop), pop);
    }
  }
  seedLive(env, { completed: null, openStepStart: null, pendingMin: null, toolPhaseStart: null, rootCostCny: 0, unpricedSteps: 0, invalidSteps: 0, pricing: null, budget: null });
  {
    const el = render(env, props);
    pop = popTextOf(el);
    check("turn end: Tok row stable with real usage",
      pop.indexOf("输入 650 (39.39%) 输出 110 (52.38%)") !== -1, pop);
  }
}

// Scenario 28: a spliced subagent transcript must not hijack the parent's
// model attribution — AND its usage must not inflate the parent's 本轮 fold.
{
  const liveEvents = [];
  applyWith({ binding: () => ({ session: { events: liveEvents } }) });
  const env = makeEnv();
  seedLive(env, {
    completed: null, openStepStart: 1700000000000, pendingMin: null, toolPhaseStart: null,
    rootCostCny: 0, unpricedSteps: 0, invalidSteps: 0, pricing: null, budget: null
  });
  env.states[HOOK.hovered] = { value: true };
  env.states[HOOK.anchor] = { value: { left: 100, top: 100 } };
  const props = {
    useProjection: (key) => (key === "tokenUsage" ? TOKEN_USAGE : SESSION_STATS),
    useSessions: () => ({ byId: { "session-test": { running: true } } }),
    sessionId: "session-test",
  };
  const steps = [
    { type: "turn/start", data: { turn: 1 } },
    { type: "step/start", data: { turn: 1, step: 1 } },
    { type: "assistant/chunk", data: { turn: 1, step: 1, chunk: { type: "usage", usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } } } },
    { type: "assistant/message", data: { turn: 1, step: 1, usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }, message: { source: { model: "deepseek-v4-flash" } } } },
    { type: "step/end", data: { turn: 1, step: 1 } },
    { type: "turn/end", data: { turn: 1 } },
    { type: "turn/start", data: { turn: 2 } },
    { type: "step/start", data: { turn: 2, step: 1 } },
    // spliced subagent transcript mid-turn (its own turn/step numbering)
    { type: "step/start", data: { turn: 7, step: 1 } },
    { type: "assistant/chunk", data: { turn: 7, step: 1, chunk: { type: "usage", usage: { inputTokens: 500, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } } } },
    { type: "assistant/message", data: { turn: 7, step: 1, usage: { inputTokens: 500, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }, message: { source: { model: "deepseek-v4-flash" } } } },
    { type: "step/end", data: { turn: 7, step: 1 } },
    // parent's own stream continues
    { type: "text-chunks", data: { texts: ["pro streaming"] } },
    { type: "assistant/chunk", data: { turn: 2, step: 1, chunk: { type: "usage", usage: { inputTokens: 300, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } } } },
    { type: "assistant/message", data: { turn: 2, step: 1, usage: { inputTokens: 300, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }, message: { source: { model: "deepseek-v4-pro" } } } },
  ];
  for (let n = 1; n <= steps.length; n++) {
    liveEvents.push(steps[n - 1]);
    render(env, props);
  }
  const pop = popTextOf(render(env, props));
  const strip = groupTextsOf(render(env, props));
  check("spliced subagent usage stays out of the client fold",
    pop.indexOf("输入 1000 (76.92%) 输出 100 (66.67%)") !== -1, pop);
  check("parent pro usage lands on pro (not the subagent's model)",
    /输入 300 \(23\.08%\) 输出 50 \(33\.33%\)/.test(pop), pop);
  check("estimate attaches to the parent's model",
    /v4-pro 花费 ¥0\.[0-9]{3,}/.test(pop), pop);
  // the spliced usage must not inflate the parent turn's 本轮 amount:
  // turn 2 = pro 300/50 only (at the current tier)
  const now = Date.now();
  const proMiss = peakAt(now) ? 9.0 : 4.5;
  const proOut = peakAt(now) ? 27.0 : 13.5;
  const turn2Cny = (300 * proMiss + 50 * proOut) / 1e6;
  check("spliced usage does not inflate the parent 本轮 amount",
    Math.abs(cnyOf(strip) - turn2Cny) < 0.0051, strip + " expected " + turn2Cny.toFixed(4));
}

// Scenario 29: session-wide 轮次/耗时 tick from the client event fold
{
  const liveEvents = [];
  applyWith({ binding: () => ({ session: { events: liveEvents } }) });
  const env = makeEnv();
  seedLive(env, {
    completed: null, openStepStart: null, pendingMin: null, toolPhaseStart: null,
    rootCostCny: 0, unpricedSteps: 0, invalidSteps: 0, pricing: null, budget: null
  });
  env.states[HOOK.hovered] = { value: true };
  env.states[HOOK.anchor] = { value: { left: 100, top: 100 } };
  const props = {
    useProjection: (key) => (key === "tokenUsage" ? TOKEN_USAGE : { turns: 0, steps: 0, llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0 }),
    useSessions: () => ({ byId: { "session-test": { running: false } } }),
    sessionId: "session-test",
  };
  const steps = [
    { type: "turn/start", data: { turn: 1 }, time: 1000 },
    { type: "step/start", data: { turn: 1, step: 1 }, time: 1000 },
    { type: "assistant/chunk", data: { turn: 1, step: 1, chunk: { type: "text-delta", text: "hi" } }, time: 1500 },
    { type: "assistant/message", data: { turn: 1, step: 1, usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }, message: { source: { model: "deepseek-v4-flash" } } }, time: 2000 },
    { type: "step/end", data: { turn: 1, step: 1 }, time: 2000 },
    { type: "turn/end", data: { turn: 1 } },
    { type: "turn/start", data: { turn: 2 }, time: 5000 },
    { type: "step/start", data: { turn: 2, step: 1 }, time: 5000 },
    { type: "assistant/chunk", data: { turn: 2, step: 1, chunk: { type: "text-delta", text: "yo" } }, time: 5500 },
    { type: "assistant/message", data: { turn: 2, step: 1, usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }, message: { source: { model: "deepseek-v4-flash" } } }, time: 6000 },
    { type: "step/end", data: { turn: 2, step: 1 }, time: 6000 },
    { type: "step/start", data: { turn: 2, step: 2 }, time: 7000 },
    { type: "assistant/message", data: { turn: 2, step: 2, usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }, message: { source: { model: "deepseek-v4-flash" } } }, time: 8000 },
    { type: "step/end", data: { turn: 2, step: 2 }, time: 8000 },
  ];
  for (let n = 1; n <= steps.length; n++) {
    liveEvents.push(steps[n - 1]);
    render(env, props);
  }
  const pop = popTextOf(render(env, props));
  check("live 轮次: 2 turns 3 steps from the fold",
    pop.indexOf("会话 2 轮 3 步") !== -1, pop);
  check("live 耗时: LLM time from the fold",
    pop.indexOf("会话 LLM 3.0s") !== -1, pop);
  check("live 速率: TTFT from the fold",
    pop.indexOf("首 token 平均 0.5s") !== -1, pop);
}

// Scenario 30: live turn rows — the open step counts as step 1 immediately
{
  const liveEvents = [];
  applyWith({ binding: () => ({ session: { events: liveEvents } }) });
  const env = makeEnv();
  seedLive(env, {
    completed: null, openStepStart: Date.now() - 65000, pendingMin: null, toolPhaseStart: null,
    rootCostCny: 0, unpricedSteps: 0, invalidSteps: 0, pricing: null, budget: null
  });
  env.states[HOOK.hovered] = { value: true };
  env.states[HOOK.anchor] = { value: { left: 100, top: 100 } };
  const props = {
    useProjection: (key) => (key === "tokenUsage" ? TOKEN_USAGE : SESSION_STATS),
    useSessions: () => ({ byId: { "session-test": { running: true } } }),
    sessionId: "session-test",
  };
  const t0 = Date.now() - 65000;
  liveEvents.push({ type: "turn/start", data: { turn: 1 }, time: t0 });
  liveEvents.push({ type: "step/start", data: { turn: 1, step: 1 }, time: t0 });
  let pop = popTextOf(render(env, props));
  check("open step counts as 本轮 1 步 (not 0)",
    pop.indexOf("本轮 1 轮 1 步") !== -1, pop);
  check("open step LLM time ticks live",
    /本轮 LLM 1m 5.0s/.test(pop), pop);
  check("本轮缓存 row visible during the turn",
    pop.indexOf("本轮 缓存 0 命中 0.00%") !== -1, pop);
  liveEvents.push({ type: "step/end", data: { turn: 1, step: 1 }, time: t0 + 60000 });
  liveEvents.push({ type: "turn/end", data: { turn: 1 } });
  seedLive(env, { completed: null, openStepStart: null, pendingMin: null, toolPhaseStart: null, rootCostCny: 0, unpricedSteps: 0, invalidSteps: 0, pricing: null, budget: null });
  props.useSessions = () => ({ byId: { "session-test": { running: false } } });
  pop = popTextOf(render(env, props));
  check("本轮缓存 row persists after termination",
    pop.indexOf("本轮 缓存 0 命中 0.00%") !== -1, pop);
  check("本轮 Tok row persists after termination",
    pop.indexOf("本轮 输入 0 输出 0") !== -1, pop);
}

// Scenario 31: tool time banks into the turn total; live TTFT + decode rate
{
  const liveEvents = [];
  applyWith({ binding: () => ({ session: { events: liveEvents } }) });
  const env = makeEnv();
  const t0 = Date.now() - 4000;
  seedLive(env, {
    completed: null, openStepStart: t0, pendingMin: null, toolPhaseStart: t0 + 1000,
    rootCostCny: 0, unpricedSteps: 0, invalidSteps: 0, pricing: null, budget: null
  });
  env.states[HOOK.hovered] = { value: true };
  env.states[HOOK.anchor] = { value: { left: 100, top: 100 } };
  const props = {
    useProjection: (key) => (key === "tokenUsage" ? TOKEN_USAGE : SESSION_STATS),
    useSessions: () => ({ byId: { "session-test": { running: true } } }),
    sessionId: "session-test",
  };
  liveEvents.push({ type: "turn/start", data: { turn: 1 }, time: t0 });
  liveEvents.push({ type: "step/start", data: { turn: 1, step: 1 }, time: t0 });
  liveEvents.push({ type: "assistant/chunk", data: { turn: 1, step: 1, chunk: { type: "text-delta", text: "hi" } }, time: t0 + 500 });
  liveEvents.push({ type: "assistant/chunk", data: { turn: 1, step: 1, chunk: { type: "text-delta", text: "there" } }, time: t0 + 1500 });
  let pop = popTextOf(render(env, props));
  // 本轮 tok/s is LIVE from the first token (no maturity gate): 2 delta
  // fragments × segFactor (1.01) over the server-time decode window
  // (1500 − 500 = 1s) = 2.02 tok/s — visible immediately, and the push-domain
  // wall anchors (firstTokWall/lastTokWall) keep the settle from jumping.
  check("live speed: open-step TTFT joins the average",
    /本轮 首 token 平均 0\.5s 2\.0\d+tok\/s/.test(pop), pop);
  check("live speed: fragment rate ticks live (no maturity gate)",
    /本轮 首 token 平均 0\.5s 2\.0\d+tok\/s/.test(pop), pop);
  check("session rate row still shows tok/s",
    pop.indexOf("会话 首 token 平均 1.4s 25.00tok/s") !== -1, pop);
  check("tool phase elapsed ticks",
    /本轮 LLM 4.0s 工具 3.0s/.test(pop), pop);
  env.states[HOOK.live].value.toolPhaseStart = null;
  pop = popTextOf(render(env, props));
  check("banked tool time survives the phase end (no reset to 0)",
    /本轮 LLM 4.0s 工具 [23].0s/.test(pop), pop);
}

// Scenario 32: 本轮 tok/s = the API-standard throughput — settled output
// tokens (real output ÷ real decode — reasoning is a subset and never
// doubles the numerator) PLUS the open step's token fragments (texts/args
// lengths × segFactor ≈ real tokens) over the wall clock since first token.
// Live from the first token; the settle folds the step's REAL tokens via the
// usage chunk / message, so the displayed value equals the settled one.
{
  const liveEvents = [];
  applyWith({ binding: () => ({ session: { events: liveEvents } }) });
  const env = makeEnv();
  const t0 = Date.now() - 6000;
  seedLive(env, {
    completed: { turns: 1, steps: 1, llmMs: 2000, toolMs: 0, ttftMs: 500, ttftSteps: 1, decodeMs: 1500, decodeTokens: 30 },
    openStepStart: t0, pendingMin: null, toolPhaseStart: null,
    rootCostCny: 0, unpricedSteps: 0, invalidSteps: 0, pricing: null, budget: null
  });
  env.states[HOOK.hovered] = { value: true };
  env.states[HOOK.anchor] = { value: { left: 100, top: 100 } };
  const props = {
    useProjection: (key) => (key === "tokenUsage" ? TOKEN_USAGE : { turns: 0, steps: 0, llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0 }),
    useSessions: () => ({ byId: { "session-test": { running: true } } }),
    sessionId: "session-test",
  };
  liveEvents.push({ type: "turn/start", data: { turn: 1 }, time: t0 });
  liveEvents.push({ type: "step/start", data: { turn: 1, step: 1 }, time: t0 });
  liveEvents.push({ type: "assistant/chunk", data: { turn: 1, step: 1, chunk: { type: "text-delta", text: "streaming output here" } }, time: t0 + 1000 });
  liveEvents.push({ type: "assistant/chunk", data: { turn: 1, step: 1, chunk: { type: "text-delta", text: "more tokens now" } }, time: t0 + 2000 });
  let pop = popTextOf(render(env, props));
  check("open step: TTFT joins the average (1.00s)",
    pop.indexOf("首 token 平均 1.0s") !== -1, pop);
  check("会话 LLM ticks with the same live elapsed (in lockstep)",
    /会话 LLM 8.0s 工具 0.0s/.test(pop), pop);
  check("本轮 LLM shows the open step's elapsed",
    /本轮 LLM 6.0s/.test(pop), pop);
  // 2 delta fragments × segFactor(1.01) over the server-time decode window
  // (2000 − 1000 = 1s) = 2.02 tok/s — live immediately (no maturity gate);
  // the settle folds the real tokens via the usage chunk / message, landing
  // on the displayed value (push-domain anchors cancel the latency).
  const rate1 = 2.02;
  pop = popTextOf(render(env, props));
  check("streaming: fragment cumulative rate ticks live from the first token",
    pop.indexOf("本轮 首 token 平均 1.0s " + rate1.toFixed(2) + "tok/s") !== -1, pop);
  // step settles with output 100 + reasoning 600: the numerator must be
  // OUTPUT ONLY (100) — the old subset-double-count gave 160 → 80tok/s
  liveEvents.push({ type: "assistant/message", data: { turn: 1, step: 1, usage: { inputTokens: 10, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 600 }, message: { source: { model: "deepseek-v4-pro" } } }, time: t0 + 3000 });
  liveEvents.push({ type: "step/end", data: { turn: 1, step: 1 }, time: t0 + 3000 });
  pop = popTextOf(render(env, props));
  check("settled step: cumulative rate = REAL output tokens (100 ÷ 2s = 50.00, not 80.00)",
    /本轮 首 token 平均 1\.0s 50\.00tok\/s/.test(pop), pop);
  check("settled step: 本轮 and 会话 LLM agree (3s)",
    /本轮 LLM 3.0s/.test(pop) && /会话 LLM 3.0s/.test(pop), pop);
}

// Scenario 33: session switch — the strip is keyed by sessionId so React
// fully rebuilds estimate/model/cursor/turn/server/live state on switch.
{
  applyWith({ binding: () => ({ session: { events: [] } }) });
  const env = makeEnv();
  const el = render(env, propsWithData);
  check("strip is keyed by sessionId (full rebuild on switch)",
    el !== null && env.lastKeys.length > 0 && env.lastKeys[env.lastKeys.length - 1] === "session-test",
    JSON.stringify(env.lastKeys));
  const props2 = { ...propsWithData, sessionId: "session-other" };
  const el2 = render(env, props2);
  check("a different session gets a different key",
    env.lastKeys[env.lastKeys.length - 1] === "session-other",
    JSON.stringify(env.lastKeys));
}

// Scenario 34: full-unknown snapshot — cost ¥0 is a LEGAL answer, displayed
// with ≈ (unpriced) but never mistaken for "no data".
{
  applyWith({});
  const env = makeEnv();
  seedLive(env, {
    completed: null, openStepStart: null, pendingMin: null, toolPhaseStart: null,
    rootCostCny: 0, unpricedSteps: 1, invalidSteps: 0, pricing: null, budget: null
  });
  seedCost(env, {
    merged: { ...TOKEN_USAGE, reasoningTokens: 0 },
    costCny: 0,
    root: { costCny: 0 },
    descendants: { costCny: 0 },
    models: [{ model: "unknown", usage: TOKEN_USAGE, costCny: 0 }],
    unpricedSteps: 1, invalidSteps: 0, partial: false, failedSessionCount: 0,
    persistenceAvailable: false, descendantCount: 0, pricing: null, stale: false
  });
  env.states[HOOK.hovered] = { value: true };
  env.states[HOOK.anchor] = { value: { left: 100, top: 100 } };
  const el = render(env, propsWithData);
  const text = groupTextsOf(el);
  check("all-unknown session shows the legal zero (¥0.0000, not missing)",
    text.indexOf("会话 ¥0.0000") !== -1 && text.indexOf("≈") === -1, text);
  const pop = popTextOf(el);
  check("all-unknown popover shows 未计价 row", pop.indexOf("unknown 未计价") !== -1, pop);
}

// Scenario 35: batch chunks and sampled deltas are deduped (never both)
{
  const events = [
    { type: "turn/start", data: { turn: 1 } },
    { type: "step/start", data: { turn: 1, step: 1 } },
    { type: "text-chunks", data: { turn: 1, step: 1, texts: ["xxxx"] } },
    { type: "assistant/chunk", data: { turn: 1, step: 1, chunk: { type: "text-delta", text: "yyyy" } } }
  ];
  applyWith({ binding: () => ({ session: { events } }) });
  const env = makeEnv();
  seedLive(env, {
    completed: null, openStepStart: Date.now() - 1000, pendingMin: null, toolPhaseStart: null,
    rootCostCny: 0, unpricedSteps: 0, invalidSteps: 0, pricing: null, budget: null
  });
  const runningProps = {
    ...propsWithData,
    useSessions: () => ({ byId: { "session-test": { running: true } } })
  };
  const now = Date.now();
  const outP = flashOut(now);
  // only the batch (4 chars) counts — the delta is skipped
  const est = 4 / 2.5 * outP / 1e6;
  const t = groupTextsOf(render(env, runningProps));
  check("batch + delta dedupe: only the batch text counts",
    t.indexOf("本轮 ¥" + est.toFixed(4)) !== -1 && t.indexOf("(估)") === -1, t + " expected " + est.toFixed(4));
}

// Scenario 36: the 模型 group is the LAST popover group (below Tok):
//   模型 | v4-pro | 花费 ¥x | (占比%)
//        |        | 输入 x (占比%) | 输出 y (占比%)
// No 思考/可见 breakdown anywhere (user removed it).
{
  applyWith({});
  const env = makeEnv();
  const mergedUsage36 = { uncachedInputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 158000, reasoningTokens: 107000 };
  seedLive(env, {
    completed: null, openStepStart: null, pendingMin: null, toolPhaseStart: null,
    rootCostCny: 0.05, unpricedSteps: 0, invalidSteps: 0, pricing: null, budget: null
  });
  seedCost(env, {
    merged: mergedUsage36,
    costCny: 0.05,
    root: { costCny: 0.05 },
    descendants: { costCny: 0 },
    models: [{ model: "deepseek-v4-pro", usage: mergedUsage36, costCny: 0.05 }],
    unpricedSteps: 0, invalidSteps: 0, partial: false, failedSessionCount: 0,
    persistenceAvailable: false, descendantCount: 0, pricing: null, stale: false
  });
  env.states[HOOK.hovered] = { value: true };
  env.states[HOOK.anchor] = { value: { left: 100, top: 100 } };
  const el = render(env, propsWithData);
  const pop = popTextOf(el);
  check("Tok session row keeps only 输入/输出",
    pop.indexOf("会话 输入 1000 输出 158.00K") !== -1, pop);
  check("模型 row 1: 模型 | v4-pro | 花费 ¥x | (占比)",
    pop.indexOf("v4-pro 花费 ¥0.050000 (100.00%)") !== -1, pop);
  check("模型 rows: 输入/输出 on their own rows with value | (占比)",
    pop.indexOf("输入 1000 (100.00%) 输出 158.00K (100.00%)") !== -1, pop);
  check("模型 group has ONE short title (模型), renders below Tok",
    pop.lastIndexOf("模型") > pop.indexOf("Tok 会话"), pop);
  check("no 思考/可见 breakdown anywhere",
    pop.indexOf("思考") === -1 && pop.indexOf("可见/工具") === -1, pop);
}

// Scenario 37: partial + stale snapshot markers next to the main amount
{
  applyWith({});
  const env = makeEnv();
  seedLive(env, {
    completed: null, openStepStart: null, pendingMin: null, toolPhaseStart: null,
    rootCostCny: 0.5, unpricedSteps: 0, invalidSteps: 0, pricing: null, budget: null
  });
  seedCost(env, {
    merged: { ...TOKEN_USAGE, reasoningTokens: 0 },
    costCny: 0.5,
    root: { costCny: 0.5 },
    descendants: { costCny: 0 },
    models: [{ model: "deepseek-v4-flash", usage: TOKEN_USAGE, costCny: 0.5 }],
    unpricedSteps: 0, invalidSteps: 0, partial: true, failedSessionCount: 2,
    persistenceAvailable: true, descendantCount: 0, pricing: null, stale: true
  });
  env.states[HOOK.hovered] = { value: true };
  env.states[HOOK.anchor] = { value: { left: 100, top: 100 } };
  const el = render(env, propsWithData);
  const text = groupTextsOf(el);
  check("partial + stale snapshot marks the session amount",
    text.indexOf("会话 ¥0.5000 过期 部分") !== -1 && text.indexOf("≈") === -1, text);
  const pop = popTextOf(el);
  check("popover carries the partial note", pop.indexOf("含 2 个子会话读取失败") !== -1, pop);
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : "\n" + failures + " CHECK(S) FAILED");
process.exit(failures === 0 ? 0 : 1);
