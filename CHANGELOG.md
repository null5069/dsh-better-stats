# Changelog

## 0.1.10 (unreleased — prepared, not yet published)

- **rate settle drift fix**: the live decode window switched from the wall
  clock (`Date.now() − firstTokenTime`) to the **push-domain span**
  (`lastTokWall − firstTokWall`, the arrival times of the step's first/last
  token events). The constant push latency cancels between the two anchors,
  so the window matches the settle's server-domain `decodeMs` — no more
  gradual drift down during a step (140 → 135/130) followed by a jump back
  to the real average at the settle. Server-time fallback
  (`lastTokEvt − firstTokenTime`) covers steps whose events carry no wall
  anchor. Real-session replay: settle jump median 0.00%, p90 0.06%, no
  >+3% cases. Tests updated (Scenario 31/32 assert the server-time window).
- **fresh-chat placeholder strip**: every group renders from the start —
  an empty session shows 轮次/耗时/速率/缓存/花费/Tok with legal zeros or
  dashes (`0 轮 · 0 步`, `LLM - · 工具 -`, `--`, `缓存 0 · 命中 0.00%`,
  `输入 0 · 输出 0`, `本轮 ¥0.0000 · 会话 ¥0.0000`) instead of waiting for
  data to appear; the turns/time/speed groups are gated on the projection
  only (dash placeholders when it is missing entirely), the spend group
  shows a dash pair without a usage projection, and the cache hit of an
  empty session is a legal 0.00% (no more hidden groups on a new chat).

## 0.1.9 (2026-08-21)

Accounting correctness (P1) — the release gate:

- **output/reasoning contract**: `outputTokens` already includes
  `reasoningTokens`; reasoning is a display-only subset. Cost bills
  `outputTokens * outPrice` only, and the settled tok/s numerator is
  `sum(outputTokens) / sum(decodeMs)`. The estimate synthesizes reasoning +
  visible into ONE total-output estimate × estAccuracy — the same value feeds
  金额, Tok and 速率. Test fixtures with `reasoning > output` were removed.
- **fork/subagent seed**: headers are indexed as `{parentId, origin,
  seedLength}`; only `origin === "subagent"` enters a parent's tree; every
  session folds only the events after its own `seedLength` (incl. `/today` and
  month folds, and querying the child/fork itself). Self-cycles (A→B→A) can no
  longer re-add the root.
- **whole-tree snapshot**: `/cost` returns root + descendants separately with
  merged usage/cost/models/unpriced/invalid/partial, `descendantCount`,
  `pricingVersion`, `queriedAt`, `eventRevision`. The client shows
  "live root + latest descendants" — the `max(treeCost, rootLiveCost)`
  guessing is gone, and `/live` root figures never override the tree's model
  breakdown.
- **unknown + exact zeros**: a legal `costCny: 0` is a real answer (absence is
  null/undefined); the initial model is `unknown` (never flash); unknown
  tokens total and display as 未计价; partial/stale snapshots mark the amount
  (`过期/部分`); model shares are priced-cost shares and token-share
  denominators include unknown.
- **session switching + balance contract**: the strip is a `key={sessionId}`
  subcomponent (full state rebuild on switch); balance responses share one
  schema with `status: ok|stale|error`; singleflight on balance/cost/today/
  pricing.

Completeness (P2):

- persistence `list`/`inspect` failures surface as `partial` +
  `failedSessionCount/Ids` + `persistenceAvailable` + `foldedSessionCount`;
  a root read failure triggers stale/error instead of a partial answer.
- immutable per-request pricing snapshot + versioned ledger
  (`{effectiveAt, version, tables}`); caches keyed by `pricingVersion`;
  `/today` cache key includes the Beijing date, month and pricingVersion;
  pre-ledger samples are priced at current tables and counted approximate.
- strict validation (finite/non-negative/integer tokens, reasoning ≤ output,
  turn/step/time) — invalid samples count into `invalidSteps`, never clamped.
- removed the unused USD/CNY third-party rate requests; pricing fetch retries
  back off (5 min) after failures.

Estimation & presentation (P3):

- batch chunks vs sampled deltas are deduped (batch wins per step).
- the estAccuracy-corrected estimate feeds 金额 and Tok alike; the estimate
  uses (in priority order) the CURRENT step's own measured density
  (stepLocalAcc, set at its usage chunk), the PREVIOUS step's measured ratio
  (prevStepAcc — consecutive steps share density), then the global EMA — so
  the streaming value lands on the same number at the settle.
  **本轮 tok/s = settled cumulative rate + the in-flight step's live share**:
  dynamic (ticks with the stream), but the open step only enters the blend
  after a 2s maturity window (the first moments of a step are an
  instantaneous burst that used to spike turn starts to 200-270 tok/s), and
  the step-local density makes the settle land on the displayed value
  (verified on the real session: 115.71 → 115.71, 114.91 → 114.91 at
  settles — no more 117↔170 or 140→125 snaps); the next-step input estimate
  prices with the parent turn's guarded lastModel.
- **本轮 tok/s 重做 — 按 API 官方口径**（最终版，替代上述成熟窗口方案）：
  the stream chunk events (`reasoning-chunks`/`text-chunks`/`tool-call-chunks`)
  carry per-token text fragments (`texts[]`/`args[]`) — measured ≈99% of
  `usage.outputTokens` on real logs (big steps 1.005-1.017), plus per-token
  `dt` deltas. The live rate is now `(settled outputTokens + fragments ×
  segFactor) / (settled decodeMs + wall clock since first token)`: **live
  from the first token (no maturity gate)**, segFactor starts at 1.01 and is
  re-calibrated by LARGE steps only (short steps' fragments are merged by
  the assembler, factors up to 2.2 are noise), and the usage chunk (≈3ms
  before the message) folds the step's real tokens into the settled totals,
  so the settle lands on the displayed value — real-log replay: median
  settle jump 0.01%, p90 0.00%, worst big steps 78.0→78.0/83.7→83.7.
- ETA re-derives from the latest balance (7/30-day workspace windows feed the
  rate internally); the balance row shows only the duration —
  `(约可用 3 天 5 小时)`.
- the 100ms ticker only bumps while the session runs AND a live edge exists
  (open step / in-flight tool) AND the page is visible; the event fold is
  cursor-gated and layout measurement runs on signature/size changes only.
- stable group ids with width caches invalidated by id+text+font; narrow
  popovers fall back to two/one columns with wrapping.
- full i18n (no Chinese leaks into the English popover); the balance refresh
  is a real `<button>`; popover supports click/focus/touch, Enter/Space,
  Escape, focus-visible, ARIA and prefers-reduced-motion.
- the 模型 group is the LAST popover group (below Tok), popover-only, with
  ONE short title row ("模型") and per model:
  `v4-pro | 花费 ¥x | (占比%)`, then 输入/输出 on their own rows
  (`输入 x | (占比%)`, `输出 y | (占比%)`) — consistent with the cost row
  (value in col 3, share in col 4). Tok keeps only the turn/session rows.

Tests & packaging (P4):

- sanitized JSONL fixtures in `test/fixtures` (no `/tmp` private logs in the
  default suite); every core assertion calls the production exports.
- zh-CN and en-US suites both run EXPLICITLY (the client suite pins
  navigator.language at load — machine-locale independent — plus a dedicated
  en-US suite asserting zero CJK); `test/reconcile-live.mjs` re-derives a real
  log with an independent oracle.
- golden tests: reasoning subset, seedLength (child with AND without a seed),
  multi-level subagents, ordinary fork, parallel children, all-unknown ¥0,
  session switch, root+child live merge, partial persistence, price-table
  switch, midnight rollover, negative/Infinity, concurrent balance requests.
- `npm test`, engines, CI, LICENSE, CHANGELOG, prepublishOnly; packaged files
  are 0644.

## 0.1.8

- 100ms heartbeat ticker, 1-decimal popover seconds, lockstep turn/session
  durations, banked turn tool time, cumulative turn tok/s (settled real output
  + reasoning tokens over real decode time), estAccuracy self-calibration
  persisted to localStorage, no settle dip (usage chunks no longer reset the
  char counters), shared per-model share denominators, curTurn guard against
  spliced subagent attribution, host foldLive/foldUsage reasoning-aware rate
  numerator, per-turn model attribution for in-flight usage chunks.

## 0.1.7

- i18n (zh/en), balance force-refresh + days-left ETA + recharge link,
  bilingual README.

## 0.1.6

- Official CNY price tables with peak/off-peak tiers, per-model settlement,
  balance proxy, tree-merged subagent cost, budget/balance alerts, popover.
