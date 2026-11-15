#!/usr/bin/env node
// 校验五处版本号一致（以 package.json 为基准）：package.json / 插件 plugin.json /
// 远端 marketplace.json / 插件包 package.json（全局 npm 包）/ 本地 marketplace.json。
// 传入发布版本时（如 0.2.0 或 v0.2.0）额外校验五处都与之一致。CI 与 release 流程共用。
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const plugin = JSON.parse(
  readFileSync(join(root, "plugins/zcode-claim-watcher/.zcode-plugin/plugin.json"), "utf8"),
);
const marketplace = JSON.parse(readFileSync(join(root, ".claude-plugin/marketplace.json"), "utf8"));
const entry = marketplace.plugins.find((p) => p.name === plugin.name);
const npmPkg = JSON.parse(readFileSync(join(root, "plugins/zcode-claim-watcher/package.json"), "utf8"));
const localMarketplace = JSON.parse(readFileSync(join(root, "plugins/marketplace.json"), "utf8"));
const localEntry = localMarketplace.plugins.find((p) => p.name === plugin.name);

if (!entry) {
  console.error(`[check] marketplace.json 中找不到插件 ${plugin.name}`);
  process.exit(1);
}
if (!localEntry) {
  console.error(`[check] plugins/marketplace.json 中找不到插件 ${plugin.name}`);
  process.exit(1);
}

const expected = process.argv[2]?.replace(/^v/, "") ?? pkg.version;
const sources = [
  ["package.json", pkg.version],
  ["plugins/zcode-claim-watcher/.zcode-plugin/plugin.json", plugin.version],
  [".claude-plugin/marketplace.json", entry.version],
  ["plugins/zcode-claim-watcher/package.json", npmPkg.version],
  ["plugins/marketplace.json", localEntry.version],
];

let ok = true;
for (const [file, version] of sources) {
  const match = version === expected;
  if (!match) ok = false;
  console.log(`${match ? "✅" : "❌"} ${file}: ${version}${process.argv[2] ? `（期望 ${expected}）` : ""}`);
}
if (!ok) {
  console.error("[check] 版本号不一致，请运行 npm run release 统一维护");
  process.exit(1);
}
