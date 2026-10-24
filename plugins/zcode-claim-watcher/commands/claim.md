---
description: 检查并领取 ZCode 活动套餐
---

使用 zcode-plan-claim 技能执行"检查并领取 ZCode 活动套餐"。技能脚本位于技能 base directory 下的 `scripts/`。

1. 运行 `<技能目录>/scripts/claim.mjs status` 查询活动状态（只读）。
2. 按 `situation` 字段分支：
   - `claimable` → 取 `recommendedPlanId`，按技能"操作流程"第 2~4 步完成无感验证码、领取与 `current` 复核，报告套餐名/额度/适用模型/有效期。
   - `already_claimed_active` → 报告已领取套餐（名称/额度/适用模型/有效期）后结束。
   - `claimed_expired` 或 `none` → 报告"无可领活动"后结束。
3. 全程约束：不打印解密后的 JWT；除 zcode.z.ai 外不请求任何地址；验证码出现 slider 立即停止转人工；仅 3007 允许换新验证码参数重试一次；1001~1005 为终态不重试。
