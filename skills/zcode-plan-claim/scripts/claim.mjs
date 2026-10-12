#!/usr/bin/env node
// ZCode 活动套餐查询与领取 CLI（非官方，协议逆向自 ZCode Desktop 3.14.4 的
// marketing-touch / billing 接口链路，细节见 references/CLAIM-LOGIC.md）。
// 凭证仅在本机解密使用，除 zcode.z.ai 外不向任何第三方发送。
//
// 用法：
//   node claim.mjs preview                          查询当前可领取的活动套餐
//   node claim.mjs current                          查询账户已生效套餐
//   node claim.mjs status                           一站式状态：可领/已领生效/活动卡片/本地领取历史（区分"无活动"与"已领取过"）
//   node claim.mjs configs                          查询客户端配置（含验证码 SceneId/prefix）
//   node claim.mjs claim --plan <planId> --captcha-param-file <path>
//                                                   提交领取（验证码参数由浏览器步骤产出）
//
// 退出码：0 成功/已领取（status 成功恒为 0，分支看 situation 字段）；2 有可领套餐（preview）；
//         3 暂无可领套餐；4 失败（含验证码失败）

import { createHash, createDecipheriv } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { homedir, userInfo, platform } from "node:os";
import { join } from "node:path";

const BASE = process.env.ZCODE_API_BASE ?? "https://zcode.z.ai";
const APP_VERSION = process.env.ZCODE_APP_VERSION ?? "3.14.4";
const PLATFORM = process.env.ZCODE_PLATFORM ?? "windows";

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
// source: "claim"=确证已领取（来自 current 生效列表或领取成功响应）；"preview"=仅 sighting（可领但未确认领取）
function rememberPlan(state, plan, source) {
  const now = new Date().toISOString();
  const prev = state.plans[plan.planId] ?? {};
  state.plans[plan.planId] = {
    ...prev,
    ...plan,
    firstSeenAt: prev.firstSeenAt ?? now,
    lastSeenAt: now,
    claimedAt: source === "claim" ? (prev.claimedAt ?? now) : (prev.claimedAt ?? null),
    lastPreviewAt: source === "preview" ? now : (prev.lastPreviewAt ?? null),
  };
}

async function api(path, { method = "GET", body, captchaParam, extraHeaders } = {}) {
  const jwt = await loadJwt();
  const mid = await loadDeviceMid();
  const headers = {
    Authorization: `Bearer ${jwt}`,
    "X-Device-Mid": mid,
    "X-ZCode-App-Version": APP_VERSION,
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

function formatPreviewPlan(p) {
  return {
    planId: p.plan_id,
    name: p.name,
    description: p.description,
    priority: p.priority,
    entitlements: (p.entitlements ?? []).map((e) => ({
      model: e.show_name,
      grantUnits: e.grant_units,
      unitType: e.unit_type,
      period: e.period,
    })),
  };
}

async function cmdPreview() {
  const { status, json } = await api(
    `/api/v1/zcode-plan/billing/preview?app_version=${APP_VERSION}&platform=${PLATFORM}`,
  );
  if (json.code !== 0) fail(`preview 失败 HTTP ${status} code=${json.code} ${json.msg ?? ""}`);
  const plans = (json.data?.plans ?? []).map(formatPreviewPlan);
  console.log(JSON.stringify({ claimable: plans.length > 0, plans }, null, 2));
  process.exit(plans.length > 0 ? 2 : 3);
}

async function cmdCurrent() {
  const { status, json } = await api(`/api/v1/zcode-plan/billing/current`);
  if (json.code !== 0) fail(`current 失败 HTTP ${status} code=${json.code} ${json.msg ?? ""}`);
  console.log(
    JSON.stringify({ serverTime: json.data?.server_time, plans: (json.data?.plans ?? []).map(showPlan) }, null, 2),
  );
}

// 一站式状态查询（只读）：preview（未领可领）+ current（已领生效）+ marketing/touch（活动卡片），
// 并入本地状态文件后给出无歧义结论——preview 为空时能区分"无活动"与"已领取过"。
async function cmdStatus() {
  const state = await loadState();

  const pv = await api(`/api/v1/zcode-plan/billing/preview?app_version=${APP_VERSION}&platform=${PLATFORM}`);
  if (pv.json.code !== 0) fail(`status: preview 失败 HTTP ${pv.status} code=${pv.json.code} ${pv.json.msg ?? ""}`);
  const claimablePlans = (pv.json.data?.plans ?? []).map(formatPreviewPlan);

  const cu = await api(`/api/v1/zcode-plan/billing/current`);
  if (cu.json.code !== 0) fail(`status: current 失败 HTTP ${cu.status} code=${cu.json.code} ${cu.json.msg ?? ""}`);
  const activePlans = (cu.json.data?.plans ?? []).map(showPlan);

  // 活动卡片：当前下发的营销投放（仅参考，失败不影响结论）
  let campaigns = [];
  let campaignsError = "";
  {
    const mt = await api(`/api/v1/marketing/touch?seq=1`, { extraHeaders: { "X-Client-Language": "zh-CN" } });
    if (mt.json.code === 0) {
      campaigns = (mt.json.data?.deliveries ?? []).map((d) => ({
        campaignId: d.campaign_id,
        position: d.resource_position,
        priority: d.priority,
        buttons: (d.banner?.buttons ?? []).map((b) => ({
          text: b.text,
          actionType: b.action?.type,
          planId: b.action?.args?.plan_id,
        })),
      }));
    } else {
      campaignsError = `HTTP ${mt.status} code=${mt.json.code} ${mt.json.msg ?? ""}`;
    }
  }

  for (const p of activePlans) rememberPlan(state, p, "claim");
  for (const p of claimablePlans) rememberPlan(state, p, "preview");
  await saveState(state);

  const activeIds = new Set(activePlans.map((p) => p.planId));
  const claimHistory = Object.values(state.plans)
    .filter((p) => p.claimedAt)
    .sort((a, b) => (a.firstSeenAt < b.firstSeenAt ? 1 : -1))
    .map((p) => ({ ...p, currentlyActive: activeIds.has(p.planId) }));

  let recommendedPlanId = null;
  let situation;
  let summary;
  if (claimablePlans.length > 0) {
    const best = [...claimablePlans].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))[0];
    recommendedPlanId = best.planId;
    situation = "claimable";
    summary = `有 ${claimablePlans.length} 个可领套餐，推荐 ${best.planId}（${best.name}）`;
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
  if (situation !== "claimable" && campaigns.length > 0) {
    summary += `；有 ${campaigns.length} 张活动卡片在下发`;
  }

  console.log(
    JSON.stringify(
      {
        serverTime: cu.json.data?.server_time
          ? new Date(cu.json.data.server_time * 1000).toISOString()
          : undefined,
        situation,
        summary,
        recommendedPlanId,
        claimablePlans,
        activePlans,
        claimHistory,
        campaigns,
        ...(campaignsError ? { campaignsError } : {}),
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

// 验证码场景参数（SceneId/prefix）会随运营配置轮换，此命令用于人工诊断是否轮换。
// 注意：该接口的完整请求规格尚未捕获（客户端可能另有参数），实测 3.14.4 下
// 脚本请求会得到 3001，属已知坑位（见 references/CLAIM-LOGIC.md §6），正常
// 领取流程不依赖本命令，直接使用 SKILL.md 中的实测默认场景参数。
async function cmdConfigs() {
  const { status, json } = await api(
    `/api/v1/client/configs?app_version=${APP_VERSION}&platform=${PLATFORM}`,
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
if (cmd === "preview") await cmdPreview();
else if (cmd === "current") await cmdCurrent();
else if (cmd === "status") await cmdStatus();
else if (cmd === "configs") await cmdConfigs();
else if (cmd === "claim") await cmdClaim(rest);
else {
  console.log("用法: node claim.mjs <preview|current|status|configs|claim --plan <id> --captcha-param-file <path>>");
  process.exit(1);
}
