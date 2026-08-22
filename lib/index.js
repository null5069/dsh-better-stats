// dsh-better-stats — host half: proxy the DeepSeek account balance and fold
// the workspace's session logs into CNY cost/usage snapshots.
//
// Serves GET /plugins/better-stats/balance | cost | live | today.
//
//   /balance  official provider balance (15s cache, ?force=1 + 2s cooldown),
//             one schema: { configured, status: ok|stale|error, provider,
//             displayName, amount, amountDecimals, currency, grantedBalance,
//             toppedUpBalance, queriedAt }
//   /cost     ONE whole-tree snapshot for a session: root + descendants split,
//             merged usage/cost/models, unpriced/invalid/partial accounting.
//   /live     ROOT-only live edges (1s poll target): foldLive timing + the
//             root's settled cost (rootCostCny) — the client combines it with
//             the latest /cost descendants ("实时 root + 最近 descendants").
//   /today    Beijing-day + month fold over ALL sessions, seed-excluded.
//
// Accounting contract (P1):
//   - outputTokens ALREADY includes reasoningTokens. Reasoning is a subset of
//     output: it is NEVER billed again and NEVER enters the rate numerator.
//       cost = input buckets at input prices + outputTokens * outPrice
//       settled tok/s numerator = sum(outputTokens)
//   - Every usage sample is strictly validated (finite, non-negative,
//     integer tokens; reasoning <= output). Invalid samples are counted in
//     invalidSteps and never silently clamped.
//   - Fork/subagent lineage: only headers with origin === "subagent" enter a
//     parent's tree; every session folds ONLY the events after its own
//     seedLength (its inherited prefix). /today and month folds exclude the
//     seed of every session too.
//   - Unknown models are explicit: tokens total, cost stays 0, unpricedSteps
//     counts them. A legal costCny === 0 is never mistaken for "no answer"
//     (absence is null/undefined at the route boundary).
//
// Price consistency (P2):
//   - The official CNY tables are re-fetched every 6h into a versioned ledger
//     ({ effectiveAt, version, tables }); each request captures ONE immutable
//     pricing snapshot and the whole tree is priced with it. Caches are keyed
//     by pricingVersion. Samples the ledger cannot cover (before the first
//     fetch) are priced at current tables and counted as approximate.
//   - persistence list/inspect failures are reported (partial,
//     failedSessionCount/Ids, persistenceAvailable, foldedSessionCount); a
//     root read failure triggers stale/error instead of a partial answer.
//   - singleflight on balance/cost/today/pricing prevents duplicate upstream
//     work from concurrent first requests; pricing retries back off.

const BALANCE_URL = "https://api.deepseek.com/user/balance";
const API_KEY_ENV = "DEEPSEEK_API_KEY";
const CACHE_TTL_MS = 15000;
const FORCE_COOLDOWN_MS = 2000;
const PROVIDER_LABELS = {
  deepseek: "DeepSeek",
  "deepseek-official": "DeepSeek"
};

const inflight = new Map(); // singleflight: key → Promise

// Run `fn` once per key while it is outstanding; concurrent callers share the
// same promise (and therefore the same upstream request).
function singleflight(key, fn) {
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    try {
      return await fn();
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

// ── official DeepSeek pricing, CNY per 1M tokens ───────────────────────────
// deepseek-v4-flash: 输入(缓存命中) ¥0.05/¥0.10, 输入(未命中) ¥1.5/¥3.0, 输出 ¥4.5/¥9.0
// deepseek-v4-pro:   输入(缓存命中) ¥0.15/¥0.30, 输入(未命中) ¥4.5/¥9.0, 输出 ¥13.5/¥27.0
// 高峰(北京 9:00-12:00 / 14:00-18:00) 为两倍, 其余空闲. Each step is priced by the
// MODEL that produced it and at its OWN event time.
const BUILTIN_TABLES = {
  "deepseek-v4-flash": { miss: 1.5, read: 0.05, out: 4.5, missPeak: 3.0, readPeak: 0.1, outPeak: 9.0 },
  "deepseek-v4-pro": { miss: 4.5, read: 0.15, out: 13.5, missPeak: 9.0, readPeak: 0.3, outPeak: 27.0 }
};
const PRICING_URL = "https://api-docs.deepseek.com/zh-cn/quick_start/pricing/";
const PRICING_TTL_MS = 6 * 3600 * 1000;
const PRICING_FETCH_TIMEOUT_MS = 8000;
// After a failed fetch (first or refresh), don't retry more often than this —
// otherwise every /live request would re-probe the official page.
const PRICING_RETRY_MS = 5 * 60 * 1000;

const PRICING_RE = /百万tokens输入（缓存命中）\s*空闲时段\s*([\d.]+)元\s*([\d.]+)元\s*高峰时段\s*([\d.]+)元\s*([\d.]+)元\s*百万tokens输入（缓存未命中）\s*空闲时段\s*([\d.]+)元\s*([\d.]+)元\s*高峰时段\s*([\d.]+)元\s*([\d.]+)元\s*百万tokens输出\s*空闲时段\s*([\d.]+)元\s*([\d.]+)元\s*高峰时段\s*([\d.]+)元\s*([\d.]+)元/;

// pricing state: tables = null until the first successful official fetch.
let pricingState = {
  tables: null, // official tables once fetched; null = builtin fallback
  fetchedAt: 0,
  lastErrorAt: 0,
  lastSuccessAt: 0,
  inFlight: null,
  version: 0,
  ledger: [] // [{ effectiveAt, version, tables }] — the versioned price table
};

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

// Background refresh, singleflight-ed; each success appends a ledger entry.
function refreshPricing() {
  if (pricingState.inFlight !== null) return pricingState.inFlight;
  pricingState.inFlight = singleflight("pricing", async () => {
    try {
      const tables = await fetchOfficialPricing();
      const changed = pricingState.tables === null ||
        JSON.stringify(pricingState.tables) !== JSON.stringify(tables);
      pricingState.tables = tables;
      pricingState.fetchedAt = Date.now();
      pricingState.lastSuccessAt = pricingState.fetchedAt;
      pricingState.lastErrorAt = 0;
      // A successful refresh of an unchanged table is freshness metadata, not
      // a new accounting version. Avoid invalidating every cache (and growing
      // the ledger) four times a day when the official prices did not change.
      if (changed) {
        pricingState.version += 1;
        pricingState.ledger.push({ effectiveAt: pricingState.fetchedAt, version: pricingState.version, tables });
      }
    } catch {
      pricingState.lastErrorAt = Date.now();
    } finally {
      pricingState.inFlight = null;
    }
  });
  return pricingState.inFlight;
}

// Kick a refresh when the cached tables are missing/older than the TTL;
// requests never wait. Failures back off (PRICING_RETRY_MS) so a down official
// page is not re-probed on every /live poll.
function ensurePricing() {
  const now = Date.now();
  const fresh = pricingState.tables !== null && now - pricingState.fetchedAt < PRICING_TTL_MS;
  const due = pricingState.tables === null || now - pricingState.fetchedAt >= PRICING_TTL_MS;
  const backedOff = pricingState.lastErrorAt > 0 && now - pricingState.lastErrorAt < PRICING_RETRY_MS;
  if (!fresh && due && !backedOff) refreshPricing();
  return pricingPayload();
}

function pricingPayload() {
  if (pricingState.tables === null) {
    return { source: "builtin", fetchedAt: null, tables: BUILTIN_TABLES, version: 0, ledger: [] };
  }
  const stale = pricingState.lastErrorAt > pricingState.fetchedAt &&
    Date.now() - pricingState.fetchedAt >= PRICING_TTL_MS;
  return {
    source: stale ? "stale" : "official",
    fetchedAt: new Date(pricingState.fetchedAt).toISOString(),
    tables: pricingState.tables,
    version: pricingState.version,
    // Entries are appended only when the official table actually changes.
    // Supplying them lets the client reprice a settled event at its event time
    // instead of applying today's table to historical steps.
    ledger: pricingState.ledger.slice()
  };
}

// Immutable pricing snapshot captured at request start: the whole tree is
// priced with THESE tables + ledger, and caches are keyed by the version.
function pricingSnapshot() {
  return {
    tables: pricingState.tables !== null ? pricingState.tables : BUILTIN_TABLES,
    version: pricingState.version,
    source: pricingState.tables === null ? "builtin" : "official",
    // Capture the ledger by value. queryTreeCost/queryToday await persistence;
    // a background pricing refresh must not mutate their in-flight snapshot.
    ledger: pricingState.ledger.slice()
  };
}

// ── model classification ───────────────────────────────────────────────────
// Normalized EXACT model ids only — no arbitrary substring matching.
// "deepseek-v4-flash-0731" → strip the trailing date suffix → exact match.
function modelKeyOf(model) {
  if (typeof model !== "string") return "unknown";
  const normalized = model.trim().toLowerCase().replace(/-\d{4,}$/, "");
  if (normalized === "deepseek-v4-flash") return "deepseek-v4-flash";
  if (normalized === "deepseek-v4-pro") return "deepseek-v4-pro";
  return "unknown";
}

function beijingPeak(epochMs) {
  const at = typeof epochMs === "number" && Number.isFinite(epochMs) ? epochMs : Date.now();
  const d = new Date(at + 8 * 3600 * 1000);
  const h = d.getUTCHours();
  return (h >= 9 && h < 12) || (h >= 14 && h < 18);
}

// CNY cost of a usage bucket at a moment's tier + the producing model's table.
// Contract: ONLY outputTokens is billed at the output rate — reasoningTokens
// is a subset of outputTokens and must never be billed again.
function priceBuckets(buckets, time, model, tables) {
  const table = (tables || BUILTIN_TABLES)[modelKeyOf(model)];
  if (table === void 0 || table === null) return 0;
  const peak = beijingPeak(time);
  const miss = peak ? table.missPeak : table.miss;
  const read = peak ? table.readPeak : table.read;
  const out = peak ? table.outPeak : table.out;
  return (
    ((buckets.uncachedInputTokens + buckets.cacheWriteTokens) * miss +
      buckets.cacheReadTokens * read +
      buckets.outputTokens * out) / 1e6
  );
}

// Strict usage validation. Returns the folded buckets, or null when the raw
// usage violates the accounting contract (non-finite / negative / non-integer
// tokens, or reasoning > output). Absent fields default to 0.
const USAGE_FIELDS = [
  ["inputTokens", "uncachedInputTokens"],
  ["outputTokens", "outputTokens"],
  ["reasoningTokens", "reasoningTokens"],
  ["cacheReadTokens", "cacheReadTokens"],
  ["cacheWriteTokens", "cacheWriteTokens"]
];
function usageBucket(raw) {
  if (raw === void 0 || raw === null || typeof raw !== "object") return null;
  const out = { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0 };
  for (const [from, to] of USAGE_FIELDS) {
    const v = raw[from];
    if (v === void 0 || v === null) continue;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) return null;
    out[to] = n;
  }
  if (out.reasoningTokens > out.outputTokens) return null; // reasoning ⊆ output
  return out;
}

// Latest tables whose effectiveAt covers `time`; falls back to the CURRENT
// snapshot tables (marked approximate — priced at current prices).
function tablesForTime(snapshot, time) {
  let best = null;
  const ledger = snapshot.ledger;
  if (Array.isArray(ledger)) {
    for (const entry of ledger) {
      if (typeof entry.effectiveAt === "number" && entry.effectiveAt <= time &&
          (best === null || entry.effectiveAt > best.effectiveAt)) {
        best = entry;
      }
    }
  }
  if (best !== null) return { tables: best.tables, version: best.version, approx: false };
  return { tables: snapshot.tables, version: snapshot.version, approx: true };
}

// ── token usage fold ───────────────────────────────────────────────────────
// Per "turn:step" the LATEST usage sample wins (no double counting); each
// sample is priced at its own event time and producing model. In-flight usage
// chunks carry no model → attribute them to the model the same turn last
// settled with. Unknown models total their tokens but price at 0
// (unpricedSteps). Invalid samples are counted and excluded (invalidSteps).
// opts.sinceMs: only samples at/after that timestamp (the "today" fold).
// opts.startIndex: skip the first N events (a session's inherited seed).
// opts.snapshot: the immutable pricing snapshot { tables, version, ledger }.
function requestModelOf(event) {
  if (event === void 0 || event === null || typeof event !== "object") return void 0;
  const data = event.data;
  if (data === void 0 || data === null || typeof data !== "object") return void 0;
  if (event.type === "request/context" && typeof data.model === "string" && data.model !== "") {
    return data.model;
  }
  if (event.type === "request/header") {
    const model = data.header && data.header.config ? data.header.config.model : void 0;
    if (typeof model === "string" && model !== "") return model;
  }
  return void 0;
}

// A live parent log can temporarily splice a subagent's complete transcript
// into the active parent turn. Those child events also exist in the child's
// own session and are folded separately by the tree query, so accepting them
// here would both double-count them and let child boundaries/routes close or
// re-price the parent. Seed events never enter this guard: they only warm the
// inherited model route, while the child's own turn starts after startIndex.
function createSplicedTurnGuard() {
  let parentTurn = null;
  const nestedTurns = [];
  const turnOf = (event) => {
    const data = event && event.data;
    if (data === void 0 || data === null || typeof data !== "object") return null;
    const raw = data.turn;
    if ((typeof raw !== "number" && typeof raw !== "string") ||
        (typeof raw === "string" && raw.trim() === "")) return null;
    const turn = Number(raw);
    return Number.isFinite(turn) && turn >= 0 && Number.isInteger(turn) ? turn : null;
  };
  return (event) => {
    const turn = turnOf(event);
    if (parentTurn === null) {
      if (event.type === "turn/start" && turn !== null) parentTurn = turn;
      return false;
    }
    if (nestedTurns.length > 0) {
      // An explicit parent event means the parent stream has resumed. This
      // also recovers safely from an incomplete/corrupt child transcript.
      if (turn === parentTurn) {
        nestedTurns.length = 0;
        if (event.type === "turn/end") parentTurn = null;
        return false;
      }
      if (event.type === "turn/start" && turn !== null) {
        if (nestedTurns[nestedTurns.length - 1] !== turn) nestedTurns.push(turn);
      } else if (event.type === "turn/end" && turn !== null) {
        const index = nestedTurns.lastIndexOf(turn);
        if (index !== -1) nestedTurns.splice(index);
      }
      // Events without a turn (notably request/context and some tool events)
      // belong to the currently spliced child until its boundary closes.
      return true;
    }
    if (turn !== null && turn !== parentTurn) {
      // Usually this is turn/start, but opening the guard on any differing
      // turn also handles older logs whose child boundary was not persisted.
      if (event.type !== "turn/end") nestedTurns.push(turn);
      return true;
    }
    if (event.type === "turn/end" && turn === parentTurn) parentTurn = null;
    return false;
  };
}

function foldUsage(events, opts) {
  const o = opts || {};
  const sinceMs = typeof o.sinceMs === "number" ? o.sinceMs : 0;
  const startIndex = typeof o.startIndex === "number" && o.startIndex > 0 ? Math.floor(o.startIndex) : 0;
  const snapshot = o.snapshot !== void 0 ? o.snapshot : pricingSnapshot();
  const totals = { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0 };
  const samples = new Map(); // "turn:step" → { buckets, time, model }
  const lastModelByTurn = new Map();
  const isSplicedTurn = createSplicedTurnGuard();
  let activeRouteModel;
  let lastSettledModel;
  let invalidSteps = 0;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e === void 0 || typeof e !== "object" || e === null) continue;
    const routed = requestModelOf(e);
    const sourceModel = e.type === "assistant/message" && e.data && e.data.message && e.data.message.source
      ? e.data.message.source.model
      : void 0;
    if (i < startIndex) {
      // The inherited seed is not billed or used to establish an active turn,
      // but it still warms the route for a child that emits no fresh context.
      if (routed !== void 0) activeRouteModel = routed;
      if (typeof sourceModel === "string" && sourceModel !== "") {
        activeRouteModel = sourceModel;
        lastSettledModel = sourceModel;
      }
      continue;
    }
    if (isSplicedTurn(e)) continue;
    // request/header and request/context are the authoritative model route for
    // attempts that may end with a usage chunk but no assistant/message (for
    // example, a failed request).
    if (routed !== void 0) activeRouteModel = routed;
    if (typeof sourceModel === "string" && sourceModel !== "") {
      activeRouteModel = sourceModel;
      lastSettledModel = sourceModel;
    }
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
      model = sourceModel;
    } else {
      continue;
    }
    if (usage === void 0 || usage === null) continue;
    // strict turn/step validation: finite non-negative integers
    const tn = Number(turn);
    const sn = Number(step);
    if (!Number.isFinite(tn) || tn < 0 || !Number.isInteger(tn) ||
        !Number.isFinite(sn) || sn < 0 || !Number.isInteger(sn)) {
      invalidSteps += 1;
      continue;
    }
    const sampleKey = tn + ":" + sn;
    if (model === void 0 || model === null || model === "") {
      model = activeRouteModel;
      if (model === void 0) model = lastModelByTurn.get(tn);
      if (model === void 0) model = lastSettledModel;
      if (model === void 0 && samples.has(sampleKey)) model = samples.get(sampleKey).model;
    }
    if (typeof sourceModel === "string" && sourceModel !== "") {
      lastModelByTurn.set(tn, sourceModel);
    }
    if (!Number.isFinite(e.time) || e.time < 0) {
      invalidSteps += 1;
      continue;
    }
    if (sinceMs > 0 && e.time < sinceMs) continue;
    const buckets = usageBucket(usage);
    if (buckets === null) {
      invalidSteps += 1;
      continue;
    }
    samples.set(sampleKey, { buckets, time: e.time, model });
  }
  const byModel = new Map();
  let unpricedSteps = 0;
  let approxSteps = 0;
  for (const sample of samples.values()) {
    mergeTotals(totals, sample.buckets);
    const key = modelKeyOf(sample.model);
    if (key === "unknown") unpricedSteps += 1;
    const entry = byModel.get(key) ?? { usage: { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0 }, costCny: 0 };
    mergeTotals(entry.usage, sample.buckets);
    const priced = tablesForTime(snapshot, sample.time);
    if (priced.approx) approxSteps += 1;
    entry.costCny += priceBuckets(sample.buckets, sample.time, sample.model, priced.tables);
    byModel.set(key, entry);
  }
  let costCny = 0;
  for (const entry of byModel.values()) costCny += entry.costCny;
  return { totals, costCny, byModel, unpricedSteps, invalidSteps, approxSteps };
}

function mergeTotals(target, source) {
  target.uncachedInputTokens += source.uncachedInputTokens;
  target.cacheReadTokens += source.cacheReadTokens;
  target.cacheWriteTokens += source.cacheWriteTokens;
  target.outputTokens += source.outputTokens;
  target.reasoningTokens += source.reasoningTokens || 0;
  return target;
}

// ── live step timing (host side) ───────────────────────────────────────────
// Mirrors the official sessionStats reducer, PLUS the open step and in-flight
// tool calls. decodeTokens = sum(outputTokens) — reasoning is a SUBSET of
// output and never doubles the rate numerator.
function isTokenDeltaChunk(chunk) {
  if (chunk === void 0 || chunk === null || typeof chunk !== "object") return false;
  switch (chunk.type) {
    case "text-delta":
    case "reasoning-delta": return typeof chunk.text === "string" && chunk.text !== "";
    case "tool-call-delta":
      return (typeof chunk.argumentsDelta === "string" && chunk.argumentsDelta !== "") ||
        (typeof chunk.name === "string" && chunk.name !== "");
    default: return false;
  }
}

function foldLive(events, opts) {
  const startIndex = opts !== void 0 && typeof opts.startIndex === "number" && opts.startIndex > 0 ? Math.floor(opts.startIndex) : 0;
  const isSplicedTurn = createSplicedTurnGuard();
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
    pendingCalls: new Map(),
    toolPhaseStart: null
  };
  for (let i = 0; i < events.length; i++) {
    if (i < startIndex) continue;
    const e = events[i];
    if (e === void 0 || typeof e !== "object" || e === null) continue;
    // strict time validation (P2): a timing fold must never propagate NaN —
    // malformed events are skipped, not silently folded into the timers
    if (typeof e.time !== "number" || !Number.isFinite(e.time) || e.time < 0) continue;
    if (isSplicedTurn(e)) continue;
    switch (e.type) {
      case "step/start": {
        const data = e.data;
        if (data !== void 0 && data !== null && typeof data === "object" &&
            Number.isFinite(data.turn) && data.turn >= 0 && Number.isInteger(data.turn) &&
            Number.isFinite(data.step) && data.step >= 0 && Number.isInteger(data.step)) {
          state.openStep = {
            turn: data.turn,
            step: data.step,
            startTime: e.time,
            firstTokenTime: null
          };
        }
        break;
      }
      case "assistant/chunk": {
        const open = state.openStep;
        const data = e.data;
        if (open !== null && data !== void 0 && data !== null && typeof data === "object" &&
            open.turn === data.turn && open.step === data.step && open.firstTokenTime === null &&
            isTokenDeltaChunk(data.chunk)) {
          open.firstTokenTime = e.time;
        }
        break;
      }
      case "assistant/message": {
        const open = state.openStep;
        const data = e.data;
        if (open !== null && data !== void 0 && data !== null && typeof data === "object" &&
            open.turn === data.turn && open.step === data.step) {
          state.llmMs += Math.max(0, e.time - open.startTime);
          if (open.firstTokenTime !== null) {
            state.ttftMs += Math.max(0, open.firstTokenTime - open.startTime);
            state.ttftSteps += 1;
            const validUsage = usageBucket(data.usage);
            if (validUsage !== null) {
              state.decodeMs += Math.max(0, e.time - open.firstTokenTime);
              state.decodeTokens += validUsage.outputTokens; // output already includes reasoning
            }
          }
          const blocks = data.message && data.message.content;
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
      case "tool/call": {
        const data = e.data;
        if (data !== void 0 && data !== null && typeof data === "object" &&
            typeof data.callId === "string" && !state.pendingCalls.has(data.callId)) {
          state.pendingCalls.set(data.callId, e.time);
        }
        break;
      }
      case "tool/result": {
        const callId = e.data && e.data.message && e.data.message.source ? e.data.message.source.callId : void 0;
        if (typeof callId === "string" && state.pendingCalls.has(callId)) {
          state.toolMs += Math.max(0, e.time - state.pendingCalls.get(callId));
          state.pendingCalls.delete(callId);
        }
        break;
      }
      case "step/end": {
        const data = e.data;
        if (data !== void 0 && data !== null && typeof data === "object" &&
            Number.isFinite(data.turn) && data.turn >= 0 && Number.isInteger(data.turn) &&
            Number.isFinite(data.step) && data.step >= 0 && Number.isInteger(data.step)) {
          state.turns = state.lastTurn === data.turn ? state.turns : state.turns + 1;
          state.steps += 1;
          state.lastTurn = data.turn;
          state.openStep = null;
          state.toolPhaseStart = null;
        }
        break;
      }
      case "turn/end":
        if (state.pendingCalls.size > 0) state.pendingCalls.clear();
        state.toolPhaseStart = null;
        break;
      default:
        break;
    }
  }
  let pendingMin = null;
  for (const t of state.pendingCalls.values()) {
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

// ── fork/subagent lineage ──────────────────────────────────────────────────
// Index SessionHeaders as { parentId, origin, seedLength }.
//   - ONLY origin === "subagent" enters the parent's subagent tree; ordinary
//     forks are their own roots even with a parentSession link.
//   - every session folds only the events after its own seedLength.
//   - `seen` starts with the root so a self-cycle (A→B→A) can never re-add it.
function indexHeaders(liveList, persistedHeaders, target) {
  const byId = target !== void 0 && target !== null ? target : Object.create(null);
  const add = (id, header) => {
    if (typeof id !== "string" || id === "") return;
    const h = header !== void 0 && header !== null ? header : {};
    if (!Object.prototype.hasOwnProperty.call(byId, id)) {
      // Assignment to "__proto__" invokes the legacy prototype setter on a
      // normal object/array. Define an own data property so arbitrary branded
      // SessionIds remain indexable even when a caller supplies its own target.
      Object.defineProperty(byId, id, {
        configurable: true,
        enumerable: true,
        writable: true,
        value: {
          parentId: typeof h.parentSession === "string" && h.parentSession !== "" ? h.parentSession : void 0,
          origin: h.origin === "subagent" ? "subagent" : "other",
          seedLength: typeof h.seedLength === "number" && Number.isFinite(h.seedLength) && h.seedLength > 0 ? Math.floor(h.seedLength) : 0
        }
      });
    }
  };
  try {
    for (const s of liveList) {
      if (s !== void 0 && s !== null && typeof s.id === "string") add(s.id, s.header);
    }
  } catch { /* best-effort */ }
  if (Array.isArray(persistedHeaders)) {
    for (const h of persistedHeaders) {
      if (h !== void 0 && h !== null && typeof h.id === "string") add(h.id, h);
    }
  }
  return byId;
}

// Descendants of rootId, only through origin === "subagent" nodes; the seen
// set is pre-seeded with the root so cycles can never re-enter it.
function collectDescendantIds(byId, rootId) {
  const out = [];
  const seen = new Set([rootId]);
  const children = new Map();
  for (const id in byId) {
    if (!Object.prototype.hasOwnProperty.call(byId, id)) continue;
    const entry = byId[id];
    if (entry === void 0 || entry.origin !== "subagent" || typeof entry.parentId !== "string") continue;
    const list = children.get(entry.parentId) ?? [];
    list.push(id);
    children.set(entry.parentId, list);
  }
  const queue = (children.get(rootId) ?? []).slice();
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i];
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    const nested = children.get(id);
    if (nested !== void 0) {
      for (const child of nested) queue.push(child);
    }
  }
  return out;
}

// ── session read plumbing ──────────────────────────────────────────────────
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
  const toNonnegativeOrNull = (v) => {
    if (v === void 0 || v === null || typeof v === "boolean") return null;
    if (typeof v === "string" && v.trim() === "") return null;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  let first;
  let amount = null;
  for (const item of infos) {
    if (item === void 0 || item === null) continue;
    const parsed = toNonnegativeOrNull(item.total_balance);
    if (parsed !== null) {
      first = item;
      amount = parsed;
      break;
    }
  }
  if (first === void 0 || amount === null) throw new Error("provider returned no balance");
  const decimalPlaces = (v) => {
    if (typeof v !== "string") return null;
    const match = v.trim().match(/^[+-]?\d+(?:\.(\d+))?$/);
    return match === null ? null : Math.min(6, match[1] ? match[1].length : 0);
  };
  const toNumOrNull = (v) => {
    return toNonnegativeOrNull(v);
  };
  return {
    provider: "deepseek-official",
    displayName: PROVIDER_LABELS["deepseek-official"],
    amount,
    amountDecimals: decimalPlaces(first.total_balance),
    currency: typeof first.currency === "string" && first.currency !== "" ? first.currency : "CNY",
    grantedBalance: toNumOrNull(first.granted_balance),
    toppedUpBalance: toNumOrNull(first.topped_up_balance)
  };
}

// One session's events: live store first, persisted store as fallback.
// Returns { events, meta } or null when neither source has it.
async function sessionEvents(ctx, persistence, id, signal) {
  const live = ctx.sessions.get(id);
  if (live !== void 0 && Array.isArray(live.events)) {
    // Freeze the append-only live view for this fold. Otherwise an event that
    // lands while an async tree query is reading descendants can make one
    // response combine different revisions of the root log.
    return { events: live.events.slice(), meta: live.header !== void 0 && live.header !== null ? { ...live.header } : {} };
  }
  if (persistence === null) return null;
  const loaded = await persistence.inspect(id, signal);
  if (loaded === void 0 || !Array.isArray(loaded.events)) return null;
  return { events: loaded.events, meta: loaded.meta !== void 0 && loaded.meta !== null ? loaded.meta : {} };
}

// ── whole-tree snapshot ────────────────────────────────────────────────────
// ONE snapshot per revision: root and descendants folded separately, merged
// figures derived from the same fold. The client uses "live root + latest
// descendants" — never max() guessing.
async function queryTreeCost(ctx, persistence, sessionId, signal, suppliedSnapshot) {
  const snapshot = suppliedSnapshot !== void 0 ? suppliedSnapshot : pricingSnapshot();
  let liveHeaders = [];
  let listFailed = false;
  try {
    liveHeaders = ctx.sessions.list();
  } catch {
    listFailed = true;
  }
  const byId = indexHeaders(liveHeaders, []);
  let persistenceAvailable = persistence !== null;
  let persistedHeaders = null;
  if (persistence !== null) {
    try {
      persistedHeaders = await persistence.list(signal);
    } catch {
      listFailed = true;
      persistedHeaders = null;
    }
  }
  if (persistedHeaders !== null) indexHeaders([], persistedHeaders, byId);
  if (!Object.prototype.hasOwnProperty.call(byId, sessionId)) {
    const live = ctx.sessions.get(sessionId);
    if (live !== void 0) {
      indexHeaders([{ id: sessionId, header: live.header }], [], byId);
    } else {
      return { found: false, sessionId };
    }
  }
  const ids = [sessionId, ...collectDescendantIds(byId, sessionId)];
  const zeroUsage = () => ({ uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0 });
  const rootAcc = { usage: zeroUsage(), costCny: 0, unpricedSteps: 0, invalidSteps: 0, approxSteps: 0, readFailed: false };
  const descAcc = { usage: zeroUsage(), costCny: 0, unpricedSteps: 0, invalidSteps: 0, approxSteps: 0 };
  const failedSessionIds = [];
  let foldedSessionCount = 0;
  let eventRevision = 0;
  let rootEventRevision = 0;
  let rootReadFailed = false;
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const isRoot = i === 0;
    let folded;
    try {
      const read = await sessionEvents(ctx, persistence, id, signal);
      if (read === null) {
        if (isRoot) rootReadFailed = true;
        else { failedSessionIds.push(id); }
        continue;
      }
      const seed = typeof read.meta.seedLength === "number" && read.meta.seedLength > 0 ? Math.floor(read.meta.seedLength) : 0;
      if (seed > read.events.length) {
        // corrupt metadata: the inherited prefix is longer than the log
        if (isRoot) rootReadFailed = true;
        else { failedSessionIds.push(id); }
        continue;
      }
      folded = foldUsage(read.events, { snapshot, startIndex: seed });
      eventRevision += read.events.length;
      if (isRoot) rootEventRevision = read.events.length;
      foldedSessionCount += 1;
    } catch {
      if (isRoot) rootReadFailed = true;
      else failedSessionIds.push(id);
      continue;
    }
    const acc = isRoot ? rootAcc : descAcc;
    mergeTotals(acc.usage, folded.totals);
    acc.costCny += folded.costCny;
    acc.unpricedSteps += folded.unpricedSteps;
    acc.invalidSteps += folded.invalidSteps;
    acc.approxSteps += folded.approxSteps;
    acc.byModel = acc.byModel || new Map();
    for (const [key, entry] of folded.byModel.entries()) {
      const prev = acc.byModel.get(key);
      if (prev === void 0) {
        acc.byModel.set(key, { usage: Object.assign(zeroUsage(), entry.usage), costCny: entry.costCny });
      } else {
        mergeTotals(prev.usage, entry.usage);
        prev.costCny += entry.costCny;
      }
    }
  }
  const merged = zeroUsage();
  mergeTotals(merged, rootAcc.usage);
  mergeTotals(merged, descAcc.usage);
  const mergedModels = new Map();
  for (const map of [rootAcc.byModel, descAcc.byModel]) {
    if (map === void 0) continue;
    for (const [key, entry] of map.entries()) {
      const prev = mergedModels.get(key);
      if (prev === void 0) mergedModels.set(key, { usage: Object.assign(zeroUsage(), entry.usage), costCny: entry.costCny });
      else { mergeTotals(prev.usage, entry.usage); prev.costCny += entry.costCny; }
    }
  }
  const modelsOf = (map) => map === void 0 ? [] : [...map.entries()].map(([model, entry]) => ({ model, usage: entry.usage, costCny: entry.costCny }));
  const partial = listFailed || failedSessionIds.length > 0;
  return {
    found: true,
    sessionId,
    rootReadFailed,
    root: {
      usage: rootAcc.usage,
      costCny: rootAcc.costCny,
      models: modelsOf(rootAcc.byModel),
      unpricedSteps: rootAcc.unpricedSteps,
      invalidSteps: rootAcc.invalidSteps,
      approxSteps: rootAcc.approxSteps
    },
    descendants: {
      usage: descAcc.usage,
      costCny: descAcc.costCny,
      models: modelsOf(descAcc.byModel),
      unpricedSteps: descAcc.unpricedSteps,
      invalidSteps: descAcc.invalidSteps,
      approxSteps: descAcc.approxSteps,
      descendantCount: ids.length - 1
    },
    merged,
    costCny: rootAcc.costCny + descAcc.costCny,
    models: modelsOf(mergedModels),
    unpricedSteps: rootAcc.unpricedSteps + descAcc.unpricedSteps,
    invalidSteps: rootAcc.invalidSteps + descAcc.invalidSteps,
    approxSteps: rootAcc.approxSteps + descAcc.approxSteps,
    descendantCount: ids.length - 1,
    partial,
    failedSessionCount: failedSessionIds.length,
    failedSessionIds,
    persistenceAvailable,
    foldedSessionCount,
    pricingVersion: snapshot.version,
    eventRevision,
    rootEventRevision,
    queriedAt: new Date().toISOString()
  };
}

// ── "today" fold: every session's own samples since Beijing midnight ───────
const TODAY_CACHE_TTL_MS = 60000;

function todayStartBeijing(now) {
  const shifted = now + 8 * 3600 * 1000;
  return Math.floor(shifted / 86400000) * 86400000 - 8 * 3600 * 1000;
}
function monthStartBeijing(now) {
  const shifted = new Date(now + 8 * 3600 * 1000);
  return Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), 1) - 8 * 3600 * 1000;
}
function beijingDate(now) {
  return new Date(now + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

async function queryToday(ctx, persistence, signal, suppliedSnapshot, suppliedNow) {
  const now = typeof suppliedNow === "number" && Number.isFinite(suppliedNow) ? suppliedNow : Date.now();
  const since = todayStartBeijing(now);
  const monthSince = monthStartBeijing(now);
  const snapshot = suppliedSnapshot !== void 0 ? suppliedSnapshot : pricingSnapshot();
  let liveList = [];
  let listFailed = false;
  try {
    liveList = ctx.sessions.list();
  } catch {
    listFailed = true;
  }
  let persistedHeaders = [];
  let persistenceAvailable = persistence !== null;
  if (persistence !== null) {
    try {
      persistedHeaders = await persistence.list(signal);
    } catch {
      listFailed = true;
      persistedHeaders = [];
    }
  }
  const byId = indexHeaders(liveList, persistedHeaders);
  let costCny = 0;
  let monthCostCny = 0;
  let unpricedSteps = 0;
  let invalidSteps = 0;
  let approxSteps = 0;
  let sessionCount = 0;
  let foldedSessionCount = 0;
  const failedSessionIds = [];
  for (const id in byId) {
    if (!Object.prototype.hasOwnProperty.call(byId, id)) continue;
    try {
      const read = await sessionEvents(ctx, persistence, id, signal);
      if (read === null) {
        failedSessionIds.push(id);
        continue;
      }
      const seed = typeof read.meta.seedLength === "number" && read.meta.seedLength > 0 ? Math.floor(read.meta.seedLength) : 0;
      if (seed > read.events.length) {
        failedSessionIds.push(id);
        continue;
      }
      const day = foldUsage(read.events, { snapshot, startIndex: seed, sinceMs: since });
      costCny += day.costCny;
      unpricedSteps += day.unpricedSteps;
      invalidSteps += day.invalidSteps;
      approxSteps += day.approxSteps;
      sessionCount += 1;
      foldedSessionCount += 1;
      if (monthSince !== since) {
        const month = foldUsage(read.events, { snapshot, startIndex: seed, sinceMs: monthSince });
        monthCostCny += month.costCny;
      } else {
        monthCostCny += day.costCny;
      }
    } catch {
      failedSessionIds.push(id);
    }
  }
  return {
    date: beijingDate(now),
    since,
    costCny,
    monthCostCny,
    unpricedSteps,
    invalidSteps,
    approxSteps,
    partial: listFailed || failedSessionIds.length > 0,
    failedSessionCount: failedSessionIds.length,
    failedSessionIds,
    persistenceAvailable,
    foldedSessionCount,
    sessionCount,
    pricingVersion: snapshot.version
  };
}

export { foldLive, foldUsage, parsePricingHtml, modelKeyOf, beijingPeak, priceBuckets, usageBucket, collectDescendantIds, indexHeaders, pricingSnapshot, tablesForTime, queryTreeCost, queryToday };

export const inject = ["webServer", "credentials", "sessions"];

export function apply(ctx, config = {}) {
  let persistence = null;
  // Route caches and request coalescing belong to this plugin instance. Keeping
  // them module-global leaks balances/today totals between two Cordis contexts.
  const balanceCacheByCredential = new Map(); // credentialKey → { at, data }
  const forceAtByCredential = new Map();
  let todayCache = null;
  const routeInflight = new Map();
  const liveFoldCache = new WeakMap();
  const routeSingleflight = (key, fn) => {
    if (routeInflight.has(key)) return routeInflight.get(key);
    const promise = (async () => {
      try { return await fn(); }
      finally { routeInflight.delete(key); }
    })();
    routeInflight.set(key, promise);
    return promise;
  };
  const budgetPayload = (() => {
    const daily = Number(config.dailyBudgetCny);
    const monthly = Number(config.monthlyBudgetCny);
    const warn = Number(config.balanceWarnCny);
    const critical = Number(config.balanceCriticalCny);
    const out = {};
    if (Number.isFinite(daily) && daily > 0) out.daily = daily;
    if (Number.isFinite(monthly) && monthly > 0) out.monthly = monthly;
    out.balanceWarnCny = Number.isFinite(warn) && warn >= 0 ? warn : 20;
    out.balanceCriticalCny = Number.isFinite(critical) && critical >= 0 ? critical : 5;
    return out;
  })();
  ctx.inject(["sessionPersistence"], (childCtx) => {
    const service = childCtx.sessionPersistence;
    persistence = service;
    childCtx.effect(() => () => {
      if (persistence === service) persistence = null;
    }, "dsh-better-stats: optional sessionPersistence binding");
  });
  ctx.effect(() => {
    refreshPricing();
    return () => { /* background refresh needs no teardown */ };
  }, "dsh-better-stats: initial pricing refresh");

  // ── /balance: one schema for fresh/cache/cooldown/stale/error ────────────
  ctx.effect(() => ctx.webServer.register({
    path: "/plugins/better-stats/balance",
    handler: async (req, res) => {
      const requestAt = Date.now();
      const url = new URL(req.url, "http://dsh.local");
      const force = url.searchParams.get("force") === "1";
      const meta = { pricing: ensurePricing(), budget: budgetPayload };
      const write = (body) => {
        res.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store"
        });
        res.end(JSON.stringify({ ...body, ...meta }));
      };
      let credentialKey = null;
      let matchingCache = null;
      const cachedData = () => ({ ...matchingCache.data, queriedAt: new Date(matchingCache.at).toISOString() });
      try {
        const hit = await ctx.credentials.resolve(API_KEY_ENV);
        if (!hit) {
          write({ configured: false, status: "ok", provider: null, displayName: null, amount: null, amountDecimals: null, currency: null, grantedBalance: null, toppedUpBalance: null, queriedAt: new Date().toISOString() });
          return;
        }
        credentialKey = String(hit.value);
        matchingCache = balanceCacheByCredential.get(credentialKey) ?? null;
        if (matchingCache !== null && !force && requestAt - matchingCache.at < CACHE_TTL_MS) {
          write({ ...cachedData(), status: "ok" });
          return;
        }
        const lastForceAt = forceAtByCredential.get(credentialKey) ?? 0;
        if (force && requestAt - lastForceAt < FORCE_COOLDOWN_MS && matchingCache !== null) {
          write({ ...cachedData(), status: "stale" }); // cooldown: serve cache
          return;
        }
        if (force) forceAtByCredential.set(credentialKey, requestAt);
        const data = await routeSingleflight("balance:" + credentialKey, () => queryBalance(hit.value));
        const completedAt = Date.now();
        matchingCache = { at: completedAt, data: { configured: true, ...data } };
        balanceCacheByCredential.set(credentialKey, matchingCache);
        write({ configured: true, status: "ok", ...data, queriedAt: new Date(completedAt).toISOString() });
      } catch {
        if (credentialKey !== null) matchingCache = balanceCacheByCredential.get(credentialKey) ?? null;
        if (matchingCache !== null) {
          write({ ...cachedData(), status: "stale" }); // stale-while-error
        } else {
          write({ configured: true, status: "error", error: "unavailable", provider: null, displayName: null, amount: null, amountDecimals: null, currency: null, grantedBalance: null, toppedUpBalance: null, queriedAt: new Date().toISOString() });
        }
      }
    }
  }), "dsh-better-stats: /plugins/better-stats/balance route");

  // ── /cost: one whole-tree snapshot ────────────────────────────────────────
  let costCache = null; // { at, key, data }
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
      const pricing = ensurePricing();
      const snapshot = pricingSnapshot();
      const meta = { pricing, budget: budgetPayload };
      const key = sessionId + "|" + snapshot.version;
      if (costCache !== null && costCache.key === key && now - costCache.at < COST_TTL_MS) {
        write({ ...costCache.data, cached: true, queriedAt: new Date(costCache.at).toISOString(), ...meta });
        return;
      }
      try {
        const result = await routeSingleflight("cost:" + key, () =>
          queryTreeCost(ctx, persistence, sessionId, AbortSignal.timeout(15000), snapshot));
        if (result.found !== true) {
          write({ error: "session not found", sessionId }, 404);
          return;
        }
        if (result.rootReadFailed) {
          if (costCache !== null && costCache.key === key) {
            write({ ...costCache.data, stale: true, cached: false, queriedAt: new Date(costCache.at).toISOString(), ...meta });
            return;
          }
          write({ error: "session root read failed", sessionId }, 500);
          return;
        }
        const data = { sessionId, ...result };
        delete data.queriedAt;
        costCache = { at: Date.now(), key, data };
        write({ ...result, cached: false, ...meta });
      } catch {
        if (costCache !== null && costCache.key === key) {
          write({ ...costCache.data, stale: true, cached: false, queriedAt: new Date(costCache.at).toISOString(), ...meta });
        } else {
          write({ error: "cost query failed", sessionId }, 500);
        }
      }
    }
  }), "dsh-better-stats: /plugins/better-stats/cost route");

  // ── /live: ROOT-only live edges (client merges with /cost descendants) ────
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
      const seed = session.header !== void 0 && session.header !== null &&
        typeof session.header.seedLength === "number" && session.header.seedLength > 0
        ? Math.floor(session.header.seedLength)
        : 0;
      const pricing = ensurePricing();
      const snapshot = pricingSnapshot();
      const sourceEvents = Array.isArray(session.events) ? session.events : [];
      const lastEvent = sourceEvents.length > 0 ? sourceEvents[sourceEvents.length - 1] : null;
      let folded = liveFoldCache.get(session);
      if (folded === void 0 || folded.events !== sourceEvents || folded.length !== sourceEvents.length ||
          folded.lastEvent !== lastEvent || folded.seed !== seed || folded.pricingVersion !== snapshot.version) {
        const events = sourceEvents.slice();
        const live = foldLive(events, { startIndex: seed });
        let usage = { totals: { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0 }, costCny: 0, byModel: new Map(), unpricedSteps: 0, invalidSteps: 0 };
        try {
          usage = foldUsage(events, { snapshot, startIndex: seed });
        } catch {
          // settlement is best-effort; never fail the live route
        }
        folded = {
          events: sourceEvents,
          length: sourceEvents.length,
          lastEvent,
          seed,
          pricingVersion: snapshot.version,
          live,
          usage
        };
        liveFoldCache.set(session, folded);
      }
      const live = folded.live;
      const usage = folded.usage;
      write({
        sessionId,
        ...live,
        rootCostCny: usage.costCny,
        rootUsage: usage.totals,
        models: [...usage.byModel.entries()].map(([model, entry]) => ({ model, usage: entry.usage, costCny: entry.costCny })),
        unpricedSteps: usage.unpricedSteps,
        invalidSteps: usage.invalidSteps,
        seedLength: seed,
        eventRevision: sourceEvents.length,
        pricing,
        budget: budgetPayload,
        queriedAt: new Date().toISOString()
      });
    }
  }), "dsh-better-stats: /plugins/better-stats/live route");

  // ── /today: Beijing-day + month fold (cache key: date|month|pricingVersion)
  ctx.effect(() => ctx.webServer.register({
    path: "/plugins/better-stats/today",
    handler: async (req, res) => {
      const now = Date.now();
      const pricing = ensurePricing();
      const snapshot = pricingSnapshot();
      const meta = { pricing, budget: budgetPayload };
      const write = (payload, status = 200) => {
        res.writeHead(status, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store"
        });
        res.end(JSON.stringify({ ...payload, ...meta }));
      };
      const date = beijingDate(now);
      const key = date + "|" + date.slice(0, 7) + "|" + snapshot.version;
      if (todayCache !== null && todayCache.key === key && now - todayCache.at < TODAY_CACHE_TTL_MS) {
        write({ ...todayCache.data, cached: true, queriedAt: new Date(todayCache.at).toISOString() });
        return;
      }
      try {
        const result = await routeSingleflight("today:" + key, () =>
          queryToday(ctx, persistence, AbortSignal.timeout(15000), snapshot, now));
        const completedAt = Date.now();
        todayCache = { at: completedAt, key, data: result };
        write({ ...result, cached: false, queriedAt: new Date(completedAt).toISOString() });
      } catch {
        if (todayCache !== null && todayCache.key === key) {
          write({ ...todayCache.data, stale: true, cached: false, queriedAt: new Date(todayCache.at).toISOString() });
        } else {
          write({ error: "today query failed" }, 500);
        }
      }
    }
  }), "dsh-better-stats: /plugins/better-stats/today route");
}
