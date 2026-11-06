// mock 验证：本地回放 ZCode 服务端真实响应形态，断言 claim.mjs 发出的请求规格正确，
// 且 status/claim 等各场景退出码与输出字段符合约定。全程只访问 127.0.0.1，不向 zcode.z.ai 发送任何请求。
//
// 运行：node mock-claim-test.mjs
import { createHash, createCipheriv, randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { homedir, userInfo, platform } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import http from "node:http";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "claim.mjs");

// ---------- 夹具：按真实服务端响应形态构造 ----------
const FIXTURES = {
  // marketing/touch 活动卡片：claim_zcode_plan 按钮 + zcode_plan 元数据
  marketingTouch: {
    code: 0, msg: "",
    data: {
      server_time: 1791073839, language: "zh-CN",
      deliveries: [{
        campaign_id: "cmp-weekend", resource_position: "popup", priority: 120,
        banner: {
          buttons: [{
            text: "领取",
            action: { type: "claim_zcode_plan", args: { plan_id: "zcode-v3-start-plan-trust-1004" } },
          }],
          background: { type: "bundle", args: { zcode_plan: {
            plan_id: "zcode-v3-start-plan-trust-1004", name: "ZCode Trust Build", priority: 111,
            // 相对时间戳：写死过去时间会被 pending 的过期过滤排除
            starts_at: Math.floor(Date.now() / 1000) - 3600, ends_at: Math.floor(Date.now() / 1000) + 86400,
            entitlements: [{ show_name: "GLM-5.3-Flash", grant_units: 100000000, unit_type: "token", period: "one_time" }],
          } } },
        },
      }],
    },
    logid: "mock-touch",
  },
  marketingTouchEmpty: {
    code: 0, msg: "",
    data: { server_time: 1791073839, language: "zh-CN", deliveries: [] },
    logid: "mock-touch-empty",
  },
  marketingTouchError: { code: 13, msg: "mock touch error", logid: "mock-touch-error" },
  claimSuccess: {
    code: 0, msg: "",
    data: {
      server_time: 1791074517,
      plan: {
        user_plan_id: "upl_2106545324661809152", plan_id: "zcode-v3-start-plan-trust-1004",
        name: "ZCode Trust Build", description: "ZCode Global Build", priority: 110,
        status: "active", starts_at: 1791074517, ends_at: 1791129600,
        entitlements: [{
          entitlement_id: "zcode-v3-start-plan-trust-1004", show_name: "GLM-5.3-Flash",
          meter: "model_usage", unit_type: "token", capabilities: ["model:glm-5.3-flash"],
          grant_units: 100000000, period: "one_time", priority: 110, effective_at: 0,
        }],
      },
      message: "Plan claimed successfully.",
    },
    logid: "20261004004157dd96ae056ed03f163999",
  },
  claimCaptchaFail: { code: 3007, msg: "captcha verify failed", logid: "mock-3007" },
  claimAlreadyClaimed: { code: 1001, msg: "already claimed", logid: "mock-1001" },
  configs: {
    code: 0, msg: "",
    data: {
      configs: {
        captcha: { enabled: true, region: "cn", prefix: "no8xfe", sceneId: "11xygtvd", skip_model_request: true },
      },
    },
    logid: "mock-configs",
  },
  current: {
    code: 0, msg: "",
    data: {
      server_time: 1791074553,
      plans: [{
        user_plan_id: "upl_2106545324661809152", plan_id: "zcode-v3-start-plan-trust-1004",
        name: "ZCode Trust Build", description: "ZCode Global Build", priority: 110,
        status: "active", starts_at: 1791074517, ends_at: 1791129600,
        entitlements: [{
          entitlement_id: "zcode-v3-start-plan-trust-1004", show_name: "GLM-5.3-Flash",
          meter: "model_usage", unit_type: "token", capabilities: ["model:glm-5.3-flash"],
          grant_units: 100000000, period: "one_time", priority: 110, effective_at: 0,
        }],
      }],
    },
    logid: "20261004004233a84e355b1d43897a906f",
  },
  // 无生效套餐：服务端整体省略 data 字段
  currentEmpty: {
    code: 0, msg: "",
    logid: "mock-current-empty",
  },
};

// ---------- 伪造本地凭证（加密方式与 claim.mjs 解密互为逆过程） ----------
const MOCK_JWT = "MOCK-JWT-" + randomBytes(12).toString("hex");
const MOCK_MID = "00000000-0000-4000-8000-000000000000";
let secret;
try {
  secret = `zcode-credential-fallback:${platform()}:${homedir()}:${userInfo().username}`;
} catch {
  secret = `zcode-credential-fallback:${platform()}:${homedir()}:unknown`;
}
const key = createHash("sha256").update(secret).digest();
const iv = randomBytes(12);
const c = createCipheriv("aes-256-gcm", key, iv);
const ct = Buffer.concat([c.update(MOCK_JWT, "utf8"), c.final()]);
const encValue =
  "enc:v1:" + iv.toString("base64url") + "." + c.getAuthTag().toString("base64url") + "." + ct.toString("base64url");

const home = mkdtempSync(join(tmpdir(), "zcode-claim-mock-"));
writeFileSync(join(home, "credentials.json"), JSON.stringify({ zcodejwttoken: encValue }));
writeFileSync(join(home, "telemetry-state.json"), JSON.stringify({ deviceMid: MOCK_MID }));

const CAPTCHA_PARAM = JSON.stringify({ sceneId: "11xygtvd", certifyId: "MOCKCERTIFY01", deviceToken: "mock" });
const captchaFile = join(home, "cap-param.txt");
writeFileSync(captchaFile, CAPTCHA_PARAM);

// ---------- mock 服务器：记录请求、按场景回放 ----------
const seen = [];
let claimScenario = "claimSuccess"; // claimSuccess | claimCaptchaFail | claimAlreadyClaimed
let currentScenario = "plans"; // plans | empty
let touchScenario = "card"; // card | empty | error

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    seen.push({ method: req.method, url: req.url, headers: req.headers, body });
    const send = (obj) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (req.url.startsWith("/api/v1/marketing/touch")) {
      if (touchScenario === "empty") return send(FIXTURES.marketingTouchEmpty);
      if (touchScenario === "error") return send(FIXTURES.marketingTouchError);
      return send(FIXTURES.marketingTouch);
    }
    if (req.url.startsWith("/api/v1/zcode-plan/billing/current")) {
      return send(currentScenario === "empty" ? FIXTURES.currentEmpty : FIXTURES.current);
    }
    if (req.url.startsWith("/api/v1/client/configs")) return send(FIXTURES.configs);
    if (req.url.startsWith("/api/v1/zcode-plan/billing/claim")) {
      if (claimScenario === "claimCaptchaFail") return send(FIXTURES.claimCaptchaFail);
      if (claimScenario === "claimAlreadyClaimed") return send(FIXTURES.claimAlreadyClaimed);
      return send(FIXTURES.claimSuccess);
    }
    res.writeHead(404); res.end("{}");
  });
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const env = {
  ...process.env,
  ZCODE_API_BASE: base,
  // 固定版本号：任意合法格式的 env 值都是硬覆盖（跳过动态探测，保证测试确定性）
  ZCODE_APP_VERSION: "3.14.4.0",
  ZCODE_CREDENTIALS_FILE: join(home, "credentials.json"),
  ZCODE_TELEMETRY_FILE: join(home, "telemetry-state.json"),
  ZCODE_CLAIM_STATE_FILE: join(home, "claim-state.json"),
};

function run(args) {
  // 注意必须用异步 spawn：spawnSync 会阻塞父进程事件循环，导致内置 mock 服务器无法应答（死锁）
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [SCRIPT, ...args], { env });
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    const killer = setTimeout(() => p.kill("SIGTERM"), 30000);
    p.on("error", (e) => {
      clearTimeout(killer);
      console.log(`  (诊断 spawn error: ${e.message})`);
      resolve({ code: -1, stdout, stderr });
    });
    p.on("close", (code) => {
      clearTimeout(killer);
      resolve({ code, stdout, stderr });
    });
  });
}

let pass = 0, failed = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? " — " + detail : ""}`); }
}

const stateFile = join(home, "claim-state.json");
const resetState = () => writeFileSync(stateFile, JSON.stringify({ version: 1, plans: {} }));

// 场景1：status —— 活动卡片可领（权威判定源）→ 退出码 0
console.log("[1] status（卡片可领 → 退出码0 + campaign_claimable）");
{
  touchScenario = "card";
  currentScenario = "empty";
  resetState();
  const r = await run(["status"]);
  check("退出码=0（存在可领取活动）", r.code === 0, `got ${r.code} ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  check("situation=campaign_claimable", out.situation === "campaign_claimable", out.situation);
  check("recommendedPlanId=trust-1004（来自卡片按钮）", out.recommendedPlanId === "zcode-v3-start-plan-trust-1004");
  check(
    "campaigns 透出卡片按钮 plan_id",
    out.campaigns?.[0]?.buttons?.[0]?.planId === "zcode-v3-start-plan-trust-1004",
  );
  const st = JSON.parse(readFileSync(stateFile, "utf8"));
  const rec = st.plans["zcode-v3-start-plan-trust-1004"];
  check("卡片 sighting 写入状态文件（discoveredAt，无 claimedAt）", !!rec?.discoveredAt && !rec?.claimedAt);
}

// 场景2：pending —— 卡片 sighting 进入本地待领记录（discoveredAt 修复的回归）
console.log("[2] pending（卡片 sighting → 待领记录可见）");
{
  const before = seen.length;
  const r = await run(["pending"]);
  check("退出码=0", r.code === 0, `got ${r.code} ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  check("pending 含 trust-1004", out.pending.some((p) => p.planId === "zcode-v3-start-plan-trust-1004"));
  check("recommendedPlanId=trust-1004", out.recommendedPlanId === "zcode-v3-start-plan-trust-1004");
  check("零网络（无新请求）", seen.length === before, `requests grew: ${seen.length - before}`);
}

// 场景3：status —— 卡片套餐已被领取过（本地 claimedAt）→ 不误报 campaign_claimable
console.log("[3] status（卡片套餐已领取过 → 退出码1 + claimed_expired）");
{
  touchScenario = "card";
  writeFileSync(stateFile, JSON.stringify({
    version: 1,
    plans: {
      "zcode-v3-start-plan-trust-1004": {
        planId: "zcode-v3-start-plan-trust-1004", name: "ZCode Trust Build",
        discoveredAt: "2026-11-04T00:00:00.000Z", claimedAt: "2026-11-04T01:00:00.000Z",
      },
    },
  }));
  const r = await run(["status"]);
  check("退出码=1（查询成功但无可领）", r.code === 1, `got ${r.code}`);
  const out = JSON.parse(r.stdout);
  check("situation=claimed_expired（而非 campaign_claimable）", out.situation === "claimed_expired", out.situation);
  check("无推荐套餐", out.recommendedPlanId === null);
}

// 场景4：status —— 卡片空队列 + 已领取套餐生效中
console.log("[4] status（卡片空 + 生效中 → 退出码1 + already_claimed_active）");
{
  touchScenario = "empty";
  currentScenario = "plans";
  resetState();
  const r = await run(["status"]);
  check("退出码=1", r.code === 1, `got ${r.code} ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  check("situation=already_claimed_active", out.situation === "already_claimed_active", out.situation);
  check(
    "activePlans 仍在且额度正确",
    out.activePlans?.length === 1 && out.activePlans[0].entitlements?.[0]?.grantUnits === 100000000,
  );
}

// 场景5：status —— 卡片空 + 无生效 + 本地有领取记录
console.log("[5] status（卡片空 + 无生效 + 有历史 → 退出码1 + claimed_expired）");
{
  currentScenario = "empty";
  const r = await run(["status"]);
  check("退出码=1", r.code === 1, `got ${r.code}`);
  const out = JSON.parse(r.stdout);
  check("situation=claimed_expired", out.situation === "claimed_expired", out.situation);
  check(
    "claimHistory 含 trust-1004 且 currentlyActive=false",
    out.claimHistory?.[0]?.planId === "zcode-v3-start-plan-trust-1004" &&
      out.claimHistory?.[0]?.currentlyActive === false,
  );
}

// 场景6：status —— 全部无记录
console.log("[6] status（无可领、无生效、无历史 → 退出码1 + none）");
{
  resetState();
  const r = await run(["status"]);
  check("退出码=1", r.code === 1, `got ${r.code}`);
  const out = JSON.parse(r.stdout);
  check("situation=none", out.situation === "none", out.situation);
}

// 场景7：status —— 活动卡片查询失败（无法给出结论）
console.log("[7] status（卡片接口返回非0 code → 退出码4）");
{
  touchScenario = "error";
  const r = await run(["status"]);
  check("退出码=4（查询失败）", r.code === 4, `got ${r.code}`);
  check("stderr 提示活动卡片查询失败", /活动卡片查询失败/.test(r.stderr), r.stderr.slice(0, 160));
}

// 场景8：configs（获取验证码场景参数，诊断用）
console.log("[8] configs（获取验证码场景参数）");
{
  const r = await run(["configs"]);
  check("退出码=0", r.code === 0, `got ${r.code} ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  check("透出 captcha.sceneId/prefix", out.captcha?.sceneId === "11xygtvd" && out.captcha?.prefix === "no8xfe");
  const req = seen.find((s) => s.url.startsWith("/api/v1/client/configs"));
  check("请求路径 GET /api/v1/client/configs", !!req && req.method === "GET");
}

// 场景9：claim 成功（对照真实成功请求规格）
console.log("[9] claim 成功（对照成功请求规格）");
{
  touchScenario = "card";
  claimScenario = "claimSuccess";
  const r = await run(["claim", "--plan", "zcode-v3-start-plan-trust-1004", "--captcha-param-file", captchaFile]);
  check("退出码=0", r.code === 0, `got ${r.code} ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  check("success=true 且 plan.status=active", out.success === true && out.plan?.status === "active");

  const req = seen.find((s) => s.url.startsWith("/api/v1/zcode-plan/billing/claim") && s.method === "POST");
  check("请求方法/路径 POST /api/v1/zcode-plan/billing/claim", !!req);
  const h = req?.headers ?? {};
  check("Authorization = Bearer <解密后的JWT>", h["authorization"] === "Bearer " + MOCK_JWT);
  check("Content-Type: application/json", (h["content-type"] ?? "").startsWith("application/json"));
  check("X-Aliyun-Captcha-Verify-Param 与文件内容一致", h["x-aliyun-captcha-verify-param"] === CAPTCHA_PARAM);
  check("X-Aliyun-Captcha-Verify-Region: cn", h["x-aliyun-captcha-verify-region"] === "cn");
  check("X-Device-Mid 一致", h["x-device-mid"] === MOCK_MID);
  check("X-ZCode-App-Version: 3.14.4.0（env 硬覆盖）", h["x-zcode-app-version"] === "3.14.4.0");
  check("X-Platform: windows", h["x-platform"] === "windows");
  check("body = {plan_id}", JSON.parse(req?.body ?? "{}").plan_id === "zcode-v3-start-plan-trust-1004");
  const st = JSON.parse(readFileSync(stateFile, "utf8"));
  check("领取成功写入状态文件（claimedAt）", !!st.plans["zcode-v3-start-plan-trust-1004"]?.claimedAt);
}

// 场景10：claim 验证码失败（3007 → 退出码4，表示需取新参数重试）
console.log("[10] claim 验证码失败 3007（→ 退出码4）");
{
  claimScenario = "claimCaptchaFail";
  const r = await run(["claim", "--plan", "mock-plan-x", "--captcha-param-file", captchaFile]);
  check("退出码=4", r.code === 4, `got ${r.code}`);
  const out = JSON.parse(r.stdout);
  check("success=false code=3007", out.success === false && out.code === 3007);
}

// 场景11：claim 已领取终态（1001 → 退出码0，不应重试）
console.log("[11] claim 已领取终态 1001（→ 退出码0，不重试）");
{
  claimScenario = "claimAlreadyClaimed";
  const r = await run(["claim", "--plan", "mock-plan-x", "--captcha-param-file", captchaFile]);
  check("退出码=0（终态视为完成）", r.code === 0, `got ${r.code}`);
  const out = JSON.parse(r.stdout);
  check("code=1001 透出", out.code === 1001);
}

// 场景12：active —— 查询已生效套餐
console.log("[12] active（查询已生效套餐）");
{
  claimScenario = "claimSuccess";
  currentScenario = "plans";
  const r = await run(["active"]);
  check("退出码=0", r.code === 0, `got ${r.code} ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  check("套餐 active 且额度 1 亿", out.plans?.[0]?.status === "active" && out.plans?.[0]?.entitlements?.[0]?.grantUnits === 100000000);
  check("不做任何写请求（仅 GET current）", seen.filter((s) => s.url.startsWith("/api/v1/zcode-plan/billing/current")).every((s) => s.method === "GET"));
}

// 场景13：安全性
console.log("[13] 安全性");
{
  const act = await run(["active"]);
  check("脚本 stdout 不含明文 JWT", !act.stdout.includes(MOCK_JWT));
  check("脚本 stderr 不含明文 JWT", !act.stderr.includes(MOCK_JWT));
  const claimRun = seen.find((s) => s.url.includes("claim"));
  check("JWT 仅出现在 Authorization 头（不散落在 body/url）", !!claimRun && !claimRun.body.includes(MOCK_JWT) && !claimRun.url.includes(MOCK_JWT));
}

// 场景14：claim 参数文件内容非法 → 发请求前本地拦截
console.log("[14] claim 参数文件内容非法（本地拦截，不发请求）");
{
  claimScenario = "claimSuccess";
  const before = seen.length;
  const badFile = join(home, "cap-param-bad.txt");
  writeFileSync(badFile, JSON.stringify(CAPTCHA_PARAM)); // 双重序列化：parse 后是字符串而非对象
  let r = await run(["claim", "--plan", "mock-plan-x", "--captcha-param-file", badFile]);
  check("双重序列化被拦截（退出码=4）", r.code === 4, `got ${r.code}`);
  check("报错提示应原样写入", /原样/.test(r.stderr), r.stderr.slice(0, 120));
  writeFileSync(badFile, "not-json-at-all");
  r = await run(["claim", "--plan", "mock-plan-x", "--captcha-param-file", badFile]);
  check("非 JSON 内容被拦截（退出码=4）", r.code === 4, `got ${r.code}`);
  check("两次均未发出任何请求", seen.length === before, `requests grew: ${seen.length - before}`);
}

// 场景15：pending —— 本地待领记录的排序与排除（零网络）
console.log("[15] pending（本地待领记录，优先级排序，排除已领取）");
{
  writeFileSync(stateFile, JSON.stringify({
    version: 1,
    plans: {
      "plan-low": { planId: "plan-low", name: "Low", discoveredAt: "2026-10-24T00:00:00.000Z", priority: 10 },
      "plan-high": { planId: "plan-high", name: "High", discoveredAt: "2026-10-24T00:00:00.000Z", priority: 90 },
      "plan-claimed": { planId: "plan-claimed", name: "Done", discoveredAt: "2026-10-24T00:00:00.000Z", claimedAt: "2026-10-24T01:00:00.000Z" },
    },
  }));
  const before = seen.length;
  const r = await run(["pending"]);
  check("退出码=0", r.code === 0, `got ${r.code} ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  check("仅含未领取的两条，按优先级排序", out.pending.length === 2 && out.pending[0].planId === "plan-high" && out.pending[1].planId === "plan-low");
  check("recommendedPlanId=plan-high", out.recommendedPlanId === "plan-high");
  check("已领取的 plan-claimed 被排除", !out.pending.some((p) => p.planId === "plan-claimed"));
  check("零网络（无新请求）", seen.length === before, `requests grew: ${seen.length - before}`);
}

// 场景16：未知命令 → 用法提示
console.log("[16] 未知命令（→ 退出码1 + stderr 用法提示）");
{
  const r = await run(["preview"]); // 已下线的旧命令
  check("退出码=1", r.code === 1, `got ${r.code}`);
  const helpPart = r.stderr.split("\n[claim]")[0]; // 帮助主体（剥离回显的"未知命令"行）
  check(
    "stderr 帮助列出全部现行命令且不含已下线命令",
    ["status", "pending", "active", "configs", "claim"].every((c) => helpPart.includes(c)) && !/preview|current/.test(helpPart),
    r.stderr.slice(0, 200),
  );
}

server.close();
rmSync(home, { recursive: true, force: true });
console.log(`\n结果: ${pass} 通过, ${failed} 失败`);
process.exit(failed ? 1 : 0);
