# dsh-better-stats

DSH Web 输入框下方的增强统计条：官方人民币计价（峰谷时段）、多模型分账、实时计时、子代理树合并、余额直连。

```
DeepSeek 官方 | 余额 ¥8.67 | 本轮 ¥0.1676 · 会话 ¥29.49 | 20 轮 · 345 步 | LLM 1h 12m · 工具 5m 6s | 首token平均 3.88s · 111.72tok/s | 缓存 103.98M · 命中 98.64% | 输入 1.44M · 输出 336.53K
```

## 功能

- **余额**：host 直连 `api.deepseek.com/user/balance`（DEEPSEEK_API_KEY 走 DSH credentials seam），15s 缓存刷新
- **消费**：官方 CNY 价目表（[api-docs.deepseek.com/zh-cn/quick_start/pricing](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)），**峰谷分时段**（高峰 = 北京 9:00-12:00 / 14:00-18:00，价格两倍），**按每条消息的 model 分账**（deepseek-v4-flash / deepseek-v4-pro 各用各的价目）
- **本轮**：只对新增 token 计价（实时累计，模型切换/时段翻转不会产生回溯幻影）
- **会话**：host 端按完整轨迹逐步结算（每秒），**子代理整树合并**（含持久化旧会话），悬浮层显示分模型明细与子会话数
- **实时计时**：LLM/工具耗时在步骤进行中每秒跳动（工具相位以模型工具调用决策消息为起点，host 侧 fold 完整日志）
- **布局**：换行时自动删除被拆到行首/行尾的孤立分隔符；Token 组拆为「缓存命中」「输入输出」两组

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

包内自带 `cordis.patch.yml`（`dsh.bundle.patch`），登记为 bundle 后**无需手改任何配置**。

### 方式二：GitHub 克隆

```bash
git clone https://github.com/hanshushao123/dsh-better-stats.git
cd dsh-better-stats          # 无运行时依赖，不需要 npm install

ln -s "$PWD" ~/.dsh/profiles/web/node_modules/dsh-better-stats
# profile package.json 加依赖: "dsh-better-stats": "link:/绝对路径/dsh-better-stats",
# 再按方式一的第 2、3 步登记 bundle 并重启
```

## 架构

| 部分 | 文件 | 说明 |
|---|---|---|
| host 半身 | `lib/index.js` | `/plugins/better-stats/balance`（余额，15s 缓存）、`/plugins/better-stats/cost`（整树用量+分模型 CNY 结算，10s 缓存）、`/plugins/better-stats/live`（实时计时状态 + 每秒成本结算） |
| client 半身 | `lib/client.js` | `conversation.composer.dock` 槽位统计条；本轮增量计价；/live 每秒轮询；分隔符换行自适应 |
| 测试 | `test/client-regression.test.mjs`、`test/host-fold.test.mjs` | 无依赖 Node 测试：`node test/client-regression.test.mjs`、`node test/host-fold.test.mjs` |

## 已知边界

- 余额是**整个 DeepSeek 账号**的（官网聊天/其他程序/其他机器共用 key 都会扣）；统计只覆盖本工作区，且余额接口本身有结算延迟——对比时用"长窗口两端"口径
- 高峰/空闲时段按事件时间戳计价；官方调价后需同步 `PRICE_TABLES`
- 工具执行期间的实时计时以"模型工具调用决策消息"为起点（tool/call 事件在工具完成后才落库），结束瞬间并入精确累计值
