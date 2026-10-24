// 监控轮询循环：定时决策（windows.planNext / isDue）与轮次执行的解耦，便于注入测试
// 节拍（已冻结）：启动后 initialDelayMs 首轮；此后每轮结束后间隔 intervalMinutes 再评估；
//              每次评估前检查是否 due（enabled 且在窗口内）：不 due 则睡到窗口开启；
//              enabled=false 时零 HTTP，仅低频复查配置

import { isWithinWindows } from "./windows.mjs";

export function startWatcherLoop({
  getConfig,          // () => config | Promise<config>（每 tick 热加载；支持同步或异步）
  evaluateRound,      // async (cfg, roundCount, trigger) => void；仅 due 时被调用
  initialDelayMs = 20 * 1000,
  disabledRecheckMs = 60 * 1000,
  planNext,           // lib/windows.mjs 的 planNext
  isDue = (cfg, now) => isWithinWindows(now, cfg.activeWindows ?? []),
  logger = () => {},
  timers = { setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms), clearTimeout: (t) => globalThis.clearTimeout(t) },
} = {}) {
  let timer = null;
  let stopped = false;
  let running = false;
  let roundCount = 0;

  function schedule(delayMs, why) {
    if (stopped) return;
    logger(`调度 ${why}：${Math.round(delayMs / 1000)}s 后`);
    timer = timers.setTimeout(() => {
      timer = null;
      tick().catch((e) => logger(`tick 异常: ${e?.message ?? e}`));
    }, delayMs);
  }

  async function tick(trigger = "schedule") {
    if (stopped || running) return { skipped: true };
    const cfg = await getConfig(); // 必须等待：getConfig 可能是异步（读配置文件）
    if (!cfg?.enabled) {
      schedule(disabledRecheckMs, "已停用，低频复查配置");
      return { skipped: true, disabled: true };
    }
    const now = new Date();
    if (!isDue(cfg, now)) {
      // 窗口外：不评估，睡到下一次窗口开启
      const d = planNext(cfg, now);
      schedule(d.type === "sleep" ? d.delayMs : disabledRecheckMs, "窗口外，睡到窗口开启");
      return { skipped: true, outsideWindow: true };
    }
    running = true;
    let outcome;
    try {
      roundCount += 1;
      outcome = await evaluateRound(cfg, roundCount, trigger);
    } catch (e) {
      logger(`轮次执行异常（循环继续）: ${e?.message ?? e}`);
    } finally {
      running = false;
    }
    if (stopped) return { roundCount };
    const d = planNext(cfg, new Date());
    if (d.type === "run") schedule(d.delayMs, "间隔到点");
    else if (d.type === "sleep") schedule(d.delayMs, "窗口外，睡到窗口开启");
    else schedule(disabledRecheckMs, "已停用，低频复查配置");
    return { roundCount, outcome };
  }

  return {
    start() {
      stopped = false;
      schedule(initialDelayMs);
    },
    stop() {
      stopped = true;
      if (timer) timers.clearTimeout(timer);
      timer = null;
    },
    tick,
    get roundCount() {
      return roundCount;
    },
    get running() {
      return running || timer !== null;
    },
  };
}
