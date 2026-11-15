#!/usr/bin/env node
// zcwatch —— ZCode 活动领取监控 daemon 的管理 CLI（全局命令经 package.json bin 注册；
// 仅装插件的用户可用 node <插件路径>/daemon/cli.mjs 调用，SessionStart 钩子已自动 ensure）。
//
// 用法：
//   node cli.mjs serve [--keep-alive]   前台运行 daemon（默认 ZCode 不在运行则自退出；--keep-alive 供调试/CI）
//   node cli.mjs ensure                 幂等拉起：健康且版本一致即秒回；版本不一致自动重启同步升级；
//                                       否则 detached 拉起 serve 并等其就绪（恒 exit 0，不阻塞会话）
//   node cli.mjs stop                   优雅停止（POST /shutdown，失败回退 pid 文件 kill；未在运行视为成功）
//   node cli.mjs status                 查询 /health（daemon 是否在运行、pid、uptime、轮次）
//   node cli.mjs check                  经 MCP 调 check_now 立即检查一轮（诊断/自动化用）
//   node cli.mjs --test                 轮询一次活动卡片并输出 JSON 后退出（不依赖 daemon）
//
// 端口：缺省 47823（绑定 127.0.0.1）；ZCODE_DAEMON_PORT 仅用于测试隔离。
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { daemonPort, probeHealth, probeHealthInfo, mcpUrl, healthUrl, shutdownUrl } from "./http.mjs";
import { pollCampaigns, log, PID_FILE, pluginVersion } from "./mcp.mjs";

const SELF = fileURLToPath(import.meta.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 提示语前缀跟随实际调用方式：npm 全局 bin 的 argv[1] 落在 node_modules 下显示 zcwatch；
// 插件内 / 源码直调（node cli.mjs）显示脚本形态
const PROG = process.argv[1]?.includes("node_modules") ? "zcwatch" : "node cli.mjs";

// 幂等拉起 + 版本一致性自愈：健康且版本一致即秒回；健康但版本不一致（插件升级后旧 daemon
// 仍在跑）先优雅停止再以当前版本重新拉起——否则旧进程会用旧代码持续轮询（协议变更类升级
// 会整段失效，如 credentials enc:v1→v2）；否则 detached 拉起 serve 并轮询 /health 最多 ~4s。
// 无论成败都 exit 0（不阻塞会话）
async function ensure() {
  const port = daemonPort();
  const myVersion = pluginVersion();
  const running = await probeHealthInfo(port, 500);
  if (running) {
    if (running.version === myVersion) return;
    console.error(`[zcwatch] daemon 版本不一致（运行 ${running.version ?? "未知"} ≠ 当前 ${myVersion}），自动重启以同步升级`);
    await stopDaemon();
    // 留出端口释放时间；若旧进程未被杀死仍持有端口，下方探活将一直不匹配并落到超时提示
    await sleep(1000);
  }
  const child = spawn(process.execPath, [SELF, "serve"], {
    detached: true,
    stdio: "ignore",
    ...(process.platform === "win32" ? { windowsHide: true } : {}),
  });
  child.unref();
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    await sleep(200);
    const body = await probeHealthInfo(port, 300);
    if (body && body.version === myVersion) return;
  }
  const leftover = await probeHealthInfo(port, 300);
  if (leftover && leftover.version !== myVersion) {
    console.error(`[zcwatch] 旧版本 daemon 未能停止（版本 ${leftover.version}），本轮保持现状，留待下次会话重试`);
  }
  // 拉起失败（如端口被其他程序占用）也不阻塞会话，留待下次会话重试
}

async function stopDaemon() {
  try {
    const res = await fetch(shutdownUrl(), { method: "POST", signal: AbortSignal.timeout(3000) });
    if (res.ok) return 0;
  } catch {}
  // 回退：读 pid 文件直接 kill
  try {
    const { pid } = JSON.parse(readFileSync(PID_FILE, "utf8"));
    process.kill(pid, "SIGTERM");
    return 0;
  } catch {
    console.log("daemon 未在运行");
    return 0; // 幂等：未运行视为成功
  }
}

async function status() {
  try {
    const res = await fetch(healthUrl(), { signal: AbortSignal.timeout(3000) });
    const body = await res.json();
    console.log(JSON.stringify(body, null, 2));
    return body.ok === true ? 0 : 1;
  } catch {
    console.log(`daemon 未在运行（端口 ${daemonPort()} 无健康实例）`);
    return 1;
  }
}

// 经 MCP 调 check_now：输出工具结果 JSON（诊断/自动化用）
async function check() {
  try {
    const res = await fetch(mcpUrl(), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "check_now", arguments: {} } }),
      signal: AbortSignal.timeout(60 * 1000),
    });
    const msg = await res.json();
    if (msg.error) {
      console.error(`check_now 失败: ${msg.error.message}`);
      return 1;
    }
    console.log(msg.result.content[0].text);
    return 0;
  } catch {
    console.error(`daemon 未在运行或调用失败（先 ${PROG} ensure / status）`);
    return 1;
  }
}

function usage(toStderr = false) {
  const print = toStderr ? console.error : console.log;
  print(`ZCode 活动领取监控 daemon 的管理 CLI（会话外诊断/管理用；会话内由 SessionStart 钩子自动拉起 daemon，经 MCP 工具操作）

用法: ${PROG} <命令> [选项]

命令：
  serve [--keep-alive]   前台运行 daemon；ZCode 未运行则自退出，--keep-alive 供调试/CI 常驻
  ensure                 幂等拉起：健康且版本一致即秒回；版本不一致自动重启同步升级（恒 exit 0）
  stop                   优雅停止：POST /shutdown，失败回退 pid 文件 kill；未在运行视为成功
  status                 查询 /health：运行状态、pid、uptime、轮询轮次；未运行 exit 1
  check                  经 daemon 的 MCP 立即检查一轮活动卡片（诊断/自动化用）
  --test                 不经 daemon 独立轮询一次活动卡片，输出 JSON 后退出（诊断用）
  -h, --help             显示本帮助

环境变量：
  ZCODE_DAEMON_PORT      覆盖 daemon 端口（缺省 47823，绑定 127.0.0.1；仅用于测试隔离）

示例：
  ${PROG} status          查看 daemon 是否在运行
  ${PROG} check           手动触发一轮活动检查
  ${PROG} stop            停止后台 daemon`);
}

async function main() {
  const cmd = process.argv[2];
  switch (cmd) {
    case "serve": {
      const { serve } = await import("./serve.mjs");
      await serve({ keepAlive: process.argv.includes("--keep-alive") });
      return;
    }
    case "ensure":
      await ensure();
      return;
    case "stop":
      process.exitCode = await stopDaemon();
      return;
    case "status":
      process.exitCode = await status();
      return;
    case "check":
      process.exitCode = await check();
      return;
    case "--test":
      console.log(JSON.stringify(await pollCampaigns(), null, 2));
      return;
    case "--help":
    case "-h":
      usage(); // 主动求助走 stdout，exit 0
      return;
    case undefined:
      usage(true); // 缺命令/未知命令走 stderr，exit 1
      log(`缺少命令`);
      process.exitCode = 1;
      return;
    default:
      usage(true);
      log(`未知命令: ${cmd}`);
      process.exitCode = 1;
  }
}

main().catch((e) => {
  log(`cli 致命错误: ${e?.message ?? e}`);
  process.exit(1);
});
