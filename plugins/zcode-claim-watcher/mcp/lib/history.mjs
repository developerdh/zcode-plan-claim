// 轮次历史：JSONL 追加 + 轮换（7 天且 ≤1000 行，保留最新）+ 过滤读取
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { RETENTION_DAYS, MAX_HISTORY_LINES } from "./config.mjs";

function readLines(file) {
  if (!existsSync(file)) return [];
  try {
    return readFileSync(file, "utf8").split("\n").filter((l) => l.trim());
  } catch {
    return [];
  }
}

function parseLine(line) {
  try {
    const r = JSON.parse(line);
    return r && typeof r === "object" ? r : null;
  } catch {
    return null;
  }
}

// 追加一轮记录并执行轮换；record 至少包含 ts(ISO) 与 outcome
export function appendRound(file, record) {
  const lines = readLines(file);
  lines.push(JSON.stringify(record));
  const cutoff = Date.now() - RETENTION_DAYS * 86400 * 1000;
  let kept = lines.filter((l) => {
    const r = parseLine(l);
    return r && typeof r.ts === "string" && Date.parse(r.ts) >= cutoff;
  });
  if (kept.length > MAX_HISTORY_LINES) kept = kept.slice(-MAX_HISTORY_LINES);
  writeFileSync(file, kept.length ? kept.join("\n") + "\n" : "");
  return record;
}

// 过滤读取：返回 { total, matched, rounds }；rounds 为时间正序的尾部切片
export function readRounds(file, { limit = 10, outcome, since, until } = {}) {
  const all = readLines(file).map(parseLine).filter(Boolean);
  const matched = all.filter((r) => {
    if (outcome && r.outcome !== outcome) return false;
    if (since && Date.parse(r.ts) < Date.parse(since)) return false;
    if (until && Date.parse(r.ts) > Date.parse(until)) return false;
    return true;
  });
  const tail = matched.slice(-Math.max(1, limit));
  return { total: all.length, matched: matched.length, rounds: tail };
}

// 汇总统计（全部保留轮次）
export function summarize(file) {
  const all = readLines(file).map(parseLine).filter(Boolean);
  const byOutcome = {};
  let lastKeyRound = null;
  for (const r of all) {
    byOutcome[r.outcome] = (byOutcome[r.outcome] ?? 0) + 1;
    if (r.outcome === "claimable" || r.outcome === "claimed" || r.outcome === "failed") lastKeyRound = r;
  }
  return { total: all.length, byOutcome, lastKeyRound };
}
