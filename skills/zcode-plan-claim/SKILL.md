---
name: zcode-plan-claim
description: 检查并领取 ZCode 活动卡片限时赠送的编程套餐额度（如限时 token 包/模型额度）。只要用户提到领取 ZCode 活动套餐、活动卡片赠送的 Token/额度，或想检查当前有没有可领活动、查询已生效套餐是否到账，都应使用本技能。核心链路：preview 查询可领套餐 → 浏览器环境完成阿里云无感验证码 → claim 提交 → current 复核。约束：仅限本人账号使用、验证码出现滑块必须停止、终态错误码不重试。不适用：购买付费套餐、管理订阅、API Key 直连配置。
---

# ZCode 活动套餐领取

按以下流程执行。需解读错误码或怀疑协议已随客户端升级变化时，查阅 [references/CLAIM-LOGIC.md](references/CLAIM-LOGIC.md)。

## 脚本

`scripts/claim.mjs`（Node ≥ 18，无第三方依赖）：

```bash
node scripts/claim.mjs preview    # 查询当前可领取套餐；退出码 2=有可领, 3=暂无可领
node scripts/claim.mjs current    # 查询已生效套餐（验证到账）
node scripts/claim.mjs configs    # 查询客户端配置（诊断用，见第 2 步）
node scripts/claim.mjs claim --plan <planId> --captcha-param-file <验证码参数文件>   # 领取
```

- 凭证自动从 `~/.zcode/v2/credentials.json` 与同目录 `telemetry-state.json` 读取；明文 JWT 不打印、仅发送至 zcode.z.ai。

## 操作流程

1. **检查是否有可领活动**（只读）：

   ```bash
   node scripts/claim.mjs preview
   ```

   - 退出码 3 或 `claimable:false` → 无可领活动，到此结束，不进入后续步骤。
   - 退出码 2 → 多个可领时取 `priority` 最大的（并列取第一个），本次只领取这一个。

2. **生成验证码参数**（仅有可领套餐时执行）：用浏览器自动化打开 `https://zcode.z.ai/cn`，把 [scripts/captcha-inject.js](scripts/captcha-inject.js) 的文件内容作为页面 JS 注入执行一次，之后每 1~2 秒读取 `window.__capResult`，累计不超过 40 秒，`status` 按以下处理：

   - `ok`（含 `param`）→ 把 `param` 原样写入系统临时目录固定文件 `cap-param.txt`（Windows 用 `$TEMP/cap-param.txt`）：内容不包裹、不转义、不打印，后续步骤与清理都用该路径。
   - `slider` → 立即停止，告知用户在客户端内手动领取。不重试、不尝试通过滑块。
   - `sdk_failed`（含 `reason`）→ 停止并报告 reason，不改用其他 CDN 或镜像。
   - 40 秒仍未终态、变量不存在或读取报错 → 停止并报告，不重新注入。

   claim 换新参数后仍 3007 时，可运行 `node scripts/claim.mjs configs` 核对场景参数；该接口实测可能返回 3001，失败即终止报告，不猜测请求参数。

3. **提交领取**：

   ```bash
   node scripts/claim.mjs claim --plan <planId> --captcha-param-file <第 2 步的 cap-param.txt>
   ```

   - `success:true` → 领取成功，删除 `cap-param.txt`。
   - `code:3007` → 回到第 2 步生成新参数重试一次；再失败即停。
   - `code:1001~1005` → 终态（含已领取），视为完成，不重试。

4. **复核**：`node scripts/claim.mjs current` 确认新套餐 `status:"active"`，报告套餐名、额度、有效期。

## 失败处理原则

- 仅 `code:3007` 允许换新验证码参数重试一次；其余任何失败（脚本异常、网络错误、凭证解密失败、未知返回码等）立即终止本次执行。
- 终止后不更换接口或参数、不推测新协议、不重跑、不探索替代路径。
- 终止时报告失败步骤与原始错误信息（脚本输出 / 接口返回），并说明需人工核对协议是否变更。

## 安全红线

- 不打印、不外传解密后的 JWT；除 zcode.z.ai 外不请求任何地址（验证码 SDK 的 o.alicdn.com 除外）。
- 不绕过、不拖动、不破解任何形式的人机验证。
- 不做高频重复调用：领取为一次性，重复检查没有收益且可能触发风控。
