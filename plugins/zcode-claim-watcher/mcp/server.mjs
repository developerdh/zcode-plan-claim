#!/usr/bin/env node
// ZCode 活动领取监控 —— 插件 MCP server 入口。
// 职责：
//   1. 后台按配置间隔轮询 marketing/touch 活动卡片（只读 GET），支持配置热加载、总开关与时间窗
//   2. 发现可领套餐 → 通过官方绑定的 bot 渠道推送微信/飞书通知，提醒用户回复"领取"
//      （领取由用户回复触发的 ZCode 会话执行：内置浏览器过验证码，实证可靠）
//   3. MCP 工具：watcher_status / watcher_config / watcher_history / check_now / notify_send
//
// 设计说明：监控不做自动领取——无头/CDP 浏览器的无感验证码会被风控挂起（实测），
// 能通过验证码的内嵌浏览器只在 ZCode 会话内可用；因此监控负责"发现与提醒"，
// 领取动作由用户回复触发的会话（或定时自动化）完成。
//
// 自检：node server.mjs --selftest-poll
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeConfig } from "./lib/config.mjs";
import { appendRound, readRounds, summarize } from "./lib/history.mjs";
import { acquireWatcherRole, releaseLock } from "./lib/lock.mjs";
import { startWatcherLoop } from "./lib/loop.mjs";
import { sendBotNotification } from "./lib/notify.mjs";
import { alreadyHandled, loadState, markNotified, markPlan, saveState, shouldNotify, statePath } from "./lib/state.mjs";
import { planNext } from "./lib/windows.mjs";

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_VERSION = JSON.parse(readFileSync(join(PLUGIN_ROOT, ".zcode-plugin", "plugin.json"), "utf8")).version;

const BASE = process.env.ZCODE_API_BASE ?? "https://zcode.z.ai";
const CONFIG_FILE = process.env.ZCODE_CLAIM_WATCHER_CONFIG ?? joinHomedir(".zcode", "zcode-claim-watcher.json");
const LOCK_FILE = joinHomedir(".zcode", "zcode-claim-watcher.lock");
const LOG_FILE = joinHomedir(".zcode", "zcode-claim-watcher.log");
const HISTORY_FILE = joinHomedir(".zcode", "zcode-claim-watcher-history.jsonl");

// ---------- 客户端版本号解析（与技能 claim.mjs 同口径，细节见 references/CLAIM-LOGIC.md §6.9~6.11） ----------
// 服务端按"客户端声明的版本号"（app.asar 内 package.json 的 version，三段式如 3.17.1）
// 做定向过滤：marketing/touch 仅对该版本值下发活动卡片，其他版本值静默返回空 deliveries。
// 因此：ZCODE_APP_VERSION（任意合法格式）硬覆盖 > 动态读取 app.asar 包版本 > 内置回退值（告警）。
const FALLBACK_APP_VERSION = "3.17.1";
const VERSION_RE = /^\d+\.\d+(\.\d+){0,3}$/;

async function detectAsarPackageVersion() {
  const { open } = await import("node:fs/promises");
  let fh = null;
  try {
    fh = await open("D:\\Program Files\\ZCode\\resources\\app.asar", "r");
    const headBuf = Buffer.alloc(16);
    await fh.read(headBuf, 0, 16, 0);
    const jsonSize = headBuf.readUInt32LE(12);
    const head = Buffer.alloc(jsonSize);
    await fh.read(head, 0, jsonSize, 16);
    const header = JSON.parse(head.toString("utf8"));
    const pkgNode = header.files?.["package.json"];
    if (!pkgNode) return null;
    const dataBase = 16 + jsonSize;
    const body = Buffer.alloc(pkgNode.size);
    await fh.read(body, 0, pkgNode.size, dataBase + Number(pkgNode.offset));
    const version = JSON.parse(body.toString("utf8")).version;
    return VERSION_RE.test(String(version).trim()) ? String(version).trim() : null;
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => {});
  }
}

async function resolveAppVersion() {
  const env = process.env.ZCODE_APP_VERSION?.trim();
  if (env && VERSION_RE.test(env)) return { version: env, source: "env" };
  if (process.platform === "win32") {
    const detected = await detectAsarPackageVersion();
    if (detected) return { version: detected, source: "detect" };
  }
  log(`警告：未能动态获取客户端版本号，回退内置值 ${FALLBACK_APP_VERSION}（可用 ZCODE_APP_VERSION 指定）`);
  return { version: FALLBACK_APP_VERSION, source: "fallback" };
}

let APP_VERSION = FALLBACK_APP_VERSION; // main() 启动时 resolve 覆盖

function joinHomedir(...parts) {
  const home = process.env.USERPROFILE ?? process.env.HOME;
  let p = home.replace(/[\\/]+$/, "");
  for (const part of parts) p += "/" + part;
  return p;
}

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.error(`[claim-watcher] ${msg}`);
  try { appendFileSync(LOG_FILE, line + "\n"); } catch {}
}

// ---------- 只读查询 ----------
async function apiGet(path, extraHeaders) {
  const creds = JSON.parse(readFileSync(process.env.ZCODE_CREDENTIALS_FILE ?? joinHomedir(".zcode", "v2", "credentials.json"), "utf8"));
  const enc = creds["zcodejwttoken"];
  if (typeof enc !== "string" || !enc.startsWith("enc:v1:")) throw new Error("credentials.json 中未找到 enc:v1 的 zcodejwttoken");
  const { createHash, createDecipheriv } = await import("node:crypto");
  const { platform, userInfo } = await import("node:os");
  let secret;
  try {
    secret = process.env.ZCODE_CREDENTIAL_SECRET?.trim() || `zcode-credential-fallback:${platform()}:${homedir()}:${userInfo().username}`;
  } catch {
    secret = `zcode-credential-fallback:${platform()}:${homedir()}:unknown`;
  }
  const key = createHash("sha256").update(secret).digest();
  const [iv, tag, ct] = enc.slice("enc:v1:".length).split(".");
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  const jwt = Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8");
  const telemetry = JSON.parse(readFileSync(process.env.ZCODE_TELEMETRY_FILE ?? joinHomedir(".zcode", "v2", "telemetry-state.json"), "utf8"));
  if (!telemetry.deviceMid) throw new Error("telemetry-state.json 中无 deviceMid");
  const res = await fetch(BASE + path, { headers: { Authorization: `Bearer ${jwt}`, "X-Device-Mid": telemetry.deviceMid, "X-ZCode-App-Version": APP_VERSION, "X-Platform": "windows", ...extraHeaders } });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { throw new Error(`HTTP ${res.status} 非JSON响应: ${text.slice(0, 200)}`); }
  if (body.code !== 0) throw new Error(`HTTP ${res.status} code=${body.code} ${body.msg ?? ""}`);
  if (body.data === undefined) {
    throw new Error(`接口 ${path} 返回 code=0 但缺 data 字段——版本值 ${APP_VERSION} 下该接口不返回信封（各接口版本口径不一致，可设置 ZCODE_APP_VERSION 换其他版本值）`);
  }
  return body.data;
}

// 活动卡片轮询（权威判定源）：解析 claim_zcode_plan 按钮，返回卡片上全部可领套餐（不做本地过滤，
// 已领取/已通知的去重由 runRound 依据本地状态处理）。卡片类活动不出现在 billing/preview 中。
async function pollCampaigns() {
  const data = await apiGet(`/api/v1/marketing/touch?seq=1`, { "X-Client-Language": "zh-CN" });
  const seen = new Map();
  for (const d of data.deliveries ?? []) {
    const meta = d.banner?.background?.args?.zcode_plan ?? d.banner?.hero?.args?.zcode_plan ?? null;
    for (const b of d.banner?.buttons ?? []) {
      if (b.action?.type !== "claim_zcode_plan" || !b.action?.args?.plan_id) continue;
      const planId = b.action.args.plan_id;
      const priority = meta?.priority ?? d.priority ?? 0;
      const prev = seen.get(planId);
      if (!prev || priority > prev.priority) {
        seen.set(planId, {
          planId,
          name: meta?.name ?? planId,
          priority,
          entitlements: (meta?.entitlements ?? []).map((e) => ({ model: e.show_name, grantUnits: e.grant_units, unitType: e.unit_type, period: e.period })),
        });
      }
    }
  }
  const plans = [...seen.values()].sort((a, b) => b.priority - a.priority);
  return { serverTime: data.server_time, claimable: plans.length > 0, plans };
}

function planLabel(plan) {
  const ents = (plan.entitlements ?? []).map((e) => `${e.model} ${(e.grantUnits / 1e8).toFixed(1).replace(/\.0$/, "")}亿 token`).join(" + ");
  return `${plan.name}（${ents || "额度未知"}）`;
}

// ---------- 轮次执行：轮询 → 发现 → bot 渠道通知 ----------
async function runRound(trigger, roundCount, cfg) {
  const state = await loadState();
  const record = { ts: new Date().toISOString(), round: roundCount, trigger, outcome: "empty" };
  try {
    const campaigns = await pollCampaigns();
    if (!campaigns.claimable) {
      appendRound(HISTORY_FILE, record);
      return { ...record, campaigns };
    }
    const best = [...campaigns.plans].sort((a, b) => b.priority - a.priority)[0];
    record.planId = best.planId;
    record.planName = best.name;

    if (alreadyHandled(state, best.planId)) {
      record.outcome = "already_claimed";
      record.note = "本地记录已领取过，跳过通知";
      appendRound(HISTORY_FILE, record);
      return { ...record };
    }
    if (!shouldNotify(state, best.planId, "discovered")) {
      record.outcome = "already_notified";
      record.note = "发现通知已发送过，等待用户回复领取";
      appendRound(HISTORY_FILE, record);
      return { ...record };
    }

    const text = `🔔 发现可领活动：${planLabel(best)}\nplan_id: ${best.planId}\n回复「领取活动套餐」即可领取（需要 ZCode 保持运行）。`;
    const notifyResults = await sendBotNotification({ message: text, channels: cfg?.notify?.channels, failover: cfg?.notify?.failover });
    markNotified(state, best.planId, "discovered");
    markPlan(state, best.planId, { name: best.name, priority: best.priority, discoveredAt: record.ts });
    await saveState(state);

    const sent = notifyResults.some((r) => r.ok);
    record.outcome = sent ? "notified" : "notify_failed";
    record.notify = notifyResults;
    log(`发现可领套餐 ${best.planId}（${best.name}），通知${sent ? "已发送" : "失败"}`);
    appendRound(HISTORY_FILE, record);
    return { ...record };
  } catch (e) {
    record.outcome = "error";
    record.error = String(e?.message ?? e);
    appendRound(HISTORY_FILE, record);
    return { ...record };
  }
}

// ---------- 配置 ----------
async function loadConfigFile() {
  try {
    return normalizeConfig(JSON.parse(readFileSync(CONFIG_FILE, "utf8")));
  } catch {
    return normalizeConfig({});
  }
}

// ---------- MCP 工具 ----------
const TOOLS = [
  { name: "watcher_status", description: "查询活动监控运行状态、配置摘要、历史与已领取/已过期套餐（只读）", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "watcher_config", description: "读取或修改监控配置（intervalMinutes≥5 / enabled / activeWindows / notify.events / notify.channels（空=自动发首个绑定渠道） / notify.failover）。传入 config 字段为修改，缺省为读取", inputSchema: { type: "object", properties: { config: { type: "object", description: "完整的新配置对象（整体替换）", additionalProperties: true } }, additionalProperties: false } },
  { name: "watcher_history", description: "查询轮询历史（默认最近 10 条，支持按 outcome/since/until 过滤）", inputSchema: { type: "object", properties: { limit: { type: "number", minimum: 1, maximum: 100 }, outcome: { type: "string", enum: ["empty", "notified", "already_claimed", "already_notified", "notify_failed", "error"] }, since: { type: "string" }, until: { type: "string" } }, additionalProperties: false } },
  { name: "check_now", description: "立即手动执行一轮检查（轮询 → 若发现可领活动则推送通知；不受开关/时间窗限制）", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "notify_send", description: "通过 bot 渠道主动推送一条通知到用户微信/飞书（供定时自动化会话在领取结束后报告结果用）。channel 缺省用配置默认渠道，可指定 weixin/feishu/all", inputSchema: { type: "object", properties: { message: { type: "string", description: "通知文本" }, channel: { type: "string", enum: ["weixin", "feishu", "all"], description: "推送渠道：缺省=配置默认（notify.channels，空则自动发首个绑定渠道）；all=全部启用渠道" } }, required: ["message"], additionalProperties: false } },
];

function jsonResult(obj) {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] };
}

function planStateView(state) {
  const now = Date.now();
  return Object.values(state.plans).map((p) => ({
    planId: p.planId,
    name: p.name ?? null,
    claimedAt: p.claimedAt ?? null,
    endsAt: p.endsAt ?? null,
    state: p.claimedAt ? (p.endsAt && Date.parse(p.endsAt) < now ? "已过期" : "已领取") : "仅发现",
  }));
}

async function handleToolCall(name, args = {}) {
  if (name === "watcher_status") {
    const cfg = (await loadConfigFile()).config;
    const state = await loadState();
    const stats = summarize(HISTORY_FILE);
    return jsonResult({
      role: watcherRole,
      version: PLUGIN_VERSION,
      running: Boolean(loop?.running),
      roundCount: loop?.roundCount ?? 0,
      checkInFlight: Boolean(checkInFlight),
      config: cfg,
      history: { total: stats.total, byOutcome: stats.byOutcome, lastRounds: readRounds(HISTORY_FILE, { limit: 3 }).rounds },
      plans: planStateView(state),
      paths: { config: CONFIG_FILE, state: statePath(), history: HISTORY_FILE, log: LOG_FILE },
    });
  }
  if (name === "watcher_config") {
    if (args.config === undefined) {
      const { config, warnings } = await loadConfigFile();
      return jsonResult({ config, warnings, path: CONFIG_FILE });
    }
    const { config, warnings } = normalizeConfig(args.config);
    writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n");
    log(`配置已更新（热加载）`);
    return jsonResult({ saved: true, config, warnings, note: "配置已热加载，下一轮评估生效" });
  }
  if (name === "watcher_history") {
    const limit = Math.max(1, Math.min(100, Math.round(Number(args.limit ?? 10))));
    return jsonResult({ path: HISTORY_FILE, ...readRounds(HISTORY_FILE, { limit, outcome: args.outcome, since: args.since, until: args.until }) });
  }
  if (name === "check_now") {
    if (checkInFlight) return jsonResult({ busy: true, note: "已有检查在执行中" });
    checkInFlight = runRound("manual", undefined, (await loadConfigFile()).config).finally(() => (checkInFlight = null));
    return jsonResult(await checkInFlight);
  }
  if (name === "notify_send") {
    const message = String(args.message ?? "").trim();
    if (!message) throw new Error("message 不能为空");
    const channel = args.channel;
    if (channel !== undefined && !["weixin", "feishu", "all"].includes(channel)) throw new Error(`channel 非法（可选：weixin/feishu/all）`);
    const { config: cfg } = await loadConfigFile();
    const channels = channel === undefined ? cfg.notify.channels : channel === "all" ? "all" : [channel];
    return jsonResult({ results: await sendBotNotification({ message, channels, failover: cfg.notify.failover }) });
  }
  throw new Error(`未知工具: ${name}`);
}

// ---------- MCP stdio（newline-delimited JSON-RPC 2.0） ----------
function startMcpServer() {
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line) handleJsonRpcLine(line).catch((e) => log(`RPC 处理异常: ${e.message}`));
    }
  });
  process.stdin.on("end", () => process.exit(0));
}

async function handleJsonRpcLine(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const reply = (result) => {
    if (msg.id === undefined) return;
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n");
  };
  if (msg.method === "initialize") {
    reply({ protocolVersion: msg.params?.protocolVersion ?? "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "zcode-claim-watcher", version: PLUGIN_VERSION } });
  } else if (msg.method === "ping") {
    reply({});
  } else if (msg.method === "tools/list") {
    reply({ tools: TOOLS });
  } else if (msg.method === "tools/call") {
    try {
      reply(await handleToolCall(msg.params?.name, msg.params?.arguments));
    } catch (e) {
      if (msg.id === undefined) return;
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: String(e?.message ?? e) } }) + "\n");
    }
  }
}

// ---------- 监控循环 ----------
let watcherRole = "idle";
let loop = null;
let checkInFlight = null;

function startWatcher() {
  loop = startWatcherLoop({
    getConfig: async () => (await loadConfigFile()).config,
    evaluateRound: async (cfg, roundCount, trigger) => {
      const r = await runRound(trigger, roundCount, cfg);
      log(`轮询完成 #${roundCount}(${trigger}): outcome=${r.outcome}${r.planName ? ` plan=${r.planName}` : ""}${r.error ? ` error=${r.error}` : ""}`);
      return r;
    },
    initialDelayMs: Number(process.env.CLAIM_WATCH_FIRST_DELAY_MS ?? 20 * 1000),
    logger: log,
    planNext,
  });
  loop.start();
  log("监控循环已启动");
}

// ---------- 入口 ----------
async function main() {
  const resolved = await resolveAppVersion();
  APP_VERSION = resolved.version;
  log(`使用客户端版本号 ${APP_VERSION}（来源 ${resolved.source}）`);
  const mode = process.argv[2];
  if (mode === "--selftest-poll") {
    console.log(JSON.stringify(await pollCampaigns(), null, 2));
    return;
  }

  watcherRole = acquireWatcherRole(LOCK_FILE);
  log(`监控启动 role=${watcherRole}`);
  if (watcherRole === "watcher") startWatcher();
  process.on("exit", () => releaseLock(LOCK_FILE));
  startMcpServer();
}

main().catch((e) => {
  log(`致命错误: ${e.message}`);
  process.exit(1);
});
