// ensure 幂等拉起与单实例锁测试：
//  1) daemon 已健康 → ensure 秒回 exit 0，且不拉起第二个实例（pid 不变）
//  2) daemon 未运行 → ensure detached 拉起并等 /health 就绪后 exit 0，pid 文件就位
//  3) 端口被其他程序占用（/health 不健康）→ serve exit 1（EADDRINUSE 探测分支）
import assert from "node:assert/strict";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.mjs");

// 独立测试端口段（避开 49152+ 的 OS 临时端口段、真实 daemon 47823 与 http-protocol 的 41000 段）
const PORT_BASE = 44000 + (process.pid % 2000);
const PORTS = { healthy: PORT_BASE, fresh: PORT_BASE + 1, occupied: PORT_BASE + 2 };

function childEnv(port, home) {
  return {
    ...process.env,
    USERPROFILE: home, HOME: home,
    ZCODE_DATA_BASE_DIR: home,
    ZCODE_APP_VERSION: "3.17.1",
    CLAIM_WATCH_FIRST_DELAY_MS: "3600000",
    ZCODE_DAEMON_PORT: String(port),
    ZCODE_DAEMON_PROCESS_RE: "",
  };
}

function makeHome(tag) {
  const home = mkdtempSync(join(tmpdir(), `claim-daemon-ensure-${tag}-`));
  return { home, pidFile: join(home, ".zcode", "zcode-claim-daemon.json") };
}

async function waitHealth(port, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(400) });
      if (res.ok) return await res.json();
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  return null;
}

async function shutdown(port) {
  try { await fetch(`http://127.0.0.1:${port}/shutdown`, { method: "POST", signal: AbortSignal.timeout(2000) }); } catch {}
  await waitHealthGone(port);
}

async function waitHealthGone(port, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await waitHealth(port, 300)) === null) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

test("ensure：daemon 已健康 → 秒回 exit 0 且不拉起第二个实例", async () => {
  const { home, pidFile } = makeHome("healthy");
  const daemon = spawn(process.execPath, [CLI, "serve", "--keep-alive"], { env: childEnv(PORTS.healthy, home), stdio: "ignore" });
  try {
    const health = await waitHealth(PORTS.healthy);
    assert.ok(health, "daemon 未就绪");
    assert.equal(health.pid, daemon.pid);

    const t0 = Date.now();
    const ensure = spawnSync(process.execPath, [CLI, "ensure"], { env: childEnv(PORTS.healthy, home), timeout: 15000, encoding: "utf8" });
    const elapsed = Date.now() - t0;
    assert.equal(ensure.status, 0, `ensure 应 exit 0：${ensure.stderr}`);
    assert.ok(elapsed < 3000, `健康时应秒回，实际 ${elapsed}ms`);

    const again = await waitHealth(PORTS.healthy, 1000);
    assert.equal(again.pid, daemon.pid, "不应拉起第二个实例");
  } finally {
    await shutdown(PORTS.healthy);
    daemon.kill();
    rmSync(home, { recursive: true, force: true });
  }
});

test("ensure：daemon 未运行 → detached 拉起并等就绪，pid 文件就位", async () => {
  const { home, pidFile } = makeHome("fresh");
  try {
    assert.equal(await waitHealth(PORTS.fresh, 300), null, "测试前提：端口空闲");
    const ensure = spawnSync(process.execPath, [CLI, "ensure"], { env: childEnv(PORTS.fresh, home), timeout: 20000, encoding: "utf8" });
    assert.equal(ensure.status, 0, `ensure 应恒 exit 0：${ensure.stderr}`);

    const health = await waitHealth(PORTS.fresh, 6000);
    assert.ok(health, "ensure 后 daemon 应就绪");
    assert.ok(existsSync(pidFile), "pid 文件应存在");
    const pidInfo = JSON.parse(readFileSync(pidFile, "utf8"));
    assert.equal(pidInfo.pid, health.pid);
    assert.equal(pidInfo.port, PORTS.fresh);
    await shutdown(PORTS.fresh);
    assert.equal(existsSync(pidFile), false, "daemon 退出后应清理 pid 文件");
  } finally {
    await shutdown(PORTS.fresh);
    rmSync(home, { recursive: true, force: true });
  }
});

test("serve：端口被其他程序占用（/health 不健康）→ exit 1", async () => {
  const { home } = makeHome("occupied");
  const squatter = http.createServer((req, res) => {
    res.writeHead(404);
    res.end("not a daemon");
  });
  await new Promise((r) => squatter.listen(PORTS.occupied, "127.0.0.1", r));
  try {
    const serve = spawnSync(process.execPath, [CLI, "serve"], { env: childEnv(PORTS.occupied, home), timeout: 15000, encoding: "utf8" });
    assert.equal(serve.status, 1, `端口被非 daemon 占用时应 exit 1，stderr: ${serve.stderr}`);
    assert.match(serve.stderr, /已被占用/);
  } finally {
    await new Promise((r) => squatter.close(r));
    rmSync(home, { recursive: true, force: true });
  }
});
