// dsh-better-stats — client half (v5): ONE complete stats strip merging the
// shipped row's figures with the balance/cost ledger, hiding the shipped row
// via CSS:
//
//   DeepSeek 官方 | 余额 ¥48.8600 | 本轮 ¥0.0081 · 会话 ¥0.2362 |
//   3 轮 · 12 步 | LLM 45.2s · 工具 12.3s | 首token 1.4s · 25.4tok/s |
//   输入 12.2K · 缓存 10.6K · 87.00% · 输出 517
//
// v5 changes:
//  - cost (this turn / total) is tree-merged: the viewed session PLUS all
//    descendant subagent sessions' tokenUsage;
//  - "this turn" tracks the merged total via numeric diff in USD (rate-
//    independent), kept in refs so unrelated re-renders (hover, balance
//    refresh) never reset it to 0;
//  - durations labelled "LLM … · 工具 …";
//  - provider label normalized ("DeepSeek 官方"), popover labels API/余额/
//    花费/轮次/耗时/速率/Token with an aligned label column;
//  - balance cached in localStorage (instant paint, background refresh,
//    stale value kept on failure); host also serves stale on upstream errors.
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
      ".dsh-better-stats-line{position:relative;display:flex;flex-wrap:wrap;justify-content:center;align-items:flex-start;max-width:var(--dsh-chat-content-width);box-sizing:border-box;width:100%;padding:4px calc(var(--dsh-composer-side-clearance) + 16px) 4px;color:var(--dsw-alias-label-tertiary);margin:0 auto;font-size:12px;line-height:20px;row-gap:2px;max-height:44px;overflow:hidden}",
      ".dsh-better-stats-item{white-space:nowrap}",
      ".dsh-better-stats-sep{color:var(--dsw-alias-separator-primary);margin:0 10px;white-space:nowrap}",
      ".dsh-better-stats-pop{box-sizing:border-box;min-width:220px;max-width:calc(100vw - 32px);border:1px solid var(--dsw-alias-border-inverted);background:var(--dsw-specific-menu);box-shadow:var(--dsw-shadow-lv3);color:var(--dsw-alias-label-secondary);border-radius:12px;padding:10px 14px;font-size:12px;line-height:20px;text-align:left;z-index:100}",
      ".dsh-better-stats-pop-row{white-space:nowrap}",
      ".dsh-better-stats-pop-label{display:inline-block;min-width:56px;color:var(--dsw-alias-label-tertiary);margin-right:12px}",
      ".dsh-better-stats-pop b{color:var(--dsw-alias-label-primary);font-weight:600}"
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
    // same currency as the balance endpoint):
    //   https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
    //   deepseek-v4-flash: 输入缓存命中 ¥0.05/¥0.10 · 输入未命中 ¥1.5/¥3.0 ·
    //                      输出 ¥4.5/¥9.0
    //   deepseek-v4-pro:   输入缓存命中 ¥0.15/¥0.30 · 输入未命中 ¥4.5/¥9.0 ·
    //                      输出 ¥13.5/¥27.0  (exactly 3× flash)
    //   高峰(北京 9:00-12:00 / 14:00-18:00) 为两倍, 其余为空闲.
    // The host cost route prices each step at ITS OWN event time AND model;
    // this client-side table is the fallback while the route is unavailable
    // (priced at the current time's tier and the session's latest model).
    var PRICE_TABLES = {
      "deepseek-v4-flash": { miss: 1.5, read: 0.05, out: 4.5, missPeak: 3.0, readPeak: 0.1, outPeak: 9.0 },
      "deepseek-v4-pro": { miss: 4.5, read: 0.15, out: 13.5, missPeak: 9.0, readPeak: 0.3, outPeak: 27.0 }
    };
    var DEFAULT_MODEL = "deepseek-v4-flash";

    // Fixed decimal precision shared by cost and balance.
    var PRECISION = 4;
    var CURRENCY_SYMBOLS = { CNY: "¥", USD: "$", EUR: "€", GBP: "£", JPY: "¥" };
    var PROVIDER_LABELS = { deepseek: "DeepSeek 官方", "deepseek-official": "DeepSeek 官方" };

    var USAGE_KEYS = ["uncachedInputTokens", "cacheReadTokens", "cacheWriteTokens", "outputTokens"];
    var ZERO_USAGE = { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
    var BALANCE_CACHE_KEY = "dsh-better-stats:balance";
    var diagnosticLogs = 0;

    function beijingPeak(epochMs) {
      var d = new Date((epochMs || Date.now()) + 8 * 3600 * 1000);
      var h = d.getUTCHours();
      return (h >= 9 && h < 12) || (h >= 14 && h < 18);
    }

    function modelKeyOf(model) {
      if (typeof model === "string") {
        if (model.indexOf("v4-pro") !== -1) return "deepseek-v4-pro";
        if (model.indexOf("v4-flash") !== -1) return "deepseek-v4-flash";
      }
      return DEFAULT_MODEL;
    }

    // CNY cost of a usage bucket at a given moment's peak/off-peak tier and
    // the producing model's price table.
    function cnyCost(totals, time, model) {
      if (!totals) return 0;
      var peak = beijingPeak(time);
      var table = PRICE_TABLES[modelKeyOf(model)];
      var miss = peak ? table.missPeak : table.miss;
      var read = peak ? table.readPeak : table.read;
      var out = peak ? table.outPeak : table.out;
      return (
        ((totals.uncachedInputTokens || 0) + (totals.cacheWriteTokens || 0)) * miss +
        (totals.cacheReadTokens || 0) * read +
        (totals.outputTokens || 0) * out
      ) / 1e6;
    }

    function fmtMoney(symbol, value) {
      var n = Number(value) || 0;
      return symbol + n.toFixed(PRECISION);
    }

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

    // ── group builders ──────────────────────────────────────────────────────
    function buildGroups(stats, usage, turnCny, totalCny, balance, subCount, modelBreakdown) {
      var groups = [];
      if (balance !== null) {
        groups.push({ label: "API", text: balance.label });
        if (balance.amount !== null) {
          var balText = fmtMoney(currencySymbol(balance.currency), balance.amount);
          groups.push({ label: "余额", text: "余额 " + balText, value: balText });
        } else {
          groups.push({ label: "余额", text: balance.text });
        }
      }
      if (usage !== void 0) {
        var spendText = "本轮 " + fmtMoney("¥", turnCny) + " · 会话 " + fmtMoney("¥", totalCny);
        var spendPop = spendText;
        var popNotes = [];
        if (modelBreakdown !== null && modelBreakdown.length > 1) {
          var modelParts = [];
          for (var mb = 0; mb < modelBreakdown.length; mb++) {
            var entry = modelBreakdown[mb];
            var short = String(entry.model).replace("deepseek-", "");
            modelParts.push(short + " " + fmtMoney("¥", entry.costCny));
          }
          popNotes.push(modelParts.join(" · "));
        }
        if (subCount > 0) popNotes.push("含 " + subCount + " 个子会话");
        if (popNotes.length > 0) spendPop += "（" + popNotes.join("，") + "）";
        groups.push({ label: "花费", text: spendText, popover: spendPop });
      }
      if (stats && stats.steps > 0) {
        groups.push({ label: "轮次", text: stats.turns + " 轮 · " + stats.steps + " 步" });
        var durations = [];
        if (stats.llmMs > 0) durations.push("LLM " + formatDuration(stats.llmMs));
        if (stats.toolMs > 0) durations.push("工具 " + formatDuration(stats.toolMs));
        if (durations.length > 0) groups.push({ label: "耗时", text: durations.join(" · ") });
        var speeds = [];
        if (stats.ttftSteps > 0) speeds.push("首token平均 " + formatTtft(stats.ttftMs / stats.ttftSteps));
        if (stats.decodeMs > 0) speeds.push(formatTps(stats.decodeTokens / (stats.decodeMs / 1000)));
        if (speeds.length > 0) groups.push({ label: "速率", text: speeds.join(" · ") });
      }
      if (usage !== void 0 && (billedInputTokens(usage) > 0 || usage.outputTokens > 0)) {
        var hit = cacheHitPercent(usage);
        if (hit !== null) {
          // 缓存命中组（倒数第二）
          groups.push({
            label: "缓存",
            text: "缓存 " + fmtTokens(usage.cacheReadTokens || 0) + " · 命中 " + hit + "%"
          });
        }
        // 输入输出组（倒数第一）— label "Tok" 与左侧双字标签对称
        groups.push({
          label: "Tok",
          text: "输入 " + fmtTokens(billedInputTokens(usage)) + " · 输出 " + fmtTokens(usage.outputTokens || 0)
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
      var sepRefs = react.useRef([]);
      // Latest-measurement ref: ResizeObserver and effects always call through
      // this so they never run a stale closure against a changed groups list.
      var measureRef = react.useRef(null);

      react.useEffect(function () {
        var alive = true;
        function load() {
          fetch("/plugins/better-stats/balance", { cache: "no-store" })
            .then(function (res) {
              if (!res.ok) throw new Error("balance http " + res.status);
              return res.json();
            })
            .then(function (body) {
              if (!alive) return;
              if (body && body.configured === true && body.status === "ok" && body.amount !== void 0) {
                var label = body.displayName || PROVIDER_LABELS[body.provider] || (typeof body.provider === "string" ? body.provider : "DeepSeek");
                var next = {
                  text: label + " " + fmtMoney(currencySymbol(body.currency), body.amount),
                  label: label,
                  amount: body.amount,
                  currency: body.currency || "CNY"
                };
                setBalance(next);
                saveBalanceCache(next);
              } else if (body && body.configured === false) {
                setBalance({ text: "余额 --", label: "DeepSeek", amount: null, currency: null });
              } else {
                // status error: keep the stale value when we have one.
                setBalance(function (prev) {
                  return prev !== null ? prev : { text: "余额查询失败", label: "DeepSeek", amount: null, currency: null };
                });
              }
            })
            .catch(function () {
              if (!alive) return;
              setBalance(function (prev) {
                return prev !== null ? prev : { text: "余额查询失败", label: "DeepSeek", amount: null, currency: null };
              });
            });
        }
        load();
        var timer = setInterval(load, 15000);
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
              setLiveInfo({
                completed: body.completed || null,
                openStepStart: body.openStepStart,
                pendingMin: body.pendingMin,
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

      // session running bit (from the list) — gates the live parts
      var sessionRunning = false;
      try {
        var listById = list !== null && typeof list === "object" ? list.byId : null;
        sessionRunning = !!(listById && sessionId !== null && listById[sessionId] && listById[sessionId].running === true);
      } catch (e) { sessionRunning = false; }

      // Current model = the latest assistant message's producing model (the
      // fallback pricing tier when the host cost route is unavailable).
      var currentModel = DEFAULT_MODEL;
      try {
        var liveSessBinding = sessionsService !== null && sessionId !== null
          ? sessionsService.binding(sessionId)
          : void 0;
        var clientEvents = liveSessBinding !== void 0 && liveSessBinding.session !== void 0
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

      // "本轮" = priced ONLY on NEW usage: the projection's cumulative token
      // buckets are diffed per render and the DELTA is priced at the current
      // model/tier. Old usage is never re-priced, so model switches and
      // peak/off-peak flips cannot inject phantom amounts into 本轮; every
      // LLM call counts the moment its tokens are reported.
      // "会话" = the host's exact tree-wide cost (per-step event time +
      // model); a zero/absent host answer falls back to the live estimate.
      var liveCostNow = cnyCost(usage, Date.now(), currentModel);
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
            turnCostRef.current += cnyCost(uDelta, Date.now(), currentModel);
          }
        }
      }
      var turnCny = turnCostRef.current;

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
      var groups = buildGroups(displayStats, effective, turnCny, sessionCost, balance, subCount, modelBreakdown);

      // Separators are independent flex items BEFORE each group (the layout
      // the user confirmed working). A separator only earns its place BETWEEN
      // two groups ON THE SAME LINE: if a line break separates the two
      // neighbouring groups — the "|" would be stranded at the END of the
      // previous line ("组 |" then wrap) or orphaned at the START of the next
      // line ("| 组") — the separator is DROPPED (rendered as a zero-size
      // empty span: no phantom width, but still measurable so a later re-flow
      // can restore it).
      //
      // MEASUREMENT reads the two GROUP items' offsetTop (never the
      // separator's own geometry): a hidden separator is a zero-size empty
      // span whose offsetTop is unreliable, and comparing the groups keeps
      // the rule exact no matter how many separators are currently dropped.
      // Hidden seps shrink content width, so the hidden set only grows while
      // the window narrows and shrinks when it widens — the measurement
      // converges either way.
      // Default: all visible; display always wins.
      //
      // CRASH-HARDENED: every ref access is null/undefined safe and the whole
      // body is a no-op on any surprise, so measurement can never take the
      // slot entry down (a crashed entry gets abdicated by the slot boundary
      // and stops rendering for the page's lifetime).
      function measureSeps() {
        try {
          var next = [];
          for (var k = 1; k < groups.length; k++) {
            var leftItem = itemRefs.current[k - 1];
            var rightItem = itemRefs.current[k];
            next.push(
              !(leftItem != null && rightItem != null &&
                leftItem.offsetTop === rightItem.offsetTop)
            );
          }
          var sig = next.join(",");
          if (sig !== trailingCache.current) {
            trailingCache.current = sig;
            setSepHidden(next);
            if (diagnosticLogs < 3) {
              diagnosticLogs += 1;
              try {
                var pairs = [];
                for (var d = 1; d < groups.length; d++) {
                  var l = itemRefs.current[d - 1];
                  var r = itemRefs.current[d];
                  pairs.push((l ? l.offsetTop : "?") + "|" + (r ? r.offsetTop : "?"));
                }
                if (typeof console !== "undefined" && console.log) {
                  console.log("[dsh-better-stats] sep measure groups=" + groups.length + " pairs=[" + pairs.join(",") + "] hidden=[" + next.join(",") + "]");
                }
              } catch (e) { /* diagnostics are best-effort */ }
            }
          }
        } catch (e) {
          // Measurement is cosmetic — never let it take the line down.
        }
      }
      measureRef.current = measureSeps;
      react.useEffect(function () {
        measureRef.current();
      }, [groups]);
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

      // Never silently disappear: with no data yet (balance not loaded, no
      // usage), render a muted placeholder instead of null, so an empty dock
      // area is always distinguishable from a plugin that failed to mount.
      if (groups.length === 0) {
        return react.createElement(
          "div",
          {
            ref: lineRef,
            className: "dsh-better-stats-line",
            "data-bs": "v18-empty",
            style: { color: "var(--dsw-alias-label-caption)" }
          },
          "better-stats: 等待数据…"
        );
      }

      var items = [];
      for (var gi = 0; gi < groups.length; gi++) {
        if (gi > 0) {
          items.push(
            react.createElement(
              "span",
              {
                key: "sep" + gi,
                // Capture gi per iteration: a closure over the loop's `var gi`
                // would see the FINAL value when React calls the ref at commit
                // time, so every ref would write to the same slot and the
                // measurement would see undefined refs everywhere (the bug
                // that hid ALL separators since v7).
                ref: (function (idx) {
                  return function (el) { sepRefs.current[idx] = el; };
                })(gi),
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
              className: "dsh-better-stats-item"
            },
            groups[gi].text
          )
        );
      }

      return react.createElement(
        "div",
        {
          ref: lineRef,
          className: "dsh-better-stats-line",
          "data-bs": "v18",
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
                return react.createElement(
                  "div",
                  { key: i, className: "dsh-better-stats-pop-row" },
                  react.createElement("span", { className: "dsh-better-stats-pop-label" }, group.label),
                  group.popover !== void 0 ? group.popover : (group.value !== void 0 ? group.value : group.text)
                );
              })
            )
          : null
      );
    }

    var sessionsService = null;

    function apply(ctx) {
      sessionsService = ctx.sessions;
      if (typeof console !== "undefined" && console.log) {
        console.log("[dsh-better-stats] apply: registering conversation.composer.dock entry (v18)");
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
