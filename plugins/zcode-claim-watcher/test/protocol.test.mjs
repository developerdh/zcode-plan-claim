// MCP 协议集成测试：spawn 真实 server.mjs（文件路径隔离到临时目录，ZCode API / iLink / 飞书
// 均指向本地 mock），验证握手、工具清单、配置读写、check_now 全链路（发现→默认单渠道推送）、
// 通知去重、notify_send 渠道选择与配置驱动。
import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { createHash, createCipheriv, randomBytes } from "node:crypto";
import http from "node:http";
import os from "node:os";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "mcp", "server.mjs");

// ---------- mock：ZCode API（preview 返回可领套餐）+ iLink + 飞书 ----------
const PLAN_FIXTURE = {
  plan_id: "zcode-test-plan",
  name: "Test Plan",
  description: "测试活动",
  priority: 100,
  entitlements: [{ entitlement_id: "ent-1", show_name: "GLM-5.3-Flash", meter: "model_usage", unit_type: "token", grant_units: 300000000, period: "one_time" }],
};
const zcodeMock = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ code: 0, msg: "", data: { server_time: 1792805009, plans: [PLAN_FIXTURE] } }));
});
const ilinkPosts = [];
const ilinkMock = http.createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    ilinkPosts.push({ url: req.url, body: JSON.parse(body) });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ret: 0, errcode: 0 }));
  });
});
const feishuPosts = [];
const feishuMock = http.createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    feishuPosts.push({ url: req.url, body: body ? JSON.parse(body) : null });
    res.writeHead(200, { "Content-Type": "application/json" });
    if (req.url.includes("tenant_access_token")) res.end(JSON.stringify({ code: 0, tenant_access_token: "T-FS-TEST", expire: 7200 }));
    else res.end(JSON.stringify({ code: 0, data: { message_id: "om_test" } }));
  });
});
await new Promise((r) => zcodeMock.listen(0, "127.0.0.1", r));
await new Promise((r) => ilinkMock.listen(0, "127.0.0.1", r));
await new Promise((r) => feishuMock.listen(0, "127.0.0.1", r));
const zcodeBase = `http://127.0.0.1:${zcodeMock.address().port}`;
const ilinkBase = `http://127.0.0.1:${ilinkMock.address().port}`;
const feishuBase = `http://127.0.0.1:${feishuMock.address().port}`;

// ---------- 隔离环境 ----------
const home = mkdtempSync(join(tmpdir(), "claim-watcher-e2e-"));
const v2 = join(home, ".zcode", "v2");
const BOT_WX = "bot-wx-" + randomBytes(6).toString("hex");
const BOT_FS = "bot-fs-" + randomBytes(6).toString("hex");
const RECIPIENT = "o9cq80wxid0000chat";
const deriveKey = () =>
  createHash("sha256").update(`zcode-credential-fallback:${process.platform}:${home}:${os.userInfo().username}`).digest();
const encrypt = (plain) => {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", deriveKey(), iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return "enc:v1:" + iv.toString("base64url") + "." + c.getAuthTag().toString("base64url") + "." + ct.toString("base64url");
};
mkdirSync(v2, { recursive: true });
writeFileSync(join(v2, "telemetry-state.json"), JSON.stringify({ deviceMid: "00000000-0000-4000-8000-000000000000" }));
writeFileSync(join(v2, "credentials.json"), JSON.stringify({
  zcodejwttoken: encrypt("TEST-JWT"),
  [`bot:${BOT_WX}:credential`]: encrypt("TEST-WX-TOKEN"),
  [`bot:${BOT_FS}:credential`]: encrypt("TEST-FS-SECRET"),
}));
writeFileSync(join(v2, "bot-config.v3.json"), JSON.stringify({
  version: 3,
  bots: [
    { id: BOT_WX, provider: "weixin", enabled: true, credentialRef: `bot:${BOT_WX}:credential`, providerUserId: "botuid@im.bot" },
    { id: BOT_FS, provider: "feishu", enabled: true, credentialRef: `bot:${BOT_FS}:credential`, feishuAppId: "cli_test", providerUserId: "ou_test0000open" },
  ],
}));
writeFileSync(join(v2, "bot-state.v3.json"), JSON.stringify({
  version: 3,
  bots: { [BOT_WX]: { botId: BOT_WX, privateRecipientId: RECIPIENT } },
}));
const configFile = join(home, "watcher-config.json");
const stateFile = join(home, "state.json");

function cleanup() {
  rmSync(home, { recursive: true, force: true });
  zcodeMock.close();
  ilinkMock.close();
  feishuMock.close();
}
test.after(cleanup);

// ---------- 启动 server ----------
const env = {
  ...process.env,
  USERPROFILE: home, HOME: home,
  ZCODE_DATA_BASE_DIR: home,
  ZCODE_API_BASE: zcodeBase,
  ZCODE_ILINK_BASE: ilinkBase,
  ZCODE_FEISHU_BASE: feishuBase,
  ZCODE_CREDENTIALS_FILE: join(v2, "credentials.json"),
  ZCODE_TELEMETRY_FILE: join(v2, "telemetry-state.json"),
  ZCODE_CLAIM_WATCHER_CONFIG: configFile,
  ZCODE_CLAIM_STATE_FILE: stateFile,
  // 注意：不得设置 ZCODE_CREDENTIAL_SECRET —— 凭证夹具用的是默认派生串
  CLAIM_WATCH_FIRST_DELAY_MS: "3600000", // 测试期间不让调度循环自动轮询，由 check_now 驱动
};
const child = spawn(process.execPath, [SCRIPT], { env, stdio: ["pipe", "pipe", "pipe"] });
let stderrBuf = "";
child.stderr.on("data", (d) => (stderrBuf += d));

let buf = "";
let nextId = 1;
const pending = new Map();
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      const p = pending.get(msg.id);
      if (p) { pending.delete(msg.id); p(msg); }
    } catch { /* 忽略非 JSON 行 */ }
  }
});

function rpc(method, params, { timeoutMs = 15000 } = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`RPC 超时: ${method}\nstderr: ${stderrBuf.slice(-400)}`));
    }, timeoutMs);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}
function parseContent(msg) {
  assert.equal(msg.error, undefined, `工具调用报错: ${JSON.stringify(msg.error)}`);
  return JSON.parse(msg.result.content[0].text);
}

test("initialize 握手与工具清单", async () => {
  const msg = await rpc("initialize", { protocolVersion: "2024-11-05" });
  assert.equal(msg.result.serverInfo.name, "zcode-claim-watcher");
  assert.equal(msg.result.protocolVersion, "2024-11-05");
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const toolsMsg = await rpc("tools/list", {});
  assert.deepEqual(toolsMsg.result.tools.map((t) => t.name).sort(), ["check_now", "notify_send", "watcher_config", "watcher_history", "watcher_status"]);
});

test("check_now：发现可领套餐 → 默认单渠道推送（自动=首个绑定渠道）", async () => {
  const out = parseContent(await rpc("tools/call", { name: "check_now", arguments: {} }, { timeoutMs: 20000 }));
  assert.equal(out.outcome, "notified");
  assert.equal(out.planId, "zcode-test-plan");
  assert.deepEqual(out.notify, [{ channel: "bot(weixin)", ok: true }]);

  const wx = ilinkPosts.at(-1);
  assert.equal(wx.url, "/ilink/bot/sendmessage");
  assert.equal(wx.body.msg.to_user_id, RECIPIENT);
  assert.ok(wx.body.msg.item_list[0].text_item.text.includes("Test Plan"));
  assert.equal(feishuPosts.length, 0); // 缺省只发首个绑定渠道，不发飞书
});

test("check_now：同套餐去重，不再重复推送", async () => {
  const wxBefore = ilinkPosts.length, fsBefore = feishuPosts.filter((p) => p.url.includes("im/v1/messages")).length;
  const out = parseContent(await rpc("tools/call", { name: "check_now", arguments: {} }));
  assert.equal(out.outcome, "already_notified");
  assert.equal(ilinkPosts.length, wxBefore);
  assert.equal(feishuPosts.filter((p) => p.url.includes("im/v1/messages")).length, fsBefore);
});

test("notify_send：缺省=配置默认（自动单渠道）；可指定渠道或 all", async () => {
  const wxBefore = ilinkPosts.length;
  const fsBefore = feishuPosts.filter((p) => p.url.includes("im/v1/messages")).length;

  let out = parseContent(await rpc("tools/call", { name: "notify_send", arguments: { message: "✅ 领取成功：Test Plan" } }));
  assert.deepEqual(out.results, [{ channel: "bot(weixin)", ok: true }]);
  assert.equal(ilinkPosts.length, wxBefore + 1);
  assert.equal(feishuPosts.filter((p) => p.url.includes("im/v1/messages")).length, fsBefore);

  out = parseContent(await rpc("tools/call", { name: "notify_send", arguments: { message: "仅飞书", channel: "feishu" } }));
  assert.deepEqual(out.results, [{ channel: "bot(feishu)", ok: true }]);
  assert.equal(ilinkPosts.length, wxBefore + 1);
  assert.equal(feishuPosts.filter((p) => p.url.includes("im/v1/messages")).length, fsBefore + 1);

  out = parseContent(await rpc("tools/call", { name: "notify_send", arguments: { message: "全部渠道", channel: "all" } }));
  assert.deepEqual(out.results.map((r) => r.channel), ["bot(weixin)", "bot(feishu)"]);
  assert.ok(out.results.every((r) => r.ok));
  assert.equal(ilinkPosts.length, wxBefore + 2);
  assert.equal(feishuPosts.filter((p) => p.url.includes("im/v1/messages")).length, fsBefore + 2);
});

test("watcher_status：计划状态与历史标签", async () => {
  const out = parseContent(await rpc("tools/call", { name: "watcher_status", arguments: {} }));
  assert.equal(out.role, "watcher");
  assert.deepEqual(out.config.notify.events, ["discovered", "claimed", "failed"]);
  const p = out.plans.find((x) => x.planId === "zcode-test-plan");
  assert.equal(p.state, "仅发现"); // 未领取，无过期时间
  assert.ok(out.history.total >= 2);
});

test("watcher_config：钳制与持久化", async () => {
  const saved = parseContent(await rpc("tools/call", { name: "watcher_config", arguments: { config: { intervalMinutes: 2 } } }));
  assert.equal(saved.config.intervalMinutes, 5);
  assert.equal(JSON.parse(readFileSync(configFile, "utf8")).intervalMinutes, 5);
});

test("watcher_config：notify.channels 双渠道 → notify_send 缺省双发", async () => {
  const saved = parseContent(await rpc("tools/call", { name: "watcher_config", arguments: { config: { notify: { channels: ["weixin", "feishu"], failover: false } } } }));
  assert.deepEqual(saved.config.notify.channels, ["weixin", "feishu"]);
  assert.equal(saved.config.notify.failover, false);
  assert.equal(JSON.parse(readFileSync(configFile, "utf8")).notify.channels.length, 2);

  const out = parseContent(await rpc("tools/call", { name: "notify_send", arguments: { message: "双渠道缺省" } }));
  assert.deepEqual(out.results.map((r) => r.channel), ["bot(weixin)", "bot(feishu)"]);
  assert.ok(out.results.every((r) => r.ok));
});

test("watcher_history：按 outcome 过滤", async () => {
  const out = parseContent(await rpc("tools/call", { name: "watcher_history", arguments: { outcome: "notified" } }));
  assert.ok(out.matched >= 1);
  assert.ok(out.rounds.every((r) => r.outcome === "notified"));
});

test("安全性：JWT / bot 令牌 / app secret 不出现在输出与日志", async () => {
  const status = parseContent(await rpc("tools/call", { name: "watcher_status", arguments: {} }));
  assert.doesNotMatch(JSON.stringify(status), /TEST-JWT|TEST-WX-TOKEN|TEST-FS-SECRET/);
  assert.doesNotMatch(stderrBuf, /TEST-JWT|TEST-WX-TOKEN|TEST-FS-SECRET/);
});

test.after(() => {
  child.kill();
  rmSync(home, { recursive: true, force: true });
  zcodeMock.close();
  ilinkMock.close();
  feishuMock.close();
});
