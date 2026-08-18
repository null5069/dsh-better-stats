// dsh-better-stats — client half (v20): ONE complete stats strip merging the
// shipped row's figures with the balance/cost ledger, hiding the shipped row
// via CSS:
//
//   DeepSeek 官方 | 余额 ¥48.8600 | 本轮 ¥0.0081 · 会话 ¥0.2362 |
//   3 轮 · 12 步 | LLM 45.2s · 工具 12.3s | 首token 1.4s · 25.4tok/s |
//   输入 12.2K · 缓存 10.6K · 87.00% · 输出 517
//
// v20 changes (P0/P1 batch):
//  - price tables come from the host (`pricing` payload on every route, 6h
//    official sync with builtin fallback); the client never hard-codes the
//    numbers, and the 花费 popover shows the price source;
//  - unknown models are EXPLICIT: `unpricedSteps` marks the session amount
//    with ≈ and a popover note (含 N 步未定价) instead of silently pricing
//    at the flash rate;
//  - optional daily/monthly budget (host config): 花费 group turns amber at
//    80% / red with ⚠ over budget, hover shows 今日/本月 totals from the
//    /today route (Asia/Shanghai midnight rollover);
//  - balance hover shows the granted/topped-up split, plus the peak/off-peak
//    countdown (next switch in Beijing time);
//  - while a step is streaming, 本轮 shows a chars/4 estimate marked (估),
//    removed automatically once the usage chunk lands (estimates only affect
//    display, never the exact turn ledger).
//
// Hand-written in the lazy-CJS bundle protocol (window.__ModuleLoader__.load)
// — no build step, no imports from dsh client packages.
window.__ModuleLoader__.load({
  id: "dsh-better-stats",
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var react = require("react");

    // ── styles ──────────────────────────────────────────────────────────────
    var STYLES = [
      // Hide the shipped stats row (StatsLine.module.css root class).
      ".FJxK0a_root{display:none}",
      ".dsh-better-stats-line{position:relative;display:flex;flex-wrap:wrap;justify-content:center;align-items:flex-start;max-width:var(--dsh-composer-card-max-width);box-sizing:border-box;width:100%;padding:4px 16px 4px;color:var(--dsw-alias-label-tertiary);margin:0 auto;font-size:12px;line-height:20px;row-gap:2px;max-height:48px;overflow:hidden;font-variant-numeric:tabular-nums}",
      ".dsh-better-stats-ellipsis{color:var(--dsw-alias-label-tertiary)}",
      ".dsh-better-stats-item{white-space:nowrap}",
      ".dsh-better-stats-sep{color:var(--dsw-alias-separator-primary);margin:0 10px;white-space:nowrap}",
      ".dsh-better-stats-sep-probe{position:absolute;visibility:hidden;pointer-events:none;left:-10000px;top:0}",
      ".dsh-better-stats-pop{box-sizing:border-box;min-width:220px;max-width:calc(100vw - 32px);border:1px solid var(--dsw-alias-border-inverted);background:var(--dsw-specific-menu);box-shadow:var(--dsw-shadow-lv3);color:var(--dsw-alias-label-secondary);border-radius:12px;padding:10px 14px;font-size:12px;line-height:20px;text-align:left;z-index:100;font-variant-numeric:tabular-nums}",
      ".dsh-better-stats-pop-row{white-space:nowrap}",
      ".dsh-better-stats-pop-label{display:inline-block;min-width:56px;color:var(--dsw-alias-label-tertiary);margin-right:12px}",
      ".dsh-better-stats-pop b{color:var(--dsw-alias-label-primary);font-weight:600}",
      ".dsh-better-stats-refresh{cursor:pointer;border-radius:4px}",
      ".dsh-better-stats-refresh:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".dsh-better-stats-pop-link{color:var(--dsw-alias-brand-primary);text-decoration:none;font-weight:600}",
      ".dsh-better-stats-pop-link:hover{text-decoration:underline}"
    ];
    var STYLE_ID = "dsh-better-stats/styles.css";
    if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(STYLE_ID) + "]") === null) {
      var tag = document.createElement("style");
      tag.dataset.plugin = "dsh-better-stats";
      tag.dataset.pluginCss = STYLE_ID;
      tag.textContent = STYLES.join("\n");
      document.head.appendChild(tag);
    }

    // Official DeepSeek pricing, CNY per 1M tokens (provider bills in CNY —
    // same currency as the balance endpoint). Since v20 this table is only
    // the FALLBACK: the host re-syncs the official page every 6h and every
    // route response carries `pricing: { source, fetchedAt, tables }`; the
    // client prices with the host tables when present and shows the source
    // in the 花费 popover.
    //   https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
    //   deepseek-v4-flash: 输入缓存命中 ¥0.05/¥0.10 · 输入未命中 ¥1.5/¥3.0 ·
    //                      输出 ¥4.5/¥9.0
    //   deepseek-v4-pro:   输入缓存命中 ¥0.15/¥0.30 · 输入未命中 ¥4.5/¥9.0 ·
    //                      输出 ¥13.5/¥27.0  (exactly 3× flash)
    //   高峰(北京 9:00-12:00 / 14:00-18:00) 为两倍, 其余为空闲.
    // The host cost route prices each step at ITS OWN event time AND model;
    // the client-side fallback prices at the current time's tier and the
    // session's latest model.
    var PRICE_TABLES = {
      "deepseek-v4-flash": { miss: 1.5, read: 0.05, out: 4.5, missPeak: 3.0, readPeak: 0.1, outPeak: 9.0 },
      "deepseek-v4-pro": { miss: 4.5, read: 0.15, out: 13.5, missPeak: 9.0, readPeak: 0.3, outPeak: 27.0 }
    };
    var DEFAULT_MODEL = "deepseek-v4-flash";
    // Streaming-estimate calibration. The STARTING densities are measured
    // session averages (reasoning ≈3.5 non-CJK chars/token, final text +
    // tool JSON ≈2.5, CJK ≈1 char/token), but every settled step re-
    // calibrates them with an EMA of the step's REAL chars→tokens ratio
    // (calibrateEstDensity), so the estimate adapts to the actual content
    // mix instead of drifting high/low. Display-only — exact figures take
    // over the moment the step's usage chunk lands.
    var EST_DENSITY_REASON = 3.5;
    var EST_DENSITY_OUTPUT = 2.5;
    var EST_DENSITY_MIN = 0.8;
    var EST_DENSITY_MAX = 12;

    // EMA-update the per-kind densities from one settled step: the counters
    // hold that step's streamed chars (they reset right after), and usage
    // carries the billed tokens. Guarded against tiny/noisy steps.
    function calibrateEstDensity(est, reason, text, tool, usage) {
      if (usage === void 0 || usage === null || typeof usage !== "object") return;
      var reasonTok = Number(usage.reasoningTokens) || 0;
      var outTok = Number(usage.outputTokens) || 0;
      if (reasonTok > 0 && reason.rest > 8) {
        var rd = reason.rest / reasonTok;
        if (rd >= EST_DENSITY_MIN && rd <= EST_DENSITY_MAX) {
          est.reasonDensity = est.reasonDensity * 0.7 + rd * 0.3;
        }
      }
      if (outTok > 0) {
        var outRest = text.rest + tool.rest;
        if (outRest > 8) {
          var od = outRest / outTok;
          if (od >= EST_DENSITY_MIN && od <= EST_DENSITY_MAX) {
            est.outputDensity = est.outputDensity * 0.7 + od * 0.3;
          }
        }
      }
    }

    // Inline precision: 2 decimals, matching the balance's provider format
    // (DeepSeek returns 2) — 本轮/会话/预算 all align with the balance for
    // direct reconciliation. The popover keeps full 6-decimal detail.
    // Computed amounts (本轮/会话/今日) default to 4 decimals so they look
    // uniform and small increments stay visible; external/configured amounts
    // (balance at the provider's precision, budget/alert thresholds) use 2.
    var PRECISION = 4;
    var CONFIG_DECIMALS = 2;
    var CURRENCY_SYMBOLS = { CNY: "¥", USD: "$", EUR: "€", GBP: "£", JPY: "¥" };

    // ── i18n: UI strings follow the browser language (zh → English default).
    // The test harness runs without a navigator, so it falls back to zh and
    // every existing assertion keeps passing.
    var LANG = (function () {
      try {
        var navLang = typeof navigator !== "undefined" && navigator.language ? navigator.language : "";
        return String(navLang).toLowerCase().indexOf("zh") === 0 ? "zh" : "en";
      } catch (e) { return "zh"; }
    })();
    var I18N = {
      zh: {
        providerDeepSeek: "DeepSeek 官方",
        balance: "余额",
        balanceDash: "余额 --",
        balanceFailed: "余额查询失败",
        balanceAlertCritical: "余额告警：低于 {0}（红色）",
        balanceAlertWarn: "余额告警：低于 {0}（琥珀）",
        granted: "赠送",
        toppedUp: "充值",
        refreshHint: "点击余额可强刷",
        recharge: "充值 ↗",
        peakNow: "高峰中",
        offPeakNow: "空闲中",
        peakNowDetail: "高峰中（价格×2）",
        offPeakNowDetail: "空闲中",
        peakStart: "高峰 {0} 开始",
        offPeakStart: "空闲 {0} 开始",
        inMinutes: "（{0} 后）",
        turn: "本轮",
        session: "会话",
        exact: "精确",
        estimate: "估算",
        unpricedNote: "（含 {0} 步未定价 · 模型未知）",
        subSessions: "含 {0} 个子会话",
        turnsSteps: "{0} 轮 · {1} 步",
        tool: "工具",
        ttftAvg: "首token平均",
        cache: "缓存",
        hit: "命中",
        input: "输入",
        output: "输出",
        pricingBuiltin: "内置价目(可能过期)",
        pricingOfficialStale: "DeepSeek 官方价目(已过期)",
        pricingSource: "价源",
        today: "今日",
        dailyBudget: "日预算",
        month: "本月",
        monthlyBudget: "月预算",
        waiting: "better-stats: 等待数据…",
        etaDays: "约可用 {0} 天",
        etaHours: "约可用 {0} 小时"
      },
      en: {
        providerDeepSeek: "DeepSeek Official",
        balance: "Balance",
        balanceDash: "Balance --",
        balanceFailed: "Balance query failed",
        balanceAlertCritical: "Balance alert: below {0} (red)",
        balanceAlertWarn: "Balance alert: below {0} (amber)",
        granted: "Granted",
        toppedUp: "Top-up",
        refreshHint: "click balance to force refresh",
        recharge: "Recharge ↗",
        peakNow: "Peak",
        offPeakNow: "Off-peak",
        peakNowDetail: "Peak (price ×2)",
        offPeakNowDetail: "Off-peak",
        peakStart: "Peak starts {0}",
        offPeakStart: "Off-peak starts {0}",
        inMinutes: " (in {0})",
        turn: "Turn",
        session: "Session",
        exact: "exact",
        estimate: "estimate",
        unpricedNote: " ({0} steps unpriced · unknown model)",
        subSessions: " {0} sub-sessions",
        turnsSteps: "{0} turns · {1} steps",
        tool: "Tool",
        ttftAvg: "TTFT avg",
        cache: "Cache",
        hit: "hit",
        input: "In",
        output: "Out",
        pricingBuiltin: "Built-in prices (may be stale)",
        pricingOfficialStale: "DeepSeek official prices (stale)",
        pricingSource: "Prices",
        today: "Today",
        dailyBudget: "daily budget",
        month: "Month",
        monthlyBudget: "monthly budget",
        waiting: "better-stats: waiting for data…",
        etaDays: "≈ {0} days left",
        etaHours: "≈ {0} hours left"
      }
    };
    var L = I18N[LANG];
    function T(tpl) {
      // {0}/{1} placeholder substitution
      var args = Array.prototype.slice.call(arguments, 1);
      return String(tpl).replace(/\{(\d+)\}/g, function (m, i) {
        return args[Number(i)] !== void 0 ? String(args[Number(i)]) : m;
      });
    }

    var PROVIDER_LABELS = { deepseek: L.providerDeepSeek, "deepseek-official": L.providerDeepSeek };

    var USAGE_KEYS = ["uncachedInputTokens", "cacheReadTokens", "cacheWriteTokens", "outputTokens"];
    var ZERO_USAGE = { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
    var BALANCE_CACHE_KEY = "dsh-better-stats:balance";

    function beijingPeak(epochMs) {
      var d = new Date((epochMs || Date.now()) + 8 * 3600 * 1000);
      var h = d.getUTCHours();
      return (h >= 9 && h < 12) || (h >= 14 && h < 18);
    }

    // Three-state model classification (mirrors the host): unknown models
    // price at 0 and are flagged via unpricedSteps instead of silently
    // pricing at the flash rate.
    function modelKeyOf(model) {
      if (typeof model === "string") {
        if (model.indexOf("v4-pro") !== -1) return "deepseek-v4-pro";
        if (model.indexOf("v4-flash") !== -1) return "deepseek-v4-flash";
      }
      return "unknown";
    }

    // CNY cost of a usage bucket at a given moment's peak/off-peak tier and
    // the producing model's price table. Unknown models (or models missing
    // from the active table) cost 0 — they surface via unpricedSteps.
    function cnyCost(totals, time, model, tables) {
      if (!totals) return 0;
      var table = (tables || PRICE_TABLES)[modelKeyOf(model)];
      if (table === void 0 || table === null) return 0;
      var peak = beijingPeak(time);
      var miss = peak ? table.missPeak : table.miss;
      var read = peak ? table.readPeak : table.read;
      var out = peak ? table.outPeak : table.out;
      return (
        ((totals.uncachedInputTokens || 0) + (totals.cacheWriteTokens || 0)) * miss +
        (totals.cacheReadTokens || 0) * read +
        ((totals.outputTokens || 0) + (totals.reasoningTokens || 0)) * out
      ) / 1e6;
    }

    // Upsert one step's settled usage into the turn fold: the per-step
    // LATEST sample wins (usage chunk first, then the assistant/message with
    // its model), and the turn cost is adjusted by the sample's price delta —
    // exact and incremental (O(1) per event).
    function upsertTurnSample(samples, cost, turn, step, usage, model, time, tables) {
      if (usage === void 0 || usage === null || typeof usage !== "object") return cost;
      var key = turn + ":" + step;
      var prev = samples.get(key);
      var buckets = {
        uncachedInputTokens: Number(usage.inputTokens) || 0,
        cacheReadTokens: Number(usage.cacheReadTokens) || 0,
        cacheWriteTokens: Number(usage.cacheWriteTokens) || 0,
        outputTokens: Number(usage.outputTokens) || 0,
        reasoningTokens: Number(usage.reasoningTokens) || 0
      };
      var newCost = cnyCost(buckets, time, model, tables);
      var prevCost = prev !== void 0 ? prev.cost : 0;
      samples.set(key, {
        cost: newCost,
        model: model !== void 0 ? model : (prev !== void 0 ? prev.model : void 0)
      });
      return cost + (newCost - prevCost);
    }

    // Next Beijing peak/off-peak switch: { peak, label, minutesLeft }.
    // 高峰 09:00-12:00 / 14:00-18:00, 其余空闲.
    function beijingPeakNext(now) {
      var d = new Date((now || Date.now()) + 8 * 3600 * 1000);
      var mins = d.getUTCHours() * 60 + d.getUTCMinutes();
      var bounds = [
        { t: 9 * 60, label: T(L.peakStart, "09:00") },
        { t: 12 * 60, label: T(L.offPeakStart, "12:00") },
        { t: 14 * 60, label: T(L.peakStart, "14:00") },
        { t: 18 * 60, label: T(L.offPeakStart, "18:00") }
      ];
      var next = null;
      for (var i = 0; i < bounds.length; i++) {
        if (bounds[i].t > mins) { next = bounds[i]; break; }
      }
      if (next === null) next = { t: 9 * 60 + 24 * 60, label: T(L.peakStart, "09:00") };
      var left = next.t - mins;
      var hh = Math.floor(left / 60);
      var mm = left % 60;
      var minutesLeft = hh > 0 ? hh + "h " + mm + "m" : mm + "m";
      return {
        peak: beijingPeak(now),
        label: next.label,
        minutesLeft: minutesLeft
      };
    }

    function pad2(n) {
      return (n < 10 ? "0" : "") + n;
    }

    // CJK-aware char classification for the streaming estimate: CJK ≈ 1
    // token/char, everything else at the per-kind density.
    function classifyChars(target, s) {
      for (var i = 0; i < s.length; i++) {
        var c = s.charCodeAt(i);
        if ((c >= 0x3000 && c <= 0x303f) || (c >= 0x4e00 && c <= 0x9fff) || (c >= 0xff00 && c <= 0xffef)) {
          target.cjk += 1;
        } else {
          target.rest += 1;
        }
      }
    }

    // Beijing-time "YYYY-MM-DD HH:MM" of a UTC ISO timestamp for the 价源 row.
    function beijingDateLabel(iso) {
      try {
        var t = new Date(iso);
        if (isNaN(t.getTime())) return "";
        var tBJ = new Date(t.getTime() + 8 * 3600 * 1000);
        return tBJ.getUTCFullYear() + "-" +
          pad2(tBJ.getUTCMonth() + 1) + "-" +
          pad2(tBJ.getUTCDate()) + " " +
          pad2(tBJ.getUTCHours()) + ":" + pad2(tBJ.getUTCMinutes());
      } catch (e) {
        return "";
      }
    }

    function fmtMoney(symbol, value, decimals) {
      var n = Number(value) || 0;
      return symbol + n.toFixed(typeof decimals === "number" ? decimals : PRECISION);
    }

    // decimals shown by the provider's own balance value (DeepSeek returns
    // 2); adapt to whatever the endpoint sends, capped against float noise
    function moneyDecimals(value) {
      var n = Number(value);
      if (!Number.isFinite(n)) return 2;
      var s = String(n);
      var i = s.indexOf(".");
      var d = i === -1 ? 0 : s.length - i - 1;
      if (d > 6) d = 6;
      return d;
    }
    var POPOVER_DECIMALS = 6; // full detail in the popover

    function fmtTokens(n) {
      var v = Number(n) || 0;
      if (v >= 1000000) return (v / 1000000).toFixed(2) + "M";
      if (v >= 10000) return (v / 1000).toFixed(2) + "K";
      return String(v);
    }

    // h/m/s format, integer parts only: 45.2s → "45s", 65s → "1m 5s",
    // 3661s → "1h 1m 1s".
    function formatDuration(ms) {
      var v = Number(ms) || 0;
      var totalSec = Math.round(v / 1000);
      var h = Math.floor(totalSec / 3600);
      var m = Math.floor((totalSec % 3600) / 60);
      var s = totalSec % 60;
      var parts = [];
      if (h > 0) parts.push(h + "h");
      if (m > 0) parts.push(m + "m");
      if (s > 0 || parts.length === 0) parts.push(s + "s");
      return parts.join(" ");
    }

    function formatTps(tps) {
      var v = Number(tps) || 0;
      return v.toFixed(2) + "tok/s";
    }

    // Time-to-first-token: seconds with 2 decimals ("1.40s").
    function formatTtft(ms) {
      var v = Number(ms) || 0;
      return (v / 1000).toFixed(2) + "s";
    }

    // Billed input = uncached input + cache writes (both charged at the
    // miss price); cache-hit rate = cacheRead / (cacheRead + billed).
    function billedInputTokens(totals) {
      return (totals.uncachedInputTokens || 0) + (totals.cacheWriteTokens || 0);
    }
    function cacheHitPercent(totals) {
      var billed = billedInputTokens(totals);
      var read = totals.cacheReadTokens || 0;
      if (billed + read <= 0) return null;
      return (read / (billed + read) * 100).toFixed(2);
    }

    function currencySymbol(currency) {
      if (typeof currency === "string" && CURRENCY_SYMBOLS[currency] !== void 0) return CURRENCY_SYMBOLS[currency];
      return typeof currency === "string" && currency !== "" ? currency + " " : "¥";
    }

    // ── tree merge (descendant subagent sessions) ───────────────────────────
    function collectDescendants(byId, rootId) {
      var out = [];
      var stack = [];
      for (var id in byId) {
        var entry = byId[id];
        if (entry !== void 0 && entry.parentId === rootId) stack.push(id);
      }
      var seen = new Set();
      while (stack.length > 0) {
        var cid = stack.pop();
        if (seen.has(cid)) continue;
        seen.add(cid);
        out.push(cid);
        for (var gid in byId) {
          var gentry = byId[gid];
          if (gentry !== void 0 && gentry.parentId === cid) stack.push(gid);
        }
      }
      return out;
    }
    // Merged tokenUsage = root + every descendant. Defensive: if the
    // sessions binding API is unavailable, falls back to the root usage only.
    function mergedUsage(sessions, list, sessionId, usage) {
      var merged = usage === void 0 ? void 0 : Object.assign({}, ZERO_USAGE);
      if (merged !== void 0) {
        for (var i = 0; i < USAGE_KEYS.length; i++) merged[USAGE_KEYS[i]] = usage[USAGE_KEYS[i]] || 0;
      }
      var byId = list && list.byId ? list.byId : {};
      var desc;
      try {
        desc = collectDescendants(byId, sessionId);
      } catch (e) {
        return merged;
      }
      if (typeof sessions.binding !== "function") return merged;
      for (var d = 0; d < desc.length; d++) {
        try {
          var binding = sessions.binding(desc[d]);
          var projections = binding && binding.session ? binding.session.projections : void 0;
          if (projections === void 0) continue;
          var u = projections.get("tokenUsage");
          if (u === void 0) continue;
          if (merged === void 0) merged = Object.assign({}, ZERO_USAGE);
          for (var k = 0; k < USAGE_KEYS.length; k++) merged[USAGE_KEYS[k]] += u[USAGE_KEYS[k]] || 0;
        } catch (e) { /* skip this child */ }
      }
      return merged;
    }

    // ── balance cache (localStorage) ────────────────────────────────────────
    function loadBalanceCache() {
      try {
        var raw = localStorage.getItem(BALANCE_CACHE_KEY);
        if (!raw) return null;
        var parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && parsed.amount !== void 0) return parsed;
        return null;
      } catch (e) {
        return null;
      }
    }
    function saveBalanceCache(value) {
      try {
        localStorage.setItem(BALANCE_CACHE_KEY, JSON.stringify(value));
      } catch (e) { /* ignore */ }
    }

    // ── ETA (days-left estimate) ───────────────────────────────────────────
    // Sampled from the /today route: today's Beijing-day spend is normalized
    // by the elapsed fraction of the day, blended with the trailing per-day
    // history, then smoothed with an EWMA so one expensive day never swings
    // the prediction. Pure display math — no host changes, localStorage only.
    var ETA_STORAGE_KEY = "dsh-better-stats:eta";
    var ETA_HISTORY_MAX = 30;
    function sampleEta(body, etaRef) {
      try {
        var cost = Number(body.costCny) || 0;
        var date = body.date; // Beijing YYYY-MM-DD
        if (typeof date !== "string" || date === "") return;
        var raw = localStorage.getItem(ETA_STORAGE_KEY);
        var st = null;
        try { st = raw ? JSON.parse(raw) : null; } catch (e) { st = null; }
        if (st === null || typeof st !== "object") st = { date: null, cost: 0, rate: null, history: [] };
        if (!Array.isArray(st.history)) st.history = [];
        if (st.date !== date) {
          // Beijing-day rollover: archive the finished day.
          if (st.date !== null && st.date !== void 0 && st.date !== date && Number(st.cost) > 0) {
            st.history.push({ date: st.date, cost: Number(st.cost) });
            if (st.history.length > ETA_HISTORY_MAX) st.history = st.history.slice(-ETA_HISTORY_MAX);
          }
          st.date = date;
          st.cost = cost;
        } else {
          st.cost = cost;
        }
        // Today's projected rate: cost / elapsed fraction of the Beijing day.
        var d = new Date(Date.now() + 8 * 3600 * 1000);
        var mins = d.getUTCHours() * 60 + d.getUTCMinutes();
        var frac = mins / 1440;
        var todayRate = 0;
        if (cost > 0 && frac > 0.02) todayRate = cost / frac;
        var histTotal = 0;
        var histDays = 0;
        for (var i = 0; i < st.history.length; i++) {
          var h = st.history[i];
          if (h !== null && typeof h === "object" && Number(h.cost) > 0) {
            histTotal += Number(h.cost);
            histDays += 1;
          }
        }
        var histRate = histDays > 0 ? histTotal / histDays : 0;
        var blended = 0;
        if (todayRate > 0 && histRate > 0) blended = todayRate * 0.5 + histRate * 0.5;
        else if (todayRate > 0) blended = todayRate;
        else if (histRate > 0) blended = histRate;
        if (blended > 0) {
          var prev = Number(st.rate) || 0;
          st.rate = prev > 0 ? prev * 0.7 + blended * 0.3 : blended;
        }
        localStorage.setItem(ETA_STORAGE_KEY, JSON.stringify(st));
        etaRef.current = st;
      } catch (e) { /* display-only, never throw */ }
    }
    function etaTextOf(st, balance) {
      try {
        if (st === null || typeof st !== "object") return "";
        var rate = Number(st.rate);
        var amount = balance !== null && balance !== void 0 ? Number(balance.amount) : NaN;
        if (!(rate > 0) || !Number.isFinite(amount) || amount <= 0) return "";
        var days = amount / rate;
        if (days >= 1) return T(L.etaDays, String(Math.floor(days)));
        return T(L.etaHours, String(Math.max(1, Math.round(days * 24))));
      } catch (e) { return ""; }
    }

    // ── group builders ──────────────────────────────────────────────────────
    // meta: { subCount, modelBreakdown, unpricedSteps, pricingSourceText,
    //         budgetLines, spendWarn, estimateCny, estimateNote, peakGroup,
    //         balanceWarnCny, balanceCriticalCny }
    // Popover strings may contain "\n": each line renders as its own row.
    function buildGroups(stats, usage, turnCny, totalCny, balance, meta) {
      var groups = [];
      var subCount = meta !== null && meta !== void 0 ? (meta.subCount || 0) : 0;
      var modelBreakdown = meta !== null && meta !== void 0 && meta.modelBreakdown ? meta.modelBreakdown : null;
      var unpricedSteps = meta !== null && meta !== void 0 ? (meta.unpricedSteps || 0) : 0;
      var estimateCny = meta !== null && meta !== void 0 ? (meta.estimateCny || 0) : 0;
      var sessionRunning = meta !== null && meta !== void 0 && meta.sessionRunning === true;
      var balanceWarnCny = meta !== null && meta !== void 0 ? (meta.balanceWarnCny || 0) : 0;
      var balanceCriticalCny = meta !== null && meta !== void 0 ? (meta.balanceCriticalCny || 0) : 0;
      if (balance !== null) {
        groups.push({ label: "API", text: balance.label });
        if (balance.amount !== null) {
          // provider-native decimals (DeepSeek sends 2); cached values from
          // older versions lack the field → infer from the amount
          var balDec = balance.decimals !== void 0 ? balance.decimals : moneyDecimals(balance.amount);
          var balText = fmtMoney(currencySymbol(balance.currency), balance.amount, balDec);
          var balPop = L.balance + " " + balText;
          // Loose null checks: old localStorage caches lack the split fields.
          if (balance.granted != null || balance.toppedUp != null) {
            var splitParts = [];
            if (balance.granted != null) splitParts.push(L.granted + " " + fmtMoney(currencySymbol(balance.currency), balance.granted, balDec));
            if (balance.toppedUp != null) splitParts.push(L.toppedUp + " " + fmtMoney(currencySymbol(balance.currency), balance.toppedUp, balDec));
            if (splitParts.length > 0) balPop += "（" + splitParts.join(" · ") + "）";
          }
          // two-tier low-balance alert (defaults from the host config: warn
          // ¥20 amber, critical ¥5 red; a tier set to 0 is disabled)
          var balStyle = void 0;
          var balWarn = "";
          var balAmount = Number(balance.amount);
          var rechargeUrl = null;
          if (balanceCriticalCny > 0 && balAmount <= balanceCriticalCny) {
            balStyle = { color: "#ef4444" };
            balWarn = "⚠ ";
            rechargeUrl = "https://platform.deepseek.com/top_up";
            balPop += "\n" + T(L.balanceAlertCritical, fmtMoney(currencySymbol(balance.currency), balanceCriticalCny, CONFIG_DECIMALS));
          } else if (balanceWarnCny > 0 && balAmount <= balanceWarnCny) {
            balStyle = { color: "#f59e0b" };
            balWarn = "⚠ ";
            balPop += "\n" + T(L.balanceAlertWarn, fmtMoney(currencySymbol(balance.currency), balanceWarnCny, CONFIG_DECIMALS));
          }
          if (meta !== null && meta !== void 0 && meta.etaText !== null && meta.etaText !== void 0 && meta.etaText !== "") {
            balPop += "\n" + meta.etaText;
          }
          balPop += "\n" + L.refreshHint;
          groups.push({ label: "余额", text: balWarn + L.balance + " " + balText, value: balText, popover: balPop, style: balStyle, refreshable: balance.amount !== null, recharge: rechargeUrl });
        } else {
          groups.push({ label: "余额", text: balance.text });
        }
      }
      // 峰谷 group: 行内 just 高峰中/空闲中; the popover keeps the detail
      if (meta !== null && meta !== void 0 && meta.peakGroup !== null && meta.peakGroup !== void 0) {
        var pg = meta.peakGroup;
        groups.push({
          label: "峰谷",
          text: pg.peak ? L.peakNow : L.offPeakNow,
          popover: (pg.peak ? L.peakNowDetail : L.offPeakNowDetail) + " · " + pg.label + T(L.inMinutes, pg.minutesLeft)
        });
      }
      if (usage !== void 0) {
        var approx = unpricedSteps > 0 ? "≈" : "";
        var totalShown = turnCny + estimateCny;
        // 会话 ticks live too: host-exact settled cost + the in-flight step's
        // estimate, so long generations never sit still.
        var sessionShown = totalCny + estimateCny;
        // inline stays clean (no (估) suffix) — the 精确/估算 breakdown and
        // the fact that the amount includes an estimate live in the popover;
        // both computed amounts at 4 decimals (uniform, movement visible)
        var spendText = L.turn + " " + fmtMoney("¥", totalShown) +
          " · " + L.session + " " + approx + fmtMoney("¥", sessionShown);
        var popLines = [];
        // while a session is running the 本轮 bracket stays put (the estimate
        // may momentarily be 0 between steps — no flicker); 会话 ticks as one
        // number (历史+本轮) without its own breakdown
        if (estimateCny > 0 || sessionRunning) {
          popLines.push(L.turn + " " + fmtMoney("¥", totalShown, POPOVER_DECIMALS) + "（" + L.exact + " " + fmtMoney("¥", turnCny, POPOVER_DECIMALS) + " + " + L.estimate + " " + fmtMoney("¥", estimateCny, POPOVER_DECIMALS) + "）");
        } else {
          popLines.push(L.turn + " " + fmtMoney("¥", turnCny, POPOVER_DECIMALS));
        }
        popLines.push(L.session + " " + approx + fmtMoney("¥", sessionShown, POPOVER_DECIMALS) + (unpricedSteps > 0 ? T(L.unpricedNote, unpricedSteps) : ""));
        if (meta !== null && meta !== void 0 && meta.budgetLines && meta.budgetLines.length > 0) {
          popLines = popLines.concat(meta.budgetLines);
        }
        if (modelBreakdown !== null && modelBreakdown.length > 1) {
          var modelParts = [];
          for (var mb = 0; mb < modelBreakdown.length; mb++) {
            var entry = modelBreakdown[mb];
            if (entry === void 0 || entry === null || entry.model === "unknown") continue;
            var short = String(entry.model).replace("deepseek-", "");
            modelParts.push(short + " " + fmtMoney("¥", entry.costCny, POPOVER_DECIMALS));
          }
          if (modelParts.length > 0) popLines.push(modelParts.join(" · "));
        }
        if (subCount > 0) popLines.push(T(L.subSessions, subCount));
        var groupStyle = void 0;
        if (meta !== null && meta !== void 0 && meta.spendWarn === "over") groupStyle = { color: "#ef4444" };
        else if (meta !== null && meta !== void 0 && meta.spendWarn === "warn") groupStyle = { color: "#f59e0b" };
        var warnMark = meta !== null && meta !== void 0 && meta.spendWarn !== null && meta.spendWarn !== void 0 ? "⚠ " : "";
        groups.push({ label: "花费", text: warnMark + spendText, popover: popLines.join("\n"), style: groupStyle });
      }
      if (stats && stats.steps > 0) {
        groups.push({ label: "轮次", text: T(L.turnsSteps, stats.turns, stats.steps) });
        var durations = [];
        if (stats.llmMs > 0) durations.push("LLM " + formatDuration(stats.llmMs));
        if (stats.toolMs > 0) durations.push(L.tool + " " + formatDuration(stats.toolMs));
        if (durations.length > 0) groups.push({ label: "耗时", text: durations.join(" · ") });
        var speeds = [];
        if (stats.ttftSteps > 0) speeds.push(L.ttftAvg + " " + formatTtft(stats.ttftMs / stats.ttftSteps));
        if (stats.decodeMs > 0) speeds.push(formatTps(stats.decodeTokens / (stats.decodeMs / 1000)));
        if (speeds.length > 0) groups.push({ label: "速率", text: speeds.join(" · ") });
      }
      if (usage !== void 0 && (billedInputTokens(usage) > 0 || usage.outputTokens > 0)) {
        var hit = cacheHitPercent(usage);
        if (hit !== null) {
          // 缓存命中组（倒数第二）
          groups.push({
            label: "缓存",
            text: L.cache + " " + fmtTokens(usage.cacheReadTokens || 0) + " · " + L.hit + " " + hit + "%"
          });
        }
        // 输入输出组（倒数第一）— label "Tok" 与左侧双字标签对称
        groups.push({
          label: "Tok",
          text: L.input + " " + fmtTokens(billedInputTokens(usage)) + " · " + L.output + " " + fmtTokens(usage.outputTokens || 0)
        });
      }
      return groups;
    }

    function BetterStatsLine(props) {
      try {
        return BetterStatsLineInner(props);
      } catch (error) {
        // Never take the whole dock down silently: surface the error inline
        // so it can be reported and fixed.
        return react.createElement(
          "div",
          {
            className: "dsh-better-stats-line",
            style: { color: "#ef4444" }
          },
          "better-stats: " + (error && error.message ? error.message : String(error))
        );
      }
    }

    function BetterStatsLineInner(props) {
      var useProjection = props && typeof props.useProjection === "function" ? props.useProjection : null;
      var useSessions = props && typeof props.useSessions === "function" ? props.useSessions : null;
      var sessionId = props && typeof props.sessionId === "string" ? props.sessionId : null;

      var usage = useProjection !== null ? useProjection("tokenUsage") : void 0;
      var stats = useProjection !== null ? useProjection("sessionStats") : void 0;

      var list = useSessions !== null ? useSessions(function (s) { return s; }) : null;
      var merged = react.useMemo(
        function () {
          if (sessionsService === null) return usage;
          return mergedUsage(sessionsService, list, sessionId, usage);
        },
        [sessionsService, list, sessionId, usage]
      );

      var balanceState = react.useState(loadBalanceCache());
      var balance = balanceState[0];
      var setBalance = balanceState[1];

      var hoverState = react.useState(false);
      var hovered = hoverState[0];
      var setHovered = hoverState[1];

      var anchorState = react.useState(null);
      var anchor = anchorState[0];
      var setAnchor = anchorState[1];
      var lineRef = react.useRef(null);
      function measureAnchor() {
        var el = lineRef.current;
        if (el === null) return;
        var rect = el.getBoundingClientRect();
        setAnchor({ left: rect.left + rect.width / 2, top: rect.top - 8 });
      }

      // Separator state (measured after layout; see measureSeps below).
      // Declared up here, unconditionally, to keep hook order stable.
      var sepState = react.useState([]);
      var sepHidden = sepState[0];
      var setSepHidden = sepState[1];
      var trailingCache = react.useRef("");
      var itemRefs = react.useRef([]);
      var sepProbeRef = react.useRef(null);
      // Latest-measurement ref: ResizeObserver and effects always call through
      // this so they never run a stale closure against a changed groups list.
      var measureRef = react.useRef(null);
      // v20 hooks (declared after measureRef so the measurement ref indices
      // stay stable): streaming-estimate cursor, host pricing/budget refs
      // (written by the poll handlers, read during render), today's spend.
      var estimateRef = react.useRef({
        next: 0,
        reason: { cjk: 0, rest: 0 },
        text: { cjk: 0, rest: 0 },
        tool: { cjk: 0, rest: 0 },
        reasonDensity: EST_DENSITY_REASON, // EMA-calibrated chars/token
        outputDensity: EST_DENSITY_OUTPUT,
        inputCny: 0,       // carried input cost of the current step (from the previous usage chunk)
        lastUsage: null,   // { inputTokens, cacheReadTokens } of the last settled step
        lastModel: void 0, // last model seen (prices usage chunks when the
                           // browser stream omits the message usage/model)
        sawStepStart: false,
        turnCost: 0,       // exact cost of the current TURN (per-step fold)
        turnSamples: new Map(), // "turn:step" → { cost, model }
        turnActive: false  // folds only after the first turn/start (or a
                           // restored-session step/start), so pre-loaded
                           // history never leaks into 本轮
      });
      var pricingRef = react.useRef(null); // { source, fetchedAt, tables } from host
      var budgetRef = react.useRef(null);  // { daily, monthly } from host config
      var todayState = react.useState(null);
      var todayCost = todayState[0];
      var setTodayCost = todayState[1];

      react.useEffect(function () {
        var alive = true;
        function load(force) {
          fetch("/plugins/better-stats/balance" + (force ? "?force=1" : ""), { cache: "no-store" })
            .then(function (res) {
              if (!res.ok) throw new Error("balance http " + res.status);
              return res.json();
            })
            .then(function (body) {
              if (!alive) return;
              if (body && body.configured === true && body.status === "ok" && body.amount !== void 0) {
                var label = body.displayName || PROVIDER_LABELS[body.provider] || (typeof body.provider === "string" ? body.provider : "DeepSeek");
                var next = {
                  text: label + " " + fmtMoney(currencySymbol(body.currency), body.amount, moneyDecimals(body.amount)),
                  label: label,
                  amount: body.amount,
                  currency: body.currency || "CNY",
                  decimals: moneyDecimals(body.amount),
                  granted: body.grantedBalance !== void 0 ? body.grantedBalance : null,
                  toppedUp: body.toppedUpBalance !== void 0 ? body.toppedUpBalance : null
                };
                setBalance(next);
                saveBalanceCache(next);
              } else if (body && body.configured === false) {
                setBalance({ text: L.balanceDash, label: "DeepSeek", amount: null, currency: null, granted: null, toppedUp: null });
              } else {
                // status error: keep the stale value when we have one.
                setBalance(function (prev) {
                  return prev !== null ? prev : { text: L.balanceFailed, label: "DeepSeek", amount: null, currency: null, granted: null, toppedUp: null };
                });
              }
            })
            .catch(function () {
              if (!alive) return;
              setBalance(function (prev) {
                return prev !== null ? prev : { text: L.balanceFailed, label: "DeepSeek", amount: null, currency: null, granted: null, toppedUp: null };
              });
            });
        }
        load(false);
        balanceRefreshRef.current = load;
        var timer = setInterval(function () { load(false); }, 15000);
        return function () {
          alive = false;
          clearInterval(timer);
        };
      }, []);

      // ── server-side tree-merged usage ─────────────────────────────────────
      // The host folds EVERY descendant session's log (client-side projections
      // only exist for sessions this browser has opened, so subagent usage was
      // silently undercounted). Falls back to the client merge while the host
      // route is unavailable (e.g. before a server restart).
      var costState = react.useState(null);
      var serverCost = costState[0];
      var setServerCost = costState[1];
      react.useEffect(function () {
        if (sessionId === null) return;
        var alive = true;
        function load() {
          fetch("/plugins/better-stats/cost?sessionId=" + encodeURIComponent(sessionId), { cache: "no-store" })
            .then(function (res) {
              if (!res.ok) throw new Error("cost http " + res.status);
              return res.json();
            })
            .then(function (body) {
              if (!alive || !body || typeof body.merged !== "object" || body.merged === null) return;
              if (body.pricing && typeof body.pricing === "object" && body.pricing.tables) {
                pricingRef.current = body.pricing;
              }
              if (body.budget && typeof body.budget === "object") {
                budgetRef.current = body.budget;
              }
              setServerCost({
                merged: {
                  uncachedInputTokens: Number(body.merged.uncachedInputTokens) || 0,
                  cacheReadTokens: Number(body.merged.cacheReadTokens) || 0,
                  cacheWriteTokens: Number(body.merged.cacheWriteTokens) || 0,
                  outputTokens: Number(body.merged.outputTokens) || 0
                },
                // costCny is null until the host runs the version with the
                // official-CNY pricing (needs a server restart); the client
                // falls back to its own current-tier estimate meanwhile.
                costCny: typeof body.costCny === "number" && Number.isFinite(body.costCny) ? body.costCny : null,
                models: Array.isArray(body.models) ? body.models : null,
                unpricedSteps: Number(body.unpricedSteps) || 0,
                pricing: body.pricing && typeof body.pricing === "object" ? body.pricing : null,
                descendantCount: Number(body.descendantCount) || 0,
                at: Date.now()
              });
            })
            .catch(function () { /* keep previous value */ });
        }
        load();
        var timer = setInterval(load, 15000);
        return function () {
          alive = false;
          clearInterval(timer);
        };
      }, [sessionId]);

      // ── live step timing (host-driven) ────────────────────────────────────
      // The client session stream does NOT carry tool/call / tool/result
      // events, so live timing must come from the host, which holds the full
      // log. Poll /plugins/better-stats/live every second; the response
      // carries the completed totals plus the open step's and in-flight tool
      // calls' start times, all from ONE host snapshot — no frame-vs-event
      // race is possible, and completion is continuous by construction.
      var liveState = react.useState(null);
      var liveInfo = liveState[0];
      var setLiveInfo = liveState[1];
      // ETA state: { date (Beijing YYYY-MM-DD), cost, rate (¥/day, EWMA),
      // history: [{date, cost}] } — sampled from the /today route. Declared
      // AFTER the v20 hook block so the regression harness's fixed hook
      // indices (13=todayState, 17=liveInfo) stay stable.
      var etaRef = react.useRef(null);
      var etaState = react.useState(null);
      var etaText = etaState[0];
      var setEtaText = etaState[1];
      var balanceRefreshRef = react.useRef(null); // force refresh, set below
      react.useEffect(function () {
        if (sessionId === null) return;
        var alive = true;
        function poll() {
          fetch("/plugins/better-stats/live?sessionId=" + encodeURIComponent(sessionId), { cache: "no-store" })
            .then(function (res) {
              if (!res.ok) throw new Error("live http " + res.status);
              return res.json();
            })
            .then(function (body) {
              if (!alive || body === void 0 || body === null || typeof body.openStepStart === "undefined") return;
              if (body.pricing && typeof body.pricing === "object" && body.pricing.tables) {
                pricingRef.current = body.pricing;
              }
              if (body.budget && typeof body.budget === "object") {
                budgetRef.current = body.budget;
              }
              setLiveInfo({
                completed: body.completed || null,
                openStepStart: body.openStepStart,
                pendingMin: body.pendingMin,
                toolPhaseStart: body.toolPhaseStart,
                costCny: typeof body.costCny === "number" && Number.isFinite(body.costCny) ? body.costCny : null,
                models: Array.isArray(body.models) ? body.models : null,
                unpricedSteps: Number(body.unpricedSteps) || 0,
                pricing: body.pricing && typeof body.pricing === "object" ? body.pricing : null,
                budget: body.budget && typeof body.budget === "object" ? body.budget : null,
                at: Date.now()
              });
            })
            .catch(function () { /* keep previous value */ });
        }
        poll();
        var timer = setInterval(poll, 1000);
        return function () {
          alive = false;
          clearInterval(timer);
        };
      }, [sessionId]);

      // ── today's workspace spend (budget display) ─────────────────────────
      // Polled only while a budget is configured (budgetRef is written by the
      // live/cost poll handlers). The host caches the fold for 60s, so a 5s
      // client poll stays cheap while the budget line appears promptly.
      react.useEffect(function () {
        if (sessionId === null) return;
        var alive = true;
        function load() {
          var b = budgetRef.current;
          fetch("/plugins/better-stats/today", { cache: "no-store" })
            .then(function (res) {
              if (!res.ok) throw new Error("today http " + res.status);
              return res.json();
            })
            .then(function (body) {
              if (!alive || !body || typeof body.costCny !== "number") return;
              // ETA sampling runs unconditionally (balance-left estimate);
              // the budget display stays gated on configured budgets.
              sampleEta(body, etaRef);
              setEtaText(etaTextOf(etaRef.current, balance));
              if (b === null || !(Number(b.daily) > 0 || Number(b.monthly) > 0)) {
                setTodayCost(null);
                return;
              }
              setTodayCost({
                costCny: body.costCny,
                monthCostCny: typeof body.monthCostCny === "number" ? body.monthCostCny : null,
                unpricedSteps: Number(body.unpricedSteps) || 0,
                sessionCount: Number(body.sessionCount) || 0,
                at: Date.now()
              });
            })
            .catch(function () { /* keep previous value */ });
        }
        load();
        var timer = setInterval(load, 5000);
        return function () {
          alive = false;
          clearInterval(timer);
        };
      }, [sessionId]);

      // session running bit (from the list) — gates the live parts
      var sessionRunning = false;
      try {
        var listById = list !== null && typeof list === "object" ? list.byId : null;
        sessionRunning = !!(listById && sessionId !== null && listById[sessionId] && listById[sessionId].running === true);
      } catch (e) { sessionRunning = false; }

      // Current model = the latest assistant message's producing model (the
      // fallback pricing tier when the host cost route is unavailable).
      // clientEvents is the LIVE in-place-pushed array — used for the model
      // scan and for the streaming char estimate below.
      var currentModel = DEFAULT_MODEL;
      var clientEvents = null;
      try {
        var liveSessBinding = sessionsService !== null && sessionId !== null
          ? sessionsService.binding(sessionId)
          : void 0;
        clientEvents = liveSessBinding !== void 0 && liveSessBinding.session !== void 0
          ? liveSessBinding.session.events
          : null;
        if (clientEvents !== null) {
          for (var mi = clientEvents.length - 1; mi >= 0; mi--) {
            var me = clientEvents[mi];
            if (me !== void 0 && me !== null && me.type === "assistant/message" &&
                me.data && me.data.message && me.data.message.source &&
                typeof me.data.message.source.model === "string") {
              currentModel = me.data.message.source.model;
              break;
            }
          }
        }
      } catch (e) { /* keep the default model */ }

      // effective usage: host-merged when available, else the client merge
      var effective = serverCost !== null ? serverCost.merged : merged;

      // ── v20: host-driven pricing/budget, unpriced steps, estimates ───────
      // Price tables come from the host (official page, 6h sync); the builtin
      // table is the fallback while no host answer has arrived yet.
      var hostPricing = null;
      if (liveInfo !== null && liveInfo.pricing !== null && liveInfo.pricing.tables) hostPricing = liveInfo.pricing;
      else if (serverCost !== null && serverCost.pricing !== null && serverCost.pricing.tables) hostPricing = serverCost.pricing;
      var effectiveTables = hostPricing !== null ? hostPricing.tables : PRICE_TABLES;
      var pricingSourceText = L.pricingBuiltin;
      if (hostPricing !== null && hostPricing.source === "official") {
        pricingSourceText = L.providerDeepSeek + " " + beijingDateLabel(hostPricing.fetchedAt);
      } else if (hostPricing !== null && hostPricing.source === "stale") {
        pricingSourceText = L.pricingOfficialStale;
      }

      // Unknown-model steps: host counts them (tokens still totaled, cost 0);
      // the session amount gets a ≈ prefix and a popover note.
      var unpricedSteps = 0;
      if (liveInfo !== null && Number(liveInfo.unpricedSteps) > 0) unpricedSteps = Number(liveInfo.unpricedSteps);
      else if (serverCost !== null && Number(serverCost.unpricedSteps) > 0) unpricedSteps = Number(serverCost.unpricedSteps);

      // ── turn-scoped 本轮: exact turn fold + streaming estimate ───────────
      // 本轮 = the CURRENT TURN's exact cost (per-step event-time pricing
      // over the live events — the same fold the host does, scoped to this
      // turn) PLUS the in-flight step's streaming estimate. The scan below
      // runs on EVERY render (not gated on an open step) so turn boundaries
      // are tracked even during tool phases; only the ESTIMATE VALUE is
      // gated on a running session with an open step.
      // The exact base resets at turn/start and turn/end; before the first
      // turn boundary it simply accumulates from page load (restored
      // sessions keep working). The streaming counters reset per STEP (usage
      // landing hands the exact figures over), so the displayed number grows
      // continuously across the turn's steps:
      //   exact(step1..k-1) + estimate(step k)
      // and never restarts mid-turn.
      var estimateCny = 0;
      var exactTurnCny = 0;
      if (clientEvents !== null) {
        try {
          var estState = estimateRef.current;
          var estLen = clientEvents.length;
          if (estLen >= estState.next) {
            var reason = estState.reason;
            var text = estState.text;
            var tool = estState.tool;
            var inputCny = estState.inputCny;
            var lastUsage = estState.lastUsage;
            var sawStepStart = estState.sawStepStart;
            // usage chunks land BEFORE their assistant/message in the stream,
            // so the very first step of a page load has no prior model yet —
            // seed from the component's current-model scan (last message seen)
            var lastModel = estState.lastModel !== void 0 ? estState.lastModel : currentModel;
            var turnCost = estState.turnCost;
            var turnSamples = estState.turnSamples;
            var turnActive = estState.turnActive;
            for (var ei = estState.next; ei < estLen; ei++) {
              var ev = clientEvents[ei];
              if (ev === void 0 || ev === null || typeof ev !== "object") continue;
              if (ev.type === "turn/start") {
                // new turn: the exact base restarts (本轮 = 这一轮的)
                turnSamples = new Map();
                turnCost = 0;
                turnActive = true;
                reason.cjk = 0; reason.rest = 0;
                text.cjk = 0; text.rest = 0;
                tool.cjk = 0; tool.rest = 0;
                inputCny = 0;
                sawStepStart = false;
              } else if (ev.type === "turn/end") {
                // turn complete: KEEP the final turn cost on display (本轮
                // resets to 0 only at the NEXT turn/start); counters reset
                // so the next turn's estimate starts clean
                turnActive = false;
                reason.cjk = 0; reason.rest = 0;
                text.cjk = 0; text.rest = 0;
                tool.cjk = 0; tool.rest = 0;
                inputCny = 0;
                sawStepStart = false;
              } else if (!turnActive) {
                // fold stays dormant until the first turn/start, so pre-loaded
                // history (restored sessions) never leaks into 本轮; restored
                // sessions carry their turn/start in the event stream anyway
                continue;
              } else if (ev.type === "reasoning-chunks" && ev.data !== void 0 && Array.isArray(ev.data.texts)) {
                classifyChars(reason, ev.data.texts.join(""));
              } else if (ev.type === "text-chunks" && ev.data !== void 0 && Array.isArray(ev.data.texts)) {
                classifyChars(text, ev.data.texts.join(""));
              } else if (ev.type === "tool-call-chunks" && ev.data !== void 0 && Array.isArray(ev.data.args)) {
                classifyChars(tool, ev.data.args.join(""));
              } else if (ev.type === "assistant/chunk" && ev.data !== void 0 && ev.data.chunk !== void 0) {
                var ck = ev.data.chunk;
                if (ck.type === "usage" && ck.usage !== void 0 && ck.usage !== null) {
                  // step settled: exact figures take over the turn fold, carry
                  // the input snapshot for the NEXT step's input estimate;
                  // the step's real chars→tokens ratio re-calibrates the
                  // streaming densities (counters still hold this step).
                  // The browser stream may not carry the assistant/message
                  // usage (nor its model), so price with the last known model.
                  calibrateEstDensity(estState, reason, text, tool, ck.usage);
                  turnCost = upsertTurnSample(turnSamples, turnCost, ev.data.turn, ev.data.step, ck.usage, lastModel, ev.time, effectiveTables);
                  reason.cjk = 0; reason.rest = 0;
                  text.cjk = 0; text.rest = 0;
                  tool.cjk = 0; tool.rest = 0;
                  inputCny = 0;
                  sawStepStart = false;
                  lastUsage = {
                    inputTokens: Number(ck.usage.inputTokens) || 0,
                    cacheReadTokens: Number(ck.usage.cacheReadTokens) || 0
                  };
                } else if (ck.type === "text-delta" || ck.type === "reasoning-delta") {
                  // legacy fallback: the sampled delta events (tiny subset;
                  // counted only when batch events are absent)
                  classifyChars(ck.type === "reasoning-delta" ? reason : text, typeof ck.text === "string" ? ck.text : "");
                }
              } else if (ev.type === "assistant/message" && ev.data !== void 0 && ev.data.message !== void 0) {
                var msgModel = ev.data.message && ev.data.message.source ? ev.data.message.source.model : void 0;
                if (typeof msgModel === "string" && msgModel !== "") lastModel = msgModel;
                if (ev.data.usage !== void 0) {
                  calibrateEstDensity(estState, reason, text, tool, ev.data.usage);
                  turnCost = upsertTurnSample(turnSamples, turnCost, ev.data.turn, ev.data.step, ev.data.usage, msgModel, ev.time, effectiveTables);
                  reason.cjk = 0; reason.rest = 0;
                  text.cjk = 0; text.rest = 0;
                  tool.cjk = 0; tool.rest = 0;
                  inputCny = 0;
                  sawStepStart = false;
                  lastUsage = {
                    inputTokens: Number(ev.data.usage.inputTokens) || 0,
                    cacheReadTokens: Number(ev.data.usage.cacheReadTokens) || 0
                  };
                }
              } else if (ev.type === "step/start") {
                // new step: re-apply the previous step's input snapshot as
                // this step's input estimate (context barely grows between
                // consecutive steps of a turn)
                reason.cjk = 0; reason.rest = 0;
                text.cjk = 0; text.rest = 0;
                tool.cjk = 0; tool.rest = 0;
                if (lastUsage !== null && !sawStepStart) {
                  inputCny = cnyCost({
                    uncachedInputTokens: lastUsage.inputTokens,
                    cacheReadTokens: lastUsage.cacheReadTokens,
                    cacheWriteTokens: 0,
                    outputTokens: 0
                  }, Date.now(), currentModel, effectiveTables);
                }
                sawStepStart = true;
              } else if (ev.type === "step/end") {
                reason.cjk = 0; reason.rest = 0;
                text.cjk = 0; text.rest = 0;
                tool.cjk = 0; tool.rest = 0;
                inputCny = 0;
                sawStepStart = false;
              }
            }
            estimateRef.current = {
              next: estLen,
              reason: reason,
              text: text,
              tool: tool,
              reasonDensity: estState.reasonDensity,
              outputDensity: estState.outputDensity,
              inputCny: inputCny,
              lastUsage: lastUsage,
              lastModel: lastModel,
              sawStepStart: sawStepStart,
              turnCost: turnCost,
              turnSamples: turnSamples,
              turnActive: turnActive
            };
          }
          exactTurnCny = estimateRef.current.turnCost;
          if (sessionRunning && liveInfo !== null && liveInfo.openStepStart !== null && liveInfo.openStepStart !== void 0) {
            var estOutPrice = 0;
            var estTable = effectiveTables[modelKeyOf(currentModel)];
            if (estTable !== void 0 && estTable !== null) {
              var estPeak = beijingPeak(Date.now());
              estOutPrice = estPeak ? estTable.outPeak : estTable.out;
            }
            var estCur = estimateRef.current;
            var estTokens =
              (estCur.reason.cjk + estCur.reason.rest / estCur.reasonDensity) +
              (estCur.text.cjk + estCur.text.rest / estCur.outputDensity) +
              (estCur.tool.cjk + estCur.tool.rest / estCur.outputDensity);
            estimateCny = estTokens * estOutPrice / 1e6 + estCur.inputCny;
          }
        } catch (e) {
          estimateCny = 0;
          exactTurnCny = 0;
        }
      }

      // Budget status + popover lines (daily and/or monthly from host config;
      // today's totals come from /today, Asia/Shanghai midnight rollover).
      var budgetLines = [];
      var spendWarn = null;
      var budget = liveInfo !== null && liveInfo.budget !== null ? liveInfo.budget : (budgetRef.current !== null ? budgetRef.current : null);
      // Balance alert: host always sends balanceAlertCny (default 10; 0 =
      // disabled). Daily/monthly budgets stay OFF unless configured.
      var balanceWarnCny = budget !== null && typeof budget.balanceWarnCny === "number" ? budget.balanceWarnCny : 20;
      var balanceCriticalCny = budget !== null && typeof budget.balanceCriticalCny === "number" ? budget.balanceCriticalCny : 5;
      if (budget !== null && todayCost !== null) {
        var dailyBudget = Number(budget.daily) || 0;
        var monthlyBudget = Number(budget.monthly) || 0;
        var worst = null;
        if (dailyBudget > 0) {
          var dayPct = todayCost.costCny / dailyBudget;
          budgetLines.push(L.today + " " + fmtMoney("¥", todayCost.costCny) + " · " + L.dailyBudget + " " + fmtMoney("¥", dailyBudget, CONFIG_DECIMALS) + " (" + Math.round(dayPct * 100) + "%)");
          if (dayPct >= 1) worst = "over";
          else if (dayPct >= 0.8 && worst === null) worst = "warn";
        }
        if (monthlyBudget > 0 && todayCost.monthCostCny !== null) {
          var monthPct = todayCost.monthCostCny / monthlyBudget;
          budgetLines.push(L.month + " " + fmtMoney("¥", todayCost.monthCostCny) + " · " + L.monthlyBudget + " " + fmtMoney("¥", monthlyBudget, CONFIG_DECIMALS) + " (" + Math.round(monthPct * 100) + "%)");
          if (monthPct >= 1) worst = "over";
          else if (monthPct >= 0.8 && worst === null) worst = "warn";
        }
        spendWarn = worst;
      }

      // Peak/off-peak status for the 峰谷 group (recomputes every render;
      // the 1s live poll drives the countdown tick).
      var peakInfo = beijingPeakNext(Date.now());

      // "本轮" = priced ONLY on NEW usage: the projection's cumulative token
      // buckets are diffed per render and the DELTA is priced at the current
      // model/tier. Old usage is never re-priced, so model switches and
      // peak/off-peak flips cannot inject phantom amounts into 本轮; every
      // LLM call counts the moment its tokens are reported.
      // "会话" = the host's exact tree-wide cost (per-step event time +
      // model); a zero/absent host answer falls back to the live estimate.
      var liveCostNow = cnyCost(usage, Date.now(), currentModel, effectiveTables);
      // 会话 = the freshest exact figure: the host /live route settles the
      // ROOT session per second; the /cost route settles the whole tree
      // (subagents) every ~15s. Take the max of the two exact numbers (the
      // tree is a superset of the root) and fall back to the client-side
      // estimate only when neither host answer is available.
      var treeCost = serverCost !== null && serverCost.costCny !== null && serverCost.costCny > 0 ? serverCost.costCny : 0;
      var liveHostCost = liveInfo !== null && typeof liveInfo.costCny === "number" && liveInfo.costCny > 0 ? liveInfo.costCny : 0;
      var sessionCost = Math.max(treeCost, liveHostCost);
      if (sessionCost <= 0) sessionCost = liveCostNow;
      var prevUsageRef = react.useRef(null);
      var turnCostRef = react.useRef(0);
      if (usage !== void 0) {
        var uNow = {
          uncachedInputTokens: usage.uncachedInputTokens || 0,
          cacheReadTokens: usage.cacheReadTokens || 0,
          cacheWriteTokens: usage.cacheWriteTokens || 0,
          outputTokens: usage.outputTokens || 0
        };
        var uPrev = prevUsageRef.current;
        if (uPrev === null) {
          prevUsageRef.current = uNow;
        } else {
          var uDelta = {
            uncachedInputTokens: Math.max(0, uNow.uncachedInputTokens - uPrev.uncachedInputTokens),
            cacheReadTokens: Math.max(0, uNow.cacheReadTokens - uPrev.cacheReadTokens),
            cacheWriteTokens: Math.max(0, uNow.cacheWriteTokens - uPrev.cacheWriteTokens),
            outputTokens: Math.max(0, uNow.outputTokens - uPrev.outputTokens)
          };
          prevUsageRef.current = uNow;
          if (uDelta.uncachedInputTokens + uDelta.cacheReadTokens + uDelta.cacheWriteTokens + uDelta.outputTokens > 0) {
            turnCostRef.current += cnyCost(uDelta, Date.now(), currentModel, effectiveTables);
          }
        }
      }
      // 本轮: the turn-scoped exact fold when live events are available,
      // else the projection-diff fallback (no events binding).
      var turnCny = clientEvents !== null ? exactTurnCny : turnCostRef.current;

      // durations: the host snapshot's completed totals + live elapsed. The
      // host snapshot is internally consistent (one log state), so completion
      // is continuous by construction — no clamps, no races.
      var liveLlmMs = 0;
      var liveToolMs = 0;
      if (sessionRunning && liveInfo !== null) {
        if (liveInfo.openStepStart !== null && liveInfo.openStepStart !== void 0) {
          liveLlmMs = Math.max(0, Date.now() - liveInfo.openStepStart);
        }
        // tool start: the host's in-flight tool/call timestamp when present,
        // else the model's tool-call DECISION message time (tool/call events
        // only land in the log after the tool completes — the message
        // timestamp is the only live start signal).
        var toolStart = liveInfo.pendingMin !== null && liveInfo.pendingMin !== void 0
          ? liveInfo.pendingMin
          : liveInfo.toolPhaseStart;
        if (toolStart !== null && toolStart !== void 0) {
          liveToolMs = Math.max(0, Date.now() - toolStart);
        }
      }
      var displayStats = stats;
      if (liveInfo !== null && liveInfo.completed !== null && liveInfo.completed !== void 0) {
        // host-completed figures (whole-log exact)
        displayStats = {
          turns: liveInfo.completed.turns,
          steps: liveInfo.completed.steps,
          llmMs: liveInfo.completed.llmMs + liveLlmMs,
          toolMs: liveInfo.completed.toolMs + liveToolMs,
          ttftMs: liveInfo.completed.ttftMs,
          ttftSteps: liveInfo.completed.ttftSteps,
          decodeMs: liveInfo.completed.decodeMs,
          decodeTokens: liveInfo.completed.decodeTokens
        };
      } else if ((liveLlmMs > 0 || liveToolMs > 0) && stats !== void 0) {
        displayStats = {
          turns: stats.turns,
          steps: stats.steps,
          llmMs: stats.llmMs + liveLlmMs,
          toolMs: stats.toolMs + liveToolMs,
          ttftMs: stats.ttftMs,
          ttftSteps: stats.ttftSteps,
          decodeMs: stats.decodeMs,
          decodeTokens: stats.decodeTokens
        };
      }

      // subagent count for the hover popover (host answer wins when present)
      var subCount = 0;
      try {
        var byIdMap = list !== null && typeof list === "object" && list.byId ? list.byId : {};
        subCount = collectDescendants(byIdMap, sessionId === null ? "" : sessionId).length;
      } catch (e) { subCount = 0; }
      if (serverCost !== null && serverCost.descendantCount > subCount) subCount = serverCost.descendantCount;

      var modelBreakdown = serverCost !== null && Array.isArray(serverCost.models) ? serverCost.models : null;
      var etaText = etaState[0];
      var groups = buildGroups(displayStats, effective, turnCny, sessionCost, balance, {
        subCount: subCount,
        modelBreakdown: modelBreakdown,
        unpricedSteps: unpricedSteps,
        pricingSourceText: pricingSourceText,
        budgetLines: budgetLines,
        spendWarn: spendWarn,
        estimateCny: estimateCny,
        sessionRunning: sessionRunning,
        peakGroup: peakInfo,
        balanceWarnCny: balanceWarnCny,
        balanceCriticalCny: balanceCriticalCny,
        etaText: etaText
      });

      // Separators are independent flex items before each group. Whether a
      // separator fits is calculated from the container's usable width plus
      // the NATURAL widths of every item and one hidden separator probe. This
      // calculation is independent of the currently hidden separators, so it
      // has one stable answer. The previous offsetTop feedback loop could
      // alternate forever at a wrap boundary: showing a separator caused a
      // wrap, hiding it pulled the group back, then showing it wrapped again.
      // That loop was the visible status-line flicker.
      function measureSeps() {
        try {
          var line = lineRef.current;
          if (line == null || groups.length < 2) {
            if (trailingCache.current !== "") {
              trailingCache.current = "";
              setSepHidden([]);
            }
            return;
          }
          var available = Number(line.clientWidth || line.offsetWidth) || 0;
          if (typeof getComputedStyle === "function") {
            var lineStyle = getComputedStyle(line);
            available -= (parseFloat(lineStyle.paddingLeft) || 0) + (parseFloat(lineStyle.paddingRight) || 0);
          }
          if (available <= 0) return;

          function widthOf(el) {
            if (el == null) return 0;
            if (typeof el.getBoundingClientRect === "function") {
              var rect = el.getBoundingClientRect();
              if (rect && Number(rect.width) > 0) return Number(rect.width);
            }
            return Number(el.offsetWidth) || 0;
          }

          var firstWidth = widthOf(itemRefs.current[0]);
          var sepWidth = widthOf(sepProbeRef.current);
          if (typeof getComputedStyle === "function" && sepProbeRef.current != null) {
            var sepStyle = getComputedStyle(sepProbeRef.current);
            sepWidth += (parseFloat(sepStyle.marginLeft) || 0) + (parseFloat(sepStyle.marginRight) || 0);
          }
          if (firstWidth <= 0 || sepWidth <= 0) return;

          // natural widths, cached so the ellide mode never needs the
          // hidden groups' DOM (their spans are not rendered)
          function natWidth(idx) {
            var cached = widthsRef.current[idx];
            if (cached !== void 0 && cached > 0) return cached;
            var w = widthOf(itemRefs.current[idx]);
            if (w > 0) widthsRef.current[idx] = w;
            return w;
          }
          var next = [];
          var rows = [[0]];
          var rowWidth = firstWidth;
          for (var k = 1; k < groups.length; k++) {
            var itemWidth = natWidth(k);
            if (itemWidth <= 0) return;
            var staysOnRow = rowWidth + sepWidth + itemWidth <= available + 0.5;
            next.push(!staysOnRow);
            if (staysOnRow) {
              rows[rows.length - 1].push(k);
              rowWidth += sepWidth + itemWidth;
            } else {
              rows.push([k]);
              rowWidth = itemWidth;
            }
          }
          // trailing-⋯ decision: groups render IN ORDER across at most two
          // rows; the first group that does not fit on the second row (and
          // everything after it) is omitted and a "⋯" marker (\cdots style)
          // is shown at the end of the visible content.
          var ELLIPSE_W = 14; // approximate ⋯ width, reserved on row 2
          var omitFrom = groups.length;
          var rw2 = firstWidth;
          var onRow2 = false;
          for (var k2 = 1; k2 < groups.length; k2++) {
            var iw2 = natWidth(k2);
            if (iw2 <= 0) { omitFrom = k2; break; }
            if (rw2 + sepWidth + iw2 <= available + 0.5) {
              rw2 += sepWidth + iw2;
            } else if (!onRow2) {
              onRow2 = true;
              rw2 = iw2 + ELLIPSE_W; // reserve room for the ⋯ after it
            } else {
              omitFrom = k2;
              break;
            }
          }
          var ell = omitFrom < groups.length ? { omitFrom: omitFrom } : null;
          var prevEll = ellideRef.current;
          if ((ell === null) !== (prevEll === null) ||
              (ell !== null && ell.omitFrom !== prevEll.omitFrom)) {
            ellideRef.current = ell;
            setEllide(ell);
          }
          var sig = next.join(",");
          if (sig !== trailingCache.current) {
            trailingCache.current = sig;
            setSepHidden(next);
          }
        } catch (e) {
          // Measurement is cosmetic — never let it take the line down.
        }
      }
      measureRef.current = measureSeps;
      var groupSignature = groups.map(function (group) { return group.text; }).join("\u0001");
      var useLayoutEffect = typeof react.useLayoutEffect === "function" ? react.useLayoutEffect : react.useEffect;
      useLayoutEffect(function () {
        measureRef.current();
      }, [groupSignature]);
      react.useEffect(function () {
        var el = lineRef.current;
        if (el === null || typeof ResizeObserver === "undefined") return;
        var observer = new ResizeObserver(function () {
          if (measureRef.current) measureRef.current();
        });
        observer.observe(el);
        return function () {
          observer.disconnect();
        };
      }, []);
      // two-row layout with MID-ellipsis: when the natural-width model says
      // the full content needs more than two rows, the first row keeps the
      // leading groups and the last row keeps the trailing groups, with a
      // "⋯" marker between them (latex \cdots style). The decision comes
      // from cached NATURAL widths, independent of what is rendered, so it
      // is stable — hiding groups can never feed back into the decision.
      var ellideState = react.useState(null);
      var ellide = ellideState[0]; // null | { firstRowEnd, lastRowStart }
      var setEllide = ellideState[1];
      var ellideRef = react.useRef(null);
      var widthsRef = react.useRef([]); // per-group natural widths (cached)

      // Never silently disappear: with no data yet (balance not loaded, no
      // usage), render a muted placeholder instead of null, so an empty dock
      // area is always distinguishable from a plugin that failed to mount.
      if (groups.length === 0) {
        return react.createElement(
          "div",
          {
            ref: lineRef,
            className: "dsh-better-stats-line",
            "data-bs": "v20-empty",
            style: { color: "var(--dsw-alias-label-caption)" }
          },
          L.waiting
        );
      }

      itemRefs.current.length = groups.length;
      var items = [
        react.createElement(
          "span",
          {
            key: "sep-probe",
            ref: function (el) { sepProbeRef.current = el; },
            className: "dsh-better-stats-sep dsh-better-stats-sep-probe",
            "aria-hidden": "true"
          },
          "|"
        )
      ];
      for (var gi = 0; gi < groups.length; gi++) {
        var skipped = ellide !== null && gi >= ellide.omitFrom;
        if (skipped) continue;
        if (gi > 0) {
          items.push(
            react.createElement(
              "span",
              {
                key: "sep" + gi,
                className: "dsh-better-stats-sep",
                style: sepHidden[gi - 1] === true
                  ? { minWidth: 0, width: 0, margin: 0 }
                  : void 0
              },
              sepHidden[gi - 1] === true ? "" : "|"
            )
          );
        }
        items.push(
          react.createElement(
            "span",
            {
              key: "grp" + gi,
              ref: (function (idx) {
                return function (el) { itemRefs.current[idx] = el; };
              })(gi),
              className: "dsh-better-stats-item" + (groups[gi].refreshable === true ? " dsh-better-stats-refresh" : ""),
              style: groups[gi].style,
              onClick: groups[gi].refreshable === true
                ? function (e) {
                    e.stopPropagation();
                    if (balanceRefreshRef.current) balanceRefreshRef.current(true);
                  }
                : void 0,
              title: groups[gi].refreshable === true ? L.refreshHint : void 0
            },
            groups[gi].text
          )
        );
        if (ellide !== null && gi === ellide.omitFrom - 1) {
          // trailing ⋯ (latex \cdots): omitted content falls into it
          items.push(
            react.createElement(
              "span",
              {
                key: "ellide-marker",
                className: "dsh-better-stats-item dsh-better-stats-ellipsis",
                "aria-hidden": "true"
              },
              "⋯"
            )
          );
        }
      }

      return react.createElement(
        "div",
        {
          ref: lineRef,
          className: "dsh-better-stats-line",
          "data-bs": "v20",
          onMouseEnter: function () {
            measureAnchor();
            setHovered(true);
          },
          onMouseLeave: function () { setHovered(false); }
        },
        items,
        hovered && anchor !== null
          ? react.createElement(
              "div",
              {
                className: "dsh-better-stats-pop",
                style: {
                  position: "fixed",
                  left: anchor.left + "px",
                  top: anchor.top + "px",
                  transform: "translate(-50%, -100%)"
                }
              },
              groups.map(function (group, i) {
                var popText = group.popover !== void 0 ? group.popover : (group.value !== void 0 ? group.value : group.text);
                var popLines = String(popText).split("\n");
                var rows = popLines.map(function (line, li) {
                  return react.createElement(
                    "div",
                    { key: i + ":" + li, className: "dsh-better-stats-pop-row" },
                    react.createElement(
                      "span",
                      { className: "dsh-better-stats-pop-label" },
                      li === 0 ? group.label : ""
                    ),
                    line
                  );
                });
                // 价源 row lives right under the 花费 group
                if (group.label === "花费" && pricingSourceText !== "") {
                  rows.push(
                    react.createElement(
                      "div",
                      { key: i + ":src", className: "dsh-better-stats-pop-row" },
                      react.createElement("span", { className: "dsh-better-stats-pop-label" }, L.pricingSource),
                      pricingSourceText
                    )
                  );
                }
                // low-balance recharge link (critical tier only)
                if (group.recharge !== null && group.recharge !== void 0 && group.recharge !== "") {
                  rows.push(
                    react.createElement(
                      "div",
                      { key: i + ":recharge", className: "dsh-better-stats-pop-row" },
                      react.createElement("span", { className: "dsh-better-stats-pop-label" }, ""),
                      react.createElement(
                        "a",
                        {
                          className: "dsh-better-stats-pop-link",
                          href: group.recharge,
                          target: "_blank",
                          rel: "noreferrer"
                        },
                        L.recharge
                      )
                    )
                  );
                }
                return rows;
              })
            )
          : null
      );
    }

    var sessionsService = null;

    function apply(ctx) {
      sessionsService = ctx.sessions;
      if (typeof console !== "undefined" && console.log) {
        console.log("[dsh-better-stats] apply: registering conversation.composer.dock entry (v20)");
      }
      ctx.slots.inject("conversation.composer.dock", function () {
        return ctx.slots.register(
          {
            name: "conversation.composer.dock",
            id: "better-stats",
            order: 1
          },
          BetterStatsLine
        );
      });
    }

    exports.apply = apply;
    exports.inject = ["slots", "sessions"];
    return module.exports;
  }
});
