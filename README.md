# zcode-plan-claim

非官方的 ZCode 活动套餐查询与领取工具。ZCode 客户端会不定期在左下角投放限时活动卡片（例如赠送 GLM 模型限时 token 额度），本项目将客户端的领取链路整理为：

- 一个零依赖的 Node CLI（查询可领套餐 / 查询已生效套餐 / 提交领取）
- 一份协议级参考文档（[skills/zcode-plan-claim/references/CLAIM-LOGIC.md](skills/zcode-plan-claim/references/CLAIM-LOGIC.md)）
- 一个符合 Agent Skills 开放规范的技能（[skills/zcode-plan-claim/SKILL.md](skills/zcode-plan-claim/SKILL.md)），供 AI Agent（如 ZCode）按流程自动执行

> ⚠️ **免责声明**：本项目为个人学习用途的逆向实现，与 ZCode / 智谱官方无关。接口、凭证格式与验证码场景随时可能随客户端升级而变更；活动为平台限时投放且每账号限领一次。请仅用于本人账号，遵守服务条款，自行承担使用风险。本项目不绕过任何人机验证。

## 工作原理

```
preview 查询可领套餐 → 浏览器完成阿里云无感验证码 → claim 提交领取 → current 复核到账
```

凭证从本机 ZCode 客户端的 `~/.zcode/v2/credentials.json` 读取（AES-256-GCM 本地解密 `zcodejwttoken`），明文只存在于内存中，仅发送至 `zcode.z.ai`。协议细节见 [skills/zcode-plan-claim/references/CLAIM-LOGIC.md](skills/zcode-plan-claim/references/CLAIM-LOGIC.md)。

## 环境要求

- Windows（凭证与 ZCode 客户端绑定）+ 已登录的 ZCode 桌面客户端
- Node.js ≥ 18（无第三方依赖）
- 领取步骤需要可编程的浏览器环境（ZCode 内嵌浏览器，或 Playwright 驱动的本地 Chromium）

## CLI 用法

```bash
node skills/zcode-plan-claim/scripts/claim.mjs preview    # 查询当前可领取套餐；退出码 2=有可领, 3=暂无可领
node skills/zcode-plan-claim/scripts/claim.mjs current    # 查询已生效套餐
node skills/zcode-plan-claim/scripts/claim.mjs configs    # 查询客户端配置（诊断用，请求规格尚未完全捕获）
node skills/zcode-plan-claim/scripts/claim.mjs claim --plan <planId> --captcha-param-file <验证码参数文件>   # 领取
```

`claim` 需要的验证码参数来自浏览器步骤（阿里云 Captcha 2.0 无感验证）：把 [skills/zcode-plan-claim/scripts/captcha-inject.js](skills/zcode-plan-claim/scripts/captcha-inject.js) 注入 `zcode.z.ai/cn` 页面执行，脚本内置等待与滑块判定，终态见 `window.__capResult`（`ok`/`slider`/`sdk_failed`），详见 [SKILL.md](skills/zcode-plan-claim/SKILL.md) 的"操作流程"。若风控要求人工滑块，请直接在客户端内手动领取。

## 作为 Agent Skill 安装

技能位于 `skills/zcode-plan-claim/`，符合 Agent Skills 开放规范（SKILL.md + scripts/ + references/）：

```bash
# 方式一：skills CLI 自动安装（识别 skills/ 容器目录）
npx skills add <owner>/zcode-plan-claim

# 方式二：手动拷贝技能子目录
# ZCode（或任何读取 ~/.agents/skills 的 Agent）
cp -r skills/zcode-plan-claim ~/.agents/skills/
# Claude Code
cp -r skills/zcode-plan-claim ~/.claude/skills/
```

安装后对 Agent 说"检查并领取 ZCode 活动"即可触发。注意：SKILL.md 中浏览器步骤默认使用 ZCode 内嵌浏览器，其他 Agent 需替换为自身浏览器自动化能力。

## 定时自动化

现成的任务提示词见 [AUTOMATION-PROMPT.md](AUTOMATION-PROMPT.md)。实践要点：

- 每日一次足够：先 `preview`，无套餐直接结束（不产生写请求）；有套餐再走验证码与领取
- 领取步骤依赖浏览器环境。实测 ZCode 内嵌浏览器路径在桌面会话锁屏 / 远程断开状态下仍可运行（Chromium 引擎内渲染，不依赖桌面可见性），但要求 ZCode 进程存活（建议开启"关闭到托盘"）
- 若风控要求人工滑块，任务应停止并转为在客户端内手动领取

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
        │   ├── claim.mjs            # CLI：preview / current / configs / claim
        │   └── captcha-inject.js    # 验证码注入脚本（内置等待与滑块判定状态机）
        └── tests/
            ├── mock-claim-test.mjs  # 本地 mock 测试（CLI 请求规格与退出码）
            └── captcha-inject-test.mjs # 注入脚本状态机单测
```

## License

[MIT](LICENSE)
