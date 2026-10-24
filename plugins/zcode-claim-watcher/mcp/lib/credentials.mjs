// 凭证解密（与 ZCode 客户端一致的 AES-256-GCM 方案，claim.mjs 同款派生）
// 明文只在内存中出现，调用方不得打印
import { createHash, createDecipheriv } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir, platform, userInfo } from "node:os";
import { join } from "node:path";

function deriveKey() {
  let secret;
  try {
    secret = process.env.ZCODE_CREDENTIAL_SECRET?.trim() || `zcode-credential-fallback:${platform()}:${homedir()}:${userInfo().username}`;
  } catch {
    secret = `zcode-credential-fallback:${platform()}:${homedir()}:unknown`;
  }
  return createHash("sha256").update(secret).digest();
}

export function decryptEntry(enc) {
  if (typeof enc !== "string" || !enc.startsWith("enc:v1:")) throw new Error("凭证格式非 enc:v1");
  const [iv, tag, ct] = enc.slice("enc:v1:".length).split(".");
  const d = createDecipheriv("aes-256-gcm", deriveKey(), Buffer.from(iv, "base64url"));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8");
}

export function resolveDesktopCredentialsPath() {
  const base = process.env.ZCODE_DATA_BASE_DIR;
  return base ? join(base, ".zcode", "v2", "credentials.json") : join(homedir(), ".zcode", "v2", "credentials.json");
}

export async function loadJwt() {
  const file = process.env.ZCODE_CREDENTIALS_FILE ?? join(homedir(), ".zcode", "v2", "credentials.json");
  const creds = JSON.parse(await readFile(file, "utf8"));
  const plain = decryptEntry(creds["zcodejwttoken"]);
  if (!plain) throw new Error("zcodejwttoken 解密结果为空");
  return plain;
}

export async function loadMid() {
  const file = process.env.ZCODE_TELEMETRY_FILE ?? join(homedir(), ".zcode", "v2", "telemetry-state.json");
  const s = JSON.parse(await readFile(file, "utf8"));
  if (!s.deviceMid) throw new Error("telemetry-state.json 中无 deviceMid");
  return s.deviceMid;
}

// 读取 ZCode 已接入的 bot 渠道凭证（仅 web hook 型可用于出站）
// 返回 [{botId, provider, plain}]；无配置/读取失败 → []
export async function loadBotCredentials() {
  try {
    const cfg = JSON.parse(await readFile(resolveDesktopDataBotConfig(), "utf8"));
    const bots = Array.isArray(cfg?.bots) ? cfg.bots.filter((b) => b?.enabled !== false) : [];
    if (!bots.length) return [];
    const creds = JSON.parse(await readFile(resolveDesktopCredentialsPath(), "utf8"));
    const out = [];
    for (const b of bots) {
      if (!b?.credentialRef) continue;
      try {
        out.push({ botId: b.id, provider: b.provider, plain: decryptEntry(creds[b.credentialRef]) });
      } catch {
        // 单个 bot 凭证解密失败不阻塞其他
      }
    }
    return out;
  } catch {
    return [];
  }
}

function resolveDesktopDataBotConfig() {
  const base = process.env.ZCODE_DATA_BASE_DIR;
  return base ? join(base, ".zcode", "v2", "bot-config.v3.json") : join(homedir(), ".zcode", "v2", "bot-config.v3.json");
}
