#!/usr/bin/env node
// 把技能脚本与 daemon 服务同步进监控插件，保证单源（skills/ 与 daemon/ 是唯一源）。
// 用法：npm run sync  （源内容变更后、插件安装/更新前运行）
import { cpSync, existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pluginDir = join(root, "plugins", "zcode-claim-watcher");

function sync({ label, src, dest, excludes = [] }) {
  if (!existsSync(src)) {
    console.error(`[sync] 源目录不存在: ${src}`);
    process.exit(1);
  }
  rmSync(dest, { recursive: true, force: true });
  cpSync(src, dest, { recursive: true, filter: (s) => !excludes.some((e) => s.includes(`${sep}${e}${sep}`) || s.endsWith(`${sep}${e}`)) });
  let files = 0;
  const walk = (d) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else files++;
    }
  };
  walk(dest);
  console.log(`[sync] ${label}：已同步 ${files} 个文件 → ${dest.slice(root.length + 1)}/`);
}

sync({
  label: "技能",
  src: join(root, "skills", "zcode-plan-claim"),
  dest: join(pluginDir, "skills", "zcode-plan-claim"),
  excludes: ["tests"],
});

sync({
  label: "daemon",
  src: join(root, "daemon"),
  dest: join(pluginDir, "daemon"),
  excludes: ["test"],
});
