import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireWatcherRole, releaseLock } from "../mcp/lib/lock.mjs";

function tmpLock() {
  const dir = mkdtempSync(join(tmpdir(), "claim-watcher-lock-"));
  return { file: join(dir, "watcher.lock"), dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("首个实例获得 watcher 角色", () => {
  const { file, cleanup } = tmpLock();
  try {
    assert.equal(acquireWatcherRole(file, 1111, { isAlive: () => true }), "watcher");
  } finally { cleanup(); }
});

test("持锁进程存活时第二实例为 idle", () => {
  const { file, cleanup } = tmpLock();
  try {
    assert.equal(acquireWatcherRole(file, 1111, { isAlive: () => true }), "watcher");
    assert.equal(acquireWatcherRole(file, 2222, { isAlive: () => true }), "idle");
  } finally { cleanup(); }
});

test("持锁进程已死 → 接管", () => {
  const { file, cleanup } = tmpLock();
  try {
    assert.equal(acquireWatcherRole(file, 1111, { isAlive: () => true }), "watcher");
    assert.equal(acquireWatcherRole(file, 2222, { isAlive: () => false }), "watcher");
  } finally { cleanup(); }
});

test("同 pid 重复获取为 idle（本进程已持有）", () => {
  const { file, cleanup } = tmpLock();
  try {
    assert.equal(acquireWatcherRole(file, 1111, { isAlive: () => true }), "watcher");
    assert.equal(acquireWatcherRole(file, 1111), "idle");
  } finally { cleanup(); }
});

test("releaseLock：仅释放自己的锁", () => {
  const { file, cleanup } = tmpLock();
  try {
    acquireWatcherRole(file, 1111, { isAlive: () => true });
    releaseLock(file, 2222); // pid 不匹配 → 不释放
    assert.equal(acquireWatcherRole(file, 3333, { isAlive: () => true }), "idle");
    releaseLock(file); // 默认按当前进程 pid —— 测试环境与 1111 不同，应不释放
  } finally { cleanup(); }
});

test("锁文件内容损坏 → 安全回退 idle", () => {
  const { file, cleanup } = tmpLock();
  try {
    writeFileSync(file, "not-a-pid");
    assert.equal(acquireWatcherRole(file, 1111, { isAlive: () => true }), "idle");
  } finally { cleanup(); }
});
