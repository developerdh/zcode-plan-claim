// daemon 组装：常驻监控服务进程（每台机器一个，由端口绑定保证单实例）。
// 启动顺序：触发版本号解析（惰性，不阻塞监听）→ HTTP 监听 → 写 pid 文件 → 监控循环 → 自退出定时器。
// 自退出：ZCode 不在运行时 daemon 无存在意义——首检延迟 90s（避开 ZCode 冷启动/重启瞬间），
// 此后每 60s 检测一次，连续 3 次未检出 ZCode 进程 → 退出；下次 SessionStart 钩子会重新拉起。
// --keep-alive 关闭自退出（手动调试 / CI 用）。
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { startDaemonHttp, daemonPort } from "./http.mjs";
import { TOOLS, handleToolCall, runRound, loadConfigFile, pluginVersion, getAppVersion, setLoop, log, PID_FILE } from "./mcp.mjs";
import { startWatcherLoop } from "./lib/loop.mjs";
import { planNext } from "./lib/windows.mjs";
import { isZcodeRunning } from "./lib/procscan.mjs";

const FIRST_CHECK_DELAY_MS = 90 * 1000;
const CHECK_INTERVAL_MS = 60 * 1000;
const MAX_MISSES = 3;

export async function serve({ keepAlive = false } = {}) {
  const port = daemonPort();
  const startedAt = Date.now();
  let exiting = false;

  // 版本号解析立即触发但不等待（首次 apiGet 前完成即可）
  getAppVersion();

  const server = await startDaemonHttp({
    port,
    tools: () => TOOLS,
    handleToolCall,
    serverInfo: () => ({ name: "zcode-claim-watcher", version: pluginVersion() }),
    health: () => ({ ok: true, pid: process.pid, version: pluginVersion(), uptime: Date.now() - startedAt, roundCount: loop?.roundCount ?? 0 }),
    onShutdown: () => gracefulExit("shutdown 请求"),
    logger: log,
  }).catch((err) => {
    if (err?.code === "EADDRINUSE" && err.healthyExisting) {
      log(`端口 ${port} 已有健康 daemon 实例，本进程退出`);
      process.exit(0);
    }
    log(`致命错误: ${err?.message ?? err}`);
    process.exit(1);
  });

  mkdirSync(dirname(PID_FILE), { recursive: true });
  writeFileSync(PID_FILE, JSON.stringify({ pid: process.pid, port, startedAt: new Date(startedAt).toISOString() }, null, 2) + "\n");

  function gracefulExit(reason) {
    if (exiting) return;
    exiting = true;
    log(`daemon 退出（${reason}）`);
    try { server?.close(); } catch {}
    try { rmSync(PID_FILE, { force: true }); } catch {}
    process.exit(0);
  }

  // 监控循环：daemon 即唯一实例，恒以 watcher 身份轮询（与原 server.mjs startWatcher 接线一致）
  const loop = startWatcherLoop({
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
  setLoop(loop);
  loop.start();
  log(`daemon 监听 http://127.0.0.1:${port}（pid ${process.pid}，keep-alive=${keepAlive}），监控循环已启动`);

  if (!keepAlive) {
    let misses = 0;
    let timer = null;
    const check = async () => {
      try {
        if (await isZcodeRunning({ logger: log })) {
          misses = 0;
        } else {
          misses += 1;
          log(`未检出 ZCode 进程（${misses}/${MAX_MISSES}）`);
          if (misses >= MAX_MISSES) return gracefulExit(`连续 ${MAX_MISSES} 次未检出 ZCode，daemon 自退出（下次 SessionStart 钩子将重新拉起）`);
        }
      } catch (e) {
        log(`进程检测异常（保守视为在运行）: ${e?.message ?? e}`);
      }
      timer = setTimeout(check, CHECK_INTERVAL_MS);
    };
    timer = setTimeout(check, FIRST_CHECK_DELAY_MS);
  }

  process.on("exit", () => {
    try { rmSync(PID_FILE, { force: true }); } catch {}
  });
  process.on("SIGINT", () => gracefulExit("SIGINT"));
  process.on("SIGTERM", () => gracefulExit("SIGTERM"));
}
