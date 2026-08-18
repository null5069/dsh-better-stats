# dsh-better-stats

A richer stats strip for the DeepSeek Harness (DSH) Web UI, sitting right below the composer: official CNY pricing (peak/off-peak tiers, auto-synced from the official pricing page), per-model accounting, live timers, subagent-tree merging, direct account balance, budget alerts, and streaming cost estimation.

```
DeepSeek Official | Balance ¥8.67 | Turn ¥0.1676 · Session ¥29.49 | 20 turns · 345 steps | LLM 1h 12m · Tool 5m 6s | TTFT avg 3.88s · 111.72tok/s | Cache 103.98M · hit 98.64% | In 1.44M · Out 336.53K
```

## Features

- **Balance**: host queries `api.deepseek.com/user/balance` directly (the `DEEPSEEK_API_KEY` credential goes through the DSH credentials seam, never the browser), 15s cache. The hover popover shows the **granted / topped-up split** (degrades to the total when fields are missing), a **days-left estimate** (EWMA-smoothed from today's spend and the trailing daily history), and a **recharge link** on critical balance. **Click the balance group** to force a fresh query (2s anti-flood cooldown on the host).
- **Pricing**: official CNY price table ([api-docs.deepseek.com/zh-cn/quick_start/pricing](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)), re-synced by the host every 6h with a builtin fallback; the popover shows a "Prices" row with the source and fetch time (e.g. `DeepSeek Official 2026-08-18 14:16`). **Peak/off-peak tiers** (peak = Beijing 09:00–12:00 / 14:00–18:00, ×2 price) apply per event timestamp; the strip shows the current tier and the popover the next switch with a countdown.
- **Per-model accounting**: each message is priced with the model that produced it (`deepseek-v4-flash` / `deepseek-v4-pro` each use their own table). **Unknown models are explicit**: their tokens still total up but price at 0, the session amount gets an `≈` prefix, and the popover notes the unpriced step count instead of silently pricing at a default.
- **Cache buckets**: uncached input, cache-read and cache-write are billed separately (cache-read at the much lower hit price), and the cache-hit rate is shown.
- **Turn (本轮)**: the current turn is settled from the settled steps' event-level fold (each step priced at its own event time/model; `reasoningTokens` billed at the output rate), plus a **streaming character-level estimate** for the in-flight step (densities self-calibrate via EMA from settled steps; priced at the current tier). The number grows continuously within the turn, keeps its final value after the turn ends, and resets only when the next turn starts.
- **Session**: host-side per-second settlement of the whole tree, **including all descendant subagent sessions** (persisted older sessions too), ticking live (exact settled cost + the in-flight estimate). The popover shows the per-model breakdown and sub-session count.
- **Budget alerts (optional, off by default)**: `config: { dailyBudgetCny: 20, monthlyBudgetCny: 100 }` — the spend group turns amber past 80% and red with ⚠ over budget; the popover shows `Today ¥x · daily budget ¥20 (85%)` / `Month ¥y · monthly budget ¥100 (30%)` (Asia/Shanghai midnight/month rollover).
- **Balance alerts (two tiers, default warn ≤¥20 amber / critical ≤¥5 red)**: the balance group changes color with ⚠ and the popover explains; `config: { balanceWarnCny, balanceCriticalCny }` adjusts the thresholds, `0` disables a tier.
- **Live timers**: LLM/tool durations tick every second while a step runs (tool phase starts at the model's tool-call decision message; the host folds the full log); TTFT average and decode tok/s are shown when data exists.
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
