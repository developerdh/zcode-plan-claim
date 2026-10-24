// 单实例锁：多会话各拉起一份 MCP server，仅存活实例中的第一个担任 watcher 轮询
import { mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function acquireWatcherRole(lockFile, pid = process.pid, { isAlive } = {}) {
  const alive = isAlive ?? ((p) => {
    try {
      process.kill(p, 0);
      return true;
    } catch {
      return false;
    }
  });
  const writeLock = () => {
    mkdirSync(dirname(lockFile), { recursive: true });
    const fd = openSync(lockFile, "wx");
    try {
      writeFileSync(fd, String(pid));
    } finally {
      // fd 保持打开：进程存活期间占住语义；退出后由下一个实例按 pid 判活清理
    }
    return true;
  };
  try {
    writeLock();
    return "watcher";
  } catch {
    let holder;
    try {
      holder = Number(readFileSync(lockFile, "utf8").trim());
    } catch {
      return "idle";
    }
    if (holder === pid || alive(holder)) return "idle";
    // 持锁进程已死，清理后重试一次
    try {
      rmSync(lockFile, { force: true });
    } catch {}
    try {
      writeLock();
      return "watcher";
    } catch {
      return "idle";
    }
  }
}

export function releaseLock(lockFile) {
  try {
    const holder = Number(readFileSync(lockFile, "utf8").trim());
    if (holder === process.pid) rmSync(lockFile, { force: true });
  } catch {}
}
