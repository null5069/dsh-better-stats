// dsh-better-stats — client half: ONE complete stats strip merging the
// shipped row's figures with the balance/cost ledger, hiding the shipped row
// via CSS:
//
//   DeepSeek | 余额 ¥48.8600 | 本轮 ¥0.0081 · 会话 ≈¥0.2362 |
//   3 轮 · 12 步 | LLM 45.2s · 工具 12.3s | 首token 1.4s · 25.4tok/s |
//   输入 12.2K · 缓存 10.6K · 87.00% · 输出 517
//
// Accounting contract (mirrors the host):
//   - outputTokens ALREADY includes reasoningTokens; reasoning is a display
//     subset only. Amounts and the settled tok/s numerator use outputTokens.
//   - Streaming: reasoning and visible chars are estimated separately, then
//     synthesized into ONE total-output estimate × estAccuracy — that single
//     corrected value feeds 金额, Tok and 速率 alike. Settled steps switch to
//     the real outputTokens.
//   - 会话 = host tree snapshot: "live root + latest descendants" — the
//     /live root figure refreshes every second, the /cost descendants every
//     ~15s, NEVER a max() of the two.
//   - The initial model is "unknown" (never flash): the first usage chunk of
//     a fresh session stays unpriced (≈) until a message identifies the
//     model. Unknown tokens still total; the cost shows 未计价.
//   - A legal costCny === 0 is a real answer; "no answer" is null/undefined.
//   - Session switching rebuilds every session-scoped state: the strip is a
//     key={sessionId} subcomponent.
//   - The 100ms ticker only bumps while the session runs AND the page is
//     visible; the event fold only scans new events (cursor) and layout
//     measurement only runs on signature/size changes.
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
      ".FJxK0a_root{display:none}",
      ".dsh-better-stats-line{position:relative;display:flex;flex-direction:column;align-items:center;max-width:var(--dsh-composer-card-max-width);box-sizing:border-box;width:100%;padding:4px 16px 4px;color:var(--dsw-alias-label-tertiary);margin:0 auto;font-size:12px;line-height:20px;row-gap:2px;max-height:48px;overflow:hidden;font-variant-numeric:tabular-nums}",
      ".dsh-better-stats-line:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;border-radius:8px}",
      ".dsh-better-stats-row{display:flex;align-items:center;justify-content:center;white-space:nowrap;max-width:100%}",
      ".dsh-better-stats-ellipsis{color:var(--dsw-alias-label-tertiary)}",
      ".dsh-better-stats-item{white-space:nowrap}",
      ".dsh-better-stats-unit{display:inline-flex;align-items:center;white-space:nowrap}",
      ".dsh-better-stats-sep{color:var(--dsw-alias-separator-primary);margin:0 10px;white-space:nowrap}",
      ".dsh-better-stats-sep-hidden{visibility:hidden}",
      ".dsh-better-stats-sep-probe{position:absolute;visibility:hidden;pointer-events:none;left:-10000px;top:0}",
      ".dsh-better-stats-pop{box-sizing:border-box;min-width:220px;max-width:calc(100vw - 32px);max-height:calc(100vh - 24px);overflow-y:auto;overscroll-behavior:contain;border:1px solid var(--dsw-alias-border-inverted);background:var(--dsw-specific-menu);box-shadow:var(--dsw-shadow-lv3);color:var(--dsw-alias-label-secondary);border-radius:12px;padding:10px 14px;font-size:12px;line-height:20px;text-align:left;z-index:100;font-variant-numeric:tabular-nums;display:grid;grid-template-columns:56px auto auto auto;column-gap:12px;align-items:baseline;justify-items:start}",
      ".dsh-better-stats-pop:focus-visible{outline:2px solid var(--dsw-alias-brand-primary)}",
      ".dsh-better-stats-pop-label{grid-column:1;color:var(--dsw-alias-label-tertiary)}",
      ".dsh-better-stats-pop-c{white-space:nowrap}",
      ".dsh-better-stats-pop-c2{grid-column:2}",
      ".dsh-better-stats-pop-c3{grid-column:3}",
      ".dsh-better-stats-pop-c4{grid-column:4}",
      ".dsh-better-stats-pop-cspan3{grid-column:2 / span 3}",
      ".dsh-better-stats-pop-cspan2{grid-column:3 / span 2}",
      ".dsh-better-stats-pop-cspan1{grid-column:4}",
      ".dsh-better-stats-pop b{color:var(--dsw-alias-label-primary);font-weight:600}",
      ".dsh-better-stats-refresh{background:none;border:none;padding:0;margin:0;font:inherit;color:inherit;cursor:pointer;text-align:left}",
      ".dsh-better-stats-refresh:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;border-radius:4px}",
      "@keyframes dsh-better-stats-pulse{0%{filter:brightness(1.7)}35%{filter:brightness(1.7)}100%{filter:brightness(1)}}",
      ".dsh-better-stats-refreshing{animation:dsh-better-stats-pulse .6s ease-out}",
      "@media (prefers-reduced-motion: reduce){.dsh-better-stats-refreshing{animation:none}}",
      ".dsh-better-stats-pop-link{color:var(--dsw-alias-brand-primary);text-decoration:none;font-weight:400}",
      ".dsh-better-stats-pop-link-bold{font-weight:700}",
      ".dsh-better-stats-pop-link:hover{text-decoration:underline}",
      // narrow popover: two columns first, then one column with wrapping
      "@media (max-width:720px){.dsh-better-stats-pop{grid-template-columns:56px auto}.dsh-better-stats-pop-label{grid-column:1;grid-row:auto !important}.dsh-better-stats-pop-c{grid-column:2 !important;grid-row:auto !important;white-space:normal}}",
      "@media (max-width:420px){.dsh-better-stats-pop{grid-template-columns:1fr}.dsh-better-stats-pop-label{grid-column:1 !important}.dsh-better-stats-pop-c{grid-column:1 !important}}"
    ];
    var STYLE_ID = "dsh-better-stats/styles.css";
    if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(STYLE_ID) + "]") === null) {
      var tag = document.createElement("style");
      tag.dataset.plugin = "dsh-better-stats";
      tag.dataset.pluginCss = STYLE_ID;
      tag.textContent = STYLES.join("\n");
      document.head.appendChild(tag);
    }

    // Fallback price tables (the host re-syncs the official page every 6h and
    // every route response carries `pricing`; these only cover the gap before
    // the first host answer).
    var PRICE_TABLES = {
      "deepseek-v4-flash": { miss: 1.5, read: 0.05, out: 4.5, missPeak: 3.0, readPeak: 0.1, outPeak: 9.0 },
      "deepseek-v4-pro": { miss: 4.5, read: 0.15, out: 13.5, missPeak: 9.0, readPeak: 0.3, outPeak: 27.0 }
    };
    // The initial model is UNKNOWN — never silently defaulted to flash: an
    // unknown model prices at 0 and surfaces as 未计价/≈ instead.
    var DEFAULT_MODEL = "unknown";

    // Streaming-estimate calibration. The STARTING densities are measured
    // session averages (reasoning ≈3.5 non-CJK chars/token, final text +
    // tool JSON ≈2.5, CJK ≈1 char/token), but every settled step re-
    // calibrates them with an EMA of the step's REAL chars→tokens ratio.
    // Display-only — exact figures take over the moment the step settles.
    var EST_DENSITY_REASON = 3.5;
    var EST_DENSITY_OUTPUT = 2.5;
    var EST_DENSITY_MIN = 0.8;
    var EST_DENSITY_MAX = 12;
    // 本轮 tok/s follows the API's own throughput accounting: the stream
    // chunk events (reasoning-chunks / text-chunks / tool-call-chunks) carry
    // per-token TEXT FRAGMENTS (texts[]/args[], measured ≈99% of
    // usage.outputTokens on real logs) plus per-token dt deltas. The live
    // rate is therefore (settled tokens + fragments×segFactor) / (settled
    // decodeMs + wall clock since first token) — no char-density guessing.
    // The fragment→token factor is stable ≈1.01 on real sessions; short
    // steps' fragments get MERGED by the assembler (factor up to 2.2), so
    // only large steps re-calibrate it.
    var SEG_FACTOR_INIT = 1.01;
    var SEG_FACTOR_MIN_SEGS = 2000;
    var SEG_FACTOR_EMA_NEW = 0.5;
    // calibration EMA weights (faster = closer to the real density within a
    // turn; stepLocalAcc already makes the settle exact)
    var CALIB_EMA_NEW = 0.5;

    // EMA-update the per-kind densities from one settled step. The OUTPUT
    // density calibrates against the VISIBLE share only (output − reasoning)
    // — reasoning chars have their own density.
    function calibrateEstDensity(est, reason, text, tool, usage) {
      if (usage === void 0 || usage === null || typeof usage !== "object") return;
      var reasonTok = Number(usage.reasoningTokens) || 0;
      var outTok = Number(usage.outputTokens) || 0;
      var emaNew = CALIB_EMA_NEW;
      if (reasonTok > 0 && reason.rest > 8) {
        var rd = reason.rest / reasonTok;
        if (rd >= EST_DENSITY_MIN && rd <= EST_DENSITY_MAX) {
          est.reasonDensity = est.reasonDensity * (1 - emaNew) + rd * emaNew;
        }
      }
      var visibleTok = Math.max(0, outTok - reasonTok);
      if (visibleTok > 0) {
        var outRest = text.rest + tool.rest;
        if (outRest > 8) {
          var od = outRest / visibleTok;
          if (od >= EST_DENSITY_MIN && od <= EST_DENSITY_MAX) {
            est.outputDensity = est.outputDensity * (1 - emaNew) + od * emaNew;
          }
        }
      }
    }

    var PRECISION = 4;
    var CONFIG_DECIMALS = 2;
    var CURRENCY_SYMBOLS = { CNY: "¥", USD: "$", EUR: "€", GBP: "£", JPY: "¥" };

    // ── i18n: UI strings follow the browser language (zh → English default).
    var LANG = (function () {
      try {
        var navLang = typeof navigator !== "undefined" && navigator.language ? navigator.language : "";
        return String(navLang).toLowerCase().indexOf("zh") === 0 ? "zh" : "en";
      } catch (e) { return "en"; }
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
        labelApi: "API",
        labelPeak: "峰谷",
        labelTurns: "轮次",
        labelTime: "耗时",
        labelSpeed: "速率",
        labelCache: "缓存",
        labelSpend: "花费",
        labelTok: "Tok",
        exact: "精确",
        estimate: "估算",
        inclEstimate: "含估算 {0}",
        unpricedNote: " (含 {0} 步未定价 · 模型未知)",
        invalidNote: " (含 {0} 步无效数据)",
        partialNote: " (含 {0} 个子会话读取失败)",
        subSessions: "含 {0} 个子会话",
        turnsSteps: "{0} 轮 · {1} 步",
        turns: "{0} 轮",
        steps: "{0} 步",
        tool: "工具",
        llm: "LLM",
        zeroS: "0.0s",
        ttftAvg: "首 token 平均",
        cache: "缓存",
        hit: "命中",
        input: "输入",
        output: "输出",
        unpricedLabel: "未计价",
        labelModels: "模型",
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
        etaHours: "约可用 {0} 小时",
        staleMark: "过期",
        partialMark: "部分",
        lineAria: "better-stats 统计条",
        popAria: "better-stats 详情浮窗"
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
        labelApi: "API",
        labelPeak: "Peak",
        labelTurns: "Turns",
        labelTime: "Time",
        labelSpeed: "Speed",
        labelCache: "Cache",
        labelSpend: "Spend",
        labelTok: "Tok",
        exact: "exact",
        estimate: "estimate",
        inclEstimate: "incl. estimate {0}",
        unpricedNote: " ({0} steps unpriced · unknown model)",
        invalidNote: " ({0} steps with invalid data)",
        partialNote: " ({0} sub-sessions failed to read)",
        subSessions: " {0} sub-sessions",
        turnsSteps: "{0} turns · {1} steps",
        turns: "{0} turns",
        steps: "{0} steps",
        tool: "Tool",
        llm: "LLM",
        zeroS: "0.0s",
        ttftAvg: "TTFT avg",
        cache: "Cache",
        hit: "hit",
        input: "In",
        output: "Out",
        unpricedLabel: "Unpriced",
        labelModels: "Model",
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
        etaHours: "≈ {0}h left",
        staleMark: "stale",
        partialMark: "partial",
        lineAria: "better-stats line",
        popAria: "better-stats details"
      }
    };
    var L = I18N[LANG];
    function T(tpl) {
      var args = Array.prototype.slice.call(arguments, 1);
      return String(tpl).replace(/\{(\d+)\}/g, function (m, i) {
        return args[Number(i)] !== void 0 ? String(args[Number(i)]) : m;
      });
    }

    var PROVIDER_LABELS = { deepseek: L.providerDeepSeek, "deepseek-official": L.providerDeepSeek };

    var USAGE_KEYS = ["uncachedInputTokens", "cacheReadTokens", "cacheWriteTokens", "outputTokens"];
    var ZERO_USAGE = { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
    var BALANCE_CACHE_KEY = "dsh-better-stats:balance:v2";

    function strictUsageBucket(raw) {
      if (raw === void 0 || raw === null || typeof raw !== "object") return null;
      var fields = [
        ["inputTokens", "uncachedInputTokens"],
        ["cacheReadTokens", "cacheReadTokens"],
        ["cacheWriteTokens", "cacheWriteTokens"],
        ["outputTokens", "outputTokens"],
        ["reasoningTokens", "reasoningTokens"]
      ];
      var out = { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0 };
      for (var fi = 0; fi < fields.length; fi++) {
        var value = raw[fields[fi][0]];
        if (value === void 0 || value === null) continue;
        var number = Number(value);
        if (!Number.isFinite(number) || number < 0 || !Number.isInteger(number)) return null;
        out[fields[fi][1]] = number;
      }
      return out.reasoningTokens <= out.outputTokens ? out : null;
    }

    function requestModelOf(event) {
      if (event === void 0 || event === null || typeof event !== "object" || event.data === void 0 || event.data === null) return void 0;
      if (event.type === "request/context" && typeof event.data.model === "string" && event.data.model !== "") return event.data.model;
      if (event.type === "request/header") {
        var model = event.data.header && event.data.header.config ? event.data.header.config.model : void 0;
        if (typeof model === "string" && model !== "") return model;
      }
      return void 0;
    }

    function beijingPeak(epochMs) {
      var at = typeof epochMs === "number" && Number.isFinite(epochMs) ? epochMs : Date.now();
      var d = new Date(at + 8 * 3600 * 1000);
      var h = d.getUTCHours();
      return (h >= 9 && h < 12) || (h >= 14 && h < 18);
    }

    // Normalized EXACT model ids only (mirrors the host) — no substring
    // matching. "deepseek-v4-flash-0731" → strip the trailing date suffix.
    function modelKeyOf(model) {
      if (typeof model !== "string") return "unknown";
      var normalized = model.trim().toLowerCase().replace(/-\d{4,}$/, "");
      if (normalized === "deepseek-v4-flash") return "deepseek-v4-flash";
      if (normalized === "deepseek-v4-pro") return "deepseek-v4-pro";
      return "unknown";
    }

    // CNY cost of a usage bucket: ONLY outputTokens is billed at the output
    // rate — reasoning is a subset of output and is never billed again.
    function tablesAtTime(tables, ledger, time) {
      var best = null;
      if (Array.isArray(ledger) && typeof time === "number" && Number.isFinite(time)) {
        for (var li = 0; li < ledger.length; li++) {
          var entry = ledger[li];
          if (entry !== null && typeof entry === "object" && typeof entry.effectiveAt === "number" && entry.effectiveAt <= time &&
              entry.tables && (best === null || entry.effectiveAt > best.effectiveAt)) best = entry;
        }
      }
      return best !== null ? best.tables : tables;
    }

    function cnyCost(totals, time, model, tables, ledger) {
      if (!totals) return 0;
      var effectiveTables = tablesAtTime(tables || PRICE_TABLES, ledger, time);
      var table = effectiveTables[modelKeyOf(model)];
      if (table === void 0 || table === null) return 0;
      var peak = beijingPeak(time);
      var miss = peak ? table.missPeak : table.miss;
      var read = peak ? table.readPeak : table.read;
      var out = peak ? table.outPeak : table.out;
      return (
        ((totals.uncachedInputTokens || 0) + (totals.cacheWriteTokens || 0)) * miss +
        (totals.cacheReadTokens || 0) * read +
        (totals.outputTokens || 0) * out
      ) / 1e6;
    }

    // Upsert one step's settled usage into the turn fold: the per-step
    // LATEST sample wins, and the turn cost is adjusted by the price delta —
    // exact and incremental (O(1) per event).
    function upsertTurnSample(samples, cost, turn, step, usage, model, time, tables, turnUsage, ledger) {
      var tn = Number(turn);
      var sn = Number(step);
      if (!Number.isFinite(tn) || tn < 0 || !Number.isInteger(tn) ||
          !Number.isFinite(sn) || sn < 0 || !Number.isInteger(sn) ||
          typeof time !== "number" || !Number.isFinite(time) || time < 0) return cost;
      var buckets = strictUsageBucket(usage);
      if (buckets === null) return cost;
      var key = tn + ":" + sn;
      var prev = samples.get(key);
      var effectiveModel = model !== void 0 && model !== null && model !== ""
        ? model
        : (prev !== void 0 ? prev.model : void 0);
      var newCost = cnyCost(buckets, time, effectiveModel, tables, ledger);
      var prevCost = prev !== void 0 ? prev.cost : 0;
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
        model: effectiveModel,
        buckets: buckets,
        time: time
      });
      return cost + (newCost - prevCost);
    }

    function repriceSamples(samples, tables, ledger) {
      var total = 0;
      samples.forEach(function (sample) {
        sample.cost = cnyCost(sample.buckets, sample.time, sample.model, tables, ledger);
        total += sample.cost;
      });
      return total;
    }

    function zeroUsage() {
      return { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0 };
    }

    function safeUsage(raw) {
      var out = zeroUsage();
      if (raw === void 0 || raw === null || typeof raw !== "object") return out;
      var keys = ["uncachedInputTokens", "cacheReadTokens", "cacheWriteTokens", "outputTokens", "reasoningTokens"];
      for (var i = 0; i < keys.length; i++) {
        var value = Number(raw[keys[i]]);
        if (Number.isFinite(value) && value >= 0) out[keys[i]] = value;
      }
      return out;
    }

    function addUsage(target, source) {
      var src = safeUsage(source);
      target.uncachedInputTokens += src.uncachedInputTokens;
      target.cacheReadTokens += src.cacheReadTokens;
      target.cacheWriteTokens += src.cacheWriteTokens;
      target.outputTokens += src.outputTokens;
      target.reasoningTokens += src.reasoningTokens;
      return target;
    }

    function modelsFromClientMap(byModel) {
      var out = [];
      if (byModel && typeof byModel.forEach === "function") {
        byModel.forEach(function (entry, model) {
          out.push({ model: model, costCny: Number(entry.cost) || 0, usage: safeUsage(entry.usage) });
        });
      }
      return out;
    }

    function mergeModelLists(first, second) {
      var merged = new Map();
      function take(list) {
        if (!Array.isArray(list)) return;
        for (var i = 0; i < list.length; i++) {
          var row = list[i];
          if (row === void 0 || row === null || typeof row.model !== "string") continue;
          var prev = merged.get(row.model);
          if (prev === void 0) {
            prev = { model: row.model, costCny: 0, usage: zeroUsage() };
            merged.set(row.model, prev);
          }
          var cost = Number(row.costCny);
          if (Number.isFinite(cost)) prev.costCny += cost;
          addUsage(prev.usage, row.usage);
        }
      }
      take(first);
      take(second);
      return Array.from(merged.values());
    }

    function foldSessionStatEvent(stat, event) {
      if (event === void 0 || event === null || typeof event !== "object" ||
          event.data === void 0 || event.data === null || typeof event.time !== "number" ||
          !Number.isFinite(event.time) || event.time < 0) return;
      var data = event.data;
      if (event.type === "step/start") {
        if (!validEventIndex(data.turn) || !validEventIndex(data.step)) return;
        stat.openStep = { turn: data.turn, step: data.step, startTime: event.time, firstTokenTime: null };
      } else if (event.type === "assistant/chunk") {
        var open = stat.openStep;
        var chunk = data.chunk;
        if (open !== null && open.turn === data.turn && open.step === data.step && open.firstTokenTime === null && chunk) {
          var token = chunk.type === "text-delta" || chunk.type === "reasoning-delta"
            ? (typeof chunk.text === "string" && chunk.text !== "")
            : (chunk.type === "tool-call-delta" &&
                ((typeof chunk.argumentsDelta === "string" && chunk.argumentsDelta !== "") ||
                 (typeof chunk.name === "string" && chunk.name !== "")));
          if (token) open.firstTokenTime = event.time;
        }
      } else if (event.type === "assistant/message") {
        var open2 = stat.openStep;
        if (open2 !== null && open2.turn === data.turn && open2.step === data.step) {
          stat.llmMs += Math.max(0, event.time - open2.startTime);
          if (open2.firstTokenTime !== null) {
            stat.ttftMs += Math.max(0, open2.firstTokenTime - open2.startTime);
            stat.ttftSteps += 1;
            var bucket = strictUsageBucket(data.usage);
            if (bucket !== null) {
              stat.decodeMs += Math.max(0, event.time - open2.firstTokenTime);
              stat.decodeTokens += bucket.outputTokens;
            }
          }
          stat.openStep = null;
        }
      } else if (event.type === "step/end") {
        if (!validEventIndex(data.turn) || !validEventIndex(data.step)) return;
        stat.turns = stat.lastTurn === data.turn ? stat.turns : stat.turns + 1;
        stat.steps += 1;
        stat.lastTurn = data.turn;
        stat.openStep = null;
      }
    }

    function upsertModelSample(state, event, model, tables, ledger) {
      if (state === null || state === void 0 || event === null || event === void 0 || event.data === null || event.data === void 0) return;
      var data = event.data;
      var raw = null;
      if (event.type === "assistant/chunk" && data.chunk && data.chunk.type === "usage") raw = data.chunk.usage;
      else if (event.type === "assistant/message") raw = data.usage;
      if (raw === null || raw === void 0) return;
      var bucket = strictUsageBucket(raw);
      var turn = Number(data.turn);
      var step = Number(data.step);
      if (bucket === null || !Number.isFinite(turn) || turn < 0 || !Number.isInteger(turn) ||
          !Number.isFinite(step) || step < 0 || !Number.isInteger(step) ||
          typeof event.time !== "number" || !Number.isFinite(event.time) || event.time < 0) return;
      var resolved = modelKeyOf(model);
      var key = turn + ":" + step;
      var cost = cnyCost(bucket, event.time, resolved, tables, ledger);
      var previous = state.samples.get(key);
      if (previous !== void 0) {
        var oldEntry = state.byModel.get(previous.model);
        if (oldEntry !== void 0) {
          oldEntry.cost -= previous.cost;
          for (var oi = 0; oi < USAGE_KEYS.length; oi++) {
            var oldKey = USAGE_KEYS[oi];
            oldEntry.usage[oldKey] = (oldEntry.usage[oldKey] || 0) - (previous.usage[oldKey] || 0);
          }
          // reasoningTokens is a display subset of outputTokens, not a billed
          // bucket, so it is intentionally absent from USAGE_KEYS. It still
          // has to obey latest-sample replacement in the model aggregate.
          oldEntry.usage.reasoningTokens = (oldEntry.usage.reasoningTokens || 0) - (previous.usage.reasoningTokens || 0);
        }
      }
      var entry = state.byModel.get(resolved);
      if (entry === void 0) {
        entry = { cost: 0, usage: zeroUsage() };
        state.byModel.set(resolved, entry);
      }
      entry.cost += cost;
      addUsage(entry.usage, bucket);
      state.samples.set(key, { cost: cost, model: resolved, usage: bucket, time: event.time });
    }

    function repriceModelState(state, tables, ledger) {
      if (state === null || state === void 0 || !state.samples || typeof state.samples.forEach !== "function") return;
      state.byModel = new Map();
      state.samples.forEach(function (sample) {
        sample.cost = cnyCost(sample.usage, sample.time, sample.model, tables, ledger);
        var entry = state.byModel.get(sample.model);
        if (entry === void 0) {
          entry = { cost: 0, usage: zeroUsage() };
          state.byModel.set(sample.model, entry);
        }
        entry.cost += sample.cost;
        addUsage(entry.usage, sample.usage);
      });
    }

    function beijingPeakNext(now) {
      var at = typeof now === "number" && Number.isFinite(now) ? now : Date.now();
      var d = new Date(at + 8 * 3600 * 1000);
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

    // CJK-aware char classification: CJK ≈ 1 token/char, everything else at
    // the per-kind density.
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

    // Batch streams are authoritative, but older runtimes can emit sampled
    // deltas before the matching batch event. Track the fallback separately
    // for each content kind so the first batch can roll back only its own
    // provisional contribution (reasoning/text/tool must not suppress one
    // another).
    function freshBatchSeen() {
      return { reason: false, text: false, tool: false };
    }

    function freshDeltaFallback() {
      return {
        reason: { cjk: 0, rest: 0, segs: 0 },
        text: { cjk: 0, rest: 0, segs: 0 },
        tool: { cjk: 0, rest: 0, segs: 0 }
      };
    }

    function addFallbackDelta(target, fallback, value) {
      if (typeof value !== "string" || value === "") return false;
      classifyChars(target, value);
      classifyChars(fallback, value);
      fallback.segs += 1;
      return true;
    }

    function rollbackFallbackDelta(target, fallback, est) {
      target.cjk = Math.max(0, target.cjk - fallback.cjk);
      target.rest = Math.max(0, target.rest - fallback.rest);
      est.liveSegs = Math.max(0, (Number(est.liveSegs) || 0) - fallback.segs);
      fallback.cjk = 0;
      fallback.rest = 0;
      fallback.segs = 0;
    }

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

    function moneyDecimals(value) {
      var n = Number(value);
      if (!Number.isFinite(n)) return 2;
      var s = String(n);
      var i = s.indexOf(".");
      var d = i === -1 ? 0 : s.length - i - 1;
      if (d > 6) d = 6;
      return d;
    }
    var POPOVER_DECIMALS = 6;

    function fmtTokens(n) {
      var v = Number(n) || 0;
      if (v >= 1000000) return (v / 1000000).toFixed(2) + "M";
      if (v >= 10000) return (v / 1000).toFixed(2) + "K";
      return String(v);
    }

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
      var v = Number(tps);
      if (!Number.isFinite(v) || v < 0) return "--";
      return v.toFixed(2) + "tok/s";
    }

    function finiteNonNegative(value) {
      var v = Number(value);
      return Number.isFinite(v) && v >= 0 ? v : 0;
    }

    function validEventIndex(value) {
      return typeof value === "number" && Number.isFinite(value) && value >= 0 && Number.isInteger(value);
    }

    function formatTtft(ms) {
      var v = Number(ms) || 0;
      return (v / 1000).toFixed(2) + "s";
    }

    // Popover variants: durations and TTFT show ONE decimal there; the strip
    // keeps whole seconds.
    function formatDurationPop(ms) {
      var v = Number(ms) || 0;
      if (v < 0) v = 0;
      var totalSec = v / 1000;
      var h = Math.floor(totalSec / 3600);
      var m = Math.floor((totalSec % 3600) / 60);
      var s = totalSec % 60;
      var parts = [];
      if (h > 0) parts.push(h + "h");
      if (m > 0) parts.push(m + "m");
      if (s > 0 || parts.length === 0) parts.push(s.toFixed(1) + "s");
      return parts.join(" ");
    }
    function formatTtftPop(ms) {
      var v = Number(ms) || 0;
      return (v / 1000).toFixed(1) + "s";
    }

    function billedInputTokens(totals) {
      return (totals.uncachedInputTokens || 0) + (totals.cacheWriteTokens || 0);
    }
    function cacheHitPercent(totals) {
      var billed = billedInputTokens(totals);
      var read = totals.cacheReadTokens || 0;
      if (billed + read <= 0) return "0.00"; // no data at all → legal zero, group still shows
      return (read / (billed + read) * 100).toFixed(2);
    }

    function currencySymbol(currency) {
      if (typeof currency === "string" && CURRENCY_SYMBOLS[currency] !== void 0) return CURRENCY_SYMBOLS[currency];
      return typeof currency === "string" && currency !== "" ? currency + " " : "¥";
    }

    // ── tree merge (client-side fallback for the subagent count) ───────────
    function collectDescendants(byId, rootId) {
      var out = [];
      var children = Object.create(null);
      for (var id in byId) {
        if (!Object.prototype.hasOwnProperty.call(byId, id)) continue;
        var entry = byId[id];
        if (entry === void 0 || entry === null || entry.origin !== "subagent" || typeof entry.parentId !== "string") continue;
        if (!Array.isArray(children[entry.parentId])) children[entry.parentId] = [];
        children[entry.parentId].push(id);
      }
      var stack = Array.isArray(children[rootId]) ? children[rootId].slice() : [];
      var seen = new Set([rootId]);
      while (stack.length > 0) {
        var cid = stack.pop();
        if (seen.has(cid)) continue;
        seen.add(cid);
        out.push(cid);
        var nested = children[cid];
        if (Array.isArray(nested)) for (var ni = 0; ni < nested.length; ni++) stack.push(nested[ni]);
      }
      return out;
    }

    function postSeedUsage(session) {
      if (session === void 0 || session === null || !Array.isArray(session.events)) return null;
      var header = session.header !== void 0 && session.header !== null ? session.header : {};
      var seed = typeof header.seedLength === "number" && Number.isFinite(header.seedLength) && header.seedLength > 0
        ? Math.floor(header.seedLength)
        : 0;
      if (seed <= 0) return null; // the projection is already exact and cheaper
      if (seed > session.events.length) return zeroUsage();
      var samples = new Map();
      for (var i = seed; i < session.events.length; i++) {
        var event = session.events[i];
        if (event === void 0 || event === null || typeof event !== "object" || event.data === void 0 || event.data === null) continue;
        var raw = null;
        if (event.type === "assistant/chunk" && event.data.chunk && event.data.chunk.type === "usage") raw = event.data.chunk.usage;
        else if (event.type === "assistant/message") raw = event.data.usage;
        if (raw === null || raw === void 0) continue;
        var turn = Number(event.data.turn);
        var step = Number(event.data.step);
        var bucket = strictUsageBucket(raw);
        if (!Number.isFinite(turn) || turn < 0 || !Number.isInteger(turn) ||
            !Number.isFinite(step) || step < 0 || !Number.isInteger(step) ||
            typeof event.time !== "number" || !Number.isFinite(event.time) || event.time < 0 || bucket === null) continue;
        samples.set(turn + ":" + step, bucket);
      }
      var out = zeroUsage();
      samples.forEach(function (bucket) { addUsage(out, bucket); });
      return out;
    }

    function mergedUsage(sessions, list, sessionId, usage) {
      var rootPostSeed = null;
      try {
        if (typeof sessions.binding === "function") {
          var rootBinding = sessions.binding(sessionId);
          rootPostSeed = postSeedUsage(rootBinding && rootBinding.session);
        }
      } catch (e) { rootPostSeed = null; }
      var rootUsage = rootPostSeed !== null ? rootPostSeed : usage;
      var merged = rootUsage === void 0 || rootUsage === null ? void 0 : Object.assign({}, ZERO_USAGE);
      if (merged !== void 0) {
        for (var i = 0; i < USAGE_KEYS.length; i++) merged[USAGE_KEYS[i]] = rootUsage[USAGE_KEYS[i]] || 0;
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
          var childSession = binding && binding.session ? binding.session : void 0;
          var u = postSeedUsage(childSession);
          var projections = childSession ? childSession.projections : void 0;
          if (u === null && projections !== void 0) u = projections.get("tokenUsage");
          if (u === void 0 || u === null) continue;
          if (merged === void 0) merged = Object.assign({}, ZERO_USAGE);
          for (var k = 0; k < USAGE_KEYS.length; k++) merged[USAGE_KEYS[k]] += u[USAGE_KEYS[k]] || 0;
        } catch (e) { /* skip this child */ }
      }
      return merged;
    }

    // ── balance cache (localStorage) ────────────────────────────────────────
    var balanceCacheLoaded = false;
    var balanceCacheMemory = null;
    function loadBalanceCache() {
      if (balanceCacheLoaded) return balanceCacheMemory;
      balanceCacheLoaded = true;
      try {
        var raw = localStorage.getItem(BALANCE_CACHE_KEY);
        if (!raw) return balanceCacheMemory;
        var parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && parsed.amount !== void 0) balanceCacheMemory = parsed;
        return balanceCacheMemory;
      } catch (e) {
        return balanceCacheMemory;
      }
    }
    function saveBalanceCache(value) {
      balanceCacheLoaded = true;
      balanceCacheMemory = value;
      try {
        localStorage.setItem(BALANCE_CACHE_KEY, JSON.stringify(value));
      } catch (e) { /* ignore */ }
    }

    // ── estimate calibration persistence ───────────────────────────────────
    var CALIB_CACHE_KEY = "dsh-better-stats:calib:v1";
    var calibCacheLoaded = false;
    var calibCacheMemory = null;
    function loadCalibCache() {
      if (calibCacheLoaded) return calibCacheMemory;
      calibCacheLoaded = true;
      try {
        var raw = localStorage.getItem(CALIB_CACHE_KEY);
        if (!raw) return calibCacheMemory;
        var parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" &&
            typeof parsed.acc === "number" && parsed.acc > 0 && parsed.acc <= 10 &&
            typeof parsed.reasonDensity === "number" && parsed.reasonDensity > 0 &&
            typeof parsed.outputDensity === "number" && parsed.outputDensity > 0) {
          calibCacheMemory = parsed;
          return calibCacheMemory;
        }
        return calibCacheMemory;
      } catch (e) {
        return calibCacheMemory;
      }
    }
    function saveCalibCache(acc, reasonDensity, outputDensity) {
      calibCacheLoaded = true;
      calibCacheMemory = { acc: acc, reasonDensity: reasonDensity, outputDensity: outputDensity };
      try {
        localStorage.setItem(CALIB_CACHE_KEY, JSON.stringify(calibCacheMemory));
      } catch (e) { /* ignore */ }
    }

    // ── ETA (days-left estimate) ───────────────────────────────────────────
    // Sampled from the /today route: today's Beijing-day spend is normalized
    // by the elapsed fraction of the day, blended with the trailing per-day
    // history (two windows: last 7 days and last 30 days), then smoothed with
    // an EWMA. Labelled with its basis, update time and confidence.
    var ETA_STORAGE_KEY = "dsh-better-stats:eta";
    var ETA_HISTORY_MAX = 30;
    function sampleEta(body, etaRef) {
      try {
        var cost = Number(body.costCny) || 0;
        var date = body.date;
        if (typeof date !== "string" || date === "") return;
        var raw = localStorage.getItem(ETA_STORAGE_KEY);
        var st = null;
        try { st = raw ? JSON.parse(raw) : null; } catch (e) { st = null; }
        if (st === null || typeof st !== "object") st = { date: null, cost: 0, rate: null, history: [] };
        // /today is cached by the host. Re-applying the same snapshot on each
        // client poll would give one observation many EWMA votes and perform a
        // synchronous localStorage write every few seconds. queriedAt is
        // stable for a cached response; old hosts without it keep their prior
        // sampling behaviour.
        var sampleKey = typeof body.queriedAt === "string" && body.queriedAt !== ""
          ? date + "|" + String(body.pricingVersion) + "|" + body.queriedAt
          : null;
        if (sampleKey !== null && st.sampleKey === sampleKey) {
          etaRef.current = st;
          return;
        }
        if (!Array.isArray(st.history)) st.history = [];
        if (st.date !== date) {
          if (st.date !== null && st.date !== void 0 && st.date !== date && Number(st.cost) > 0) {
            st.history.push({ date: st.date, cost: Number(st.cost) });
            if (st.history.length > ETA_HISTORY_MAX) st.history = st.history.slice(-ETA_HISTORY_MAX);
          }
          st.date = date;
          st.cost = cost;
        } else {
          st.cost = cost;
        }
        var d = new Date(Date.now() + 8 * 3600 * 1000);
        var mins = d.getUTCHours() * 60 + d.getUTCMinutes();
        var frac = mins / 1440;
        var todayRate = 0;
        if (cost > 0 && frac > 0.02) todayRate = cost / frac;
        var history = st.history.filter(function (h) { return h !== null && typeof h === "object" && Number(h.cost) > 0; });
        var windowRate = function (n) {
          var take = history.slice(-n);
          if (take.length === 0) return 0;
          var total = 0;
          for (var i = 0; i < take.length; i++) total += Number(take[i].cost);
          return total / take.length;
        };
        var rate7 = windowRate(7);
        var rate30 = windowRate(30);
        var histRate = 0;
        if (rate7 > 0 && rate30 > 0) histRate = rate7 * 0.5 + rate30 * 0.5;
        else if (rate7 > 0) histRate = rate7;
        else if (rate30 > 0) histRate = rate30;
        var blended = 0;
        if (todayRate > 0 && histRate > 0) blended = todayRate * 0.5 + histRate * 0.5;
        else if (todayRate > 0) blended = todayRate;
        else if (histRate > 0) blended = histRate;
        if (blended > 0) {
          var prev = Number(st.rate) || 0;
          st.rate = prev > 0 ? prev * 0.7 + blended * 0.3 : blended;
        }
        st.updatedAt = Date.now();
        if (sampleKey !== null) st.sampleKey = sampleKey;
        st.historyDays = history.length;
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
        // popover shows ONLY the duration ("约可用 X 天 Y 小时") — the
        // 7/30-day basis, update time and confidence stay internal to the
        // rate derivation (sampleEta), never in the row
        if (days >= 1) {
          var dd = Math.floor(days);
          var hh = Math.floor((days - dd) * 24);
          return T(L.etaDays, String(dd), String(hh));
        }
        return T(L.etaHours, String(Math.max(1, Math.round(days * 24))));
      } catch (e) { return ""; }
    }

    // ── group builders ──────────────────────────────────────────────────────
    // meta: { subCount, modelBreakdown, unpricedSteps, invalidSteps, partial,
    //         stale, pricingSourceRow, budgetLines, spendWarn, estimateCny,
    //         peakGroup, balanceWarnCny, balanceCriticalCny, etaText,
    //         turnUsage, turnSpeed, turnSteps, turnOpen, turnActive, hadTurn,
    //         turnToolMs, toolPhaseStart, sessLlmMs, estTokensRaw,
    //         estOutputTokens, estInputTokens, estCacheTokens, estModel }
    function buildGroups(stats, usage, turnCny, totalCny, meta) {
      var groups = [];
      var subCount = meta !== null && meta !== void 0 ? (meta.subCount || 0) : 0;
      var modelBreakdown = meta !== null && meta !== void 0 && meta.modelBreakdown ? meta.modelBreakdown : null;
      var unpricedSteps = meta !== null && meta !== void 0 ? (meta.unpricedSteps || 0) : 0;
      var invalidSteps = meta !== null && meta !== void 0 ? (meta.invalidSteps || 0) : 0;
      var partialCount = meta !== null && meta !== void 0 ? (meta.partialCount || 0) : 0;
      var snapshotPartial = meta !== null && meta !== void 0 && meta.partial === true;
      var snapshotStale = meta !== null && meta !== void 0 && meta.stale === true;
      var estimateCny = meta !== null && meta !== void 0 ? (meta.estimateCny || 0) : 0;
      var sessionRunning = meta !== null && meta !== void 0 && meta.sessionRunning === true;
      var balanceWarnCny = meta !== null && meta !== void 0 ? (meta.balanceWarnCny || 0) : 0;
      var balanceCriticalCny = meta !== null && meta !== void 0 ? (meta.balanceCriticalCny || 0) : 0;
      var balance = meta !== null && meta !== void 0 && meta.balance !== void 0 ? meta.balance : null;
      if (balance !== null) {
        groups.push({ id: "api", label: L.labelApi, text: balance.label, popover: { rows: [{ c: [balance.label, "", ""] }] } });
        if (balance.amount !== null && balance.amount !== void 0) {
          var balDec = balance.decimals !== void 0 ? balance.decimals : moneyDecimals(balance.amount);
          var balText = fmtMoney(currencySymbol(balance.currency), balance.amount, balDec);
          var balPop = balText;
          var etaCell = "";
          if (meta !== null && meta !== void 0 && meta.etaText !== null && meta.etaText !== void 0 && meta.etaText !== "") {
            etaCell = "(" + meta.etaText + ")";
          }
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
          groups.push({
            id: "balance",
            label: L.balance,
            text: balWarn + L.balance + " " + balText,
            value: balText,
            popover: { rows: [{ c: [balPop, etaCell, ""] }] },
            style: balStyle,
            refreshable: true,
            recharge: "https://platform.deepseek.com/top_up",
            rechargeBold: alertOn
          });
        } else {
          groups.push({ id: "balance", label: L.balance, text: balance.text });
        }
      }
      if (meta !== null && meta !== void 0 && meta.peakGroup !== null && meta.peakGroup !== void 0) {
        var pg = meta.peakGroup;
        var peakRows = [];
        peakRows.push({ c: [pg.peak ? L.peakNowDetail : L.offPeakNowDetail, pg.label, T(L.inMinutes, pg.minutesLeft)] });
        if (meta !== null && meta !== void 0 && meta.pricingSourceRow !== null && meta.pricingSourceRow !== void 0) {
          var ps = meta.pricingSourceRow;
          peakRows.push({ label: L.pricingSource, c: [ps.name || "", ps.media || "", ps.at || ""] });
        }
        groups.push({
          id: "peak",
          label: L.labelPeak,
          text: pg.peak ? L.peakNow : L.offPeakNow,
          popover: { rows: peakRows }
        });
      }
      if (usage !== void 0 && usage !== null) {
        var totalShown = turnCny + estimateCny;
        var sessionShown = totalCny + estimateCny;
        var markParts = [];
        if (snapshotStale) markParts.push(L.staleMark);
        if (snapshotPartial || partialCount > 0) markParts.push(L.partialMark);
        var markSuffix = markParts.length > 0 ? " " + markParts.join(" ") : "";
        var spendText = L.turn + " " + fmtMoney("¥", totalShown) +
          " · " + L.session + " " + fmtMoney("¥", sessionShown) + markSuffix;
        var popRows = [];
        if (estimateCny > 0 || sessionRunning) {
          // like the session row: one number + a note — no 精确/估算 split
          popRows.push({ label: L.labelSpend, c: [L.turn, fmtMoney("¥", totalShown, POPOVER_DECIMALS), T(L.inclEstimate, fmtMoney("¥", estimateCny, POPOVER_DECIMALS))] });
        } else {
          popRows.push({ label: L.labelSpend, c: [L.turn, fmtMoney("¥", turnCny, POPOVER_DECIMALS), ""] });
        }
        var sessNotes = [];
        if (unpricedSteps > 0) sessNotes.push(T(L.unpricedNote, unpricedSteps));
        if (invalidSteps > 0) sessNotes.push(T(L.invalidNote, invalidSteps));
        if (partialCount > 0) sessNotes.push(T(L.partialNote, partialCount));
        else if (snapshotPartial) sessNotes.push(" (" + L.partialMark + ")");
        if (snapshotStale) sessNotes.push(" (" + L.staleMark + ")");
        popRows.push({ c: [L.session, fmtMoney("¥", sessionShown, POPOVER_DECIMALS), sessNotes.join("")] });
        if (meta !== null && meta !== void 0 && meta.budgetLines && meta.budgetLines.length > 0) {
          for (var bl = 0; bl < meta.budgetLines.length; bl++) {
            popRows.push({ c: [meta.budgetLines[bl], "", ""] });
          }
        }
        if (subCount > 0) popRows.push({ c: [T(L.subSessions, subCount), "", ""] });
        var groupStyle = void 0;
        if (meta !== null && meta !== void 0 && meta.spendWarn === "over") groupStyle = { color: "#ef4444" };
        else if (meta !== null && meta !== void 0 && meta.spendWarn === "warn") groupStyle = { color: "#f59e0b" };
        var warnMark = meta !== null && meta !== void 0 && meta.spendWarn !== null && meta.spendWarn !== void 0 ? "⚠ " : "";
        groups.push({ id: "spend", label: L.labelSpend, text: warnMark + spendText, popover: { rows: popRows }, style: groupStyle });
      } else {
        // no usage projection at all — the group still shows with a dash
        groups.push({ id: "spend", label: L.labelSpend, text: L.turn + " - · " + L.session + " -" });
      }
      if (stats) {
        var turnRows = [];
        var tSteps = meta !== null && meta !== void 0 ? (meta.turnSteps || 0) : 0;
        var turnOpenMeta = meta !== null && meta !== void 0 && meta.turnOpen === true;
        var turnActiveMeta = meta !== null && meta !== void 0 && meta.turnActive === true;
        if (turnOpenMeta || (turnActiveMeta && tSteps === 0)) tSteps += 1;
        // the turn row only exists while a turn is actually open
        if (turnOpenMeta || turnActiveMeta) {
          turnRows.push({ c: [L.turn, T(L.turns, "1"), T(L.steps, tSteps)] });
        }
        turnRows.push({ c: [L.session, T(L.turns, stats.turns), T(L.steps, stats.steps)] });
        groups.push({ id: "turns", label: L.labelTurns, text: T(L.turnsSteps, stats.turns, stats.steps), popover: { rows: turnRows } });
        var durations = [];
        if (stats.llmMs > 0) durations.push(L.llm + " " + formatDuration(stats.llmMs));
        if (stats.toolMs > 0) durations.push(L.tool + " " + formatDuration(stats.toolMs));
        {
          var timeRows = [];
          var ts2 = meta !== null && meta !== void 0 && meta.turnSpeed ? meta.turnSpeed : null;
          var openStepElapsed = 0;
          if (ts2 !== null && ts2.openStep !== null && typeof ts2.openStep.startTime === "number" && Number.isFinite(ts2.openStep.startTime)) {
            openStepElapsed = Math.max(0, Date.now() - ts2.openStep.startTime);
          }
          var turnLlmTotal = (ts2 !== null ? finiteNonNegative(ts2.llmMs) : 0) + openStepElapsed;
          var turnLlm = turnLlmTotal > 0 ? L.llm + " " + formatDurationPop(turnLlmTotal) : L.llm + " " + L.zeroS;
          var turnToolMs = meta !== null && meta !== void 0 ? (meta.turnToolMs || 0) : 0;
          var tpStart = meta !== null && meta !== void 0 ? (meta.toolPhaseStart || null) : null;
          if (tpStart !== null) turnToolMs += Math.max(0, Date.now() - tpStart);
          var turnTool = turnToolMs > 0 ? L.tool + " " + formatDurationPop(turnToolMs) : L.tool + " " + L.zeroS;
          timeRows.push({ c: [L.turn, turnLlm, turnTool] });
          var sessLlmMsBase = meta !== null && meta !== void 0 && typeof meta.sessLlmMs === "number" ? meta.sessLlmMs : 0;
          var sessLlmTotal = sessLlmMsBase + openStepElapsed;
          var sessLlm = sessLlmTotal > 0 ? L.llm + " " + formatDurationPop(sessLlmTotal) : L.llm + " " + L.zeroS;
          var sessTool = stats.toolMs > 0 ? L.tool + " " + formatDurationPop(stats.toolMs) : L.tool + " " + L.zeroS;
          timeRows.push({ c: [L.session, sessLlm, sessTool] });
          groups.push({ id: "time", label: L.labelTime, text: durations.length > 0 ? durations.join(" · ") : L.llm + " - · " + L.tool + " -", popover: { rows: timeRows } });
        }
        var speeds = [];
        if (stats.ttftSteps > 0) speeds.push(L.ttftAvg + " " + formatTtft(stats.ttftMs / stats.ttftSteps));
        if (stats.decodeMs > 0) speeds.push(formatTps(stats.decodeTokens / (stats.decodeMs / 1000)));
        {
          var speedRows = [];
          var ts3 = meta !== null && meta !== void 0 && meta.turnSpeed ? meta.turnSpeed : null;
          var sessionRunningMeta = meta !== null && meta !== void 0 && meta.sessionRunning === true;
          var openSp = ts3 !== null && ts3.openStep !== null ? ts3.openStep : null;
          var liveTtftMs = 0;
          var liveTtftSteps = 0;
          if (openSp !== null && typeof openSp.startTime === "number" && Number.isFinite(openSp.startTime)) {
            if (openSp.firstTokenTime !== null && typeof openSp.firstTokenTime === "number" && Number.isFinite(openSp.firstTokenTime)) {
              liveTtftMs = Math.max(0, openSp.firstTokenTime - openSp.startTime);
              liveTtftSteps = 1;
            }
          }
          // 本轮 tok/s = the API-standard throughput: (settled output tokens
          // + in-flight token fragments×segFactor) / (settled decodeMs +
          // the open step's live decode window). The live window is the
          // PUSH-DOMAIN span (last token event's arrival − first token
          // event's arrival): the constant push latency cancels between the
          // two anchors, so the window matches the settle's server-domain
          // decodeMs and the usage chunk (≈3ms before the message) folds the
          // step's REAL tokens into the settled totals with no visible jump.
          // Server-time fallback (lastTokEvt − firstTokenTime) covers steps
          // whose events carry no wall anchor (tests / replay).
          var cumToks = ts3 !== null ? finiteNonNegative(ts3.decodeTokens) : 0;
          var cumMs = ts3 !== null ? finiteNonNegative(ts3.decodeMs) : 0;
          var openLive = 0;
          if (openSp !== null && openSp.firstTokenTime !== null && typeof openSp.firstTokenTime === "number" && Number.isFinite(openSp.firstTokenTime)) {
            var fw = meta !== null && meta !== void 0 && typeof meta.firstTokWall === "number" && Number.isFinite(meta.firstTokWall) ? meta.firstTokWall : null;
            var lw = meta !== null && meta !== void 0 && typeof meta.lastTokWall === "number" && Number.isFinite(meta.lastTokWall) ? meta.lastTokWall : null;
            // replayed steps (started before the page watched them) must use
            // the SERVER-time window — the wall anchors would only count the
            // time on the current page, spiking tok/s after a session switch
            if (openSp.replayed !== true && fw !== null && lw !== null && lw - fw > 0) {
              openLive = Math.max(0, lw - fw);
            } else {
              var le = meta !== null && meta !== void 0 && typeof meta.lastTokEvt === "number" && Number.isFinite(meta.lastTokEvt) ? meta.lastTokEvt : null;
              if (le !== null) {
                openLive = Math.max(0, le - openSp.firstTokenTime);
              } else {
                openLive = Math.max(0, Date.now() - openSp.firstTokenTime);
              }
            }
          }
          var liveSegs = meta !== null && meta !== void 0 ? finiteNonNegative(meta.liveSegs) : 0;
          var segFactor = meta !== null && meta !== void 0 && typeof meta.segFactor === "number" && Number.isFinite(meta.segFactor) && meta.segFactor > 0
            ? meta.segFactor : SEG_FACTOR_INIT;
          if (liveSegs > 0 && openLive > 0) {
            cumToks += liveSegs * segFactor;
            cumMs += openLive;
          }
          if (sessionRunningMeta || (ts3 !== null && ts3.ttftSteps > 0)) {
            var totTtftMs = (ts3 !== null ? finiteNonNegative(ts3.ttftMs) : 0) + liveTtftMs;
            var totTtftSteps = (ts3 !== null ? finiteNonNegative(ts3.ttftSteps) : 0) + liveTtftSteps;
            var tTtft = totTtftSteps > 0 ? L.ttftAvg + " " + formatTtftPop(totTtftMs / totTtftSteps) : L.ttftAvg + " --";
            var tTps = cumMs > 0 ? formatTps(cumToks / (cumMs / 1000)) : "--";
            speedRows.push({ c: [L.turn, tTtft, tTps] });
          }
          var sParts = [];
          if (stats.ttftSteps > 0) sParts.push(L.ttftAvg + " " + formatTtft(stats.ttftMs / stats.ttftSteps));
          if (stats.decodeMs > 0) sParts.push(formatTps(stats.decodeTokens / (stats.decodeMs / 1000)));
          if (sParts.length > 0) {
            speedRows.push({
              c: [L.session, stats.ttftSteps > 0 ? L.ttftAvg + " " + formatTtftPop(stats.ttftMs / stats.ttftSteps) : "", stats.decodeMs > 0 ? formatTps(stats.decodeTokens / (stats.decodeMs / 1000)) : ""]
            });
          }
          if (speedRows.length === 0) speedRows.push({ c: [L.turn, "--", "--"] });
          groups.push({ id: "speed", label: L.labelSpeed, text: speeds.length > 0 ? speeds.join(" · ") : "--", popover: { rows: speedRows } });
        }
      } else {
        // no stats projection at all — turns/time/speed still show with dashes
        groups.push({ id: "turns", label: L.labelTurns, text: L.labelTurns + " -" });
        groups.push({ id: "time", label: L.labelTime, text: L.llm + " - · " + L.tool + " -" });
        groups.push({ id: "speed", label: L.labelSpeed, text: "--" });
      }
      if (usage !== void 0 && usage !== null) {
        var hit = cacheHitPercent(usage);
        if (hit !== null) {
          var cacheRows = [];
          var tu = meta !== null && meta !== void 0 && meta.turnUsage ? meta.turnUsage : null;
          var sessionRunningMeta = meta !== null && meta !== void 0 && meta.sessionRunning === true;
          var hadTurnMeta = meta !== null && meta !== void 0 && meta.hadTurn === true;
          if (tu !== null && ((tu.cacheReadTokens || 0) > 0 || billedInputTokens(tu) > 0 || sessionRunningMeta || hadTurnMeta)) {
            var tCache = (tu.cacheReadTokens || 0) + (meta !== null && meta !== void 0 ? (meta.estCacheTokens || 0) : 0);
            var tIn = billedInputTokens(tu) + (meta !== null && meta !== void 0 ? (meta.estInputTokens || 0) : 0);
            var tTot = tCache + tIn;
            var thit = tTot > 0 ? (tCache / tTot * 100).toFixed(2) : "0.00";
            cacheRows.push({ c: [L.turn, L.cache + " " + fmtTokens(tCache), L.hit + " " + thit + "%"] });
          }
          cacheRows.push({ c: [L.session, L.cache + " " + fmtTokens(usage.cacheReadTokens || 0), L.hit + " " + hit + "%"] });
          groups.push({
            id: "cache",
            label: L.labelCache,
            text: L.cache + " " + fmtTokens(usage.cacheReadTokens || 0) + " · " + L.hit + " " + hit + "%",
            popover: { rows: cacheRows }
          });
        }
        // 输入输出组 — label "Tok"; popover splits 本轮 vs 会话 only. The
        // per-model rows live in the LAST group 模型 (below Tok).
        var tokRows = [];
        var tu2 = meta !== null && meta !== void 0 && meta.turnUsage ? meta.turnUsage : null;
        var sessionRunningMeta2 = meta !== null && meta !== void 0 && meta.sessionRunning === true;
        var hadTurnMeta2 = meta !== null && meta !== void 0 && meta.hadTurn === true;
        if (tu2 !== null && (billedInputTokens(tu2) > 0 || (tu2.outputTokens || 0) > 0 || sessionRunningMeta2 || hadTurnMeta2)) {
          var turnOut = (tu2.outputTokens || 0) + (meta !== null && meta !== void 0 ? (meta.estOutputTokens || 0) : 0);
          var turnIn = billedInputTokens(tu2) + (meta !== null && meta !== void 0 ? (meta.estInputTokens || 0) : 0);
          tokRows.push({ c: [L.turn, L.input + " " + fmtTokens(turnIn), L.output + " " + fmtTokens(turnOut)] });
        }
        // model rows computed ONCE, shared by the Tok session totals and the
        // 模型 group (token shares include unknown tokens in the denominator)
        var liveTotalIn = 0;
        var liveTotalOut = 0;
        var modelRows = [];
        var estModel = meta !== null && meta !== void 0 ? meta.estModel : void 0;
        if (modelBreakdown !== null && modelBreakdown.length > 0) {
          for (var tm2 = 0; tm2 < modelBreakdown.length; tm2++) {
            var tent = modelBreakdown[tm2];
            if (tent === void 0 || tent === null) continue;
            var u = tent.usage;
            var uIn = u !== void 0 && u !== null ? billedInputTokens(u) : 0;
            var uOut = u !== void 0 && u !== null ? (u.outputTokens || 0) : 0;
            if (typeof estModel === "string" && tent.model === estModel) {
              uIn += meta !== null && meta !== void 0 ? (meta.estInputTokens || 0) : 0;
              uOut += meta !== null && meta !== void 0 ? (meta.estOutputTokens || 0) : 0;
            }
            if (uIn <= 0 && uOut <= 0 && (Number(tent.costCny) || 0) <= 0) continue;
            liveTotalIn += uIn;
            liveTotalOut += uOut;
            modelRows.push({
              model: tent.model,
              short: String(tent.model).replace("deepseek-", ""),
              uIn: uIn,
              uOut: uOut,
              costCny: Number(tent.costCny) || 0
            });
          }
        }
        var hasModelRows = modelRows.length > 0;
        var sessIn = hasModelRows ? liveTotalIn : billedInputTokens(usage);
        var sessOut = hasModelRows ? liveTotalOut : (usage.outputTokens || 0);
        tokRows.push({ c: [L.session, L.input + " " + fmtTokens(sessIn), L.output + " " + fmtTokens(sessOut)] });
        groups.push({
          id: "tok",
          label: L.labelTok,
          text: L.input + " " + fmtTokens(sessIn) + " · " + L.output + " " + fmtTokens(sessOut),
          popover: { rows: tokRows }
        });
        // 模型 group — the LAST popover group (below Tok). ONE title row
        // ("本轮对话用到的模型"), then per model:
        //   v4-pro       花费 ¥x        (占比%)
        //                输入 x         (占比%)
        //                输出 y         (占比%)
        // Cost share is the share of PRICED cost; token shares include
        // unknown. Popover-only (never rendered on the strip).
        if (modelRows.length > 0) {
          var pricedTotal = 0;
          for (var pt = 0; pt < modelRows.length; pt++) {
            if (modelRows[pt].model !== "unknown") pricedTotal += modelRows[pt].costCny;
          }
          // the group label ("模型") sits on the FIRST model's cost row —
          // directly followed by the model name, then 花费 and the share
          var modelsRows = [];
          for (var mr = 0; mr < modelRows.length; mr++) {
            var mrow = modelRows[mr];
            var inPct = liveTotalIn > 0 ? (mrow.uIn / liveTotalIn * 100).toFixed(2) : "0.00";
            var outPct = liveTotalOut > 0 ? (mrow.uOut / liveTotalOut * 100).toFixed(2) : "0.00";
            var costCell = mrow.model === "unknown"
              ? L.unpricedLabel
              : L.labelSpend + " " + fmtMoney("¥", mrow.costCny, POPOVER_DECIMALS);
            var pctCell = mrow.model === "unknown" ? "" : "(" + (pricedTotal > 0 ? mrow.costCny / pricedTotal * 100 : 0).toFixed(2) + "%)";
            modelsRows.push({ c: [mrow.short, costCell, pctCell] });
            modelsRows.push({ c: ["", L.input + " " + fmtTokens(mrow.uIn), "(" + inPct + "%)"] });
            modelsRows.push({ c: ["", L.output + " " + fmtTokens(mrow.uOut), "(" + outPct + "%)"] });
          }
          groups.push({
            id: "models",
            label: L.labelModels,
            text: "",
            popoverOnly: true,
            popover: { rows: modelsRows }
          });
        }
      }
      return groups;
    }

    function pageHidden() {
      try {
        return typeof document !== "undefined" && document.hidden === true;
      } catch (e) { return false; }
    }

    function BetterStatsLine(props) {
      try {
        return BetterStatsLineInner(props);
      } catch (error) {
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

    // ── outer: WORKSPACE-scoped state (survives session switches) ──────────
    function BetterStatsLineInner(props) {
      var useProjection = props && typeof props.useProjection === "function" ? props.useProjection : null;
      var useSessions = props && typeof props.useSessions === "function" ? props.useSessions : null;
      var sessionId = props && typeof props.sessionId === "string" ? props.sessionId : null;

      var balanceState = react.useState(loadBalanceCache());
      var balance = balanceState[0];
      var setBalance = balanceState[1];

      var hoverState = react.useState(false);
      var hovered = hoverState[0];
      var setHovered = hoverState[1];

      var anchorState = react.useState(null);
      var anchor = anchorState[0];
      var setAnchor = anchorState[1];

      var etaRef = react.useRef(null);
      var balanceRefreshRef = react.useRef(null);
      var refreshPulseState = react.useState(false);
      var refreshPulse = refreshPulseState[0];
      var setRefreshPulse = refreshPulseState[1];
      // pricing/budget carried by the balance route (workspace-wide fallback)
      var workspaceMetaRef = react.useRef({ pricing: null, budget: null });

      react.useEffect(function () {
        var alive = true;
        var requestSeq = 0;
        var controller = null;
        function load(force) {
          var seq = ++requestSeq;
          if (controller !== null && typeof controller.abort === "function") controller.abort();
          controller = typeof AbortController === "function" ? new AbortController() : null;
          var fetchOpts = { cache: "no-store" };
          if (controller !== null) fetchOpts.signal = controller.signal;
          fetch("/plugins/better-stats/balance" + (force ? "?force=1" : ""), fetchOpts)
            .then(function (res) {
              if (!res.ok) throw new Error("balance http " + res.status);
              return res.json();
            })
            .then(function (body) {
              if (!alive || seq !== requestSeq) return;
              if (body && body.pricing && typeof body.pricing === "object" && body.pricing.tables) {
                workspaceMetaRef.current.pricing = body.pricing;
              }
              if (body && body.budget && typeof body.budget === "object") {
                workspaceMetaRef.current.budget = body.budget;
              }
              if (body && body.configured === true && (body.status === "ok" || body.status === "stale") &&
                  typeof body.amount === "number" && Number.isFinite(body.amount) && body.amount >= 0) {
                var label = body.displayName || PROVIDER_LABELS[body.provider] || (typeof body.provider === "string" ? body.provider : "DeepSeek");
                var amountDecimals = typeof body.amountDecimals === "number" && Number.isInteger(body.amountDecimals) && body.amountDecimals >= 0 && body.amountDecimals <= 12
                  ? body.amountDecimals
                  : moneyDecimals(body.amount);
                var next = {
                  text: label + " " + fmtMoney(currencySymbol(body.currency), body.amount, amountDecimals),
                  label: label,
                  amount: body.amount,
                  currency: body.currency || "CNY",
                  decimals: amountDecimals,
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
              if (!alive || seq !== requestSeq) return;
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
          requestSeq += 1;
          if (controller !== null && typeof controller.abort === "function") controller.abort();
          if (balanceRefreshRef.current === load) balanceRefreshRef.current = null;
          if (hideTimerRef.current !== null) clearTimeout(hideTimerRef.current);
          if (workspaceMetaRef.current && workspaceMetaRef.current.refreshTimer !== void 0) {
            clearTimeout(workspaceMetaRef.current.refreshTimer);
            workspaceMetaRef.current.refreshTimer = void 0;
          }
          clearInterval(timer);
        };
      }, []);

      // 100ms hide grace: the popover sits above the line; leaving the line
      // toward it must not kill it instantly.
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

      // ETA text re-derived from the LATEST balance on every render.
      var etaText = etaTextOf(etaRef.current, balance);

      return react.createElement(SessionStats, {
        key: sessionId === null ? "no-session" : sessionId,
        sessionId: sessionId,
        useProjection: useProjection,
        useSessions: useSessions,
        balance: balance,
        hovered: hovered,
        anchor: anchor,
        setHovered: setHovered,
        setAnchor: setAnchor,
        scheduleHide: scheduleHide,
        cancelHide: cancelHide,
        etaRef: etaRef,
        etaText: etaText,
        workspaceMetaRef: workspaceMetaRef,
        balanceForceRefresh: balanceRefreshRef,
        refreshPulse: refreshPulse,
        setRefreshPulse: setRefreshPulse
      });
    }

    // ── inner: SESSION-scoped strip (key={sessionId} → full rebuild on
    //    session switch: estimate/model/cursor/turn/server/live state) ───────
    function SessionStats(props) {
      var sessionId = props.sessionId;
      var useProjection = props.useProjection;
      var useSessions = props.useSessions;
      var balance = props.balance;
      var hovered = props.hovered;
      var anchor = props.anchor;
      var setHovered = props.setHovered;
      var setAnchor = props.setAnchor;
      var scheduleHide = props.scheduleHide;
      var cancelHide = props.cancelHide;
      var etaRef = props.etaRef;
      var etaText = props.etaText;
      var workspaceMetaRef = props.workspaceMetaRef;
      var balanceForceRefresh = props.balanceForceRefresh;
      var refreshPulse = props.refreshPulse;
      var setRefreshPulse = props.setRefreshPulse;

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

      // Hook arguments are evaluated on every render. Initialise the
      // calibration-backed fold lazily so the 100ms ticker never performs a
      // synchronous localStorage read + JSON parse after the first mount.
      var estimateRef = react.useRef(null);
      if (estimateRef.current === null) {
        var calibInit = loadCalibCache();
        estimateRef.current = {
        next: 0,
        // event index at MOUNT (first fold pass): events below it are
        // replayed history (switch-back), events at/above it arrived live.
        // Replayed token events must NOT stamp wall anchors — their
        // Date.now() would be the fold moment, not the real arrival, so the
        // live window would only count time on the current page (tok/s
        // spikes to thousands after a session switch-back, then falls).
        mountLen: null,
        reason: { cjk: 0, rest: 0 },
        text: { cjk: 0, rest: 0 },
        tool: { cjk: 0, rest: 0 },
        reasonDensity: calibInit !== null ? calibInit.reasonDensity : EST_DENSITY_REASON,
        outputDensity: calibInit !== null ? calibInit.outputDensity : EST_DENSITY_OUTPUT,
        inputCny: 0,
        inputTarget: 0,
        inputShown: 0,
        inputTokTarget: 0,
        inputTokShown: 0,
        cacheTokTarget: 0,
        cacheTokShown: 0,
        lastUsage: null,
        lastModel: void 0,
        activeRouteModel: void 0,
        splicedTurns: [],
        sawStepStart: false,
        batchSeen: freshBatchSeen(),
        deltaFallback: freshDeltaFallback(),
        estTokensOut: 0,      // corrected total-output estimate (shared by 金额/Tok/速率)
        turnCost: 0,
        turnSamples: new Map(),
        // session-scoped exact fold (ALL turns of the root, never reset at
        // turn/start — only the remount resets it). Mirrors the host's root
        // fold on the same events, so 会话 never lags 本轮 in the first round
        // (the /live poll is 1s, the /cost snapshot cache 10s).
        sessCost: 0,
        sessSamples: new Map(),
        // Cached exact aggregates for the 100ms render hot path. They are
        // invalidated only when the append cursor sees a usage replacement or
        // the seed boundary rewinds the fold.
        sessSampleRevision: 0,
        sessAggregateRevision: -1,
        sessUsageCache: zeroUsage(),
        sessUnpricedCache: 0,
        pricedVersion: null,
        // seed boundary for the session fold: the host folds the root from
        // startIndex: seedLength (inherited prefix excluded) — the client
        // must too, or a forked session's 会话 would include the parent's
        // cost. null = unknown (first /live poll); rebuilt when it lands.
        sessSeed: null,
        turnUsage: { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
        turnSpeed: { ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0, llmMs: 0, openStep: null },
        turnSteps: 0,
        turnActive: false,
        curTurn: null,
        hadTurn: false,
        turnToolMs: 0,
        lastToolPhaseStart: null,
        estAccuracy: calibInit !== null ? calibInit.acc : 1,
        stepLocalAcc: null,   // the CURRENT step's own real÷est ratio (set at
                              // its usage chunk) — the estimate after the chunk
                              // uses THIS, so the settle lands on the real
                              // value instead of the lagging global EMA
        prevStepAcc: null,    // the PREVIOUS step's measured ratio — a strong
                              // prior for the current step's early estimate
                              // (consecutive steps share content density), so
                              // the pre-chunk streaming rate is close to real
        liveSegs: 0,          // token fragments (texts/args lengths) received
                              // for the CURRENT open step — the API-standard
                              // live token numerator (≈99% of real tokens)
        segFactor: SEG_FACTOR_INIT, // fragment→token factor, EMA-calibrated
                              // by LARGE settled steps only (short steps'
                              // fragments are merged by the assembler)
        firstTokWall: null,   // Date.now() when the step's FIRST token event
                              // arrived — the live denominator anchor
        lastTokWall: null,    // Date.now() when the step's LAST token event
                              // arrived. The live decode window is
                              // (lastTokWall − firstTokWall): a PUSH-DOMAIN
                              // span, so the constant push latency cancels
                              // out and the settle (server-domain decodeMs)
                              // lands on the displayed value instead of
                              // jumping back by the latency share.
        lastTokEvt: null,     // server-time (ev.time) of the last token event —
                              // fallback denominator for tests/edge steps
                              // whose token events carry no wall anchor
        sessStat: {
          turns: 0, steps: 0, llmMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0,
          lastTurn: null, openStep: null
        }
        };
      }
      var pricingRef = react.useRef(null);
      var budgetRef = react.useRef(null);
      var todayState = react.useState(null);
      var todayCost = todayState[0];
      var setTodayCost = todayState[1];

      // ── server-side whole-tree snapshot (/cost, ~15s) ─────────────────────
      var costState = react.useState(null);
      var serverCost = costState[0];
      var setServerCost = costState[1];
      react.useEffect(function () {
        if (sessionId === null) return;
        var alive = true;
        var requestSeq = 0;
        var controller = null;
        var inFlight = false;
        function load() {
          if (inFlight) return;
          inFlight = true;
          var seq = ++requestSeq;
          controller = typeof AbortController === "function" ? new AbortController() : null;
          var fetchOpts = { cache: "no-store" };
          if (controller !== null) fetchOpts.signal = controller.signal;
          fetch("/plugins/better-stats/cost?sessionId=" + encodeURIComponent(sessionId), fetchOpts)
            .then(function (res) {
              if (!res.ok) throw new Error("cost http " + res.status);
              return res.json();
            })
            .then(function (body) {
              if (!alive || seq !== requestSeq || !body || typeof body.merged !== "object" || body.merged === null) return;
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
                  outputTokens: Number(body.merged.outputTokens) || 0,
                  reasoningTokens: Number(body.merged.reasoningTokens) || 0
                },
                // null = "no answer yet"; a legal 0 is kept verbatim
                costCny: typeof body.costCny === "number" && Number.isFinite(body.costCny) ? body.costCny : null,
                root: body.root && typeof body.root === "object" ? body.root : null,
                descendants: body.descendants && typeof body.descendants === "object" ? body.descendants : null,
                models: Array.isArray(body.models) ? body.models : null,
                unpricedSteps: Number(body.unpricedSteps) || 0,
                invalidSteps: Number(body.invalidSteps) || 0,
                partial: body.partial === true,
                failedSessionCount: Number(body.failedSessionCount) || 0,
                persistenceAvailable: body.persistenceAvailable === true,
                // Missing on legacy hosts. Keep absence distinct from the
                // authoritative legal zero so local lineage remains visible.
                descendantCount: typeof body.descendantCount === "number" && Number.isFinite(body.descendantCount) &&
                  body.descendantCount >= 0 && Number.isInteger(body.descendantCount) ? body.descendantCount : null,
                rootEventRevision: typeof body.rootEventRevision === "number" && Number.isFinite(body.rootEventRevision) && body.rootEventRevision >= 0 && Number.isInteger(body.rootEventRevision) ? body.rootEventRevision : null,
                eventRevision: typeof body.eventRevision === "number" && Number.isFinite(body.eventRevision) && body.eventRevision >= 0 && Number.isInteger(body.eventRevision) ? body.eventRevision : null,
                pricingVersion: typeof body.pricingVersion === "number" && Number.isFinite(body.pricingVersion) && body.pricingVersion >= 0 && Number.isInteger(body.pricingVersion) ? body.pricingVersion : null,
                pricing: body.pricing && typeof body.pricing === "object" ? body.pricing : null,
                stale: body.stale === true,
                at: Date.now()
              });
            })
            .catch(function () { /* keep previous value */ })
            .then(function () { if (seq === requestSeq) { controller = null; inFlight = false; } });
        }
        load();
        var timer = setInterval(load, 15000);
        return function () {
          alive = false;
          requestSeq += 1;
          if (controller !== null && typeof controller.abort === "function") controller.abort();
          clearInterval(timer);
        };
      }, [sessionId]);

      // ── live ROOT edges (/live, 1s) — merged with /cost descendants ──────
      var liveState = react.useState(null);
      var liveInfo = liveState[0];
      var setLiveInfo = liveState[1];
      react.useEffect(function () {
        if (sessionId === null) return;
        var alive = true;
        var requestSeq = 0;
        var controller = null;
        var inFlight = false;
        function poll() {
          if (inFlight) return;
          inFlight = true;
          var seq = ++requestSeq;
          controller = typeof AbortController === "function" ? new AbortController() : null;
          var fetchOpts = { cache: "no-store" };
          if (controller !== null) fetchOpts.signal = controller.signal;
          fetch("/plugins/better-stats/live?sessionId=" + encodeURIComponent(sessionId), fetchOpts)
            .then(function (res) {
              if (!res.ok) throw new Error("live http " + res.status);
              return res.json();
            })
            .then(function (body) {
              if (!alive || seq !== requestSeq || body === void 0 || body === null || typeof body.openStepStart === "undefined") return;
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
                rootCostCny: typeof body.rootCostCny === "number" && Number.isFinite(body.rootCostCny) ? body.rootCostCny : null,
                rootUsage: body.rootUsage && typeof body.rootUsage === "object" ? body.rootUsage : null,
                models: Array.isArray(body.models) ? body.models : null,
                eventRevision: typeof body.eventRevision === "number" && Number.isFinite(body.eventRevision) && body.eventRevision >= 0 && Number.isInteger(body.eventRevision) ? body.eventRevision : null,
                unpricedSteps: Number(body.unpricedSteps) || 0,
                invalidSteps: Number(body.invalidSteps) || 0,
                seedLength: typeof body.seedLength === "number" && Number.isFinite(body.seedLength) && body.seedLength >= 0 && Number.isInteger(body.seedLength) ? body.seedLength : null,
                pricing: body.pricing && typeof body.pricing === "object" ? body.pricing : null,
                budget: body.budget && typeof body.budget === "object" ? body.budget : null,
                at: Date.now()
              });
            })
            .catch(function () { /* keep previous value */ })
            .then(function () { if (seq === requestSeq) { controller = null; inFlight = false; } });
        }
        poll();
        var timer = setInterval(poll, 1000);
        return function () {
          alive = false;
          requestSeq += 1;
          if (controller !== null && typeof controller.abort === "function") controller.abort();
          clearInterval(timer);
        };
      }, [sessionId]);

      // ── today's workspace spend (budget display + ETA sampling) ──────────
      react.useEffect(function () {
        if (sessionId === null) return;
        var alive = true;
        var requestSeq = 0;
        var controller = null;
        var inFlight = false;
        function load() {
          if (inFlight) return;
          inFlight = true;
          var seq = ++requestSeq;
          controller = typeof AbortController === "function" ? new AbortController() : null;
          var fetchOpts = { cache: "no-store" };
          if (controller !== null) fetchOpts.signal = controller.signal;
          fetch("/plugins/better-stats/today", fetchOpts)
            .then(function (res) {
              if (!res.ok) throw new Error("today http " + res.status);
              return res.json();
            })
            .then(function (body) {
              if (!alive || seq !== requestSeq || !body || typeof body.costCny !== "number" ||
                  !Number.isFinite(body.costCny) || body.costCny < 0) return;
              if (body.pricing && typeof body.pricing === "object" && body.pricing.tables) pricingRef.current = body.pricing;
              if (body.budget && typeof body.budget === "object") budgetRef.current = body.budget;
              var b2 = budgetRef.current;
              // A partial fold is a lower bound; a stale response is an old
              // bound. Neither is a valid ETA observation. For budget display,
              // keep the same day's last complete value and only move upward
              // when the incomplete lower bound is already higher, so a read
              // failure can never make an existing warning disappear.
              if (body.partial === true || body.stale === true) {
                if (b2 === null || !(Number(b2.daily) > 0 || Number(b2.monthly) > 0)) {
                  setTodayCost(null);
                  return;
                }
                setTodayCost(function (prev) {
                  if (prev === null || typeof body.date !== "string" || prev.date !== body.date) return null;
                  var partialMonth = typeof body.monthCostCny === "number" && Number.isFinite(body.monthCostCny) && body.monthCostCny >= 0
                    ? body.monthCostCny : null;
                  return {
                    date: prev.date,
                    costCny: Math.max(finiteNonNegative(prev.costCny), body.costCny),
                    monthCostCny: prev.monthCostCny === null || prev.monthCostCny === void 0
                      ? partialMonth
                      : (partialMonth === null ? prev.monthCostCny : Math.max(finiteNonNegative(prev.monthCostCny), partialMonth)),
                    unpricedSteps: Math.max(finiteNonNegative(prev.unpricedSteps), finiteNonNegative(body.unpricedSteps)),
                    invalidSteps: Math.max(finiteNonNegative(prev.invalidSteps), finiteNonNegative(body.invalidSteps)),
                    sessionCount: Math.max(finiteNonNegative(prev.sessionCount), finiteNonNegative(body.sessionCount)),
                    at: prev.at
                  };
                });
                return;
              }
              sampleEta(body, etaRef);
              if (b2 === null || !(Number(b2.daily) > 0 || Number(b2.monthly) > 0)) {
                setTodayCost(null);
                return;
              }
              setTodayCost({
                date: typeof body.date === "string" ? body.date : null,
                costCny: body.costCny,
                monthCostCny: typeof body.monthCostCny === "number" && Number.isFinite(body.monthCostCny) && body.monthCostCny >= 0 ? body.monthCostCny : null,
                unpricedSteps: Number(body.unpricedSteps) || 0,
                invalidSteps: Number(body.invalidSteps) || 0,
                sessionCount: Number(body.sessionCount) || 0,
                at: Date.now()
              });
            })
            .catch(function () { /* keep previous value */ })
            .then(function () { if (seq === requestSeq) { controller = null; inFlight = false; } });
        }
        load();
        // The host snapshot itself is cached for 60s. Polling more often only
        // repeated the same fold/ETA sample and added needless wakeups.
        var timer = setInterval(load, 60000);
        return function () {
          alive = false;
          requestSeq += 1;
          if (controller !== null && typeof controller.abort === "function") controller.abort();
          clearInterval(timer);
        };
      }, [sessionId]);

      // ── fast live ticker ──────────────────────────────────────────────────
      // Resolve the two gates before creating the effect so idle sessions do
      // not own a permanent 100ms interval. Hook order remains unchanged.
      var sessionRunning = false;
      try {
        var tickerListById = list !== null && typeof list === "object" ? list.byId : null;
        sessionRunning = !!(tickerListById && sessionId !== null && tickerListById[sessionId] && tickerListById[sessionId].running === true);
      } catch (e) { sessionRunning = false; }
      var hasLiveEdges = sessionRunning && liveInfo !== null && (
        (liveInfo.openStepStart !== null && liveInfo.openStepStart !== void 0) ||
        (liveInfo.toolPhaseStart !== null && liveInfo.toolPhaseStart !== void 0) ||
        (liveInfo.pendingMin !== null && liveInfo.pendingMin !== void 0)
      );
      // 100ms cadence so 1-decimal seconds advance 0.1 at a time. Bumps only
      // while the session runs AND a live edge exists (an open step or an
      // in-flight tool phase) AND the page is visible — idle/no-edge/hidden
      // sessions render zero extra frames. The event fold below is
      // cursor-gated (new events only) and layout measurement runs only on
      // signature/size changes.
      var tickState = react.useState(0);
      var tickBump = tickState[1];
      var runningRef = react.useRef({ running: false, hasLive: false });
      react.useEffect(function () {
        if (!sessionRunning || !hasLiveEdges) return;
        var timer = setInterval(function () {
          var g = runningRef.current;
          if (g !== null && g.running === true && g.hasLive === true && !pageHidden()) {
            tickBump(function (t) { return t + 1; });
          }
        }, 100);
        return function () { clearInterval(timer); };
      }, [sessionRunning, hasLiveEdges]);

      var sessionModelRef = react.useRef({
        lastModel: void 0,
        samples: new Map(),
        byModel: new Map()
      });

      // Layout/separator state (declared unconditionally to keep hook order).
      var layoutState = react.useState(null);
      var layout = layoutState[0];
      var setLayout = layoutState[1];
      var layoutRef = react.useRef(null);
      var prevUsageRef = react.useRef(null);
      var turnCostRef = react.useRef(0);
      var sepState = react.useState([]);
      var sepHidden = sepState[0];
      var setSepHidden = sepState[1];
      var trailingCache = react.useRef("");
      var itemRefs = react.useRef([]);
      var sepProbeRef = react.useRef(null);
      var measureRef = react.useRef(null);
      var lineRef = react.useRef(null);
      var ellideState = react.useState(null);
      var ellide = ellideState[0];
      var setEllide = ellideState[1];
      var ellideRef = react.useRef(null);
      var widthsRef = react.useRef({});

      function measureAnchor() {
        var el = lineRef.current;
        if (el === null) return;
        var rect = el.getBoundingClientRect();
        setAnchor({ left: rect.left + rect.width / 2, top: rect.top - 8 });
      }
      function openPopover() {
        measureAnchor();
        setHovered(true);
      }
      function closePopover() {
        cancelHide();
        setHovered(false);
      }

      runningRef.current = { running: sessionRunning, hasLive: hasLiveEdges };

      // The event cursor below maintains both the active request route and the
      // last settled model. Reusing that state avoids scanning the entire log
      // backwards on every 100ms live render.
      var currentModel = estimateRef.current !== null && typeof estimateRef.current.activeRouteModel === "string"
        ? estimateRef.current.activeRouteModel
        : (estimateRef.current !== null && typeof estimateRef.current.lastModel === "string" ? estimateRef.current.lastModel : DEFAULT_MODEL);
      var clientEvents = null;
      try {
        var liveSessBinding = sessionsService !== null && sessionId !== null
          ? sessionsService.binding(sessionId)
          : void 0;
        clientEvents = liveSessBinding !== void 0 && liveSessBinding.session !== void 0
          ? liveSessBinding.session.events
          : null;
      } catch (e) { /* keep the default model */ }

      // effective usage: host tree-merged snapshot when available, else the
      // client-side merge
      var effective = serverCost !== null ? serverCost.merged : merged;

      // host-driven pricing/budget: session polls first, workspace (balance
      // route) as fallback, builtin tables as the last resort
      var hostPricing = null;
      if (liveInfo !== null && liveInfo.pricing !== null && liveInfo.pricing.tables) hostPricing = liveInfo.pricing;
      else if (serverCost !== null && serverCost.pricing !== null && serverCost.pricing.tables) hostPricing = serverCost.pricing;
      else if (workspaceMetaRef.current !== null && workspaceMetaRef.current.pricing !== null && workspaceMetaRef.current.pricing.tables) hostPricing = workspaceMetaRef.current.pricing;
      var effectiveTables = hostPricing !== null ? hostPricing.tables : PRICE_TABLES;
      var effectiveLedger = hostPricing !== null && Array.isArray(hostPricing.ledger) ? hostPricing.ledger : [];
      var effectivePricingVersion = hostPricing !== null && typeof hostPricing.version === "number" &&
        Number.isFinite(hostPricing.version) && hostPricing.version >= 0
        ? Math.floor(hostPricing.version)
        : 0;
      var pricingSourceRow = { name: L.pricingKindBuiltin, media: "", at: "" };
      if (hostPricing !== null && hostPricing.source === "official") {
        pricingSourceRow = { name: "DeepSeek", media: L.pricingMediaOfficial, at: beijingDateLabel(hostPricing.fetchedAt) };
      } else if (hostPricing !== null && hostPricing.source === "stale") {
        pricingSourceRow = { name: "DeepSeek", media: L.pricingKindStale, at: "" };
      }

      // Accounting flags — all from the SAME tree snapshot (live root figures
      // only fill the gap before the first snapshot lands).
      var unpricedSteps = 0;
      var invalidSteps = 0;
      var snapshotPartial = false;
      var snapshotStale = false;
      var failedSessionCount = 0;
      if (serverCost !== null) {
        unpricedSteps = serverCost.unpricedSteps;
        invalidSteps = serverCost.invalidSteps;
        snapshotPartial = serverCost.partial === true;
        snapshotStale = serverCost.stale === true;
        failedSessionCount = serverCost.failedSessionCount;
      } else if (liveInfo !== null) {
        unpricedSteps = liveInfo.unpricedSteps;
        invalidSteps = liveInfo.invalidSteps;
      }

      // ── turn-scoped 本轮: exact turn fold + streaming estimate ───────────
      var estimateCny = 0;
      var exactTurnCny = 0;
      if (clientEvents !== null) {
        try {
          var estState = estimateRef.current;
          var estLen = clientEvents.length;
          if (estLen >= estState.next) {
            if (estState.pricedVersion !== effectivePricingVersion) {
              estState.turnCost = repriceSamples(estState.turnSamples, effectiveTables, effectiveLedger);
              estState.sessCost = repriceSamples(estState.sessSamples, effectiveTables, effectiveLedger);
              repriceModelState(sessionModelRef.current, effectiveTables, effectiveLedger);
              estState.pricedVersion = effectivePricingVersion;
            }
            if (estState.mountLen === null) estState.mountLen = estLen;
            var reason = estState.reason;
            var text = estState.text;
            var tool = estState.tool;
            var inputCny = estState.inputCny;
            var lastUsage = estState.lastUsage;
            var sawStepStart = estState.sawStepStart;
            var batchSeen = estState.batchSeen !== void 0 ? estState.batchSeen : freshBatchSeen();
            var deltaFallback = estState.deltaFallback !== void 0 ? estState.deltaFallback : freshDeltaFallback();
            var activeRouteModel = estState.activeRouteModel;
            var splicedTurns = Array.isArray(estState.splicedTurns) ? estState.splicedTurns : [];
            var lastModel = estState.lastModel !== void 0 ? estState.lastModel : currentModel;
            var turnCost = estState.turnCost;
            var turnSamples = estState.turnSamples;
            var sessCost = estState.sessCost;
            var sessSamples = estState.sessSamples;
            var turnUsage = estState.turnUsage;
            // the session fold must skip the inherited SEED prefix exactly
            // like the host's root fold (startIndex: seedLength) — the seed's
            // usage belongs to the parent session, never to this one. The
            // authoritative boundary comes from /live (seedLength); the
            // binding header is a fallback. null = not known yet.
            var sessSeed = null;
            try {
              if (liveInfo !== null && liveInfo !== void 0 && typeof liveInfo.seedLength === "number") {
                sessSeed = Math.floor(liveInfo.seedLength);
              } else {
                var sessHdr = liveSessBinding !== void 0 && liveSessBinding.session !== void 0 ? liveSessBinding.session.header : void 0;
                if (sessHdr !== void 0 && sessHdr !== null && typeof sessHdr === "object") {
                  // A present header with no seedLength means an ordinary
                  // no-seed session: fold every event. This is also the legacy
                  // host fallback for explicit seedLength: 0.
                  sessSeed = typeof sessHdr.seedLength === "number" && Number.isFinite(sessHdr.seedLength) && sessHdr.seedLength > 0
                    ? Math.floor(sessHdr.seedLength)
                    : 0;
                } else {
                  // no /live answer yet AND no header: a session without a
                  // parent link is its own root (seed 0); a forked one waits
                  // for the boundary (null) — never folds the seed into 会话
                  var sessRow = list !== null && typeof list === "object" && list.byId ? list.byId[sessionId] : void 0;
                  if (sessRow !== void 0 && sessRow !== null &&
                      (sessRow.origin === "subagent" || sessRow.origin === "fork")) {
                    sessSeed = typeof sessRow.seedLength === "number" && Number.isFinite(sessRow.seedLength) && sessRow.seedLength > 0
                      ? Math.floor(sessRow.seedLength)
                      : 0;
                  } else if (sessRow === void 0 || sessRow === null || sessRow.parentId === void 0 || sessRow.parentId === null || sessRow.parentId === "") {
                    sessSeed = 0;
                  }
                }
              }
            } catch (e) { sessSeed = 0; }
            // The seed boundary arrived/changed. Start BOTH the turn and
            // session folds at that boundary: inherited events may warm the
            // request route and the next-input prior, but must never appear as
            // this fork's current turn, timing, tokens, model rows or cost.
            // Rewinding the incremental cursor to the boundary lets the normal
            // event path rebuild every post-seed value once, rather than
            // maintaining a second subtly different replay implementation.
            if (sessSeed !== null && estState.sessSeed !== sessSeed) {
              estState.sessSeed = sessSeed;
              sessSamples = new Map();
              sessCost = 0;
              estState.sessSampleRevision = finiteNonNegative(estState.sessSampleRevision) + 1;
              estState.sessStat = {
                turns: 0, steps: 0, llmMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0,
                lastTurn: null, openStep: null
              };
              var rebuiltModels = { lastModel: void 0, samples: new Map(), byModel: new Map() };
              sessionModelRef.current = rebuiltModels;

              turnSamples = new Map();
              turnCost = 0;
              turnUsage = { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
              estState.turnUsage = turnUsage;
              estState.turnSpeed = { ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0, llmMs: 0, openStep: null };
              estState.turnSteps = 0;
              estState.turnActive = false;
              estState.curTurn = null;
              splicedTurns = [];
              estState.hadTurn = false;
              estState.turnToolMs = 0;
              estState.lastToolPhaseStart = null;
              estState.prevStepAcc = null;
              estState.stepLocalAcc = null;
              estState.liveSegs = 0;
              estState.firstTokWall = null;
              estState.lastTokWall = null;
              estState.lastTokEvt = null;
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
              batchSeen = freshBatchSeen();
              deltaFallback = freshDeltaFallback();
              estState.estTokensOut = 0;
              lastUsage = null;

              var priorFallbackModel = lastModel;
              var seedModel;
              var seedRouteModel;
              // Prefix events do not enter any totals, but they do warm the
              // active route. A fork's first own request may reuse the route
              // recorded at the end of its inherited seed.
              var prefixLimit = Math.min(Math.max(sessSeed, 0), estLen);
              for (var sei = 0; sei < prefixLimit; sei++) {
                var sev = clientEvents[sei];
                if (sev === void 0 || sev === null || typeof sev !== "object") continue;
                var sed = sev.data;
                var srm = requestModelOf(sev);
                if (srm !== void 0) { seedRouteModel = srm; rebuiltModels.lastModel = srm; }
                if (sed === void 0 || sed === null) continue;
                var sourceModel = sev.type === "assistant/message" && sed.message && sed.message.source && typeof sed.message.source.model === "string"
                  ? sed.message.source.model
                  : void 0;
                if (typeof sourceModel === "string" && sourceModel !== "") {
                  seedModel = sourceModel;
                  seedRouteModel = sourceModel;
                  rebuiltModels.lastModel = sourceModel;
                }
                var prefixRawUsage = null;
                if (sev.type === "assistant/chunk" && sed.chunk && sed.chunk.type === "usage") prefixRawUsage = sed.chunk.usage;
                else if (sev.type === "assistant/message") prefixRawUsage = sed.usage;
                var prefixUsage = strictUsageBucket(prefixRawUsage);
                if (prefixUsage !== null) {
                  lastUsage = {
                    inputTokens: prefixUsage.uncachedInputTokens,
                    cacheReadTokens: prefixUsage.cacheReadTokens
                  };
                }
              }
              activeRouteModel = seedRouteModel;
              lastModel = seedModel !== void 0 ? seedModel
                : (seedRouteModel !== void 0 ? seedRouteModel : (sessSeed === 0 ? priorFallbackModel : void 0));
              if (rebuiltModels.lastModel === void 0 && typeof lastModel === "string" && lastModel !== "") {
                rebuiltModels.lastModel = lastModel;
              }
              estState.next = prefixLimit;
            }
            var turnSpeed = estState.turnSpeed;
            var turnActive = estState.turnActive;
            var curTurn = estState.curTurn;
            var sessStat = estState.sessStat;
            var hadTurn = estState.hadTurn;
            function touchTokWall(evtTime, replayEvt) {
              // any token-bearing event (batch chunks or sampled delta)
              // advances the live decode window; evtTime is the server-time
              // fallback used when the wall anchors are absent. REPLAYED
              // events (history folded at mount) must NOT stamp the wall
              // anchors — their Date.now() would be the fold moment, not the
              // real arrival, so a switch-back session's window would only
              // count the time on the current page (tok/s spikes to
              // thousands, then slowly falls as the window grows). A step
              // that STARTED as replayed stays server-windowed for its whole
              // life (its first token predates the mount).
              var os = turnSpeed.openStep;
              if (replayEvt !== true && os !== null && os.replayed !== true) {
                var now = Date.now();
                if (estState.firstTokWall === null) estState.firstTokWall = now;
                estState.lastTokWall = now;
              }
              if (typeof evtTime === "number" && Number.isFinite(evtTime)) estState.lastTokEvt = evtTime;
            }
            function sessStatFold(ev) {
              foldSessionStatEvent(sessStat, ev);
            }
            function sessionModelUpsert(ev, eventIndex) {
              if (sessSeed === null || eventIndex < sessSeed) return;
              if (ev.data === void 0 || ev.data === null) return;
              if (curTurn !== null && ev.data.turn !== void 0 && ev.data.turn !== null && Number(ev.data.turn) !== Number(curTurn)) return;
              var sm = sessionModelRef.current;
              var model = activeRouteModel !== void 0 ? activeRouteModel : sm.lastModel;
              if (ev.type === "assistant/message" && ev.data.message !== void 0) {
                var source = ev.data.message.source;
                if (source && typeof source.model === "string" && source.model !== "") model = source.model;
              }
              if (typeof model === "string" && model !== "") sm.lastModel = model;
              var rawUsage = null;
              if (ev.type === "assistant/chunk" && ev.data.chunk && ev.data.chunk.type === "usage") rawUsage = ev.data.chunk.usage;
              else if (ev.type === "assistant/message") rawUsage = ev.data.usage;
              if (rawUsage !== null && rawUsage !== void 0) {
                sessCost = upsertTurnSample(sessSamples, sessCost, ev.data.turn, ev.data.step, rawUsage, model, ev.time, effectiveTables, null, effectiveLedger);
                upsertModelSample(sm, ev, model, effectiveTables, effectiveLedger);
                // A valid appended sample or same-step replacement changes
                // the aggregate; an invalid one only causes one harmless
                // refresh for this event batch.
                estState.sessSampleRevision = finiteNonNegative(estState.sessSampleRevision) + 1;
              }
            }
            for (var ei = estState.next; ei < estLen; ei++) {
              var ev = clientEvents[ei];
              if (ev === void 0 || ev === null || typeof ev !== "object") continue;
              // events below the mount index are REPLAYED history (the
              // component just (re)mounted with an existing log): their wall
              // anchors would be the fold moment, not the real arrival — the
              // rate must use the server-time window instead
              var replayEvt = estState.mountLen !== null && ei < estState.mountLen;
              var routedTurn = ev.data !== void 0 && ev.data !== null ? ev.data.turn : void 0;
              var routedModel = requestModelOf(ev);
              // A fork whose boundary is still unknown must not briefly expose
              // inherited totals. Keep only non-accounting route/input priors;
              // when seedLength arrives the cursor rewinds to the exact edge.
              if (sessSeed === null || ei < sessSeed) {
                if (routedModel !== void 0) {
                  activeRouteModel = routedModel;
                  sessionModelRef.current.lastModel = routedModel;
                }
                if (ev.type === "assistant/message" && ev.data && ev.data.message && ev.data.message.source) {
                  var warmModel = ev.data.message.source.model;
                  if (typeof warmModel === "string" && warmModel !== "") {
                    activeRouteModel = warmModel;
                    lastModel = warmModel;
                    sessionModelRef.current.lastModel = warmModel;
                  }
                }
                var warmRaw = ev.type === "assistant/chunk" && ev.data && ev.data.chunk && ev.data.chunk.type === "usage"
                  ? ev.data.chunk.usage
                  : (ev.type === "assistant/message" && ev.data ? ev.data.usage : null);
                var warmUsage = strictUsageBucket(warmRaw);
                if (warmUsage !== null) {
                  lastUsage = { inputTokens: warmUsage.uncachedInputTokens, cacheReadTokens: warmUsage.cacheReadTokens };
                }
                continue;
              }

              // A subagent's complete transcript may be spliced inside the
              // active parent turn. Once its differing turn opens, even events
              // without a turn (request/context, batch/tool events) belong to
              // that child until its boundary closes. Persist this small guard
              // across incremental renders so no child route, estimate, usage
              // or boundary can steer/close the parent fold.
              var guardedTurn = null;
              if ((typeof routedTurn === "number" || typeof routedTurn === "string") &&
                  !(typeof routedTurn === "string" && routedTurn.trim() === "")) {
                var guardedNumber = Number(routedTurn);
                if (Number.isFinite(guardedNumber) && guardedNumber >= 0 && Number.isInteger(guardedNumber)) guardedTurn = guardedNumber;
              }
              var parentTurnNumber = curTurn !== null ? Number(curTurn) : null;
              var splicedEvent = false;
              if (turnActive && parentTurnNumber !== null && Number.isFinite(parentTurnNumber)) {
                if (splicedTurns.length > 0) {
                  if (guardedTurn === parentTurnNumber) {
                    splicedTurns = [];
                  } else {
                    if (ev.type === "turn/start" && guardedTurn !== null) {
                      if (splicedTurns[splicedTurns.length - 1] !== guardedTurn) splicedTurns.push(guardedTurn);
                    } else if (ev.type === "turn/end" && guardedTurn !== null) {
                      var nestedAt = splicedTurns.lastIndexOf(guardedTurn);
                      if (nestedAt !== -1) splicedTurns.splice(nestedAt, 1);
                    }
                    splicedEvent = true;
                  }
                } else if (guardedTurn !== null && guardedTurn !== parentTurnNumber) {
                  if (ev.type !== "turn/end") splicedTurns.push(guardedTurn);
                  splicedEvent = true;
                }
              }
              if (splicedEvent) {
                continue;
              }
              if (routedModel !== void 0) {
                // Request routing arrives before the assistant message. It is
                // therefore the best model for the usage chunk; a later
                // message source remains authoritative and can replace it.
                activeRouteModel = routedModel;
                sessionModelRef.current.lastModel = routedModel;
              }
              sessStatFold(ev);
              if (ev.type === "turn/start") {
                if (!validEventIndex(ev.data && ev.data.turn)) continue;
                splicedTurns = [];
                turnSamples = new Map();
                turnCost = 0;
                turnActive = true;
                hadTurn = true;
                estState.turnToolMs = 0;
                estState.lastToolPhaseStart = null;
                estState.prevStepAcc = null; // fresh turn: no prior step
                curTurn = ev.data !== void 0 && ev.data !== null ? ev.data.turn : null;
                estState.turnUsage = { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
                turnUsage = estState.turnUsage;
                estState.turnSpeed = { ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0, llmMs: 0, openStep: null };
                turnSpeed = estState.turnSpeed;
                estState.turnSteps = 0;
                estState.liveSegs = 0;
                estState.firstTokWall = null;
                estState.lastTokWall = null;
                estState.lastTokEvt = null;
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
                batchSeen = freshBatchSeen();
                deltaFallback = freshDeltaFallback();
                estState.estTokensOut = 0;
                estState.stepLocalAcc = null;
              } else if (ev.type === "turn/end") {
                if (!validEventIndex(ev.data && ev.data.turn)) continue;
                turnActive = false;
                curTurn = null;
                splicedTurns = [];
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
                batchSeen = freshBatchSeen();
                deltaFallback = freshDeltaFallback();
                estState.estTokensOut = 0;
                estState.stepLocalAcc = null;
                estState.liveSegs = 0;
                estState.firstTokWall = null;
                estState.lastTokWall = null;
                estState.lastTokEvt = null;
              } else if (!turnActive) {
                sessionModelUpsert(ev, ei);
                continue;
              } else if (ev.type === "reasoning-chunks" && ev.data !== void 0 && Array.isArray(ev.data.texts)) {
                if (ev.data.texts.length > 0) {
                  if (!batchSeen.reason) rollbackFallbackDelta(reason, deltaFallback.reason, estState);
                  batchSeen.reason = true;
                  classifyChars(reason, ev.data.texts.join(""));
                  estState.liveSegs = (estState.liveSegs || 0) + ev.data.texts.length;
                  touchTokWall(ev.time, replayEvt);
                }
              } else if (ev.type === "text-chunks" && ev.data !== void 0 && Array.isArray(ev.data.texts)) {
                if (ev.data.texts.length > 0) {
                  if (!batchSeen.text) rollbackFallbackDelta(text, deltaFallback.text, estState);
                  batchSeen.text = true;
                  classifyChars(text, ev.data.texts.join(""));
                  estState.liveSegs = (estState.liveSegs || 0) + ev.data.texts.length;
                  touchTokWall(ev.time, replayEvt);
                }
              } else if (ev.type === "tool-call-chunks" && ev.data !== void 0 && Array.isArray(ev.data.args)) {
                if (ev.data.args.length > 0) {
                  if (!batchSeen.tool) rollbackFallbackDelta(tool, deltaFallback.tool, estState);
                  batchSeen.tool = true;
                  classifyChars(tool, ev.data.args.join(""));
                  estState.liveSegs = (estState.liveSegs || 0) + ev.data.args.length;
                  touchTokWall(ev.time, replayEvt);
                }
              } else if (ev.type === "assistant/chunk" && ev.data !== void 0 && ev.data.chunk !== void 0) {
                var ck = ev.data.chunk;
                if (ck.type === "usage" && ck.usage !== void 0 && ck.usage !== null) {
                  var settledUsage = strictUsageBucket(ck.usage);
                  var settledTurn = Number(ev.data.turn);
                  var settledStep = Number(ev.data.step);
                  var validSettleSample = settledUsage !== null &&
                    Number.isFinite(settledTurn) && settledTurn >= 0 && Number.isInteger(settledTurn) &&
                    Number.isFinite(settledStep) && settledStep >= 0 && Number.isInteger(settledStep) &&
                    typeof ev.time === "number" && Number.isFinite(ev.time) && ev.time >= 0;
                  if (validSettleSample) {
                    touchTokWall(ev.time, replayEvt);
                    calibrateEstDensity(estState, reason, text, tool, ck.usage);
                    {
                      var estStepTokens =
                        (reason.cjk + reason.rest / estState.reasonDensity) +
                        (text.cjk + text.rest / estState.outputDensity) +
                        (tool.cjk + tool.rest / estState.outputDensity);
                      // outputTokens already contains reasoningTokens.
                      var realStepTokens = settledUsage.outputTokens;
                      if (estStepTokens > 0 && realStepTokens > 0) {
                        var accNow = realStepTokens / estStepTokens;
                        if (Number.isFinite(accNow) && accNow >= 0.1 && accNow <= 10) {
                          estState.stepLocalAcc = accNow;
                          estState.prevStepAcc = accNow;
                          estState.estAccuracy = estState.estAccuracy + (accNow - estState.estAccuracy) * CALIB_EMA_NEW;
                          saveCalibCache(estState.estAccuracy, estState.reasonDensity, estState.outputDensity);
                        }
                      }
                    }
                    var usageModel = activeRouteModel !== void 0 ? activeRouteModel : lastModel;
                    if (usageModel !== void 0) lastModel = usageModel;
                    turnCost = upsertTurnSample(turnSamples, turnCost, ev.data.turn, ev.data.step, ck.usage, usageModel, ev.time, effectiveTables, turnUsage, effectiveLedger);
                    sessionModelUpsert(ev, ei);
                    // The usage chunk is the exact hand-off point. Fold its
                    // real tokens once, close even a zero-output step, then
                    // discard every provisional char/fragment contribution.
                    var outTk = settledUsage.outputTokens;
                    if (turnSpeed.openStep !== null && turnSpeed.openStep.turn === ev.data.turn && turnSpeed.openStep.step === ev.data.step) {
                      var osU = turnSpeed.openStep;
                      if (typeof ev.time === "number" && Number.isFinite(ev.time) &&
                          typeof osU.startTime === "number" && Number.isFinite(osU.startTime)) {
                        turnSpeed.llmMs += Math.max(0, ev.time - osU.startTime);
                        if (osU.firstTokenTime !== null && typeof osU.firstTokenTime === "number" && Number.isFinite(osU.firstTokenTime)) {
                          turnSpeed.ttftMs += Math.max(0, osU.firstTokenTime - osU.startTime);
                          turnSpeed.ttftSteps += 1;
                          turnSpeed.decodeMs += Math.max(0, ev.time - osU.firstTokenTime);
                          turnSpeed.decodeTokens += outTk;
                        }
                      }
                      turnSpeed.openStep = null;
                    }
                    // fragment→token factor: re-calibrated by LARGE steps only
                    var liveSegsNow = Number(estState.liveSegs);
                    if (!Number.isFinite(liveSegsNow) || liveSegsNow < 0) liveSegsNow = 0;
                    if (liveSegsNow >= SEG_FACTOR_MIN_SEGS && outTk > 0) {
                      var realF = outTk / liveSegsNow;
                      if (Number.isFinite(realF) && realF > 0.3 && realF < 3) {
                        var oldFactor = typeof estState.segFactor === "number" && Number.isFinite(estState.segFactor) && estState.segFactor > 0
                          ? estState.segFactor : SEG_FACTOR_INIT;
                        estState.segFactor = oldFactor + (realF - oldFactor) * SEG_FACTOR_EMA_NEW;
                      }
                    }
                    estState.liveSegs = 0;
                    reason.cjk = 0; reason.rest = 0;
                    text.cjk = 0; text.rest = 0;
                    tool.cjk = 0; tool.rest = 0;
                    batchSeen = freshBatchSeen();
                    deltaFallback = freshDeltaFallback();
                    estState.estTokensOut = 0;
                    estState.firstTokWall = null;
                    estState.lastTokWall = null;
                    estState.lastTokEvt = null;
                    inputCny = 0;
                    estState.inputShown = 0;
                    estState.inputTarget = 0;
                    estState.inputTokShown = 0;
                    estState.inputTokTarget = 0;
                    estState.cacheTokShown = 0;
                    estState.cacheTokTarget = 0;
                    sawStepStart = false;
                    estState.stepLocalAcc = null;
                    lastUsage = {
                      inputTokens: settledUsage.uncachedInputTokens,
                      cacheReadTokens: settledUsage.cacheReadTokens
                    };
                  }
                } else if (ck.type === "text-delta" || ck.type === "reasoning-delta" || ck.type === "tool-call-delta") {
                  var deltaKind = ck.type === "reasoning-delta" ? "reason" : (ck.type === "text-delta" ? "text" : "tool");
                  var deltaText = ck.type === "tool-call-delta"
                    ? ((typeof ck.name === "string" ? ck.name : "") + (typeof ck.argumentsDelta === "string" ? ck.argumentsDelta : ""))
                    : (typeof ck.text === "string" ? ck.text : "");
                  var hasDeltaToken = deltaText !== "";
                  if (hasDeltaToken && !batchSeen[deltaKind]) {
                    var deltaTarget = deltaKind === "reason" ? reason : (deltaKind === "text" ? text : tool);
                    if (addFallbackDelta(deltaTarget, deltaFallback[deltaKind], deltaText)) {
                      estState.liveSegs = (estState.liveSegs || 0) + 1;
                      touchTokWall(ev.time, replayEvt);
                    }
                  }
                  if (hasDeltaToken && turnSpeed.openStep !== null && turnSpeed.openStep.firstTokenTime === null &&
                      typeof ev.time === "number" && Number.isFinite(ev.time)) {
                    turnSpeed.openStep.firstTokenTime = ev.time;
                  }
                }
              } else if (ev.type === "assistant/message" && ev.data !== void 0 && ev.data.message !== void 0) {
                var msgModel = ev.data.message && ev.data.message.source ? ev.data.message.source.model : void 0;
                if (typeof msgModel === "string" && msgModel !== "" && ev.data.turn === curTurn) {
                  // The producer recorded on the completed message is the
                  // final authority for this route and replaces any hint.
                  lastModel = msgModel;
                  activeRouteModel = msgModel;
                }
                var messageUsage = ev.data.usage !== void 0 ? strictUsageBucket(ev.data.usage) : null;
                var nestedMessageUsage = ev.data.message.usage !== void 0 ? strictUsageBucket(ev.data.message.usage) : null;
                var rateUsage = messageUsage !== null ? messageUsage : nestedMessageUsage;
                var os = turnSpeed.openStep;
                if (os !== null && os.turn === ev.data.turn && os.step === ev.data.step) {
                  if (typeof ev.time === "number" && Number.isFinite(ev.time) &&
                      typeof os.startTime === "number" && Number.isFinite(os.startTime)) {
                    turnSpeed.llmMs += Math.max(0, ev.time - os.startTime);
                    if (os.firstTokenTime !== null && typeof os.firstTokenTime === "number" && Number.isFinite(os.firstTokenTime)) {
                      turnSpeed.ttftMs += Math.max(0, os.firstTokenTime - os.startTime);
                      turnSpeed.ttftSteps += 1;
                      if (rateUsage !== null) {
                        // outputTokens already includes reasoningTokens
                        turnSpeed.decodeMs += Math.max(0, ev.time - os.firstTokenTime);
                        turnSpeed.decodeTokens += rateUsage.outputTokens;
                      }
                    }
                  }
                  turnSpeed.openStep = null;
                }
                if (messageUsage !== null) {
                  calibrateEstDensity(estState, reason, text, tool, ev.data.usage);
                  var messageUsageModel = typeof msgModel === "string" && msgModel !== ""
                    ? msgModel : (activeRouteModel !== void 0 ? activeRouteModel : lastModel);
                  turnCost = upsertTurnSample(turnSamples, turnCost, ev.data.turn, ev.data.step, ev.data.usage, messageUsageModel, ev.time, effectiveTables, turnUsage, effectiveLedger);
                  sessionModelUpsert(ev, ei);
                  // rate settle fallback for steps WITHOUT a usage chunk
                  var outTk2 = messageUsage.outputTokens;
                  var liveSegsNow2 = Number(estState.liveSegs);
                  if (!Number.isFinite(liveSegsNow2) || liveSegsNow2 < 0) liveSegsNow2 = 0;
                  if (liveSegsNow2 >= SEG_FACTOR_MIN_SEGS && outTk2 > 0) {
                    var realF2 = outTk2 / liveSegsNow2;
                    if (Number.isFinite(realF2) && realF2 > 0.3 && realF2 < 3) {
                      var oldFactor2 = typeof estState.segFactor === "number" && Number.isFinite(estState.segFactor) && estState.segFactor > 0
                        ? estState.segFactor : SEG_FACTOR_INIT;
                      estState.segFactor = oldFactor2 + (realF2 - oldFactor2) * SEG_FACTOR_EMA_NEW;
                    }
                  }
                  lastUsage = {
                    inputTokens: messageUsage.uncachedInputTokens,
                    cacheReadTokens: messageUsage.cacheReadTokens
                  };
                }
                // A completed message ends provisional streaming display even
                // when its usage object is absent or malformed.
                estState.liveSegs = 0;
                reason.cjk = 0; reason.rest = 0;
                text.cjk = 0; text.rest = 0;
                tool.cjk = 0; tool.rest = 0;
                batchSeen = freshBatchSeen();
                deltaFallback = freshDeltaFallback();
                estState.estTokensOut = 0;
                estState.firstTokWall = null;
                estState.lastTokWall = null;
                estState.lastTokEvt = null;
                inputCny = 0;
                estState.inputShown = 0;
                estState.inputTarget = 0;
                estState.inputTokShown = 0;
                estState.inputTokTarget = 0;
                estState.cacheTokShown = 0;
                estState.cacheTokTarget = 0;
                sawStepStart = false;
                estState.stepLocalAcc = null;
              } else if (ev.type === "step/start") {
                if (!validEventIndex(ev.data && ev.data.turn) || !validEventIndex(ev.data && ev.data.step)) continue;
                turnSpeed.openStep = {
                  turn: ev.data !== void 0 ? ev.data.turn : void 0,
                  step: ev.data !== void 0 ? ev.data.step : void 0,
                  startTime: ev.time,
                  firstTokenTime: null,
                  // a step that began in the REPLAYED history never stamps
                  // wall anchors: its first token predates the mount, so the
                  // wall span would only count time on the current page
                  replayed: replayEvt === true
                };
                reason.cjk = 0; reason.rest = 0;
                text.cjk = 0; text.rest = 0;
                tool.cjk = 0; tool.rest = 0;
                batchSeen = freshBatchSeen();
                deltaFallback = freshDeltaFallback();
                estState.estTokensOut = 0;
                estState.stepLocalAcc = null;
                estState.liveSegs = 0;
                estState.firstTokWall = null;
                estState.lastTokWall = null;
                estState.lastTokEvt = null;
                if (lastUsage !== null && !sawStepStart) {
                  // the next-step input estimate prices with the PARENT turn's
                  // guarded lastModel — never the global scan (a spliced
                  // subagent message must not re-price the parent's input)
                  inputCny = cnyCost({
                    uncachedInputTokens: lastUsage.inputTokens,
                    cacheReadTokens: lastUsage.cacheReadTokens,
                    cacheWriteTokens: 0,
                    outputTokens: 0
                  }, Date.now(), lastModel, effectiveTables, effectiveLedger);
                  estState.inputTarget = inputCny;
                  estState.inputTokTarget = Number(lastUsage.inputTokens) || 0;
                  estState.cacheTokTarget = Number(lastUsage.cacheReadTokens) || 0;
                }
                sawStepStart = true;
              } else if (ev.type === "step/end") {
                if (!validEventIndex(ev.data && ev.data.turn) || !validEventIndex(ev.data && ev.data.step)) continue;
                turnSpeed.openStep = null;
                estState.turnSteps = (estState.turnSteps || 0) + 1;
                estState.stepLocalAcc = null;
                estState.liveSegs = 0;
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
                batchSeen = freshBatchSeen();
                deltaFallback = freshDeltaFallback();
                estState.estTokensOut = 0;
                estState.firstTokWall = null;
                estState.lastTokWall = null;
                estState.lastTokEvt = null;
              }
            }
            estimateRef.current = {
              next: estLen,
              mountLen: estState.mountLen,
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
              activeRouteModel: activeRouteModel,
              splicedTurns: splicedTurns,
              sawStepStart: sawStepStart,
              batchSeen: batchSeen,
              deltaFallback: deltaFallback,
              estTokensOut: estState.estTokensOut,
              turnCost: turnCost,
              turnSamples: turnSamples,
              sessCost: sessCost,
              sessSamples: sessSamples,
              sessSampleRevision: estState.sessSampleRevision,
              sessAggregateRevision: estState.sessAggregateRevision,
              sessUsageCache: estState.sessUsageCache,
              sessUnpricedCache: estState.sessUnpricedCache,
              sessSeed: estState.sessSeed,
              pricedVersion: estState.pricedVersion,
              turnUsage: estState.turnUsage,
              turnSpeed: estState.turnSpeed,
              turnSteps: estState.turnSteps,
              turnActive: turnActive,
              curTurn: curTurn,
              hadTurn: hadTurn,
              turnToolMs: estState.turnToolMs,
              lastToolPhaseStart: estState.lastToolPhaseStart,
              estAccuracy: estState.estAccuracy,
              stepLocalAcc: estState.stepLocalAcc,
              prevStepAcc: estState.prevStepAcc,
              sessStat: sessStat,
              liveSegs: estState.liveSegs,
              segFactor: estState.segFactor,
              firstTokWall: estState.firstTokWall,
              lastTokWall: estState.lastTokWall,
              lastTokEvt: estState.lastTokEvt
            };
          }
          exactTurnCny = estimateRef.current.turnCost;
          if (sessionRunning && liveInfo !== null && liveInfo.openStepStart !== null && liveInfo.openStepStart !== void 0) {
            var estOutPrice = 0;
            var estPriceModel = typeof estimateRef.current.activeRouteModel === "string" && estimateRef.current.activeRouteModel !== ""
              ? estimateRef.current.activeRouteModel
              : (estimateRef.current.lastModel !== void 0 && estimateRef.current.lastModel !== null
                  ? estimateRef.current.lastModel
                  : currentModel);
            var estTable = effectiveTables[modelKeyOf(estPriceModel)];
            if (estTable !== void 0 && estTable !== null) {
              var estPeak = beijingPeak(Date.now());
              estOutPrice = estPeak ? estTable.outPeak : estTable.out;
            }
            var estCur = estimateRef.current;
            estCur.inputShown = estCur.inputShown + (estCur.inputTarget - estCur.inputShown) * 0.45;
            estCur.inputTokShown = estCur.inputTokShown + (estCur.inputTokTarget - estCur.inputTokShown) * 0.45;
            estCur.cacheTokShown = estCur.cacheTokShown + (estCur.cacheTokTarget - estCur.cacheTokShown) * 0.45;
            var estTokensUnc =
              (estCur.reason.cjk + estCur.reason.rest / estCur.reasonDensity) +
              (estCur.text.cjk + estCur.text.rest / estCur.outputDensity) +
              (estCur.tool.cjk + estCur.tool.rest / estCur.outputDensity);
            // ONE corrected total-output estimate × estAccuracy — the SAME
            // value feeds 金额, Tok and 速率 (settled steps use real values)
            var accUse = estCur.stepLocalAcc !== null && estCur.stepLocalAcc !== void 0
              ? estCur.stepLocalAcc
              : (estCur.prevStepAcc !== null && estCur.prevStepAcc !== void 0
                  ? estCur.prevStepAcc
                  : (typeof estCur.estAccuracy === "number" && estCur.estAccuracy > 0 ? estCur.estAccuracy : 1));
            estCur.estTokensOut = estTokensUnc * accUse;
            estimateCny = estCur.estTokensOut * estOutPrice / 1e6 + estCur.inputShown;
          }
        } catch (e) {
          estimateCny = 0;
          exactTurnCny = 0;
        }
      }

      // ── turn-scoped tool time accumulation ────────────────────────────────
      if (estimateRef.current !== null) {
        var tpNow = liveInfo !== null && typeof liveInfo.toolPhaseStart === "number" && Number.isFinite(liveInfo.toolPhaseStart) ? liveInfo.toolPhaseStart : null;
        var estTool = estimateRef.current;
        var lastTp = typeof estTool.lastToolPhaseStart === "number" && Number.isFinite(estTool.lastToolPhaseStart) ? estTool.lastToolPhaseStart : null;
        if (lastTp !== null && (tpNow === null || tpNow !== lastTp)) {
          estTool.turnToolMs = (estTool.turnToolMs || 0) + Math.max(0, Date.now() - lastTp);
        }
        estTool.lastToolPhaseStart = tpNow;
      }

      // Budget status + popover lines
      var budgetLines = [];
      var spendWarn = null;
      var budget = liveInfo !== null && liveInfo.budget !== null ? liveInfo.budget : (budgetRef.current !== null ? budgetRef.current : null);
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

      var peakInfo = beijingPeakNext(Date.now());

      // New hosts expose a root event revision. In that mode freshness is
      // selected by revision (never by amount: a correction may be smaller).
      // Old hosts have no revision, so retain the established magnitude
      // heuristic for backwards compatibility.
      var snapDescCost = serverCost !== null && serverCost.descendants !== null && typeof serverCost.descendants.costCny === "number" && Number.isFinite(serverCost.descendants.costCny) ? serverCost.descendants.costCny : 0;
      var clientSessCost = estimateRef.current !== null && typeof estimateRef.current.sessCost === "number" ? estimateRef.current.sessCost : 0;
      var clientSeed = estimateRef.current !== null ? estimateRef.current.sessSeed : null;
      var clientRootReady = clientEvents !== null && estimateRef.current !== null &&
        typeof clientSeed === "number" && Number.isInteger(clientSeed) && clientSeed >= 0 && clientSeed <= clientEvents.length &&
        estimateRef.current.next === clientEvents.length;
      var clientRootModels = modelsFromClientMap(sessionModelRef.current !== null ? sessionModelRef.current.byModel : null);
      var clientUnpricedSteps = 0;
      var clientRootUsage = zeroUsage();
      if (clientRootReady) {
        var aggregateState = estimateRef.current;
        if (aggregateState.sessAggregateRevision !== aggregateState.sessSampleRevision) {
          var aggregateUsage = zeroUsage();
          var aggregateUnpriced = 0;
          aggregateState.sessSamples.forEach(function (sample) {
            if (sample && sample.buckets) addUsage(aggregateUsage, sample.buckets);
            if (sample && modelKeyOf(sample.model) === "unknown") aggregateUnpriced += 1;
          });
          aggregateState.sessUsageCache = aggregateUsage;
          aggregateState.sessUnpricedCache = aggregateUnpriced;
          aggregateState.sessAggregateRevision = aggregateState.sessSampleRevision;
        }
        clientRootUsage = safeUsage(aggregateState.sessUsageCache);
        clientUnpricedSteps = finiteNonNegative(aggregateState.sessUnpricedCache);
      }
      var snapRoot = serverCost !== null && serverCost.root !== null ? serverCost.root : null;
      var descUsage = serverCost !== null && serverCost.descendants !== null && serverCost.descendants.usage
        ? serverCost.descendants.usage
        : null;
      var descModels = serverCost !== null && serverCost.descendants !== null && Array.isArray(serverCost.descendants.models)
        ? serverCost.descendants.models
        : null;
      var costRevisionReady = serverCost !== null && typeof serverCost.rootEventRevision === "number" && Number.isFinite(serverCost.rootEventRevision) &&
        serverCost.rootEventRevision >= 0 && Number.isInteger(serverCost.rootEventRevision) && snapRoot !== null &&
        typeof snapRoot.costCny === "number" && Number.isFinite(snapRoot.costCny) && snapRoot.usage && Array.isArray(snapRoot.models);
      var liveRevisionReady = liveInfo !== null && typeof liveInfo.eventRevision === "number" && Number.isFinite(liveInfo.eventRevision) &&
        liveInfo.eventRevision >= 0 && Number.isInteger(liveInfo.eventRevision) &&
        typeof liveInfo.rootCostCny === "number" && Number.isFinite(liveInfo.rootCostCny) && liveInfo.rootUsage && Array.isArray(liveInfo.models);
      var descendantShapeReady = serverCost === null || serverCost.descendantCount === 0 ||
        (descUsage !== null && descModels !== null);
      var revisionMode = (costRevisionReady || liveRevisionReady) && descendantShapeReady;
      var rootChoice = null;
      var modelBreakdown = null;
      var liveCostNow = cnyCost(usage, Date.now(), currentModel, effectiveTables, effectiveLedger);
      var sessionCost;
      if (revisionMode) {
        function chooseRoot(candidate) {
          if (candidate === null) return;
          if (rootChoice === null || candidate.revision > rootChoice.revision ||
              (candidate.revision === rootChoice.revision && candidate.priority > rootChoice.priority)) rootChoice = candidate;
        }
        if (costRevisionReady) {
          chooseRoot({ cost: snapRoot.costCny, usage: snapRoot.usage, models: snapRoot.models,
            revision: serverCost.rootEventRevision, priority: 2, version: serverCost.pricingVersion,
            unpricedSteps: finiteNonNegative(snapRoot.unpricedSteps), invalidSteps: finiteNonNegative(snapRoot.invalidSteps) });
        }
        if (liveRevisionReady) {
          var liveVersion = liveInfo.pricing && typeof liveInfo.pricing.version === "number" ? liveInfo.pricing.version : null;
          // Do not combine a newly-priced root with descendants still folded
          // under the previous pricing snapshot.
          var tailCompatible = serverCost === null || serverCost.descendantCount === 0 ||
            serverCost.pricingVersion === null || liveVersion === null || serverCost.pricingVersion === liveVersion;
          if (tailCompatible) chooseRoot({ cost: liveInfo.rootCostCny, usage: liveInfo.rootUsage, models: liveInfo.models,
            revision: liveInfo.eventRevision, priority: 3, version: liveVersion,
            unpricedSteps: finiteNonNegative(liveInfo.unpricedSteps), invalidSteps: finiteNonNegative(liveInfo.invalidSteps) });
        }
        var clientTailCompatible = serverCost === null || serverCost.descendantCount === 0 ||
          serverCost.pricingVersion === null || serverCost.pricingVersion === effectivePricingVersion;
        if (clientRootReady && clientTailCompatible && estimateRef.current.pricedVersion === effectivePricingVersion) {
          chooseRoot({ cost: clientSessCost, usage: clientRootUsage, models: clientRootModels,
            revision: clientEvents.length, priority: 1, version: effectivePricingVersion,
            unpricedSteps: clientUnpricedSteps,
            invalidSteps: liveInfo !== null ? finiteNonNegative(liveInfo.invalidSteps) : (snapRoot !== null ? finiteNonNegative(snapRoot.invalidSteps) : 0) });
        }
        if (rootChoice !== null) {
          effective = safeUsage(rootChoice.usage);
          if (descUsage !== null) addUsage(effective, descUsage);
          modelBreakdown = mergeModelLists(rootChoice.models, descModels);
          sessionCost = rootChoice.cost + snapDescCost;
          unpricedSteps = rootChoice.unpricedSteps + (serverCost !== null && serverCost.descendants !== null ? finiteNonNegative(serverCost.descendants.unpricedSteps) : 0);
          invalidSteps = rootChoice.invalidSteps + (serverCost !== null && serverCost.descendants !== null ? finiteNonNegative(serverCost.descendants.invalidSteps) : 0);
        } else {
          // A partial/new-shape response cannot be safely spliced. Fall back as
          // one legacy snapshot instead of mixing incompatible pieces.
          revisionMode = false;
        }
      }
      if (!revisionMode) {
        effective = serverCost !== null ? safeUsage(serverCost.merged) : merged;
        var legacyModels = serverCost !== null && Array.isArray(serverCost.models) ? serverCost.models : null;
        modelBreakdown = legacyModels !== null ? legacyModels : clientRootModels;
        var legacyLiveRoot = liveInfo !== null && typeof liveInfo.rootCostCny === "number" && Number.isFinite(liveInfo.rootCostCny) ? liveInfo.rootCostCny : null;
        var legacySnapRoot = snapRoot !== null && typeof snapRoot.costCny === "number" && Number.isFinite(snapRoot.costCny) ? snapRoot.costCny : null;
        var legacyRoot = legacyLiveRoot !== null ? legacyLiveRoot : legacySnapRoot;
        if (legacyRoot !== null && legacyRoot >= clientSessCost) sessionCost = legacyRoot + snapDescCost;
        else if (clientRootReady && clientSessCost > 0) sessionCost = clientSessCost + snapDescCost;
        else if (legacyRoot !== null) sessionCost = legacyRoot + snapDescCost;
        else if (serverCost !== null && typeof serverCost.costCny === "number" && Number.isFinite(serverCost.costCny)) sessionCost = serverCost.costCny;
        else sessionCost = liveCostNow;
      }

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
            turnCostRef.current += cnyCost(uDelta, Date.now(), currentModel, effectiveTables, effectiveLedger);
          }
        }
      }
      var turnCny = clientEvents !== null ? exactTurnCny : turnCostRef.current;

      var liveLlmMs = 0;
      var liveToolMs = 0;
      if (sessionRunning && liveInfo !== null) {
        if (typeof liveInfo.openStepStart === "number" && Number.isFinite(liveInfo.openStepStart)) {
          liveLlmMs = Math.max(0, Date.now() - liveInfo.openStepStart);
        }
        var toolStart = liveInfo.pendingMin !== null && liveInfo.pendingMin !== void 0
          ? liveInfo.pendingMin
          : liveInfo.toolPhaseStart;
        if (typeof toolStart === "number" && Number.isFinite(toolStart)) {
          liveToolMs = Math.max(0, Date.now() - toolStart);
        }
      }
      var displayStats = stats;
      var estRefStats = estimateRef.current;
      var sessReady = clientRootReady && estRefStats !== null && estRefStats.sessStat !== void 0 && estRefStats.sessStat !== null;
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
      var statRevisionMode = liveInfo !== null && liveInfo.completed !== null && liveInfo.completed !== void 0 &&
        typeof liveInfo.eventRevision === "number" && Number.isFinite(liveInfo.eventRevision) &&
        liveInfo.eventRevision >= 0 && Number.isInteger(liveInfo.eventRevision);
      var useClientStats = statRevisionMode && ss !== null && clientEvents.length > liveInfo.eventRevision;
      // /live can trail the locally appended message by one poll. Once the
      // client fold has a newer CLOSED step, adding the host's still-open edge
      // would count the same LLM interval twice until the next response. In
      // revision mode the event count is authoritative; old hosts fall back to
      // the same monotonic completed-stat evidence used by the legacy merge.
      var clientClosedNewerStep = ss !== null && ss.openStep === null &&
        estRefStats.turnSpeed !== null && estRefStats.turnSpeed.openStep === null &&
        (useClientStats || (!statRevisionMode && (
          finiteNonNegative(ss.llmMs) > finiteNonNegative(hostLlmMs) ||
          finiteNonNegative(ss.steps) > finiteNonNegative(hostSteps) ||
          finiteNonNegative(ss.turns) > finiteNonNegative(hostTurns) ||
          finiteNonNegative(ss.decodeMs) > finiteNonNegative(hostDecodeMs)
        )));
      if (clientClosedNewerStep) liveLlmMs = 0;
      var sessionBaseLlmMs;
      if (statRevisionMode) {
        var chosenStats = useClientStats ? ss : {
          turns: hostTurns, steps: hostSteps, llmMs: hostLlmMs,
          ttftMs: hostTtftMs, ttftSteps: hostTtftSteps,
          decodeMs: hostDecodeMs, decodeTokens: hostDecodeTokens
        };
        sessionBaseLlmMs = finiteNonNegative(chosenStats.llmMs);
        displayStats = {
          turns: finiteNonNegative(chosenStats.turns),
          steps: finiteNonNegative(chosenStats.steps),
          llmMs: sessionBaseLlmMs + finiteNonNegative(liveLlmMs),
          toolMs: finiteNonNegative(hostToolMs) + finiteNonNegative(liveToolMs),
          ttftMs: finiteNonNegative(chosenStats.ttftMs),
          ttftSteps: finiteNonNegative(chosenStats.ttftSteps),
          decodeMs: finiteNonNegative(chosenStats.decodeMs),
          decodeTokens: finiteNonNegative(chosenStats.decodeTokens)
        };
      } else {
        sessionBaseLlmMs = ss !== null ? Math.max(finiteNonNegative(hostLlmMs), finiteNonNegative(ss.llmMs)) : finiteNonNegative(hostLlmMs);
        displayStats = {
          turns: ss !== null ? Math.max(finiteNonNegative(hostTurns), finiteNonNegative(ss.turns)) : finiteNonNegative(hostTurns),
          steps: ss !== null ? Math.max(finiteNonNegative(hostSteps), finiteNonNegative(ss.steps)) : finiteNonNegative(hostSteps),
          llmMs: sessionBaseLlmMs + finiteNonNegative(liveLlmMs),
          toolMs: finiteNonNegative(hostToolMs) + finiteNonNegative(liveToolMs),
          ttftMs: ss !== null ? Math.max(finiteNonNegative(hostTtftMs), finiteNonNegative(ss.ttftMs)) : finiteNonNegative(hostTtftMs),
          ttftSteps: ss !== null ? Math.max(finiteNonNegative(hostTtftSteps), finiteNonNegative(ss.ttftSteps)) : finiteNonNegative(hostTtftSteps),
          decodeMs: ss !== null ? Math.max(finiteNonNegative(hostDecodeMs), finiteNonNegative(ss.decodeMs)) : finiteNonNegative(hostDecodeMs),
          decodeTokens: ss !== null ? Math.max(finiteNonNegative(hostDecodeTokens), finiteNonNegative(ss.decodeTokens)) : finiteNonNegative(hostDecodeTokens)
        };
      }

      var subCount = 0;
      // Once the authoritative tree snapshot exists it may correct the local
      // fallback in either direction (including down to zero). Avoid the
      // O(all sessions) local scan when it would be overwritten immediately.
      // A partial/stale snapshot is not complete enough to hide a descendant
      // which the live session index already knows about, so in that rare path
      // retain the larger of the two known counts.
      var serverCountReady = serverCost !== null && typeof serverCost.descendantCount === "number" &&
        Number.isFinite(serverCost.descendantCount) && serverCost.descendantCount >= 0;
      if (serverCountReady && serverCost.partial !== true && serverCost.stale !== true) {
        subCount = serverCost.descendantCount;
      } else {
        try {
          var byIdMap = list !== null && typeof list === "object" && list.byId ? list.byId : {};
          subCount = collectDescendants(byIdMap, sessionId === null ? "" : sessionId).length;
        } catch (e) { subCount = 0; }
        if (serverCountReady) subCount = Math.max(subCount, serverCost.descendantCount);
      }

      var estOutputTokens = 0;
      var estTokensRaw = 0;
      var estStateRender = estimateRef.current;
      // the corrected estimated tokens feed Tok + 速率 even while the model
      // is still UNKNOWN (unpriced): the estimate exists, only its PRICE is 0.
      // Gated on the same live conditions the estimate is computed under, so
      // a stale value can never survive a termination.
      var estLiveGate = sessionRunning && liveInfo !== null && liveInfo.openStepStart !== null && liveInfo.openStepStart !== void 0;
      if (estStateRender !== null && estLiveGate && typeof estStateRender.estTokensOut === "number" && estStateRender.estTokensOut > 0) {
        estTokensRaw = estStateRender.estTokensOut;
        estOutputTokens = Math.round(estTokensRaw);
      }
      // Input/cache carry is provisional too. Use the exact same live-edge
      // gate as output so an abnormal stop without turn/end cannot leave a
      // stale estimate in Tok/model rows after the amount has returned to 0.
      var estInputTokens = estStateRender !== null && estLiveGate ? Math.round(estStateRender.inputTokShown) : 0;
      var estCacheTokens = estStateRender !== null && estLiveGate ? Math.round(estStateRender.cacheTokShown) : 0;
      var estModelNow = estStateRender !== null && typeof estStateRender.activeRouteModel === "string" && estStateRender.activeRouteModel !== ""
        ? estStateRender.activeRouteModel
        : (estStateRender !== null ? estStateRender.lastModel : void 0);
      // Samples and host rows use canonical model ids. The provisional row
      // must use the same key, otherwise dated route ids briefly create a
      // duplicate row which disappears at settle. UNKNOWN is deliberately
      // retained: its price is zero, but its estimated tokens still belong in
      // 会话 Tok and in the existing "未计价" model row.
      var estModelKey = modelKeyOf(estModelNow);
      if (estimateCny > 0 || estTokensRaw > 0 || estInputTokens > 0 || estCacheTokens > 0) {
        var streamList = Array.isArray(modelBreakdown) ? modelBreakdown.slice() : [];
        var foundModel = false;
        for (var smi = 0; smi < streamList.length; smi++) {
          if (streamList[smi] !== null && streamList[smi] !== void 0 && modelKeyOf(streamList[smi].model) === estModelKey) {
            streamList[smi] = {
              model: estModelKey,
              costCny: (Number(streamList[smi].costCny) || 0) + estimateCny,
              usage: streamList[smi].usage
            };
            foundModel = true;
            break;
          }
        }
        if (!foundModel) streamList.push({ model: estModelKey, costCny: estimateCny, usage: zeroUsage() });
        modelBreakdown = streamList;
      }
      var groups = buildGroups(displayStats, effective, turnCny, sessionCost, {
        balance: balance,
        subCount: subCount,
        modelBreakdown: modelBreakdown,
        unpricedSteps: unpricedSteps,
        invalidSteps: invalidSteps,
        partial: snapshotPartial,
        partialCount: failedSessionCount,
        stale: snapshotStale,
        budgetLines: budgetLines,
        spendWarn: spendWarn,
        estimateCny: estimateCny,
        sessionRunning: sessionRunning,
        peakGroup: peakInfo,
        balanceWarnCny: balanceWarnCny,
        balanceCriticalCny: balanceCriticalCny,
        pricingSourceRow: pricingSourceRow,
        etaText: etaText,
        turnUsage: estimateRef.current !== null ? estimateRef.current.turnUsage : null,
        turnSpeed: estimateRef.current !== null ? estimateRef.current.turnSpeed : null,
        turnSteps: estimateRef.current !== null ? estimateRef.current.turnSteps : 0,
        turnOpen: estimateRef.current !== null && estimateRef.current.turnSpeed !== null && estimateRef.current.turnSpeed.openStep !== null,
        turnActive: estimateRef.current !== null ? estimateRef.current.turnActive === true : false,
        hadTurn: estimateRef.current !== null ? estimateRef.current.hadTurn === true : false,
        turnToolMs: estimateRef.current !== null ? (estimateRef.current.turnToolMs || 0) : 0,
        toolPhaseStart: liveInfo !== null ? liveInfo.toolPhaseStart : null,
        sessLlmMs: sessionBaseLlmMs,
        estTokensRaw: estTokensRaw,
        estOutputTokens: estOutputTokens,
        liveSegs: estStateRender !== null ? (estStateRender.liveSegs || 0) : 0,
        segFactor: estStateRender !== null && typeof estStateRender.segFactor === "number" ? estStateRender.segFactor : SEG_FACTOR_INIT,
        firstTokWall: estStateRender !== null ? estStateRender.firstTokWall : null,
        lastTokWall: estStateRender !== null ? estStateRender.lastTokWall : null,
        lastTokEvt: estStateRender !== null ? estStateRender.lastTokEvt : null,
        estInputTokens: estInputTokens,
        estCacheTokens: estCacheTokens,
        estModel: estModelKey
      });

      // ── separator/layout measurement ──────────────────────────────────────
      // popoverOnly groups (模型) never render on the strip: all strip math
      // (widths, separators, ellipsis, rows) runs on the filtered list.
      var stripGroups = [];
      for (var sgi = 0; sgi < groups.length; sgi++) {
        if (groups[sgi].popoverOnly !== true) stripGroups.push(groups[sgi]);
      }
      function measureSeps() {
        try {
          var line = lineRef.current;
          if (line == null || stripGroups.length < 2) {
            if (trailingCache.current !== "") {
              trailingCache.current = "";
              setSepHidden([]);
            }
            return;
          }
          var available = Number(line.clientWidth || line.offsetWidth) || 0;
          var font = "";
          if (typeof getComputedStyle === "function") {
            var lineStyle = getComputedStyle(line);
            available -= (parseFloat(lineStyle.paddingLeft) || 0) + (parseFloat(lineStyle.paddingRight) || 0);
            font = lineStyle.font || "";
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

          // Keep one measurement per stable group id. Time/cost text changes
          // continuously, so keying the object by the whole string leaked one
          // entry per tick during a long session. If a hidden group's text
          // changes, use a 1px probe width for one layout pass: this gives a
          // newly-shorter value a chance to render and be measured, instead of
          // remaining hidden forever behind its older, wider cached value.
          function natWidth(idx) {
            var group = stripGroups[idx];
            var signature = (idx === 0 ? "first|" : "rest|") + group.text + "|" + font;
            var cached = widthsRef.current[group.id];
            if (cached !== void 0 && cached !== null && cached.signature === signature && cached.width > 0) return cached.width;
            var w = widthOf(itemRefs.current[idx]);
            if (w > 0) {
              if (idx > 0) w += sepWidth;
              widthsRef.current[group.id] = { signature: signature, width: w };
              return w;
            }
            return 1;
          }
          var firstUnit = natWidth(0);
          var ELLIPSE_W = 14;
          var omitFrom = stripGroups.length;
          var rw2 = firstUnit;
          var onRow2 = false;
          for (var k2 = 1; k2 < stripGroups.length; k2++) {
            var iw2 = natWidth(k2);
            if (iw2 <= 0) { omitFrom = k2; break; }
            if (rw2 + iw2 <= available + 0.5) {
              rw2 += iw2;
            } else if (!onRow2) {
              onRow2 = true;
              rw2 = iw2 + ELLIPSE_W;
            } else {
              omitFrom = k2;
              break;
            }
          }
          var ell = omitFrom < stripGroups.length ? { omitFrom: omitFrom } : null;
          var prevEll = ellideRef.current;
          if ((ell === null) !== (prevEll === null) ||
              (ell !== null && ell.omitFrom !== prevEll.omitFrom)) {
            ellideRef.current = ell;
            setEllide(ell);
          }
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
          for (var s = 0; s < stripGroups.length - 1; s++) {
            next.push(s + 1 === rowBreak);
          }
          var sig = next.join(",");
          if (sig !== trailingCache.current) {
            trailingCache.current = sig;
            setSepHidden(next);
          }
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
      var groupSignature = stripGroups.map(function (group) { return group.id + "\u0002" + group.text; }).join("\u0001");
      var useLayoutEffect = typeof react.useLayoutEffect === "function" ? react.useLayoutEffect : react.useEffect;
      var layoutSignature = layout === null ? "initial" : layout.rowBreak + "|" + layout.omitFrom;
      useLayoutEffect(function () {
        measureRef.current();
      }, [groupSignature, layoutSignature]);
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

      if (stripGroups.length === 0) {
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

      itemRefs.current.length = stripGroups.length;
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
      function unitSpan(gi, hideSep, rowKey) {
        var group = stripGroups[gi];
        var className = "dsh-better-stats-item" +
          (group.refreshable === true ? " dsh-better-stats-refresh" : "") +
          (group.refreshable === true && refreshPulse === true ? " dsh-better-stats-refreshing" : "");
        var refCb = (function (idx) {
          return function (el) { itemRefs.current[idx] = el; };
        })(gi);
        var content = group.refreshable === true
          ? react.createElement(
              "button",
              {
                key: "grp",
                type: "button",
                ref: refCb,
                className: className,
                style: group.style,
                "aria-label": L.refreshHint,
                title: L.refreshHint,
                onClick: function (e) {
                  e.stopPropagation();
                  setRefreshPulse(true);
                  if (workspaceMetaRef.current && workspaceMetaRef.current.refreshTimer !== void 0) {
                    clearTimeout(workspaceMetaRef.current.refreshTimer);
                  }
                  workspaceMetaRef.current.refreshTimer = setTimeout(function () {
                    workspaceMetaRef.current.refreshTimer = void 0;
                    setRefreshPulse(false);
                  }, 800);
                  if (balanceForceRefresh.current) balanceForceRefresh.current(true);
                }
              },
              group.text
            )
          : react.createElement(
              "span",
              {
                key: "grp",
                ref: refCb,
                className: className,
                style: group.style
              },
              group.text
            );
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
          content
        );
      }
      var rowBreak = layout !== null ? layout.rowBreak : -1;
      var omit = layout !== null ? layout.omitFrom : stripGroups.length;
      if (rowBreak >= omit) rowBreak = -1;
      var row1Units = [];
      var row1End = rowBreak >= 0 ? rowBreak : omit;
      for (var g1 = 0; g1 < row1End && g1 < stripGroups.length; g1++) {
        row1Units.push(unitSpan(g1, false, "r1"));
      }
      if (row1Units.length > 0) {
        items.push(react.createElement("div", { key: "row1", className: "dsh-better-stats-row" }, row1Units));
      }
      if (rowBreak >= 0) {
        var row2Units = [];
        for (var g2 = rowBreak; g2 < omit && g2 < stripGroups.length; g2++) {
          row2Units.push(unitSpan(g2, g2 === rowBreak, "r2"));
        }
        if (omit < stripGroups.length) {
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

      function onLineKeyDown(e) {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openPopover();
        } else if (e.key === "Escape") {
          closePopover();
        }
      }

      return react.createElement(
        "div",
        {
          ref: lineRef,
          className: "dsh-better-stats-line",
          "data-bs": "v20",
          tabIndex: "0",
          role: "group",
          "aria-label": L.lineAria,
          onMouseEnter: function () {
            cancelHide();
            measureAnchor();
            setHovered(true);
          },
          onMouseLeave: function () { scheduleHide(); },
          onFocus: function () { openPopover(); },
          onClick: function () { openPopover(); },
          onKeyDown: onLineKeyDown
        },
        items,
        hovered && anchor !== null
          ? react.createElement(
              "div",
              {
                className: "dsh-better-stats-pop",
                role: "dialog",
                "aria-label": L.popAria,
                tabIndex: "-1",
                style: {
                  position: "fixed",
                  left: anchor.left + "px",
                  top: anchor.top + "px",
                  transform: "translate(-50%, -100%)",
                  maxHeight: Math.max(120, anchor.top - 12) + "px"
                },
                onMouseEnter: function () { cancelHide(); },
                onMouseLeave: function () { scheduleHide(); },
                onKeyDown: function (e) {
                  if (e.key === "Escape") {
                    e.stopPropagation();
                    closePopover();
                  }
                }
              },
              (function () {
              function cellSpan(idx, nonEmpty) {
                if (nonEmpty.length === 1 && nonEmpty[0] === idx) {
                  return "dsh-better-stats-pop-c dsh-better-stats-pop-cspan" + (3 - idx);
                }
                return "dsh-better-stats-pop-c dsh-better-stats-pop-c" + (idx + 2);
              }
              var gridEls = [];
              var gridRowNum = 1;
              var firstGroup = true;
              var POP_ORDER = ["api", "balance", "peak", "turns", "time", "speed", "cache", "spend", "tok", "models"];
              var popGroups = groups.slice().sort(function (a, b) {
                var ia = POP_ORDER.indexOf(a.id);
                var ib = POP_ORDER.indexOf(b.id);
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
        console.log("[dsh-better-stats] apply: registering conversation.composer.dock entry");
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
