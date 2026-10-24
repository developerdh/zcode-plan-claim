# zcode-plan-claim

非官方的 ZCode 活动套餐查询与领取工具，包含两部分：

- **技能** [skills/zcode-plan-claim](skills/zcode-plan-claim/SKILL.md)：符合 Agent Skills 规范的领取技能（CLI + 协议级参考），`skills/` 是唯一源
- **插件** [plugins/zcode-claim-watcher](plugins/zcode-claim-watcher)：活动监控插件，本仓库即插件市场（marketplace）

## 活动监控插件（plugins/zcode-claim-watcher）

本仓库附带一个 ZCode 插件：以 MCP server 常驻会话，按配置间隔只读轮询 `preview`（0 token），发现可领活动后通过**官方绑定的机器人渠道**把通知推送到你的微信/飞书，提醒你回复「领取活动套餐」触发会话领取。所有行为由配置文件驱动（`~/.zcode/zcode-claim-watcher.json`，每轮热加载）：

```json
{
  "enabled": true,                  // 总开关：false 停止全部计划轮询
  "intervalMinutes": 10,            // 轮询间隔，缺省 10，下限 5（自动钳制）
  "activeWindows": [                // 轮询时间窗（缺省=全天候）；支持跨零点（start > end）
    { "daysOfWeek": [0, 6], "daysOfMonth": [24], "start": "08:00", "end": "23:30" }
  ],
  "notify": {                       // 通知事件（固定走官方绑定的机器人渠道，无需配置通道）
    "events": ["discovered", "claimed", "failed"]
  }
}
```

MCP 工具：`watcher_status`（状态摘要）/ `watcher_config`（读写配置，会话内自然语言改配置）/ `watcher_history`（轮询历史，按 outcome/时间过滤）/ `check_now`（立即检查一轮，不受开关与时间窗限制）/ `notify_send`（主动推送一条通知，供自动化会话报告结果）。历史文件 `~/.zcode/zcode-claim-watcher-history.jsonl`（每轮一行，保留 7 天且 ≤1000 行），运行日志 `~/.zcode/zcode-claim-watcher.log`。

**为什么监控只提醒、不自动领取？** 活动领取需要通过阿里云无感验证码：实测 ZCode 内嵌浏览器（Desktop IAB）可以通过，而无头/CDP 浏览器（含 playwright + 系统 Chrome、CLI 无头后端）会被风控挂起且无法绕过。能过验证码的浏览器只存在于 ZCode 会话内，而监控进程无法创建会话（模型注入、宿主接口均已实测封死）。因此把分工设计为：监控负责 0 token 的「发现与提醒」，领取由用户回复触发、走 ZCode 官方 bot 渠道进入会话，用实证可靠的内嵌浏览器完成——渠道无关（微信/飞书行为一致）、用户全程可在手机上确认。

安装（ZCode 内执行；本仓库即 marketplace，插件零依赖、纯文件拷贝即装）：

```bash
zcode plugins marketplace add developerdh/zcode-plan-claim
zcode plugins install zcode-claim-watcher@zcode-plan-claim
```

开发：

```bash
npm run sync                                   # 技能脚本变更后同步进插件（skills/ 是唯一源）
npm run test:plugin                            # 监控插件单元测试（55 项：配置/时间窗/定时器/通知/历史/协议）
zcode plugins marketplace add <仓库路径>\.claude-plugin\marketplace.json   # 本地开发安装
```

说明：

- 通知依赖 ZCode 的官方 bot 绑定（扫码 + 在微信/飞书里发一条消息激活会话）；监控读取桌面记录的绑定标识直发推送，无任何额外引导步骤。已验证渠道：**微信**（iLink 中继直发）与**飞书**（开放平台 API）；其他渠道类型（Telegram/Webhook 等）会明确跳过并记日志
- 插件副本是安装时的快照：技能脚本更新后需 `npm run sync` 再 `zcode plugins update zcode-claim-watcher@zcode-plan-claim`
- 若不需要微信/飞书提醒，可以不绑定 bot 渠道：监控仍持续轮询与记录历史，桌面内随时可查

## 测试

```bash
npm test   # 本地 mock 回放真实成功响应，验证请求规格与退出码，不出外网
```

## 项目结构

```
zcode-plan-claim/
├── .claude-plugin/
│   └── marketplace.json            # 插件市场清单（ZCode 对 GitHub 源 marketplace 的标准查找位置）
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
            ├── mock-claim-test.mjs # 本地 mock 测试（CLI 请求规格与退出码）
            └── captcha-inject-test.mjs # 注入脚本状态机单测
```

## 发布

版本号统一维护在三处（package.json / plugin.json / marketplace.json），由脚本保证一致：

```bash
npm run release 0.2.0       # 三处版本号统一 bump，提交并打 tag（不推送）
git push --follow-tags      # 推送后触发 Release：测试通过 → 打 plugin.zip + sha256 → 创建 GitHub Release
```

CI 在每次 push / PR 时运行：技能测试、插件测试、`npm run sync` 后 `git diff --exit-code`（技能副本无漂移）、版本号一致性校验。

## License

[MIT](LICENSE)
