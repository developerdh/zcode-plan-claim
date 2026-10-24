import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import { tmpdir } from "node:os";
import http from "node:http";
import { join } from "node:path";
import { createHash, createCipheriv, randomBytes } from "node:crypto";
import { buildWeixinSendBody, readBotRuntime, sendBotNotification } from "../mcp/lib/notify.mjs";

const MSG = "🔔 发现可领活动：Test Plan（GLM-5.3-Flash 3亿 token）\nplan_id: p-123\n回复「领取活动套餐」即可领取。";

// 凭证夹具：与 notify.mjs 相同派生，加密存储（生产格式），运行时解密互为逆过程
const deriveKey = () =>
  createHash("sha256").update(`zcode-credential-fallback:${process.platform}:${os.homedir()}:${os.userInfo().username}`).digest();
const encrypt = (plain) => {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", deriveKey(), iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return "enc:v1:" + iv.toString("base64url") + "." + c.getAuthTag().toString("base64url") + "." + ct.toString("base64url");
};

const WEIXIN_BOT = { id: "bot-wx", provider: "weixin", enabled: true, credentialRef: "bot:bot-wx:credential", providerUserId: "botuid@im.bot" };
const FEISHU_BOT = { id: "bot-fs", provider: "feishu", enabled: true, credentialRef: "bot:bot-fs:credential", feishuAppId: "cli_test", providerUserId: "ou_test0000open" };
const RUNTIME = {
  botConfig: { bots: [WEIXIN_BOT, FEISHU_BOT] },
  botState: { bots: { "bot-wx": { privateRecipientId: "o9cq80wxid0000chat" } } },
  credentials: { "bot:bot-wx:credential": encrypt("TEST-WX-TOKEN"), "bot:bot-fs:credential": encrypt("TEST-FS-SECRET") },
};

test("buildWeixinSendBody：字段与桌面客户端同款，换行规范化", () => {
  const body = buildWeixinSendBody({ fromUserId: "botuid@im.bot", toUserId: "o9cq80wxid", text: "a\nb" });
  assert.equal(body.base_info.channel_version, "2.0.0");
  assert.equal(body.msg.from_user_id, "botuid@im.bot");
  assert.equal(body.msg.to_user_id, "o9cq80wxid");
  assert.equal(body.msg.message_type, 2);
  assert.equal(body.msg.item_list[0].text_item.text, "a\r\nb");
  assert.equal(body.msg.context_token, undefined);
});

test("分发：双渠道推送，微信走 iLink、飞书走开放平台（token 两段式）", async () => {
  const posts = [];
  const fetchImpl = async (url, opts) => {
    posts.push({ url, body: opts.body ? JSON.parse(opts.body) : null, auth: opts.headers.authorization ?? opts.headers.Authorization });
    if (url.includes("tenant_access_token")) return { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, tenant_access_token: "T-TOKEN", expire: 7200 }) };
    return { ok: true, status: 200, text: async () => url.includes("ilink") ? JSON.stringify({ ret: 0, errcode: 0 }) : JSON.stringify({ code: 0, data: { message_id: "om_x" } }) };
  };
  const results = await sendBotNotification({ message: MSG, runtime: RUNTIME, fetchImpl });
  assert.equal(results.length, 2);
  assert.deepEqual(results.map((r) => r.ok), [true, true]);

  const ilink = posts.find((p) => p.url.includes("ilinkai.weixin.qq.com"));
  assert.equal(ilink.url, "https://ilinkai.weixin.qq.com/ilink/bot/sendmessage");
  assert.equal(ilink.auth, "Bearer TEST-WX-TOKEN");
  assert.equal(ilink.body.msg.to_user_id, "o9cq80wxid0000chat");

  const tokenCall = posts.find((p) => p.url.includes("tenant_access_token"));
  assert.deepEqual(tokenCall.body, { app_id: "cli_test", app_secret: "TEST-FS-SECRET" });
  const imSend = posts.find((p) => p.url.includes("im/v1/messages"));
  assert.equal(imSend.url, "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id");
  assert.equal(imSend.auth, "Bearer T-TOKEN");
  assert.equal(imSend.body.receive_id, "ou_test0000open");
  assert.equal(imSend.body.msg_type, "text");
  assert.equal(JSON.parse(imSend.body.content).text, MSG);
});

test("分发：单通道失败不影响另一通道", async () => {
  const fetchImpl = async (url) => {
    if (url.includes("ilink")) return { ok: false, status: 500, text: async () => "boom" };
    if (url.includes("tenant_access_token")) return { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, tenant_access_token: "T" }) };
    return { ok: true, status: 200, text: async () => JSON.stringify({ code: 0 }) };
  };
  const results = await sendBotNotification({ message: MSG, runtime: RUNTIME, fetchImpl });
  assert.equal(results[0].ok, false);
  assert.match(results[0].error, /HTTP 500/);
  assert.equal(results[1].ok, true);
});

test("分发：未启用任何 bot → 跳过", async () => {
  const results = await sendBotNotification({ message: MSG, runtime: { botConfig: { bots: [] }, botState: { bots: {} }, credentials: {} }, fetchImpl: async () => { throw new Error("不应发起请求"); } });
  assert.equal(results[0].ok, false);
  assert.match(results[0].skipped, /未接入任何 bot 渠道/);
});

test("分发：未知渠道类型 → 明确跳过不猜测", async () => {
  const rt = { botConfig: { bots: [{ id: "bot-x", provider: "telegram", enabled: true }] }, botState: { bots: {} }, credentials: {} };
  const results = await sendBotNotification({ message: MSG, runtime: rt, fetchImpl: async () => { throw new Error("不应发起请求"); } });
  assert.match(results[0].skipped, /暂未支持/);
});

test("分发：微信会话未激活（无接收者标识）→ 跳过，飞书正常", async () => {
  const rt = {
    botConfig: { bots: [WEIXIN_BOT, FEISHU_BOT] },
    botState: { bots: {} }, // 微信无 privateRecipientId
    credentials: RUNTIME.credentials,
  };
  const fetchImpl = async (url) => {
    if (url.includes("tenant_access_token")) return { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, tenant_access_token: "T" }) };
    return { ok: true, status: 200, text: async () => JSON.stringify({ code: 0 }) };
  };
  const results = await sendBotNotification({ message: MSG, runtime: rt, fetchImpl });
  assert.match(results[0].skipped ?? results[0].error ?? "", /接收者标识|激活/);
  assert.equal(results[1].ok, true);
});

test("readBotRuntime：文件缺失回退默认结构", async () => {
  const root = mkdtempSync(join(tmpdir(), "claim-watcher-rt-"));
  try {
    const rt = await readBotRuntime({ configRoot: root });
    assert.deepEqual(rt.botConfig, { bots: [] });
    assert.deepEqual(rt.botState, { bots: {} });
    assert.deepEqual(rt.credentials, {});
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("readBotRuntime：正常读取", async () => {
  const root = mkdtempSync(join(tmpdir(), "claim-watcher-rt-"));
  const v2 = join(root, ".zcode", "v2");
  mkdirSync(v2, { recursive: true });
  writeFileSync(join(v2, "bot-config.v3.json"), JSON.stringify({ version: 3, bots: [WEIXIN_BOT] }));
  try {
    const rt = await readBotRuntime({ configRoot: root });
    assert.equal(rt.botConfig.bots.length, 1);
    assert.deepEqual(rt.credentials, {});
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("readBotRuntime：未传 configRoot 且未设置 ZCODE_DATA_BASE_DIR → 回退 homedir()（.zcode 父目录）", async () => {
  const home = mkdtempSync(join(tmpdir(), "claim-watcher-home-"));
  const v2 = join(home, ".zcode", "v2");
  mkdirSync(v2, { recursive: true });
  writeFileSync(join(v2, "bot-config.v3.json"), JSON.stringify({ version: 3, bots: [WEIXIN_BOT] }));
  writeFileSync(join(v2, "bot-state.v3.json"), JSON.stringify({ version: 3, bots: { "bot-wx": { privateRecipientId: "o9cq80wxid0000chat" } } }));
  const credValue = encrypt("TEST-WX-TOKEN");
  writeFileSync(join(v2, "credentials.json"), JSON.stringify({ "bot:bot-wx:credential": credValue }));
  // 回归覆盖：bug 根因是回退值误为 ~/.zcode，外层再拼 .zcode/v2 变成 ~/.zcode/.zcode/v2
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, ZCODE_DATA_BASE_DIR: process.env.ZCODE_DATA_BASE_DIR };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.ZCODE_DATA_BASE_DIR;
  try {
    const rt = await readBotRuntime();
    assert.equal(rt.v2Dir, join(home, ".zcode", "v2"));
    assert.deepEqual(rt.botConfig, { version: 3, bots: [WEIXIN_BOT] });
    assert.deepEqual(rt.botState.bots["bot-wx"], { privateRecipientId: "o9cq80wxid0000chat" });
    assert.equal(rt.credentials["bot:bot-wx:credential"], credValue);
  } finally {
    if (saved.HOME === undefined) delete process.env.HOME; else process.env.HOME = saved.HOME;
    if (saved.USERPROFILE === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = saved.USERPROFILE;
    if (saved.ZCODE_DATA_BASE_DIR === undefined) delete process.env.ZCODE_DATA_BASE_DIR; else process.env.ZCODE_DATA_BASE_DIR = saved.ZCODE_DATA_BASE_DIR;
    rmSync(home, { recursive: true, force: true });
  }
});

test("端到端：模拟另一台电脑（无 ZCODE_DATA_BASE_DIR、全新 home）→ 自动发现飞书 bot 并送达", async () => {
  const home = mkdtempSync(join(tmpdir(), "claim-watcher-user-"));
  // 先切到"另一台电脑"的家目录再加密凭证：与该机器上官方客户端的密钥派生保持一致
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, ZCODE_DATA_BASE_DIR: process.env.ZCODE_DATA_BASE_DIR, ZCODE_FEISHU_BASE: process.env.ZCODE_FEISHU_BASE, ZCODE_CREDENTIAL_SECRET: process.env.ZCODE_CREDENTIAL_SECRET };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.ZCODE_DATA_BASE_DIR;
  delete process.env.ZCODE_CREDENTIAL_SECRET;

  const v2 = join(home, ".zcode", "v2");
  mkdirSync(v2, { recursive: true });
  const feishuBot = { id: "bot-fs-remote", provider: "feishu", enabled: true, credentialRef: "bot:bot-fs-remote:credential", feishuAppId: "cli_remote", providerUserId: "ou_remoteUser0000" };
  writeFileSync(join(v2, "bot-config.v3.json"), JSON.stringify({ version: 3, bots: [feishuBot] }));
  writeFileSync(join(v2, "credentials.json"), JSON.stringify({ "bot:bot-fs-remote:credential": encrypt("REMOTE-SECRET") }));

  // 本地 mock 飞书开放平台：校验解密出的 app_secret 与 token 两段式
  const seen = {};
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen[req.url] = { auth: req.headers.authorization, body: body ? JSON.parse(body) : null };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(req.url.includes("tenant_access_token") ? { code: 0, tenant_access_token: "T-REMOTE" } : { code: 0, data: { message_id: "om_remote" } }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  process.env.ZCODE_FEISHU_BASE = `http://127.0.0.1:${server.address().port}`;
  try {
    // 不传 runtime/configRoot/fetchImpl：走 readBotRuntime() 回退发现 → 本机派生解密 → 真实 fetch 推送
    const results = await sendBotNotification({ message: MSG });
    assert.deepEqual(results, [{ channel: "bot(feishu)", ok: true }]);
    const tokenCall = seen["/open-apis/auth/v3/tenant_access_token/internal"];
    assert.deepEqual(tokenCall.body, { app_id: "cli_remote", app_secret: "REMOTE-SECRET" });
    const imSend = Object.entries(seen).find(([u]) => u.startsWith("/open-apis/im/v1/messages"))[1];
    assert.equal(imSend.auth, "Bearer T-REMOTE");
    assert.equal(imSend.body.receive_id, "ou_remoteUser0000");
    assert.equal(JSON.parse(imSend.body.content).text, MSG);
  } finally {
    if (saved.HOME === undefined) delete process.env.HOME; else process.env.HOME = saved.HOME;
    if (saved.USERPROFILE === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = saved.USERPROFILE;
    if (saved.ZCODE_DATA_BASE_DIR === undefined) delete process.env.ZCODE_DATA_BASE_DIR; else process.env.ZCODE_DATA_BASE_DIR = saved.ZCODE_DATA_BASE_DIR;
    if (saved.ZCODE_FEISHU_BASE === undefined) delete process.env.ZCODE_FEISHU_BASE; else process.env.ZCODE_FEISHU_BASE = saved.ZCODE_FEISHU_BASE;
    if (saved.ZCODE_CREDENTIAL_SECRET === undefined) delete process.env.ZCODE_CREDENTIAL_SECRET; else process.env.ZCODE_CREDENTIAL_SECRET = saved.ZCODE_CREDENTIAL_SECRET;
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    rmSync(home, { recursive: true, force: true });
  }
});
