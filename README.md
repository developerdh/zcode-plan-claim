# zcode-plan-claim

非官方的 ZCode 活动套餐查询与领取工具，包含两部分：

- **插件** `zcode-claim-watcher`：活动监控，轮询发现可领活动并推送微信/飞书通知；本仓库同时是插件市场（marketplace）
- **技能** `zcode-plan-claim`：查询与领取，符合 Agent Skills 规范（CLI + 协议参考），可独立安装

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

# 或仅安装技能（任意 Agent，无需插件系统）
cp -r skills/zcode-plan-claim ~/.agents/skills/    # Claude Code 为 ~/.claude/skills/
```

## 插件：活动监控（zcode-claim-watcher）

以 MCP server 常驻 ZCode 会话，按配置间隔只读轮询 `preview`（0 token），发现可领活动后通过官方 bot 渠道把通知推送到微信/飞书，提醒你回复「领取活动套餐」触发会话领取。**只监控通知，不自动领取**（原因见下）。

行为由配置文件驱动（`~/.zcode/zcode-claim-watcher.json`，每轮热加载）：

```json
{
  "enabled": true,        // 总开关：false 停止全部计划轮询
  "intervalMinutes": 10,  // 轮询间隔（分钟），缺省 10，下限 5（自动钳制）
  "activeWindows": [      // 轮询时间窗（缺省=全天候），支持跨零点（start > end）
    { "daysOfWeek": [0, 6], "daysOfMonth": [24], "start": "08:00", "end": "23:30" }
  ],
  "notify": {
    "events": ["discovered", "claimed", "failed"]
  }
}
```

MCP 工具：

| 工具 | 作用 |
|---|---|
| `watcher_status` | 查询运行状态、配置摘要、历史与已领取/已过期套餐（只读） |
| `watcher_config` | 读取或修改监控配置（会话内自然语言改配置） |
| `watcher_history` | 查询轮询历史（默认最近 10 条，按 outcome/时间过滤） |
| `check_now` | 立即执行一轮检查，不受开关与时间窗限制 |
| `notify_send` | 主动推送一条通知（供自动化会话报告结果） |

历史文件 `~/.zcode/zcode-claim-watcher-history.jsonl`（每轮一行，保留 7 天且 ≤1000 行），运行日志 `~/.zcode/zcode-claim-watcher.log`。

### 为什么只提醒、不自动领取？

领取必须通过阿里云无感验证码：实测只有 ZCode 内嵌浏览器能通过，无头/CDP 浏览器（含 playwright + 系统 Chrome、CLI 无头后端）会被风控挂起；而能过验证码的浏览器只存在于 ZCode 会话内，监控进程无法创建会话（模型注入、宿主接口均已实测封死）。因此分工为：插件负责 0 token 的「发现与提醒」，领取由你回复通知触发、在会话内用内嵌浏览器完成——手机上即可确认，渠道无关（微信/飞书行为一致）。

### 通知渠道

- 依赖 ZCode 官方 bot 绑定：客户端扫码，并在微信/飞书里发一条消息激活会话；监控读取桌面记录的绑定标识直发推送，无额外配置
- 已验证渠道：**微信**（iLink 中继直发）与**飞书**（开放平台 API）；其他渠道类型（Telegram/Webhook 等）明确跳过并记日志
- 不绑定 bot 也可用：监控仍持续轮询并记录历史，ZCode 桌面内随时可查

## 技能：查询与领取（zcode-plan-claim）

零依赖 CLI（Node ≥ 18）：

```bash
node skills/zcode-plan-claim/scripts/claim.mjs status    # 一站式状态查询：可领/已领生效/领取历史（推荐）
node skills/zcode-plan-claim/scripts/claim.mjs preview   # 查询当前可领套餐；退出码 2=有可领, 3=暂无可领
node skills/zcode-plan-claim/scripts/claim.mjs pending   # 读取本地待领记录（零网络），供回复通知后快速定位
node skills/zcode-plan-claim/scripts/claim.mjs current   # 查询已生效套餐（验证到账）
node skills/zcode-plan-claim/scripts/claim.mjs claim --plan <planId> --captcha-param-file <验证码参数文件>
```

- 凭证自动从本机 ZCode 客户端读取（AES-256-GCM 本地解密，明文只存在于内存中，仅发送至 `zcode.z.ai`）
- 验证码参数来自浏览器注入 [captcha-inject.js](skills/zcode-plan-claim/scripts/captcha-inject.js)（阿里云无感验证）；出现滑块立即停止，转客户端手动领取
- 仅限本人账号使用，遵守平台服务条款；协议细节与错误码见 [references/CLAIM-LOGIC.md](skills/zcode-plan-claim/references/CLAIM-LOGIC.md)

## 测试

```bash
npm test             # 技能测试 66 项：CLI mock 回放 + 验证码注入状态机，不出外网
npm run test:plugin  # 插件测试 55 项：配置/时间窗/定时器/通知/历史/协议
```

## 发布

版本号统一维护在三处（package.json / plugin.json / marketplace.json），由脚本保证一致：

```bash
npm run release 0.1.1       # 例：三处版本统一 bump 到 0.1.1，提交并打 tag v0.1.1（不推送）
git push --follow-tags      # 推送后触发 Release：测试通过 → 打 plugin.zip + sha256 → 创建 GitHub Release
```

CI 在每次 push / PR 时运行：全部测试、技能副本同步校验、三处版本号一致性校验。

## 项目结构

`skills/` 是技能唯一源，变更后 `npm run sync` 同步进插件（CI 校验副本无漂移）：

```
zcode-plan-claim/
├── .claude-plugin/
│   └── marketplace.json            # 插件市场清单（ZCode 对 GitHub 源的标准查找位置）
├── .github/workflows/              # CI（测试+一致性校验）与 Release（打 tag 发布）
├── plugins/
│   └── zcode-claim-watcher/        # 监控插件（.zcode-plugin/plugin.json + mcp/ + skills/ + commands/ + test/）
├── scripts/                        # sync-plugin（技能同步）/ check-release（版本校验）/ release（发版）
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
