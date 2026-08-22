// Explicit en-US half of the i18n suite: loads the bundle with
// navigator.language = "en-US" (independent of the machine locale) and
// asserts the full strip + popover render in English with ZERO Chinese.
// The zh-CN half is the default client-regression run (locale pinned to
// zh-CN at load), which also re-runs the bundle under en-US in scenario 25.
import { readFileSync } from "node:fs";

let failures = 0;
const check = (name, cond, detail) => {
  console.log((cond ? "PASS: " : "FAIL: ") + name + (detail && !cond ? " — " + detail : ""));
  if (!cond) failures++;
};

// Node < 21 has no global navigator, so pin the property when present and
// otherwise install a minimal global; the bundle reads it at load time.
try {
  Object.defineProperty(globalThis.navigator, "language", { value: "en-US", configurable: true });
} catch (e) {
  Object.defineProperty(globalThis, "navigator", { value: { language: "en-US" }, configurable: true });
}

const code = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");

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
      if (typeof type === "function") return type({ ...(props || {}), children });
      return { type, props: props || {}, children };
    }
  };
}

let factory = null;
globalThis.window = { __ModuleLoader__: { load(h) { factory = h.factory; } } };
new Function("window", "require", code)(globalThis.window, (spec) => {
  if (spec === "react") return reactProxy();
  throw new Error("unexpected require: " + spec);
});

globalThis.fetch = (url) => Promise.resolve({ ok: true, json: () => Promise.resolve({ configured: false, status: "ok" }) });

let Comp = null;
factory((spec) => {
  if (spec === "react") return reactProxy();
  throw new Error("unexpected require: " + spec);
}).apply({
  sessions: {},
  slots: {
    inject(name, cb) { Comp = cb()[1]; },
    register(o, c) { return [o, c]; }
  }
});

function makeEnv() {
  return { states: [], cursor: 0, effects: [], rerender: false };
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
    try { cb(); } catch (err) {
      check("effect ran without throwing (" + (err && err.message) + ")", false);
    }
  }
  return el;
}
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
function stripTextOf(el) {
  return flatEls(el)
    .filter((c) => c && c.props && c.props["data-bs"] === void 0 && typeof c.props.className === "string" && c.props.className.indexOf("item") !== -1)
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
  collectStrings(pop.children, out);
  return out.join(" ");
}

const TOKEN_USAGE = { uncachedInputTokens: 1000, cacheReadTokens: 500, cacheWriteTokens: 0, outputTokens: 200 };
const SESSION_STATS = { turns: 3, steps: 12, llmMs: 45200, toolMs: 12300, ttftMs: 1400, ttftSteps: 1, decodeMs: 1000, decodeTokens: 25 };
const props = {
  useProjection: (key) => (key === "tokenUsage" ? TOKEN_USAGE : SESSION_STATS),
  useSessions: () => ({ byId: {} }),
  sessionId: "session-test"
};

const env = makeEnv();
// seed the balance (hook 1 → index 0) and open the popover (hovered/anchored)
env.states[0] = { value: { text: "DeepSeek ¥48.86", label: "DeepSeek", amount: 48.86, currency: "CNY", decimals: 2, granted: 10, toppedUp: 38.86 } };
const el = render(env, props);
env.states[1] = { value: true };
env.states[2] = { value: { left: 100, top: 100 } };
const el2 = render(env, props);
const strip = stripTextOf(el2);
const pop = popTextOf(el2);

check("en strip renders", /Turn ¥/.test(strip) && /Session ¥/.test(strip), strip);
check("en strip: Balance group + refresh button", strip.indexOf("Balance ¥48.86") !== -1, strip);
check("en strip: In/Out + Cache labels", /In \d/.test(strip) && /Out \d/.test(strip) && /Cache \d/.test(strip), strip);
check("en strip has no Chinese leakage", !/[\u4e00-\u9fff]/.test(strip), strip);
check("en popover renders populated groups",
  pop.indexOf("Turn") !== -1 && pop.indexOf("Session") !== -1 && pop.indexOf("Balance") !== -1, pop);
check("en popover has no Chinese leakage", !/[\u4e00-\u9fff]/.test(pop), pop);

console.log(failures === 0 ? "ALL EN CLIENT CHECKS PASSED" : failures + " EN CHECK(S) FAILED");
process.exit(failures === 0 ? 0 : 1);
