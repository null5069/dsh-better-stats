# dsh-better-stats

A richer stats strip for the DeepSeek Harness (DSH) Web UI, sitting right below the composer: official CNY pricing (peak/off-peak tiers, auto-synced from the official pricing page), per-model accounting, live timers, subagent-tree merging, direct account balance, budget alerts, and streaming cost estimation.

```
DeepSeek Official | Balance ¥8.67 | Turn ¥0.1676 · Session ¥29.49 | 20 turns · 345 steps | LLM 1h 12m · Tool 5m 6s | TTFT avg 3.88s · 111.72tok/s | Cache 103.98M · hit 98.64% | In 1.44M · Out 336.53K
```

## Features

- **Balance**: host queries `api.deepseek.com/user/balance` directly (the `DEEPSEEK_API_KEY` credential goes through the DSH credentials seam, never the browser), 15s cache; **click the balance group to force a fresh query** (after switching models/API the balance would otherwise only update on the next poll; the host has a 2s anti-flood cooldown). The hover popover shows the **granted / topped-up split** (degrades to the total when fields are missing), a **days-left estimate** (EWMA-smoothed from today's spend and the trailing daily history), and a **recharge link** from the warn tier down.
- **Pricing**: official CNY price table ([api-docs.deepseek.com/zh-cn/quick_start/pricing](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)), re-synced by the host every 6h with a builtin fallback; the popover shows a "Prices" row with the source and fetch time (e.g. `DeepSeek Official 2026-08-18 14:16`). **Peak/off-peak tiers** (peak = Beijing 09:00–12:00 / 14:00–18:00, ×2 price) apply per event timestamp; the strip shows the current tier and the popover the next switch with a countdown.
- **Per-model accounting**: each message is priced with the model that produced it (`deepseek-v4-flash` / `deepseek-v4-pro` each use their own table). **Unknown models are explicit**: their tokens still total up but price at 0, the popover's 模型 group shows `Unpriced`, and the spend row notes the unpriced step count instead of silently pricing at a default.
- **Cache buckets**: uncached input, cache-read and cache-write are billed separately (cache-read at the much lower hit price), and the cache-hit rate is shown.
- **Turn (本轮)**: the current turn is settled from the settled steps' event-level fold (each step priced at its own event time/model), plus a **streaming character-level estimate** for the in-flight step (densities self-calibrate via EMA from settled steps; priced at the current tier). The estimate × estAccuracy is ONE corrected value driving the amount, the Tok figures and the rate alike. The number grows continuously within the turn, keeps its final value after the turn ends, and resets only when the next turn starts.
- **Session**: host-side per-second settlement of the whole tree, **including all descendant subagent sessions** (only `origin: subagent` children enter a parent's tree; ordinary forks stay their own roots; every session folds only the events after its own `seedLength` — the day/month aggregates exclude inherited seeds too), ticking live as "live root + latest descendants" (no max() guessing). The popover shows the per-model breakdown and sub-session count.
- **Accounting contract**: `outputTokens` already includes `reasoningTokens` — reasoning is a display-only subset used for detail stats only, never billed twice, and the settled tok/s numerator is `sum(outputTokens)`; invalid samples count as invalid steps instead of being clamped. The initial model is `unknown` (never flash): unknown tokens still total and show as Unpriced; a legal `costCny: 0` is a real answer (absence is null/undefined); partial/stale snapshots mark the amount (`stale`/`partial`); model shares are priced-cost shares and token-share denominators include unknown. Prices come from a versioned ledger (`effectiveAt`); one immutable pricing snapshot serves the whole tree per request and caches are keyed by pricingVersion.
- **Budget alerts (optional, off by default)**: `config: { dailyBudgetCny: 20, monthlyBudgetCny: 100 }` — the spend group turns amber past 80% and red with ⚠ over budget; the popover shows `Today ¥x · daily budget ¥20 (85%)` / `Month ¥y · monthly budget ¥100 (30%)` (Asia/Shanghai midnight/month rollover).
- **Balance alerts (two tiers, default warn ≤¥20 amber / critical ≤¥5 red)**: the balance group changes color with ⚠ and the popover explains; `config: { balanceWarnCny, balanceCriticalCny }` adjusts the thresholds, `0` disables a tier.
- **Live timers**: LLM/tool durations tick every second while a step runs (tool phase starts at the model's tool-call decision message; the host folds the full log); TTFT average and decode tok/s are shown when data exists. The turn's tok/s follows the API's own throughput accounting: settled `outputTokens` plus the open step's per-token stream fragments (the `texts`/`args` arrays of the `*-chunks` events — measured ≈99% of the real token count on real logs) × a fragment factor (starts at 1.01, re-calibrated by large settled steps only), over settled `decodeMs` plus the open step's **push-domain decode window** (last token event's arrival − first token event's arrival — the constant push latency cancels between the two anchors, so the window matches the settle's server-domain `decodeMs` and there is no empty tail while a batch is in flight) — **live from the first token, no maturity gate**; the usage chunk (≈3ms before the message) folds the step's real tokens in, so the settle lands on the displayed value (median settle jump 0.00% on the real-session replay, no more 117↔170 snaps or 140→130→140 drift).
- **Fresh-chat placeholder strip**: a new window/chat renders the full set of groups from the very first frame — empty values show as legal zeros or dashes (`0 turns · 0 steps`, `LLM - · Tool -`, `--`, `Cache 0 · hit 0.00%`, `In 0 · Out 0`, `Turn ¥0.0000 · Session ¥0.0000`) and are replaced in place once data arrives.
- **Live popover**: every derivable figure in the hover panel (turn/session amounts, the Tok group and its per-model rows, durations, cache, turn/step counts) ticks in real time — event-stream folds plus a 100ms heartbeat while the session runs. **Per-model shares and the session row use one shared denominator** (never above 100%); **spliced subagent transcripts never hijack the parent turn's model attribution** (estimates and usage chunks stay on the parent's own model); a turn shows step 1 as soon as it opens; 本轮 rows stay visible after a termination.
- **Layout**: the strip matches the composer width, wraps to at most two rows, drops orphaned separators at row boundaries, and truncates overflowing content into a trailing `⋯` (measured from cached natural widths — no flicker, no feedback loop).
- **i18n**: UI strings follow the browser language (中文 / English).
- **Precision rule**: computed amounts (turn/session/today) use 4 decimals, external amounts (balance) use the provider's own precision, configured amounts (budgets/alert thresholds) use 2, and the popover keeps 6-decimal detail.

## Install

### Option 1: npm (one command)

```sh
cd ~/.dsh/profiles/web
pnpm add dsh-better-stats
```

then register the package as a bundle (add `dsh-better-stats` to the `dsh.profile.bundles` array in the profile `package.json`), restart `dsh web` and hard-refresh the browser. The bundled `cordis.patch.yml` mounts the plugin row automatically — no manual YAML editing.

Defaults: two-tier balance alerts (warn ¥20 / critical ¥5), no daily/monthly budget. To customize, set any of `balanceWarnCny` / `balanceCriticalCny` (0 disables a tier), `dailyBudgetCny` / `monthlyBudgetCny` (presence enables) in the plugin's `config`.

### Option 2: GitHub clone

```sh
git clone https://github.com/null5069/dsh-better-stats.git
cd dsh-better-stats        # no runtime dependencies — no npm install needed
```

symlink the directory into the profile (`ln -s "$PWD" ~/.dsh/profiles/web/node_modules/dsh-better-stats`), add `"dsh-better-stats": "link:/absolute/path/dsh-better-stats"` to the profile `package.json` dependencies, then follow the bundle-registration + restart steps above.

## Architecture

| Half | File | What it does |
|---|---|---|
| Host | `lib/index.js` | Routes `/plugins/better-stats/balance` (balance + split, 15s cache, `?force=1` bypass with 2s cooldown), `/cost` (whole-tree usage + per-model CNY settlement, 10s cache), `/live` (live timing + per-second cost + pricing/budget payload), `/today` (Asia/Shanghai day/month workspace totals, 60s cache); official pricing page sync every 6h with builtin fallback |
| Client | `lib/client.js` | `conversation.composer.dock` strip; turn fold + streaming estimate; 1s `/live` polling; budget/peak countdown popover; two-row truncation with `⋯`; i18n (zh/en) |
| Tests | `test/` | Zero-dependency Node suites: `node test/client-regression.test.mjs`, `node test/host-apply.test.mjs`, `node test/host-fold.test.mjs` |

Every route response carries `pricing: { source: "official"|"builtin"|"stale", fetchedAt, tables }` and an optional `budget`, so the client never hard-codes price numbers.

## Known boundaries

- The balance is the **whole DeepSeek account** (web chat, other programs and other machines sharing the key all deduct from it); stats cover only this workspace, and the balance endpoint itself has settlement lag — compare with long-window endpoints.
- Peak/off-peak is priced per event timestamp; after an official price change the host follows within 6h, and the popover shows the price source meanwhile.
- Live tool timing starts at the model's tool-call decision message (`tool/call` events only land in the log after the tool finishes); the value merges into the exact totals on completion.
- The streaming estimate is a display-level heuristic: starting densities (reasoning ≈3.5, final text + tool JSON ≈2.5 non-CJK chars/token, CJK ≈1 char/token) are EMA-calibrated per settled step and are always replaced by the exact figure once the step's usage chunk lands. Estimates price at the current tier's output rate.

## License

MIT
