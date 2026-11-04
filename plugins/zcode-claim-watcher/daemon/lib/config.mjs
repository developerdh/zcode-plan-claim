// 配置加载与校验（纯函数，便于单元测试）
// 配置文件：~/.zcode/zcode-claim-watcher.json（经 ZCODE_CLAIM_WATCHER_CONFIG 可覆盖）
export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  intervalMinutes: 10,
  activeWindows: [],
  notify: { events: ["discovered", "claimed", "failed"], channels: [], failover: true },
});

export const NOTIFY_EVENTS = ["discovered", "claimed", "failed"];
export const NOTIFY_CHANNELS = ["weixin", "feishu"];
export const MIN_INTERVAL_MINUTES = 5;
export const RETENTION_DAYS = 7;
export const MAX_HISTORY_LINES = 1000;

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function normalizeConfig(raw, { minIntervalMinutes = MIN_INTERVAL_MINUTES } = {}) {
  const warnings = [];
  const src = raw && typeof raw === "object" ? raw : {};
  const out = { enabled: true, intervalMinutes: DEFAULT_CONFIG.intervalMinutes, activeWindows: [], notify: { events: [...DEFAULT_CONFIG.notify.events], channels: [], failover: true } };

  if ("enabled" in src && typeof src.enabled !== "boolean") warnings.push("enabled 非布尔值，已重置为 true");
  else if ("enabled" in src) out.enabled = src.enabled;

  if ("intervalMinutes" in src) {
    const n = Number(src.intervalMinutes);
    if (!Number.isFinite(n)) warnings.push(`intervalMinutes 非数字（${JSON.stringify(src.intervalMinutes)}），已重置为 ${out.intervalMinutes}`);
    else {
      const v = Math.max(minIntervalMinutes, Math.round(n));
      if (n < minIntervalMinutes) warnings.push(`intervalMinutes ${n} 低于下限，已钳制为 ${v}`);
      out.intervalMinutes = v;
    }
  }

  if ("activeWindows" in src) {
    if (!Array.isArray(src.activeWindows)) {
      warnings.push("activeWindows 非数组，已忽略");
    } else {
      out.activeWindows = [];
      src.activeWindows.forEach((w, i) => {
        const tag = `activeWindows[${i}]`;
        if (!w || typeof w !== "object") return warnings.push(`${tag} 非对象，已忽略`);
        if (!HHMM.test(w.start ?? "") || !HHMM.test(w.end ?? "")) return warnings.push(`${tag} start/end 缺失或格式非法，已忽略`);
        const entry = { start: w.start, end: w.end };
        const dow = w.daysOfWeek;
        if (dow !== undefined) {
          if (!Array.isArray(dow) || dow.some((x) => !Number.isInteger(x) || x < 0 || x > 6)) return warnings.push(`${tag} daysOfWeek 非法（需 0-6 整数数组），已忽略`);
          if (dow.length) entry.daysOfWeek = [...new Set(dow)].sort((a, b) => a - b);
        }
        const dom = w.daysOfMonth;
        if (dom !== undefined) {
          if (!Array.isArray(dom) || dom.some((x) => !Number.isInteger(x) || x < 1 || x > 31)) return warnings.push(`${tag} daysOfMonth 非法（需 1-31 整数数组），已忽略`);
          if (dom.length) entry.daysOfMonth = [...new Set(dom)].sort((a, b) => a - b);
        }
        out.activeWindows.push(entry);
      });
    }
  }

  if ("notify" in src) {
    if (!src.notify || typeof src.notify !== "object") warnings.push("notify 非对象，已忽略");
    else {
      const n = src.notify;
      if ("events" in n) {
        if (!Array.isArray(n.events)) warnings.push("notify.events 非数组，已忽略");
        else {
          const ev = [...new Set(n.events)].filter((e) => NOTIFY_EVENTS.includes(e));
          const dropped = n.events.filter((e) => !NOTIFY_EVENTS.includes(e));
          if (dropped.length) warnings.push(`notify.events 含未知事件 ${dropped.join(",")}，已忽略（可选：${NOTIFY_EVENTS.join("/")}）`);
          out.notify.events = ev;
        }
      }
      // channels：空=自动（绑定列表第一个启用的渠道）；非空数组=指定渠道（按 provider）
      if ("channels" in n) {
        if (!Array.isArray(n.channels)) {
          warnings.push("notify.channels 非数组，已回退为自动（首个启用的绑定渠道）");
        } else if (n.channels.length) {
          const valid = [];
          const dropped = [];
          for (const c of n.channels) (NOTIFY_CHANNELS.includes(c) ? valid : dropped).push(c);
          if (dropped.length) warnings.push(`notify.channels 含未知渠道 ${dropped.join(",")}，已忽略（可选：${NOTIFY_CHANNELS.join("/") || "无"}）`);
          if (valid.length) out.notify.channels = [...new Set(valid)];
          else warnings.push("notify.channels 无有效渠道，已回退为自动（首个启用的绑定渠道）");
        }
      }
      if ("failover" in n) {
        if (typeof n.failover !== "boolean") warnings.push("notify.failover 非布尔值，已重置为 true");
        else out.notify.failover = n.failover;
      }
    }
  }

  return { config: out, warnings };
}
