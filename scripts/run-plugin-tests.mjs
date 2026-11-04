#!/usr/bin/env node
// 插件 + daemon 测试统一入口：收集两个测试目录下的 *.test.mjs 后以显式文件列表交给 node --test。
// 之所以不用目录参数：Node ≥21 的 --test 把目录当模块入口（MODULE_NOT_FOUND），Node ≤20 又不支持
// glob 模式——显式文件列表在 18/20/22+ 行为一致。
// 用法：npm run test:plugin
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dirs = [join(root, "plugins", "zcode-claim-watcher", "test"), join(root, "daemon", "test")];

const files = [];
for (const dir of dirs) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    console.error(`[test:plugin] 测试目录不存在: ${dir}`);
    process.exit(1);
  }
  for (const e of entries) {
    if (e.endsWith(".test.mjs")) files.push(join(dir, e));
  }
}

console.log(`[test:plugin] ${files.length} 个测试文件：`);
for (const f of files) console.log(`  - ${f.slice(root.length + 1)}`);

const r = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit", cwd: root });
process.exit(r.status ?? 1);
