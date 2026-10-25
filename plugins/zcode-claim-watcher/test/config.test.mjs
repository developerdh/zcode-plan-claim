import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CONFIG, normalizeConfig, MIN_INTERVAL_MINUTES } from "../mcp/lib/config.mjs";

test("空配置回到默认：enabled=true、间隔=10、无窗口、通知含三类事件、渠道自动、转移开", () => {
  const { config, warnings } = normalizeConfig({});
  assert.deepEqual(config, { enabled: true, intervalMinutes: 10, activeWindows: [], notify: { events: ["discovered", "claimed", "failed"], channels: [], failover: true } });
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

test("notify：events 过滤（discovered/claimed/failed）；channels 未知项丢弃；failover 类型校验", () => {
  const { config, warnings } = normalizeConfig({
    notify: {
      events: ["claimed", "failed", "discovered", 42],
      channels: ["feishu", "feishu", "sms", "weixin"],
      failover: "no",
    },
  });
  assert.deepEqual(config.notify.events, ["claimed", "failed", "discovered"]);
  assert.deepEqual(config.notify.channels, ["feishu", "weixin"]); // 去重保序
  assert.equal(config.notify.failover, true);
  assert.ok(warnings.some((w) => w.includes("42")));
  assert.ok(warnings.some((w) => w.includes("sms")));
  assert.ok(warnings.some((w) => w.includes("failover")));
});

test("notify.channels：非数组回退自动；全非法回退自动；空数组=自动；合法组合原样保留", () => {
  const a = normalizeConfig({ notify: { channels: "weixin" } });
  assert.deepEqual(a.config.notify.channels, []);
  assert.ok(a.warnings.some((w) => w.includes("非数组")));

  const b = normalizeConfig({ notify: { channels: ["sms", "tel"] } });
  assert.deepEqual(b.config.notify.channels, []);
  assert.ok(b.warnings.some((w) => w.includes("无有效渠道")));

  const c = normalizeConfig({ notify: { channels: [] } });
  assert.deepEqual(c.config.notify.channels, []);
  assert.equal(c.warnings.length, 0); // 空数组本就是"自动"的规范化形态

  const d = normalizeConfig({ notify: { channels: ["weixin"], failover: false } });
  assert.deepEqual(d.config.notify, { events: ["discovered", "claimed", "failed"], channels: ["weixin"], failover: false });
  assert.equal(d.warnings.length, 0);
});
