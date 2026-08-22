// Ad-hoc REAL-LOG verification (not part of npm test): mount the client
// bundle against a real session log with a STALE host root (rootCostCny: 0)
// and confirm 会话 (session cost) is NONZERO — the client's exact real-time
// fold fills the host poll lag (the first-round consistency fix). With a
// FRESH host root the authoritative host value must win unchanged.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const logPath = process.argv[2];
if (!logPath) {
  console.error("usage: node test/verify-real-sess.mjs <session.jsonl.zstd-or-jsonl>");
  process.exit(2);
}
let text;
if (logPath.endsWith(".zstd")) {
  text = execFileSync("zstd", ["-dc", logPath], { maxBuffer: 1 << 30 }).toString("utf8");
} else {
  text = readFileSync(logPath, "utf8");
}
const lines = text.split("\n").filter(Boolean);
const events = lines.slice(1).map((l) => JSON.parse(l));
console.log("log:", logPath.split("/").pop(), "events:", events.length);

const code = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");

let failures = 0;
const check = (name, cond, detail) => {
  console.log((cond ? "PASS: " : "FAIL: ") + name + (detail && !cond ? " — " + detail : ""));
  if (!cond) failures++;
};

let currentEnv = null;
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

try {
  Object.defineProperty(globalThis.navigator, "language", { value: "zh-CN", configurable: true });
} catch (e) { /* keep whatever */ }
globalThis.window = { __ModuleLoader__: { load(handoff) { factory = handoff.factory; } } };
let factory = null;
new Function("window", "require", code)(globalThis.window, (spec) => {
  if (spec === "react") return reactProxy();
  throw new Error("unexpected require: " + spec);
});
const plugin = factory((spec) => {
  if (spec === "react") return reactProxy();
  throw new Error("unexpected require: " + spec);
});

function defaultBody(url) {
  const u = String(url);
  if (u.indexOf("/plugins/better-stats/balance") !== -1) return { configured: false, status: "ok", provider: null, amount: null, currency: null };
  if (u.indexOf("/plugins/better-stats/cost") !== -1) return { sessionId: "s", found: true, merged: { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0 }, costCny: 0, root: { costCny: 0 }, descendants: { costCny: 0 }, models: [], unpricedSteps: 0, invalidSteps: 0, partial: false, failedSessionCount: 0, persistenceAvailable: false, descendantCount: 0, pricingVersion: 0 };
  if (u.indexOf("/plugins/better-stats/live") !== -1) return { sessionId: "s", completed: null, rootCostCny: 0, unpricedSteps: 0, invalidSteps: 0 };
  if (u.indexOf("/plugins/better-stats/today") !== -1) return { date: "x", costCny: 0, monthCostCny: 0, sessionCount: 0 };
  return {};
}
globalThis.fetch = (url) => Promise.resolve({ ok: true, json: () => Promise.resolve(defaultBody(url)) });

let Comp = null;
const sessions = { binding: () => ({ session: { events } }) };
plugin.apply({
  sessions,
  slots: {
    inject(name, cb) { const r = cb(); Comp = r[1]; },
    register(o, c) { return [o, c]; },
  },
});

function makeEnv() { return { states: [], cursor: 0, effects: [], rerender: false, lastKeys: [] }; }
function render(env, props) {
  currentEnv = env;
  env.cursor = 0;
  env.effects = [];
  const el = Comp(props);
  const effects = env.effects;
  currentEnv = null;
  for (const cb of effects) { try { cb(); } catch (e) { /* noop */ } }
  return el;
}
function allEls(node, out) {
  if (node === null || typeof node !== "object") return;
  if (typeof node.props !== "undefined" && typeof node.props.className === "string") out.push(node);
  if (Array.isArray(node)) { for (const c of node) allEls(c, out); return; }
  if (typeof node.children !== "undefined") allEls(node.children, out);
}
function flatEls(el) { const out = []; allEls(el.children, out); return out; }
function groupTextsOf(el) {
  const flat = flatEls(el);
  return flat.filter((c) => c && c.props && c.props["data-bs"] === void 0 && typeof c.props.className === "string" && c.props.className.indexOf("item") !== -1)
    .map((g) => (g.children || []).join ? g.children.join("") : g.children).join(" ");
}
function collectStrings(node, out) {
  if (typeof node === "string") { out.push(node); return; }
  if (node === null || node === void 0 || typeof node !== "object") return;
  if (Array.isArray(node)) { for (const c of node) collectStrings(c, out); return; }
  if (typeof node.children !== "undefined") collectStrings(node.children, out);
}
function popTextOf(el) {
  const flat = flatEls(el);
  const pop = flat.find((c) => c && typeof c === "object" && c.props && typeof c.props.className === "string" && c.props.className.indexOf("dsh-better-stats-pop") !== -1 && c.props.className.indexOf("pop-row") === -1);
  if (!pop) return "";
  const out = [];
  collectStrings(pop, out);
  return out.join(" ");
}

const HOOK = { hovered: 1, anchor: 2, live: 16 };// hook indices: live=16
const TOKEN_USAGE = { uncachedInputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 100 };
const STATS = { turns: 0, steps: 0, llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0 };

function sessionCnyOf(strip) {
  const m = String(strip).match(/会话 ¥([\d.]+)/);
  return m ? Number(m[1]) : NaN;
}
function turnCnyOf(strip) {
  const m = String(strip).match(/本轮 ¥([\d.]+)/);
  return m ? Number(m[1]) : NaN;
}

function run(rootCostCny) {
  const env = makeEnv();
  env.states[HOOK.live] = { value: { completed: null, openStepStart: null, pendingMin: null, toolPhaseStart: null, rootCostCny, unpricedSteps: 0, invalidSteps: 0, pricing: null, budget: null } };
  env.states[HOOK.hovered] = { value: true };
  env.states[HOOK.anchor] = { value: { left: 100, top: 100 } };
  const props = {
    useProjection: (key) => (key === "tokenUsage" ? TOKEN_USAGE : STATS),
    useSessions: () => ({ byId: { s: { running: false } } }),
    sessionId: "s",
  };
  const el = render(env, props);
  return { strip: groupTextsOf(el), pop: popTextOf(render(env, props)) };
}

// STALE host root (0): the /live poll has not folded this session — 会话 must
// be NONZERO (the client's exact real-time fold fills the staleness window).
const stale = run(0);
const sessStale = sessionCnyOf(stale.strip);
check("real log: 会话 nonzero while the host root is stale-0 (was ¥0.0000)",
  Number.isFinite(sessStale) && sessStale > 1, stale.strip);
check("real log: 会话 fills with the session's real fold magnitude",
  Number.isFinite(sessStale) && sessStale > 50, String(sessStale));

// FRESH host root: the authoritative host value must win (no client override)
const fresh = run(123.456);
const sessFresh = sessionCnyOf(fresh.strip);
check("real log: fresh host root stays authoritative (123.4560)",
  Number.isFinite(sessFresh) && Math.abs(sessFresh - 123.456) < 0.0005,
  fresh.strip);

console.log(failures === 0 ? "\nREAL-LOG VERIFY PASSED" : "\n" + failures + " CHECK(S) FAILED");
process.exit(failures === 0 ? 0 : 1);
