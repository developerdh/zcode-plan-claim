# ZCode 活动套餐领取协议

> ZCode Desktop marketing-touch / billing 接口链路的协议说明，基于客户端 3.14.4 与 3.17.1（构建 3.17.1.9553）验证。
> 接口与凭证格式均为客户端内部实现，随时可能随客户端升级而变更；活动为平台限时投放，可领性以
> `status` 命令判定（marketing/touch 活动卡片单源权威），每个活动每账号一般限领一次。
> 仅供个人账号自动化使用，请自行评估并遵守服务条款。

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

- **Base URL**: `https://zcode.z.ai`（`open.bigmodel.cn` / `api.z.ai` 上无这些路径，会 404）
- 公共请求头：

| Header | 值 | 说明 |
|---|---|---|
| `Authorization` | `Bearer <JWT>` | 见 §2，**必须用 `zcodejwttoken`**，不是 oauth access_token |
| `X-Device-Mid` | UUID v4 | 来自 telemetry-state.json |
| `X-ZCode-App-Version` | 客户端声明的版本号（app.asar 内 package.json 的 `version`，三段式如 `3.17.1`） | 营销投放按此值定向过滤（§6 条目 9/10）；exe 的 ProductVersion 构建号在客户端任何请求中都不出现 |
| `X-Platform` | `windows` | billing 系接口使用 |
| `X-Client-Language` | `zh-CN` | marketing 系接口使用 |

## 2. 凭证

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
- ⚠️ `billing/claim` 只认 `zcodejwttoken`。`oauth:bigmodel:access_token`（同样可解密成功、同样是 JWT 格式）
  会得到 401 空响应体。两种 token 前缀都是 `eyJ`，注意区分。
- 设备标识：`~/.zcode/v2/telemetry-state.json` → `deviceMid`
- 安全约束：明文 JWT 只应在本机内存中出现，仅发送给 `zcode.z.ai`；日志与输出中不得打印

## 3. 接口清单

### 3.1 查询下发的活动卡片

```
GET /api/v1/marketing/touch?seq=<递增整数>
→ { code:0, data:{ deliveries:[{ campaign_id, resource_position:"banner"|"popup", priority,
      banner:{ buttons:[{ text, action:{ type, args } }], success_popup:{...} } }] } }
```

- 按钮动作类型：`claim_zcode_plan`（args.plan_id）/ `open_url` / `navigate`（应用内页面跳转）/ `close` / `copy_text`
- `success_popup` 为活动方配置的"领取成功"弹窗内容
- 卡片 bundle 的 `args.zcode_plan`（`banner.background.args` / `banner.hero.args`）携带套餐元数据：
  `{ plan_id, name, priority, starts_at, ends_at, entitlements:[{ show_name, grant_units, unit_type, period, effective_at }] }`
- 账号领取套餐后，该账号的 `deliveries` 返回空数组（活动卡片不再下发）
- ⚠️ 有频控：短时间连续请求返回 429。单轮查询只发送一次，不得高频轮询
- ⚠️ **投放按 `X-ZCode-App-Version` 定向过滤**：仅客户端真实版本值（`3.17.1`）能收到 deliveries，
  其他版本值返回空数组且无任何错误提示（§6 条目 10）。查询必须使用客户端声明的版本号
- ⚠️ 活动可领时 `billing/preview` 仍可能返回空列表或缺 `data` 字段（§3.2、§6 条目 10/11）；
  `claim_zcode_plan` 按钮是客户端领取链路（§0）的入口，可领性判定以卡片为准
- 行为上报（非必须）：`POST /api/v1/marketing/touch/action`，body `{campaign_id, action_type:"confirm"|"cancel"}`

### 3.2 查询当前可领取套餐（**脚本已下线该查询**，本节保留为协议记录）

```
GET /api/v1/zcode-plan/billing/preview?app_version=<版本>&platform=windows
→ { code:0, data:{ plans:[{ plan_id, name, description, priority,
      entitlements:[{ entitlement_id, show_name, meter, unit_type, grant_units, period }] }] } }
```

- ⚠️ 只返回**当前账号尚未领取**的套餐；领过之后返回空数组（`plans:[]`），这不代表活动结束
- ⚠️ `data` 信封仅对部分版本值返回（如四段 `3.17.1.9553` 返回、三段 `3.17.1` 缺 data，见 §6 条目 10）——
  但卡片类活动套餐**不出现在 preview 的 plans 中**（仅经 marketing/touch 卡片下发），
  因此 preview 的 plans 空不能判定无可领。该接口对活动判定无价值，脚本已停止调用

### 3.3 查询已生效套餐（验证到账；对应命令 `claim.mjs active`）

```
GET /api/v1/zcode-plan/billing/current
→ { code:0, data:{ plans:[{ user_plan_id, plan_id, name, status:"active", starts_at, ends_at, entitlements:[...] }] } }
```

- `ends_at` 为额度失效时间（限时活动通常为当日 24:00，本地时区）
- 套餐 entitlement 可带未来 `effective_at`：领取成功但 `current` 在生效时刻前不显示（§6 条目 13）；
  无生效套餐时服务端可能整体省略 `data` 字段

### 3.4 验证码配置（仅诊断）

```
GET /api/v1/client/configs?app_version=<版本>&platform=windows
→ data.configs.captcha = { enabled:true, region:"cn", prefix:"no8xfe", sceneId:"11xygtvd", skip_model_request:true }
```

- 以 GET 重放该接口（含 `app_version`/`platform` 查询参数与 `X-Client-Language` 头的各种组合）均返回
  `3001 parameter error`，完整请求规格未捕获
- 该命令仅作诊断；领取流程使用固定场景参数：SceneId `11xygtvd` / prefix `no8xfe`（与 §4 一致）

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

### 3.6 本地状态与一站式 status（查询活动状态的唯一权威入口）

`node claim.mjs status` 以 marketing/touch 活动卡片为唯一权威判定源，current 生效列表与本地状态文件
`~/.zcode/zcode-plan-claim-state.json`（`ZCODE_CLAIM_STATE_FILE` 可覆盖；只存套餐元数据，不含任何凭证）
仅作辅助：

- current 出现过 / claim 成功响应中的套餐 → 记 `claimedAt`（确证"已领取"），过期后仍保留
- marketing/touch 卡片中的 `claim_zcode_plan` 套餐 → 记 sighting（`discoveredAt`，`pending` 依赖此字段）
- 输出 `situation` 字段：

| situation | 含义 | 处置 |
|---|---|---|
| `campaign_claimable` | 服务端在下发可领取的活动卡片（`recommendedPlanId` 为 priority 最大者）；与客户端"点卡片领取"同链路 | 进入领取流程 |
| `already_claimed_active` | 无未领卡片，但已领取套餐仍在生效 | 报告生效套餐详情，结束 |
| `claimed_expired` | 无未领卡片、无生效，但本地有领取记录 | 报告历史，结束 |
| `none` | 各源均无记录 | 报告无活动，结束 |

- 卡片接口失败（非 0 code / 网络）→ 无法给出结论，退出码 4；current 失败不阻断结论，降级为 `activePlansError` 字段
- 本地已确认领取过（`claimedAt` 存在）的卡片套餐不再判为 `campaign_claimable`
- 退出码（谓词语义）：0=存在可领取活动；1=查询成功但无可领活动；4=活动卡片查询失败
- 领取成功（claim code=0）也会把套餐写入状态文件，此后即使过期 status 仍能报告"领取过"

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

- **智能验证（无痕）**：低风险环境下点击按钮后 1~3 秒直接回调，无任何交互
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

## 6. 已知问题与处置

条目编号（§6.10 等）被 `claim.mjs` / `server.mjs` 注释引用，不可变更既有编号。

1. ❌ `oauth:bigmodel:access_token` 作为凭证 → 401；✅ `zcodejwttoken` → 通过
2. ❌ claim 只带 `X-Aliyun-Captcha-Verify-Param` → 3007；✅ 再加 `X-Aliyun-Captcha-Verify-Region: cn` → 成功
3. ❌ `open.bigmodel.cn/api/v1/marketing/touch` → 404 NOT_FOUND；✅ `zcode.z.ai` → 200
4. ❌ preview 用 `platform=win32` → 3001 参数错误；✅ `platform=windows` → 200
5. preview 空列表 ≠ 活动结束：可能是本账号已领取（条目 8）、版本口径问题（条目 10）或活动仅经卡片下发（条目 11）
6. 验证码参数一次性：同一个 param 发两次 claim，第二次 3007
7. `client/configs` 以 GET 重放（含 `app_version`/`platform` 参数或 `X-Client-Language` 头的各种组合）均 3001；
   完整请求规格未捕获，该接口只作诊断、不进主流程
8. 领取成功后 `preview` 返回空数组（只列未领套餐），**不能据此断言"无活动"**；用 `status` 结合
   current 与本地状态文件区分"无活动 / 已领取生效中 / 已领取已过期"
9. 客户端声明的版本号以 app.asar 内 package.json 的 `version` 为准（三段式，如 `3.17.1`）；全客户端
   （marketing/touch、billing/claim、preview 查询参数）都用它。exe 的 ProductVersion 构建号
   （如 `3.17.1.9553`）在客户端任何请求中都不出现，**不能**作为版本号来源
10. 接口按版本值做定向过滤，且静默无提示：`marketing/touch` 仅对客户端真实版本值下发活动卡片，
    其他版本值返回空 `deliveries`；`billing/preview` 则仅对部分版本值返回 `data` 信封
    （四段 `3.17.1.9553` 有信封、三段 `3.17.1` 缺 data）。两个口径不一致，且都会被误读为
    "无活动"——查询必须使用客户端声明的版本号（脚本动态读取 app.asar 包版本），缺 data 时显式报错
11. 可领性权威来源是 marketing/touch 卡片：卡片类活动套餐不出现在 preview 的 plans 中，
    preview 为空 ≠ 无活动。卡片按钮的 plan_id 可直接用于 claim；`status` 的 `campaign_claimable`
    判定由此而来
12. marketing/touch 有频控：短时间连续请求返回 429；单轮查询只发一次，勿高频轮询
13. entitlement 可带未来 `effective_at`：claim 成功（`data.plan.status="active"`）但 `current` 在生效时刻前
    不显示该套餐。复核 current 为空 ≠ 领取失败，以 claim 响应为准

## 7. 调用语义与约束

- 每个活动每账号一般限领一次；claim 返回 1001~1005 即为终态。注意 `preview` 为空只说明"没有未领的套餐"，
  可能是已领取、版本口径问题或卡片单源下发——以 `status`（活动卡片单源）的判定为准，
  不应盲目重跑或放弃报告
- 领取是**写操作**：应先 `status` 确认可领（退出码 0，即 `campaign_claimable` 的 `recommendedPlanId`），
  再走验证码 + claim；无可领依据时不产生任何写请求
- 重试边界：仅 3007 允许换新验证码参数重试一次；其余失败应立即终止并如实暴露原始错误，调用方不应自行探索替代路径（协议可能已随客户端升级变化，排查属于人工维护）
- 避免高频重复调用；把验证码风控当作停止信号，而不是对抗目标

## 8. 脚本环境变量（仅测试与人工维护使用）

`scripts/claim.mjs` 支持以下覆盖，正常执行**不需要**设置任何一项：

| 环境变量 | 默认值 | 用途 |
|---|---|---|
| `ZCODE_API_BASE` | `https://zcode.z.ai` | 指向本地 mock（`tests/mock-claim-test.mjs` 即依赖此项） |
| `ZCODE_APP_VERSION` | 动态解析 | 任意合法 `x.y[.z[.w]]` 格式硬覆盖（跳过探测，测试确定性用） |
| `ZCODE_PLATFORM` | `windows` | 请求头 `X-Platform` |
| `ZCODE_CREDENTIALS_FILE` | `~/.zcode/v2/credentials.json` | 使用备用凭证文件 |
| `ZCODE_TELEMETRY_FILE` | `~/.zcode/v2/telemetry-state.json` | 使用备用设备标识文件 |
| `ZCODE_CREDENTIAL_SECRET` | fallback 派生串 | 凭证加密密钥的自定义来源（见 §2） |
| `ZCODE_CAPTCHA_REGION` | `cn` | 请求头 `X-Aliyun-Captcha-Verify-Region` |

版本号动态解析（未设置 `ZCODE_APP_VERSION` 时）：win32 下读取已安装客户端
`resources\app.asar` 头部文件清单中 `package.json` 的 `version`（即客户端声明的三段式版本号）；
探测失败或非 Windows 回退内置值并告警。preview 缺 data 时显式报错并提示原因（条目 10）。
