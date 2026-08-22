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
// Node < 21 has no global navigator (it was added in Node 21), so pin the
// property when present and otherwise install a minimal global; the bundle
// reads navigator.language at load time.
function pinNavigatorLanguage(lang) {
  try {
    Object.defineProperty(globalThis.navigator, "language", { value: lang, configurable: true });
  } catch (e) {
    Object.defineProperty(globalThis, "navigator", { value: { language: lang }, configurable: true });
  }
}
{
  const forced = process.env.BS_LANG || "zh-CN";
  pinNavigatorLanguage(forced);
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
  layout: 23, sepState: 27, itemRefs: 29, probe: 30, measure: 31, lineRef: 32
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

// Scenario 6b: a group hidden by the two-row ellipsis can become shorter
// while it has no DOM ref. A changed signature must probe/reveal it instead of
// reusing the old wide cache forever.
{
  applyWith({});
  const env = makeEnv();
  let turns = 999;
  const dynamicProps = {
    ...propsWithData,
    useProjection: (key) => key === "tokenUsage" ? TOKEN_USAGE : { ...SESSION_STATS, turns }
  };
  render(env, dynamicProps);
  env.states[HOOK.lineRef].current = { clientWidth: 170 };
  env.states[HOOK.probe].current = { offsetWidth: 20 };
  [80, 90, 70, 60, 50, 40, 30].forEach((width, i) => {
    env.states[HOOK.itemRefs].current[i] = { offsetWidth: width, idx: i };
  });
  env.states[HOOK.measure].current();
  const oldOmit = env.states[HOOK.layout].value.omitFrom;
  render(env, dynamicProps);
  for (let i = oldOmit; i < env.states[HOOK.itemRefs].current.length; i++) {
    env.states[HOOK.itemRefs].current[i] = null;
  }
  turns = 0;
  render(env, dynamicProps); // changed hidden signature schedules a 1px probe
  const recovered = render(env, dynamicProps); // apply the probe layout
  check("hidden shorter group is probed and restored from behind ellipsis",
    oldOmit === 2 && env.states[HOOK.layout].value.omitFrom > oldOmit &&
      groupTextsOf(recovered).indexOf("0 轮 · 12 步") !== -1,
    "old=" + oldOmit + " new=" + JSON.stringify(env.states[HOOK.layout].value) + " text=" + groupTextsOf(recovered));
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
  events.push({ type: "assistant/chunk", data: { turn: 1, step: 1, chunk: { type: "usage", usage: { inputTokens: 100, outputTokens: 8000, cacheReadTokens: 5000 } } }, time: Date.now() });
  events.push({ type: "assistant/message", data: { turn: 1, step: 1, usage: { inputTokens: 100, outputTokens: 8000, cacheReadTokens: 5000 }, message: { source: { model: "deepseek-v4-flash" } } }, time: Date.now() });
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
    { type: "assistant/message", data: { turn: 1, step: 1, usage: { inputTokens: 100, outputTokens: 4000, cacheReadTokens: 500 }, message: { source: { model: "deepseek-v4-flash" } } }, time: Date.now() },
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
    { type: "assistant/message", data: { turn: 9, step: 1, usage: { inputTokens: 9000, outputTokens: 9000, cacheReadTokens: 9000 }, message: { source: { model: "deepseek-v4-pro" } } }, time: Date.now() },
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
    { type: "assistant/chunk", data: { turn: 1, step: 1, chunk: { type: "usage", usage: { inputTokens: 100, outputTokens: 1000, cacheReadTokens: 500, reasoningTokens: 1000 } } }, time: Date.now() },
    { type: "assistant/message", data: { turn: 1, step: 1, usage: { inputTokens: 100, outputTokens: 1000, cacheReadTokens: 500, reasoningTokens: 1000 }, message: { source: { model: "deepseek-v4-flash" } } }, time: Date.now() },
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
  // reasoningTokens is a legal subset of outputTokens; the shared 1000
  // output tokens are billed once, never once again as reasoning.
  const step1Exact = (100 * missP + 500 * readP + 1000 * outP) / 1e6;
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
    { type: "assistant/chunk", data: { turn: 1, step: 1, chunk: { type: "usage", usage: { inputTokens: 100, outputTokens: 4000, cacheReadTokens: 500, reasoningTokens: 200 } } }, time: Date.now() }
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
  events.push({ type: "assistant/message", data: { turn: 1, step: 1, usage: { inputTokens: 100, outputTokens: 4000, cacheReadTokens: 500, reasoningTokens: 200 }, message: { source: { model: "deepseek-v4-flash" } } }, time: Date.now() });
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
  pinNavigatorLanguage("en-US");
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
    pinNavigatorLanguage("zh-CN");
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
    { type: "turn/start", data: { turn: 0 } },
    { type: "step/start", data: { turn: 0, step: 1 } },
    { type: "assistant/message", data: { turn: 0, step: 1, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 500, cacheWriteTokens: 0, reasoningTokens: 0 }, message: { source: { model: "deepseek-v4-flash" } } }, time: Date.now() - 1 },
    { type: "step/end", data: { turn: 0, step: 1 } },
    { type: "turn/end", data: { turn: 0 } },
    { type: "turn/start", data: { turn: 1 } },
    { type: "step/start", data: { turn: 1, step: 1 } },
    { type: "assistant/chunk", data: { turn: 1, step: 1, chunk: { type: "usage", usage: { inputTokens: 1000, outputTokens: 10000, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } } }, time: Date.now() },
    { type: "assistant/message", data: { turn: 1, step: 1, usage: { inputTokens: 1000, outputTokens: 10000, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }, message: { source: { model: "deepseek-v4-pro" } } }, time: Date.now() },
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
    { type: "assistant/chunk", data: { turn: 1, step: 1, chunk: { type: "usage", usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } } }, time: Date.now() },
    { type: "assistant/message", data: { turn: 1, step: 1, usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }, message: { source: { model: "deepseek-v4-flash" } } }, time: Date.now() },
    { type: "step/end", data: { turn: 1, step: 1 } },
    { type: "turn/end", data: { turn: 1 } },
    { type: "turn/start", data: { turn: 2 } },
    { type: "step/start", data: { turn: 2, step: 1 } },
    { type: "text-chunks", data: { texts: ["hello world, first step streaming now"] } },
    { type: "assistant/chunk", data: { turn: 2, step: 1, chunk: { type: "usage", usage: { inputTokens: 300, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } } }, time: Date.now() },
    { type: "assistant/message", data: { turn: 2, step: 1, usage: { inputTokens: 300, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }, message: { source: { model: "deepseek-v4-pro" } } }, time: Date.now() },
    { type: "step/end", data: { turn: 2, step: 1 } },
    { type: "step/start", data: { turn: 2, step: 2 } },
    { type: "text-chunks", data: { texts: ["second step still streaming along nicely"] } },
    { type: "assistant/chunk", data: { turn: 2, step: 2, chunk: { type: "usage", usage: { inputTokens: 350, outputTokens: 60, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } } }, time: Date.now() },
    { type: "assistant/message", data: { turn: 2, step: 2, usage: { inputTokens: 350, outputTokens: 60, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }, message: { source: { model: "deepseek-v4-pro" } } }, time: Date.now() },
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
        /输入 58[78] \(\d+\.\d+%\) 输出 50 \(33\.33%\)/.test(pop), pop);
      check("session Tok row ticks with the live totals",
        /会话 输入 158[78] 输出 150/.test(pop), pop);
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
    { type: "assistant/chunk", data: { turn: 1, step: 1, chunk: { type: "usage", usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } } }, time: Date.now() },
    { type: "assistant/message", data: { turn: 1, step: 1, usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }, message: { source: { model: "deepseek-v4-flash" } } }, time: Date.now() },
    { type: "step/end", data: { turn: 1, step: 1 } },
    { type: "turn/end", data: { turn: 1 } },
    { type: "turn/start", data: { turn: 2 } },
    { type: "step/start", data: { turn: 2, step: 1 } },
    // spliced subagent transcript mid-turn (its own turn/step numbering)
    { type: "step/start", data: { turn: 7, step: 1 } },
    { type: "assistant/chunk", data: { turn: 7, step: 1, chunk: { type: "usage", usage: { inputTokens: 500, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } } }, time: Date.now() },
    { type: "assistant/message", data: { turn: 7, step: 1, usage: { inputTokens: 500, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }, message: { source: { model: "deepseek-v4-flash" } } }, time: Date.now() },
    { type: "step/end", data: { turn: 7, step: 1 } },
    // parent's own stream continues
    { type: "text-chunks", data: { texts: ["pro streaming"] } },
    { type: "assistant/chunk", data: { turn: 2, step: 1, chunk: { type: "usage", usage: { inputTokens: 300, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } } }, time: Date.now() },
    { type: "assistant/message", data: { turn: 2, step: 1, usage: { inputTokens: 300, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }, message: { source: { model: "deepseek-v4-pro" } } }, time: Date.now() },
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
  // step settles with output 100 including reasoning 60: the numerator must be
  // OUTPUT ONLY (100) — the old subset-double-count gave 160 → 80tok/s
  liveEvents.push({ type: "assistant/message", data: { turn: 1, step: 1, usage: { inputTokens: 10, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 60 }, message: { source: { model: "deepseek-v4-pro" } } }, time: t0 + 3000 });
  liveEvents.push({ type: "step/end", data: { turn: 1, step: 1 }, time: t0 + 3000 });
  const settledEl = render(env, props);
  pop = popTextOf(settledEl);
  check("settled step: cumulative rate = REAL output tokens (100 ÷ 2s = 50.00, not 80.00)",
    /本轮 首 token 平均 1\.0s 50\.00tok\/s/.test(pop), pop);
  check("settled step: 本轮 and 会话 LLM agree (3s)",
    /本轮 LLM 3.0s/.test(pop) && /会话 LLM 3.0s/.test(pop), pop);
  check("settled step: stale /live open edge is not added to completed LLM time",
    groupTextsOf(settledEl).indexOf("LLM 3s") !== -1, groupTextsOf(settledEl));
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

// Scenario 38: FIRST ROUND consistency — right after the first step settles,
// the host root snapshot (/live 1s poll, /cost 10s cache) is still 0/stale
// while the client's real-time fold already has the real cost. 会话 must
// equal 本轮 from the settle moment (freshest exact fold wins), never ¥0.
{
  const liveEvents = [
    { type: "turn/start", data: { turn: 1 }, time: Date.now() - 2000 },
    { type: "step/start", data: { turn: 1, step: 1 }, time: Date.now() - 2000 },
    { type: "assistant/chunk", data: { turn: 1, step: 1, chunk: { type: "usage", usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } } }, time: Date.now() - 1000 },
    { type: "assistant/message", data: { turn: 1, step: 1, usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }, message: { source: { model: "deepseek-v4-flash" } } }, time: Date.now() - 1000 },
    { type: "step/end", data: { turn: 1, step: 1 }, time: Date.now() - 1000 },
    { type: "turn/end", data: { turn: 1 }, time: Date.now() - 1000 },
  ];
  applyWith({ binding: () => ({ session: { events: liveEvents } }) });
  const env = makeEnv();
  // host /live poll is STALE: it has not folded the just-settled step yet
  seedLive(env, {
    completed: null, openStepStart: null, pendingMin: null, toolPhaseStart: null,
    rootCostCny: 0, unpricedSteps: 0, invalidSteps: 0, pricing: null, budget: null
  });
  // no /cost snapshot yet at all
  env.states[HOOK.hovered] = { value: true };
  env.states[HOOK.anchor] = { value: { left: 100, top: 100 } };
  const props = {
    useProjection: (key) => (key === "tokenUsage" ? TOKEN_USAGE : SESSION_STATS),
    useSessions: () => ({ byId: { "session-test": { running: true } } }),
    sessionId: "session-test",
  };
  const strip = groupTextsOf(render(env, props));
  const m = String(strip).match(/本轮 ¥([\d.]+) · 会话 ¥([\d.]+)/);
  check("first round: 会话 == 本轮 (client fold fills the stale host poll)",
    m !== null && Number(m[1]) > 0 && Math.abs(Number(m[1]) - Number(m[2])) < 0.00005,
    strip);
  const pop = popTextOf(render(env, props));
  const pm = String(pop).match(/本轮 ¥([\d.]+)/);
  const ps = String(pop).match(/会话 ¥([\d.]+)/);
  check("first round: popover 会话 row matches 本轮 row",
    pm !== null && ps !== null && Math.abs(Number(pm[1]) - Number(ps[1])) < 0.0000005,
    pop);
}

// Scenario 39: session SWITCH-BACK must not spike tok/s. The remount folds
// the existing history in ONE synchronous pass — if those replayed token
// events stamped the wall anchors, the live window would only count the time
// on the current page (numerator holds the whole step's fragments → rate
// spikes to thousands, then slowly falls). Replayed steps must use the
// SERVER-time window (real elapsed decode), and stay on it while streaming.
{
  const t0 = Date.now() - 30000; // the open step started 30s before the switch-back
  const liveEvents = [
    { type: "turn/start", data: { turn: 1 }, time: t0 },
    { type: "step/start", data: { turn: 1, step: 1 }, time: t0 },
    // batch chunks have NO time field — only sampled deltas carry ev.time
    { type: "text-chunks", data: { turn: 1, step: 1, texts: Array(100).fill("x") } },
    { type: "assistant/chunk", data: { turn: 1, step: 1, chunk: { type: "text-delta", text: "hi" } }, time: t0 + 1000 },
    { type: "text-chunks", data: { turn: 1, step: 1, texts: Array(200).fill("y") } },
  ];
  applyWith({ binding: () => ({ session: { events: liveEvents } }) });
  const env = makeEnv();
  seedLive(env, {
    completed: null, openStepStart: t0, pendingMin: null, toolPhaseStart: null,
    rootCostCny: 0, unpricedSteps: 0, invalidSteps: 0, pricing: null, budget: null
  });
  env.states[HOOK.hovered] = { value: true };
  env.states[HOOK.anchor] = { value: { left: 100, top: 100 } };
  const props = {
    useProjection: (key) => (key === "tokenUsage" ? TOKEN_USAGE : { turns: 0, steps: 0, llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0 }),
    useSessions: () => ({ byId: { "session-test": { running: true } } }),
    sessionId: "session-test",
  };
  let pop = popTextOf(render(env, props));
  // 300 fragments × 1.01 over the REAL elapsed (~29s) ≈ 10 tok/s — the true
  // average, NOT a wall-collapsed spike (would be thousands)
  const m1 = String(pop).match(/本轮 首 token 平均 1\.0s ([\d.]+)tok\/s/);
  check("switch-back: replayed open step uses the server-time window (no spike)",
    m1 !== null && Number(m1[1]) > 5 && Number(m1[1]) < 50,
    "rate=" + (m1 !== null ? m1[1] : "n/a"));
  // the session keeps streaming AFTER the switch-back: new live fragments
  // must not re-stamp the wall anchors for the replayed step either
  const spin = Date.now();
  while (Date.now() - spin < 10) { /* guarantee wall time advances */ }
  liveEvents.push({ type: "text-chunks", data: { turn: 1, step: 1, texts: Array(50).fill("z") } });
  pop = popTextOf(render(env, props));
  const m2 = String(pop).match(/本轮 首 token 平均 1\.0s ([\d.]+)tok\/s/);
  check("switch-back: live fragments after remount keep the server window",
    m2 !== null && Number(m2[1]) > 5 && Number(m2[1]) < 50,
    "rate=" + (m2 !== null ? m2[1] : "n/a"));
}

// Scenario 40: a FORKED session's 会话 must exclude the inherited SEED
// exactly like the host root fold (startIndex: seedLength) — the seed's
// usage belongs to the parent session, never to the child. The boundary
// arrives via /live (seedLength); the session fold rebuilds around it.
{
  // events 0-1 are the SEED (parent's usage), events 2+ are the child's own
  const liveEvents = [
    { type: "assistant/message", data: { turn: 1, step: 1, usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }, message: { source: { model: "deepseek-v4-flash" } } }, time: Date.now() - 4000 },
    { type: "assistant/message", data: { turn: 1, step: 2, usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }, message: { source: { model: "deepseek-v4-flash" } } }, time: Date.now() - 3000 },
    { type: "turn/start", data: { turn: 2 }, time: Date.now() - 2000 },
    { type: "step/start", data: { turn: 2, step: 1 }, time: Date.now() - 2000 },
    { type: "assistant/chunk", data: { turn: 2, step: 1, chunk: { type: "usage", usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } } }, time: Date.now() - 1000 },
    { type: "assistant/message", data: { turn: 2, step: 1, usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }, message: { source: { model: "deepseek-v4-flash" } } }, time: Date.now() - 1000 },
    { type: "step/end", data: { turn: 2, step: 1 }, time: Date.now() - 1000 },
    { type: "turn/end", data: { turn: 2 }, time: Date.now() - 1000 },
  ];
  applyWith({ binding: () => ({ session: { events: liveEvents } }) });
  const env = makeEnv();
  // the /live poll KNOWS the seed boundary (host folds from startIndex: seed)
  seedLive(env, {
    completed: null, openStepStart: null, pendingMin: null, toolPhaseStart: null,
    rootCostCny: 0, unpricedSteps: 0, invalidSteps: 0, pricing: null, budget: null,
    seedLength: 2
  });
  env.states[HOOK.hovered] = { value: true };
  env.states[HOOK.anchor] = { value: { left: 100, top: 100 } };
  const props = {
    useProjection: (key) => (key === "tokenUsage" ? TOKEN_USAGE : SESSION_STATS),
    useSessions: () => ({ byId: { "session-test": { running: false, parentId: "parent-x" } } }),
    sessionId: "session-test",
  };
  const strip = groupTextsOf(render(env, props));
  // 会话 = ONLY the child's own step (turn 2) — the two seed steps (turn 1)
  // stay out; the strip shows 本轮 == 会话 (single own turn) while the seed
  // usage would have doubled the amount if the boundary were ignored
  const m = String(strip).match(/本轮 ¥([\d.]+) · 会话 ¥([\d.]+)/);
  check("fork: 会话 excludes the seed (boundary from /live seedLength)",
    m !== null && Number(m[2]) > 0 && Math.abs(Number(m[1]) - Number(m[2])) < 0.00005,
    strip);
  const pop = popTextOf(render(env, props));
  check("fork: popover session row excludes the seed too",
    /会话 ¥([\d.]+)/.test(pop) && pop.indexOf("会话 ¥" + m[1]) !== -1, pop);
}

// Scenario 41: the exact usage chunk is the estimate hand-off point. The
// host's /live answer may still report the step as open for one poll, but no
// provisional chars/tokens/cost may survive or be counted again by message.
{
  const t0 = Date.now() - 2000;
  const events = [
    { type: "turn/start", data: { turn: 1 }, time: t0 },
    { type: "step/start", data: { turn: 1, step: 1 }, time: t0 },
    { type: "request/context", data: { turn: 1, step: 1, model: "deepseek-v4-flash" }, time: t0 },
    { type: "text-chunks", data: { turn: 1, step: 1, texts: ["x".repeat(250)] }, time: t0 + 500 },
  ];
  applyWith({ binding: () => ({ session: { events } }) });
  const env = makeEnv();
  seedLive(env, {
    completed: null, openStepStart: t0, pendingMin: null, toolPhaseStart: null,
    rootCostCny: 0, unpricedSteps: 0, invalidSteps: 0, pricing: null, budget: null,
    seedLength: 0
  });
  env.states[HOOK.hovered] = { value: true };
  env.states[HOOK.anchor] = { value: { left: 100, top: 100 } };
  const zero = { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0 };
  const zeroStats = { turns: 0, steps: 0, llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0 };
  const props = {
    useProjection: (key) => (key === "tokenUsage" ? zero : zeroStats),
    useSessions: () => ({ byId: { "session-test": { running: true } } }),
    sessionId: "session-test",
  };
  const beforeEl = render(env, props);
  const before = popTextOf(beforeEl);
  const beforeStrip = groupTextsOf(beforeEl);
  check("usage hand-off: a provisional output estimate exists before usage",
    /本轮 输入 0 输出 100\b/.test(before), before);
  check("request route prices and attributes the provisional estimate before usage",
    cnyOf(beforeStrip) > 0 && before.indexOf("v4-flash 花费 ¥") !== -1,
    beforeStrip + " | " + before);

  const exactUsage = { inputTokens: 5, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 2 };
  const settleTime = Date.now() - 100;
  events.push({ type: "assistant/chunk", data: { turn: 1, step: 1, chunk: { type: "usage", usage: exactUsage } }, time: NaN });
  const malformedEl = render(env, props);
  const malformedStrip = groupTextsOf(malformedEl);
  const malformedPop = popTextOf(malformedEl);
  check("usage hand-off: invalid sample metadata cannot erase a valid provisional estimate",
    /本轮 输入 0 输出 100\b/.test(malformedPop) && cnyOf(malformedStrip) === cnyOf(beforeStrip),
    malformedStrip + " | " + malformedPop);

  events.push({ type: "assistant/chunk", data: { turn: 1, step: 1, chunk: { type: "usage", usage: exactUsage } }, time: settleTime });
  let strip = groupTextsOf(render(env, props));
  let pop = popTextOf(render(env, props));
  const exactCost = (5 * flashMiss(settleTime) + 10 * flashOut(settleTime)) / 1e6;
  check("usage hand-off: exact usage clears every residual estimate while /live is stale-open",
    /本轮 输入 5 输出 10\b/.test(pop) && pop.indexOf("含估算 ¥0.000000") !== -1 &&
      Math.abs(cnyOf(strip) - exactCost) < 0.0001,
    strip + " | " + pop);
  check("request route prices the usage chunk before message source arrives",
    exactCost > 0 && cnyOf(strip) > 0, strip);

  events.push({ type: "assistant/message", data: { turn: 1, step: 1, usage: exactUsage, message: { source: { model: "deepseek-v4-flash" } } }, time: settleTime + 1 });
  strip = groupTextsOf(render(env, props));
  pop = popTextOf(render(env, props));
  check("usage hand-off: duplicate message sample replaces rather than double-counts",
    /本轮 输入 5 输出 10\b/.test(pop) && Math.abs(cnyOf(strip) - exactCost) < 0.0001,
    strip + " | " + pop);
  const modelUsage = env.states[22].current.byModel.get("deepseek-v4-flash").usage;
  check("usage replacement: reasoning subset is replaced with the same step sample",
    modelUsage.reasoningTokens === 2 && modelUsage.outputTokens === 10,
    JSON.stringify(modelUsage));
}

// Scenario 42: batch authority is tracked independently for reasoning, text
// and tool streams. A late batch rolls back its own earlier sampled deltas;
// a batch in one kind must not suppress fallback deltas in another kind.
{
  const estimatedOutput = (tail) => {
    const t0 = Date.now() - 1000;
    const events = [
      { type: "turn/start", data: { turn: 1 }, time: t0 },
      { type: "step/start", data: { turn: 1, step: 1 }, time: t0 },
      ...tail,
    ];
    applyWith({ binding: () => ({ session: { events } }) });
    const env = makeEnv();
    seedLive(env, {
      completed: null, openStepStart: t0, pendingMin: null, toolPhaseStart: null,
      rootCostCny: 0, unpricedSteps: 0, invalidSteps: 0, pricing: null, budget: null,
      seedLength: 0
    });
    env.states[HOOK.hovered] = { value: true };
    env.states[HOOK.anchor] = { value: { left: 100, top: 100 } };
    const props = {
      useProjection: (key) => (key === "tokenUsage"
        ? { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0 }
        : { turns: 0, steps: 0, llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0 }),
      useSessions: () => ({ byId: { "session-test": { running: true } } }),
      sessionId: "session-test",
    };
    const pop = popTextOf(render(env, props));
    const match = pop.match(/本轮 输入 0 输出 (\d+)\b/);
    return { value: match === null ? NaN : Number(match[1]), pop };
  };

  const batches = [
    { type: "reasoning-chunks", data: { turn: 1, step: 1, texts: ["rrrr"] }, time: Date.now() - 500 },
    { type: "text-chunks", data: { turn: 1, step: 1, texts: ["tttt"] }, time: Date.now() - 400 },
    { type: "tool-call-chunks", data: { turn: 1, step: 1, args: ["aaaa"] }, time: Date.now() - 300 },
  ];
  const batchOnly = estimatedOutput(batches);
  const deltaThenBatch = estimatedOutput([
    { type: "assistant/chunk", data: { turn: 1, step: 1, chunk: { type: "reasoning-delta", text: "zzzz" } }, time: Date.now() - 800 },
    { type: "assistant/chunk", data: { turn: 1, step: 1, chunk: { type: "text-delta", text: "zzzz" } }, time: Date.now() - 700 },
    { type: "assistant/chunk", data: { turn: 1, step: 1, chunk: { type: "tool-call-delta", argumentsDelta: "zzzz" } }, time: Date.now() - 600 },
    ...batches,
  ]);
  check("batch state: delta→batch rolls back provisional reasoning/text/tool",
    Number.isFinite(batchOnly.value) && deltaThenBatch.value === batchOnly.value,
    "batch=" + batchOnly.value + " delta→batch=" + deltaThenBatch.value + " | " + deltaThenBatch.pop);

  const crossKind = estimatedOutput([
    { type: "reasoning-chunks", data: { turn: 1, step: 1, texts: ["rrrr"] }, time: Date.now() - 600 },
    { type: "assistant/chunk", data: { turn: 1, step: 1, chunk: { type: "text-delta", text: "tttt" } }, time: Date.now() - 500 },
    { type: "assistant/chunk", data: { turn: 1, step: 1, chunk: { type: "tool-call-delta", argumentsDelta: "aaaa" } }, time: Date.now() - 400 },
  ]);
  check("batch state: a reasoning batch does not suppress text/tool deltas",
    crossKind.value === batchOnly.value, "batch=" + batchOnly.value + " cross-kind=" + crossKind.value + " | " + crossKind.pop);

  const toolDelta = estimatedOutput([
    { type: "assistant/chunk", data: { turn: 1, step: 1, chunk: { type: "tool-call-delta", name: "read", argumentsDelta: "{\"path\":1}" } }, time: Date.now() - 400 },
  ]);
  check("tool-call-delta contributes a finite non-zero fallback estimate",
    Number.isFinite(toolDelta.value) && toolDelta.value > 0, toolDelta.pop);
}

// Scenario 43: malformed usage never enters exact accounting or poisons the
// throughput display. It also must not erase a still-valid stream estimate.
{
  const t0 = Date.now() - 3000;
  const events = [
    { type: "turn/start", data: { turn: 1 }, time: t0 },
    { type: "step/start", data: { turn: 1, step: 1 }, time: t0 },
    { type: "request/context", data: { turn: 1, step: 1, model: "deepseek-v4-flash" }, time: t0 },
    { type: "assistant/chunk", data: { turn: 1, step: 1, chunk: { type: "text-delta", text: "x".repeat(100) } }, time: t0 + 1000 },
    { type: "assistant/chunk", data: { turn: 1, step: 1, chunk: { type: "usage", usage: { inputTokens: 1, outputTokens: Infinity, reasoningTokens: 0 } } }, time: t0 + 1500 },
    { type: "assistant/chunk", data: { turn: 1, step: 1, chunk: { type: "usage", usage: { inputTokens: -1, outputTokens: 10, reasoningTokens: 0 } } }, time: t0 + 1600 },
    { type: "assistant/chunk", data: { turn: 1, step: 1, chunk: { type: "usage", usage: { inputTokens: 1, outputTokens: 2.5, reasoningTokens: 0 } } }, time: t0 + 1700 },
    { type: "assistant/chunk", data: { turn: 1, step: 1, chunk: { type: "usage", usage: { inputTokens: 1, outputTokens: 10, reasoningTokens: 11 } } }, time: t0 + 1800 },
  ];
  applyWith({ binding: () => ({ session: { events } }) });
  const env = makeEnv();
  seedLive(env, {
    completed: { turns: 0, steps: 0, llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 1, decodeTokens: Infinity },
    openStepStart: t0, pendingMin: null, toolPhaseStart: null,
    rootCostCny: 0, unpricedSteps: 0, invalidSteps: 4, pricing: null, budget: null,
    seedLength: 0
  });
  env.states[HOOK.hovered] = { value: true };
  env.states[HOOK.anchor] = { value: { left: 100, top: 100 } };
  const props = {
    useProjection: (key) => (key === "tokenUsage"
      ? { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0 }
      : { turns: 0, steps: 0, llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: Infinity, decodeTokens: Infinity }),
    useSessions: () => ({ byId: { "session-test": { running: true } } }),
    sessionId: "session-test",
  };
  const pop = popTextOf(render(env, props));
  check("strict usage: non-finite/negative/fractional/subset-invalid samples are ignored",
    /本轮 输入 0 输出 40\b/.test(pop), pop);
  check("finite rate: malformed usage and host stats never render Infinity/NaN",
    pop.indexOf("Infinity") === -1 && pop.indexOf("NaN") === -1, pop);
}

// Scenario 44: a complete spliced child turn, including turn/end, must not
// terminate the parent's in-flight turn or hijack its active route.
{
  const t0 = Date.now() - 3000;
  const events = [
    { type: "turn/start", data: { turn: 1 }, time: t0 },
    { type: "step/start", data: { turn: 1, step: 1 }, time: t0 },
    { type: "request/context", data: { turn: 1, step: 1, model: "deepseek-v4-flash" }, time: t0 },
    { type: "assistant/chunk", data: { turn: 1, step: 1, chunk: { type: "text-delta", text: "parent" } }, time: t0 + 300 },
    { type: "turn/start", data: { turn: 7 }, time: t0 + 500 },
    { type: "request/context", data: { model: "deepseek-v4-pro" }, time: t0 + 550 },
    { type: "text-chunks", data: { texts: ["child-only"] }, time: t0 + 575 },
    { type: "step/start", data: { turn: 7, step: 1 }, time: t0 + 600 },
    { type: "assistant/message", data: { turn: 7, step: 1, usage: { inputTokens: 500, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }, message: { source: { model: "deepseek-v4-pro" } } }, time: t0 + 900 },
    { type: "step/end", data: { turn: 7, step: 1 }, time: t0 + 1000 },
    { type: "turn/end", data: { turn: 7 }, time: t0 + 1100 },
    { type: "assistant/chunk", data: { turn: 1, step: 1, chunk: { type: "usage", usage: { inputTokens: 5, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 2 } } }, time: t0 + 2000 },
  ];
  applyWith({ binding: () => ({ session: { events } }) });
  const env = makeEnv();
  seedLive(env, {
    completed: null, openStepStart: t0, pendingMin: null, toolPhaseStart: null,
    rootCostCny: 0, unpricedSteps: 0, invalidSteps: 0, pricing: null, budget: null,
    seedLength: 0
  });
  env.states[HOOK.hovered] = { value: true };
  env.states[HOOK.anchor] = { value: { left: 100, top: 100 } };
  const props = {
    useProjection: (key) => (key === "tokenUsage"
      ? { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0 }
      : { turns: 0, steps: 0, llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0 }),
    useSessions: () => ({ byId: { "session-test": { running: true } } }),
    sessionId: "session-test",
  };
  const pop = popTextOf(render(env, props));
  check("spliced child turn/end leaves the parent turn active for its later usage",
    /本轮 输入 5 输出 10\b/.test(pop) && pop.indexOf("本轮 1 轮") !== -1, pop);
check("spliced child message does not hijack the parent's request route",
    pop.indexOf("v4-flash 花费 ¥") !== -1 && pop.indexOf("v4-pro 花费 ¥") === -1, pop);
}

// Scenario 45: revision freshness is independent of the numeric amount. A
// newer /live root may be smaller than /cost; descendants are added once and
// root accounting flags must come from the same selected revision.
{
  applyWith({});
  const env = makeEnv();
  const rootUsage = { uncachedInputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 2, reasoningTokens: 0 };
  const descUsage = { uncachedInputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 3, reasoningTokens: 0 };
  const pricing = { source: "official", version: 0, tables: HOST_TABLES, ledger: [] };
  seedLive(env, {
    completed: null, openStepStart: null, pendingMin: null, toolPhaseStart: null,
    rootCostCny: 0.2, rootUsage, models: [{ model: "deepseek-v4-flash", usage: rootUsage, costCny: 0.2 }],
    eventRevision: 11, seedLength: 0, unpricedSteps: 1, invalidSteps: 0, pricing, budget: null
  });
  seedCost(env, {
    merged: { uncachedInputTokens: 1020, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 103, reasoningTokens: 0 },
    costCny: 0.6,
    root: { usage: { uncachedInputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 100, reasoningTokens: 0 }, costCny: 0.5, models: [], unpricedSteps: 0, invalidSteps: 0 },
    descendants: { usage: descUsage, costCny: 0.1, models: [{ model: "deepseek-v4-pro", usage: descUsage, costCny: 0.1 }], unpricedSteps: 2, invalidSteps: 0 },
    models: [], unpricedSteps: 2, invalidSteps: 0, partial: false, failedSessionCount: 0,
    descendantCount: 1, rootEventRevision: 10, eventRevision: 12, pricingVersion: 0, pricing, stale: false
  });
  env.states[HOOK.hovered] = { value: true };
  env.states[HOOK.anchor] = { value: { left: 100, top: 100 } };
  const el = render(env, propsWithData);
  const strip = groupTextsOf(el);
  const pop = popTextOf(el);
  check("revision merge: newer smaller live root wins and descendant cost is added once",
    strip.indexOf("会话 ¥0.3000") !== -1, strip);
  check("revision merge: token/model tail comes from the same root + descendants",
    pop.indexOf("会话 输入 30 输出 5") !== -1 &&
      pop.indexOf("v4-flash 花费 ¥0.200000") !== -1 && pop.indexOf("v4-pro 花费 ¥0.100000") !== -1,
    pop);
  check("revision merge: accounting flags follow the selected live root",
    pop.indexOf("含 3 步未定价") !== -1, pop);
}

// Scenario 46: equal revisions are corrected by the host even when the legal
// corrected value is zero. Without revisions, the legacy stale-zero heuristic
// remains in effect (covered by Scenario 38).
{
  const t0 = Date.now() - 1000;
  const usage46 = { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
  const events = [
    { type: "request/context", data: { model: "deepseek-v4-flash" }, time: t0 },
    { type: "turn/start", data: { turn: 1 }, time: t0 },
    { type: "step/start", data: { turn: 1, step: 1 }, time: t0 },
    { type: "assistant/chunk", data: { turn: 1, step: 1, chunk: { type: "usage", usage: usage46 } }, time: t0 + 500 },
    { type: "assistant/message", data: { turn: 1, step: 1, usage: usage46, message: { source: { model: "deepseek-v4-flash" } } }, time: t0 + 500 },
    { type: "step/end", data: { turn: 1, step: 1 }, time: t0 + 500 },
  ];
  applyWith({ binding: () => ({ session: { events } }) });
  const env = makeEnv();
  const zero = { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0 };
  seedLive(env, {
    completed: null, openStepStart: null, pendingMin: null, toolPhaseStart: null,
    rootCostCny: 0, rootUsage: zero, models: [], eventRevision: events.length,
    seedLength: 0, unpricedSteps: 0, invalidSteps: 0,
    pricing: { source: "official", version: 0, tables: HOST_TABLES, ledger: [] }, budget: null
  });
  env.states[HOOK.hovered] = { value: true };
  env.states[HOOK.anchor] = { value: { left: 100, top: 100 } };
  const props = {
    useProjection: (key) => key === "tokenUsage" ? zero : { turns: 0, steps: 0, llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0 },
    useSessions: () => ({ byId: { "session-test": { running: false } } }),
    sessionId: "session-test",
  };
  const el = render(env, props);
  const strip = groupTextsOf(el);
  const pop = popTextOf(el);
  check("revision tie: host legal zero corrects a non-zero client fold",
    /本轮 ¥0\.\d+ · 会话 ¥0\.0000/.test(strip), strip);
  check("revision tie: host usage corrects session tokens down to zero",
    pop.indexOf("会话 输入 0 输出 0") !== -1, pop);
}

// Scenario 47: a pricing-version change reprices already-settled samples at
// their event time instead of leaving the client fold on the bootstrap table.
{
  const t0 = Date.now() - 1000;
  const usage47 = { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
  const events = [
    { type: "request/context", data: { model: "deepseek-v4-flash" }, time: t0 },
    { type: "turn/start", data: { turn: 1 }, time: t0 },
    { type: "step/start", data: { turn: 1, step: 1 }, time: t0 },
    { type: "assistant/message", data: { turn: 1, step: 1, usage: usage47, message: { source: { model: "deepseek-v4-flash" } } }, time: t0 + 500 },
    { type: "step/end", data: { turn: 1, step: 1 }, time: t0 + 500 },
  ];
  applyWith({ binding: () => ({ session: { events } }) });
  const env = makeEnv();
  const oldPricing = { source: "official", version: 0, tables: HOST_TABLES, ledger: [] };
  seedLive(env, { completed: null, openStepStart: null, pendingMin: null, toolPhaseStart: null,
    rootCostCny: 0, unpricedSteps: 0, invalidSteps: 0, seedLength: 0, pricing: oldPricing, budget: null });
  const props = {
    useProjection: (key) => key === "tokenUsage" ? TOKEN_USAGE : SESSION_STATS,
    useSessions: () => ({ byId: { "session-test": { running: false } } }),
    sessionId: "session-test",
  };
  const before = cnyOf(groupTextsOf(render(env, props)));
  const cheapTables = {
    "deepseek-v4-flash": { miss: 1, read: 1, out: 1, missPeak: 1, readPeak: 1, outPeak: 1 },
    "deepseek-v4-pro": { miss: 1, read: 1, out: 1, missPeak: 1, readPeak: 1, outPeak: 1 }
  };
  env.states[HOOK.live].value.pricing = { source: "official", version: 1, tables: cheapTables,
    ledger: [{ effectiveAt: 0, version: 1, tables: cheapTables }] };
  const after = cnyOf(groupTextsOf(render(env, props)));
  check("pricing refresh: settled client samples are repriced exactly once",
    before > after && Math.abs(after - 0.0011) < 0.00005, "before=" + before + " after=" + after);
}

// Scenario 48: the fork seed boundary applies to timing, tokens and model
// attribution too—not just the monetary total.
{
  const t0 = Date.now() - 5000;
  const parentUsage = { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
  const childUsage = { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
  const events = [
    { type: "request/context", data: { model: "deepseek-v4-pro" }, time: t0 },
    { type: "turn/start", data: { turn: 1 }, time: t0 },
    { type: "step/start", data: { turn: 1, step: 1 }, time: t0 },
    { type: "assistant/chunk", data: { turn: 1, step: 1, chunk: { type: "text-delta", text: "parent" } }, time: t0 + 500 },
    { type: "assistant/message", data: { turn: 1, step: 1, usage: parentUsage, message: { source: { model: "deepseek-v4-pro" } } }, time: t0 + 1000 },
    { type: "step/end", data: { turn: 1, step: 1 }, time: t0 + 1000 },
    { type: "request/context", data: { model: "deepseek-v4-flash" }, time: t0 + 2000 },
    { type: "turn/start", data: { turn: 2 }, time: t0 + 2000 },
    { type: "step/start", data: { turn: 2, step: 1 }, time: t0 + 2000 },
    { type: "assistant/chunk", data: { turn: 2, step: 1, chunk: { type: "text-delta", text: "child" } }, time: t0 + 2500 },
    { type: "assistant/message", data: { turn: 2, step: 1, usage: childUsage, message: { source: { model: "deepseek-v4-flash" } } }, time: t0 + 3000 },
    { type: "step/end", data: { turn: 2, step: 1 }, time: t0 + 3000 },
  ];
  applyWith({ binding: () => ({ session: { events } }) });
  const env = makeEnv();
  seedLive(env, { completed: null, openStepStart: null, pendingMin: null, toolPhaseStart: null,
    rootCostCny: 0, unpricedSteps: 0, invalidSteps: 0, seedLength: 6, pricing: null, budget: null });
  env.states[HOOK.hovered] = { value: true };
  env.states[HOOK.anchor] = { value: { left: 100, top: 100 } };
  const zero = { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0 };
  const props = {
    useProjection: (key) => key === "tokenUsage" ? zero : { turns: 0, steps: 0, llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0 },
    useSessions: () => ({ byId: { "session-test": { running: false, parentId: "parent" } } }),
    sessionId: "session-test",
  };
  const pop = popTextOf(render(env, props));
  check("fork seed: inherited turns/timing/tokens are excluded",
    pop.indexOf("会话 1 轮 1 步") !== -1 && pop.indexOf("会话 LLM 1.0s") !== -1 &&
      pop.indexOf("会话 输入 10 输出 10") !== -1, pop);
  check("fork seed: inherited model rows are excluded",
    pop.indexOf("v4-flash 花费 ¥") !== -1 && pop.indexOf("v4-pro 花费 ¥") === -1, pop);
}

// Scenario 49: local lineage fallback accepts only origin=subagent, is cycle
// safe, and a partial snapshot with zero named failures still shows 部分.
{
  applyWith({});
  const env = makeEnv();
  env.states[HOOK.hovered] = { value: true };
  env.states[HOOK.anchor] = { value: { left: 100, top: 100 } };
  const props = {
    ...propsWithData,
    useSessions: () => ({ byId: {
      "session-test": { running: false, parentId: "sub-1", origin: "subagent" },
      "sub-1": { parentId: "session-test", origin: "subagent" },
      "ordinary-fork": { parentId: "session-test", origin: "fork" },
    } })
  };
  let pop = popTextOf(render(env, props));
  check("lineage fallback: ordinary forks are excluded and cycles do not re-add root",
    pop.indexOf("含 1 个子会话") !== -1, pop);

  const env2 = makeEnv();
  seedCost(env2, {
    merged: TOKEN_USAGE, costCny: 0.5, root: { costCny: 0.5 }, descendants: { costCny: 0 }, models: [],
    unpricedSteps: 0, invalidSteps: 0, partial: true, failedSessionCount: 0,
    persistenceAvailable: true, descendantCount: 0, pricing: null, stale: false
  });
  env2.states[HOOK.hovered] = { value: true };
  env2.states[HOOK.anchor] = { value: { left: 100, top: 100 } };
  const el2 = render(env2, props);
  pop = popTextOf(el2);
  check("partial snapshot: partial=true is visible even when failedSessionCount is zero",
    groupTextsOf(el2).indexOf("会话 ¥0.5000 部分") !== -1 && pop.indexOf("(部分)") !== -1 &&
      pop.indexOf("含 1 个子会话") !== -1,
    groupTextsOf(el2) + " | " + pop);
}

// Scenario 50: malformed turn/step coordinates cannot manufacture timing or
// completed-step counts in the client fallback while the host poll catches up.
{
  const t0 = Date.now() - 2000;
  const events = [
    { type: "turn/start", data: { turn: -1 }, time: t0 },
    { type: "step/start", data: { turn: -1, step: 1 }, time: t0 },
    { type: "assistant/chunk", data: { turn: -1, step: 1, chunk: { type: "text-delta", text: "bad" } }, time: t0 + 500 },
    { type: "assistant/message", data: { turn: -1, step: 1, usage: { inputTokens: 1, outputTokens: 1 }, message: { source: { model: "deepseek-v4-flash" } } }, time: t0 + 1000 },
    { type: "step/end", data: { turn: -1, step: 1 }, time: t0 + 1000 },
    { type: "step/end", data: { turn: "2", step: "1" }, time: t0 + 1500 },
  ];
  applyWith({ binding: () => ({ session: { events } }) });
  const env = makeEnv();
  seedLive(env, { completed: null, openStepStart: null, pendingMin: null, toolPhaseStart: null,
    rootCostCny: 0, unpricedSteps: 0, invalidSteps: 2, seedLength: 0, pricing: null, budget: null });
  env.states[HOOK.hovered] = { value: true };
  env.states[HOOK.anchor] = { value: { left: 100, top: 100 } };
  const zero = { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0 };
  const pop = popTextOf(render(env, {
    useProjection: (key) => key === "tokenUsage" ? zero : { turns: 0, steps: 0, llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0 },
    useSessions: () => ({ byId: { "session-test": { running: false } } }),
    sessionId: "session-test",
  }));
  check("strict stats: malformed turn/step ids do not enter fallback counts or timing",
    pop.indexOf("会话 0 轮 0 步") !== -1 && pop.indexOf("会话 LLM 0.0s") !== -1, pop);
}

// Scenario 51: old /cost responses did not carry descendantCount. Their
// missing field must not erase the client-side lineage count (legal 0 still can).
{
  applyWith({});
  const env = makeEnv();
  seedCost(env, {
    merged: { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0 },
    costCny: 0, root: { costCny: 0 }, descendants: { costCny: 0 }, models: [],
    unpricedSteps: 0, invalidSteps: 0, partial: false, failedSessionCount: 0,
    persistenceAvailable: false, pricing: null, stale: false
  });
  env.states[HOOK.hovered] = { value: true };
  env.states[HOOK.anchor] = { value: { left: 100, top: 100 } };
  const zero = { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0 };
  const pop = popTextOf(render(env, {
    useProjection: (key) => key === "tokenUsage" ? zero : { turns: 0, steps: 0, llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0 },
    useSessions: () => ({ byId: {
      "session-test": { running: false },
      "sub-legacy": { parentId: "session-test", origin: "subagent" },
    } }),
    sessionId: "session-test",
  }));
  check("legacy cost: missing descendantCount preserves the local subagent count",
    pop.indexOf("含 1 个子会话") !== -1, pop);
}

// Scenario 52: a present legacy session header with no seedLength is an
// explicit no-seed session, even when it has a parent link.
{
  const t0 = Date.now() - 1500;
  const ownUsage = { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
  const events = [
    { type: "request/context", data: { model: "deepseek-v4-flash" }, time: t0 },
    { type: "turn/start", data: { turn: 1 }, time: t0 },
    { type: "step/start", data: { turn: 1, step: 1 }, time: t0 },
    { type: "assistant/message", data: { turn: 1, step: 1, usage: ownUsage, message: { source: { model: "deepseek-v4-flash" } } }, time: t0 + 1000 },
    { type: "step/end", data: { turn: 1, step: 1 }, time: t0 + 1000 },
  ];
  applyWith({ binding: () => ({ session: { events, header: { origin: "subagent", parentSession: "parent" } } }) });
  const env = makeEnv();
  seedLive(env, { completed: null, openStepStart: null, pendingMin: null, toolPhaseStart: null,
    rootCostCny: 0, unpricedSteps: 0, invalidSteps: 0, pricing: null, budget: null });
  env.states[HOOK.hovered] = { value: true };
  env.states[HOOK.anchor] = { value: { left: 100, top: 100 } };
  const zero = { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0 };
  const pop = popTextOf(render(env, {
    useProjection: (key) => key === "tokenUsage" ? zero : { turns: 0, steps: 0, llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0 },
    useSessions: () => ({ byId: { "session-test": { running: false, parentId: "parent", origin: "subagent" } } }),
    sessionId: "session-test",
  }));
  check("legacy seed: a missing seedLength header folds the whole child session",
    pop.indexOf("会话 输入 10 输出 10") !== -1 && pop.indexOf("v4-flash 花费 ¥") !== -1, pop);
}

// Scenario 53: if an old host initially omits seedLength, a later authoritative
// /live boundary rewinds and rebuilds every child-only aggregate.
{
  const t0 = Date.now() - 4000;
  const parentUsage = { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
  const childUsage = { inputTokens: 8, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
  const events = [
    { type: "request/context", data: { model: "deepseek-v4-pro" }, time: t0 },
    { type: "turn/start", data: { turn: 1 }, time: t0 },
    { type: "step/start", data: { turn: 1, step: 1 }, time: t0 },
    { type: "assistant/message", data: { turn: 1, step: 1, usage: parentUsage, message: { source: { model: "deepseek-v4-pro" } } }, time: t0 + 1000 },
    { type: "step/end", data: { turn: 1, step: 1 }, time: t0 + 1000 },
    { type: "request/context", data: { model: "deepseek-v4-flash" }, time: t0 + 2000 },
    { type: "turn/start", data: { turn: 2 }, time: t0 + 2000 },
    { type: "step/start", data: { turn: 2, step: 1 }, time: t0 + 2000 },
    { type: "assistant/message", data: { turn: 2, step: 1, usage: childUsage, message: { source: { model: "deepseek-v4-flash" } } }, time: t0 + 3000 },
    { type: "step/end", data: { turn: 2, step: 1 }, time: t0 + 3000 },
  ];
  const seed = 5;
  applyWith({ binding: () => ({ session: { events } }) });
  const env = makeEnv();
  seedLive(env, { completed: null, openStepStart: null, pendingMin: null, toolPhaseStart: null,
    rootCostCny: 0, unpricedSteps: 0, invalidSteps: 0, pricing: null, budget: null });
  env.states[HOOK.hovered] = { value: true };
  env.states[HOOK.anchor] = { value: { left: 100, top: 100 } };
  const zero = { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0 };
  const props = {
    useProjection: (key) => key === "tokenUsage" ? zero : { turns: 0, steps: 0, llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0 },
    useSessions: () => ({ byId: { "session-test": { running: false, parentId: "parent" } } }),
    sessionId: "session-test",
  };
  let pop = popTextOf(render(env, props));
  check("late seed: unknown boundary never exposes inherited parent totals",
    pop.indexOf("会话 输入 0 输出 0") !== -1 && pop.indexOf("v4-pro 花费 ¥") === -1, pop);
  env.states[HOOK.live].value = { ...env.states[HOOK.live].value, seedLength: seed };
  pop = popTextOf(render(env, props));
  check("late seed: arriving boundary rebuilds child timing/tokens/model only",
    pop.indexOf("会话 1 轮 1 步") !== -1 && pop.indexOf("会话 输入 8 输出 4") !== -1 &&
      pop.indexOf("v4-flash 花费 ¥") !== -1 && pop.indexOf("v4-pro 花费 ¥") === -1, pop);
}

// Scenario 54: a newer live root must not be spliced onto descendants priced
// with a different ledger version; use the coherent /cost snapshot as a unit.
{
  applyWith({});
  const env = makeEnv();
  const zero = { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0 };
  const rootOld = { uncachedInputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 10, reasoningTokens: 0 };
  const descOld = { uncachedInputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 2, reasoningTokens: 0 };
  seedCost(env, {
    merged: { uncachedInputTokens: 120, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 12, reasoningTokens: 0 }, costCny: 0.6,
    root: { usage: rootOld, costCny: 0.5, models: [{ model: "deepseek-v4-pro", usage: rootOld, costCny: 0.5 }], unpricedSteps: 0, invalidSteps: 0 },
    descendants: { usage: descOld, costCny: 0.1, models: [{ model: "deepseek-v4-flash", usage: descOld, costCny: 0.1 }], unpricedSteps: 0, invalidSteps: 0 },
    models: [], unpricedSteps: 0, invalidSteps: 0, partial: false, failedSessionCount: 0,
    descendantCount: 1, rootEventRevision: 10, pricingVersion: 0,
    pricing: { source: "official", version: 0, tables: HOST_TABLES, ledger: [] }, stale: false
  });
  seedLive(env, { completed: null, openStepStart: null, pendingMin: null, toolPhaseStart: null,
    rootCostCny: 0.2, rootUsage: zero, models: [], eventRevision: 11, seedLength: 0,
    unpricedSteps: 0, invalidSteps: 0,
    pricing: { source: "official", version: 1, tables: HOST_TABLES, ledger: [] }, budget: null });
  const el = render(env, {
    useProjection: (key) => key === "tokenUsage" ? zero : { turns: 0, steps: 0, llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0 },
    useSessions: () => ({ byId: { "session-test": { running: false } } }),
    sessionId: "session-test",
  });
  check("revision merge: mismatched pricing versions never splice live root + old descendants",
    groupTextsOf(el).indexOf("会话 ¥0.6000") !== -1, groupTextsOf(el));
}

// Scenario 55: an unknown request route is unpriced, not absent. Its
// provisional tokens must feed the same Tok totals as a known-model estimate
// so settling real usage does not make the session total jump upward.
{
  const t0 = Date.now() - 1000;
  const events = [
    { type: "turn/start", data: { turn: 1 }, time: t0 },
    { type: "step/start", data: { turn: 1, step: 1 }, time: t0 },
    { type: "text-chunks", data: { turn: 1, step: 1, texts: ["x".repeat(250)] }, time: t0 + 500 },
  ];
  applyWith({ binding: () => ({ session: { events } }) });
  const env = makeEnv();
  seedLive(env, {
    completed: null, openStepStart: t0, pendingMin: null, toolPhaseStart: null,
    rootCostCny: 0, unpricedSteps: 0, invalidSteps: 0, pricing: null, budget: null,
    seedLength: 0
  });
  env.states[HOOK.hovered] = { value: true };
  env.states[HOOK.anchor] = { value: { left: 100, top: 100 } };
  const zero = { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0 };
  const el = render(env, {
    useProjection: (key) => key === "tokenUsage" ? zero : { turns: 0, steps: 0, llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0 },
    useSessions: () => ({ byId: { "session-test": { running: true } } }),
    sessionId: "session-test",
  });
  const pop = popTextOf(el);
  check("unknown estimate: 本轮 and 会话 Tok share the provisional output",
    /本轮 输入 0 输出 100\b/.test(pop) && /会话 输入 0 输出 100\b/.test(pop), pop);
  check("unknown estimate: the existing model group attributes tokens as unpriced",
    pop.indexOf("unknown 未计价") !== -1 && groupTextsOf(el).indexOf("输入 0 · 输出 100") !== -1,
    groupTextsOf(el) + " | " + pop);
}

// Scenario 56: provisional next-step input/cache must use the same live gate
// as output. Its animation is driven by wall time (not render/chunk count),
// advances in 本轮 + 会话 + strip together, and atomically hands off to usage.
{
  const realNow = Date.now;
  let fakeNow = realNow();
  Date.now = () => fakeNow;
  try {
    const t0 = fakeNow - 2000;
    const step2Start = fakeNow;
    const usage = { inputTokens: 100, cacheReadTokens: 50, cacheWriteTokens: 25, outputTokens: 10, reasoningTokens: 0 };
    const events = [
      { type: "turn/start", data: { turn: 1 }, time: t0 },
      { type: "step/start", data: { turn: 1, step: 1 }, time: t0 },
      { type: "assistant/message", data: { turn: 1, step: 1, usage, message: { source: { model: "deepseek-v4-flash" } } }, time: t0 + 1000 },
      { type: "step/end", data: { turn: 1, step: 1 }, time: t0 + 1000 },
      { type: "step/start", data: { turn: 1, step: 2 }, time: step2Start },
    ];
    applyWith({ binding: () => ({ session: { events } }) });
    const env = makeEnv();
    seedLive(env, {
      completed: null, openStepStart: step2Start, pendingMin: null, toolPhaseStart: null,
      rootCostCny: 0, unpricedSteps: 0, invalidSteps: 0, pricing: null, budget: null,
      seedLength: 0
    });
    env.states[HOOK.hovered] = { value: true };
    env.states[HOOK.anchor] = { value: { left: 100, top: 100 } };
    const projection = { uncachedInputTokens: 100, cacheReadTokens: 50, cacheWriteTokens: 25, outputTokens: 10, reasoningTokens: 0 };
    const zeroStats = { turns: 1, steps: 1, llmMs: 1000, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0 };
    const makeProps = (running) => ({
      useProjection: (key) => key === "tokenUsage" ? projection : zeroStats,
      useSessions: () => ({ byId: { "session-test": { running } } }),
      sessionId: "session-test",
    });
    const cacheValues = (el) => {
      const pop = popTextOf(el);
      const strip = groupTextsOf(el);
      const turn = Number((pop.match(/本轮 缓存 (\d+)/) || [])[1]);
      const session = Number((pop.match(/会话 缓存 (\d+)/) || [])[1]);
      const stripCache = Number((strip.match(/缓存 (\d+) · 命中/) || [])[1]);
      return { pop, strip, turn, session, stripCache };
    };

    const first = cacheValues(render(env, makeProps(true)));
    check("cache animation: starts close to the predictor in all three views",
      first.turn === 218 && first.session === 218 && first.stripCache === 218 &&
        /本轮 输入 245 输出 10\b/.test(first.pop),
      first.strip + " | " + first.pop);

    let sameNow = first;
    for (let ri = 0; ri < 12; ri++) sameNow = cacheValues(render(env, makeProps(true)));
    check("cache animation: render/chunk count cannot accelerate wall time",
      sameNow.turn === first.turn && sameNow.session === first.session && sameNow.stripCache === first.stripCache,
      first.pop + " | after=" + sameNow.pop);

    const timeline = [first.turn];
    let liveAtOneSecond = first;
    for (let ms = 100; ms <= 1000; ms += 100) {
      fakeNow = step2Start + ms;
      liveAtOneSecond = cacheValues(render(env, makeProps(true)));
      timeline.push(liveAtOneSecond.turn);
      check("cache animation frame " + ms + "ms: 本轮、会话 and strip stay identical",
        liveAtOneSecond.turn === liveAtOneSecond.session && liveAtOneSecond.turn === liveAtOneSecond.stripCache,
        liveAtOneSecond.strip + " | " + liveAtOneSecond.pop);
    }
    const distinctTimeline = [...new Set(timeline)];
    check("cache animation: wall-clock ticks visibly and monotonically during streaming",
      distinctTimeline.length >= 4 && timeline.every((value, index) => index === 0 || value >= timeline[index - 1]),
      JSON.stringify(timeline));

    fakeNow = step2Start + 8000;
    const beforeSettle = cacheValues(render(env, makeProps(true)));
    check("cache hand-off: provisional cache remains close to its predictor",
      beforeSettle.turn === 224 && beforeSettle.session === 224 && beforeSettle.stripCache === 224,
      beforeSettle.strip + " | " + beforeSettle.pop);

    const stoppedPop = popTextOf(render(env, makeProps(false)));
    check("estimate gate: abnormal stop clears provisional input/cache without end events",
      /本轮 输入 125 输出 10\b/.test(stoppedPop) && /会话 输入 125 输出 10\b/.test(stoppedPop) &&
        stoppedPop.indexOf("本轮 缓存 50 命中 28.57%") !== -1 &&
        stoppedPop.indexOf("会话 缓存 50 命中 28.57%") !== -1,
      stoppedPop);

    const nextUsage = { inputTokens: 100, cacheReadTokens: 175, cacheWriteTokens: 25, outputTokens: 10, reasoningTokens: 0 };
    events.push({ type: "assistant/message", data: { turn: 1, step: 2, usage: nextUsage, message: { source: { model: "deepseek-v4-flash" } } }, time: fakeNow });
    events.push({ type: "step/end", data: { turn: 1, step: 2 }, time: fakeNow });
    events.push({ type: "turn/end", data: { turn: 1 }, time: fakeNow + 1 });
    seedLive(env, { completed: null, openStepStart: null, pendingMin: null, toolPhaseStart: null,
      rootCostCny: 0, unpricedSteps: 0, invalidSteps: 0, seedLength: 0, pricing: null, budget: null });
    const settledPop = popTextOf(render(env, makeProps(false)));
    check("cache hand-off: exact usage atomically replaces the provisional cache",
      settledPop.indexOf("本轮 缓存 225 命中 47.37%") !== -1 &&
        settledPop.indexOf("会话 缓存 225 命中 47.37%") !== -1 &&
        settledPop.indexOf("本轮 输入 250 输出 20") !== -1 &&
        settledPop.indexOf("会话 输入 250 输出 20") !== -1,
      settledPop);
  } finally {
    Date.now = realNow;
  }
}

// Scenario 57: an incomplete /today fold is a lower bound. It must neither
// vote in the ETA EWMA nor reduce a same-day complete budget snapshot.
{
  // Flush effects created by preceding synchronous harness scenarios before
  // installing this scenario's isolated fetch/storage pair.
  await new Promise((resolve) => setTimeout(resolve, 0));
  const storage = {};
  globalThis.localStorage = {
    getItem: (k) => (k in storage ? storage[k] : null),
    setItem: (k, v) => { storage[k] = String(v); },
    removeItem: (k) => { delete storage[k]; },
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url) => {
    if (String(url).indexOf("/plugins/better-stats/today") !== -1) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({
        date: "2026-08-22", costCny: 5, monthCostCny: 20,
        unpricedSteps: 0, invalidSteps: 0, sessionCount: 1,
        partial: true, failedSessionCount: 1, stale: false,
        queriedAt: "2026-08-22T01:00:00.000Z",
        budget: { daily: 100, monthly: 1000 }
      }) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve(defaultBody(url)) });
  };
  try {
    applyWith({});
    const env = makeEnv();
    seedToday(env, {
      date: "2026-08-22", costCny: 10, monthCostCny: 30,
      unpricedSteps: 0, invalidSteps: 0, sessionCount: 2, at: Date.now()
    });
    render(env, propsWithData);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const kept = env.states[HOOK.today].value;
    check("partial today: same-day complete budget value never moves down",
      kept !== null && kept.costCny === 10 && kept.monthCostCny === 30,
      JSON.stringify(kept));
    check("partial today: incomplete lower bound is not persisted as an ETA sample",
      storage["dsh-better-stats:eta"] === void 0,
      storage["dsh-better-stats:eta"]);
  } finally {
    globalThis.fetch = realFetch;
  }
}

// Scenario 58: DSH can expose the completed assistant message as a flat data
// object instead of the historical data.message envelope. The exact message
// must still replace the streaming estimate immediately and authoritatively.
{
  const t0 = Date.now() - 2000;
  const exact = { inputTokens: 120, outputTokens: 40, cacheReadTokens: 20, cacheWriteTokens: 0, reasoningTokens: 10 };
  const events = [
    { type: "request/context", data: { model: "deepseek-v4-flash" }, time: t0 },
    { type: "turn/start", data: { turn: 1 }, time: t0 },
    { type: "step/start", data: { turn: 1, step: 1 }, time: t0 },
    { type: "assistant/chunk", data: { turn: 1, step: 1, chunk: { type: "text-delta", text: "provisional output that must be discarded" } }, time: t0 + 200 },
    { type: "assistant/message", data: {
      turn: 1, step: 1, usage: exact,
      role: "assistant", content: [{ type: "text", text: "done" }],
      source: { kind: "model", model: "deepseek-v4-pro" }
    }, time: t0 + 1000 },
    { type: "step/end", data: { turn: 1, step: 1 }, time: t0 + 1000 },
    { type: "turn/end", data: { turn: 1 }, time: t0 + 1001 },
  ];
  applyWith({ binding: () => ({ session: { events, header: {} } }) });
  const env = makeEnv();
  seedLive(env, {
    completed: null, openStepStart: t0, pendingMin: null, toolPhaseStart: null,
    rootCostCny: 0, unpricedSteps: 0, invalidSteps: 0, pricing: null, budget: null,
    seedLength: 0
  });
  env.states[HOOK.hovered] = { value: true };
  env.states[HOOK.anchor] = { value: { left: 100, top: 100 } };
  const zero = { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0 };
  const pop = popTextOf(render(env, {
    useProjection: (key) => key === "tokenUsage" ? zero : { turns: 0, steps: 0, llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0 },
    useSessions: () => ({ byId: { "session-test": { running: true } } }),
    sessionId: "session-test",
  }));
  check("flat assistant message: exact usage replaces the provisional turn without disappearing",
    /本轮 输入 120 输出 40\b/.test(pop) && pop.indexOf("本轮 ¥0.000000") === -1 &&
      pop.indexOf("含估算 ¥0.000000") !== -1,
    pop);
  check("flat assistant message: final source overrides the request route",
    pop.indexOf("v4-pro 花费 ¥") !== -1 && pop.indexOf("v4-flash 花费 ¥") === -1,
    pop);
  check("flat assistant message: settled timing and speed remain available",
    pop.indexOf("本轮 LLM 1.0s") !== -1 && pop.indexOf("本轮 首 token 平均 0.2s") !== -1,
    pop);
}

// Scenario 59: the client event stream leads the 1s /live poll. A real open
// client step must expose its estimate immediately instead of showing zeros
// until the first host response arrives.
{
  const t0 = Date.now() - 500;
  const events = [
    { type: "request/context", data: { model: "deepseek-v4-flash" }, time: t0 },
    { type: "turn/start", data: { turn: 1 }, time: t0 },
    { type: "step/start", data: { turn: 1, step: 1 }, time: t0 },
    { type: "text-chunks", data: { turn: 1, step: 1, texts: ["x".repeat(250)] }, time: t0 + 100 },
  ];
  applyWith({ binding: () => ({ session: { events, header: {} } }) });
  const env = makeEnv(); // live state intentionally remains null
  env.states[HOOK.hovered] = { value: true };
  env.states[HOOK.anchor] = { value: { left: 100, top: 100 } };
  const zero = { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0 };
  const el = render(env, {
    useProjection: (key) => key === "tokenUsage" ? zero : { turns: 0, steps: 0, llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0 },
    // The session-list row can lag the event binding during reconnect/mount.
    // Unknown is not an explicit stopped state.
    useSessions: () => ({ byId: {} }),
    sessionId: "session-test",
  });
  const pop = popTextOf(el);
  check("client-led live gate: estimate appears before the first /live response",
    groupTextsOf(el).indexOf("本轮 ¥0.0000 · 会话 ¥0.0000") === -1 &&
      /本轮 输入 0 输出 100\b/.test(pop) && pop.indexOf("含估算") !== -1,
    groupTextsOf(el) + " | " + pop);
}

// Scenario 60: request/context can switch models before the next step opens.
// Its provisional input/cache carry must use that new route, matching the
// model row and the eventual producer instead of being priced on the prior
// step's model.
{
  const t0 = Date.now() - 2000;
  const prior = { inputTokens: 100, cacheReadTokens: 100, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0 };
  const events = [
    { type: "request/context", data: { model: "deepseek-v4-flash" }, time: t0 },
    { type: "turn/start", data: { turn: 1 }, time: t0 },
    { type: "step/start", data: { turn: 1, step: 1 }, time: t0 },
    { type: "assistant/message", data: { turn: 1, step: 1, usage: prior, message: { source: { model: "deepseek-v4-flash" } } }, time: t0 + 1000 },
    { type: "step/end", data: { turn: 1, step: 1 }, time: t0 + 1000 },
    { type: "request/context", data: { model: "deepseek-v4-pro" }, time: t0 + 1100 },
    { type: "step/start", data: { turn: 1, step: 2 }, time: t0 + 1200 },
  ];
  applyWith({ binding: () => ({ session: { events, header: {} } }) });
  const env = makeEnv();
  seedLive(env, { completed: null, openStepStart: t0 + 1200, pendingMin: null, toolPhaseStart: null,
    rootCostCny: 0, unpricedSteps: 0, invalidSteps: 0, seedLength: 0, pricing: null, budget: null });
  env.states[HOOK.hovered] = { value: true };
  env.states[HOOK.anchor] = { value: { left: 100, top: 100 } };
  const zero = { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0 };
  const pop = popTextOf(render(env, {
    useProjection: (key) => key === "tokenUsage" ? zero : { turns: 0, steps: 0, llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0 },
    useSessions: () => ({ byId: { "session-test": { running: true } } }),
    sessionId: "session-test",
  }));
  const peak = peakAt(Date.now());
  const flashExact = (100 * (peak ? 3.0 : 1.5) + 100 * (peak ? 0.1 : 0.05)) / 1e6;
  const proCarryFull = (100 * (peak ? 9.0 : 4.5) + 200 * (peak ? 0.3 : 0.15)) / 1e6;
  const shownEstimate = (() => {
    const match = pop.match(/含估算 ¥([\d.]+)/);
    return match ? Number(match[1]) : NaN;
  })();
  check("model switch: provisional input/cache is priced on the active route",
    Number.isFinite(shownEstimate) && shownEstimate > proCarryFull * 0.95 && shownEstimate < proCarryFull &&
      pop.indexOf("本轮 ¥" + (flashExact + shownEstimate).toFixed(6)) !== -1 &&
      pop.indexOf("v4-flash 花费 ¥") !== -1 && pop.indexOf("v4-pro 花费 ¥") !== -1,
    pop);
}

// Scenario 61: long sessions expose a sequenced tail window. It can still
// drive 本轮, but must never masquerade as the complete session root.
{
  const t0 = Date.now() - 1000;
  const tailUsage = { inputTokens: 100, cacheReadTokens: 1000, cacheWriteTokens: 0, outputTokens: 10, reasoningTokens: 0 };
  const tailEvents = [
    { seq: 100, type: "request/context", data: { model: "deepseek-v4-pro" }, time: t0 },
    { seq: 101, type: "turn/start", data: { turn: 9 }, time: t0 },
    { seq: 102, type: "step/start", data: { turn: 9, step: 1 }, time: t0 },
    { seq: 103, type: "assistant/message", data: { turn: 9, step: 1, usage: tailUsage, message: { source: { model: "deepseek-v4-pro" } } }, time: t0 + 500 },
    { seq: 104, type: "step/end", data: { turn: 9, step: 1 }, time: t0 + 500 },
    { seq: 105, type: "turn/end", data: { turn: 9 }, time: t0 + 501 },
  ];
  applyWith({ binding: () => ({ session: { events: tailEvents, header: { seedLength: 0 }, baseSeq: 100, hasMore: true } }) });
  const env = makeEnv();
  const hostUsage = { uncachedInputTokens: 1000, cacheReadTokens: 5000, cacheWriteTokens: 0, outputTokens: 100, reasoningTokens: 0 };
  seedCost(env, {
    merged: hostUsage, costCny: 0.5,
    root: { costCny: 0.5, unpricedSteps: 0, invalidSteps: 0 },
    descendants: { costCny: 0, unpricedSteps: 0, invalidSteps: 0 },
    models: [{ model: "deepseek-v4-flash", usage: hostUsage, costCny: 0.5 }],
    unpricedSteps: 0, invalidSteps: 0, partial: false, failedSessionCount: 0,
    descendantCount: 0, persistenceAvailable: true, stale: false, pricing: null
  });
  seedLive(env, { completed: null, openStepStart: null, pendingMin: null, toolPhaseStart: null,
    rootCostCny: 0.9, eventRevision: 106, unpricedSteps: 0, invalidSteps: 0,
    seedLength: 0, pricing: null, budget: null });
  env.states[HOOK.hovered] = { value: true };
  env.states[HOOK.anchor] = { value: { left: 100, top: 100 } };
  const pop = popTextOf(render(env, {
    useProjection: (key) => key === "tokenUsage" ? hostUsage : { turns: 1, steps: 1, llmMs: 500, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0 },
    useSessions: () => ({ byId: { "session-test": { running: false } } }),
    sessionId: "session-test",
  }));
  check("tail window: current turn folds but incomplete root cannot override host session",
    pop.indexOf("本轮 缓存 1000 命中 90.91%") !== -1 &&
      pop.indexOf("会话 缓存 5000 命中 83.33%") !== -1 &&
      pop.indexOf("会话 输入 1000 输出 100") !== -1 &&
      pop.indexOf("会话 ¥0.500000") !== -1,
    pop);
}

// Scenario 62: even without revisions, a newer complete client root and a
// complete descendant tail must be selected as one bundle. A cost-only live
// answer cannot mix its amount with stale /cost usage or models.
{
  const t0 = Date.now() - 1000;
  const own = { inputTokens: 200, cacheReadTokens: 800, cacheWriteTokens: 0, outputTokens: 100, reasoningTokens: 0 };
  const events = [
    { type: "request/context", data: { model: "deepseek-v4-pro" }, time: t0 },
    { type: "turn/start", data: { turn: 1 }, time: t0 },
    { type: "step/start", data: { turn: 1, step: 1 }, time: t0 },
    { type: "assistant/message", data: { turn: 1, step: 1, usage: own, message: { source: { model: "deepseek-v4-pro" } } }, time: t0 + 500 },
    { type: "step/end", data: { turn: 1, step: 1 }, time: t0 + 500 },
    { type: "turn/end", data: { turn: 1 }, time: t0 + 501 },
  ];
  applyWith({ binding: () => ({ session: { events, header: { seedLength: 0 } } }) });
  const env = makeEnv();
  const oldRoot = { uncachedInputTokens: 1, cacheReadTokens: 1, cacheWriteTokens: 0, outputTokens: 1, reasoningTokens: 0 };
  const desc = { uncachedInputTokens: 20, cacheReadTokens: 200, cacheWriteTokens: 0, outputTokens: 20, reasoningTokens: 0 };
  const oldMerged = { uncachedInputTokens: 21, cacheReadTokens: 201, cacheWriteTokens: 0, outputTokens: 21, reasoningTokens: 0 };
  seedCost(env, {
    merged: oldMerged, costCny: 0.01001,
    root: { usage: oldRoot, costCny: 0.00001, models: [{ model: "deepseek-v4-flash", usage: oldRoot, costCny: 0.00001 }], unpricedSteps: 0, invalidSteps: 0 },
    descendants: { usage: desc, costCny: 0.01, models: [{ model: "deepseek-v4-flash", usage: desc, costCny: 0.01 }], unpricedSteps: 0, invalidSteps: 0 },
    models: [{ model: "deepseek-v4-flash", usage: oldMerged, costCny: 0.01001 }],
    unpricedSteps: 0, invalidSteps: 0, partial: false, failedSessionCount: 0,
    descendantCount: 1, persistenceAvailable: true, stale: true, pricing: null
  });
  seedLive(env, { completed: null, openStepStart: null, pendingMin: null, toolPhaseStart: null,
    rootCostCny: 0.5, unpricedSteps: 0, invalidSteps: 0, seedLength: 0, pricing: null, budget: null });
  env.states[HOOK.hovered] = { value: true };
  env.states[HOOK.anchor] = { value: { left: 100, top: 100 } };
  const zero = { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0 };
  const pop = popTextOf(render(env, {
    useProjection: (key) => key === "tokenUsage" ? zero : { turns: 0, steps: 0, llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0 },
    useSessions: () => ({ byId: { "session-test": { running: false }, "child": { parentId: "session-test", origin: "subagent" } } }),
    sessionId: "session-test",
  }));
  const peak = peakAt(Date.now());
  const ownCost = (200 * (peak ? 9.0 : 4.5) + 800 * (peak ? 0.3 : 0.15) + 100 * (peak ? 27.0 : 13.5)) / 1e6;
  check("legacy bundle: amount, Tok, cache and models use client root + one descendant tail",
    pop.indexOf("会话 ¥" + (ownCost + 0.01).toFixed(6)) !== -1 &&
      pop.indexOf("会话 缓存 1000 命中 81.97%") !== -1 &&
      pop.indexOf("会话 输入 220 输出 120") !== -1 &&
      pop.indexOf("v4-pro 花费 ¥") !== -1 && pop.indexOf("v4-flash 花费 ¥") !== -1 &&
      pop.indexOf("会话 ¥0.500000") === -1,
    pop);
}

// Scenario 63: loading older events prepends the sliding window and changes
// its base. The incremental cursor must rebuild once, then promote the client
// fold to a complete root without double-counting the old tail.
{
  const t0 = Date.now() - 2000;
  const currentUsage = { inputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 0, outputTokens: 5, reasoningTokens: 0 };
  const tail = [
    { seq: 2, type: "request/context", data: { model: "deepseek-v4-pro" }, time: t0 },
    { seq: 3, type: "turn/start", data: { turn: 1 }, time: t0 },
    { seq: 4, type: "step/start", data: { turn: 1, step: 1 }, time: t0 },
    { seq: 5, type: "assistant/message", data: { turn: 1, step: 1, usage: currentUsage, message: { source: { model: "deepseek-v4-pro" } } }, time: t0 + 500 },
    { seq: 6, type: "step/end", data: { turn: 1, step: 1 }, time: t0 + 500 },
    { seq: 7, type: "turn/end", data: { turn: 1 }, time: t0 + 501 },
  ];
  const sessionWindow = { events: tail, header: { seedLength: 0 }, baseSeq: 2, hasMore: true };
  applyWith({ binding: () => ({ session: sessionWindow }) });
  const env = makeEnv();
  const hostUsage = { uncachedInputTokens: 1, cacheReadTokens: 999, cacheWriteTokens: 0, outputTokens: 1, reasoningTokens: 0 };
  seedCost(env, { merged: hostUsage, costCny: 0.000001,
    root: { costCny: 0.000001, unpricedSteps: 0, invalidSteps: 0 },
    descendants: { costCny: 0, unpricedSteps: 0, invalidSteps: 0 },
    models: [{ model: "deepseek-v4-flash", usage: hostUsage, costCny: 0.000001 }],
    unpricedSteps: 0, invalidSteps: 0, partial: false, failedSessionCount: 0,
    descendantCount: 0, persistenceAvailable: true, stale: false, pricing: null });
  seedLive(env, { completed: null, openStepStart: null, pendingMin: null, toolPhaseStart: null,
    rootCostCny: 0.000001, eventRevision: 8, unpricedSteps: 0, invalidSteps: 0,
    seedLength: 0, pricing: null, budget: null });
  env.states[HOOK.hovered] = { value: true };
  env.states[HOOK.anchor] = { value: { left: 100, top: 100 } };
  const props = {
    useProjection: (key) => key === "tokenUsage" ? hostUsage : { turns: 0, steps: 0, llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0 },
    useSessions: () => ({ byId: { "session-test": { running: false } } }),
    sessionId: "session-test",
  };
  let pop = popTextOf(render(env, props));
  check("window prepend: incomplete tail keeps host session while preserving 本轮",
    pop.indexOf("本轮 缓存 20 命中 66.67%") !== -1 &&
      pop.indexOf("会话 缓存 999 命中 99.90%") !== -1,
    pop);
  const historyUsage = { inputTokens: 100, cacheReadTokens: 200, cacheWriteTokens: 0, outputTokens: 50, reasoningTokens: 0 };
  sessionWindow.events = [
    { seq: 0, type: "request/context", data: { model: "deepseek-v4-flash" }, time: t0 - 1000 },
    { seq: 1, type: "assistant/message", data: { turn: 0, step: 1, usage: historyUsage, message: { source: { model: "deepseek-v4-flash" } } }, time: t0 - 500 },
  ].concat(tail);
  sessionWindow.baseSeq = 0;
  sessionWindow.hasMore = false;
  pop = popTextOf(render(env, props));
  check("window prepend: base change rebuilds one complete root without duplicate tail",
    pop.indexOf("本轮 缓存 20 命中 66.67%") !== -1 &&
      pop.indexOf("会话 缓存 220 命中 66.67%") !== -1 &&
      pop.indexOf("会话 输入 110 输出 55") !== -1 &&
      pop.indexOf("v4-flash 花费 ¥") !== -1 && pop.indexOf("v4-pro 花费 ¥") !== -1,
    pop);
}

// Scenario 64: model rows are attribution, never the session accounting
// total. A partial legacy model breakdown must not erase exact Tok totals.
{
  applyWith({});
  const env = makeEnv();
  const exact = { uncachedInputTokens: 1000, cacheReadTokens: 500, cacheWriteTokens: 50, outputTokens: 200, reasoningTokens: 0 };
  const partial = { uncachedInputTokens: 100, cacheReadTokens: 50, cacheWriteTokens: 0, outputTokens: 20, reasoningTokens: 0 };
  seedCost(env, {
    merged: exact, costCny: 0.1,
    root: { costCny: 0.1, unpricedSteps: 0, invalidSteps: 0 },
    descendants: { costCny: 0, unpricedSteps: 0, invalidSteps: 0 },
    models: [{ model: "deepseek-v4-flash", usage: partial, costCny: 0.1 }],
    unpricedSteps: 0, invalidSteps: 0, partial: true, failedSessionCount: 1,
    descendantCount: 0, persistenceAvailable: true, stale: false, pricing: null
  });
  env.states[HOOK.hovered] = { value: true };
  env.states[HOOK.anchor] = { value: { left: 100, top: 100 } };
  const pop = popTextOf(render(env, {
    useProjection: (key) => key === "tokenUsage" ? exact : { turns: 1, steps: 1, llmMs: 1, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0 },
    useSessions: () => ({ byId: { "session-test": { running: false } } }),
    sessionId: "session-test",
  }));
  check("Tok accounting: partial model rows never replace the exact session total",
    pop.indexOf("会话 输入 1050 输出 200") !== -1 && pop.indexOf("会话 输入 100 输出 20") === -1,
    pop);
}

// Scenario 65: /live can settle before the client binding catches up. The
// open client estimate remains visible in 本轮 but is not added a second time
// to the already-closed authoritative session root.
{
  const t0 = Date.now() - 3000;
  const prior = { inputTokens: 100, cacheReadTokens: 100, cacheWriteTokens: 0, outputTokens: 10, reasoningTokens: 0 };
  const events = [
    { seq: 0, type: "request/context", data: { model: "deepseek-v4-flash" }, time: t0 },
    { seq: 1, type: "turn/start", data: { turn: 1 }, time: t0 },
    { seq: 2, type: "step/start", data: { turn: 1, step: 1 }, time: t0 },
    { seq: 3, type: "assistant/message", data: { turn: 1, step: 1, usage: prior, message: { source: { model: "deepseek-v4-flash" } } }, time: t0 + 1000 },
    { seq: 4, type: "step/end", data: { turn: 1, step: 1 }, time: t0 + 1000 },
    { seq: 5, type: "step/start", data: { turn: 1, step: 2 }, time: t0 + 2000 },
  ];
  applyWith({ binding: () => ({ session: { events, baseSeq: 0, hasMore: false, header: { seedLength: 0 } } }) });
  const env = makeEnv();
  const hostExact = { uncachedInputTokens: 200, cacheReadTokens: 200, cacheWriteTokens: 0, outputTokens: 20, reasoningTokens: 0 };
  seedLive(env, {
    completed: { turns: 1, steps: 2, llmMs: 2000, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0 },
    openStepStart: null, pendingMin: null, toolPhaseStart: null,
    rootCostCny: 1, rootUsage: hostExact,
    models: [{ model: "deepseek-v4-flash", usage: hostExact, costCny: 1 }],
    eventRevision: 7, seedLength: 0, unpricedSteps: 0, invalidSteps: 0,
    pricing: { source: "official", version: 0, tables: HOST_TABLES, ledger: [] }, budget: null
  });
  env.states[HOOK.hovered] = { value: true };
  env.states[HOOK.anchor] = { value: { left: 100, top: 100 } };
  const zero = { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0 };
  const pop = popTextOf(render(env, {
    useProjection: (key) => key === "tokenUsage" ? zero : { turns: 0, steps: 0, llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0 },
    useSessions: () => ({ byId: { "session-test": { running: true } } }),
    sessionId: "session-test",
  }));
  check("host hand-off: closed ahead root suppresses only the duplicate session estimate",
    /本轮 缓存 29\d/.test(pop) &&
      pop.indexOf("会话 缓存 200 命中 50.00%") !== -1 &&
      pop.indexOf("会话 输入 200 输出 20") !== -1 &&
      pop.indexOf("会话 ¥1.000000") !== -1,
    pop);
}

// Scenario 66: a continuously mounted fixed-size window can advance its base
// while retaining the old absolute cursor. Keep all prior turn/cache samples
// and fold only the new suffix.
{
  const t0 = Date.now() - 3000;
  const prior = { inputTokens: 100, cacheReadTokens: 1000, cacheWriteTokens: 0, outputTokens: 10, reasoningTokens: 0 };
  const initial = [
    { seq: 0, type: "request/context", data: { model: "deepseek-v4-flash" }, time: t0 },
    { seq: 1, type: "turn/start", data: { turn: 1 }, time: t0 },
    { seq: 2, type: "step/start", data: { turn: 1, step: 1 }, time: t0 },
    { seq: 3, type: "assistant/message", data: { turn: 1, step: 1, usage: prior, message: { source: { model: "deepseek-v4-flash" } } }, time: t0 + 1000 },
    { seq: 4, type: "step/end", data: { turn: 1, step: 1 }, time: t0 + 1000 },
    { seq: 5, type: "step/start", data: { turn: 1, step: 2 }, time: t0 + 1500 },
    { seq: 6, type: "text-chunks", data: { turn: 1, step: 2, texts: ["a".repeat(100)] }, time: t0 + 1800 },
    { seq: 7, type: "text-chunks", data: { turn: 1, step: 2, texts: ["b".repeat(100)] }, time: t0 + 1900 },
  ];
  const window = { events: initial, baseSeq: 0, hasMore: false, header: { seedLength: 0 } };
  applyWith({ binding: () => ({ session: window }) });
  const env = makeEnv();
  seedLive(env, { completed: null, openStepStart: t0 + 1500, pendingMin: null, toolPhaseStart: null,
    rootCostCny: 0, unpricedSteps: 0, invalidSteps: 0, seedLength: 0, pricing: null, budget: null });
  env.states[HOOK.hovered] = { value: true };
  env.states[HOOK.anchor] = { value: { left: 100, top: 100 } };
  const zero = { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0 };
  const props = {
    useProjection: (key) => key === "tokenUsage" ? zero : { turns: 0, steps: 0, llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0 },
    useSessions: () => ({ byId: { "session-test": { running: true } } }),
    sessionId: "session-test",
  };
  const before = popTextOf(render(env, props));
  window.events = initial.slice(5).concat([
    { seq: 8, type: "text-chunks", data: { turn: 1, step: 2, texts: ["c".repeat(100)] }, time: t0 + 2000 },
    { seq: 9, type: "text-chunks", data: { turn: 1, step: 2, texts: ["d".repeat(100)] }, time: t0 + 2100 },
  ]);
  window.baseSeq = 5;
  window.hasMore = true;
  const after = popTextOf(render(env, props));
  const beforeCache = Number((before.match(/本轮 缓存 (\d+)/) || [])[1]);
  const afterCache = Number((after.match(/本轮 缓存 (\d+)/) || [])[1]);
  check("window advance: absolute cursor preserves exact and provisional cache state",
    Number.isFinite(beforeCache) && afterCache >= beforeCache && afterCache <= beforeCache + 1 && beforeCache > 2000 && beforeCache < 2100 &&
      after.indexOf("会话 缓存 " + afterCache) !== -1 && /本轮 输入 19[78]/.test(after),
    "before=" + before + " | after=" + after);
}

// Scenario 67: mounting directly into an incomplete live tail may omit the
// turn/start (and even step/start). Recover the current turn from /live plus
// the latest legal turn/step so the provisional cache/output does not vanish.
{
  const t0 = Date.now() - 2000;
  const prior = { inputTokens: 100, cacheReadTokens: 1000, cacheWriteTokens: 0, outputTokens: 10, reasoningTokens: 0 };
  const tail = [
    { seq: 100, type: "assistant/message", data: { turn: 7, step: 1, usage: prior, message: { source: { model: "deepseek-v4-flash" } } }, time: t0 },
    { seq: 101, type: "step/end", data: { turn: 7, step: 1 }, time: t0 },
    { seq: 102, type: "request/context", data: { model: "deepseek-v4-flash" }, time: t0 + 100 },
    { seq: 103, type: "assistant/chunk", data: { turn: 7, step: 2, chunk: { type: "text-delta", text: "x".repeat(250) } }, time: t0 + 500 },
  ];
  applyWith({ binding: () => ({ session: { events: tail, baseSeq: 100, hasMore: true, header: { seedLength: 0 } } }) });
  const env = makeEnv();
  seedLive(env, { completed: null, openStepStart: t0 + 200, pendingMin: null, toolPhaseStart: null,
    rootCostCny: 0, unpricedSteps: 0, invalidSteps: 0, seedLength: 0, pricing: null, budget: null });
  env.states[HOOK.hovered] = { value: true };
  env.states[HOOK.anchor] = { value: { left: 100, top: 100 } };
  const zero = { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0 };
  const pop = popTextOf(render(env, {
    useProjection: (key) => key === "tokenUsage" ? zero : { turns: 0, steps: 0, llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0 },
    useSessions: () => ({ byId: { "session-test": { running: true } } }),
    sessionId: "session-test",
  }));
  check("tail recovery: live chunk without turn/start/step:start restores 本轮 cache and output",
    /本轮 缓存 [1-9]\d*/.test(pop) && /本轮 输入 [1-9]\d* 输出 [1-9]\d*/.test(pop),
    pop);
}

// Scenario 68: the tail can finish its first fold before the first /live
// response arrives. When openStepStart appears, retry that incomplete tail
// once even if no new event was appended.
{
  const t0 = Date.now() - 2000;
  const prior = { inputTokens: 100, cacheReadTokens: 1000, cacheWriteTokens: 0, outputTokens: 10, reasoningTokens: 0 };
  const tail = [
    { seq: 100, type: "assistant/message", data: { turn: 7, step: 1, usage: prior, message: { source: { model: "deepseek-v4-flash" } } }, time: t0 },
    { seq: 101, type: "step/end", data: { turn: 7, step: 1 }, time: t0 },
    { seq: 102, type: "assistant/chunk", data: { turn: 7, step: 2, chunk: { type: "text-delta", text: "x".repeat(250) } }, time: t0 + 500 },
  ];
  applyWith({ binding: () => ({ session: { events: tail, baseSeq: 100, hasMore: true, header: { seedLength: 0 } } }) });
  const env = makeEnv();
  env.states[HOOK.hovered] = { value: true };
  env.states[HOOK.anchor] = { value: { left: 100, top: 100 } };
  const zero = { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0 };
  const props = {
    useProjection: (key) => key === "tokenUsage" ? zero : { turns: 0, steps: 0, llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0 },
    useSessions: () => ({ byId: { "session-test": { running: true } } }),
    sessionId: "session-test",
  };
  const before = popTextOf(render(env, props));
  seedLive(env, { completed: null, openStepStart: t0 + 200, pendingMin: null, toolPhaseStart: null,
    rootCostCny: 0, unpricedSteps: 0, invalidSteps: 0, seedLength: 0, pricing: null, budget: null });
  const after = popTextOf(render(env, props));
  check("tail recovery: late /live edge replays the existing tail without a new event",
    before.indexOf("本轮 缓存 0 命中 0.00%") !== -1 && /本轮 缓存 [1-9]\d*/.test(after) &&
      /本轮 输入 [1-9]\d* 输出 [1-9]\d*/.test(after),
    "before=" + before + " | after=" + after);
}

// Scenario 69: after a long response completes, an incomplete tail may retain
// the final message/end markers but not turn/start. The last explicit turn/end
// identifies the final root turn, so its exact usage must remain in 本轮.
{
  const t0 = Date.now() - 1000;
  const exact = { inputTokens: 120, cacheReadTokens: 480, cacheWriteTokens: 0, outputTokens: 60, reasoningTokens: 10 };
  const tail = [
    { seq: 200, type: "request/context", data: { model: "deepseek-v4-pro" }, time: t0 },
    { seq: 201, type: "assistant/message", data: { turn: 9, step: 3, usage: exact, source: { model: "deepseek-v4-pro" }, content: [] }, time: t0 + 500 },
    { seq: 202, type: "step/end", data: { turn: 9, step: 3 }, time: t0 + 500 },
    { seq: 203, type: "turn/end", data: { turn: 9 }, time: t0 + 501 },
  ];
  applyWith({ binding: () => ({ session: { events: tail, baseSeq: 200, hasMore: true, header: { seedLength: 0 } } }) });
  const env = makeEnv();
  const host = { uncachedInputTokens: 1000, cacheReadTokens: 5000, cacheWriteTokens: 0, outputTokens: 500, reasoningTokens: 0 };
  seedCost(env, { merged: host, costCny: 1,
    root: { costCny: 1, unpricedSteps: 0, invalidSteps: 0 },
    descendants: { costCny: 0, unpricedSteps: 0, invalidSteps: 0 },
    models: [{ model: "deepseek-v4-flash", usage: host, costCny: 1 }],
    unpricedSteps: 0, invalidSteps: 0, partial: false, failedSessionCount: 0,
    descendantCount: 0, persistenceAvailable: true, stale: false, pricing: null });
  seedLive(env, { completed: null, openStepStart: null, pendingMin: null, toolPhaseStart: null,
    rootCostCny: 1, unpricedSteps: 0, invalidSteps: 0, seedLength: 0, pricing: null, budget: null });
  env.states[HOOK.hovered] = { value: true };
  env.states[HOOK.anchor] = { value: { left: 100, top: 100 } };
  const pop = popTextOf(render(env, {
    useProjection: (key) => key === "tokenUsage" ? host : { turns: 1, steps: 3, llmMs: 1000, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0 },
    useSessions: () => ({ byId: { "session-test": { running: false } } }),
    sessionId: "session-test",
  }));
  check("tail recovery: completed final turn keeps exact 本轮 while session stays host-authoritative",
    pop.indexOf("本轮 缓存 480 命中 80.00%") !== -1 &&
      pop.indexOf("本轮 输入 120 输出 60") !== -1 &&
      pop.indexOf("会话 缓存 5000 命中 83.33%") !== -1,
    pop);
}

// Scenario 70: current DSH list rows expose origin/parent but not seedLength.
// A subagent must wait for /live's boundary instead of assuming seed 0 and
// briefly showing the inherited parent prefix.
{
  const t0 = Date.now() - 3000;
  const inherited = { inputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 100, reasoningTokens: 0 };
  const own = { inputTokens: 8, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 4, reasoningTokens: 0 };
  const events = [
    { type: "turn/start", data: { turn: 1 }, time: t0 },
    { type: "step/start", data: { turn: 1, step: 1 }, time: t0 },
    { type: "assistant/message", data: { turn: 1, step: 1, usage: inherited, message: { source: { model: "deepseek-v4-pro" } } }, time: t0 + 500 },
    { type: "step/end", data: { turn: 1, step: 1 }, time: t0 + 500 },
    { type: "turn/end", data: { turn: 1 }, time: t0 + 501 },
    { type: "turn/start", data: { turn: 2 }, time: t0 + 1000 },
    { type: "step/start", data: { turn: 2, step: 1 }, time: t0 + 1000 },
    { type: "assistant/message", data: { turn: 2, step: 1, usage: own, message: { source: { model: "deepseek-v4-flash" } } }, time: t0 + 1500 },
    { type: "step/end", data: { turn: 2, step: 1 }, time: t0 + 1500 },
    { type: "turn/end", data: { turn: 2 }, time: t0 + 1501 },
  ];
  applyWith({ binding: () => ({ session: { events } }) });
  const env = makeEnv();
  env.states[HOOK.hovered] = { value: true };
  env.states[HOOK.anchor] = { value: { left: 100, top: 100 } };
  const zero = { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0 };
  const props = {
    useProjection: (key) => key === "tokenUsage" ? zero : { turns: 0, steps: 0, llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0 },
    useSessions: () => ({ byId: { "session-test": { running: false, parentId: "parent", origin: "subagent" } } }),
    sessionId: "session-test",
  };
  let pop = popTextOf(render(env, props));
  check("subagent seed: missing list boundary never exposes inherited totals",
    pop.indexOf("会话 输入 0 输出 0") !== -1 && pop.indexOf("v4-pro 花费 ¥") === -1,
    pop);
  seedLive(env, { completed: null, openStepStart: null, pendingMin: null, toolPhaseStart: null,
    rootCostCny: 0, unpricedSteps: 0, invalidSteps: 0, seedLength: 5, pricing: null, budget: null });
  pop = popTextOf(render(env, props));
  check("subagent seed: authoritative boundary reveals only the child usage",
    pop.indexOf("会话 输入 8 输出 4") !== -1 && pop.indexOf("v4-flash 花费 ¥") !== -1 &&
      pop.indexOf("v4-pro 花费 ¥") === -1,
    pop);
}

// Scenario 71: the final tail can arrive one render before the list row flips
// from running to stopped. Re-evaluate the same events once on that edge so
// the completed 本轮 does not remain zero forever.
{
  const t0 = Date.now() - 1000;
  const exact = { inputTokens: 20, cacheReadTokens: 80, cacheWriteTokens: 0, outputTokens: 10, reasoningTokens: 0 };
  const tail = [
    { seq: 300, type: "assistant/message", data: { turn: 11, step: 2, usage: exact, source: { model: "deepseek-v4-flash" }, content: [] }, time: t0 + 500 },
    { seq: 301, type: "step/end", data: { turn: 11, step: 2 }, time: t0 + 500 },
    { seq: 302, type: "turn/end", data: { turn: 11 }, time: t0 + 501 },
  ];
  applyWith({ binding: () => ({ session: { events: tail, baseSeq: 300, hasMore: true, header: { seedLength: 0 } } }) });
  const env = makeEnv();
  seedLive(env, { completed: null, openStepStart: null, pendingMin: null, toolPhaseStart: null,
    rootCostCny: 0, unpricedSteps: 0, invalidSteps: 0, seedLength: 0, pricing: null, budget: null });
  env.states[HOOK.hovered] = { value: true };
  env.states[HOOK.anchor] = { value: { left: 100, top: 100 } };
  const zero = { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0 };
  let rowRunning = true;
  const props = {
    useProjection: (key) => key === "tokenUsage" ? zero : { turns: 0, steps: 0, llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0 },
    useSessions: () => ({ byId: { "session-test": { running: rowRunning } } }),
    sessionId: "session-test",
  };
  const before = popTextOf(render(env, props));
  rowRunning = false;
  const after = popTextOf(render(env, props));
  check("tail recovery: running→stopped edge replays the unchanged final tail once",
    before.indexOf("本轮 输入 0 输出 0") !== -1 &&
      after.indexOf("本轮 缓存 80 命中 80.00%") !== -1 && after.indexOf("本轮 输入 20 输出 10") !== -1,
    "before=" + before + " | after=" + after);
}

// Scenario 72: a brand-new session has no lastUsage carry. DSH publishes
// contextBreakdown shortly after step/start but before the first output token;
// seed that late projection once, animate it by wall time, then let exact
// provider usage replace it atomically.
{
  const realNow = Date.now;
  let fakeNow = realNow();
  Date.now = () => fakeNow;
  try {
    const t0 = fakeNow;
    let breakdown = null;
    const events = [
      { type: "turn/start", data: { turn: 1 }, time: t0 },
      { type: "step/start", data: { turn: 1, step: 1 }, time: t0 },
      { type: "request/context", data: { model: "deepseek-v4-flash" }, time: t0 + 2 },
    ];
    const session = { events };
    applyWith({ binding: () => ({ session }) });
    const env = makeEnv();
    seedLive(env, { completed: null, openStepStart: t0, pendingMin: null, toolPhaseStart: null,
      rootCostCny: 0, unpricedSteps: 0, invalidSteps: 0, seedLength: 0, pricing: null, budget: null });
    env.states[HOOK.hovered] = { value: true };
    env.states[HOOK.anchor] = { value: { left: 100, top: 100 } };
    const zero = { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0 };
    let running = true;
    const props = {
      useProjection: (key) => key === "tokenUsage" ? zero
        : key === "contextBreakdown" ? breakdown
        : { turns: 0, steps: 0, llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0 },
      useSessions: () => ({ byId: { "session-test": { running } } }),
      sessionId: "session-test",
    };
    const cacheValues = (el) => {
      const pop = popTextOf(el);
      const strip = groupTextsOf(el);
      return {
        pop, strip,
        turn: Number((pop.match(/本轮 缓存 (\d+)/) || [])[1]),
        session: Number((pop.match(/会话 缓存 (\d+)/) || [])[1]),
        stripCache: Number((strip.match(/缓存 (\d+) · 命中/) || [])[1]),
        input: Number((pop.match(/本轮 输入 (\d+)/) || [])[1])
      };
    };

    const beforeProjection = cacheValues(render(env, props));
    check("first-request fallback: step/start alone does not invent a cache prior",
      beforeProjection.turn === 0 && beforeProjection.session === 0 && beforeProjection.stripCache === 0,
      beforeProjection.strip + " | " + beforeProjection.pop);

    // Real ordering: visible user messages reach the projection before
    // request/header contributes the system/tool prefix. Do not freeze this
    // partial frame or the cache prior would stay zero for the whole turn.
    breakdown = { systemTokens: 0, toolsTokens: 0, messageTokens: 22 };
    const beforeHeader = cacheValues(render(env, props));
    check("first-request fallback: message-only partial projection waits for request header",
      beforeHeader.turn === 0 && beforeHeader.session === 0 && beforeHeader.stripCache === 0,
      beforeHeader.strip + " | " + beforeHeader.pop);

    // Real fixture before its first output: 1513 system + 7955 tools + 652
    // model-visible messages = 10120 estimated prompt tokens; exact was 10065.
    breakdown = { systemTokens: 1513, toolsTokens: 7955, messageTokens: 652 };
    const seeded = cacheValues(render(env, props));
    check("first-request fallback: late context projection seeds all three cache views",
      seeded.turn === 9089 && seeded.session === 9089 && seeded.stripCache === 9089 && seeded.input === 626,
      seeded.strip + " | " + seeded.pop);

    // The projection later grows with assistant surface text. The open
    // request must keep its original input snapshot instead of chasing output.
    breakdown = { systemTokens: 1513, toolsTokens: 7955, messageTokens: 5000 };
    const frozen = cacheValues(render(env, props));
    check("first-request fallback: seeded context snapshot ignores later assistant growth",
      frozen.turn === seeded.turn && frozen.input === seeded.input,
      "seeded=" + seeded.pop + " | frozen=" + frozen.pop);

    const timeline = [seeded.turn];
    let live = seeded;
    for (let ms = 100; ms <= 1000; ms += 100) {
      fakeNow = t0 + ms;
      live = cacheValues(render(env, props));
      timeline.push(live.turn);
      check("first-request frame " + ms + "ms: 本轮、会话 and strip stay identical",
        live.turn === live.session && live.turn === live.stripCache,
        live.strip + " | " + live.pop);
    }
    check("first-request fallback: cache visibly advances by wall time",
      new Set(timeline).size >= 4 && timeline.every((value, index) => index === 0 || value >= timeline[index - 1]),
      JSON.stringify(timeline));

    fakeNow = t0 + 8000;
    const beforeSettle = cacheValues(render(env, props));
    const exact = { inputTokens: 81, cacheReadTokens: 9984, cacheWriteTokens: 0, outputTokens: 2134, reasoningTokens: 1259 };
    events.push({ type: "assistant/chunk", data: { turn: 1, step: 1, chunk: { type: "usage", usage: exact } }, time: fakeNow });
    events.push({ type: "assistant/message", data: { turn: 1, step: 1, usage: exact, message: { source: { model: "deepseek-v4-flash" } } }, time: fakeNow + 1 });
    events.push({ type: "step/end", data: { turn: 1, step: 1 }, time: fakeNow + 1 });
    events.push({ type: "turn/end", data: { turn: 1 }, time: fakeNow + 2 });
    running = false;
    seedLive(env, { completed: null, openStepStart: null, pendingMin: null, toolPhaseStart: null,
      rootCostCny: 0, unpricedSteps: 0, invalidSteps: 0, seedLength: 0, pricing: null, budget: null });
    const settled = cacheValues(render(env, props));
    check("first-request hand-off: exact cache/input replace the prior once",
      beforeSettle.turn > 9000 && Math.abs(beforeSettle.turn - 9984) / 9984 < 0.1 &&
        settled.turn === 9984 && settled.session === 9984 && settled.stripCache === 9984 && settled.input === 81 &&
        settled.pop.indexOf("本轮 输入 81 输出 2134") !== -1 && settled.pop.indexOf("会话 输入 81 输出 2134") !== -1,
      "before=" + beforeSettle.pop + " | settled=" + settled.pop);
  } finally {
    Date.now = realNow;
  }
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : "\n" + failures + " CHECK(S) FAILED");
process.exit(failures === 0 ? 0 : 1);
