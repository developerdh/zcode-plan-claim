import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendRound, readRounds, summarize } from "../mcp/lib/history.mjs";

function tmpFile() {
  const dir = mkdtempSync(join(tmpdir(), "claim-watcher-hist-"));
  const file = join(dir, "history.jsonl");
  return { dir, file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("追加与读取：空文件 → 一轮；按 outcome/since 过滤", () => {
  const { file, cleanup } = tmpFile();
  try {
    appendRound(file, { ts: "2026-10-24T08:00:00.000Z", round: 1, trigger: "schedule", outcome: "empty" });
    appendRound(file, { ts: "2026-10-24T08:10:00.000Z", round: 2, trigger: "manual", outcome: "claimed", planId: "p1" });
    appendRound(file, { ts: "2026-10-24T08:20:00.000Z", round: 3, trigger: "schedule", outcome: "failed", reason: "x" });

    const all = readRounds(file, { limit: 10 });
    assert.equal(all.total, 3);
    assert.equal(all.rounds.length, 3);

    const claimed = readRounds(file, { outcome: "claimed" });
    assert.equal(claimed.matched, 1);
    assert.equal(claimed.rounds[0].planId, "p1");

    const since = readRounds(file, { since: "2026-10-24T08:15:00.000Z" });
    assert.equal(since.matched, 1);
    assert.equal(since.rounds[0].round, 3);

    const limited = readRounds(file, { limit: 2 });
    assert.equal(limited.total, 3);
    assert.equal(limited.rounds.length, 2);
    assert.equal(limited.rounds[0].round, 2); // 时间正序的尾部切片
  } finally { cleanup(); }
});

test("轮换：行数上限 1000（保留最新）", () => {
  const { file, cleanup } = tmpFile();
  try {
    for (let i = 0; i < 1005; i++) {
      appendRound(file, { ts: new Date(Date.now() - (1005 - i) * 1000).toISOString(), round: i, outcome: "empty" });
    }
    const full = readRounds(file, { limit: 1000 });
    assert.equal(full.total, 1000);
    assert.equal(full.rounds[0].round, 5);     // 最旧的 5 条被截断
    assert.equal(full.rounds.at(-1).round, 1004); // 最新保留
    const tail = readRounds(file, { limit: 100 });
    assert.equal(tail.rounds[0].round, 905);   // limit 切片返回尾部 100 条
  } finally { cleanup(); }
});

test("轮换：7 天前的记录丢弃", () => {
  const { file, cleanup } = tmpFile();
  try {
    const old = new Date(Date.now() - 8 * 86400 * 1000).toISOString();
    const fresh = new Date(Date.now() - 1000).toISOString();
    appendRound(file, { ts: old, round: 0, outcome: "empty" });
    appendRound(file, { ts: fresh, round: 1, outcome: "empty" });
    const r = readRounds(file, { limit: 10 });
    assert.equal(r.total, 1);
    assert.equal(r.rounds[0].round, 1);
  } finally { cleanup(); }
});

test("summarize：总数与按结果计数、最近关键轮", () => {
  const { file, cleanup } = tmpFile();
  try {
    appendRound(file, { ts: "2026-10-24T08:00:00.000Z", outcome: "empty" });
    appendRound(file, { ts: "2026-10-24T08:10:00.000Z", outcome: "claimed", planName: "X" });
    appendRound(file, { ts: "2026-10-24T08:20:00.000Z", outcome: "failed", reason: "y" });
    const s = summarize(file);
    assert.equal(s.total, 3);
    assert.deepEqual(s.byOutcome, { empty: 1, claimed: 1, failed: 1 });
    assert.equal(s.lastKeyRound.outcome, "failed");
  } finally { cleanup(); }
});

test("损坏行容错：非 JSON 行被忽略，不破坏读写", () => {
  const { file, cleanup } = tmpFile();
  try {
    writeFileSync(file, "not-json\n" + JSON.stringify({ ts: new Date().toISOString(), outcome: "empty" }) + "\n");
    appendRound(file, { ts: new Date().toISOString(), outcome: "empty" });
    const r = readRounds(file, { limit: 10 });
    assert.equal(r.total, 2);
    assert.equal(readFileSync(file, "utf8").includes("not-json"), false); // 轮换时清洗掉
  } finally { cleanup(); }
});
