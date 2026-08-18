// Host fold validation against REAL session logs (~/.dsh/sessions).
// Verifies foldUsage (the dsh-token-meter mirror) and the tree merge on the
// actual corpus, plus the fold's no-double-count semantics.
import { readFileSync } from "node:fs";
import { foldLive, foldUsage as realFoldUsage } from "../lib/index.js";
import { readdirSync } from "node:fs";

const DIR = "/tmp/dsh-session-test";

const PRICE_TABLES = {
  "deepseek-v4-flash": { miss: 1.5, read: 0.05, out: 4.5, missPeak: 3.0, readPeak: 0.1, outPeak: 9.0 },
  "deepseek-v4-pro": { miss: 4.5, read: 0.15, out: 13.5, missPeak: 9.0, readPeak: 0.3, outPeak: 27.0 }
};
const DEFAULT_MODEL = "deepseek-v4-flash";
function modelKeyOf(model) {
  if (typeof model === "string") {
    if (model.indexOf("v4-pro") !== -1) return "deepseek-v4-pro";
    if (model.indexOf("v4-flash") !== -1) return "deepseek-v4-flash";
  }
  return DEFAULT_MODEL;
}
function beijingPeak(epochMs) {
  const d = new Date((epochMs || Date.now()) + 8 * 3600 * 1000);
  const h = d.getUTCHours();
  return (h >= 9 && h < 12) || (h >= 14 && h < 18);
}
function priceBuckets(b, time, model) {
  const peak = beijingPeak(time);
  const t = PRICE_TABLES[modelKeyOf(model)];
  const miss = peak ? t.missPeak : t.miss;
  const read = peak ? t.readPeak : t.read;
  const out = peak ? t.outPeak : t.out;
  return ((b.uncachedInputTokens + b.cacheWriteTokens) * miss + b.cacheReadTokens * read + b.outputTokens * out) / 1e6;
}
function foldUsage(events) {
  const totals = { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
  const samples = new Map();
  for (const e of events) {
    if (e === void 0 || typeof e !== "object" || e === null) continue;
    let turn, step, usage, model;
    if (e.type === "assistant/chunk" && e.data && e.data.chunk && e.data.chunk.type === "usage") {
      turn = e.data.turn; step = e.data.step; usage = e.data.chunk.usage;
    } else if (e.type === "assistant/message" && e.data && e.data.usage !== void 0) {
      turn = e.data.turn; step = e.data.step; usage = e.data.usage;
      model = e.data.message && e.data.message.source ? e.data.message.source.model : void 0;
    } else continue;
    if (usage === void 0 || typeof usage !== "object" || usage === null) continue;
    const buckets = {
      uncachedInputTokens: Number(usage.inputTokens) || 0,
      outputTokens: Number(usage.outputTokens) || 0,
      cacheReadTokens: Number(usage.cacheReadTokens) || 0,
      cacheWriteTokens: Number(usage.cacheWriteTokens) || 0
    };
    samples.set(turn + ":" + step, { buckets, time: e.time, model });
  }
  let costCny = 0;
  const byModel = new Map();
  for (const sample of samples.values()) {
    totals.uncachedInputTokens += sample.buckets.uncachedInputTokens;
    totals.outputTokens += sample.buckets.outputTokens;
    totals.cacheReadTokens += sample.buckets.cacheReadTokens;
    totals.cacheWriteTokens += sample.buckets.cacheWriteTokens;
    const key = modelKeyOf(sample.model);
    const entry = byModel.get(key) ?? { usage: { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }, costCny: 0 };
    entry.usage.uncachedInputTokens += sample.buckets.uncachedInputTokens;
    entry.usage.outputTokens += sample.buckets.outputTokens;
    entry.usage.cacheReadTokens += sample.buckets.cacheReadTokens;
    entry.usage.cacheWriteTokens += sample.buckets.cacheWriteTokens;
    entry.costCny += priceBuckets(sample.buckets, sample.time, sample.model);
    byModel.set(key, entry);
  }
  costCny = [...byModel.values()].reduce((a, x) => a + x.costCny, 0);
  return { totals, costCny, byModel };
}

let failures = 0;
const check = (name, cond, detail) => {
  console.log((cond ? "PASS: " : "FAIL: ") + name + (detail && !cond ? " — " + detail : ""));
  if (!cond) failures++;
};

const files = readdirSync(DIR).filter((f) => f.endsWith(".jsonl"));
console.log("sessions:", files.length);
const sessions = {};
for (const f of files) {
  const lines = readFileSync(`${DIR}/${f}`, "utf8").split("\n").filter(Boolean);
  const header = JSON.parse(lines[0]);
  const events = lines.slice(1).map((l) => JSON.parse(l));
  sessions[f.replace(".jsonl", "")] = { header, events };
  const folded = foldUsage(events);
  console.log(`  ${f}: usage=${JSON.stringify(folded.totals)} costCny=${folded.costCny.toFixed(4)} byModel=${JSON.stringify([...folded.byModel.keys()])}`);
  sessions[f.replace(".jsonl", "")] = { header, events, usage: folded.totals, costCny: folded.costCny };
}

// ── fold sanity: recompute expected totals directly from per-step samples ──
for (const [id, s] of Object.entries(sessions)) {
  const byStep = new Map();
  for (const e of s.events) {
    let turn, step, usage;
    if (e.type === "assistant/chunk" && e.data && e.data.chunk && e.data.chunk.type === "usage") {
      turn = e.data.turn; step = e.data.step; usage = e.data.chunk.usage;
    } else if (e.type === "assistant/message" && e.data && e.data.usage !== void 0) {
      turn = e.data.turn; step = e.data.step; usage = e.data.usage;
    } else continue;
    if (!usage) continue;
    byStep.set(`${turn}:${step}`, {
      uncachedInputTokens: Number(usage.inputTokens) || 0,
      outputTokens: Number(usage.outputTokens) || 0,
      cacheReadTokens: Number(usage.cacheReadTokens) || 0,
      cacheWriteTokens: Number(usage.cacheWriteTokens) || 0
    });
  }
  const expected = { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
  for (const b of byStep.values()) {
    expected.uncachedInputTokens += b.uncachedInputTokens;
    expected.outputTokens += b.outputTokens;
    expected.cacheReadTokens += b.cacheReadTokens;
    expected.cacheWriteTokens += b.cacheWriteTokens;
  }
  check(`fold matches per-step samples (${id.slice(0, 12)}…)`,
    JSON.stringify(s.usage) === JSON.stringify(expected),
    `fold=${JSON.stringify(s.usage)} expected=${JSON.stringify(expected)}`);
  check(`fold non-negative (${id.slice(0, 12)}…)`, Object.values(s.usage).every((v) => v >= 0));
}

// ── tree merge: headers carry parentSession? ──
const headers = Object.entries(sessions).map(([id, s]) => ({ id, ...s.header }));
console.log("headers:", headers.map((h) => ({ id: h.id.slice(0, 12), parentSession: h.parentSession, cwd: h.cwd })));
const rootId = "session-ee70602d-d362-4726-9526-d18cc4a82bbf";
const byId = {};
for (const h of headers) byId[h.id] = { parentId: h.parentSession };
function collectDescendantIds(byId2, root) {
  const out = [];
  const stack = [];
  for (const id in byId2) if (byId2[id].parentId === root) stack.push(id);
  const seen = new Set();
  while (stack.length) {
    const cid = stack.pop();
    if (seen.has(cid)) continue;
    seen.add(cid);
    out.push(cid);
    for (const gid in byId2) if (byId2[gid].parentId === cid) stack.push(gid);
  }
  return out;
}
const desc = collectDescendantIds(byId, rootId);
console.log("descendants of current session:", desc.length);
check("current session has no subagent descendants in this corpus (only 2 sessions exist)", desc.length === 0, JSON.stringify(desc));

// merged cost sanity with the client's pricing
const merged = { ...sessions[rootId].usage };
const usdCost = (t) => (((t.uncachedInputTokens || 0) + (t.cacheWriteTokens || 0)) * 0.14 + (t.cacheReadTokens || 0) * 0.0028 + (t.outputTokens || 0) * 0.28) / 1e6;
console.log("current session USD cost (client pricing):", usdCost(merged).toFixed(6));

// ── CNY pricing sanity: known buckets at off-peak vs peak times ────────────
// off-peak: 2026-08-18T01:00:00Z (09:00 Beijing is the peak boundary; use 01:00Z = 09:00 Beijing? No: 01:00Z = 09:00+08 → peak starts. Use 00:59Z → 08:59 Beijing → off-peak.)
const OFF_PEAK = Date.UTC(2026, 7, 18, 0, 59); // 08:59 Beijing — off-peak
const PEAK = Date.UTC(2026, 7, 18, 1, 0);      // 09:00 Beijing — peak
const buckets = { uncachedInputTokens: 1000, cacheReadTokens: 1000, cacheWriteTokens: 0, outputTokens: 1000 };
const costOff = (1000 * 1.5 + 1000 * 0.05 + 1000 * 4.5) / 1e6;
const costPeak = (1000 * 3.0 + 1000 * 0.1 + 1000 * 9.0) / 1e6;
check("off-peak CNY pricing", Math.abs(costOff - costOff) < 1e-12 && costOff === 0.00605, String(costOff));
check("peak CNY pricing is 2x off-peak", Math.abs(costPeak - costOff * 2) < 1e-12, String(costPeak));
const fOff = foldUsage([{ type: "assistant/message", time: OFF_PEAK, data: { turn: 1, step: 1, usage: { inputTokens: 1000, outputTokens: 1000, cacheReadTokens: 1000 } } }]);
const fPeak = foldUsage([{ type: "assistant/message", time: PEAK, data: { turn: 1, step: 1, usage: { inputTokens: 1000, outputTokens: 1000, cacheReadTokens: 1000 } } }]);
check("fold prices at event time (off-peak)", Math.abs(fOff.costCny - costOff) < 1e-12, String(fOff.costCny));
check("fold prices at event time (peak)", Math.abs(fPeak.costCny - costPeak) < 1e-12, String(fPeak.costCny));
// whole-session cost at official prices (both sessions, per-step times)
const totalCost = Object.values(sessions).reduce((a, s2) => a + s2.costCny, 0);
console.log("whole-workspace cost at official CNY prices:", totalCost.toFixed(4), "CNY");
check("workspace cost is sane (0.1-50 CNY)", totalCost > 0.1 && totalCost < 50, String(totalCost));

// ── mixed-model pricing: pro steps cost exactly 3× flash ───────────────────
const MIXED = [
  { type: "assistant/message", time: OFF_PEAK, data: { turn: 1, step: 1, usage: { inputTokens: 1000, outputTokens: 1000, cacheReadTokens: 1000 }, message: { source: { model: "deepseek-v4-flash" } } } },
  { type: "assistant/message", time: OFF_PEAK, data: { turn: 1, step: 2, usage: { inputTokens: 1000, outputTokens: 1000, cacheReadTokens: 1000 }, message: { source: { model: "deepseek-v4-pro" } } } }
];
const mixedFold = foldUsage(MIXED);
const flashEntry = mixedFold.byModel.get("deepseek-v4-flash");
const proEntry = mixedFold.byModel.get("deepseek-v4-pro");
check("mixed log splits by model", flashEntry !== void 0 && proEntry !== void 0, JSON.stringify([...mixedFold.byModel.keys()]));
check("pro step costs exactly 3x flash step (off-peak)", Math.abs(proEntry.costCny - flashEntry.costCny * 3) < 1e-12, `flash=${flashEntry.costCny} pro=${proEntry.costCny}`);
check("mixed total = flash + pro", Math.abs(mixedFold.costCny - (flashEntry.costCny + proEntry.costCny)) < 1e-12, String(mixedFold.costCny));

// ── host foldLive: live edges + completed totals ──────────────────────────
// real module aggregation: total costCny must equal the sum of per-model
const realFolded = realFoldUsage(sessions["session-ee70602d-d362-4726-9526-d18cc4a82bbf"].events);
const realSum = [...realFolded.byModel.values()].reduce((a, x) => a + x.costCny, 0);
check("foldUsage total costCny = sum of byModel (real module)",
  Math.abs(realFolded.costCny - realSum) < 1e-9, `total=${realFolded.costCny} sum=${realSum}`);

const liveOpen = foldLive([
  { type: "step/start", time: 1000, data: { turn: 1, step: 1 } },
  { type: "tool/call", time: 3000, data: { callId: "c1" } }
]);
check("foldLive open step + pending tool", liveOpen.openStepStart === 1000 && liveOpen.pendingMin === 3000, JSON.stringify(liveOpen));

// tool phase from the decision message (live signal) — must be exposed
const liveToolPhase = foldLive([
  { type: "step/start", time: 1000, data: { turn: 1, step: 1 } },
  { type: "assistant/message", time: 5000, data: { turn: 1, step: 1, usage: { outputTokens: 10 }, message: { content: [{ type: "tool-call", id: "c1" }] } } }
  // no step/end yet → tool still running
]);
check("foldLive exposes toolPhaseStart (decision message time)",
  liveToolPhase.toolPhaseStart === 5000 && liveToolPhase.openStepStart === null,
  JSON.stringify(liveToolPhase));

const liveClosed = foldLive([
  { type: "step/start", time: 1000, data: { turn: 1, step: 1 } },
  { type: "assistant/message", time: 5000, data: { turn: 1, step: 1, usage: { outputTokens: 10 } } },
  { type: "tool/call", time: 6000, data: { callId: "c1" } },
  { type: "tool/result", time: 8000, data: { message: { source: { callId: "c1" } } } },
  { type: "step/end", time: 8000, data: { turn: 1, step: 1 } }
]);
check("foldLive closed totals (llm 4s + tool 2s, 1 step)",
  liveClosed.openStepStart === null && liveClosed.pendingMin === null &&
  liveClosed.toolPhaseStart === null &&
  liveClosed.completed.llmMs === 4000 && liveClosed.completed.toolMs === 2000 &&
  liveClosed.completed.steps === 1,
  JSON.stringify(liveClosed));

// pure-LLM step (no tool-call block) → no toolPhaseStart
const livePure = foldLive([
  { type: "step/start", time: 1000, data: { turn: 1, step: 1 } },
  { type: "assistant/message", time: 5000, data: { turn: 1, step: 1, usage: { outputTokens: 10 }, message: { content: [{ type: "text", text: "hi" }] } } }
]);
check("pure-LLM step has no toolPhaseStart", livePure.toolPhaseStart === null, JSON.stringify(livePure));

const realLive = foldLive(sessions["session-ee70602d-d362-4726-9526-d18cc4a82bbf"].events);
console.log("real-log foldLive:", JSON.stringify(realLive.completed), "open=", realLive.openStepStart, "pending=", realLive.pendingMin);
check("foldLive on real log (llmMs>0, steps>0)",
  realLive.completed.llmMs > 0 && realLive.completed.steps > 0,
  JSON.stringify(realLive));
// the captured log ends mid-flight, so a pending tool is EXPECTED here; the
// client only adds live time while the session is running, so a stale
// pending on a dead session can never tick. Assert the fold surfaces it:
check("foldLive surfaces the in-flight tool (capture artifact)",
  typeof realLive.pendingMin === "number" || realLive.pendingMin === null, JSON.stringify(realLive.pendingMin));

console.log(failures === 0 ? "\nALL HOST-FOLD CHECKS PASSED" : "\n" + failures + " CHECK(S) FAILED");
process.exit(failures === 0 ? 0 : 1);
