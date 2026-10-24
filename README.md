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

使用：

```bash
npm run sync                                   # 技能脚本变更后同步进插件（skills/ 是唯一源）
npm run test:plugin                            # 监控插件单元测试（55 项：配置/时间窗/定时器/通知/历史/协议）
zcode plugins marketplace add <仓库>/plugins/marketplace.json
zcode plugins install zcode-claim-watcher
```

说明：

- 通知依赖 ZCode 的官方 bot 绑定（扫码 + 在微信/飞书里发一条消息激活会话）；监控读取桌面记录的绑定标识直发推送，无任何额外引导步骤。已验证渠道：**微信**（iLink 中继直发）与**飞书**（开放平台 API）；其他渠道类型（Telegram/Webhook 等）会明确跳过并记日志
- 插件副本是安装时的快照：技能脚本更新后需 `npm run sync` 再 `zcode plugins update zcode-claim-watcher`
- 若不需要微信/飞书提醒，可以不绑定 bot 渠道：监控仍持续轮询与记录历史，桌面内随时可查

## 测试

```bash
npm test   # 本地 mock 回放真实成功响应，验证请求规格与退出码，不出外网
```

## 项目结构

```
zcode-plan-claim/
├── README.md / LICENSE / package.json / .gitignore
└── skills/
    └── zcode-plan-claim/            # 技能（Agent Skills 规范结构）
        ├── SKILL.md                 # 技能入口：元数据 + 操作流程
        ├── references/
        │   └── CLAIM-LOGIC.md       # 协议级参考文档（凭证、验证码、错误码、踩坑清单）
        ├── scripts/
        │   ├── claim.mjs            # CLI：preview / current / status / configs / claim
        │   └── captcha-inject.js    # 验证码注入脚本（内置等待与滑块判定状态机）
        └── tests/
            ├── mock-claim-test.mjs  # 本地 mock 测试（CLI 请求规格与退出码）
            └── captcha-inject-test.mjs # 注入脚本状态机单测
```

## License

[MIT](LICENSE)
