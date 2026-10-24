import assert from "node:assert/strict";
import { test } from "node:test";
import { startWatcherLoop } from "../mcp/lib/loop.mjs";
import { planNext } from "../mcp/lib/windows.mjs";

// 手动计时器：记录 schedule 延迟，测试直接驱动回调（确定性验证节拍逻辑）
function fakeTimers() {
  const scheduled = [];
  const timers = {
    setTimeout: (fn, ms) => {
      const t = { fn, ms };
      scheduled.push(t);
      return t;
    },
    clearTimeout: (t) => {
      const i = scheduled.indexOf(t);
      if (i >= 0) scheduled.splice(i, 1);
    },
  };
  return {
    timers,
    scheduled,
    async fire() {
      const t = scheduled.shift();
      if (!t) throw new Error("没有挂起的定时任务");
      await t.fn();
    },
    lastDelay() {
      return scheduled.at(-1)?.ms ?? null;
    },
  };
}

test("loop：启动后按 initialDelay 调度首轮；tick 执行评估并按 interval 排下一轮", async () => {
  const ft = fakeTimers();
  const rounds = [];
  const loop = startWatcherLoop({
    getConfig: () => ({ enabled: true, intervalMinutes: 10, activeWindows: [] }),
    evaluateRound: async (cfg, roundCount, trigger) => rounds.push({ roundCount, trigger }),
    initialDelayMs: 20000,
    planNext,
    timers: ft.timers,
  });
  loop.start();
  assert.equal(ft.lastDelay(), 20000);

  await ft.fire(); // 首轮
  assert.deepEqual(rounds, [{ roundCount: 1, trigger: "schedule" }]);
  assert.equal(ft.lastDelay(), 10 * 60 * 1000); // 之后按 interval 调度

  await ft.fire(); // 第二轮
  assert.equal(rounds.length, 2);
  loop.stop();
});

test("loop：enabled=false 时零评估，仅低频复查", async () => {
  const ft = fakeTimers();
  const rounds = [];
  const loop = startWatcherLoop({
    getConfig: () => ({ enabled: false, intervalMinutes: 10, activeWindows: [] }),
    evaluateRound: async () => rounds.push(1),
    planNext,
    timers: ft.timers,
  });
  loop.start();
  await ft.fire();
  assert.deepEqual(rounds, []);
  assert.equal(ft.lastDelay(), 60 * 1000); // disabledRecheckMs
  loop.stop();
});

test("loop：窗口外不执行评估，按 planNext 睡到窗口开启", async () => {
  const ft = fakeTimers();
  const rounds = [];
  const loop = startWatcherLoop({
    getConfig: () => ({ enabled: true, intervalMinutes: 10, activeWindows: [] }),
    evaluateRound: async () => rounds.push(1),
    planNext: () => ({ type: "sleep", delayMs: 123456 }),
    isDue: () => false,
    timers: ft.timers,
  });
  loop.start();
  await ft.fire();
  assert.deepEqual(rounds, []);
  assert.equal(ft.lastDelay(), 123456);
  loop.stop();
});

test("loop：getConfig 为异步函数时正常评估（回归：漏 await 曾导致静默跳过所有轮询）", async () => {
  const ft = fakeTimers();
  const rounds = [];
  const loop = startWatcherLoop({
    getConfig: async () => ({ enabled: true, intervalMinutes: 10, activeWindows: [] }),
    evaluateRound: async (cfg, roundCount) => rounds.push({ roundCount, enabled: cfg.enabled }),
    planNext,
    timers: ft.timers,
  });
  loop.start();
  await ft.fire();
  assert.deepEqual(rounds, [{ roundCount: 1, enabled: true }]);
  assert.equal(ft.lastDelay(), 10 * 60 * 1000);
  loop.stop();
});

test("loop：evaluateRound 抛错不中断循环，下一轮照常排程", async () => {
  const ft = fakeTimers();
  let calls = 0;
  const loop = startWatcherLoop({
    getConfig: () => ({ enabled: true, intervalMinutes: 10, activeWindows: [] }),
    evaluateRound: async () => {
      calls++;
      if (calls === 1) throw new Error("boom");
    },
    planNext,
    timers: ft.timers,
  });
  loop.start();
  await ft.fire();
  assert.equal(calls, 1);
  assert.equal(ft.lastDelay(), 10 * 60 * 1000);
  await ft.fire();
  assert.equal(calls, 2);
  loop.stop();
});

test("loop：stop 后不再调度，tick 被跳过", async () => {
  const ft = fakeTimers();
  const rounds = [];
  const loop = startWatcherLoop({
    getConfig: () => ({ enabled: true, intervalMinutes: 10, activeWindows: [] }),
    evaluateRound: async () => rounds.push(1),
    planNext,
    timers: ft.timers,
  });
  loop.start();
  loop.stop();
  assert.equal(ft.scheduled.length, 0);
  const r = await loop.tick();
  assert.equal(r.skipped, true);
  assert.deepEqual(rounds, []);
});

test("loop：配置热加载（getConfig 每 tick 重读）", async () => {
  const ft = fakeTimers();
  let enabled = true;
  const rounds = [];
  const loop = startWatcherLoop({
    getConfig: () => ({ enabled, intervalMinutes: 10, activeWindows: [] }),
    evaluateRound: async () => rounds.push(1),
    planNext,
    timers: ft.timers,
  });
  loop.start();
  await ft.fire();
  assert.equal(rounds.length, 1);
  enabled = false; // 热关闭
  await ft.fire();
  assert.equal(rounds.length, 1); // 不再评估
  assert.equal(ft.lastDelay(), 60 * 1000);
  loop.stop();
});
