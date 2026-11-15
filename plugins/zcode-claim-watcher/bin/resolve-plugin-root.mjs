// 全局 launcher 的插件根目录解析：npm install -g 装进全局的是本 launcher 的冻结副本，
// 而真正的插件代码随 ZCode 插件安装在版本化缓存目录（zcode plugins update 后出现更高
// 版本目录）。launcher 运行时解析最新版本目录执行，插件升级后全局命令自动跟随，无需重装。
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// 语义化版本比较：前 3 段按数值（0.10.0 > 0.2.0），预发布后缀按字符串兜底（带后缀视为更旧）
// 返回正数 = a 更新，负数 = b 更新，0 = 相同
function compareVersion(a, b) {
  const [coreA, preA] = a.split("-");
  const [coreB, preB] = b.split("-");
  const na = coreA.split(".").map(Number);
  const nb = coreB.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (na[i] || 0) - (nb[i] || 0);
    if (d !== 0) return d;
  }
  return String(preB ?? "").localeCompare(String(preA ?? ""));
}

// 解析当前激活的插件版本目录：
//  1) ZCODE_PLUGIN_ROOT 环境变量硬覆盖（非标准安装位置/调试用）
//  2) 缓存目录 ~/.zcode/cli/plugins/cache/<发布源>/zcode-claim-watcher/<版本> 中
//     语义化版本最高者（发布源段不假定具体名称）；无版本形态的目录忽略
// 找不到时抛错（由 launcher 转为退出码 1 与提示），不做其他路径的猜测
export function resolvePluginRoot({ home = homedir() } = {}) {
  const override = process.env.ZCODE_PLUGIN_ROOT?.trim();
  if (override) return override;
  const base = join(home, ".zcode", "cli", "plugins", "cache");
  let best = null;
  try {
    for (const publisher of readdirSync(base)) {
      let versions;
      try {
        versions = readdirSync(join(base, publisher, "zcode-claim-watcher"));
      } catch {
        continue; // 该发布源下无此插件，跳过
      }
      for (const v of versions) {
        if (!/^\d+\.\d+/.test(v)) continue;
        if (!best || compareVersion(v, best.version) > 0) best = { publisher, version: v };
      }
    }
  } catch {}
  if (!best) {
    throw new Error(
      `未找到已安装的插件缓存（${base}/<发布源>/zcode-claim-watcher/<版本>）。请先安装 zcode-plan-claim 插件，或重跑 /install-zcwatch-cli`,
    );
  }
  return join(base, best.publisher, "zcode-claim-watcher", best.version);
}
