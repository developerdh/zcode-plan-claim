// 共享状态文件（与 claim.mjs 同一文件 ~/.zcode/zcode-plan-claim-state.json）
// 记录已领取/终态套餐、通知去重与失败冷却，用于跨轮次判定
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export function statePath() {
  return process.env.ZCODE_CLAIM_STATE_FILE ?? join(homedir(), ".zcode", "zcode-plan-claim-state.json");
}

export async function loadState(file = statePath()) {
  try {
    const s = JSON.parse(await readFile(file, "utf8"));
    if (s && typeof s === "object" && s.plans && typeof s.plans === "object") return s;
  } catch {}
  return { version: 1, plans: {} };
}

// 过期记录清理（与 claim.mjs 的 saveState 同口径）：endsAt 已过的条目落盘时移除，
// 避免状态文件长期累积无效历史。服务端不会向已结束活动下发卡片，已领记录被清后即使
// 异常重发卡片，领取也命中 1001~1005 终态码不会重复扣量；无 endsAt 的记录无法判定时效，保留
export function pruneExpiredPlans(state, nowMs = Date.now()) {
  for (const [planId, p] of Object.entries(state.plans ?? {})) {
    const ends = p?.endsAt ? Date.parse(p.endsAt) : NaN;
    if (Number.isFinite(ends) && ends < nowMs) delete state.plans[planId];
  }
}

export async function saveState(state, file = statePath()) {
  pruneExpiredPlans(state);
  try {
    await writeFile(file, JSON.stringify(state, null, 2) + "\n");
    return true;
  } catch {
    return false;
  }
}

export function alreadyHandled(state, planId) {
  return Boolean(state.plans[planId]?.claimedAt);
}

export function markPlan(state, planId, patch) {
  const now = new Date().toISOString();
  const prev = state.plans[planId] ?? {};
  state.plans[planId] = { ...prev, planId, lastSeenAt: now, ...patch };
}

export function shouldNotify(state, planId, event, cooldownMs = 6 * 3600 * 1000, now = Date.now()) {
  const last = state.plans[planId]?.notified?.[event];
  if (last && now - Date.parse(last) < cooldownMs) return false;
  return true;
}

export function markNotified(state, planId, event, now = Date.now()) {
  const entry = state.plans[planId] ?? {};
  entry.notified = { ...(entry.notified ?? {}), [event]: new Date(now).toISOString() };
  state.plans[planId] = entry;
}
