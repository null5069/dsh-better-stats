# dsh-better-stats

DSH Web 输入框下方的增强统计条：官方人民币计价（峰谷时段、官方价目自动同步）、多模型分账、实时计时、子代理树合并、余额直连、预算预警、流式成本估算。

```
DeepSeek 官方 | 余额 ¥8.67 | 本轮 ¥0.1676 · 会话 ¥29.49 | 20 轮 · 345 步 | LLM 1h 12m · 工具 5m 6s | 首token平均 3.88s · 111.72tok/s | 缓存 103.98M · 命中 98.64% | 输入 1.44M · 输出 336.53K
```

## 功能

- **余额**：host 直连 `api.deepseek.com/user/balance`（DEEPSEEK_API_KEY 走 DSH credentials seam，key 不进入浏览器），15s 缓存刷新；悬浮层显示**赠送/充值拆分**（字段缺失时优雅降级为总额）、**可用天数估算**（按今日消耗与历史日均 EWMA 平滑）与低余额时的**充值链接**；**点击余额组可强刷**（host 端 2s 冷却防刷）
- **计价口径**：输入（未命中/缓存命中）与输出按官方价目；**reasoning token 按输出价计费**（usage.reasoningTokens 单独统计并计入成本，host 与客户端一致）
- **消费**：官方 CNY 价目表（[api-docs.deepseek.com/zh-cn/quick_start/pricing](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)），**host 每 6h 自动抓取解析同步**（失败回退内置价目；浮窗独立「价源」栏显示来源与更新时间，如 `价源 DeepSeek 官方 2026-08-18 14:16`）；**峰谷分时段**（高峰 = 北京 9:00-12:00 / 14:00-18:00，价格两倍），**按每条消息的 model 分账**（deepseek-v4-flash / deepseek-v4-pro 各用各的价目）
- **未知模型显式标记**：检测不到的模型不再静默按 flash 计价——token 照常汇总但**不计价**，会话金额前缀 `≈`，悬浮层注明「含 N 步未定价 · 模型未知」
- **缓存分桶**：未命中输入、缓存命中、缓存写入分开计价（命中价远低于未命中价），并显示缓存命中率
- **本轮**：**按整轮（turn）结算**——精确部分 = 当前轮已落定步骤的事件级折叠（每步按各自事件时刻/模型计价，含 reasoning 输出计价），流式部分 = 当前步的字符级估算（**按当前峰谷时段计价**，密度由已结算步骤**自适应校准**：EMA 追踪真实字符/token 比）；多步 turn 内数字连续增长、不随 thinking 结束重算，usage 落地自动转精确，估算只进显示不入账；**一轮结束后本轮保留最终值，下一轮开始才归零**
- **会话**：host 端按完整轨迹逐步结算（每秒），**子代理整树合并**（含持久化旧会话），**实时跳动**（精确结算 + 当前步流式估算），悬浮层显示分模型明细与子会话数
- **预算预警（可选配置，默认关闭）**：`config: { dailyBudgetCny: 20, monthlyBudgetCny: 100 }`——花费组超 80% 变琥珀色、超支变红加 `⚠`；悬浮层显示 `今日 ¥x · 日预算 ¥20 (85%)` / `本月 ¥y · 月预算 ¥100 (30%)`（今日/本月按北京时区午夜/月初滚动，host 60s 缓存折叠全会话）；不配置即不显示
- **余额告警（两档，默认 ≤¥20 琥珀 / ≤¥5 红色）**：余额组变色加 `⚠`，悬浮层提示，红色档附**充值链接**（跳官方充值页）；`config: { balanceWarnCny, balanceCriticalCny }` 调整阈值，对应档设 `0` 关闭
- **峰谷栏**：独立「峰谷」组常驻显示当前时段与下次切换（如 `高峰中 · 空闲 14:00 开始`），悬浮层显示详情（`高峰中（价格×2） · 空闲 14:00 开始（3h 20m 后）`，每秒随 /live 轮询刷新）
- **实时计时**：LLM/工具耗时在步骤进行中每秒跳动（工具相位以模型工具调用决策消息为起点，host 侧 fold 完整日志）；有数据时显示首 token 平均耗时与解码速率
- **布局**：宽度与输入框（composer）一致、不超过对话框；换行时自动删除被拆到行首/行尾的孤立分隔符；**最多两行**，内容按顺序排列，放不下的部分落入末尾 `⋯`（latex \cdots 样式）；省略决策基于缓存的自然宽度，与渲染状态无关，不会闪烁振荡；Token 组拆为「缓存命中」「输入输出」两组
- **浮窗**：label 列对齐；**运行中本轮括号常驻**（`本轮 ¥0.0364（精确 ¥0.0364 + 估算 ¥0.0000）`，步间估算为 0 也不闪）；**会话为单一数字**（历史+本轮一起跳动，无分账括号）；峰谷行内仅 `高峰中/空闲中`，详情在浮窗
- **i18n**：界面文案跟随浏览器语言（中文 / English）
- **精度规则**：计算值（本轮/会话/今日）4 位小数、外部值（余额）跟随供应商精度、配置值（预算/告警阈值）2 位小数、浮窗保留 6 位明细

## 安装（其他机器 / 其他端）

### 方式一：npm（推荐，一条命令装完）

```bash
# 1. 在 profile 目录安装包（等价于 dsh plugin --profile web add dsh-better-stats）
cd ~/.dsh/profiles/web
pnpm add dsh-better-stats

# 2. 把它登记为 bundle（让包内 cordis.patch.yml 自动注册 better-stats 行）：
#    package.json 的 dsh.profile.bundles 数组里加一行 "dsh-better-stats"

# 3. 重启 dsh web，硬刷新浏览器
```

包内自带 `cordis.patch.yml`（`dsh.bundle.patch`），登记为 bundle 后**无需手改任何配置**；默认行为 = 余额告警两档（≤¥20 琥珀 / ≤¥5 红）、无日/月预算。如需自定义，在 `cordis.patch.yml` 的 `config` 里设置（均可省略）：`balanceWarnCny` / `balanceCriticalCny`（余额两档阈值，对应档 0 关闭）、`dailyBudgetCny` / `monthlyBudgetCny`（日/月预算，配置即启用）。

### 方式二：GitHub 克隆

```bash
git clone https://github.com/null5069/dsh-better-stats.git
cd dsh-better-stats          # 无运行时依赖，不需要 npm install

ln -s "$PWD" ~/.dsh/profiles/web/node_modules/dsh-better-stats
# profile package.json 加依赖: "dsh-better-stats": "link:/绝对路径/dsh-better-stats",
# 再按方式一的第 2、3 步登记 bundle 并重启
```

## 架构

| 部分 | 文件 | 说明 |
|---|---|---|
| host 半身 | `lib/index.js` | `/plugins/better-stats/balance`（余额+赠送/充值拆分，15s 缓存，`?force=1` 绕过缓存且带 2s 冷却）、`/plugins/better-stats/cost`（整树用量+分模型 CNY 结算，10s 缓存）、`/plugins/better-stats/live`（实时计时状态 + 每秒成本结算 + 价目/预算载荷）、`/plugins/better-stats/today`（北京时区今日/本月全会话汇总，60s 缓存）；官方价目 6h 抓取同步 |
| client 半身 | `lib/client.js` | `conversation.composer.dock` 槽位统计条；本轮增量计价 + 流式估算；/live 每秒轮询；预算/峰谷倒计时悬浮层；分隔符换行自适应；可用天数估算与余额强刷；i18n（中/英） |
| 测试 | `test/client-regression.test.mjs`、`test/host-apply.test.mjs`、`test/host-fold.test.mjs` | 无依赖 Node 测试：`node test/client-regression.test.mjs`、`node test/host-apply.test.mjs`、`node test/host-fold.test.mjs` |

所有路由响应统一携带 `pricing: { source: "official"|"builtin"|"stale", fetchedAt, tables }` 与可选 `budget`，客户端不再硬编码价目数字。

## 已知边界

- 余额是**整个 DeepSeek 账号**的（官网聊天/其他程序/其他机器共用 key 都会扣）；统计只覆盖本工作区，且余额接口本身有结算延迟——对比时用"长窗口两端"口径
- 高峰/空闲时段按事件时间戳计价；官方调价后 host 会在 6h 内自动跟上，期间悬浮层会标注价目来源
- 工具执行期间的实时计时以"模型工具调用决策消息"为起点（tool/call 事件在工具完成后才落库），结束瞬间并入精确累计值
- 流式估算为显示级启发式：初始密度（reasoning ≈3.5、正文+工具 JSON ≈2.5、中文 ≈1 字/token）随每个已结算步骤 EMA 自适应校准，usage 落地后自动被精确值取代；估算按当前峰谷时段的输出价计价；日志中 `*-delta` 事件仅为抽样，完整流式文本取自 `reasoning-chunks / text-chunks / tool-call-chunks` 批量事件

## License

MIT
