#!/usr/bin/env node
// 用法：npm run release 0.2.0 —— 三处版本号统一 bump（保留原格式），提交并打 tag（不推送）。
// 推送后（git push --follow-tags）Release workflow 会跑测试、打 plugin.zip 并创建 GitHub Release。
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version ?? "")) {
  console.error("用法：npm run release <版本号>（如 0.2.0）");
  process.exit(1);
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });

const dirty = git("status", "--porcelain")
  .split("\n")
  .filter((l) => l && !l.startsWith("??"));
if (dirty.length) {
  console.error(`[release] 工作区有未提交改动，请先提交：\n${dirty.join("\n")}`);
  process.exit(1);
}

const files = [
  "package.json",
  "plugins/zcode-claim-watcher/.zcode-plugin/plugin.json",
  ".claude-plugin/marketplace.json",
];
for (const file of files) {
  const path = join(root, file);
  const text = readFileSync(path, "utf8");
  const updated = text.replace(/^(\s*"version":\s*)"[^"]+"/m, `$1"${version}"`);
  if (updated === text) {
    console.error(`[release] ${file} 中未找到 version 字段`);
    process.exit(1);
  }
  writeFileSync(path, updated);
}

git("add", ...files);
git("commit", "-m", `chore: 发布 v${version}`);
git("tag", `v${version}`);
console.log(`[release] 已 bump 到 ${version} 并打标签 v${version}；执行 git push --follow-tags 触发发布`);
