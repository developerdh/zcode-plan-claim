#!/usr/bin/env node
// ZCode 活动领取监控 —— 插件 MCP server 入口。
// 职责：
//   1. 后台按配置间隔轮询 billing/preview（只读 GET，0 token），支持配置热加载、总开关与时间窗
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
const APP_VERSION = process.env.ZCODE_APP_VERSION ?? "3.15.3";
const CONFIG_FILE = process.env.ZCODE_CLAIM_WATCHER_CONFIG ?? joinHomedir(".zcode", "zcode-claim-watcher.json");
const LOCK_FILE = joinHomedir(".zcode", "zcode-claim-watcher.lock");
const LOG_FILE = joinHomedir(".zcode", "zcode-claim-watcher.log");
const HISTORY_FILE = joinHomedir(".zcode", "zcode-claim-watcher-history.jsonl");

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
async function apiGet(path) {
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
  const res = await fetch(BASE + path, { headers: { Authorization: `Bearer ${jwt}`, "X-Device-Mid": telemetry.deviceMid, "X-ZCode-App-Version": APP_VERSION, "X-Platform": "windows" } });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { throw new Error(`HTTP ${res.status} 非JSON响应: ${text.slice(0, 200)}`); }
  if (body.code !== 0) throw new Error(`HTTP ${res.status} code=${body.code} ${body.msg ?? ""}`);
  return body.data ?? {};
}

async function pollPreview() {
  const data = await apiGet(`/api/v1/zcode-plan/billing/preview?app_version=${APP_VERSION}&platform=windows`);
  const plans = (data.plans ?? []).map((p) => ({
    planId: p.plan_id,
    name: p.name,
    description: p.description,
    priority: p.priority ?? 0,
    entitlements: (p.entitlements ?? []).map((e) => ({ model: e.show_name, grantUnits: e.grant_units, unitType: e.unit_type, period: e.period })),
  }));
  return { serverTime: data.server_time, claimable: plans.length > 0, plans };
}

function planLabel(plan) {
  const ents = (plan.entitlements ?? []).map((e) => `${e.model} ${(e.grantUnits / 1e8).toFixed(1).replace(/\.0$/, "")}亿 token`).join(" + ");
  return `${plan.name}（${ents || "额度未知"}）`;
}

// ---------- 轮次执行：轮询 → 发现 → bot 渠道通知 ----------
async function runRound(trigger, roundCount) {
  const state = await loadState();
  const record = { ts: new Date().toISOString(), round: roundCount, trigger, outcome: "empty" };
  try {
    const preview = await pollPreview();
    if (!preview.claimable) {
      appendRound(HISTORY_FILE, record);
      return { ...record, preview };
    }
    const best = [...preview.plans].sort((a, b) => b.priority - a.priority)[0];
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
    const notifyResults = await sendBotNotification({ message: text });
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
  { name: "watcher_config", description: "读取或修改监控配置（intervalMinutes≥5 / enabled / activeWindows / notify.events）。传入 config 字段为修改，缺省为读取", inputSchema: { type: "object", properties: { config: { type: "object", description: "完整的新配置对象（整体替换）", additionalProperties: true } }, additionalProperties: false } },
  { name: "watcher_history", description: "查询轮询历史（默认最近 10 条，支持按 outcome/since/until 过滤）", inputSchema: { type: "object", properties: { limit: { type: "number", minimum: 1, maximum: 100 }, outcome: { type: "string", enum: ["empty", "notified", "already_claimed", "already_notified", "notify_failed", "error"] }, since: { type: "string" }, until: { type: "string" } }, additionalProperties: false } },
  { name: "check_now", description: "立即手动执行一轮检查（轮询 → 若发现可领活动则推送通知；不受开关/时间窗限制）", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "notify_send", description: "通过 bot 渠道主动推送一条通知到用户微信/飞书（供定时自动化会话在领取结束后报告结果用）", inputSchema: { type: "object", properties: { message: { type: "string", description: "通知文本" } }, required: ["message"], additionalProperties: false } },
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
    checkInFlight = runRound("manual").finally(() => (checkInFlight = null));
    return jsonResult(await checkInFlight);
  }
  if (name === "notify_send") {
    const message = String(args.message ?? "").trim();
    if (!message) throw new Error("message 不能为空");
    return jsonResult({ results: await sendBotNotification({ message }) });
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
      const r = await runRound(trigger, roundCount);
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
  const mode = process.argv[2];
  if (mode === "--selftest-poll") {
    console.log(JSON.stringify(await pollPreview(), null, 2));
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
