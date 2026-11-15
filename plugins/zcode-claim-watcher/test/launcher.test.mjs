// 全局 launcher 插件根目录解析测试（方案 C 的核心保证：运行时自适应最新版本目录）
import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePluginRoot } from "../bin/resolve-plugin-root.mjs";

const ENV_ROOT = process.env.ZCODE_PLUGIN_ROOT;

test("launcher：ZCODE_PLUGIN_ROOT 硬覆盖优先于缓存扫描", () => {
  process.env.ZCODE_PLUGIN_ROOT = "D:/custom/plugin-root";
  try {
    assert.equal(resolvePluginRoot({ home: "unused" }), "D:/custom/plugin-root");
  } finally {
    if (ENV_ROOT === undefined) delete process.env.ZCODE_PLUGIN_ROOT;
    else process.env.ZCODE_PLUGIN_ROOT = ENV_ROOT;
  }
});

test("launcher：缓存中取语义化版本最高目录（数值比较，0.10.0 > 0.2.0）", () => {
  const home = join(tmpdir(), "claim-launcher-pick-" + String(Math.random()).slice(2));
  const pluginBase = join(home, ".zcode", "cli", "plugins", "cache", "zcode-plan-claim", "zcode-claim-watcher");
  for (const v of ["0.1.0", "0.2.0", "0.10.0", "latest"]) {
    mkdirSync(join(pluginBase, v), { recursive: true });
  }
  // 另一个发布源下同插件更高版本：发布源段不假定，也应参与竞争
  mkdirSync(join(home, ".zcode", "cli", "plugins", "cache", "other-source", "zcode-claim-watcher", "0.9.0"), { recursive: true });
  try {
    assert.equal(resolvePluginRoot({ home }), join(pluginBase, "0.10.0"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("launcher：缓存缺失 → 抛错并提示安装/重装路径", () => {
  const home = join(tmpdir(), "claim-launcher-empty-" + String(Math.random()).slice(2));
  try {
    assert.throws(() => resolvePluginRoot({ home }), /install-zcwatch-cli/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
