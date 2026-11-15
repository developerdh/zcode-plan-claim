#!/usr/bin/env node
// ZCode 活动套餐查询与领取 CLI（非官方，协议逆向自 ZCode Desktop 3.14.4 的
// marketing-touch / billing 接口链路，细节见 references/CLAIM-LOGIC.md）。
// 凭证仅在本机解密使用，除 zcode.z.ai 外不向任何第三方发送。
// 凭证格式覆盖 enc:v1（旧版 fallback 派生密钥）与 enc:v2（3.18.x 起新版：
// os 来源=系统钥匙串随机密钥，env 来源=管理密文派生，详见下方凭证解密节）。
//
// 用法：
//   node claim.mjs status                           查询活动状态（唯一权威判定：marketing/touch 活动卡片）
//   node claim.mjs pending                          读取本地待领记录（零网络）
//   node claim.mjs active                           查询已生效套餐（领取后复核到账）
//   node claim.mjs configs                          查询客户端配置（含验证码 SceneId/prefix，诊断用）
//   node claim.mjs claim --plan <planId> --captcha-param-file <path>
//                                                   提交领取（验证码参数由浏览器步骤产出）
//   node claim.mjs -h|--help                        显示详细帮助（全局 bin 调用时前缀自适应为 zcode-claim）
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
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";

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
const FALLBACK_APP_VERSION = "3.18.2";
const VERSION_RE = /^\d+\.\d+(\.\d+){0,3}$/;
// 已安装客户端的 app.asar（版本探测与 v2 钥匙串密钥模块定位都依赖它；其他安装路径
// 可用 ZCODE_CLIENT_ASAR 覆盖）
const CLIENT_ASAR_PATH =
  process.env.ZCODE_CLIENT_ASAR ?? "D:\\Program Files\\ZCode\\resources\\app.asar";

// fs.read 对大缓冲区可能部分读取（Windows 实测），循环补齐；不完整视为失败
async function readFull(fh, buf, fileOffset = 0) {
  let done = 0;
  while (done < buf.length) {
    const { bytesRead } = await fh.read(buf, done, buf.length - done, fileOffset + done);
    if (!bytesRead) break;
    done += bytesRead;
  }
  if (done < buf.length) throw new Error(`读取不完整（${done}/${buf.length} 字节）`);
}

// 根 package.json 提取 version。部分客户端构建的 asar 根 package.json 少了收尾 '}'
// （size 记录差一字节，3.18.2 实测），JSON.parse 必失败，正则兜底
function parsePkgVersion(text) {
  let version;
  try {
    version = JSON.parse(text).version;
  } catch {
    version = text.match(/"version"\s*:\s*"([^"]+)"/)?.[1];
  }
  version = String(version ?? "").trim();
  return VERSION_RE.test(version) ? version : null;
}

async function detectAsarPackageVersion() {
  const { open } = await import("node:fs/promises");
  let fh = null;
  try {
    fh = await open(CLIENT_ASAR_PATH, "r");
    // asar 头部：[u32 4][u32 pickleSize][u32 pickleSize][u32 jsonSize][json...]
    const headBuf = Buffer.alloc(16);
    await readFull(fh, headBuf, 0);
    const jsonSize = headBuf.readUInt32LE(12);
    const head = Buffer.alloc(jsonSize);
    await readFull(fh, head, 16);
    const header = JSON.parse(head.toString("utf8"));
    const pkgNode = header.files?.["package.json"];
    if (!pkgNode) return null;
    const dataBase = 16 + jsonSize;
    const body = Buffer.alloc(pkgNode.size);
    await readFull(fh, body, dataBase + Number(pkgNode.offset));
    return parsePkgVersion(body.toString("utf8"));
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

// ---------- 凭证解密（enc:v1 / enc:v2，v2 逆向自客户端 3.18.x app.asar 凭证模块） ----------
// enc:v1:<iv>.<tag>.<ct>（base64url）为 AES-256-GCM，
// 密钥与应用一致的派生方式：sha256(ZCODE_CREDENTIAL_SECRET 或 fallback 字符串)
//
// enc:v2:<source>:<fp>:<iv>.<tag>.<ct>（base64url）同为 AES-256-GCM（iv 12B / tag 16B / key 32B）：
//   - fp = sha256(key) 的 hex 前 24 位，解密前自校验（密钥拿错不碰密文）
//   - source=os：32 字节随机密钥存系统钥匙串（Windows 凭据管理器 / macOS 钥匙串 /
//     Linux Secret Service），service="ZCode Credential Encryption"、
//     account=sha256(凭证文件绝对路径) 的 hex。读取优先级：
//     ① 客户端自带 @napi-rs/keyring 平台原生包（napi ABI 稳定，Node ≥18 直接加载）
//     ② 按 account 精确读 → 失败则扫描该 service 全部条目按指纹挑选（路径变更兜底）
//     ③ Windows 下 PowerShell CredRead 直读（blob 为密钥串的 UTF-16LE）
//   - source=env：key = sha256(管理密文)；管理密文取 ZCODE_CREDENTIAL_SECRET >
//     ZCODE_CREDENTIAL_SECRET_FILE 文件 > <凭证目录>/credential-secret 兜底文件
//     （headless 场景客户端 os 回退创建密钥时写的就是该文件，32~4096 字节）
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
  try {
    const d = createDecipheriv("aes-256-gcm", deriveLegacyKey(), Buffer.from(ivB64, "base64url"));
    d.setAuthTag(Buffer.from(tagB64, "base64url"));
    return Buffer.concat([d.update(Buffer.from(ctB64, "base64url")), d.final()]).toString("utf8");
  } catch (e) {
    fail(`JWT 解密失败（密钥派生方式可能已变）: ${e.message}`);
  }
}
const CRED_V2_KEYRING_SERVICE = "ZCode Credential Encryption";
const CRED_V2_KEY_BYTES = 32;
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
// Windows 凭据管理器直读（客户端 keyring 同款存储：TargetName=<account>.<service>，
// blob 为 43 字符 base64url 密钥串的 UTF-16LE）。脚本经 -EncodedCommand 传入规避引号转义
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
// 全部失败返回 null（逐项原因打到 stderr，不打印密钥本身）
async function readV2OsKey(fp) {
  const credFile = resolve(credPath());
  const account = createHash("sha256").update(credFile).digest("hex");
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
  console.error("[claim] enc:v2:os 密钥读取失败，逐项原因：\n  - " + reasons.join("\n  - "));
  return null;
}
// v2 env 来源密钥：管理密文 → sha256。口径与客户端 resolveManagedSecret 对齐（显式
// env 变量 > 显式文件 > 凭证目录兜底文件；同时配置两种 env 来源视为不可用）
async function readV2EnvKey(credFile) {
  const { ZCODE_CREDENTIAL_SECRET, ZCODE_CREDENTIAL_SECRET_FILE } = process.env;
  if (ZCODE_CREDENTIAL_SECRET && ZCODE_CREDENTIAL_SECRET_FILE) {
    console.error("[claim] ZCODE_CREDENTIAL_SECRET 与 ZCODE_CREDENTIAL_SECRET_FILE 同时配置（客户端视为不可用）");
    return null;
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
    console.error("[claim] 未找到可用的管理密文（env 变量/文件均缺失或长度不在 32~4096 字节）");
    return null;
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
    fail("enc:v2 凭证格式异常（期望 enc:v2:<os|env>:<24位指纹>:<iv.tag.ct>，除指纹外均 base64url）");
  }
  const [source, fp, payload] = parts;
  const key = source === "os" ? await readV2OsKey(fp) : await readV2EnvKey(credFile);
  if (!key) fail(`无法取得 enc:v2:${source} 来源密钥（逐项原因见上）`);
  if (credV2Fingerprint(key) !== fp) {
    fail("v2 密钥指纹不匹配（钥匙串/管理密文与该凭证不对应，可能更换过机器或凭证路径）");
  }
  const [ivB64, tagB64, ctB64] = payload.split(".");
  if (!ivB64 || !tagB64 || !ctB64) fail("enc:v2 载荷异常（期望 iv.tag.ct 三段 base64url）");
  try {
    const d = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64url"));
    d.setAuthTag(Buffer.from(tagB64, "base64url"));
    return Buffer.concat([d.update(Buffer.from(ctB64, "base64url")), d.final()]).toString("utf8");
  } catch (e) {
    fail(`enc:v2 AES-256-GCM 解密失败: ${e.message}`);
  }
}
async function loadJwt() {
  const credFile = credPath();
  const creds = JSON.parse(await readFile(credFile, "utf8"));
  const enc = creds["zcodejwttoken"];
  if (typeof enc !== "string" || !enc) fail("credentials.json 中无 zcodejwttoken");
  if (enc.startsWith("enc:v2:")) return await decryptV2(enc, credFile);
  if (enc.startsWith("enc:v1:")) return decryptV1(enc);
  fail("credentials.json 凭证格式无法识别（非 enc:v1/enc:v2 前缀），需人工核对协议变更");
}

async function loadDeviceMid() {
  const state = JSON.parse(await readFile(telemetryPath(), "utf8"));
  if (!state.deviceMid) fail("telemetry-state.json 中无 deviceMid");
  return state.deviceMid;
}

// 本地状态文件：记录观测到/领取过的套餐元数据（不含任何凭证），用于跨次运行区分
// "无活动"与"已领取过"——preview 只列未领套餐，领取后返回空数组，单靠它无法区分两者。
// 过期记录不长期保留：落盘时统一清理（见 pruneExpiredPlans）
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
// 过期记录清理：endsAt 已过的条目在每次落盘时移除，避免状态文件长期累积无效历史。
// 安全性：服务端不会向已结束活动下发卡片，已领记录被清后即使异常重发卡片，领取也会
// 命中 1001~1005 终态码（视为完成、不重试），不会重复扣量；无 endsAt 的记录无法判定
// 时效，保留
function pruneExpiredPlans(state, nowMs = Date.now()) {
  for (const [planId, p] of Object.entries(state.plans ?? {})) {
    const ends = p?.endsAt ? Date.parse(p.endsAt) : NaN;
    if (Number.isFinite(ends) && ends < nowMs) delete state.plans[planId];
  }
}
async function saveState(state) {
  pruneExpiredPlans(state);
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
            ...(e.effective_at ? { effectiveAt: new Date(e.effective_at * 1000).toISOString() } : {}),
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
      // 生效起点（可为未来时间）：claim 响应的 plan.starts_at 是领取/归属时刻而非生效时刻，
      // 生效判定以本字段为准（§6.13 —— 生效前 current 列表不含该套餐）
      effectiveAt: e.effective_at ? new Date(e.effective_at * 1000).toISOString() : undefined,
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
  process.exitCode = unclaimedCampaignPlans.length > 0 ? 0 : 1; // 设 exitCode 让事件循环排空后自然退出：fetch 的 keep-alive 句柄下强制 process.exit 在 Windows 触发 libuv 断言崩溃（0xC0000409）
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
    process.exitCode = 0;
    return;
  }
  // 3007=验证码失败（参数缺失/过期/已用，需取新参数重试一次）
  // 1001~1005=终态失败（如已领取），不要重试
  const terminal = [1001, 1002, 1003, 1004, 1005].includes(Number(code));
  process.exitCode = terminal ? 0 : 4;
}

// 提示语前缀跟随实际调用方式：npm 全局 bin 的 argv[1] 落在 node_modules 下显示 zcode-claim；
// 技能目录 / 源码直调（node claim.mjs）显示脚本形态
const PROG = process.argv[1]?.includes("node_modules") ? "zcode-claim" : "node claim.mjs";

function usage(toStderr = false) {
  const print = toStderr ? console.error : console.log;
  print(`ZCode 活动套餐查询与领取 CLI（技能 zcode-plan-claim 的执行器，可脱离插件独立使用；凭证仅在本机解密，除 zcode.z.ai 外不向任何第三方发送）

用法: ${PROG} <命令> [选项]

命令：
  status                 查询活动状态（唯一权威判定）；退出码 0=有可领, 1=无可领, 4=失败
  pending                读取本地待领记录（零网络）；分支看 recommendedPlanId
  active                 查询已生效套餐（领取后复核到账）
  configs                查询客户端配置（含验证码 SceneId/prefix，诊断用）
  claim                  提交领取：--plan <planId> --captcha-param-file <验证码参数文件>（均必填，参数一次性）
  -h, --help             显示本帮助

领取流程（内置浏览器无感验证码、终态错误码约定）见 SKILL.md 与 references/CLAIM-LOGIC.md。`);
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "--help" || cmd === "-h") usage(); // 主动求助走 stdout，exit 0
else if (cmd === "status") await cmdStatus();
else if (cmd === "pending") await cmdPending();
else if (cmd === "active") await cmdActive();
else if (cmd === "configs") await cmdConfigs();
else if (cmd === "claim") await cmdClaim(rest);
else {
  usage(true); // 缺命令/未知命令走 stderr，exit 1（管道写是异步，process.exit 会丢缓冲，设 exitCode 自然退出）
  console.error(`[claim] ${cmd === undefined ? "缺少命令" : `未知命令: ${cmd}`}`);
  process.exitCode = 1;
}
