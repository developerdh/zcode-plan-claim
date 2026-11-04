// bot 渠道通知分发：把守望事件推送到用户通过官方绑定接入的机器人渠道。
//  - weixin：iLink 中继直发（逆向桌面客户端自带实现，已端到端实测；接收者取
//    bot-state.v3.json 的 privateRecipientId，官方绑定激活后自动写入）
//  - feishu：飞书开放平台标准 API（tenant_access_token + im/v1/messages，接收者
//    为绑定时的 open_id），字段读取带防御，未验证的渠道明确跳过不猜测
// 任何失败都不抛出——通知不影响轮询主流程。
import { randomInt, randomUUID, createHash, createDecipheriv } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir, userInfo, platform } from "node:os";
import { join } from "node:path";

const ILINK_PREFIX = "/ilink/bot";
const WEIXIN_CHANNEL_VERSION = "2.0.0";
const feishuBase = () => process.env.ZCODE_FEISHU_BASE ?? "https://open.feishu.cn";
const ilinkBase = () => process.env.ZCODE_ILINK_BASE ?? "https://ilinkai.weixin.qq.com";

const randUin = () => Buffer.from(String(randomInt(0, 4294967296)), "utf8").toString("base64");
const readStr = (o, k) => (o && typeof o === "object" && typeof o[k] === "string" ? o[k] : "");

// ZCODE_DATA_BASE_DIR 表示 .zcode 的父目录；未设置时回退 homedir()（与 credentials.mjs 约定一致），.zcode/v2 由 readBotRuntime 统一拼接
function dataDir() {
  return process.env.ZCODE_DATA_BASE_DIR ?? homedir();
}

function deriveKey() {
  let secret;
  try {
    secret =
      process.env.ZCODE_CREDENTIAL_SECRET?.trim() ||
      `zcode-credential-fallback:${platform()}:${homedir()}:${userInfo().username}`;
  } catch {
    secret = `zcode-credential-fallback:${platform()}:${homedir()}:unknown`;
  }
  return createHash("sha256").update(secret).digest();
}

function decryptEntry(enc) {
  if (typeof enc !== "string" || !enc.startsWith("enc:v1:")) throw new Error("凭证格式非 enc:v1");
  const [iv, tag, ct] = enc.slice("enc:v1:".length).split(".");
  const d = createDecipheriv("aes-256-gcm", deriveKey(), Buffer.from(iv, "base64url"));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8");
}

// 读取桌面 bot 运行时数据：{v2Dir, botConfig, botState, credentials}；缺失字段防御性回退
export async function readBotRuntime({ configRoot } = {}) {
  const v2Dir = join(configRoot ?? dataDir(), ".zcode", "v2");
  const read = async (f) => {
    try { return JSON.parse(await readFile(join(v2Dir, f), "utf8")); } catch { return null; }
  };
  const botConfig = (await read("bot-config.v3.json")) ?? { bots: [] };
  const botState = (await read("bot-state.v3.json")) ?? { bots: {} };
  const credentials = (await read("credentials.json")) ?? {};
  return { v2Dir, botConfig, botState, credentials };
}

function decryptCredential(credentials, ref) {
  if (!ref) throw new Error("凭证引用缺失");
  const token = decryptEntry(credentials[ref]).trim();
  if (!token) throw new Error("凭证解密结果为空");
  return token;
}

// ---------- 微信（iLink 中继） ----------
export function buildWeixinSendBody({ fromUserId, toUserId, text, clientId }) {
  return {
    base_info: { channel_version: WEIXIN_CHANNEL_VERSION },
    msg: {
      from_user_id: fromUserId,
      to_user_id: toUserId,
      client_id: clientId ?? `zcode-weixin-${randomUUID()}`,
      message_type: 2,
      message_state: 2,
      item_list: [{ type: 1, text_item: { text: String(text).replace(/\r\n|\r|\n/g, "\r\n") } }],
    },
  };
}

async function sendWeixinMessage({ bot, botState, credentials, text, fetchImpl, timeoutMs }) {
  const token = decryptCredential(credentials, bot.credentialRef);
  const toUserId = readStr(botState.bots?.[bot.id], "privateRecipientId");
  if (!toUserId) throw new Error("会话未激活（bot-state 无接收者标识），暂无法推送");
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${ilinkBase()}${ILINK_PREFIX}/sendmessage`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        AuthorizationType: "ilink_bot_token",
        Authorization: `Bearer ${token}`,
        "X-WECHAT-UIN": randUin(),
      },
      body: JSON.stringify(buildWeixinSendBody({ fromUserId: bot.providerUserId ?? "", toUserId, text })),
      signal: ac.signal,
    });
    const respText = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${respText.slice(0, 120)}`);
    const j = JSON.parse(respText);
    const ret = j.ret ?? 0, errcode = j.errcode ?? 0;
    if (ret !== 0 || errcode !== 0) throw new Error(`ret=${ret} errcode=${errcode} ${j.errmsg ?? j.message ?? ""}`);
  } finally { clearTimeout(timer); }
}

// ---------- 飞书（开放平台标准 API） ----------
function resolveFeishuReceiveIdType(id) {
  return id.startsWith("oc_") ? "chat_id" : "open_id";
}

async function fetchFeishuTenantToken({ baseUrl, appId, appSecret, fetchImpl, timeoutMs }) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      signal: ac.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 120)}`);
    const j = JSON.parse(text);
    if (j.code !== 0 || !j.tenant_access_token) throw new Error(j.msg ?? "tenant_access_token 获取失败");
    return j.tenant_access_token;
  } finally { clearTimeout(timer); }
}

async function sendFeishuMessage({ baseUrl, appId, appSecret, openId, text, fetchImpl, timeoutMs }) {
  const token = await fetchFeishuTenantToken({ baseUrl, appId, appSecret, fetchImpl, timeoutMs });
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${baseUrl}/open-apis/im/v1/messages?receive_id_type=open_id`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ receive_id: openId, msg_type: "text", content: JSON.stringify({ text }) }),
      signal: ac.signal,
    });
    const respText = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${respText.slice(0, 120)}`);
    const j = JSON.parse(respText);
    if (j.code !== 0) throw new Error(`code=${j.code} ${j.msg ?? ""}`);
  } finally { clearTimeout(timer); }
}

// ---------- 分发 ----------
// 渠道选择（channels）：
//  - "all"          → 全部启用渠道（绑定几个发几个）
//  - ["weixin",...] → 只发指定 provider（按给定顺序）；未绑定/未启用的明确报 skipped，不静默改道
//  - 空/缺省        → 自动：绑定列表里第一个启用的 bot 的渠道
// 失败转移（failover，默认 true）：目标渠道“发送报错”且无任何成功时，按绑定顺序补发
// 其余未尝试的渠道，成功一个即止，转移结果带 failover:true 明示；
// “未绑定/不支持”（skipped）属配置问题，只报错不转移。
// 返回各通道结果，任何失败都不抛出——通知不影响轮询主流程。
export async function sendBotNotification({ message, runtime, fetchImpl = fetch, timeoutMs = 15000, channels, failover = true } = {}) {
  const rt = runtime ?? (await readBotRuntime());
  const bots = Array.isArray(rt.botConfig?.bots) ? rt.botConfig.bots.filter((b) => b && b.enabled !== false) : [];
  if (!bots.length) return [{ channel: "bot", ok: false, skipped: "未接入任何 bot 渠道" }];

  const wanted =
    channels === "all"
      ? [...new Set(bots.map((b) => b.provider))]
      : Array.isArray(channels) && channels.length
        ? [...new Set(channels.map(String))]
        : [bots[0].provider];

  const deliver = async (bot) => {
    const channel = `bot(${bot.provider})`;
    try {
      if (bot.provider === "weixin") {
        await sendWeixinMessage({ bot, botState: rt.botState, credentials: rt.credentials, text: message, fetchImpl, timeoutMs });
        return { channel, ok: true };
      }
      if (bot.provider === "feishu") {
        const openId = bot.providerUserId ?? "";
        if (!openId.startsWith("ou_")) return { channel, ok: false, skipped: "接收者标识非 open_id，暂不支持推送" };
        const appSecret = decryptCredential(rt.credentials, bot.credentialRef);
        await sendFeishuMessage({ baseUrl: feishuBase(), appId: bot.feishuAppId, appSecret, openId, text: message, fetchImpl, timeoutMs });
        return { channel, ok: true };
      }
      return { channel, ok: false, skipped: `该渠道（${bot.provider}）的主动推送暂未支持` };
    } catch (e) {
      return { channel, ok: false, error: String(e?.message ?? e) };
    }
  };

  const results = [];
  const attempted = new Set();
  for (const provider of wanted) {
    const matched = bots.filter((b) => b.provider === provider && !attempted.has(b.id));
    if (!matched.length) {
      results.push({ channel: `bot(${provider})`, ok: false, skipped: `指定的渠道 ${provider} 未绑定或未启用（不自动改道）` });
      continue;
    }
    for (const bot of matched) {
      attempted.add(bot.id);
      results.push(await deliver(bot));
    }
  }

  if (failover !== false && !results.some((r) => r.ok) && results.some((r) => r.error)) {
    for (const bot of bots) {
      if (attempted.has(bot.id)) continue;
      attempted.add(bot.id);
      const r = await deliver(bot);
      results.push({ ...r, failover: true });
      if (r.ok) break;
    }
  }
  return results;
}
