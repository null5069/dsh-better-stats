// Real-log reconciliation: an INDEPENDENT oracle re-derives every per-step
// sample and its cost from a raw DSH session log and compares it against the
// production foldUsage/foldLive. Deliberately does NOT reuse the production
// fold algorithm: it accumulates linearly over the last-seen (turn, step)
// sample with a plain object map and its own price math.
//
// Usage: node test/reconcile-live.mjs <session.jsonl.zstd-or-jsonl>
// (zstd logs are decompressed via `zstd -dc`; plain .jsonl is read directly)
//
// NOT part of `npm test` — the default suite uses sanitized fixtures only.
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { foldUsage, foldLive, modelKeyOf } from "../lib/index.js";

const path = process.argv[2];
if (!path) {
  console.error("usage: node test/reconcile-live.mjs <session log>");
  process.exit(2);
}
let text;
if (path.endsWith(".zstd")) {
  text = execFileSync("zstd", ["-dc", path], { maxBuffer: 1 << 30 }).toString("utf8");
} else {
  text = readFileSync(path, "utf8");
}
const lines = text.split("\n").filter(Boolean);
const header = JSON.parse(lines[0]);
const events = lines.slice(1).map((l) => JSON.parse(l));
console.log("log:", path);
console.log("header:", JSON.stringify({ id: header.id, parentSession: header.parentSession, origin: header.origin, seedLength: header.seedLength }));
console.log("events:", events.length, "seedLength:", header.seedLength || 0);

let failures = 0;
const check = (name, cond, detail) => {
  console.log((cond ? "PASS: " : "FAIL: ") + name + (detail && !cond ? " — " + detail : ""));
  if (!cond) failures++;
};

// ── independent oracle ─────────────────────────────────────────────────────
const BUILTIN = {
  "deepseek-v4-flash": { miss: 1.5, read: 0.05, out: 4.5, missPeak: 3.0, readPeak: 0.1, outPeak: 9.0 },
  "deepseek-v4-pro": { miss: 4.5, read: 0.15, out: 13.5, missPeak: 9.0, readPeak: 0.3, outPeak: 27.0 }
};
function peakAt(t) {
  const h = new Date(t + 8 * 3600 * 1000).getUTCHours();
  return (h >= 9 && h < 12) || (h >= 14 && h < 18);
}
function price(b, t, model) {
  const table = BUILTIN[modelKeyOf(model)];
  if (!table) return 0;
  const pk = peakAt(t);
  const miss = pk ? table.missPeak : table.miss;
  const read = pk ? table.readPeak : table.read;
  const out = pk ? table.outPeak : table.out;
  // CONTRACT: only outputTokens is billed at the output rate
  return ((b.uncachedInputTokens + b.cacheWriteTokens) * miss + b.cacheReadTokens * read + b.outputTokens * out) / 1e6;
}

const seedStart = typeof header.seedLength === "number" && header.seedLength > 0 ? header.seedLength : 0;
const samples = new Map(); // "turn:step" → { usage, time, model }
const lastModelByTurn = {};
let invalid = 0;
for (let i = seedStart; i < events.length; i++) {
  const e = events[i];
  if (e === void 0 || typeof e !== "object" || e === null) continue;
  let turn, step, usage, model;
  if (e.type === "assistant/chunk" && e.data && e.data.chunk && e.data.chunk.type === "usage") {
    turn = e.data.turn; step = e.data.step; usage = e.data.chunk.usage;
    if (typeof lastModelByTurn[turn] === "string") model = lastModelByTurn[turn];
  } else if (e.type === "assistant/message" && e.data && e.data.usage !== void 0) {
    turn = e.data.turn; step = e.data.step; usage = e.data.usage;
    model = e.data.message && e.data.message.source ? e.data.message.source.model : void 0;
    if (typeof model === "string" && model !== "") lastModelByTurn[turn] = model;
  } else continue;
  if (usage === void 0 || usage === null || typeof usage !== "object") continue;
  const u = {
    uncachedInputTokens: Number(usage.inputTokens) || 0,
    cacheReadTokens: Number(usage.cacheReadTokens) || 0,
    cacheWriteTokens: Number(usage.cacheWriteTokens) || 0,
    outputTokens: Number(usage.outputTokens) || 0,
    reasoningTokens: Number(usage.reasoningTokens) || 0
  };
  if (u.reasoningTokens > u.outputTokens || u.outputTokens < 0 || !Number.isInteger(u.outputTokens)) {
    invalid += 1;
    continue;
  }
  samples.set(turn + ":" + step, { usage: u, time: e.time, model });
}
const oracle = { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0 };
let oracleCost = 0;
for (const s of samples.values()) {
  oracle.uncachedInputTokens += s.usage.uncachedInputTokens;
  oracle.cacheReadTokens += s.usage.cacheReadTokens;
  oracle.cacheWriteTokens += s.usage.cacheWriteTokens;
  oracle.outputTokens += s.usage.outputTokens;
  oracle.reasoningTokens += s.usage.reasoningTokens;
  oracleCost += price(s.usage, s.time, s.model);
}

// ── production fold (builtin tables: this log predates any ledger) ─────────
const snap = { tables: BUILTIN, version: 0, ledger: [] };
const folded = foldUsage(events, { snapshot: snap, startIndex: seedStart });
const live = foldLive(events, { startIndex: seedStart });

// ── independent decode oracle: steps anchored by a first token ────────────
// The rate numerator only covers steps whose decode window opened with a
// first-token chunk; its tokens must be <= total output and NEVER include
// reasoning on top of output.
let oracleDecodeTokens = 0;
let oracleDecodeMs = 0;
{
  let open = null;
  for (let i = seedStart; i < events.length; i++) {
    const e = events[i];
    if (e === void 0 || typeof e !== "object" || e === null) continue;
    if (e.type === "step/start") {
      open = { turn: e.data && e.data.turn, step: e.data && e.data.step, start: e.time, first: null };
    } else if (e.type === "assistant/chunk" && open !== null && e.data && open.turn === e.data.turn && open.step === e.data.step && open.first === null) {
      const c = e.data.chunk;
      const isTok = c && (c.type === "text-delta" || c.type === "reasoning-delta" ? c.text !== "" : c.type === "tool-call-delta" ? (c.argumentsDelta !== "" || c.name !== void 0) : false);
      if (isTok) open.first = e.time;
    } else if (e.type === "assistant/message" && open !== null && e.data && open.turn === e.data.turn && open.step === e.data.step) {
      if (open.first !== null && e.data.usage && typeof e.data.usage.outputTokens === "number") {
        oracleDecodeTokens += e.data.usage.outputTokens;
        oracleDecodeMs += Math.max(0, e.time - open.first);
      }
      open = null;
    } else if (e.type === "step/end") {
      open = null;
    }
  }
}

check("every sample upholds 0 <= reasoning <= output (oracle invalid count = production invalidSteps)",
  invalid === folded.invalidSteps,
  "oracle invalid=" + invalid + " production invalidSteps=" + folded.invalidSteps);
check("oracle totals match production totals",
  JSON.stringify(oracle) === JSON.stringify(folded.totals),
  "oracle=" + JSON.stringify(oracle) + " production=" + JSON.stringify(folded.totals));
check("oracle cost matches production cost",
  Math.abs(oracleCost - folded.costCny) < 1e-9,
  "oracle=" + oracleCost + " production=" + folded.costCny);
check("decode numerator = anchored outputTokens only (subset of total, reasoning never added)",
  live.completed.decodeTokens === oracleDecodeTokens &&
  live.completed.decodeMs === oracleDecodeMs &&
  live.completed.decodeTokens <= folded.totals.outputTokens,
  "production=" + JSON.stringify({ t: live.completed.decodeTokens, ms: live.completed.decodeMs }) +
  " oracle=" + JSON.stringify({ t: oracleDecodeTokens, ms: oracleDecodeMs }) +
  " totalOutput=" + folded.totals.outputTokens);
console.log("totals:", JSON.stringify(folded.totals));
console.log("costCny:", folded.costCny.toFixed(6), "| models:", [...folded.byModel.keys()].join(","));
console.log("unpricedSteps:", folded.unpricedSteps, "invalidSteps:", folded.invalidSteps, "approxSteps:", folded.approxSteps);
console.log("completed:", JSON.stringify(live.completed));
process.exit(failures === 0 ? 0 : 1);
