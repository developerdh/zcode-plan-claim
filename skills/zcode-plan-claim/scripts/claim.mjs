#!/usr/bin/env node
// ZCode 活动套餐查询与领取 CLI（非官方，协议逆向自 ZCode Desktop 3.14.4 的
// marketing-touch / billing 接口链路，细节见 references/CLAIM-LOGIC.md）。
// 凭证仅在本机解密使用，除 zcode.z.ai 外不向任何第三方发送。
//
// 用法：
//   node claim.mjs status                           查询活动状态（唯一权威判定：marketing/touch 活动卡片）
//   node claim.mjs pending                          读取本地待领记录（零网络）
//   node claim.mjs active                           查询已生效套餐（领取后复核到账）
//   node claim.mjs configs                          查询客户端配置（含验证码 SceneId/prefix，诊断用）
//   node claim.mjs claim --plan <planId> --captcha-param-file <path>
//                                                   提交领取（验证码参数由浏览器步骤产出）
//
// status 退出码（谓词语义）：0=存在可领取活动（situation=campaign_claimable）；
//         1=查询成功但无可领活动（分支看 situation：already_claimed_active/claimed_expired/none）；
//         4=查询失败（活动卡片接口异常，无法给出结论）。JSON 全量输出，字段为机器判定的权威依据
// 其余命令退出码：0 成功/已领取（pending 恒 0，分支看字段）；4 失败（含验证码失败）
//
// 版本号：ZCODE_APP_VERSION（任意 x.y[.z[.w]]）> 动态读取已安装客户端 app.asar 内
//         package.json 的 version（如 3.17.1）> 内置回退值（告警）。
//         服务端按该版本值做定向过滤：marketing/touch 仅对客户端真实版本值下发活动卡片——
//         见 references/CLAIM-LOGIC.md §6.9/§6.10/§6.11

import { createHash, createDecipheriv } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { homedir, userInfo, platform } from "node:os";
import { join } from "node:path";

const BASE = process.env.ZCODE_API_BASE ?? "https://zcode.z.ai";
const PLATFORM = process.env.ZCODE_PLATFORM ?? "windows";

// ---------- 客户端版本号解析 ----------
// 服务端按"客户端声明的版本号"做定向过滤（口径以客户端 app.asar 内 package.json 的
// version 为准，三段式如 3.17.1；exe 的 ProductVersion 构建号在客户端任何请求中都不出现）：
//   - marketing/touch 仅对该版本值下发活动卡片，其他版本值返回空 deliveries 且无任何错误提示
//   - billing/claim 接受该版本值
//   - billing/preview 仅对部分版本值返回 data 信封，且卡片类活动套餐不出现在其 plans 中——
//     preview 空不能判定无可领，可领性以 marketing/touch 卡片为准
// 解析优先级：
//   1) ZCODE_APP_VERSION（任意合法 x.y[.z[.w]] 格式，测试/人工覆盖用）
//   2) 动态读取已安装 ZCode 客户端 app.asar 内 package.json 的 version
//   3) 内置回退值 + 告警
const FALLBACK_APP_VERSION = "3.17.1";
const VERSION_RE = /^\d+\.\d+(\.\d+){0,3}$/;

async function detectAsarPackageVersion() {
  const { open } = await import("node:fs/promises");
  let fh = null;
  try {
    fh = await open("D:\\Program Files\\ZCode\\resources\\app.asar", "r");
    // asar 头部：[u32 4][u32 pickleSize][u32 pickleSize][u32 jsonSize][json...]
    const headBuf = Buffer.alloc(16);
    await fh.read(headBuf, 0, 16, 0);
    const jsonSize = headBuf.readUInt32LE(12);
    const head = Buffer.alloc(jsonSize);
    await fh.read(head, 0, jsonSize, 16);
    const header = JSON.parse(head.toString("utf8"));
    const pkgNode = header.files?.["package.json"];
    if (!pkgNode) return null;
    const dataBase = 16 + jsonSize;
    const body = Buffer.alloc(pkgNode.size);
    await fh.read(body, 0, pkgNode.size, dataBase + Number(pkgNode.offset));
    const version = JSON.parse(body.toString("utf8")).version;
    return VERSION_RE.test(String(version).trim()) ? String(version).trim() : null;
  } catch {
    return null; // 探测失败不致命：回退内置值
  } finally {
    await fh?.close().catch(() => {});
  }
}

let appVersionPromise = null; // 同一进程只探测一次（status 会连发多个请求）
function resolveAppVersion() {
  if (!appVersionPromise) appVersionPromise = doResolveAppVersion();
  return appVersionPromise;
}
async function doResolveAppVersion() {
  const env = process.env.ZCODE_APP_VERSION?.trim();
  if (env && VERSION_RE.test(env)) return { version: env, source: "env" };
  if (process.platform === "win32") {
    const detected = await detectAsarPackageVersion();
    if (detected) return { version: detected, source: "detect" };
  }
  console.error(
    `[claim] 警告：未能动态获取客户端版本号，回退内置值 ${FALLBACK_APP_VERSION}（可用 ZCODE_APP_VERSION 指定）`,
  );
  return { version: FALLBACK_APP_VERSION, source: "fallback" };
}
async function getAppVersion() {
  return (await resolveAppVersion()).version;
}

function fail(msg, code = 4) {
  console.error("[claim] " + msg);
  process.exit(code);
}

// credentials.json 中 enc:v1:<iv>.<tag>.<ct>（base64url）为 AES-256-GCM，
// 密钥与应用一致的派生方式：sha256(ZCODE_CREDENTIAL_SECRET 或 fallback 字符串)
function credPath() {
  return (
    process.env.ZCODE_CREDENTIALS_FILE ?? join(homedir(), ".zcode", "v2", "credentials.json")
  );
}
function telemetryPath() {
  return (
    process.env.ZCODE_TELEMETRY_FILE ?? join(homedir(), ".zcode", "v2", "telemetry-state.json")
  );
}
async function loadJwt() {
  const credFile = credPath();
  const creds = JSON.parse(await readFile(credFile, "utf8"));
  const enc = creds["zcodejwttoken"];
  if (typeof enc !== "string" || !enc.startsWith("enc:v1:")) {
    fail(`credentials.json 格式变化，未找到 enc:v1 的 zcodejwttoken（ZCode 升级后需重新核对）`);
  }
  let secret;
  try {
    secret =
      process.env.ZCODE_CREDENTIAL_SECRET?.trim() ||
      `zcode-credential-fallback:${platform()}:${homedir()}:${userInfo().username}`;
  } catch {
    secret = `zcode-credential-fallback:${platform()}:${homedir()}:unknown`;
  }
  const key = createHash("sha256").update(secret).digest();
  const [ivB64, tagB64, ctB64] = enc.slice("enc:v1:".length).split(".");
  try {
    const d = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64url"));
    d.setAuthTag(Buffer.from(tagB64, "base64url"));
    return Buffer.concat([d.update(Buffer.from(ctB64, "base64url")), d.final()]).toString("utf8");
  } catch (e) {
    fail(`JWT 解密失败（密钥派生方式可能已变）: ${e.message}`);
  }
}

async function loadDeviceMid() {
  const state = JSON.parse(await readFile(telemetryPath(), "utf8"));
  if (!state.deviceMid) fail("telemetry-state.json 中无 deviceMid");
  return state.deviceMid;
}

// 本地状态文件：记录观测到/领取过的套餐元数据（不含任何凭证），用于跨次运行区分
// "无活动"与"已领取过"——preview 只列未领套餐，领取后返回空数组，单靠它无法区分两者
function statePath() {
  return (
    process.env.ZCODE_CLAIM_STATE_FILE ?? join(homedir(), ".zcode", "zcode-plan-claim-state.json")
  );
}
async function loadState() {
  try {
    const s = JSON.parse(await readFile(statePath(), "utf8"));
    if (s && typeof s === "object" && s.plans && typeof s.plans === "object") return s;
    console.error("[claim] 警告：状态文件格式异常，忽略并重建");
  } catch (e) {
    if (e.code !== "ENOENT") {
      console.error(`[claim] 警告：状态文件读取失败，忽略并重建: ${e.message}`);
    }
  }
  return { version: 1, plans: {} };
}
async function saveState(state) {
  try {
    await writeFile(statePath(), JSON.stringify(state, null, 2) + "\n");
  } catch (e) {
    console.error(`[claim] 警告：状态文件写入失败（领取历史不持久化）: ${e.message}`);
  }
}
// source: "claim"=确证已领取（来自 active 生效列表或领取成功响应）；
//        "campaign"=仅 sighting（卡片发现但未确认领取）
function rememberPlan(state, plan, source) {
  const now = new Date().toISOString();
  const prev = state.plans[plan.planId] ?? {};
  const clean = Object.fromEntries(Object.entries(plan).filter(([, v]) => v !== undefined));
  state.plans[plan.planId] = {
    ...prev,
    ...clean,
    firstSeenAt: prev.firstSeenAt ?? now,
    discoveredAt: prev.discoveredAt ?? now, // 首次 sighting 时间，pending 依赖此字段
    lastSeenAt: now,
    claimedAt: source === "claim" ? (prev.claimedAt ?? now) : (prev.claimedAt ?? null),
  };
}

// marketing/touch 卡片中的套餐 → 状态文件记录（元数据缺失时字段留空，由 rememberPlan 兜底）
function campaignPlanRecord(c) {
  const meta = c.meta;
  return {
    planId: c.planId,
    ...(meta?.name ? { name: meta.name } : {}),
    priority: c.priority,
    ...(meta?.ends_at ? { endsAt: new Date(meta.ends_at * 1000).toISOString() } : {}),
    ...((meta?.entitlements ?? []).length
      ? {
          entitlements: meta.entitlements.map((e) => ({
            model: e.show_name,
            grantUnits: e.grant_units,
            unitType: e.unit_type,
            period: e.period,
          })),
        }
      : {}),
  };
}

async function api(path, { method = "GET", body, captchaParam, extraHeaders } = {}) {
  const jwt = await loadJwt();
  const mid = await loadDeviceMid();
  const headers = {
    Authorization: `Bearer ${jwt}`,
    "X-Device-Mid": mid,
    "X-ZCode-App-Version": await getAppVersion(),
    "X-Platform": PLATFORM,
    ...extraHeaders,
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (captchaParam) {
    headers["X-Aliyun-Captcha-Verify-Param"] = captchaParam;
    headers["X-Aliyun-Captcha-Verify-Region"] = process.env.ZCODE_CAPTCHA_REGION ?? "cn";
  }
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    fail(`HTTP ${res.status} 非JSON响应: ${text.slice(0, 200)}`);
  }
  return { status: res.status, json };
}

function showPlan(p) {
  return {
    userPlanId: p.user_plan_id,
    planId: p.plan_id,
    name: p.name,
    status: p.status,
    startsAt: p.starts_at ? new Date(p.starts_at * 1000).toISOString() : undefined,
    endsAt: p.ends_at ? new Date(p.ends_at * 1000).toISOString() : undefined,
    entitlements: (p.entitlements ?? []).map((e) => ({
      model: e.show_name,
      grantUnits: e.grant_units,
      unitType: e.unit_type,
      period: e.period,
    })),
  };
}

// 查询已生效套餐（领取后复核到账）：无生效套餐时服务端可能整体省略 data 字段
async function cmdActive() {
  const { status, json } = await api(`/api/v1/zcode-plan/billing/current`);
  if (json.code !== 0) fail(`active 失败 HTTP ${status} code=${json.code} ${json.msg ?? ""}`);
  const plans = (json.data?.plans ?? []).map(showPlan);
  console.log(
    JSON.stringify(
      {
        serverTime: json.data?.server_time,
        plans,
        ...(!json.data ? { note: "当前无生效套餐（服务端省略 data 字段）" } : {}),
      },
      null,
      2,
    ),
  );
}

// 一站式活动状态查询（只读）：以 marketing/touch 活动卡片为唯一权威判定源
// （卡片活动不出现在 preview，生效前不出现在 current；见 references/CLAIM-LOGIC.md §6.11），
// current 生效列表与本地状态仅作辅助（已领取确证、生效展示）。
// 退出码（谓词语义）：0=存在可领取活动（situation=campaign_claimable）；
// 1=查询成功但无可领活动（already_claimed_active/claimed_expired/none）；4=活动卡片查询失败
async function cmdStatus() {
  const state = await loadState();

  // 权威判定源：活动卡片（失败即无法给出结论，退出码 4）
  let campaigns = [];
  let campaignClaimPlans = []; // 卡片中可发起领取的 {planId, campaignId, priority, meta}
  let serverTimeMs;
  {
    const mt = await api(`/api/v1/marketing/touch?seq=1`, { extraHeaders: { "X-Client-Language": "zh-CN" } });
    if (mt.json.code !== 0) {
      fail(`status: 活动卡片查询失败 HTTP ${mt.status} code=${mt.json.code} ${mt.json.msg ?? ""}`);
    }
    serverTimeMs = mt.json.data?.server_time;
    const deliveries = mt.json.data?.deliveries ?? [];
    campaigns = deliveries.map((d) => ({
      campaignId: d.campaign_id,
      position: d.resource_position,
      priority: d.priority,
      buttons: (d.banner?.buttons ?? []).map((b) => ({
        text: b.text,
        actionType: b.action?.type,
        planId: b.action?.args?.plan_id,
      })),
    }));
    for (const d of deliveries) {
      const meta =
        d.banner?.background?.args?.zcode_plan ?? d.banner?.hero?.args?.zcode_plan ?? null;
      for (const b of d.banner?.buttons ?? []) {
        if (b.action?.type === "claim_zcode_plan" && b.action?.args?.plan_id) {
          campaignClaimPlans.push({
            planId: b.action.args.plan_id,
            campaignId: d.campaign_id,
            priority: meta?.priority ?? d.priority ?? 0,
            meta,
          });
        }
      }
    }
  }
  // 同一 plan 出现在多张卡片时取 priority 最高；本地已确认领取过的卡片不再视为可领
  const campaignById = new Map();
  for (const c of campaignClaimPlans) {
    const prev = campaignById.get(c.planId);
    if (!prev || c.priority > prev.priority) campaignById.set(c.planId, c);
  }
  const unclaimedCampaignPlans = [...campaignById.values()].filter(
    (c) => !state.plans[c.planId]?.claimedAt,
  );

  // 辅助信息：已生效套餐（失败不阻断结论，降级为 activePlansError；
  // 无生效套餐时服务端整体省略 data 字段，属正常空态而非失败）
  let activePlans = [];
  let activePlansError = "";
  {
    const cu = await api(`/api/v1/zcode-plan/billing/current`);
    if (cu.json.code !== 0) {
      activePlansError = `HTTP ${cu.status} code=${cu.json.code} ${cu.json.msg ?? ""}`;
    } else if (cu.json.data && Array.isArray(cu.json.data.plans)) {
      activePlans = cu.json.data.plans.map(showPlan);
    }
  }

  for (const p of activePlans) rememberPlan(state, p, "claim");
  for (const c of campaignById.values()) rememberPlan(state, campaignPlanRecord(c), "campaign");
  await saveState(state);

  const activeIds = new Set(activePlans.map((p) => p.planId));
  const claimHistory = Object.values(state.plans)
    .filter((p) => p.claimedAt)
    .sort((a, b) => (a.firstSeenAt < b.firstSeenAt ? 1 : -1))
    .map((p) => ({ ...p, currentlyActive: activeIds.has(p.planId) }));

  let recommendedPlanId = null;
  let situation;
  let summary;
  if (unclaimedCampaignPlans.length > 0) {
    const best = [...unclaimedCampaignPlans].sort((a, b) => b.priority - a.priority)[0];
    recommendedPlanId = best.planId;
    situation = "campaign_claimable";
    summary = `服务端在下发可领取的活动卡片，推荐 ${best.planId}（${best.meta?.name ?? "未知名称"}）——与客户端"点卡片领取"同链路，可直接进入领取流程`;
  } else if (activePlans.length > 0) {
    situation = "already_claimed_active";
    summary = `无可领新活动；已领取套餐生效中：${activePlans.map((p) => p.name).join("、")}`;
  } else if (claimHistory.length > 0) {
    situation = "claimed_expired";
    summary = `无可领新活动；本地记录此前领取过 ${claimHistory.length} 个套餐，均已不在生效列表`;
  } else {
    situation = "none";
    summary = "当前无可领活动，本地也无领取记录";
  }
  if (situation !== "campaign_claimable" && campaigns.length > 0) {
    summary += `；有 ${campaigns.length} 张活动卡片在下发（均不可领取或已领取）`;
  }
  if (activePlansError) {
    summary += `；生效套餐查询失败：${activePlansError}`;
  }

  console.log(
    JSON.stringify(
      {
        serverTime: serverTimeMs ? new Date(serverTimeMs * 1000).toISOString() : undefined,
        situation,
        summary,
        recommendedPlanId,
        activePlans,
        claimHistory,
        campaigns,
        ...(activePlansError ? { activePlansError } : {}),
      },
      null,
      2,
    ),
  );
  process.exit(unclaimedCampaignPlans.length > 0 ? 0 : 1);
}

// 验证码场景参数（SceneId/prefix）会随运营配置轮换，此命令用于人工诊断是否轮换。
// 注意：该接口的完整请求规格尚未捕获（客户端可能另有参数），实测 3.14.4 下
// 脚本请求会得到 3001，属已知坑位（见 references/CLAIM-LOGIC.md §6），正常
// 领取流程不依赖本命令，直接使用 SKILL.md 中的实测默认场景参数。
// 读取本地待领记录（零网络）：列出状态文件中已发现未领取的活动
async function cmdPending() {
  const state = await loadState();
  const now = Date.now();
  const pending = Object.values(state.plans ?? {})
    .filter((p) => p && p.discoveredAt && !p.claimedAt && (!p.endsAt || Date.parse(p.endsAt) > now))
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  console.log(JSON.stringify({
    pending: pending.map((p) => ({ planId: p.planId, name: p.name ?? null, priority: p.priority ?? 0, discoveredAt: p.discoveredAt })),
    recommendedPlanId: pending[0]?.planId ?? null,
  }, null, 2));
}

async function cmdConfigs() {
  const appVersion = await getAppVersion();
  const { status, json } = await api(
    `/api/v1/client/configs?app_version=${appVersion}&platform=${PLATFORM}`,
    { extraHeaders: { "X-Client-Language": "zh-CN" } },
  );
  if (json.code !== 0) fail(`configs 失败 HTTP ${status} code=${json.code} ${json.msg ?? ""}`);
  console.log(JSON.stringify({ captcha: json.data?.configs?.captcha ?? null }, null, 2));
}

async function cmdClaim(args) {
  const planIdx = args.indexOf("--plan");
  const planId = planIdx >= 0 ? args[planIdx + 1] : null;
  const capIdx = args.indexOf("--captcha-param-file");
  const capFile = capIdx >= 0 ? args[capIdx + 1] : null;
  if (!planId) fail("缺少 --plan <planId>");
  if (!capFile) fail("缺少 --captcha-param-file <path>（由浏览器验证码步骤产出，一次性）");

  // 文件内容应为 captchaVerifyParam 原样（JSON 串）。若被包裹/多转义一层，发出去
  // 只会换回难以排查的 3007，且消耗唯一一次重试机会，故发请求前先本地校验。
  const captchaParam = (await readFile(capFile, "utf8")).trim();
  let parsed;
  try {
    parsed = JSON.parse(captchaParam);
  } catch {
    parsed = null;
  }
  if (!parsed || typeof parsed !== "object") {
    fail(
      `验证码参数文件内容不是预期的 captchaVerifyParam JSON 串（应把 param 原样写入，勿包裹/转义），前 80 字符: ${captchaParam.slice(0, 80)}`,
    );
  }

  const { status, json } = await api(`/api/v1/zcode-plan/billing/claim`, {
    method: "POST",
    body: { plan_id: planId },
    captchaParam,
  });
  const code = json.code;
  const out = {
    success: code === 0,
    httpStatus: status,
    code,
    msg: json.msg ?? "",
    message: json.data?.message ?? "",
    plan: json.data?.plan ? showPlan(json.data.plan) : null,
  };
  console.log(JSON.stringify(out, null, 2));
  if (code === 0) {
    // 领取成功即写入本地历史，之后即使套餐过期，status 也能报告"已领取过"
    if (json.data?.plan) {
      const st = await loadState();
      rememberPlan(st, showPlan(json.data.plan), "claim");
      await saveState(st);
    }
    process.exit(0);
  }
  // 3007=验证码失败（参数缺失/过期/已用，需取新参数重试一次）
  // 1001~1005=终态失败（如已领取），不要重试
  const terminal = [1001, 1002, 1003, 1004, 1005].includes(Number(code));
  process.exit(terminal ? 0 : 4);
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "status") await cmdStatus();
else if (cmd === "pending") await cmdPending();
else if (cmd === "active") await cmdActive();
else if (cmd === "configs") await cmdConfigs();
else if (cmd === "claim") await cmdClaim(rest);
else {
  console.log("用法: node claim.mjs <status|pending|active|configs|claim --plan <id> --captcha-param-file <path>>");
  process.exit(1);
}
