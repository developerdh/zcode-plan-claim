// 时间窗匹配与下一次轮询决策（纯函数）
// 窗口语义（已冻结）：
//   - 单条内 daysOfWeek 与 daysOfMonth 取并集（任一命中即该日有效），都缺省 = 每天
//   - 多条规则之间取并集
//   - start > end 视为跨零点（窗口从当天 start 到次日 end）；start === end 为空窗口（永不匹配）
//   - activeWindows 缺省/为空 = 全天候

const MIN = 60 * 1000;

export function parseHHMM(s) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(s ?? "");
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function dayMatches(date, entry) {
  const hasDow = Array.isArray(entry.daysOfWeek) && entry.daysOfWeek.length > 0;
  const hasDom = Array.isArray(entry.daysOfMonth) && entry.daysOfMonth.length > 0;
  if (!hasDow && !hasDom) return true;
  const dow = date.getDay();
  const dom = date.getDate();
  const dowHit = hasDow && entry.daysOfWeek.includes(dow);
  const domHit = hasDom && entry.daysOfMonth.includes(dom);
  return Boolean(dowHit || domHit);
}

function minuteOfDay(date) {
  return date.getHours() * 60 + date.getMinutes();
}

function entryHoldsAt(entry, date) {
  const S = parseHHMM(entry.start);
  const E = parseHHMM(entry.end);
  if (S === null || E === null || S === E) return false;
  const m = minuteOfDay(date);
  if (S < E) return dayMatches(date, entry) && m >= S && m < E;
  // 跨零点：[当天 S, 24:00) ∪ [次日 0:00, E)
  const yest = new Date(date.getFullYear(), date.getMonth(), date.getDate() - 1, date.getHours(), date.getMinutes());
  return (dayMatches(date, entry) && m >= S) || (dayMatches(yest, entry) && m < E);
}

export function isWithinWindows(date, windows) {
  if (!Array.isArray(windows) || windows.length === 0) return true;
  return windows.some((w) => entryHoldsAt(w, date));
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

// 距下一次窗口开启的毫秒数；扫描上限 maxScanDays 天，找不到返回 null
export function nextWindowOpenDelayMs(date, windows, { maxScanDays = 366 } = {}) {
  if (!Array.isArray(windows) || windows.length === 0) return 0;
  const t = date.getTime();
  const base = startOfDay(date);
  let best = null;
  for (let d = 0; d <= maxScanDays; d++) {
    const day = new Date(base.getFullYear(), base.getMonth(), base.getDate() + d);
    for (const entry of windows) {
      const S = parseHHMM(entry.start);
      const E = parseHHMM(entry.end);
      if (S === null || E === null || S === E) continue;
      if (!dayMatches(day, entry)) continue;
      const open = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, S).getTime();
      if (open > t && (best === null || open < best)) best = open;
      if (S > E) {
        // 跨零点窗口的“次日 0:00 段”开启时刻 = 匹配日的次日 00:00
        const open2 = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).getTime();
        if (open2 > t && (best === null || open2 < best)) best = open2;
      }
    }
  }
  return best === null ? null : best - t;
}

// 决策：下一次该做什么。
//   {type:"run", delayMs}      —— delayMs 后执行一轮（窗口内：从现在起算 intervalMinutes）
//   {type:"sleep", delayMs}    —— 窗口外：睡到窗口开启
//   {type:"disabled"}          —— 总开关关闭
// 约定：若“现在 + intervalMinutes”落在窗口外，则不执行该轮，直接睡到下一次窗口开启。
export function planNext(config, now = new Date()) {
  if (!config?.enabled) return { type: "disabled" };
  const intervalMs = Math.max(1, config.intervalMinutes ?? 10) * MIN;
  const candidate = new Date(now.getTime() + intervalMs);
  if (isWithinWindows(now, config.activeWindows) && isWithinWindows(candidate, config.activeWindows)) {
    return { type: "run", delayMs: intervalMs };
  }
  const sleep = nextWindowOpenDelayMs(now, config.activeWindows);
  if (sleep === null) return { type: "disabled" }; // 一年内没有匹配窗口
  return { type: "sleep", delayMs: sleep };
}
