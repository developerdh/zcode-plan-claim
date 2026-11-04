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

export async function saveState(state, file = statePath()) {
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
