import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CONFIG, normalizeConfig, MIN_INTERVAL_MINUTES } from "../mcp/lib/config.mjs";

test("空配置回到默认：enabled=true、间隔=10、无窗口、通知含三类事件", () => {
  const { config, warnings } = normalizeConfig({});
  assert.deepEqual(config, { enabled: true, intervalMinutes: 10, activeWindows: [], notify: { events: ["discovered", "claimed", "failed"] } });
  assert.equal(warnings.length, 0);
  assert.equal(DEFAULT_CONFIG.intervalMinutes, 10);
});

test("间隔钳制：低于下限 5 分钟强制抬升并告警；非数字回退默认", () => {
  const a = normalizeConfig({ intervalMinutes: 2 });
  assert.equal(a.config.intervalMinutes, MIN_INTERVAL_MINUTES);
  assert.ok(a.warnings.some((w) => w.includes("钳制")));
  const b = normalizeConfig({ intervalMinutes: "abc" });
  assert.equal(b.config.intervalMinutes, 10);
  assert.ok(b.warnings.length > 0);
});

test("enabled 类型错误重置为 true", () => {
  const { config, warnings } = normalizeConfig({ enabled: "yes" });
  assert.equal(config.enabled, true);
  assert.ok(warnings.some((w) => w.includes("enabled")));
});

test("时间窗：合法条目保留，非法条目丢弃并告警", () => {
  const { config, warnings } = normalizeConfig({
    activeWindows: [
      { daysOfWeek: [6, 0], daysOfMonth: [24, 24, 1], start: "08:00", end: "23:30" }, // 去重
      { start: "8:00", end: "23:30" },      // 小时缺前导零 → 丢弃
      { start: "08:00", end: "24:00" },     // 24:00 非法 → 丢弃
      { daysOfWeek: [7, 9], start: "08:00", end: "09:00" },  // 0-6 之外 → 丢弃
      { daysOfMonth: [0, 32], start: "08:00", end: "09:00" },// 1-31 之外 → 丢弃
      { daysOfWeek: "sat", start: "08:00", end: "09:00" },   // 非数组 → 丢弃
      "not-an-object",                                        // 非对象 → 忽略
    ],
  });
  assert.equal(config.activeWindows.length, 1);
  assert.deepEqual(config.activeWindows[0], { start: "08:00", end: "23:30", daysOfWeek: [0, 6], daysOfMonth: [1, 24] });
  assert.equal(warnings.length, 6);
});

test("notify：events 过滤（discovered/claimed/failed），channels 已废弃", () => {
  const { config, warnings } = normalizeConfig({
    notify: {
      events: ["claimed", "failed", "discovered", 42],
      channels: [{ type: "webhook", url: "https://a.b" }],
    },
  });
  assert.deepEqual(config.notify.events, ["claimed", "failed", "discovered"]);
  assert.equal(config.notify.channels, undefined);
  assert.ok(warnings.some((w) => w.includes("discovered")));
  assert.ok(warnings.some((w) => w.includes("已废弃")));
});
