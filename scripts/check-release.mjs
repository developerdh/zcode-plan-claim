#!/usr/bin/env node
// 校验三处版本号一致：package.json / plugin.json / marketplace.json（以 package.json 为基准）。
// 传入发布版本时（如 0.2.0 或 v0.2.0）额外校验三处都与之一致。CI 与 release 流程共用。
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

if (!entry) {
  console.error(`[check] marketplace.json 中找不到插件 ${plugin.name}`);
  process.exit(1);
}

const expected = process.argv[2]?.replace(/^v/, "") ?? pkg.version;
const sources = [
  ["package.json", pkg.version],
  ["plugins/zcode-claim-watcher/.zcode-plugin/plugin.json", plugin.version],
  [".claude-plugin/marketplace.json", entry.version],
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
