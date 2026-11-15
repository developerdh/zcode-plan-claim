#!/usr/bin/env node
// zcode-claim 全局入口（launcher）：npm install -g 装入全局的是本文件的冻结副本，实际执行的
// 技能脚本运行时按插件缓存的最新版本目录解析（见 bin/resolve-plugin-root.mjs）——
// 插件升级后全局命令自动跟随新版本，无需重跑安装命令
import { spawn } from "node:child_process";
import { join } from "node:path";
import { resolvePluginRoot } from "./resolve-plugin-root.mjs";

let root;
try {
  root = resolvePluginRoot();
} catch (e) {
  console.error(`[zcode-claim] ${String(e?.message ?? e)}`);
  process.exit(1);
}
const child = spawn(
  process.execPath,
  [join(root, "skills", "zcode-plan-claim", "scripts", "claim.mjs"), ...process.argv.slice(2)],
  {
    stdio: "inherit",
    ...(process.platform === "win32" ? { windowsHide: true } : {}),
  },
);
child.on("exit", (code) => {
  process.exitCode = code ?? 0;
});
