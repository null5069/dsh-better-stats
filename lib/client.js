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
      ".dsh-better-stats-line{position:relative;display:flex;flex-direction:column;align-items:center;max-width:var(--dsh-composer-card-max-width);box-sizing:border-box;width:100%;padding:4px 16px 4px;color:var(--dsw-alias-label-tertiary);margin:0 auto;font-size:12px;line-height:20px;row-gap:2px;max-height:48px;overflow:hidden;font-variant-numeric:tabular-nums}",
      ".dsh-better-stats-row{display:flex;align-items:center;justify-content:center;white-space:nowrap;max-width:100%}",
      ".dsh-better-stats-ellipsis{color:var(--dsw-alias-label-tertiary)}",
      ".dsh-better-stats-item{white-space:nowrap}",
      ".dsh-better-stats-unit{display:inline-flex;align-items:center;white-space:nowrap}",
      ".dsh-better-stats-sep{color:var(--dsw-alias-separator-primary);margin:0 10px;white-space:nowrap}",
      ".dsh-better-stats-sep-hidden{visibility:hidden}",
      ".dsh-better-stats-sep-probe{position:absolute;visibility:hidden;pointer-events:none;left:-10000px;top:0}",
      ".dsh-better-stats-pop{box-sizing:border-box;min-width:220px;max-width:calc(100vw - 32px);max-height:calc(100vh - 24px);overflow-y:auto;overscroll-behavior:contain;border:1px solid var(--dsw-alias-border-inverted);background:var(--dsw-specific-menu);box-shadow:var(--dsw-shadow-lv3);color:var(--dsw-alias-label-secondary);border-radius:12px;padding:10px 14px;font-size:12px;line-height:20px;text-align:left;z-index:100;font-variant-numeric:tabular-nums;display:grid;grid-template-columns:56px auto auto auto;column-gap:12px;align-items:baseline;justify-items:start}",
      ".dsh-better-stats-pop-label{grid-column:1;color:var(--dsw-alias-label-tertiary)}",
      ".dsh-better-stats-pop-c{white-space:nowrap}",
      ".dsh-better-stats-pop-c2{grid-column:2}",
      ".dsh-better-stats-pop-c3{grid-column:3}",
      ".dsh-better-stats-pop-c4{grid-column:4}",
      ".dsh-better-stats-pop-cspan3{grid-column:2 / span 3}",
      ".dsh-better-stats-pop-cspan2{grid-column:3 / span 2}",
      ".dsh-better-stats-pop-cspan1{grid-column:4}",
      ".dsh-better-stats-pop b{color:var(--dsw-alias-label-primary);font-weight:600}",
      ".dsh-better-stats-refresh{cursor:pointer}",
      "@keyframes dsh-better-stats-pulse{0%{filter:brightness(1.7)}35%{filter:brightness(1.7)}100%{filter:brightness(1)}}",
      ".dsh-better-stats-refreshing{animation:dsh-better-stats-pulse .6s ease-out}",
      ".dsh-better-stats-pop-link{color:var(--dsw-alias-brand-primary);text-decoration:none;font-weight:400}",
      ".dsh-better-stats-pop-link-bold{font-weight:700}",
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
        providerDeepSeek: "DeepSeek",
        balance: "余额",
        balanceDash: "余额 --",
        balanceFailed: "余额查询失败",
        granted: "赠送",
        toppedUp: "充值",
        refreshHint: "点击余额可强制刷新",
        recharge: "充值 ↗",
        peakNow: "高峰中",
        offPeakNow: "空闲中",
        peakNowDetail: "高峰中 (价格×2)",
        offPeakNowDetail: "空闲中",
        peakStart: "高峰 {0} 开始",
        offPeakStart: "空闲 {0} 开始",
        inMinutes: "({0} 后)",
        turn: "本轮",
        session: "会话",
        exact: "精确",
        estimate: "估算",
        unpricedNote: " (含 {0} 步未定价 · 模型未知)",
        subSessions: "含 {0} 个子会话",
        turnsSteps: "{0} 轮 · {1} 步",
        tool: "工具",
        ttftAvg: "首 token 平均",
        cache: "缓存",
        hit: "命中",
        totalCache: "会话   缓存 {0} · 命中 {1}%",
        turnTok: "本轮   输入 {0} · 输出 {1}",
        totalTok: "会话   输入 {0} · 输出 {1}",
        input: "输入",
        output: "输出",
        pricingBuiltin: "内置价目(可能过期)",
        pricingOfficialStale: "DeepSeek 官方价目(已过期)",
        pricingSource: "价源",
        pricingKindOfficial: "官方",
        pricingKindBuiltin: "内置价目",
        pricingKindStale: "官方价目(已过期)",
        pricingMediaOfficial: "官网",
        today: "今日",
        dailyBudget: "日预算",
        month: "本月",
        monthlyBudget: "月预算",
        waiting: "better-stats: 等待数据…",
        etaDays: "约可用 {0} 天 {1} 小时",
        etaHours: "约可用 {0} 小时"
      },
      en: {
        providerDeepSeek: "DeepSeek",
        balance: "Balance",
        balanceDash: "Balance --",
        balanceFailed: "Balance query failed",
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
        inMinutes: "(in {0})",
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
        totalCache: "Session   cache {0} · hit {1}%",
        turnTok: "Turn   in {0} · out {1}",
        totalTok: "Session   in {0} · out {1}",
        input: "In",
        output: "Out",
        pricingBuiltin: "Built-in prices (may be stale)",
        pricingOfficialStale: "DeepSeek official prices (stale)",
        pricingSource: "Prices",
        pricingKindOfficial: "Official",
        pricingKindBuiltin: "Built-in",
        pricingKindStale: "Official (stale)",
        pricingMediaOfficial: "Official site",
        today: "Today",
        dailyBudget: "daily budget",
        month: "Month",
        monthlyBudget: "monthly budget",
        waiting: "better-stats: waiting for data…",
        etaDays: "≈ {0}d {1}h left",
        etaHours: "≈ {0}h left"
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
    var BALANCE_CACHE_KEY = "dsh-better-stats:balance:v2"; // v2: label without the old "官方" suffix

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
    function upsertTurnSample(samples, cost, turn, step, usage, model, time, tables, turnUsage) {
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
      // Turn-scoped usage buckets (for the 本轮缓存/本轮命中 popover): the
      // per-step latest sample wins, so the turn totals follow the same
      // delta semantics as the cost.
      if (turnUsage !== void 0 && turnUsage !== null) {
        if (prev !== void 0 && prev.buckets !== void 0) {
          for (var uk = 0; uk < USAGE_KEYS.length; uk++) {
            var ukKey = USAGE_KEYS[uk];
            turnUsage[ukKey] = (turnUsage[ukKey] || 0) - (prev.buckets[ukKey] || 0);
          }
        }
        for (var uk2 = 0; uk2 < USAGE_KEYS.length; uk2++) {
          var ukKey2 = USAGE_KEYS[uk2];
          turnUsage[ukKey2] = (turnUsage[ukKey2] || 0) + (buckets[ukKey2] || 0);
        }
      }
      samples.set(key, {
        cost: newCost,
        model: model !== void 0 ? model : (prev !== void 0 ? prev.model : void 0),
        buckets: buckets
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
        // dd hh format: full days plus the hour remainder (single-digit
        // hours stay unpadded — 1 天 8 小时, not 08); under one day only
        // the hour count is shown.
        if (days >= 1) {
          var d = Math.floor(days);
          var h = Math.floor((days - d) * 24);
          return T(L.etaDays, String(d), String(h));
        }
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
        groups.push({ label: "API", text: balance.label, popover: { rows: [{ c: [balance.label, "", ""] }] } });
        if (balance.amount !== null) {
          // provider-native decimals (DeepSeek sends 2); cached values from
          // older versions lack the field → infer from the amount
          var balDec = balance.decimals !== void 0 ? balance.decimals : moneyDecimals(balance.amount);
          var balText = fmtMoney(currencySymbol(balance.currency), balance.amount, balDec);
          // Popover row: amount in col 2, ETA in col 3, recharge link in col
          // 4 (the label column already says 余额).
          var balPop = balText;
          var etaCell = "";
          if (meta !== null && meta !== void 0 && meta.etaText !== null && meta.etaText !== void 0 && meta.etaText !== "") {
            etaCell = "(" + meta.etaText + ")";
          }
          // Two-tier low-balance alert: defaults amber ¥20 / red ¥5 (config
          // via cordis.patch.yml). The strip shows the tier color + ⚠; the
          // popover no longer repeats the threshold text.
          var balStyle = void 0;
          var balWarn = "";
          var balAmount = Number(balance.amount);
          var alertOn = false;
          if (balanceCriticalCny > 0 && balAmount <= balanceCriticalCny) {
            balStyle = { color: "#ef4444" };
            balWarn = "⚠ ";
            alertOn = true;
          } else if (balanceWarnCny > 0 && balAmount <= balanceWarnCny) {
            balStyle = { color: "#f59e0b" };
            balWarn = "⚠ ";
            alertOn = true;
          }
          // The recharge link is ALWAYS visible, inline at the end of the
          // balance row; it turns bold while a low-balance alert is on.
          groups.push({
            label: "余额",
            text: balWarn + L.balance + " " + balText,
            value: balText,
            popover: { rows: [{ c: [balPop, etaCell, ""] }] },
            style: balStyle,
            refreshable: balance.amount !== null,
            recharge: balance.amount !== null ? "https://platform.deepseek.com/top_up" : null,
            rechargeBold: alertOn
          });
        } else {
          groups.push({ label: "余额", text: balance.text });
        }
      }
      // 峰谷 group: 行内 just 高峰中/空闲中; the popover keeps the detail —
      // current state in col 2, next switch time in col 3, countdown in col
      // 4, with the price-source row right after (峰谷后).
      if (meta !== null && meta !== void 0 && meta.peakGroup !== null && meta.peakGroup !== void 0) {
        var pg = meta.peakGroup;
        var peakRows = [];
        peakRows.push({ c: [pg.peak ? L.peakNowDetail : L.offPeakNowDetail, pg.label, T(L.inMinutes, pg.minutesLeft)] });
        if (meta !== null && meta !== void 0 && meta.pricingSource !== null && meta.pricingSource !== void 0) {
          var ps = meta.pricingSource;
          peakRows.push({ label: L.pricingSource, c: [ps.name || "", ps.media || "", ps.at || ""] });
        }
        groups.push({
          label: "峰谷",
          text: pg.peak ? L.peakNow : L.offPeakNow,
          popover: { rows: peakRows }
        });
      }
      if (usage !== void 0) {
        var totalShown = turnCny + estimateCny;
        // 会话 ticks live too: host-exact settled cost + the in-flight step's
        // estimate, so long generations never sit still.
        var sessionShown = totalCny + estimateCny;
        // inline stays clean (no (估) suffix) — the 精确/估算 breakdown and
        // the fact that the amount includes an estimate live in the popover;
        // both computed amounts at 4 decimals (uniform, movement visible)
        var spendText = L.turn + " " + fmtMoney("¥", totalShown) +
          " · " + L.session + " " + fmtMoney("¥", sessionShown);
        var popRows = [];
        // while a session is running the 本轮 bracket stays put (the estimate
        // may momentarily be 0 between steps — no flicker); 会话 ticks as one
        // number (历史+本轮) without its own breakdown
        if (estimateCny > 0 || sessionRunning) {
          popRows.push({ label: "花费", c: [L.turn, fmtMoney("¥", totalShown, POPOVER_DECIMALS), "(" + L.exact + " " + fmtMoney("¥", turnCny, POPOVER_DECIMALS) + " + " + L.estimate + " " + fmtMoney("¥", estimateCny, POPOVER_DECIMALS) + ")"] });
        } else {
          popRows.push({ label: "花费", c: [L.turn, fmtMoney("¥", turnCny, POPOVER_DECIMALS), ""] });
        }
        popRows.push({ c: [L.session, fmtMoney("¥", sessionShown, POPOVER_DECIMALS), unpricedSteps > 0 ? T(L.unpricedNote, unpricedSteps) : ""] });
        if (meta !== null && meta !== void 0 && meta.budgetLines && meta.budgetLines.length > 0) {
          for (var bl = 0; bl < meta.budgetLines.length; bl++) {
            popRows.push({ c: [meta.budgetLines[bl], "", ""] });
          }
        }
        // Per-model cost module under the spend rows: model in col 2, cost in
        // col 3 (aligned with the 本轮/会话 amounts), share in col 4.
        if (modelBreakdown !== null && modelBreakdown.length > 0) {
          var modelTotal = 0;
          for (var mt = 0; mt < modelBreakdown.length; mt++) {
            var me = modelBreakdown[mt];
            if (me !== void 0 && me !== null && me.model !== "unknown") modelTotal += Number(me.costCny) || 0;
          }
          for (var mb = 0; mb < modelBreakdown.length; mb++) {
            var entry = modelBreakdown[mb];
            if (entry === void 0 || entry === null || entry.model === "unknown") continue;
            var short = String(entry.model).replace("deepseek-", "");
            var costNow = Number(entry.costCny) || 0;
            var pctNow = modelTotal > 0 ? costNow / modelTotal * 100 : 0;
            // model name in col 2 (same as 本轮/会话), cost in col 3, share in col 4
            popRows.push({ c: [short, fmtMoney("¥", costNow, POPOVER_DECIMALS), "(" + pctNow.toFixed(2) + "%)"] });
          }
        }
        if (subCount > 0) popRows.push({ c: [T(L.subSessions, subCount), "", ""] });
        var groupStyle = void 0;
        if (meta !== null && meta !== void 0 && meta.spendWarn === "over") groupStyle = { color: "#ef4444" };
        else if (meta !== null && meta !== void 0 && meta.spendWarn === "warn") groupStyle = { color: "#f59e0b" };
        var warnMark = meta !== null && meta !== void 0 && meta.spendWarn !== null && meta.spendWarn !== void 0 ? "⚠ " : "";
        groups.push({ label: "花费", text: warnMark + spendText, popover: { rows: popRows }, style: groupStyle });
      }
      if (stats && stats.steps > 0) {
        // popover splits 本轮 vs 会话; 轮 in col 3, 步 in col 4. The open
        // step counts immediately (a started turn is already in step 1) —
        // and a freshly started turn with no settled step still shows 1.
        var turnRows = [];
        var tSteps = meta !== null && meta !== void 0 ? (meta.turnSteps || 0) : 0;
        var turnOpenMeta = meta !== null && meta !== void 0 && meta.turnOpen === true;
        var turnActiveMeta = meta !== null && meta !== void 0 && meta.turnActive === true;
        if (turnOpenMeta || (turnActiveMeta && tSteps === 0)) tSteps += 1;
        turnRows.push({ c: [L.turn, "1 轮", tSteps + " 步"] });
        turnRows.push({ c: [L.session, stats.turns + " 轮", stats.steps + " 步"] });
        groups.push({ label: "轮次", text: T(L.turnsSteps, stats.turns, stats.steps), popover: { rows: turnRows } });
        var durations = [];
        if (stats.llmMs > 0) durations.push("LLM " + formatDuration(stats.llmMs));
        if (stats.toolMs > 0) durations.push(L.tool + " " + formatDuration(stats.toolMs));
        if (durations.length > 0) {
          // popover splits 本轮 vs 会话: turn LLM time from the client fold,
          // plus the in-flight tool phase (client events carry no tool/call);
          // LLM in col 3, 工具 in col 4 — empty slots show 0s to keep the
          // columns aligned.
          var timeRows = [];
          var ts2 = meta !== null && meta !== void 0 && meta.turnSpeed ? meta.turnSpeed : null;
          // the open step's elapsed LLM time ticks live (settled steps +
          // in-flight duration), driven by the 250ms ticker
          var openStepElapsed = 0;
          if (ts2 !== null && ts2.openStep !== null && typeof ts2.openStep.startTime === "number") {
            openStepElapsed = Math.max(0, Date.now() - ts2.openStep.startTime);
          }
          var turnLlmTotal = (ts2 !== null ? (ts2.llmMs || 0) : 0) + openStepElapsed;
          var turnLlm = turnLlmTotal > 0 ? "LLM " + formatDuration(turnLlmTotal) : "LLM 0s";
          var turnTool = "工具 0s";
          var tpStart = meta !== null && meta !== void 0 ? (meta.toolPhaseStart || null) : null;
          if (tpStart !== null) turnTool = L.tool + " " + formatDuration(Date.now() - tpStart);
          timeRows.push({ c: [L.turn, turnLlm, turnTool] });
          var sessLlm = stats.llmMs > 0 ? "LLM " + formatDuration(stats.llmMs) : "LLM 0s";
          var sessTool = stats.toolMs > 0 ? L.tool + " " + formatDuration(stats.toolMs) : "工具 0s";
          timeRows.push({ c: [L.session, sessLlm, sessTool] });
          groups.push({ label: "耗时", text: durations.join(" · "), popover: { rows: timeRows } });
        }
        var speeds = [];
        if (stats.ttftSteps > 0) speeds.push(L.ttftAvg + " " + formatTtft(stats.ttftMs / stats.ttftSteps));
        if (stats.decodeMs > 0) speeds.push(formatTps(stats.decodeTokens / (stats.decodeMs / 1000)));
        if (speeds.length > 0) {
          // popover splits 本轮 vs 会话 (turn-level fold from the event
          // stream). While the session runs the 本轮 row stays visible —
          // "--" until the first token lands, then it ticks live.
          var speedRows = [];
          var ts2 = meta !== null && meta !== void 0 && meta.turnSpeed ? meta.turnSpeed : null;
          var sessionRunningMeta = meta !== null && meta !== void 0 && meta.sessionRunning === true;
          if (sessionRunningMeta || (ts2 !== null && ts2.ttftSteps > 0)) {
            var tTtft = ts2 !== null && ts2.ttftSteps > 0 ? L.ttftAvg + " " + formatTtft(ts2.ttftMs / ts2.ttftSteps) : L.ttftAvg + " --";
            var tTps = ts2 !== null && ts2.decodeMs > 0 ? formatTps(ts2.decodeTokens / (ts2.decodeMs / 1000)) : "--";
            speedRows.push({ c: [L.turn, tTtft, tTps] });
          }
          var sParts = [];
          if (stats.ttftSteps > 0) sParts.push(L.ttftAvg + " " + formatTtft(stats.ttftMs / stats.ttftSteps));
          if (stats.decodeMs > 0) sParts.push(formatTps(stats.decodeTokens / (stats.decodeMs / 1000)));
          if (sParts.length > 0) {
            speedRows.push({
              c: [L.session, stats.ttftSteps > 0 ? L.ttftAvg + " " + formatTtft(stats.ttftMs / stats.ttftSteps) : "", stats.decodeMs > 0 ? formatTps(stats.decodeTokens / (stats.decodeMs / 1000)) : ""]
            });
          }
          groups.push({ label: "速率", text: speeds.join(" · "), popover: { rows: speedRows } });
        }
      }
      if (usage !== void 0 && (billedInputTokens(usage) > 0 || usage.outputTokens > 0)) {
        var hit = cacheHitPercent(usage);
        if (hit !== null) {
          // 缓存命中组（倒数第二）— popover splits 本轮 vs 会话 so a fresh
          // topic's turn cache is not mistaken for the session-wide hit rate.
          var cacheRows = [];
          var tu = meta !== null && meta !== void 0 && meta.turnUsage ? meta.turnUsage : null;
          var sessionRunningMeta = meta !== null && meta !== void 0 && meta.sessionRunning === true;
          var hadTurnMeta = meta !== null && meta !== void 0 && meta.hadTurn === true;
          if (tu !== null && ((tu.cacheReadTokens || 0) > 0 || billedInputTokens(tu) > 0 || sessionRunningMeta || hadTurnMeta)) {
            // the turn's cache ticks live: settled + eased-in step estimate,
            // so the row appears at 0 and grows instead of blinking in
            var tCache = (tu.cacheReadTokens || 0) + (meta !== null && meta !== void 0 ? (meta.estCacheTokens || 0) : 0);
            var tIn = billedInputTokens(tu) + (meta !== null && meta !== void 0 ? (meta.estInputTokens || 0) : 0);
            var tTot = tCache + tIn;
            var thit = tTot > 0 ? (tCache / tTot * 100).toFixed(2) : "0.00";
            cacheRows.push({ c: [L.turn, "缓存 " + fmtTokens(tCache), "命中 " + thit + "%"] });
          }
          cacheRows.push({ c: [L.session, "缓存 " + fmtTokens(usage.cacheReadTokens || 0), "命中 " + hit + "%"] });
          groups.push({
            label: "缓存",
            text: L.cache + " " + fmtTokens(usage.cacheReadTokens || 0) + " · " + L.hit + " " + hit + "%",
            popover: { rows: cacheRows }
          });
        }
        // 输入输出组（倒数第一）— label "Tok" 与左侧双字标签对称；popover
        // splits 本轮 vs 会话 like the cache group, then lists per-model
        // token counts (with cost share) under the 会话 row.
        var tokRows = [];
        var tu2 = meta !== null && meta !== void 0 && meta.turnUsage ? meta.turnUsage : null;
        var sessionRunningMeta = meta !== null && meta !== void 0 && meta.sessionRunning === true;
        var hadTurnMeta = meta !== null && meta !== void 0 && meta.hadTurn === true;
        if (tu2 !== null && (billedInputTokens(tu2) > 0 || (tu2.outputTokens || 0) > 0 || sessionRunningMeta || hadTurnMeta)) {
          // the turn's tokens tick live: settled + the in-flight streaming
          // estimate (input eases in per frame, output grows with the stream)
          var turnOut = (tu2.outputTokens || 0) + (meta !== null && meta !== void 0 ? (meta.estOutputTokens || 0) : 0);
          var turnIn = billedInputTokens(tu2) + (meta !== null && meta !== void 0 ? (meta.estInputTokens || 0) : 0);
          tokRows.push({ c: [L.turn, "输入 " + fmtTokens(turnIn), "输出 " + fmtTokens(turnOut)] });
        }
        // per-model token counts (会话口径): input/output amounts, not billing
        // figures. The current model's row also carries the streaming estimate
        // (eased input + growing output), so it ticks live mid-generation.
        // The 会话 row and every share denominator come from the SUM of these
        // SAME rows — one source of truth that ticks with the per-model rows,
        // so shares can never exceed 100% mid-turn (the old host-total
        // denominator lagged the live rows by a poll and let them overshoot).
        var liveTotalIn = 0;
        var liveTotalOut = 0;
        var modelRows = [];
        if (modelBreakdown !== null && modelBreakdown.length > 0) {
          var estModel = meta !== null && meta !== void 0 ? meta.estModel : void 0;
          for (var tm2 = 0; tm2 < modelBreakdown.length; tm2++) {
            var tent = modelBreakdown[tm2];
            if (tent === void 0 || tent === null || tent.model === "unknown") continue;
            // usage may be absent while the host poll hasn't settled the
            // model yet — the CURRENT model's row then shows the streaming
            // estimate, so it never blinks out mid-generation
            var u = tent.usage;
            var uIn = u !== void 0 && u !== null ? billedInputTokens(u) : 0;
            var uOut = u !== void 0 && u !== null ? (u.outputTokens || 0) : 0;
            if (typeof estModel === "string" && tent.model === estModel) {
              uIn += meta !== null && meta !== void 0 ? (meta.estInputTokens || 0) : 0;
              uOut += meta !== null && meta !== void 0 ? (meta.estOutputTokens || 0) : 0;
            }
            // skip models with no real usage and no live estimate — a 0/0
            // row is noise
            if (uIn <= 0 && uOut <= 0) continue;
            liveTotalIn += uIn;
            liveTotalOut += uOut;
            modelRows.push({ model: String(tent.model).replace("deepseek-", ""), uIn: uIn, uOut: uOut });
          }
        }
        var hasModelRows = modelRows.length > 0;
        var sessIn = hasModelRows ? liveTotalIn : billedInputTokens(usage);
        var sessOut = hasModelRows ? liveTotalOut : (usage.outputTokens || 0);
        tokRows.push({ c: [L.session, "输入 " + fmtTokens(sessIn), "输出 " + fmtTokens(sessOut)] });
        for (var mri = 0; mri < modelRows.length; mri++) {
          var mrow = modelRows[mri];
          var inPct = liveTotalIn > 0 ? (mrow.uIn / liveTotalIn * 100).toFixed(2) : "0.00";
          var outPct = liveTotalOut > 0 ? (mrow.uOut / liveTotalOut * 100).toFixed(2) : "0.00";
          tokRows.push({ c: [mrow.model, "输入 " + fmtTokens(mrow.uIn) + " (" + inPct + "%)", "输出 " + fmtTokens(mrow.uOut) + " (" + outPct + "%)"] });
        }
        groups.push({
          label: "Tok",
          text: L.input + " " + fmtTokens(sessIn) + " · " + L.output + " " + fmtTokens(sessOut),
          popover: { rows: tokRows }
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
        inputTarget: 0,    // step-start input cost, eased in to avoid the jump
        inputShown: 0,     // displayed input cost (asymptotic toward target)
        inputTokTarget: 0, // step-start uncached input tokens, eased in so the
        inputTokShown: 0,  // Tok popover's 本轮输入 ticks live too
        cacheTokTarget: 0, // step-start cache-read tokens, eased in so the
        cacheTokShown: 0,  // cache popover's 本轮缓存 ticks live too
        lastUsage: null,   // { inputTokens, cacheReadTokens } of the last settled step
        lastModel: void 0, // last model seen (prices usage chunks when the
                           // browser stream omits the message usage/model)
        sawStepStart: false,
        turnCost: 0,       // exact cost of the current TURN (per-step fold)
        turnSamples: new Map(), // "turn:step" → { cost, model }
        turnUsage: { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }, // 本轮 usage buckets (popover 缓存 split)
        turnSpeed: { ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0, llmMs: 0, openStep: null }, // 本轮 TTFT/速率/LLM fold
        turnSteps: 0,    // steps settled in the current turn (popover 轮次)
        turnActive: false,  // folds only after the first turn/start (or a
                            // restored-session step/start), so pre-loaded
                            // history never leaks into 本轮
        curTurn: null,   // the PARENT turn's number (from turn/start..turn/end);
                         // spliced subagent events carry their own turn numbers,
                         // so events whose data.turn differs must not steer the
                         // model attribution (estimate, usage chunks)
        hadTurn: false,  // a turn has started since page load — keeps the
                         // 本轮缓存/本轮 Tok rows visible after a termination
                         // even when the turn settled nothing
        sessStat: {      // whole-session stats folded from the live stream
                         // (mirrors the host foldLive): 轮次/耗时 popover rows
                         // tick with every settled event instead of the 1s poll
          turns: 0, steps: 0, llmMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0,
          lastTurn: null, openStep: null
        }
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
      // Click-to-refresh on the balance group (model/API switches don't
      // auto-refresh): a click flashes the group once and forces the query.
      var balanceRefreshRef = react.useRef(null); // force refresh, set below
      var refreshPulseState = react.useState(false);
      var refreshPulse = refreshPulseState[0];
      var setRefreshPulse = refreshPulseState[1];
      // Explicit row layout: { rowBreak, omitFrom } computed from measured
      // natural widths. Rendering splits the units into two explicit rows so
      // the flex line can never wrap on its own (which is what stranded "|"
      // at row ends before). null until the first measurement.
      var layoutState = react.useState(null);
      var layout = layoutState[0];
      var setLayout = layoutState[1];
      var layoutRef = react.useRef(null); // last committed layout
      // 100ms hide grace: the popover sits above the line; leaving the line
      // toward it must not kill it instantly. Entering either side cancels
      // the pending hide.
      var hideTimerRef = react.useRef(null);
      function scheduleHide() {
        if (hideTimerRef.current !== null) clearTimeout(hideTimerRef.current);
        hideTimerRef.current = setTimeout(function () { setHovered(false); }, 100);
      }
      function cancelHide() {
        if (hideTimerRef.current !== null) {
          clearTimeout(hideTimerRef.current);
          hideTimerRef.current = null;
        }
      }
      // Session-level per-model fold from the LIVE event stream: usage lands
      // → the model row appears immediately (the host /live poll only
      // refreshes once per second, which is the "卡一下" after a model
      // switch). Host figures still win when present (they include the
      // subagent tree); the client fold only fills the gap.
      var sessionModelRef = react.useRef({
        lastModel: void 0,
        samples: new Map(),   // "turn:step" → { cost, model } (latest wins)
        byModel: new Map()    // model → costCny
      });
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
              var b2 = budgetRef.current;
              if (b2 === null || !(Number(b2.daily) > 0 || Number(b2.monthly) > 0)) {
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

      // ── fast live ticker ──────────────────────────────────────────────────
      // The 1s host poll is the only steady render driver, so elapsed-style
      // values (本轮 LLM/工具 elapsed, eased input/cache, 会话 Tok totals)
      // would only move once a second during tool phases (no parent
      // re-renders). A 250ms tick keeps every live number moving while the
      // session runs; idle sessions skip the bump entirely.
      var tickState = react.useState(0);
      var tickBump = tickState[1];
      var runningRef = react.useRef(false);
      react.useEffect(function () {
        var timer = setInterval(function () {
          if (runningRef.current === true) tickBump(function (t) { return t + 1; });
        }, 250);
        return function () { clearInterval(timer); };
      }, []);

      // session running bit (from the list) — gates the live parts
      var sessionRunning = false;
      try {
        var listById = list !== null && typeof list === "object" ? list.byId : null;
        sessionRunning = !!(listById && sessionId !== null && listById[sessionId] && listById[sessionId].running === true);
      } catch (e) { sessionRunning = false; }
      runningRef.current = sessionRunning;

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
      // Structured source for the 4-column 价源 row: provider | media | fetched
      var pricingSourceRow = { name: L.pricingKindBuiltin, media: "", at: "" };
      if (hostPricing !== null && hostPricing.source === "official") {
        pricingSourceText = L.providerDeepSeek + " " + beijingDateLabel(hostPricing.fetchedAt);
        pricingSourceRow = { name: "DeepSeek", media: L.pricingMediaOfficial, at: beijingDateLabel(hostPricing.fetchedAt) };
      } else if (hostPricing !== null && hostPricing.source === "stale") {
        pricingSourceText = L.pricingOfficialStale;
        pricingSourceRow = { name: "DeepSeek", media: L.pricingKindStale, at: "" };
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
            var turnUsage = estState.turnUsage;
            var turnSpeed = estState.turnSpeed;
            var turnActive = estState.turnActive;
            var curTurn = estState.curTurn;
            var sessStat = estState.sessStat;
            var hadTurn = estState.hadTurn;
            // Whole-session stats folded from the live stream (mirror of the
            // host's foldLive): 轮次/耗时 popover rows tick with every settled
            // event instead of the 1s host poll. Tool time stays host-only —
            // the client stream carries no tool/call / tool/result events.
            function sessStatFold(ev) {
              var d = ev.data;
              if (d === void 0 || d === null) return;
              switch (ev.type) {
                case "step/start":
                  sessStat.openStep = { turn: d.turn, step: d.step, startTime: ev.time, firstTokenTime: null };
                  break;
                case "assistant/chunk": {
                  var open = sessStat.openStep;
                  if (open !== null && open.turn === d.turn && open.step === d.step && open.firstTokenTime === null && d.chunk !== void 0 && d.chunk !== null) {
                    var c = d.chunk;
                    var isTok = c.type === "text-delta" || c.type === "reasoning-delta" ? c.text !== "" : (c.type === "tool-call-delta" ? (c.argumentsDelta !== "" || c.name !== void 0) : false);
                    if (isTok) open.firstTokenTime = ev.time;
                  }
                  break;
                }
                case "assistant/message": {
                  var open2 = sessStat.openStep;
                  if (open2 !== null && open2.turn === d.turn && open2.step === d.step) {
                    if (typeof ev.time === "number" && typeof open2.startTime === "number") {
                      sessStat.llmMs += Math.max(0, ev.time - open2.startTime);
                      if (open2.firstTokenTime !== null && typeof open2.firstTokenTime === "number") {
                        sessStat.ttftMs += Math.max(0, open2.firstTokenTime - open2.startTime);
                        sessStat.ttftSteps += 1;
                        var outTok = d.usage !== void 0 && typeof d.usage.outputTokens === "number" ? d.usage.outputTokens : null;
                        if (outTok !== null) {
                          sessStat.decodeMs += Math.max(0, ev.time - open2.firstTokenTime);
                          sessStat.decodeTokens += outTok;
                        }
                      }
                    }
                    sessStat.openStep = null;
                  }
                  break;
                }
                case "step/end":
                  sessStat.turns = sessStat.lastTurn === d.turn ? sessStat.turns : sessStat.turns + 1;
                  sessStat.steps += 1;
                  sessStat.lastTurn = d.turn;
                  sessStat.openStep = null;
                  break;
                default:
                  break;
              }
            }
            // Session-level per-model fold: latest usage sample per step wins,
            // priced at the event time with the producing model. Only events of
            // the PARENT turn (data.turn === curTurn) fold here: spliced
            // subagent transcripts carry their own turn numbers and their
            // usage is covered by the host's fold — letting them steer
            // sm.lastModel made the parent's in-flight chunks and streaming
            // estimate land on the subagent's model.
            function sessionModelUpsert(ev) {
              // only events of the PARENT turn fold once its number is known
              // (data.turn === curTurn); without a turn boundary the fold
              // keeps the historical behaviour (streams that omit turn events)
              if (ev.data === void 0 || ev.data === null) return;
              if (curTurn !== null && ev.data.turn !== curTurn) return;
              var sm = sessionModelRef.current;
              var usage = null;
              var model = void 0;
              if (ev.type === "assistant/chunk" && ev.data.chunk !== void 0 && ev.data.chunk.type === "usage") {
                usage = ev.data.chunk.usage;
                model = sm.lastModel;
              } else if (ev.type === "assistant/message" && ev.data.message !== void 0) {
                var m = ev.data.message.source && typeof ev.data.message.source.model === "string" ? ev.data.message.source.model : void 0;
                if (m !== void 0 && m !== "") sm.lastModel = m;
                if (ev.data.usage !== void 0 && ev.data.usage !== null) { usage = ev.data.usage; model = sm.lastModel; }
              }
              if (usage === null || usage === void 0 || model === void 0 || model === null) return;
              var buckets = {
                uncachedInputTokens: Number(usage.inputTokens) || 0,
                cacheReadTokens: Number(usage.cacheReadTokens) || 0,
                cacheWriteTokens: Number(usage.cacheWriteTokens) || 0,
                outputTokens: Number(usage.outputTokens) || 0,
                reasoningTokens: Number(usage.reasoningTokens) || 0
              };
              var cost = cnyCost(buckets, ev.time, model, effectiveTables);
              var key = ev.data.turn + ":" + ev.data.step;
              var prev = sm.samples.get(key);
              if (prev !== void 0) {
                var prevEntry = sm.byModel.get(prev.model);
                if (prevEntry !== void 0) {
                  prevEntry.cost -= prev.cost;
                  if (prevEntry.usage !== void 0 && prev.usage !== void 0) {
                    for (var ukp = 0; ukp < USAGE_KEYS.length; ukp++) {
                      var ukpK = USAGE_KEYS[ukp];
                      prevEntry.usage[ukpK] = (prevEntry.usage[ukpK] || 0) - (prev.usage[ukpK] || 0);
                    }
                  }
                }
              }
              var entry = sm.byModel.get(model);
              if (entry === void 0) {
                entry = { cost: 0, usage: { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 } };
                sm.byModel.set(model, entry);
              }
              entry.cost += cost;
              for (var uk3 = 0; uk3 < USAGE_KEYS.length; uk3++) {
                var uk3K = USAGE_KEYS[uk3];
                entry.usage[uk3K] = (entry.usage[uk3K] || 0) + (buckets[uk3K] || 0);
              }
              sm.samples.set(key, { cost: cost, model: model, usage: buckets });
            }
            for (var ei = estState.next; ei < estLen; ei++) {
              var ev = clientEvents[ei];
              if (ev === void 0 || ev === null || typeof ev !== "object") continue;
              sessStatFold(ev);
              if (ev.type === "turn/start") {
                // new turn: the exact base restarts (本轮 = 这一轮的)
                turnSamples = new Map();
                turnCost = 0;
                turnActive = true;
                hadTurn = true;
                curTurn = ev.data !== void 0 && ev.data !== null ? ev.data.turn : null;
                estState.turnUsage = { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
                turnUsage = estState.turnUsage;
                estState.turnSpeed = { ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0, llmMs: 0, openStep: null };
                turnSpeed = estState.turnSpeed;
                estState.turnSteps = 0;
                reason.cjk = 0; reason.rest = 0;
                text.cjk = 0; text.rest = 0;
                tool.cjk = 0; tool.rest = 0;
                inputCny = 0;
                estState.inputShown = 0;
                estState.inputTarget = 0;
                estState.inputTokShown = 0;
                estState.inputTokTarget = 0;
                estState.cacheTokShown = 0;
                estState.cacheTokTarget = 0;
                sawStepStart = false;
              } else if (ev.type === "turn/end") {
                // turn complete: KEEP the final turn cost on display (本轮
                // resets to 0 only at the NEXT turn/start); counters reset
                // so the next turn's estimate starts clean
                turnActive = false;
                curTurn = null;
                reason.cjk = 0; reason.rest = 0;
                text.cjk = 0; text.rest = 0;
                tool.cjk = 0; tool.rest = 0;
                inputCny = 0;
                estState.inputShown = 0;
                estState.inputTarget = 0;
                estState.inputTokShown = 0;
                estState.inputTokTarget = 0;
                estState.cacheTokShown = 0;
                estState.cacheTokTarget = 0;
                sawStepStart = false;
              } else if (!turnActive) {
                // fold stays dormant until the first turn/start, so pre-loaded
                // history (restored sessions) never leaks into 本轮; restored
                // sessions carry their turn/start in the event stream anyway
                sessionModelUpsert(ev);
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
                  turnCost = upsertTurnSample(turnSamples, turnCost, ev.data.turn, ev.data.step, ck.usage, lastModel, ev.time, effectiveTables, turnUsage);
                  sessionModelUpsert(ev);
                  reason.cjk = 0; reason.rest = 0;
                  text.cjk = 0; text.rest = 0;
                  tool.cjk = 0; tool.rest = 0;
                  inputCny = 0;
                  estState.inputShown = 0;
                  estState.inputTarget = 0;
                  estState.inputTokShown = 0;
                  estState.inputTokTarget = 0;
                  estState.cacheTokShown = 0;
                  estState.cacheTokTarget = 0;
                  sawStepStart = false;
                  lastUsage = {
                    inputTokens: Number(ck.usage.inputTokens) || 0,
                    cacheReadTokens: Number(ck.usage.cacheReadTokens) || 0
                  };
                } else if (ck.type === "text-delta" || ck.type === "reasoning-delta") {
                  // legacy fallback: the sampled delta events (tiny subset;
                  // counted only when batch events are absent)
                  classifyChars(ck.type === "reasoning-delta" ? reason : text, typeof ck.text === "string" ? ck.text : "");
                  // first token of the open step → TTFT anchor
                  if (turnSpeed.openStep !== null && turnSpeed.openStep.firstTokenTime === null && typeof ev.time === "number") {
                    turnSpeed.openStep.firstTokenTime = ev.time;
                  }
                }
              } else if (ev.type === "assistant/message" && ev.data !== void 0 && ev.data.message !== void 0) {
                var msgModel = ev.data.message && ev.data.message.source ? ev.data.message.source.model : void 0;
                // only the PARENT turn's messages steer the estimate model —
                // spliced subagent messages (their own turn numbers) must not
                // hijack the streaming estimate of the turn in progress
                if (typeof msgModel === "string" && msgModel !== "" && ev.data.turn === curTurn) lastModel = msgModel;
                // Turn-scoped TTFT/decode fold (mirrors the host's foldLive).
                var os = turnSpeed.openStep;
                if (os !== null && os.turn === ev.data.turn && os.step === ev.data.step) {
                  if (typeof ev.time === "number" && typeof os.startTime === "number") {
                    turnSpeed.llmMs += Math.max(0, ev.time - os.startTime);
                    if (os.firstTokenTime !== null && typeof os.firstTokenTime === "number") {
                      turnSpeed.ttftMs += Math.max(0, ev.time - os.startTime);
                      turnSpeed.ttftSteps += 1;
                      var outT = ev.data.usage !== void 0 && typeof ev.data.usage.outputTokens === "number"
                        ? ev.data.usage.outputTokens
                        : (ev.data.message.usage !== void 0 && typeof ev.data.message.usage.outputTokens === "number" ? ev.data.message.usage.outputTokens : null);
                      if (outT !== null) {
                        turnSpeed.decodeMs += Math.max(0, ev.time - os.firstTokenTime);
                        turnSpeed.decodeTokens += outT;
                      }
                    }
                  }
                  turnSpeed.openStep = null;
                }
                if (ev.data.usage !== void 0) {
                  calibrateEstDensity(estState, reason, text, tool, ev.data.usage);
                  turnCost = upsertTurnSample(turnSamples, turnCost, ev.data.turn, ev.data.step, ev.data.usage, msgModel, ev.time, effectiveTables, turnUsage);
                  sessionModelUpsert(ev);
                  reason.cjk = 0; reason.rest = 0;
                  text.cjk = 0; text.rest = 0;
                  tool.cjk = 0; tool.rest = 0;
                  inputCny = 0;
                  estState.inputShown = 0;
                  estState.inputTarget = 0;
                  estState.inputTokShown = 0;
                  estState.inputTokTarget = 0;
                  estState.cacheTokShown = 0;
                  estState.cacheTokTarget = 0;
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
                turnSpeed.openStep = {
                  turn: ev.data !== void 0 ? ev.data.turn : void 0,
                  step: ev.data !== void 0 ? ev.data.step : void 0,
                  startTime: ev.time,
                  firstTokenTime: null
                };
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
                  // ease the input cost in over a few frames instead of
                  // jumping the whole step's input at once
                  estState.inputTarget = inputCny;
                  estState.inputTokTarget = Number(lastUsage.inputTokens) || 0;
                  estState.cacheTokTarget = Number(lastUsage.cacheReadTokens) || 0;
                }
                sawStepStart = true;
              } else if (ev.type === "step/end") {
                turnSpeed.openStep = null;
                estState.turnSteps = (estState.turnSteps || 0) + 1;
                reason.cjk = 0; reason.rest = 0;
                text.cjk = 0; text.rest = 0;
                tool.cjk = 0; tool.rest = 0;
                inputCny = 0;
                estState.inputShown = 0;
                estState.inputTarget = 0;
                estState.inputTokShown = 0;
                estState.inputTokTarget = 0;
                estState.cacheTokShown = 0;
                estState.cacheTokTarget = 0;
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
              inputTarget: estState.inputTarget,
              inputShown: estState.inputShown,
              inputTokTarget: estState.inputTokTarget,
              inputTokShown: estState.inputTokShown,
              cacheTokTarget: estState.cacheTokTarget,
              cacheTokShown: estState.cacheTokShown,
              lastUsage: lastUsage,
              lastModel: lastModel,
              sawStepStart: sawStepStart,
              turnCost: turnCost,
              turnSamples: turnSamples,
              turnUsage: estState.turnUsage,
              turnSpeed: estState.turnSpeed,
              turnSteps: estState.turnSteps,
              turnActive: turnActive,
              curTurn: curTurn,
              hadTurn: hadTurn,
              sessStat: sessStat
            };
          }
          exactTurnCny = estimateRef.current.turnCost;
          if (sessionRunning && liveInfo !== null && liveInfo.openStepStart !== null && liveInfo.openStepStart !== void 0) {
            var estOutPrice = 0;
            // price the in-flight estimate with the PARENT turn's model (the
            // guarded lastModel), not the global current-model scan — a
            // spliced subagent message must not re-price the parent's stream
            var estPriceModel = estimateRef.current.lastModel !== void 0 && estimateRef.current.lastModel !== null
              ? estimateRef.current.lastModel
              : currentModel;
            var estTable = effectiveTables[modelKeyOf(estPriceModel)];
            if (estTable !== void 0 && estTable !== null) {
              var estPeak = beijingPeak(Date.now());
              estOutPrice = estPeak ? estTable.outPeak : estTable.out;
            }
            var estCur = estimateRef.current;
            // input cost eases in asymptotically (45%/frame) — the step's
            // input no longer jumps in all at once
            estCur.inputShown = estCur.inputShown + (estCur.inputTarget - estCur.inputShown) * 0.45;
            estCur.inputTokShown = estCur.inputTokShown + (estCur.inputTokTarget - estCur.inputTokShown) * 0.45;
            estCur.cacheTokShown = estCur.cacheTokShown + (estCur.cacheTokTarget - estCur.cacheTokShown) * 0.45;
            var estTokens =
              (estCur.reason.cjk + estCur.reason.rest / estCur.reasonDensity) +
              (estCur.text.cjk + estCur.text.rest / estCur.outputDensity) +
              (estCur.tool.cjk + estCur.tool.rest / estCur.outputDensity);
            estimateCny = estTokens * estOutPrice / 1e6 + estCur.inputShown;
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
      // Live session stats: the client-side fold (sessStat) covers the same
      // events as the host's foldLive but updates the moment each event lands,
      // so 轮次/耗时 tick with the stream instead of the 1s poll. The host
      // answer wins when it knows MORE (spliced subagent events the client
      // stream may not carry); tool time stays host-only either way.
      var estRefStats = estimateRef.current;
      var sessReady = estRefStats !== null && typeof estRefStats.next === "number" && estRefStats.next > 0 && estRefStats.sessStat !== void 0 && estRefStats.sessStat !== null;
      var hostTurns = 0, hostSteps = 0, hostLlmMs = 0, hostTtftMs = 0, hostTtftSteps = 0, hostDecodeMs = 0, hostDecodeTokens = 0, hostToolMs = 0;
      if (liveInfo !== null && liveInfo.completed !== null && liveInfo.completed !== void 0) {
        hostTurns = Number(liveInfo.completed.turns) || 0;
        hostSteps = Number(liveInfo.completed.steps) || 0;
        hostLlmMs = Number(liveInfo.completed.llmMs) || 0;
        hostTtftMs = Number(liveInfo.completed.ttftMs) || 0;
        hostTtftSteps = Number(liveInfo.completed.ttftSteps) || 0;
        hostDecodeMs = Number(liveInfo.completed.decodeMs) || 0;
        hostDecodeTokens = Number(liveInfo.completed.decodeTokens) || 0;
        hostToolMs = Number(liveInfo.completed.toolMs) || 0;
      } else if (stats !== void 0) {
        hostTurns = Number(stats.turns) || 0;
        hostSteps = Number(stats.steps) || 0;
        hostLlmMs = Number(stats.llmMs) || 0;
        hostTtftMs = Number(stats.ttftMs) || 0;
        hostTtftSteps = Number(stats.ttftSteps) || 0;
        hostDecodeMs = Number(stats.decodeMs) || 0;
        hostDecodeTokens = Number(stats.decodeTokens) || 0;
        hostToolMs = Number(stats.toolMs) || 0;
      }
      var ss = sessReady ? estRefStats.sessStat : null;
      displayStats = {
        turns: ss !== null ? Math.max(hostTurns, ss.turns) : hostTurns,
        steps: ss !== null ? Math.max(hostSteps, ss.steps) : hostSteps,
        llmMs: (ss !== null ? Math.max(hostLlmMs, ss.llmMs) : hostLlmMs) + liveLlmMs,
        toolMs: hostToolMs + liveToolMs,
        ttftMs: ss !== null ? Math.max(hostTtftMs, ss.ttftMs) : hostTtftMs,
        ttftSteps: ss !== null ? Math.max(hostTtftSteps, ss.ttftSteps) : hostTtftSteps,
        decodeMs: ss !== null ? Math.max(hostDecodeMs, ss.decodeMs) : hostDecodeMs,
        decodeTokens: ss !== null ? Math.max(hostDecodeTokens, ss.decodeTokens) : hostDecodeTokens
      };

      // subagent count for the hover popover (host answer wins when present)
      var subCount = 0;
      try {
        var byIdMap = list !== null && typeof list === "object" && list.byId ? list.byId : {};
        subCount = collectDescendants(byIdMap, sessionId === null ? "" : sessionId).length;
      } catch (e) { subCount = 0; }
      if (serverCost !== null && serverCost.descendantCount > subCount) subCount = serverCost.descendantCount;

      // Per-model costs tick every second like the 本轮/会话 amounts: the
      // /live route (1s poll) carries per-model figures; the /cost route
      // (15s) is the whole-tree fallback while live hasn't answered.
      var hostModelList = liveInfo !== null && Array.isArray(liveInfo.models) && liveInfo.models.length > 0
        ? liveInfo.models
        : (serverCost !== null && Array.isArray(serverCost.models) ? serverCost.models : null);
      // The live event-stream fold fills the gap right after a model switch
      // (host figures lag by up to a poll); host values win when present.
      var clientByModel = sessionModelRef.current !== null ? sessionModelRef.current.byModel : null;
      var modelBreakdown = hostModelList;
      if (clientByModel !== null && clientByModel.size > 0) {
        var hostByName = {};
        if (hostModelList !== null) {
          for (var hb = 0; hb < hostModelList.length; hb++) {
            var he = hostModelList[hb];
            if (he !== void 0 && he !== null) hostByName[he.model] = he;
          }
        }
        var merged = [];
        clientByModel.forEach(function (entry, model) {
          var hEntry = hostByName[model];
          if (hEntry !== void 0) {
            // host wins on cost AND keeps its usage buckets (the client fold
            // only tracks cost — dropping usage would hide the model's
            // input/output rows in the Tok popover)
            merged.push({ model: model, costCny: hEntry.costCny, usage: hEntry.usage });
          } else {
            // host hasn't settled this model yet (in-flight step): the
            // client fold's own usage keeps the row alive
            merged.push({ model: model, costCny: entry.cost, usage: entry.usage });
          }
        });
        if (hostModelList !== null) {
          for (var hb2 = 0; hb2 < hostModelList.length; hb2++) {
            var he2 = hostModelList[hb2];
            if (he2 !== void 0 && he2 !== null && !clientByModel.has(he2.model)) merged.push(he2);
          }
        }
        modelBreakdown = merged;
      }
      // Streaming: the in-flight estimate joins the CURRENT model's row on
      // every render, so per-model figures tick live instead of only after a
      // step settles.
      if (estimateCny > 0) {
        var estModelNow = estimateRef.current !== null ? estimateRef.current.lastModel : void 0;
        if (typeof estModelNow === "string" && estModelNow !== "") {
          var streamList = Array.isArray(modelBreakdown) ? modelBreakdown.slice() : [];
          var foundModel = false;
          for (var smi = 0; smi < streamList.length; smi++) {
            if (streamList[smi] !== null && streamList[smi] !== void 0 && streamList[smi].model === estModelNow) {
              // keep the settled usage buckets: replacing the entry without
              // them made the Tok row flip to the estimate-only figures and
              // "zero out" at every step boundary mid-turn (the exact figures
              // only came back once the turn ended and the estimate died)
              streamList[smi] = {
                model: estModelNow,
                costCny: (Number(streamList[smi].costCny) || 0) + estimateCny,
                usage: streamList[smi].usage
              };
              foundModel = true;
              break;
            }
          }
          if (!foundModel) streamList.push({ model: estModelNow, costCny: estimateCny });
          modelBreakdown = streamList;
        }
      }
      var etaText = etaState[0];
      // Streaming output-token estimate (chars→tokens at the calibrated
      // densities) so the Tok group's 本轮输出 ticks live with the stream.
      var estOutputTokens = 0;
      var estStateRender = estimateRef.current;
      if (estStateRender !== null && estimateCny > 0) {
        // tokens are whole numbers — round the chars→tokens estimate
        estOutputTokens = Math.round(
          (estStateRender.reason.cjk + estStateRender.reason.rest / estStateRender.reasonDensity) +
          (estStateRender.text.cjk + estStateRender.text.rest / estStateRender.outputDensity) +
          (estStateRender.tool.cjk + estStateRender.tool.rest / estStateRender.outputDensity)
        );
      }
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
        pricingSource: pricingSourceRow,
        etaText: etaText,
        turnUsage: estimateRef.current !== null ? estimateRef.current.turnUsage : null,
        turnSpeed: estimateRef.current !== null ? estimateRef.current.turnSpeed : null,
        turnSteps: estimateRef.current !== null ? estimateRef.current.turnSteps : 0,
        turnOpen: estimateRef.current !== null && estimateRef.current.turnSpeed !== null && estimateRef.current.turnSpeed.openStep !== null,
        turnActive: estimateRef.current !== null ? estimateRef.current.turnActive === true : false,
        hadTurn: estimateRef.current !== null ? estimateRef.current.hadTurn === true : false,
        toolPhaseStart: liveInfo !== null ? liveInfo.toolPhaseStart : null,
        estOutputTokens: estOutputTokens,
        estInputTokens: estStateRender !== null ? Math.round(estStateRender.inputTokShown) : 0,
        estCacheTokens: estStateRender !== null ? Math.round(estStateRender.cacheTokShown) : 0,
        estModel: estStateRender !== null ? estStateRender.lastModel : void 0
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
          // hidden groups' DOM (their spans are not rendered). Each unit
          // after the first includes its leading separator, so row math is
          // done in unit widths — matching how the flex line lays them out.
          function natWidth(idx) {
            var cached = widthsRef.current[idx];
            if (cached !== void 0 && cached > 0) return cached;
            var w = widthOf(itemRefs.current[idx]);
            if (w > 0) {
              if (idx > 0) w += sepWidth;
              widthsRef.current[idx] = w;
            }
            return w;
          }
          var firstUnit = natWidth(0);
          // trailing-⋯ decision: groups render IN ORDER across at most two
          // rows; the first group that does not fit on the second row (and
          // everything after it) is omitted and a "⋯" marker (\cdots style)
          // is shown at the end of the visible content.
          var ELLIPSE_W = 14; // approximate ⋯ width, reserved on row 2
          var omitFrom = groups.length;
          var rw2 = firstUnit;
          var onRow2 = false;
          for (var k2 = 1; k2 < groups.length; k2++) {
            var iw2 = natWidth(k2);
            if (iw2 <= 0) { omitFrom = k2; break; }
            if (rw2 + iw2 <= available + 0.5) {
              rw2 += iw2;
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
          // Separators: computed over the VISIBLE sequence (0..omitFrom-1),
          // not the full group list — an ellided group changes where row 2
          // actually starts, and the separator at that start must hide.
          // Rules: no `|` at the start of a row, none at the end of a row
          // (each separator is bound to the group AFTER it, inside the same
          // flex unit, so a row's last unit never trails a `|`), and none
          // before the trailing ⋯ either (the marker is standalone).
          var rowBreak = -1;
          var rw = firstUnit;
          for (var k = 1; k < omitFrom; k++) {
            var iw = natWidth(k);
            if (rw + iw <= available + 0.5) {
              rw += iw;
            } else {
              rowBreak = k;
              break;
            }
          }
          var next = [];
          for (var s = 0; s < groups.length - 1; s++) {
            next.push(s + 1 === rowBreak);
          }
          var sig = next.join(",");
          if (sig !== trailingCache.current) {
            trailingCache.current = sig;
            setSepHidden(next);
          }
          // Commit the explicit row layout (only when it actually changed —
          // layout feedback must be one-way: measurement → layout).
          var newLayout = { rowBreak: rowBreak, omitFrom: omitFrom };
          var prevLayout = layoutRef.current;
          if (prevLayout === null ||
              prevLayout.rowBreak !== newLayout.rowBreak ||
              prevLayout.omitFrom !== newLayout.omitFrom) {
            layoutRef.current = newLayout;
            setLayout(newLayout);
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
      // Explicit two-row layout: rows are split by the MEASURED rowBreak, so
      // the flex line never wraps on its own. The separator is bound inside
      // its unit (before the group), a row-start separator hides via
      // visibility (keeps its space → widths never change), and the trailing
      // ⋯ is a standalone marker with no separator.
      function unitSpan(gi, hideSep, rowKey) {
        return react.createElement(
          "span",
          { key: rowKey + "u" + gi, className: "dsh-better-stats-unit" },
          gi > 0
            ? react.createElement(
                "span",
                {
                  key: "sep",
                  className: "dsh-better-stats-sep" + (hideSep === true ? " dsh-better-stats-sep-hidden" : ""),
                  "aria-hidden": "true"
                },
                "|"
              )
            : null,
          react.createElement(
            "span",
            {
              key: "grp",
              ref: (function (idx) {
                return function (el) { itemRefs.current[idx] = el; };
              })(gi),
              className: "dsh-better-stats-item" +
                (groups[gi].refreshable === true ? " dsh-better-stats-refresh" : "") +
                (groups[gi].refreshable === true && refreshPulse === true ? " dsh-better-stats-refreshing" : ""),
              style: groups[gi].style,
              onClick: groups[gi].refreshable === true
                ? function (e) {
                    e.stopPropagation();
                    setRefreshPulse(true);
                    setTimeout(function () { setRefreshPulse(false); }, 800);
                    if (balanceRefreshRef.current) balanceRefreshRef.current(true);
                  }
                : void 0,
              title: groups[gi].refreshable === true ? L.refreshHint : void 0
            },
            groups[gi].text
          )
        );
      }
      var rowBreak = layout !== null ? layout.rowBreak : -1;
      var omit = layout !== null ? layout.omitFrom : groups.length;
      if (rowBreak >= omit) rowBreak = -1; // defensive: never split past the end
      var row1Units = [];
      var row1End = rowBreak >= 0 ? rowBreak : omit;
      for (var g1 = 0; g1 < row1End && g1 < groups.length; g1++) {
        row1Units.push(unitSpan(g1, false, "r1"));
      }
      if (row1Units.length > 0) {
        items.push(react.createElement("div", { key: "row1", className: "dsh-better-stats-row" }, row1Units));
      }
      if (rowBreak >= 0) {
        var row2Units = [];
        for (var g2 = rowBreak; g2 < omit && g2 < groups.length; g2++) {
          row2Units.push(unitSpan(g2, g2 === rowBreak, "r2"));
        }
        if (omit < groups.length) {
          row2Units.push(
            react.createElement(
              "span",
              {
                key: "r2ellide",
                className: "dsh-better-stats-item dsh-better-stats-ellipsis",
                "aria-hidden": "true"
              },
              "⋯"
            )
          );
        }
        if (row2Units.length > 0) {
          items.push(react.createElement("div", { key: "row2", className: "dsh-better-stats-row" }, row2Units));
        }
      }

      return react.createElement(
        "div",
        {
          ref: lineRef,
          className: "dsh-better-stats-line",
          "data-bs": "v20",
          onMouseEnter: function () {
            cancelHide();
            measureAnchor();
            setHovered(true);
          },
          onMouseLeave: function () { scheduleHide(); }
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
                  transform: "translate(-50%, -100%)",
                  // Popover grows upward from the stats line: cap it at the
                  // space actually available above the anchor (12px top
                  // clearance) so the whole panel fits without scrolling on
                  // normal windows, and scrolls gracefully when the window
                  // is short or more models are added.
                  maxHeight: Math.max(120, anchor.top - 12) + "px"
                },
                onMouseEnter: function () { cancelHide(); },
                onMouseLeave: function () { scheduleHide(); }
              },
              // Four-column table: ONE grid for the whole popover so column
              // widths are shared across rows. col1 = row label, cols 2-4 =
              // cells; a row with a single non-empty cell merges across the
              // remaining columns. gridRow places each row's cells.
              (function () {
              function cellSpan(idx, nonEmpty) {
                if (nonEmpty.length === 1 && nonEmpty[0] === idx) {
                  return "dsh-better-stats-pop-c dsh-better-stats-pop-cspan" + (3 - idx);
                }
                return "dsh-better-stats-pop-c dsh-better-stats-pop-c" + (idx + 2);
              }
              var gridEls = [];
              var gridRowNum = 1;
              var firstGroup = true; // 1.5× spacing between categories
              // popover order: 花费 second-to-last, Tok last (strip order
              // stays untouched — this sorts only the floating panel)
              var POP_ORDER = ["API", "余额", "峰谷", "轮次", "耗时", "速率", "缓存", "花费", "Tok"];
              var popGroups = groups.slice().sort(function (a, b) {
                var ia = POP_ORDER.indexOf(a.label);
                var ib = POP_ORDER.indexOf(b.label);
                return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
              });
              popGroups.forEach(function (group, gi) {
                var hasRecharge = group.recharge !== null && group.recharge !== void 0 && group.recharge !== "";
                function rechargeLink(key) {
                  return react.createElement(
                    "a",
                    {
                      key: key,
                      className: "dsh-better-stats-pop-link" + (group.rechargeBold === true ? " dsh-better-stats-pop-link-bold" : ""),
                      href: group.recharge,
                      target: "_blank",
                      rel: "noreferrer"
                    },
                    L.recharge
                  );
                }
                var popover = group.popover;
                var rowList = popover !== void 0 && popover !== null && popover.rows !== void 0 && Array.isArray(popover.rows) ? popover.rows : null;
                if (rowList === null) return;
                for (var li = 0; li < rowList.length; li++) {
                  var row = rowList[li];
                  var cells = row !== null && row !== void 0 && Array.isArray(row.c) ? row.c : [];
                  var nonEmpty = [];
                  for (var ci = 0; ci < 3; ci++) {
                    if (cells[ci] !== void 0 && cells[ci] !== null && cells[ci] !== "") nonEmpty.push(ci);
                  }
                  var rowLabel = row !== null && row !== void 0 && row.label !== void 0 && row.label !== "" ? row.label : (li === 0 ? group.label : "");
                  // 1.5× spacing between categories: rows that START a block
                  // (a group's first row, or any explicitly-labelled row such
                  // as 价源) get a half-line margin — except the very first
                  // block of the popover
                  var isBlockStart = li === 0 || (row !== null && row !== void 0 && row.label !== void 0 && row.label !== "");
                  var topPad = 0;
                  if (isBlockStart) {
                    if (!firstGroup) topPad = 10;
                    firstGroup = false;
                  }
                  var rn = gridRowNum;
                  gridRowNum += 1;
                  var rowStyle = topPad > 0 ? { gridRow: rn, marginTop: topPad } : { gridRow: rn };
                  gridEls.push(
                    react.createElement("span", { key: "l" + gi + ":" + li, className: "dsh-better-stats-pop-label", style: rowStyle }, rowLabel)
                  );
                  var isRechargeRow = hasRecharge && li === 0;
                  if (nonEmpty.length === 1 && !isRechargeRow) {
                    var only = nonEmpty[0];
                    var mergedContent = cells[only];
                    gridEls.push(
                      react.createElement("span", { key: "c" + gi + ":" + li, className: cellSpan(only, nonEmpty), style: rowStyle }, mergedContent)
                    );
                  } else {
                    for (var ci2 = 0; ci2 < 3; ci2++) {
                      var cellContent = cells[ci2] !== void 0 && cells[ci2] !== null ? cells[ci2] : "";
                      // the recharge link lives in col 4 of the group's first
                      // row (余额: amount | ETA | 充值 ↗)
                      if (isRechargeRow && ci2 === 2) {
                        cellContent = [cellContent, " ", rechargeLink("r" + gi)];
                      }
                      gridEls.push(
                        react.createElement("span", { key: "c" + gi + ":" + li + ":" + ci2, className: cellSpan(ci2, nonEmpty), style: rowStyle }, cellContent)
                      );
                    }
                  }
                }
              });
              return gridEls;
            })()
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
