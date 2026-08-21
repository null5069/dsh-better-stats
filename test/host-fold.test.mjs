// Host fold validation on SANITIZED fixtures (test/fixtures — no /tmp logs).
// Every core assertion calls the production exports (foldUsage/foldLive/
// priceBuckets/modelKeyOf/usageBucket/collectDescendantIds/indexHeaders/
// tablesForTime/queryTreeCost via a fake ctx). Golden numbers are hand-
// computed constants — no fold/pricing/tree implementation is copied here.
import { readFileSync, readdirSync } from "node:fs";
import {
  foldLive,
  foldUsage,
  parsePricingHtml,
  modelKeyOf,
  beijingPeak,
  priceBuckets,
  usageBucket,
  collectDescendantIds,
  indexHeaders,
  tablesForTime,
  pricingSnapshot
} from "../lib/index.js";

let failures = 0;
const check = (name, cond, detail) => {
  console.log((cond ? "PASS: " : "FAIL: ") + name + (detail && !cond ? " — " + detail : ""));
  if (!cond) failures++;
};

const FIXTURE_DIR = new URL("./fixtures", import.meta.url).pathname;
const files = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith(".jsonl")).sort();
const fixtures = {};
for (const f of files) {
  const lines = readFileSync(`${FIXTURE_DIR}/${f}`, "utf8").split("\n").filter(Boolean);
  const header = JSON.parse(lines[0]);
  const events = lines.slice(1).map((l) => JSON.parse(l));
  fixtures[header.id] = { header, events };
}
check("fixtures loaded (no /tmp dependency)", files.length === 6, JSON.stringify(files));

// ── P1-1: output/reasoning subset contract ────────────────────────────────
// output=1000 reasoning=600 (root turn 1): billed output = 1000 ONLY.
const OFF = Date.UTC(2026, 7, 18, 0, 59); // 08:59 Beijing — off-peak
const PEAK = Date.UTC(2026, 7, 18, 1, 0); // 09:00 Beijing — peak
{
  const snap = { tables: BUILTIN(), version: 0, ledger: [] };
  const f = foldUsage([
    { type: "assistant/message", time: OFF, data: { turn: 1, step: 1, usage: { inputTokens: 0, outputTokens: 1000, reasoningTokens: 600, cacheReadTokens: 0, cacheWriteTokens: 0 }, message: { source: { model: "deepseek-v4-flash" } } } }
  ], { snapshot: snap });
  check("P1-1: cost bills outputTokens only (1000, not 1600)",
    Math.abs(f.costCny - 1000 * 4.5 / 1e6) < 1e-12,
    "costCny=" + f.costCny + " expected " + 1000 * 4.5 / 1e6);
  check("P1-1: totals keep reasoning as display subset",
    f.totals.outputTokens === 1000 && f.totals.reasoningTokens === 600,
    JSON.stringify(f.totals));
  const live = foldLive([
    { type: "step/start", time: 1000, data: { turn: 1, step: 1 } },
    { type: "assistant/chunk", time: 2000, data: { turn: 1, step: 1, chunk: { type: "text-delta", text: "hi" } } },
    { type: "assistant/message", time: 5000, data: { turn: 1, step: 1, usage: { inputTokens: 0, outputTokens: 1000, reasoningTokens: 600, cacheReadTokens: 0, cacheWriteTokens: 0 }, message: { source: { model: "deepseek-v4-flash" } } } }
  ]);
  check("P1-1: decodeTokens = output only (1000, reasoning not added)",
    live.completed.decodeTokens === 1000 && live.completed.decodeMs === 3000,
    JSON.stringify(live.completed));
  // golden fixture root: 6000 output / 3600 reasoning → decode 6000, cost 0.1645
  const rootFolded = foldUsage(fixtures["session-root"].events, { snapshot: snap });
  check("P1-1: root fixture costs 0.1645 (output-only billing)",
    Math.abs(rootFolded.costCny - 0.1645) < 1e-12,
    "costCny=" + rootFolded.costCny);
}

// ── P1-1: strict usage validation (no silent clamping) ────────────────────
{
  check("usageBucket accepts legal subset", usageBucket({ outputTokens: 100, reasoningTokens: 40 }) !== null);
  const bad = [
    ["negative", { inputTokens: -5 }],
    ["Infinity", { outputTokens: Infinity }],
    ["NaN", { outputTokens: NaN }],
    ["non-integer", { outputTokens: 1.5 }],
    ["reasoning > output", { outputTokens: 100, reasoningTokens: 700 }]
  ];
  for (const [name, usage] of bad) {
    check(`usageBucket rejects ${name}`, usageBucket(usage) === null, JSON.stringify(usage));
  }
  for (const [name, usage] of bad) {
    const f = foldUsage([
      { type: "assistant/message", time: OFF, data: { turn: 1, step: 1, usage, message: { source: { model: "deepseek-v4-flash" } } } }
    ], { snapshot: { tables: BUILTIN(), version: 0, ledger: [] } });
    check(`invalid ${name} counts into invalidSteps (not clamped to zero)`,
      f.invalidSteps === 1 && f.costCny === 0 && f.totals.outputTokens === 0,
      JSON.stringify(f));
  }
  const f2 = foldUsage([
    { type: "assistant/message", time: OFF, data: { turn: -1, step: 1, usage: { outputTokens: 10 }, message: { source: { model: "deepseek-v4-flash" } } } },
    { type: "assistant/message", time: OFF, data: { turn: 1, step: 0.5, usage: { outputTokens: 10 }, message: { source: { model: "deepseek-v4-flash" } } } },
    { type: "assistant/message", time: "not-a-time", data: { turn: 1, step: 1, usage: { outputTokens: 10 }, message: { source: { model: "deepseek-v4-flash" } } } }
  ], { snapshot: { tables: BUILTIN(), version: 0, ledger: [] } });
  check("invalid turn/step/time count into invalidSteps", f2.invalidSteps === 3 && f2.costCny === 0, JSON.stringify(f2));
  // every legal fixture fold upholds 0 <= reasoning <= output
  let subsetOk = true;
  for (const [id, s] of Object.entries(fixtures)) {
    const f = foldUsage(s.events, { snapshot: { tables: BUILTIN(), version: 0, ledger: [] } });
    if (f.totals.reasoningTokens < 0 || f.totals.reasoningTokens > f.totals.outputTokens) subsetOk = false;
  }
  check("0 <= reasoning <= output across all fixtures", subsetOk);
}

// ── model classification: normalized exact ids, no substring matching ─────
{
  check("modelKeyOf normalizes trailing date suffixes",
    modelKeyOf("DeepSeek-V4-Pro-0813") === "deepseek-v4-pro" &&
    modelKeyOf("deepseek-v4-flash-0731") === "deepseek-v4-flash" &&
    modelKeyOf(" deepseek-v4-flash ") === "deepseek-v4-flash");
  check("modelKeyOf rejects arbitrary substring matches",
    modelKeyOf("my-v4-flash-x") === "unknown" &&
    modelKeyOf("x-v4-pro") === "unknown" &&
    modelKeyOf("gpt-4o") === "unknown" &&
    modelKeyOf(void 0) === "unknown" && modelKeyOf(null) === "unknown" && modelKeyOf(42) === "unknown");
}

// ── peak/off-peak boundaries ───────────────────────────────────────────────
{
  check("beijingPeak boundaries",
    beijingPeak(OFF) === false && beijingPeak(PEAK) === true &&
    beijingPeak(Date.UTC(2026, 7, 18, 3, 59)) === true && // 11:59 BJ
    beijingPeak(Date.UTC(2026, 7, 18, 4, 0)) === false && // 12:00 BJ
    beijingPeak(Date.UTC(2026, 7, 18, 5, 59)) === false && // 13:59 BJ
    beijingPeak(Date.UTC(2026, 7, 18, 6, 0)) === true && // 14:00 BJ
    beijingPeak(Date.UTC(2026, 7, 18, 10, 0)) === false); // 18:00 BJ
  const buckets = { uncachedInputTokens: 1000, cacheReadTokens: 1000, cacheWriteTokens: 0, outputTokens: 1000 };
  const costOff = priceBuckets(buckets, OFF, "deepseek-v4-flash", BUILTIN());
  const costPeak = priceBuckets(buckets, PEAK, "deepseek-v4-flash", BUILTIN());
  check("off-peak pricing", costOff === 0.00605, String(costOff));
  check("peak pricing is 2x off-peak", Math.abs(costPeak - costOff * 2) < 1e-12, String(costPeak));
  check("unknown model prices at 0 with legal buckets",
    priceBuckets(buckets, OFF, "mystery-model", BUILTIN()) === 0);
}

// ── seed exclusion: only events after seedLength fold ─────────────────────
{
  const snap = { tables: BUILTIN(), version: 0, ledger: [] };
  const a = fixtures["session-subagent-a"];
  const seed = a.header.seedLength;
  const all = foldUsage(a.events, { snapshot: snap });
  const own = foldUsage(a.events, { snapshot: snap, startIndex: seed });
  check("seed-aware fold drops the inherited prefix",
    all.totals.outputTokens === 91000 && own.totals.outputTokens === 1000,
    `all=${all.totals.outputTokens} own=${own.totals.outputTokens}`);
  check("seed-aware fold costs only own events",
    Math.abs(own.costCny - 0.0093) < 1e-12,
    "costCny=" + own.costCny);
  const b = fixtures["session-subagent-b"];
  const bOwn = foldUsage(b.events, { snapshot: snap, startIndex: b.header.seedLength });
  check("subagent-b own fold golden",
    bOwn.totals.outputTokens === 2000 && Math.abs(bOwn.costCny - 0.02745) < 1e-12,
    JSON.stringify({ totals: bOwn.totals, costCny: bOwn.costCny }));
  const fork = fixtures["session-fork"];
  const forkOwn = foldUsage(fork.events, { snapshot: snap, startIndex: fork.header.seedLength });
  check("fork's own fold excludes its seed too",
    forkOwn.totals.outputTokens === 300 && forkOwn.totals.uncachedInputTokens === 100 &&
    Math.abs(forkOwn.costCny - 0.003) < 1e-12, // 14:06 BJ → peak
    JSON.stringify({ totals: forkOwn.totals, costCny: forkOwn.costCny }));
  const gc = fixtures["session-grandchild"];
  const gcOwn = foldUsage(gc.events, { snapshot: snap, startIndex: gc.header.seedLength });
  check("grandchild own fold golden",
    gcOwn.totals.outputTokens === 500 && Math.abs(gcOwn.costCny - 0.006795) < 1e-12,
    JSON.stringify({ totals: gcOwn.totals, costCny: gcOwn.costCny }));
  // NO-seed child: a subagent header without seedLength folds ALL its events
  const cNoSeed = fixtures["session-subagent-c"];
  check("no-seed child header (origin subagent, no seedLength field)",
    cNoSeed.header.origin === "subagent" && cNoSeed.header.seedLength === void 0);
  const cFold = foldUsage(cNoSeed.events, { snapshot: snap, startIndex: 0 });
  check("no-seed child folds every event",
    cFold.totals.uncachedInputTokens === 100 && cFold.totals.outputTokens === 700 &&
    Math.abs(cFold.costCny - 0.0099) < 1e-12, // 13:30 BJ → off-peak
    JSON.stringify({ totals: cFold.totals, costCny: cFold.costCny }));
}

// ── fork/subagent tree: origin gate + nesting + parallel + cycles ─────────
{
  const byId = indexHeaders(
    Object.values(fixtures).map((s) => ({ id: s.header.id, header: s.header })),
    []
  );
  const desc = collectDescendantIds(byId, "session-root");
  check("subagent tree: only origin=subagent descendants",
    desc.length === 4 && desc.includes("session-subagent-a") &&
    desc.includes("session-subagent-b") && desc.includes("session-subagent-c") &&
    desc.includes("session-grandchild") &&
    !desc.includes("session-fork"),
    JSON.stringify(desc));
  check("ordinary fork never enters the parent's tree",
    !desc.includes("session-fork"));
  // self-cycle A→B→A: root A must not be re-added
  const cycleById = {
    A: { parentId: "B", origin: "subagent", seedLength: 0 },
    B: { parentId: "A", origin: "subagent", seedLength: 0 }
  };
  const cycleDesc = collectDescendantIds(cycleById, "A");
  check("self-cycle A→B→A terminates with B only (root never re-added)",
    JSON.stringify(cycleDesc) === JSON.stringify(["B"]), JSON.stringify(cycleDesc));
  // two-level nesting: grandchild's parent is subagent-a
  check("two-level nesting order", byId["session-grandchild"].parentId === "session-subagent-a");
}

// ── whole-tree snapshot via the production query path ─────────────────────
{
  const ctx = fakeCtx(Object.values(fixtures));
  const { queryTreeCost } = await import("../lib/index.js");
  const snap = await queryTreeCost(ctx, null, "session-root", undefined);
  check("tree snapshot found", snap.found === true);
  check("tree merged usage golden",
    snap.merged.uncachedInputTokens === 3310 && snap.merged.cacheReadTokens === 5000 &&
    snap.merged.cacheWriteTokens === 500 && snap.merged.outputTokens === 10200 &&
    snap.merged.reasoningTokens === 4000,
    JSON.stringify(snap.merged));
  check("tree merged cost golden",
    Math.abs(snap.costCny - 0.217945) < 1e-12,
    "costCny=" + snap.costCny);
  check("tree root/descendants split adds up",
    Math.abs(snap.costCny - (snap.root.costCny + snap.descendants.costCny)) < 1e-12 &&
    snap.root.costCny > 0 && snap.descendants.costCny > 0,
    JSON.stringify({ root: snap.root.costCny, desc: snap.descendants.costCny }));
  check("tree per-model split (flash 0.0154 / pro 0.202545)",
    Math.abs(snap.models.find((m) => m.model === "deepseek-v4-flash").costCny - 0.0154) < 1e-12 &&
    Math.abs(snap.models.find((m) => m.model === "deepseek-v4-pro").costCny - 0.202545) < 1e-12,
    JSON.stringify(snap.models));
  check("tree accounting flags",
    snap.descendantCount === 4 && snap.unpricedSteps === 0 && snap.invalidSteps === 0 &&
    snap.foldedSessionCount === 5 && snap.failedSessionCount === 0 && snap.partial === false &&
    snap.persistenceAvailable === false,
    JSON.stringify({ d: snap.descendantCount, u: snap.unpricedSteps, i: snap.invalidSteps, f: snap.foldedSessionCount }));
  check("tree snapshot carries pricingVersion + queriedAt + eventRevision",
    typeof snap.pricingVersion === "number" && typeof snap.queriedAt === "string" &&
    typeof snap.eventRevision === "number" && snap.eventRevision > 0,
    JSON.stringify({ v: snap.pricingVersion, q: snap.queriedAt, r: snap.eventRevision }));
  // querying the CHILD itself excludes its seed and includes its own subtree
  const childSnap = await queryTreeCost(ctx, null, "session-subagent-a", undefined);
  check("querying the child excludes its seed",
    childSnap.root.usage.outputTokens === 1000 && childSnap.descendantCount === 1 &&
    Math.abs(childSnap.costCny - 0.016095) < 1e-12,
    JSON.stringify({ root: childSnap.root.usage, d: childSnap.descendantCount, cost: childSnap.costCny }));
  const forkSnap = await queryTreeCost(ctx, null, "session-fork", undefined);
  check("querying an ordinary fork excludes its seed, no descendants",
    forkSnap.root.usage.outputTokens === 300 && forkSnap.descendantCount === 0 &&
    Math.abs(forkSnap.costCny - 0.003) < 1e-12,
    JSON.stringify({ root: forkSnap.root.usage, cost: forkSnap.costCny }));
}

// ── partial persistence accounting ─────────────────────────────────────────
{
  const list = Object.values(fixtures);
  const badInspect = {
    inspect: async () => { throw new Error("io broken"); },
    list: async () => list.map((s) => s.header)
  };
  // root lives in the fake ctx's live store; child reads go through
  // persistence and fail → partial with failedSessionIds, root still exact.
  const ctx = fakeCtx(Object.values(fixtures), new Set(["session-root"]));
  const { queryTreeCost } = await import("../lib/index.js");
  const snap = await queryTreeCost(ctx, badInspect, "session-root", undefined);
  check("child read failures → partial + failedSessionCount/Ids",
    snap.partial === true && snap.failedSessionCount === 4 &&
    snap.failedSessionIds.length === 4 && snap.persistenceAvailable === true &&
    Math.abs(snap.costCny - snap.root.costCny) < 1e-12 &&
    snap.root.usage.outputTokens === 6000,
    JSON.stringify({ partial: snap.partial, failed: snap.failedSessionIds, root: snap.root.usage.outputTokens }));
  // root read failure (not live, not readable) → rootReadFailed (route → stale/error)
  const emptyCtx = { sessions: { list: () => [], get: () => void 0 } };
  const snap2 = await queryTreeCost(emptyCtx, badInspect, "session-root", undefined);
  check("root read failure surfaces as rootReadFailed",
    snap2.rootReadFailed === true, JSON.stringify(snap2));
}

// ── price table ledger: versioned tables by effectiveAt ────────────────────
{
  const t0 = 1000;
  const cheap = { ...BUILTIN(), "deepseek-v4-flash": { ...BUILTIN()["deepseek-v4-flash"], out: 1.0, outPeak: 2.0 } };
  const snap = {
    tables: BUILTIN(),
    version: 2,
    ledger: [
      { effectiveAt: t0, version: 1, tables: cheap },
      { effectiveAt: 2000, version: 2, tables: BUILTIN() }
    ]
  };
  const at = (time) => foldUsage([
    { type: "assistant/message", time, data: { turn: 1, step: 1, usage: { inputTokens: 0, outputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0 }, message: { source: { model: "deepseek-v4-flash" } } } }
  ], { snapshot: snap });
  const before = at(500);   // before any ledger entry → current tables, approx
  const v1 = at(1500);      // cheap ledger entry
  const v2 = at(2500);      // current-version entry
  check("ledger: pre-ledger samples priced at current tables (approx)",
    Math.abs(before.costCny - 1000 * 4.5 / 1e6) < 1e-12 && before.approxSteps === 1,
    JSON.stringify({ cost: before.costCny, approx: before.approxSteps }));
  check("ledger: version-1 table prices its window",
    Math.abs(v1.costCny - 1000 * 1.0 / 1e6) < 1e-12 && v1.approxSteps === 0,
    JSON.stringify({ cost: v1.costCny, approx: v1.approxSteps }));
  check("ledger: version-2 table prices its window",
    Math.abs(v2.costCny - 1000 * 4.5 / 1e6) < 1e-12 && v2.approxSteps === 0,
    JSON.stringify({ cost: v2.costCny, approx: v2.approxSteps }));
  const tf = tablesForTime(snap, 1500);
  check("tablesForTime picks the latest effective entry",
    tf.version === 1 && tf.approx === false, JSON.stringify(tf));
}

// ── all-unknown: tokens total, cost exactly ¥0 (legal zero) ────────────────
{
  const f = foldUsage([
    { type: "assistant/message", time: OFF, data: { turn: 1, step: 1, usage: { inputTokens: 1000, outputTokens: 1000, cacheReadTokens: 1000, cacheWriteTokens: 0 }, message: { source: { model: "mystery-model" } } } },
    { type: "assistant/message", time: OFF, data: { turn: 1, step: 2, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, message: { source: { model: "deepseek-v4-flash" } } } }
  ], { snapshot: { tables: BUILTIN(), version: 0, ledger: [] } });
  check("unknown tokens total but price at 0 (legal zero, not absence)",
    f.totals.outputTokens === 1000 && f.costCny === 0 && f.unpricedSteps === 1 &&
    f.byModel.get("unknown") !== void 0 && f.byModel.get("unknown").costCny === 0,
    JSON.stringify({ totals: f.totals, cost: f.costCny, unpriced: f.unpricedSteps }));
}

// ── today/month fold: midnight rollover + seed exclusion per session ───────
{
  const ctx = fakeCtx(Object.values(fixtures));
  const { queryToday } = await import("../lib/index.js");
  // freeze "now": 2026-08-18 15:00 Beijing = 07:00 UTC
  const RealDateNow = Date.now;
  Date.now = () => Date.UTC(2026, 7, 18, 7, 0);
  try {
    const today = await queryToday(ctx, null, undefined);
    // today since 2026-08-18 00:00 Beijing = 2026-08-17 16:00 UTC (1786982400000)
    // own samples inside the day:
    //   root t1 12:00 BJ off 0.0061 · root t2 15:00 BJ peak 0.1584 ·
    //   subagent-a 15:01 BJ peak 0.0093 · subagent-b 12:56 BJ off 0.02745 ·
    //   grandchild 13:55 BJ off 0.006795 · fork 14:06 BJ peak 0.003 ·
    //   subagent-c (no seed) 13:30 BJ off 0.0099
    const expected = 0.0061 + 0.1584 + 0.0093 + 0.02745 + 0.006795 + 0.003 + 0.0099;
    check("today fold covers only today's own events (seeds excluded)",
      Math.abs(today.costCny - expected) < 1e-9 && today.sessionCount === 6,
      "costCny=" + today.costCny + " expected " + expected);
    check("today accounting flags",
      today.unpricedSteps === 0 && today.invalidSteps === 0 && today.partial === false &&
      today.failedSessionCount === 0 && typeof today.pricingVersion === "number" &&
      today.date === "2026-08-18",
      JSON.stringify(today));
    check("month fold ≥ day fold", today.monthCostCny >= today.costCny, JSON.stringify({ d: today.costCny, m: today.monthCostCny }));
  } finally {
    Date.now = RealDateNow;
  }
}

// ── pricing parser ─────────────────────────────────────────────────────────
{
  const SAMPLE_HTML = `<article><h1>模型 &amp; 价格</h1><p>deepseek-v4-flash deepseek-v4-pro</p><table>
<tbody>
<tr><th>百万tokens输入（缓存命中）</th><td>空闲时段 0.05元 0.15元</td><td>高峰时段 0.10元 0.30元</td></tr>
<tr><th>百万tokens输入（缓存未命中）</th><td>空闲时段 1.5元 4.5元</td><td>高峰时段 3.0元 9.0元</td></tr>
<tr><th>百万tokens输出</th><td>空闲时段 4.5元 13.5元</td><td>高峰时段 9.0元 27.0元</td></tr>
</tbody></table></article>`;
  const parsed = parsePricingHtml(SAMPLE_HTML);
  check("parser extracts the twelve official numbers",
    parsed !== null &&
    parsed["deepseek-v4-flash"].miss === 1.5 && parsed["deepseek-v4-flash"].read === 0.05 && parsed["deepseek-v4-flash"].out === 4.5 &&
    parsed["deepseek-v4-flash"].missPeak === 3.0 && parsed["deepseek-v4-flash"].readPeak === 0.1 && parsed["deepseek-v4-flash"].outPeak === 9.0 &&
    parsed["deepseek-v4-pro"].miss === 4.5 && parsed["deepseek-v4-pro"].read === 0.15 && parsed["deepseek-v4-pro"].out === 13.5 &&
    parsed["deepseek-v4-pro"].missPeak === 9.0 && parsed["deepseek-v4-pro"].readPeak === 0.3 && parsed["deepseek-v4-pro"].outPeak === 27.0,
    JSON.stringify(parsed));
  check("parser rejects garbage html", parsePricingHtml("<html>no prices here</html>") === null);
  check("parser rejects missing model names", parsePricingHtml(SAMPLE_HTML.replace("deepseek-v4-flash", "other-model")) === null);
  check("parser rejects invalid numbers (miss < read)", parsePricingHtml(SAMPLE_HTML.replace("1.5元", "0.01元")) === null);
  check("parser rejects non-doubling peak", parsePricingHtml(SAMPLE_HTML.replace("9.0元 27.0元", "9.5元 27.0元")) === null);
}

// ── foldLive timing on the fixtures ────────────────────────────────────────
{
  const rootLive = foldLive(fixtures["session-root"].events);
  check("foldLive root golden (2 turns, 2 steps, 20s LLM, decode 6000)",
    rootLive.completed.turns === 2 && rootLive.completed.steps === 2 &&
    rootLive.completed.llmMs === 20000 && rootLive.completed.decodeTokens === 0 &&
    rootLive.openStepStart === null && rootLive.pendingMin === null,
    JSON.stringify(rootLive));
  const liveOpen = foldLive([
    { type: "step/start", time: 1000, data: { turn: 1, step: 1 } },
    { type: "tool/call", time: 3000, data: { callId: "c1" } }
  ]);
  check("foldLive open step + pending tool", liveOpen.openStepStart === 1000 && liveOpen.pendingMin === 3000, JSON.stringify(liveOpen));
  const liveClosed = foldLive([
    { type: "step/start", time: 1000, data: { turn: 1, step: 1 } },
    { type: "assistant/chunk", time: 2000, data: { turn: 1, step: 1, chunk: { type: "text-delta", text: "hi" } } },
    { type: "assistant/message", time: 5000, data: { turn: 1, step: 1, usage: { outputTokens: 10 } } },
    { type: "tool/call", time: 6000, data: { callId: "c1" } },
    { type: "tool/result", time: 8000, data: { message: { source: { callId: "c1" } } } },
    { type: "step/end", time: 8000, data: { turn: 1, step: 1 } }
  ]);
  check("foldLive closed totals (llm 4s + tool 2s, 1 step, decode 10)",
    liveClosed.openStepStart === null && liveClosed.pendingMin === null &&
    liveClosed.toolPhaseStart === null &&
    liveClosed.completed.llmMs === 4000 && liveClosed.completed.toolMs === 2000 &&
    liveClosed.completed.steps === 1 && liveClosed.completed.decodeTokens === 10 &&
    liveClosed.completed.decodeMs === 3000 && liveClosed.completed.ttftMs === 1000,
    JSON.stringify(liveClosed));
  // strict time validation: malformed event times are skipped, never NaN
  const liveBad = foldLive([
    { type: "step/start", data: { turn: 1, step: 1 } }, // no time
    { type: "step/start", time: "bad", data: { turn: 1, step: 1 } }, // string time
    { type: "step/start", time: Infinity, data: { turn: 1, step: 1 } }, // Infinity
    { type: "step/start", time: -5, data: { turn: 1, step: 1 } }, // negative
    { type: "step/start", time: 1000, data: { turn: 1, step: 1 } },
    { type: "assistant/chunk", time: 2000, data: { turn: 1, step: 1, chunk: { type: "text-delta", text: "hi" } } },
    { type: "assistant/message", time: 5000, data: { turn: 1, step: 1, usage: { outputTokens: 10 } } },
    { type: "step/end", time: 5000, data: { turn: 1, step: 1 } }
  ]);
  check("foldLive skips malformed times (finite totals, no NaN)",
    liveBad.completed.steps === 1 && liveBad.completed.llmMs === 4000 &&
    liveBad.completed.decodeMs === 3000 && liveBad.completed.decodeTokens === 10 &&
    Object.values(liveBad.completed).every((v) => Number.isFinite(v)),
    JSON.stringify(liveBad));
}

// ── helper factories ───────────────────────────────────────────────────────
function BUILTIN() {
  return {
    "deepseek-v4-flash": { miss: 1.5, read: 0.05, out: 4.5, missPeak: 3.0, readPeak: 0.1, outPeak: 9.0 },
    "deepseek-v4-pro": { miss: 4.5, read: 0.15, out: 13.5, missPeak: 9.0, readPeak: 0.3, outPeak: 27.0 }
  };
}
function fakeCtx(records, liveIds) {
  const byId = {};
  for (const r of records) {
    if (liveIds === void 0 || liveIds.has(r.header.id)) byId[r.header.id] = { events: r.events, header: r.header };
  }
  return {
    sessions: {
      list: () => records.map((r) => ({ id: r.header.id, header: r.header })),
      get: (id) => byId[id]
    }
  };
}

console.log(failures === 0 ? "\nALL HOST-FOLD CHECKS PASSED" : "\n" + failures + " CHECK(S) FAILED");
process.exit(failures === 0 ? 0 : 1);
