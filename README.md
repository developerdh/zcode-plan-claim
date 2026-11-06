# zcode-plan-claim

非官方的 ZCode 活动套餐查询与领取工具，包含两部分：

- **插件** `zcode-claim-watcher`：活动监控。常驻 daemon 按配置轮询发现可领活动并推送微信/飞书通知，ZCode 各会话经 HTTP 共享同一 daemon（每会话零进程）；本仓库同时是插件市场
- **技能** `zcode-plan-claim`：查询与领取，符合 Agent Skills 规范（CLI + 协议参考），可独立安装

> ⚠️ **免责声明**：个人学习用途的逆向实现，与 ZCode / 智谱官方无关，接口可能随客户端升级失效。仅限本人账号使用并遵守平台服务条款，风险自担。不绕过任何人机验证：无感验证可过、出现滑块即停转人工。

## 安装

### 从 GitHub 安装（推荐）

ZCode 会话内执行：

```bash
zcode plugins marketplace add developerdh/zcode-plan-claim
zcode plugins install zcode-claim-watcher@zcode-plan-claim
```

- 插件零依赖，安装即纯文件拷贝；读取本机 ZCode 客户端登录凭证，需桌面端保持登录
- 更新：`zcode plugins update zcode-claim-watcher@zcode-plan-claim`
- 可选：安装后在会话内执行 `/install-zcwatch-cli` 注册全局 `zcwatch` 命令（非必须，仅需要在会话外手动管理 daemon 时使用，详见下文 zcwatch 一节）

### 从源码安装

```bash
git clone https://github.com/developerdh/zcode-plan-claim.git
cd zcode-plan-claim

# 插件：注册本地市场后安装
zcode plugins marketplace add <仓库路径>/.claude-plugin/marketplace.json
zcode plugins install zcode-claim-watcher@zcode-plan-claim

# 全局命令（可选）：注册 zcwatch / zcode-claim 两个 bin
npm install -g .        # 或 npm link

# 或仅安装技能（任意 Agent，无需插件系统）
cp -r skills/zcode-plan-claim ~/.agents/skills/    # Claude Code 为 ~/.claude/skills/
```

## 架构：常驻 daemon + HTTP 直连

监控逻辑抽成独立 CLI（`daemon/`），以单一常驻 daemon 方式运行，取代旧版 stdio MCP 的每会话独立进程（N 会话 = N×30-60MB）：

```
ZCode 会话 ×N ──HTTP(127.0.0.1:47823/mcp)──> daemon（唯一常驻进程）
   │                                          ├─ Streamable HTTP MCP（5 个工具）
   └─ SessionStart 钩子 ──zcwatch ensure──> 幂等拉起 ├─ 轮询循环 / bot 通知
                                                    └─ ZCode 不在运行 → 自退出
```

- **每会话零进程**：会话直连 HTTP，不再拉起任何进程，N≥2 会话即开始省内存
- **钩子拉起**：SessionStart 钩子（`node <插件>/daemon/cli.mjs ensure`，10s 超时）幂等确保 daemon 在运行，无论成败都不阻塞会话
- **单实例**：端口绑定即锁，并发拉起时后到者探测到健康实例后自行退出
- **自退出**：每 60s 检测 ZCode 进程（首检延迟 90s），连续 3 次未检出即退出，下次会话钩子重新拉起；`--keep-alive` 关闭自退出（调试/CI 用）
- 端口固定 `47823`（插件清单为静态字面量）；`ZCODE_DAEMON_PORT` 仅用于测试隔离

## 插件：活动监控（zcode-claim-watcher）

daemon 只读轮询 `marketing/touch` 活动卡片，发现可领活动后经官方 bot 渠道推送微信/飞书通知，提醒你回复「领取活动套餐」触发会话领取。**只监控通知，不自动领取**（原因见下）。

行为由配置文件驱动（`~/.zcode/zcode-claim-watcher.json`，每轮热加载）：

```json
{
  "enabled": true,        // 总开关：false 停止全部计划轮询
  "intervalMinutes": 10,  // 轮询间隔（分钟），缺省 10，下限 5
  "activeWindows": [      // 轮询时间窗（缺省=全天候），支持跨零点（start > end）
    { "daysOfWeek": [0, 6], "daysOfMonth": [24], "start": "08:00", "end": "23:30" }
  ],
  "notify": {
    "events": ["discovered", "claimed", "failed"],
    "channels": [],        // [] = 自动（只发绑定列表第一个启用渠道）；如 ["weixin","feishu"]（都发）
    "failover": true       // 渠道发送报错时自动补发其余绑定渠道（成功一个即止）；false = 不转移
  }
}
```

MCP 工具（ZCode 会话内直接可用）：

| 工具 | 作用 |
|---|---|
| `watcher_status` | 运行状态、配置摘要、历史与已领取/已过期套餐（只读） |
| `watcher_config` | 读取或修改监控配置 |
| `watcher_history` | 轮询历史（默认最近 10 条，按 outcome/时间过滤） |
| `check_now` | 立即执行一轮检查，不受开关与时间窗限制 |
| `notify_send` | 主动推送一条通知；可选 `channel`：`weixin`/`feishu`/`all`，缺省用配置默认渠道 |

数据文件：历史 `~/.zcode/zcode-claim-watcher-history.jsonl`（保留 7 天且 ≤1000 行）、日志 `~/.zcode/zcode-claim-watcher.log`、pid 记录 `~/.zcode/zcode-claim-daemon.json`。

### 为什么只提醒、不自动领取？

领取必须过阿里云无感验证码，实测只有 ZCode 内嵌浏览器能通过：无头/CDP 浏览器会被风控挂起，监控进程无法创建会话。因此插件只做「发现与提醒」，领取由你回复通知触发、在会话内完成（手机上即可确认，微信/飞书行为一致）。

### 通知渠道

- 依赖 ZCode 官方 bot 绑定：客户端扫码后 daemon 直发推送，无额外配置；已验证微信与飞书，其他渠道类型跳过并记日志
- 默认只发一个渠道，避免双端重复打扰；要都发配 `["weixin","feishu"]`
- `failover` 默认开：目标渠道报错且无任何成功时，按绑定顺序自动补发其余渠道（返回值带 `failover:true`）；指定渠道未绑定属配置问题，只报错不改道
- 不绑定 bot 也可用：监控照常轮询记录，ZCode 桌面内随时可查

## zcwatch：daemon 管理 CLI

> 全局命令需显式注册，插件安装不会自动完成：
>
> - **插件用户**：会话内执行 `/install-zcwatch-cli`，由 AI 执行 `npm install -g "<插件目录>"` 完成（零依赖、不联网，同时注册 `zcwatch` 与技能 CLI `zcode-claim`）。**非必须步骤**——插件日常使用无需 CLI（钩子已自动 ensure，管理动作会话内经 MCP 工具完成），仅需要在会话外手动管理 daemon 时安装；插件更新后重跑一次以刷新全局副本
> - **源码用户**：`npm install -g .` / `npm link`
> - 不建议自建 alias/wrapper 指向插件缓存目录：路径含版本号，`zcode plugins update` 后即失效
>
> 日常无需手动调用：`status` / `check` 等管理动作会话内经 MCP 工具即可完成，CLI 的典型独有场景是会话外 `stop` daemon。不安装 CLI 时，插件用户也可临时用 `node <插件路径>/daemon/cli.mjs` 替代 `zcwatch`。

| 命令 | 作用 |
|---|---|
| `zcwatch status` | daemon 是否在运行（pid / 版本 / uptime / 轮次），exit 0=运行中 |
| `zcwatch ensure` | 幂等拉起（健康即秒回；未运行则后台拉起并等就绪） |
| `zcwatch stop` | 优雅停止（未在运行视为成功） |
| `zcwatch check` | 经 MCP 立即检查一轮（诊断/自动化用） |
| `zcwatch serve --keep-alive` | 前台运行 daemon（`--keep-alive` 关闭自退出，调试/CI 用） |
| `zcwatch --test` | 轮询一次活动卡片输出 JSON（自检） |

自退出依赖进程检测：Windows 用 `tasklist` 镜像名匹配 `zcode(.exe)`，Linux/macOS 用 `pgrep -ix zcode`。进程名有差异（发行版打包/自编译改名）时用 `ZCODE_DAEMON_PROCESS_RE` 覆盖，如 `'zcode(-helper)?'`。

## 技能：查询与领取（zcode-plan-claim）

零依赖 CLI（Node ≥ 18）：

```bash
node skills/zcode-plan-claim/scripts/claim.mjs status    # 查询活动状态（唯一权威判定）；退出码 0=有可领, 1=无可领, 4=失败
node skills/zcode-plan-claim/scripts/claim.mjs pending   # 读取本地待领记录（零网络）；分支看 recommendedPlanId
node skills/zcode-plan-claim/scripts/claim.mjs active    # 查询已生效套餐（复核到账）
node skills/zcode-plan-claim/scripts/claim.mjs configs   # 查询客户端配置（诊断用）
node skills/zcode-plan-claim/scripts/claim.mjs claim --plan <planId> --captcha-param-file <验证码参数文件>   # 领取
```

- 凭证自动从本机 ZCode 客户端读取（AES-256-GCM 本地解密，明文仅在内存，仅发送至 `zcode.z.ai`）
- 验证码参数来自浏览器注入 [captcha-inject.js](skills/zcode-plan-claim/scripts/captcha-inject.js)（阿里云无感验证）；出现滑块立即停止
- 协议细节与错误码见 [references/CLAIM-LOGIC.md](skills/zcode-plan-claim/references/CLAIM-LOGIC.md)

## 测试

```bash
npm test             # 技能测试：CLI mock 回放 + 验证码注入状态机，不出外网
npm run test:plugin  # 插件 + daemon 测试 79 项：配置/时间窗/通知/历史 + HTTP 协议/ensure 拉起/进程检测
```

HTTP 协议测试真实 spawn daemon（env 隔离 + 本地 mock ZCode API/iLink/飞书），覆盖握手、SSE 帧、工具全链路、单实例锁等。

## 发布

版本号统一维护在三处（package.json / plugin.json / marketplace.json），由脚本保证一致：

```bash
npm run release 0.2.1       # 三处版本统一 bump，提交并打 tag v0.2.1（不推送）
git push --follow-tags      # 触发 Release：测试 → 打 plugin.zip + sha256 → 创建 GitHub Release
```

CI 在每次 push / PR 时运行：全部测试、技能与 daemon 副本同步校验、三处版本号一致性校验。

## 项目结构

`skills/` 与 `daemon/` 是唯一源，变更后 `npm run sync` 同步进插件（CI 校验副本无漂移）：

```
zcode-plan-claim/
├── .claude-plugin/marketplace.json # 插件市场清单（ZCode 对 GitHub 源的标准查找位置）
├── .github/workflows/              # CI（测试+一致性校验）与 Release
├── daemon/                         # 常驻监控服务（唯一源）
│   ├── cli.mjs                     # zcwatch CLI：serve / ensure / stop / status / check
│   ├── serve.mjs                   # daemon 组装：HTTP 监听 + 监控循环 + 自退出
│   ├── http.mjs                    # Streamable HTTP MCP 传输层 + /health + /shutdown
│   ├── mcp.mjs                     # 业务核心：5 个工具 / 轮次执行 / 版本号解析
│   ├── lib/                        # config / history / loop / notify / state / windows / procscan
│   └── test/                       # 单测（不随插件分发）
├── plugins/zcode-claim-watcher/    # 监控插件（同步副本：plugin.json + hooks + daemon + skills）
├── scripts/                        # sync-plugin（双同步）/ check-release（版本校验）/ release（发版）
└── skills/zcode-plan-claim/        # 技能（唯一源）
    ├── SKILL.md                    # 入口：元数据 + 操作流程
    ├── references/CLAIM-LOGIC.md   # 协议参考（凭证、验证码、错误码、踩坑清单）
    ├── scripts/                    # claim.mjs（CLI）+ captcha-inject.js（验证码注入）
    └── tests/                      # mock 回放 + 状态机单测
```

## License

[MIT](LICENSE)
