// mock 验证：本地回放 2026-10-04 领取成功时 zcode.z.ai 的真实响应，
// 断言 claim.mjs 发出的请求与当时成功的请求规格一致，且各场景退出码正确。
// 全程只访问 127.0.0.1，不向 zcode.z.ai 发送任何请求。
//
// 运行：node mock-claim-test.mjs
import { createHash, createCipheriv, randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { homedir, userInfo, platform } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import http from "node:http";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "claim.mjs");

// ---------- 夹具：2026-10-04 真实会话中记录的服务端响应 ----------
const FIXTURES = {
  preview: {
    code: 0, msg: "",
    data: {
      server_time: 1791073839,
      plans: [{
        plan_id: "zcode-v3-start-plan-trust-1004", name: "ZCode Trust Build",
        description: "ZCode Global Build", priority: 110,
        entitlements: [{
          entitlement_id: "zcode-v3-start-plan-trust-1004", show_name: "GLM-5.3-Flash",
          meter: "model_usage", unit_type: "token", capabilities: ["model:glm-5.3-flash"],
          grant_units: 100000000, period: "one_time", priority: 110, effective_at: 0,
        }],
      }],
    },
    logid: "202610040030395d0c58bb395c8dc9b635",
  },
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

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    seen.push({ method: req.method, url: req.url, headers: req.headers, body });
    const send = (obj) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (req.url.startsWith("/api/v1/zcode-plan/billing/preview")) return send(FIXTURES.preview);
    if (req.url.startsWith("/api/v1/zcode-plan/billing/current")) return send(FIXTURES.current);
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
  ZCODE_CREDENTIALS_FILE: join(home, "credentials.json"),
  ZCODE_TELEMETRY_FILE: join(home, "telemetry-state.json"),
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

// 场景1：preview
console.log("[1] preview（可领套餐存在 → 退出码2）");
{
  const r = await run(["preview"]);
  check("退出码=2", r.code === 2, `got ${r.code} ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  check("识别出 trust-1004 可领取", out.claimable === true && out.plans[0]?.planId === "zcode-v3-start-plan-trust-1004");
  check("额度=100000000 token", out.plans[0]?.entitlements?.[0]?.grantUnits === 100000000);
}

// 场景2：configs（获取验证码场景参数）
console.log("[2] configs（获取验证码场景参数）");
{
  const r = await run(["configs"]);
  check("退出码=0", r.code === 0, `got ${r.code} ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  check("透出 captcha.sceneId/prefix", out.captcha?.sceneId === "11xygtvd" && out.captcha?.prefix === "no8xfe");
  const req = seen.find((s) => s.url.startsWith("/api/v1/client/configs"));
  check("请求路径 GET /api/v1/client/configs", !!req && req.method === "GET");
}

// 场景3：claim 成功（回放真实成功响应，断言请求与当时一致）
console.log("[3] claim 成功（对照 2026-10-04 成功请求规格）");
{
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
  check("X-ZCode-App-Version: 3.14.4", h["x-zcode-app-version"] === "3.14.4");
  check("X-Platform: windows", h["x-platform"] === "windows");
  check("body = {plan_id}", JSON.parse(req?.body ?? "{}").plan_id === "zcode-v3-start-plan-trust-1004");
}

// 场景4：验证码失败（3007 → 退出码4，表示需取新参数重试）
console.log("[4] claim 验证码失败 3007（→ 退出码4）");
{
  claimScenario = "claimCaptchaFail";
  const r = await run(["claim", "--plan", "mock-plan-x", "--captcha-param-file", captchaFile]);
  check("退出码=4", r.code === 4, `got ${r.code}`);
  const out = JSON.parse(r.stdout);
  check("success=false code=3007", out.success === false && out.code === 3007);
}

// 场景5：已领取终态（1001 → 退出码0，不应重试）
console.log("[5] claim 已领取终态 1001（→ 退出码0，不重试）");
{
  claimScenario = "claimAlreadyClaimed";
  const r = await run(["claim", "--plan", "mock-plan-x", "--captcha-param-file", captchaFile]);
  check("退出码=0（终态视为完成）", r.code === 0, `got ${r.code}`);
  const out = JSON.parse(r.stdout);
  check("code=1001 透出", out.code === 1001);
}

// 场景6：current
console.log("[6] current（查询已生效套餐）");
{
  const r = await run(["current"]);
  check("退出码=0", r.code === 0, `got ${r.code} ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  check("套餐 active 且额度 1 亿", out.plans?.[0]?.status === "active" && out.plans?.[0]?.entitlements?.[0]?.grantUnits === 100000000);
  check("不做任何写请求（仅 GET current）", seen.filter((s) => s.url.startsWith("/api/v1/zcode-plan/billing/current")).every((s) => s.method === "GET"));
}

// 安全性：脚本输出中不应出现明文 JWT
console.log("[7] 安全性");
{
  const cur = await run(["current"]);
  check("脚本 stdout 不含明文 JWT", !cur.stdout.includes(MOCK_JWT));
  check("脚本 stderr 不含明文 JWT", !cur.stderr.includes(MOCK_JWT));
  const claimRun = seen.find((s) => s.url.includes("claim"));
  check("JWT 仅出现在 Authorization 头（不散落在 body/url）", !!claimRun && !claimRun.body.includes(MOCK_JWT) && !claimRun.url.includes(MOCK_JWT));
}

// 场景8：param 文件内容非法 → 发请求前本地拦截
console.log("[8] claim 参数文件内容非法（本地拦截，不发请求）");
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

server.close();
rmSync(home, { recursive: true, force: true });
console.log(`\n结果: ${pass} 通过, ${failed} 失败`);
process.exit(failed ? 1 : 0);
