---
name: zcode-plan-claim
description: 领取 ZCode 活动卡片赠送的编程套餐额度（如限时 token 包/模型额度）。当用户提到领取活动套餐、回复活动通知、或查询活动状态与领取历史时使用。核心流程：确定 plan_id（用户消息 → 本地待领记录 → status 查询活动状态）→ 内置浏览器无感验证码 → claim 领取 → active 复核。约束：仅限本人账号使用、验证码出现滑块必须停止、终态错误码不重试。不适用：购买付费套餐、管理订阅、API Key 直连配置。
---

# ZCode 活动套餐领取

## 流程

1. **确定 plan_id**，按优先级取第一个可用的：
   - 用户消息或近期通知中已明确给出的 plan_id
   - `node <技能目录>/scripts/claim.mjs pending` —— 读取本地待领记录（零网络），取返回的 `recommendedPlanId`
   - `node <技能目录>/scripts/claim.mjs status` —— 查询活动状态（唯一权威判定，以服务端下发的活动卡片为准）。退出码 `0` 表示存在可领取活动，取返回的 `recommendedPlanId`；退出码 `1` 表示无可领活动（分支看 `situation`），告知用户并结束；退出码 `4` 为查询失败，如实报告原因
   - 均无可领套餐 → 告知用户并结束
2. **无感验证码**：用浏览器自动化打开 `https://zcode.z.ai/cn`，把 [scripts/captcha-inject.js](scripts/captcha-inject.js) 的文件内容作为页面 JS 注入执行一次，之后每 1~2 秒读取 `window.__capResult`，累计不超过 40 秒：
   - `ok`（含 `param`）→ 把 `param` 原样写入系统临时目录固定文件 `cap-param.txt`（内容不包裹、不转义、不打印）
   - `slider` → 立即停止，告知用户在客户端内手动领取。不重试、不尝试通过滑块
   - `sdk_failed`（含 `reason`）→ 停止并报告 reason，不改用其他 CDN 或镜像
   - 40 秒未终态、变量不存在或读取报错 → 停止并报告，不重新注入
3. **提交领取**：`node <技能目录>/scripts/claim.mjs claim --plan <planId> --captcha-param-file <cap-param.txt>`
   - `success:true` → 领取成功，删除 `cap-param.txt`
   - `code:3007` → 回到第 2 步换新验证码参数重试一次；再失败即停
   - `code:1001~1005` → 终态（含已领取），视为完成，不重试
4. **复核**：`node <技能目录>/scripts/claim.mjs active` 确认 `status:"active"`，向用户报告套餐名、额度、适用模型与有效期。`active` 列表为空时以领取响应为准（套餐可能带未来生效时间）

## 脚本

`scripts/claim.mjs`（Node ≥ 18，无第三方依赖）：

```bash
node scripts/claim.mjs status    # 查询活动状态（唯一权威判定）；退出码 0=有可领活动, 1=无可领, 4=查询失败
node scripts/claim.mjs pending   # 读取本地待领记录（零网络）；分支看 recommendedPlanId
node scripts/claim.mjs active    # 查询已生效套餐（复核到账）
node scripts/claim.mjs configs   # 查询客户端配置（诊断用）
node scripts/claim.mjs claim --plan <planId> --captcha-param-file <验证码参数文件>   # 领取
```

- 凭证自动从 `~/.zcode/v2/credentials.json` 与同目录 `telemetry-state.json` 读取；明文 JWT 不打印、仅发送至 zcode.z.ai。
- 客户端版本号解析顺序：`ZCODE_APP_VERSION`（任意 `x.y[.z[.w]]` 格式）→ 动态读取已安装客户端 app.asar 内 package.json 的 `version`（如 `3.17.1`）→ 内置回退值。服务端按该版本值做定向过滤：`marketing/touch` 仅对客户端真实版本值下发活动卡片。详见 [references/CLAIM-LOGIC.md](references/CLAIM-LOGIC.md) §6.9~6.11。

## 失败处理原则

- 仅 `code:3007` 允许换新验证码参数重试一次；其余任何失败（脚本异常、网络错误、凭证解密失败、未知返回码等）立即终止本次执行
- 终止后不更换接口或参数、不推测新协议、不重跑、不探索替代路径
- 终止时报告失败步骤与原始错误信息（脚本输出 / 接口返回），并说明需人工核对协议是否变更

## 安全红线

- 不打印、不外传解密后的 JWT；除 zcode.z.ai 外不请求任何地址（验证码 SDK 的 o.alicdn.com 除外）
- 不绕过、不拖动、不破解任何形式的人机验证
- 不做高频重复调用：领取为一次性，重复检查可能触发风控
