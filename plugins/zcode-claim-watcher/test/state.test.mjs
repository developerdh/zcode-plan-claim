import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadState, saveState, alreadyHandled, markPlan, shouldNotify, markNotified } from "../mcp/lib/state.mjs";

function tmpState() {
  const dir = mkdtempSync(join(tmpdir(), "claim-watcher-state-"));
  const file = join(dir, "state.json");
  return { file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("状态读写与 alreadyHandled", async () => {
  const { file, cleanup } = tmpState();
  try {
    assert.deepEqual(await loadState(file), { version: 1, plans: {} });
    const st = await loadState(file);
    markPlan(st, "p1", { claimedAt: new Date().toISOString(), name: "X" });
    await saveState(st, file);
    const re = await loadState(file);
    assert.equal(alreadyHandled(re, "p1"), true);
    assert.equal(alreadyHandled(re, "p2"), false);
    assert.equal(re.plans.p1.name, "X");
  } finally { cleanup(); }
});

test("通知冷却：同事件 6 小时内只发一次", async () => {
  const { file, cleanup } = tmpState();
  try {
    const st = await loadState(file);
    assert.equal(shouldNotify(st, "p1", "failed"), true);
    markNotified(st, "p1", "failed");
    assert.equal(shouldNotify(st, "p1", "failed"), false);
    assert.equal(shouldNotify(st, "p1", "claimed"), true); // 不同事件独立
    assert.equal(shouldNotify(st, "p2", "failed"), true);  // 不同套餐独立
    // 冷却期过后恢复
    markPlan(st, "p1", {});
    st.plans.p1.notified.failed = new Date(Date.now() - 7 * 3600 * 1000).toISOString();
    assert.equal(shouldNotify(st, "p1", "failed"), true);
  } finally { cleanup(); }
});

test("损坏/缺失文件回退默认结构", async () => {
  const { file, cleanup } = tmpState();
  try {
    writeFileSync(file, "{broken");
    assert.deepEqual(await loadState(file), { version: 1, plans: {} });
  } finally { cleanup(); }
});
