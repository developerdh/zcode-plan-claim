// ZCode 凭证解密共享模块（notify.mjs / mcp.mjs 共用；技能脚本 claim.mjs 持有等价的独立实现）。
// 格式逆向自客户端 3.18.x app.asar 凭证模块：
//   enc:v1:<iv>.<tag>.<ct>（base64url）= AES-256-GCM，key = sha256(管理密文或 fallback 派生串)
//     （旧版格式，兼容保留——测试夹具与未升级环境仍可能使用）
//   enc:v2:<os|env>:<fp24>:<iv>.<tag>.<ct>（base64url）= AES-256-GCM（iv 12B / tag 16B / key 32B）
//     - fp = sha256(key) 的 hex 前 24 位，解密前自校验（密钥拿错不碰密文）
//     - os 来源：32 字节随机密钥存系统钥匙串（Windows 凭据管理器 / macOS 钥匙串 / Linux
//       Secret Service），service="ZCode Credential Encryption"、account=sha256(凭证文件
//       绝对路径) 的 hex。读取顺序：① 客户端自带 @napi-rs/keyring 平台原生包（napi ABI
//       稳定，Node ≥18 直接加载）按 account 精确读，失败则扫描该 service 全部条目按指纹
//       挑选（路径变更兜底）；② Windows 下 PowerShell CredRead 直读（TargetName=
//       <account>.<service>，blob 为 43 字符 base64url 密钥串的 UTF-16LE）
//     - env 来源：key = sha256(管理密文)；管理密文取 ZCODE_CREDENTIAL_SECRET >
//       ZCODE_CREDENTIAL_SECRET_FILE 文件 > <凭证目录>/credential-secret 兜底文件
//       （headless 场景客户端 os 回退创建密钥时写的就是该文件，32~4096 字节）
// 密钥与明文仅在本机内存使用：不打印、不外传（除 zcode.z.ai 的 API 调用外）。
import { createHash, createDecipheriv } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir, userInfo, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";

// 已安装客户端的 app.asar（v2 钥匙串密钥模块定位依赖；非默认安装路径用 ZCODE_CLIENT_ASAR 覆盖）
const CLIENT_ASAR_PATH =
  process.env.ZCODE_CLIENT_ASAR ?? "D:\\Program Files\\ZCode\\resources\\app.asar";
const CRED_V2_KEYRING_SERVICE = "ZCode Credential Encryption";
const CRED_V2_KEY_BYTES = 32;

// 与 readBotRuntime 的 dataDir 口径一致：ZCODE_DATA_BASE_DIR 表示 .zcode 的父目录
function defaultCredFile() {
  const base = process.env.ZCODE_DATA_BASE_DIR ?? homedir();
  return process.env.ZCODE_CREDENTIALS_FILE ?? join(base, ".zcode", "v2", "credentials.json");
}

function deriveLegacyKey() {
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

function decryptV1(enc) {
  const [ivB64, tagB64, ctB64] = enc.slice("enc:v1:".length).split(".");
  const d = createDecipheriv("aes-256-gcm", deriveLegacyKey(), Buffer.from(ivB64, "base64url"));
  d.setAuthTag(Buffer.from(tagB64, "base64url"));
  return Buffer.concat([d.update(Buffer.from(ctB64, "base64url")), d.final()]).toString("utf8");
}

function credV2Fingerprint(key) {
  return createHash("sha256").update(key).digest("hex").slice(0, 24);
}

// 客户端 app.asar.unpacked 自带的 @napi-rs/keyring 平台原生包；加载失败返回 null
function loadKeyringModule() {
  const triples =
    process.platform === "win32"
      ? [`${process.platform}-${process.arch}-msvc`]
      : process.platform === "darwin"
        ? [`${process.platform}-${process.arch}`]
        : process.platform === "linux"
          ? [`${process.platform}-${process.arch}-gnu`, `${process.platform}-${process.arch}-musl`]
          : [];
  const base = join(dirname(CLIENT_ASAR_PATH), "app.asar.unpacked", "node_modules");
  const req = createRequire(import.meta.url);
  for (const t of triples) {
    try {
      return req(join(base, "@napi-rs", `keyring-${t}`, `keyring.${t}.node`));
    } catch {}
  }
  return null;
}

// Windows 凭据管理器直读。脚本经 -EncodedCommand 传入规避引号转义；只回传密钥串
async function readOsKeyViaPowerShell(account) {
  const target = `${account}.${CRED_V2_KEYRING_SERVICE}`;
  const ps = [
    "$sig = @'",
    "using System;",
    "using System.Runtime.InteropServices;",
    "public class CredMan {",
    '  [DllImport("advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)]',
    "  static extern bool CredRead(string target, int type, int flags, out IntPtr credPtr);",
    '  [DllImport("advapi32.dll")]',
    "  static extern void CredFree(IntPtr cred);",
    "  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]",
    "  struct CREDENTIAL {",
    "    public int Flags; public int Type; public string TargetName; public string Comment;",
    "    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;",
    "    public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist;",
    "    public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;",
    "  }",
    "  public static byte[] ReadBlob(string target) {",
    "    IntPtr p = IntPtr.Zero;",
    "    try {",
    "      if (!CredRead(target, 1, 0, out p)) return null;",
    "      CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));",
    "      byte[] blob = new byte[c.CredentialBlobSize];",
    "      Marshal.Copy(c.CredentialBlob, blob, 0, blob.Length);",
    "      return blob;",
    "    } finally { if (p != IntPtr.Zero) CredFree(p); }",
    "  }",
    "}",
    "'@",
    "Add-Type -TypeDefinition $sig",
    `$b = [CredMan]::ReadBlob('${target}')`,
    "if ($b -eq $null) { exit 2 }",
    "[Console]::Out.Write([System.Text.Encoding]::Unicode.GetString($b))",
  ].join("\n");
  const { execFile } = await import("node:child_process");
  const stdout = await new Promise((res, rej) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(ps, "utf16le").toString("base64")],
      { timeout: 20000, windowsHide: true },
      (err, so, se) =>
        err ? rej(new Error(`${err.message}${se ? " | " + String(se).trim() : ""}`)) : res(String(so)),
    );
  });
  const key = Buffer.from(stdout.trim(), "base64url");
  if (key.length !== CRED_V2_KEY_BYTES) {
    throw new Error(`密钥长度异常（${key.length} 字节，期望 43 字符 base64url → 32 字节）`);
  }
  return key;
}

// v2 os 来源密钥：① 按 account 精确读 → ② 全条目按指纹扫描 → ③ Windows PowerShell 回退。
// 全部失败抛 Error（逐项原因，不打印密钥本身）
async function readV2OsKey(fp, credFile) {
  const account = createHash("sha256").update(resolve(credFile)).digest("hex");
  const reasons = [];
  const mod = loadKeyringModule();
  if (mod) {
    try {
      const pw = await new mod.AsyncEntry(CRED_V2_KEYRING_SERVICE, account).getPassword();
      const key = Buffer.from(String(pw ?? ""), "base64url");
      if (key.length === CRED_V2_KEY_BYTES && credV2Fingerprint(key) === fp) return key;
      reasons.push("钥匙串条目缺失或指纹不匹配（account=" + account.slice(0, 12) + "…）");
    } catch (e) {
      reasons.push(`AsyncEntry 读取失败: ${e.message}`);
    }
    try {
      const all = mod.findCredentials(CRED_V2_KEYRING_SERVICE) ?? [];
      for (const it of all) {
        const key = Buffer.from(String(it?.password ?? ""), "base64url");
        if (key.length === CRED_V2_KEY_BYTES && credV2Fingerprint(key) === fp) return key;
      }
      reasons.push(`钥匙串 ${CRED_V2_KEYRING_SERVICE} 下共 ${all.length} 条，无指纹匹配项`);
    } catch (e) {
      reasons.push(`findCredentials 扫描失败: ${e.message}`);
    }
  } else {
    reasons.push("客户端自带 @napi-rs/keyring 原生模块不可用");
  }
  if (process.platform === "win32") {
    try {
      const key = await readOsKeyViaPowerShell(account);
      if (credV2Fingerprint(key) === fp) return key;
      reasons.push("PowerShell 回退读到的密钥指纹不匹配");
    } catch (e) {
      reasons.push(`PowerShell CredRead 回退失败: ${e.message}`);
    }
  }
  throw new Error(`enc:v2:os 密钥读取失败：\n  - ${reasons.join("\n  - ")}`);
}

// v2 env 来源密钥：管理密文 → sha256。口径与客户端 resolveManagedSecret 对齐
async function readV2EnvKey(credFile) {
  const { ZCODE_CREDENTIAL_SECRET, ZCODE_CREDENTIAL_SECRET_FILE } = process.env;
  if (ZCODE_CREDENTIAL_SECRET && ZCODE_CREDENTIAL_SECRET_FILE) {
    throw new Error("ZCODE_CREDENTIAL_SECRET 与 ZCODE_CREDENTIAL_SECRET_FILE 同时配置（客户端视为不可用）");
  }
  let secret = null;
  if (ZCODE_CREDENTIAL_SECRET) secret = ZCODE_CREDENTIAL_SECRET;
  else if (ZCODE_CREDENTIAL_SECRET_FILE) secret = await readFile(ZCODE_CREDENTIAL_SECRET_FILE, "utf8");
  else {
    try {
      secret = await readFile(join(dirname(credFile), "credential-secret"), "utf8");
    } catch {}
  }
  const size = secret == null ? -1 : Buffer.byteLength(secret, "utf8");
  if (size < 32 || size > 4096) {
    throw new Error("未找到可用的管理密文（env 变量/文件均缺失或长度不在 32~4096 字节）");
  }
  return createHash("sha256").update(secret).digest();
}

async function decryptV2(enc, credFile) {
  const parts = enc.slice("enc:v2:".length).split(":");
  if (
    parts.length !== 3 ||
    !["os", "env"].includes(parts[0]) ||
    !/^[a-f0-9]{24}$/.test(parts[1]) ||
    !parts[2]
  ) {
    throw new Error("enc:v2 凭证格式异常（期望 enc:v2:<os|env>:<24位指纹>:<iv.tag.ct>，除指纹外均 base64url）");
  }
  const [source, fp, payload] = parts;
  const key = source === "os" ? await readV2OsKey(fp, credFile) : await readV2EnvKey(credFile);
  if (credV2Fingerprint(key) !== fp) {
    throw new Error("v2 密钥指纹不匹配（钥匙串/管理密文与该凭证不对应，可能更换过机器或凭证路径）");
  }
  const [ivB64, tagB64, ctB64] = payload.split(".");
  if (!ivB64 || !tagB64 || !ctB64) throw new Error("enc:v2 载荷异常（期望 iv.tag.ct 三段 base64url）");
  try {
    const d = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64url"));
    d.setAuthTag(Buffer.from(tagB64, "base64url"));
    return Buffer.concat([d.update(Buffer.from(ctB64, "base64url")), d.final()]).toString("utf8");
  } catch (e) {
    throw new Error(`enc:v2 AES-256-GCM 解密失败: ${e.message}`);
  }
}

// 解密 credentials.json 中任意条目值（zcodejwttoken / bot:*:credential 等，同文件同密钥）。
// 失败抛 Error（含逐项原因），由调用方决定如何呈现
export async function decryptZcodeCredentialValue(enc, { credFile } = {}) {
  if (typeof enc !== "string" || !enc) throw new Error("凭证条目为空");
  return enc.startsWith("enc:v2:")
    ? await decryptV2(enc, credFile ?? defaultCredFile())
    : enc.startsWith("enc:v1:")
      ? decryptV1(enc)
      : (() => {
          throw new Error(`凭证格式无法识别（非 enc:v1/enc:v2 前缀，前 8 字符：${enc.slice(0, 8)}），需人工核对协议变更`);
        })();
}

// 读取 zcodejwttoken 明文 JWT（mcp.mjs apiGet 用）
export async function loadZcodeJwt({ credFile } = {}) {
  const file = credFile ?? defaultCredFile();
  const creds = JSON.parse(await readFile(file, "utf8"));
  return await decryptZcodeCredentialValue(creds["zcodejwttoken"], { credFile: file });
}
