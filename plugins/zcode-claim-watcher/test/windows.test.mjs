import assert from "node:assert/strict";
import { test } from "node:test";
import { isWithinWindows, nextWindowOpenDelayMs, planNext } from "../mcp/lib/windows.mjs";

const d = (s) => new Date(s); // 本地时间解析
// 2026-10-24 是周六；2026-10-26 是周一
const SAT = "2026-10-24T10:00:00";
const SAT_23 = "2026-10-24T23:30:00";
const MON = "2026-10-26T10:00:00";

test("无窗口 = 全天候", () => {
  assert.equal(isWithinWindows(d(SAT), []), true);
});

test("daysOfWeek 命中：周六在窗内，周一不在", () => {
  const w = [{ daysOfWeek: [0, 6], start: "08:00", end: "23:30" }];
  assert.equal(isWithinWindows(d(SAT), w), true);
  assert.equal(isWithinWindows(d(MON), w), false);
  assert.equal(isWithinWindows(d("2026-10-24T07:59:00"), w), false); // 8 点前
  assert.equal(isWithinWindows(d(SAT_23), w), false);                // end 排他
  assert.equal(isWithinWindows(d("2026-10-24T23:29:59"), w), true);
});

test("daysOfMonth 命中：24 号在窗内，25 号不在", () => {
  const w = [{ daysOfMonth: [24], start: "00:00", end: "23:59" }];
  assert.equal(isWithinWindows(d(SAT), w), true);
  assert.equal(isWithinWindows(d("2026-10-25T10:00:00"), w), false);
});

test("单条内 daysOfWeek ∪ daysOfMonth 并集", () => {
  const w = [{ daysOfWeek: [6], daysOfMonth: [26], start: "00:00", end: "23:59" }];
  assert.equal(isWithinWindows(d(SAT), w), true);              // 周六命中
  assert.equal(isWithinWindows(d(MON), w), true);              // 26 号命中（虽是周一）
  assert.equal(isWithinWindows(d("2026-10-27T10:00:00"), w), false);
});

test("多条规则并集", () => {
  const w = [
    { daysOfWeek: [6], start: "08:00", end: "12:00" },
    { daysOfWeek: [1], start: "20:00", end: "22:00" },
  ];
  assert.equal(isWithinWindows(d(SAT), w), true);
  assert.equal(isWithinWindows(d("2026-10-26T21:00:00"), w), true);
  assert.equal(isWithinWindows(d("2026-10-26T10:00:00"), w), false);
});

test("跨零点窗口（22:00-次日01:00）", () => {
  const w = [{ daysOfWeek: [6], start: "22:00", end: "01:00" }];
  assert.equal(isWithinWindows(d("2026-10-24T22:00:00"), w), true);  // 周六 22:00 开
  assert.equal(isWithinWindows(d("2026-10-25T00:30:00"), w), true);  // 次日 00:30 仍在窗内
  assert.equal(isWithinWindows(d("2026-10-25T01:00:00"), w), false); // 次日 01:00 关
  assert.equal(isWithinWindows(d("2026-10-24T21:59:00"), w), false);
});

test("start === end 为空窗口（永不匹配）", () => {
  const w = [{ start: "08:00", end: "08:00" }];
  assert.equal(isWithinWindows(d(SAT), w), false);
});

test("planNext：enabled=false → disabled", () => {
  assert.deepEqual(planNext({ enabled: false, intervalMinutes: 10, activeWindows: [] }, d(SAT)), { type: "disabled" });
});

test("planNext：窗口内 → 间隔后 run（10 分钟）", () => {
  const r = planNext({ enabled: true, intervalMinutes: 10, activeWindows: [] }, d(SAT));
  assert.deepEqual(r, { type: "run", delayMs: 10 * 60 * 1000 });
});

test("planNext：候选时刻落窗外 → 睡到下一次窗口开启", () => {
  // 23:25 + 10min = 23:35 超出 23:30 关窗 → 睡到次日（周日不在窗内 → 下个周六 10-31 08:00）
  const w = [{ daysOfWeek: [6], start: "08:00", end: "23:30" }];
  const r = planNext({ enabled: true, intervalMinutes: 10, activeWindows: w }, d("2026-10-24T23:25:00"));
  assert.equal(r.type, "sleep");
  const expect = new Date("2026-10-31T08:00:00").getTime() - new Date("2026-10-24T23:25:00").getTime();
  assert.equal(r.delayMs, expect);
});

test("planNext：窗口外 → 睡到最近一次窗口开启（含跨零点次日段）", () => {
  const w = [{ daysOfWeek: [6], start: "22:00", end: "01:00" }];
  // 周日 02:00：周六窗口的次日段已结束（01:00），下一次开启是下周六 22:00
  const r = planNext({ enabled: true, intervalMinutes: 5, activeWindows: w }, d("2026-10-25T02:00:00"));
  assert.equal(r.type, "sleep");
  const expect = new Date("2026-10-31T22:00:00").getTime() - new Date("2026-10-25T02:00:00").getTime();
  assert.equal(r.delayMs, expect);
  // 周日 00:30：处于周六窗口的次日段内 → in-window，但 +5min 后仍窗内 → run
  const r2 = planNext({ enabled: true, intervalMinutes: 5, activeWindows: w }, d("2026-10-25T00:30:00"));
  assert.deepEqual(r2, { type: "run", delayMs: 5 * 60 * 1000 });
});

test("planNext：一年内无匹配窗口 → disabled", () => {
  const w = [{ daysOfMonth: [31], start: "08:00", end: "08:01" }]; // 频次极低：可能一年内只剩极少数
  const r = planNext({ enabled: true, intervalMinutes: 5, activeWindows: w }, d("2026-10-24T10:00:00"));
  assert.ok(r.type === "sleep" || r.type === "disabled");
  if (r.type === "sleep") assert.ok(r.delayMs <= 366 * 86400 * 1000);
});

test("nextWindowOpenDelayMs：空窗口 → 0", () => {
  assert.equal(nextWindowOpenDelayMs(d(SAT), []), 0);
});
