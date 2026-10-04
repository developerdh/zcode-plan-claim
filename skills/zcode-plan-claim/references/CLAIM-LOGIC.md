# ZCode 活动套餐领取协议

> 本文档整理自对 ZCode Desktop 3.14.4（2026-10）客户端行为的协议级分析，并经真实领取流程端到端验证。
> 接口与凭证格式均为客户端内部实现，**随时可能随客户端升级而变更**；活动为平台限时投放，是否可用以
> `preview` 接口实时返回为准，每个活动每账号一般限领一次。仅供个人账号自动化使用，请自行评估并遵守服务条款。

## 0. 总体时序

```
┌─────────────────────────────────────────────────────────────────────┐
│ 1. 客户端启动 → marketing-touch.query → 服务端下发 banner/popup 卡片  │
│ 2. 用户点卡片按钮 → action.type = claim_zcode_plan, args.plan_id     │
│ 3. 客户端取验证码配置(client/configs) → 初始化阿里云验证码(无感优先)   │
│ 4. 拿到 captchaVerifyParam → POST billing/claim 领取                 │
│ 5. 成功 → 刷新套餐余额 + 弹 success_popup（领取成功弹窗）             │
└─────────────────────────────────────────────────────────────────────┘
```

## 1. 基础地址与公共请求头

- **Base URL**: `https://zcode.z.ai`（注意：`open.bigmodel.cn` / `api.z.ai` 上没有这些路径，会 404）
- 公共请求头：

| Header | 值 | 说明 |
|---|---|---|
| `Authorization` | `Bearer <JWT>` | 见 §2，**必须用 `zcodejwttoken`**，不是 oauth access_token |
| `X-Device-Mid` | UUID v4 | 来自 telemetry-state.json |
| `X-ZCode-App-Version` | 客户端版本号，如 `3.14.4` | |
| `X-Platform` | `windows` | billing 系接口使用 |
| `X-Client-Language` | `zh-CN` | marketing 系接口使用 |

## 2. 凭证（关键，容易踩坑）

文件：`~/.zcode/v2/credentials.json`（Windows 即 `%USERPROFILE%\.zcode\v2\credentials.json`）

```json
{ "zcodejwttoken": "enc:v1:<iv>.<tag>.<ct>", ... }
```

- `enc:v1:` 后为三段 base64url，格式 `iv(12B) . authTag(16B) . ciphertext`，算法 **AES-256-GCM**
- 密钥派生：`sha256(secret)`，其中

  ```
  secret = 环境变量 ZCODE_CREDENTIAL_SECRET            （若设置）
         ≔ zcode-credential-fallback:{os.platform()}:{os.homedir()}:{username}   （否则）
  ```

  例：`zcode-credential-fallback:win32:C:\Users\<用户名>:<用户名>`
- ⚠️ 实测结论：**billing/claim 只认 `zcodejwttoken`**。用 `oauth:bigmodel:access_token`（同样可解密成功、同样是 JWT 格式）会得到 **401 空响应体**。两种 token 前缀都是 `eyJ`，注意区分。
- 设备标识：`~/.zcode/v2/telemetry-state.json` → `deviceMid`
- 安全约束：明文 JWT 只应在本机内存中出现，仅发送给 `zcode.z.ai`；日志与输出中不得打印

## 3. 接口清单

### 3.1 查询下发的活动卡片（可选，用于确认活动存在）
```
GET /api/v1/marketing/touch?seq=<递增整数>
→ { code:0, data:{ deliveries:[{ campaign_id, resource_position:"banner"|"popup", priority,
      banner:{ buttons:[{ text, action:{ type, args } }], success_popup:{...} } }] } }
```
- 按钮动作类型：`claim_zcode_plan`（args.plan_id）/ `open_url` / `navigate`（应用内页面跳转）/ `close` / `copy_text`
- `success_popup` 为活动方配置的"领取成功"弹窗内容
- 行为上报（非必须）：`POST /api/v1/marketing/touch/action`，body `{campaign_id, action_type:"confirm"|"cancel"}`

### 3.2 查询当前可领取套餐（推荐用这个判断"有没有活动"）
```
GET /api/v1/zcode-plan/billing/preview?app_version=<版本>&platform=windows
→ { code:0, data:{ plans:[{ plan_id, name, description, priority,
      entitlements:[{ entitlement_id, show_name, meter, unit_type, grant_units, period }] }] } }
```
- ⚠️ 只返回**当前账号尚未领取**的套餐；领过之后返回空数组（`plans:[]`），这不代表活动结束

### 3.3 查询已生效套餐（验证到账）
```
GET /api/v1/zcode-plan/billing/current
→ { code:0, data:{ plans:[{ user_plan_id, plan_id, name, status:"active", starts_at, ends_at, entitlements:[...] }] } }
```
- `ends_at` 为额度失效时间（限时活动通常为当日 24:00，本地时区）

### 3.4 验证码配置
```
GET /api/v1/client/configs
→ data.configs.captcha = { enabled:true, region:"cn", prefix:"no8xfe", sceneId:"11xygtvd", skip_model_request:true }
```
- ⚠️ 请求规格**尚未完全捕获**：上表响应来自真实会话观测，但脚本以 GET 重放（无论是否带
  `app_version`/`platform` 查询参数或 `X-Client-Language` 头）在 3.14.4 实测均返回 `3001 parameter error`
  （见 §6 坑位 7）。真实客户端可能另有未记录的参数。在捕获完整规格前，`claim.mjs configs` 仅作诊断用途，
  领取流程使用实测默认场景参数（SceneId `11xygtvd` / prefix `no8xfe`）

### 3.5 领取（核心写操作）
```
POST /api/v1/zcode-plan/billing/claim
Headers:
  Authorization: Bearer <zcodejwttoken>
  Content-Type: application/json
  X-Aliyun-Captcha-Verify-Param: <验证码参数，见 §4>     ← 必须
  X-Aliyun-Captcha-Verify-Region: cn                    ← 必须一并带上（漏掉会 3007）
  X-Device-Mid / X-ZCode-App-Version / X-Platform       ← 同公共头
Body: {"plan_id":"<planId>"}

成功 → { code:0, data:{ plan:{ user_plan_id, plan_id, status:"active", ... }, message:"Plan claimed successfully." } }
```

## 4. 验证码（阿里云 Captcha 2.0，每次领取都需要）

- SDK：`https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js`（需要浏览器 DOM 环境）
- 初始化（场景参数以 §3.4 服务端下发为准）：

```js
initAliyunCaptcha({
  SceneId: '<sceneId>', prefix: '<prefix>', mode: 'popup',
  element: '#cap-el', button: '#cap-btn', region: 'cn', language: 'cn',
  captchaVerifyCallback: async (captchaVerifyParam) => {
    // captchaVerifyParam 即所需参数（JSON 串，含 sceneId/certifyId/deviceToken 等，~1.6KB）
    return { captchaResult: true, bizResult: true };
  },
  getInstance: (inst) => { /* 保存实例，可 destroy 后重建 */ },
});
// 然后 document.getElementById('cap-btn').click() 触发
```

- **智能验证（无痕）**：低风险环境下点击按钮后 1~3 秒直接回调，无任何交互（在内嵌浏览器与 Playwright 可驱动的真实 Chromium 中实测通过）
- **滑块**：若风控判定需要人工验证，SDK 弹出滑块且不回调。**此时必须停止**——自动化不应、也无法绕过滑块；客户端把重复的 certifyId 视为 F008 风控告警
- 参数特性：**一次性、短时效**（约几分钟）、与触发时的浏览器环境绑定
- 执行方无需自行实现等待/判定：技能内 `scripts/captcha-inject.js` 封装了完整状态机（SDK 超时、触发节奏、回调等待、滑块判定），终态写入 `window.__capResult`；轮询读取该本地变量不产生网络请求，无风控代价

## 5. 响应码与处置

| code | 含义 | 处置 |
|---|---|---|
| 0 | 成功，`data.plan.status="active"` | 完成；可用 current 复核 |
| 3001 | 参数错误 | 检查 platform/app_version 等参数 |
| 3007 | 验证码校验失败 | 参数缺失/过期/已用；取**新**参数重试（最多一次） |
| 401 | 凭证不对/缺失 | 确认用的是 zcodejwttoken；检查解密是否成功 |
| 1001~1005 | 终态失败（含已领取等），响应可能带 `data.plan.ends_at` | **不再重试**，视为完成/放弃 |

## 6. 实测踩坑清单

以下差异均经真实请求验证（客户端 3.14.4）：

1. ❌ `oauth:bigmodel:access_token` → 401；✅ `zcodejwttoken` → 通过
2. ❌ 只带 `X-Aliyun-Captcha-Verify-Param` → 3007；✅ 再加 `X-Aliyun-Captcha-Verify-Region: cn` → 成功
3. ❌ `open.bigmodel.cn/api/v1/marketing/touch` → 404 NOT_FOUND；✅ `zcode.z.ai` → 200
4. ❌ preview 用 `platform=win32` → 3001 参数错误；✅ `platform=windows` → 200
5. preview 空列表 ≠ 活动结束，可能是**本账号已领过**
6. 验证码参数一次性：同一个 param 发两次 claim，第二次 3007
7. `client/configs` 以 GET 重放（含 `app_version`/`platform` 参数或 `X-Client-Language` 头的各种组合）均 3001；
   完整请求规格待新抓包确认，此前该接口只作诊断、不进主流程（2026-10-04 复测）

## 7. 调用语义与约束

- 每个活动每账号一般限领一次；`preview` 为空或 claim 返回 1001~1005 即为终态，不应继续
- 领取是**写操作**：应先 `preview` 确认有可领套餐，再走验证码 + claim；无套餐时不产生任何写请求
- 重试边界：仅 3007 允许换新验证码参数重试一次；其余失败应立即终止并如实暴露原始错误，调用方不应自行探索替代路径（协议可能已随客户端升级变化，排查属于人工维护）
- 避免高频重复调用；把验证码风控当作停止信号，而不是对抗目标

## 8. 脚本环境变量（仅测试与人工维护使用）

`scripts/claim.mjs` 支持以下覆盖，正常执行**不需要**设置任何一项：

| 环境变量 | 默认值 | 用途 |
|---|---|---|
| `ZCODE_API_BASE` | `https://zcode.z.ai` | 指向本地 mock（`tests/mock-claim-test.mjs` 即依赖此项） |
| `ZCODE_APP_VERSION` | `3.14.4` | 客户端版本号变化后核对 |
| `ZCODE_PLATFORM` | `windows` | 请求头 `X-Platform` |
| `ZCODE_CREDENTIALS_FILE` | `~/.zcode/v2/credentials.json` | 使用备用凭证文件 |
| `ZCODE_TELEMETRY_FILE` | `~/.zcode/v2/telemetry-state.json` | 使用备用设备标识文件 |
| `ZCODE_CREDENTIAL_SECRET` | fallback 派生串 | 凭证加密密钥的自定义来源（见 §2） |
| `ZCODE_CAPTCHA_REGION` | `cn` | 请求头 `X-Aliyun-Captcha-Verify-Region` |
