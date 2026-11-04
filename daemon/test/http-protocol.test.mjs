// MCP HTTP 协议集成测试：spawn 真实 daemon（cli.mjs serve --keep-alive；文件路径隔离到临时目录，
// ZCode API / iLink / 飞书均指向本地 mock），验证握手（含 SSE 帧与 protocolVersion 回显）、工具清单、
// check_now 全链路（发现→默认单渠道推送）、通知去重、notify_send 渠道选择、配置读写钳制、
// watcher_status 的 daemon 模式标记、敏感信息不出现在输出与日志、/health 与方法限制。
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

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.mjs");
// 独立测试端口（避开 49152+ 的 OS 临时端口段与真实 daemon 的 47823）
const PORT = 41000 + (process.pid % 2000);
const BASE_URL = `http://127.0.0.1:${PORT}`;

// ---------- mock：ZCode API（marketing/touch 返回活动卡片）+ iLink + 飞书 ----------
const CAMPAIGN_FIXTURE = {
  code: 0, msg: "",
  data: {
    server_time: 1792805009, language: "zh-CN",
    deliveries: [{
      campaign_id: "cmp-test", resource_position: "banner", priority: 50,
      banner: {
        buttons: [{
          text: { format: "", content: "" },
          action: { type: "claim_zcode_plan", args: { plan_id: "zcode-test-plan" } },
        }],
        background: { type: "bundle", args: { zcode_plan: {
          plan_id: "zcode-test-plan", name: "Test Plan", priority: 100,
          starts_at: 1792805009, ends_at: 1792891400,
          entitlements: [{ show_name: "GLM-5.3-Flash", grant_units: 300000000, unit_type: "token", period: "one_time" }],
        } } },
      },
    }],
  },
  logid: "mock-touch",
};
const zcodeMock = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  if (req.url.startsWith("/api/v1/marketing/touch")) return res.end(JSON.stringify(CAMPAIGN_FIXTURE));
  res.end(JSON.stringify({ code: 0, msg: "", data: {} }));
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

// ---------- 隔离环境 ----------
const home = mkdtempSync(join(tmpdir(), "claim-daemon-e2e-"));
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

// ---------- 启动 daemon ----------
const env = {
  ...process.env,
  USERPROFILE: home, HOME: home,
  ZCODE_DATA_BASE_DIR: home,
  ZCODE_API_BASE: `http://127.0.0.1:${zcodeMock.address().port}`,
  ZCODE_ILINK_BASE: `http://127.0.0.1:${ilinkMock.address().port}`,
  ZCODE_FEISHU_BASE: `http://127.0.0.1:${feishuMock.address().port}`,
  ZCODE_CREDENTIALS_FILE: join(v2, "credentials.json"),
  ZCODE_TELEMETRY_FILE: join(v2, "telemetry-state.json"),
  ZCODE_CLAIM_WATCHER_CONFIG: configFile,
  ZCODE_CLAIM_STATE_FILE: stateFile,
  // 三段式版本号 = 硬覆盖（与现行口径一致），跳过 app.asar 探测
  ZCODE_APP_VERSION: "3.17.1",
  // 注意：不得设置 ZCODE_CREDENTIAL_SECRET —— 凭证夹具用的是默认派生串
  CLAIM_WATCH_FIRST_DELAY_MS: "3600000", // 测试期间不让调度循环自动轮询，由 check_now 驱动
  ZCODE_DAEMON_PORT: String(PORT),
  ZCODE_DAEMON_PROCESS_RE: "", // 不做进程自退出检测相关的真实探测
};
const child = spawn(process.execPath, [CLI, "serve", "--keep-alive"], { env, stdio: ["ignore", "pipe", "pipe"] });
let stderrBuf = "";
child.stderr.on("data", (d) => (stderrBuf += d));

async function waitHealth(timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(500) });
      if (res.ok) return await res.json();
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`daemon 未在 ${timeoutMs}ms 内就绪\nstderr: ${stderrBuf.slice(-500)}`);
}

let nextId = 1;
async function mcp(method, params, { accept = "application/json" } = {}) {
  const res = await fetch(`${BASE_URL}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
    signal: AbortSignal.timeout(20000),
  });
  return { status: res.status, contentType: res.headers.get("content-type") ?? "", text: await res.text() };
}
function rpc(method, params, opts) {
  return mcp(method, params, opts).then(({ text }) => JSON.parse(text));
}
function parseContent(msg) {
  assert.equal(msg.error, undefined, `工具调用报错: ${JSON.stringify(msg.error)}`);
  return JSON.parse(msg.result.content[0].text);
}

test("启动并等待 /health 就绪", async () => {
  const health = await waitHealth();
  assert.equal(health.ok, true);
  assert.equal(health.pid, child.pid);
  assert.equal(health.roundCount, 0);
  assert.ok(health.version);
});

test("initialize 握手：serverInfo 与 protocolVersion 回显", async () => {
  const msg = await rpc("initialize", { protocolVersion: "2024-11-05" });
  assert.equal(msg.result.serverInfo.name, "zcode-claim-watcher");
  assert.equal(msg.result.protocolVersion, "2024-11-05");
  // stateless：可再次 initialize，其他版本值原样回显
  const again = await rpc("initialize", { protocolVersion: "2025-06-18" });
  assert.equal(again.result.protocolVersion, "2025-06-18");
});

test("无 id 通知回 202；tools/list 返回 5 个工具", async () => {
  const notif = await fetch(`${BASE_URL}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  assert.equal(notif.status, 202);
  assert.equal((await notif.text()), "");

  const toolsMsg = await rpc("tools/list", {});
  assert.deepEqual(toolsMsg.result.tools.map((t) => t.name).sort(), ["check_now", "notify_send", "watcher_config", "watcher_history", "watcher_status"]);
});

test("SSE 帧：Accept text/event-stream 返回单消息 event-stream 格式", async () => {
  const res = await mcp("tools/list", {}, { accept: "text/event-stream" });
  assert.equal(res.status, 200);
  assert.ok(res.contentType.includes("text/event-stream"));
  assert.ok(res.text.startsWith("event: message\ndata: "));
  assert.ok(res.text.endsWith("\n\n"));
  const payload = JSON.parse(res.text.slice("event: message\ndata: ".length, -2));
  assert.equal(payload.result.tools.length, 5);
});

test("check_now：发现可领套餐 → 默认单渠道推送（自动=首个绑定渠道）", async () => {
  const out = parseContent(await rpc("tools/call", { name: "check_now", arguments: {} }));
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

test("watcher_status：daemon 模式与计划状态", async () => {
  const out = parseContent(await rpc("tools/call", { name: "watcher_status", arguments: {} }));
  assert.equal(out.mode, "daemon");
  assert.equal(out.pid, child.pid);
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
  assert.deepEqual(saved.config.notify.failover, false);
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

test("方法与路径限制：GET /mcp 405、DELETE /mcp 204、未知路径 404、工具报错回 JSON-RPC error", async () => {
  const get = await fetch(`${BASE_URL}/mcp`);
  assert.equal(get.status, 405);

  const del = await fetch(`${BASE_URL}/mcp`, { method: "DELETE" });
  assert.equal(del.status, 204);

  const nf = await fetch(`${BASE_URL}/nope`);
  assert.equal(nf.status, 404);

  const bad = await rpc("tools/call", { name: "no_such_tool", arguments: {} });
  assert.equal(bad.error.code, -32000);
  assert.ok(bad.error.message.includes("未知工具"));
});

test("安全性：JWT / bot 令牌 / app secret 不出现在输出与日志", async () => {
  const status = parseContent(await rpc("tools/call", { name: "watcher_status", arguments: {} }));
  assert.doesNotMatch(JSON.stringify(status), /TEST-JWT|TEST-WX-TOKEN|TEST-FS-SECRET/);
  assert.doesNotMatch(stderrBuf, /TEST-JWT|TEST-WX-TOKEN|TEST-FS-SECRET/);
});

test.after(async () => {
  child.kill();
  await new Promise((r) => setTimeout(r, 200));
  rmSync(home, { recursive: true, force: true });
  zcodeMock.close();
  ilinkMock.close();
  feishuMock.close();
});
