#!/usr/bin/env node
// 把技能脚本同步进监控插件，保证领取逻辑单源（skills/ 是唯一源）。
// 用法：npm run sync  （技能内容变更后、插件安装/更新前运行）
import { cpSync, existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "skills", "zcode-plan-claim");
const dest = join(root, "plugins", "zcode-claim-watcher", "skills", "zcode-plan-claim");

if (!existsSync(src)) {
  console.error(`[sync] 源目录不存在: ${src}`);
  process.exit(1);
}
rmSync(dest, { recursive: true, force: true });
cpSync(src, dest, { recursive: true, filter: (s) => !s.includes(`${sep}tests`) });

let files = 0;
const walk = (d) => {
  for (const e of readdirSync(d)) {
    const p = join(d, e);
    if (statSync(p).isDirectory()) walk(p);
    else files++;
  }
};
walk(dest);
console.log(`[sync] 已同步 ${files} 个文件 → plugins/zcode-claim-watcher/skills/zcode-plan-claim/`);
