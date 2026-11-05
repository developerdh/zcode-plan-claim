# zcode-plan-claim

非官方的 ZCode 活动套餐查询与领取工具，包含两部分：

- **插件** `zcode-claim-watcher`：活动监控。常驻 daemon 按配置轮询发现可领活动并推送微信/飞书通知，ZCode 各会话经 HTTP 共享同一 daemon（每会话零进程）；本仓库同时是插件市场（marketplace）
- **技能** `zcode-plan-claim`：查询与领取，符合 Agent Skills 规范（CLI + 协议参考），可独立安装

> ⚠️ **免责声明**：本项目为个人学习用途的逆向实现，与 ZCode / 智谱官方无关；接口与验证码场景可能随客户端升级随时失效。请仅用于本人账号并遵守平台服务条款，风险自担。本项目不绕过任何人机验证——无感验证可过、出现滑块即停转人工。

## 安装

### 方式一：从 GitHub 安装（推荐）

ZCode 会话内执行：

```bash
zcode plugins marketplace add developerdh/zcode-plan-claim
zcode plugins install zcode-claim-watcher@zcode-plan-claim
```

- 本仓库即插件市场，市场清单位于 `.claude-plugin/marketplace.json`（ZCode 对 GitHub 源的标准查找位置）
- 插件零依赖，安装即纯文件拷贝；插件与技能都读取本机 ZCode 客户端的登录凭证，需桌面端保持登录
- 更新：仓库发布新版本后执行 `zcode plugins update zcode-claim-watcher@zcode-plan-claim`

### 方式二：从源码安装

```bash
git clone https://github.com/developerdh/zcode-plan-claim.git
cd zcode-plan-claim

# 插件：注册本地市场后安装
zcode plugins marketplace add <仓库路径>/.claude-plugin/marketplace.json
zcode plugins install zcode-claim-watcher@zcode-plan-claim

# 全局命令（可选）：源码安装后注册 zcwatch / zcode-claim 两个 bin，便于手动管理 daemon
npm install -g .        # 或 npm link

# 或仅安装技能（任意 Agent，无需插件系统）
cp -r skills/zcode-plan-claim ~/.agents/skills/    # Claude Code 为 ~/.claude/skills/
```

## 架构：常驻 daemon + HTTP 直连（每会话零进程）

旧版插件以 stdio 声明 MCP，ZCode **每个会话拉起一份独立 server 进程**（N 会话 = N×30-60MB）。新版把监控逻辑抽成独立 CLI（`daemon/`），以**单一常驻 daemon** 方式运行：

```
ZCode 会话 ×N ──HTTP(127.0.0.1:47823/mcp)──> daemon（唯一常驻进程）
   │                                          ├─ Streamable HTTP MCP（5 个工具）
   └─ SessionStart 钩子 ──zcwatch ensure──> 幂等拉起 ├─ 轮询循环 / bot 通知
                                                    └─ ZCode 不在运行 → 自退出
```

- **每会话零进程**：MCP 以 `{"type":"http","url":"http://127.0.0.1:47823/mcp"}` 声明，ZCode 直连 HTTP，会话本身不再拉起任何进程；N≥2 个会话即开始省内存
- **钩子拉起**：会话启动钩子（`hooks/hooks.json` → `node <插件>/daemon/cli.mjs ensure`，10s 超时）幂等确保 daemon 在运行——健康即秒回，否则后台 detached 拉起并等就绪，无论成败都不阻塞会话
- **单实例**：端口绑定即锁。并发拉起时后到者探测到已有健康实例后自行退出，无需额外锁文件（旧 `lock.mjs` 退役）
- **自退出**：daemon 每 60s 检测 ZCode 进程（首检延迟 90s 避开冷启动），连续 3 次未检出即退出——ZCode 关了 daemon 也不占资源；下次会话钩子会重新拉起。`--keep-alive` 可关闭（手动调试/CI）
- 端口固定 `47823`（插件清单 URL 为静态字面量）；`ZCODE_DAEMON_PORT` 仅用于测试隔离

## 插件：活动监控（zcode-claim-watcher）

daemon 按配置间隔只读轮询 `marketing/touch` 活动卡片，发现可领活动后通过官方 bot 渠道把通知推送到微信/飞书，提醒你回复「领取活动套餐」触发会话领取。**只监控通知，不自动领取**（原因见下）。

行为由配置文件驱动（`~/.zcode/zcode-claim-watcher.json`，每轮热加载）：

```json
{
  "enabled": true,        // 总开关：false 停止全部计划轮询
  "intervalMinutes": 10,  // 轮询间隔（分钟），缺省 10，下限 5（自动钳制）
  "activeWindows": [      // 轮询时间窗（缺省=全天候），支持跨零点（start > end）
    { "daysOfWeek": [0, 6], "daysOfMonth": [24], "start": "08:00", "end": "23:30" }
  ],
  "notify": {
    "events": ["discovered", "claimed", "failed"],
    "channels": [],        // 推送渠道：[] = 自动（只发绑定列表第一个启用渠道）；如 ["weixin"]、["feishu"]、["weixin","feishu"]（都发）
    "failover": true       // 渠道发送报错时自动补发其余绑定渠道（成功一个即止）；false = 不转移
  }
}
```

MCP 工具（ZCode 会话内直接可用）：

| 工具 | 作用 |
|---|---|
| `watcher_status` | 查询运行状态、配置摘要、历史与已领取/已过期套餐（只读） |
| `watcher_config` | 读取或修改监控配置（会话内自然语言改配置） |
| `watcher_history` | 查询轮询历史（默认最近 10 条，按 outcome/时间过滤） |
| `check_now` | 立即执行一轮检查，不受开关与时间窗限制 |
| `notify_send` | 主动推送一条通知（供自动化会话报告结果）；可选 `channel` 参数指定 `weixin`/`feishu`/`all`，缺省用配置默认渠道 |

历史文件 `~/.zcode/zcode-claim-watcher-history.jsonl`（每轮一行，保留 7 天且 ≤1000 行），运行日志 `~/.zcode/zcode-claim-watcher.log`，daemon pid 记录 `~/.zcode/zcode-claim-daemon.json`。

## zcwatch：daemon 管理 CLI

`daemon/cli.mjs` 是 daemon 的唯一入口，源码安装时注册为全局命令 `zcwatch`（仅装插件的用户把下述命令中的 `zcwatch` 换成 `node <插件路径>/daemon/cli.mjs`；日常使用无需手动——钩子已自动 ensure）：

| 命令 | 作用 |
|---|---|
| `zcwatch status` | daemon 是否在运行（pid / 版本 / uptime / 轮次），exit 0=运行中 |
| `zcwatch ensure` | 幂等拉起（健康即秒回；未运行则后台拉起并等就绪） |
| `zcwatch stop` | 优雅停止（未在运行视为成功） |
| `zcwatch check` | 经 MCP 立即检查一轮（诊断/自动化用） |
| `zcwatch serve --keep-alive` | 前台运行 daemon（`--keep-alive` 关闭自退出，调试/CI 用） |
| `zcwatch --selftest-poll` | 轮询一次活动卡片输出 JSON（自检） |

### 自退出与跨平台进程检测

自退出依赖"ZCode 是否在运行"的进程检测（`daemon/lib/procscan.mjs`）：

- **Windows**：`tasklist /NH /FO CSV` 镜像名匹配 `zcode(.exe)`
- **Linux**：`pgrep -ix zcode`（精确名匹配）；pgrep 不可用时回退扫 `/proc/*/comm`
- **macOS**：`pgrep -ix zcode`；自定义正则时用 `ps -axo comm=` 按名称枚举
- 进程名有差异（发行版打包/自编译改名）时，用环境变量覆盖匹配规则：`ZCODE_DAEMON_PROCESS_RE='zcode(-helper)?'`（非法正则忽略并告警）

### 为什么只提醒、不自动领取？

领取必须通过阿里云无感验证码：实测只有 ZCode 内嵌浏览器能通过，无头/CDP 浏览器（含 playwright + 系统 Chrome、CLI 无头后端）会被风控挂起；而能过验证码的浏览器只存在于 ZCode 会话内，监控进程无法创建会话（模型注入、宿主接口均已实测封死）。因此分工为：插件负责 0 token 的「发现与提醒」，领取由你回复通知触发、在会话内用内嵌浏览器完成——手机上即可确认，渠道无关（微信/飞书行为一致）。

### 通知渠道

- 依赖 ZCode 官方 bot 绑定：客户端扫码，并在微信/飞书里发一条消息激活会话；daemon 读取桌面记录的绑定标识直发推送，无额外配置
- 已验证渠道：**微信**（iLink 中继直发）与**飞书**（开放平台 API）；其他渠道类型（Telegram/Webhook 等）明确跳过并记日志
- **默认只发一个渠道**：`notify.channels` 为空时取绑定列表第一个启用的渠道，避免双端重复打扰；要都发就配 `["weixin","feishu"]`
- **失败转移**（`notify.failover`，默认开）：目标渠道发送报错且无任何成功时，按绑定顺序自动补发其余渠道，成功一个即止（转移结果在返回值里带 `failover:true` 明示）；“指定渠道未绑定”属配置问题，只明确报错、不改道
- 不绑定 bot 也可用：监控仍持续轮询并记录历史，ZCode 桌面内随时可查

## 技能：查询与领取（zcode-plan-claim）

零依赖 CLI（Node ≥ 18）：

```bash
node skills/zcode-plan-claim/scripts/claim.mjs status    # 查询活动状态（唯一权威判定）；退出码 0=有可领, 1=无可领, 4=失败
node skills/zcode-plan-claim/scripts/claim.mjs pending   # 读取本地待领记录（零网络）；分支看 recommendedPlanId
node skills/zcode-plan-claim/scripts/claim.mjs active    # 查询已生效套餐（复核到账）
node skills/zcode-plan-claim/scripts/claim.mjs configs   # 查询客户端配置（诊断用）
node skills/zcode-plan-claim/scripts/claim.mjs claim --plan <planId> --captcha-param-file <验证码参数文件>   # 领取
```

- 凭证自动从本机 ZCode 客户端读取（AES-256-GCM 本地解密，明文只存在于内存中，仅发送至 `zcode.z.ai`）
- 验证码参数来自浏览器注入 [captcha-inject.js](skills/zcode-plan-claim/scripts/captcha-inject.js)（阿里云无感验证）；出现滑块立即停止，转客户端手动领取
- 仅限本人账号使用，遵守平台服务条款；协议细节与错误码见 [references/CLAIM-LOGIC.md](skills/zcode-plan-claim/references/CLAIM-LOGIC.md)

## 测试

```bash
npm test             # 技能测试：CLI mock 回放 + 验证码注入状态机，不出外网
npm run test:plugin  # 插件 + daemon 测试 79 项：配置/时间窗/定时器/通知渠道/失败转移/历史 + HTTP 协议/ensure 拉起/进程检测
```

daemon 的 HTTP 协议测试会真实 spawn daemon（env 隔离 + 本地 mock ZCode API/iLink/飞书），覆盖握手、SSE 帧、工具全链路、通知去重与渠道选择、单实例锁（EADDRINUSE）等。

## 发布

版本号统一维护在三处（package.json / plugin.json / marketplace.json），由脚本保证一致：

```bash
npm run release 0.2.1       # 例：三处版本统一 bump 到 0.2.1，提交并打 tag v0.2.1（不推送）
git push --follow-tags      # 推送后触发 Release：测试通过 → 打 plugin.zip + sha256 → 创建 GitHub Release
```

CI 在每次 push / PR 时运行：全部测试、技能与 daemon 副本同步校验、三处版本号一致性校验。

## 项目结构

`skills/` 与 `daemon/` 是唯一源，变更后 `npm run sync` 同步进插件（CI 校验副本无漂移）：

```
zcode-plan-claim/
├── .claude-plugin/
│   └── marketplace.json            # 插件市场清单（ZCode 对 GitHub 源的标准查找位置）
├── .github/workflows/              # CI（测试+一致性校验）与 Release（打 tag 发布）
├── daemon/                         # 常驻监控服务（唯一源）
│   ├── cli.mjs                     # zcwatch CLI：serve / ensure / stop / status / check
│   ├── serve.mjs                   # daemon 组装：HTTP 监听 + 监控循环 + 自退出
│   ├── http.mjs                    # Streamable HTTP MCP 传输层 + /health + /shutdown
│   ├── mcp.mjs                     # 业务核心：5 个工具 / 轮次执行 / 版本号解析
│   ├── lib/                        # config / history / loop / notify / state / windows / procscan
│   └── test/                       # HTTP 协议 / ensure 拉起 / procscan 单测（不随插件分发）
├── plugins/
│   └── zcode-claim-watcher/        # 监控插件（plugin.json + hooks/ + daemon/ + skills/ + commands/ + test/）
│       ├── .zcode-plugin/plugin.json   # mcpServers 声明 http://127.0.0.1:47823/mcp
│       └── hooks/hooks.json            # SessionStart → daemon cli ensure
├── scripts/                        # sync-plugin（双同步）/ check-release（版本校验）/ release（发版）
└── skills/
    └── zcode-plan-claim/           # 技能（Agent Skills 规范结构，唯一源）
        ├── SKILL.md                # 技能入口：元数据 + 操作流程
        ├── references/
        │   └── CLAIM-LOGIC.md      # 协议级参考文档（凭证、验证码、错误码、踩坑清单）
        ├── scripts/
        │   ├── claim.mjs           # CLI：preview / pending / current / status / configs / claim
        │   └── captcha-inject.js   # 验证码注入脚本（内置等待与滑块判定状态机）
        └── tests/
            ├── mock-claim-test.mjs     # CLI mock 测试（请求规格与退出码）
            └── captcha-inject-test.mjs # 注入脚本状态机单测
```

## License

[MIT](LICENSE)
