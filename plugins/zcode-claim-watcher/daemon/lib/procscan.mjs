// 跨平台 ZCode 进程检测：daemon 自退出判定用（daemon 在 ZCode 不在运行时自省资源）。
//  - win32：tasklist /NH /FO CSV（比 PowerShell 快约 1s），镜像名匹配 /^zcode(\.exe)?$/i
//  - darwin/linux：pgrep -ix zcode（精确名匹配；禁止 -f 全命令行匹配——会命中 daemon 自身路径
//    ".../zcode-plan-claim/..."）；pgrep 不可用时 linux 回退扫 /proc/*/comm
//  - 排除自身 pid；ZCODE_DAEMON_PROCESS_RE 环境变量可覆盖默认正则（发行版进程名有差异的兜底，
//    非法正则忽略并告警；设置后按名称枚举匹配：linux 走 /proc、darwin 走 ps -axo comm=）
// 实现为可注入 runner/平台/文件系统参数的纯逻辑 + 薄壳，便于单测。
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir, readFile } from "node:fs/promises";

const execFileP = promisify(execFile);

export const DEFAULT_PROCESS_RE = /^zcode(\.exe)?$/i;

// env 值 → 正则；空值返回 null（用默认），非法返回 null 并告警
export function compileProcessRe(raw, logger = () => {}) {
  if (!raw) return null;
  try {
    return new RegExp(raw, "i");
  } catch {
    logger(`警告：ZCODE_DAEMON_PROCESS_RE 非法正则（${raw}），已忽略`);
    return null;
  }
}

// tasklist /NH /FO CSV 每行首列为镜像名；名称可含逗号且引号内转义为 ""，按引号字段解析
export function parseTasklistNames(output) {
  const names = [];
  for (const line of String(output ?? "").split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const m = /^"((?:""|[^"])*)"/.exec(t);
    const name = m ? m[1].split('""').join('"') : "";
    if (name) names.push(name);
  }
  return names;
}

export function parsePgrepPids(output) {
  return String(output ?? "")
    .split(/\s+/)
    .map((s) => Number(s))
    .filter((n) => Number.isInteger(n) && n > 0);
}

// /proc/*/comm 枚举（linux pgrep 缺失时的回退）；返回 [{pid, name}]
export async function listProcComm({ readdirImpl = readdir, readFileImpl = readFile, selfPid } = {}) {
  const out = [];
  let entries;
  try {
    entries = await readdirImpl("/proc");
  } catch {
    return out;
  }
  for (const e of entries) {
    const pid = Number(e);
    if (!Number.isInteger(pid) || pid <= 0 || pid === selfPid) continue;
    try {
      out.push({ pid, name: (await readFileImpl(`/proc/${e}/comm`, "utf8")).trim() });
    } catch {}
  }
  return out;
}

function isNoMatch(e) {
  return e && typeof e.code === "number" && e.code === 1; // pgrep 无匹配退出码 1
}

function isMissingBinary(e) {
  return e?.code === "ENOENT";
}

function basename(p) {
  return String(p).trim().split(/[\\/]/).pop() ?? "";
}

// 任一匹配即 true；检测命令本身失败时抛出（调用方保守处理，如视为在运行）
export async function isZcodeRunning({
  runner,                 // async (cmd, args) => {stdout}；缺省 execFile
  platform = process.platform,
  selfPid = process.pid,
  processRe,              // 已编译正则；缺省从 env.ZCODE_DAEMON_PROCESS_RE 编译，仍缺省用 DEFAULT
  env = process.env,
  logger = () => {},
  readdirImpl,
  readFileImpl,
} = {}) {
  const re = processRe ?? compileProcessRe(env?.ZCODE_DAEMON_PROCESS_RE?.trim?.(), logger) ?? DEFAULT_PROCESS_RE;
  const run = runner ?? ((cmd, args) => execFileP(cmd, args, { timeout: 8000, windowsHide: true }));

  if (platform === "win32") {
    const { stdout } = await run("tasklist", ["/NH", "/FO", "CSV"]);
    return parseTasklistNames(stdout).some((n) => re.test(n));
  }

  // 自定义正则 / pgrep 不可用时需要按名称枚举：linux /proc、darwin ps
  const listNames = async () => {
    if (platform === "darwin") {
      const { stdout } = await run("ps", ["-axo", "comm="]);
      return stdout.split(/\r?\n/).filter((l) => l.trim()).map(basename);
    }
    return (await listProcComm({ readdirImpl, readFileImpl, selfPid })).map((e) => e.name);
  };

  if (processRe || env?.ZCODE_DAEMON_PROCESS_RE) {
    return (await listNames()).some((n) => re.test(n));
  }

  try {
    const { stdout } = await run("pgrep", ["-ix", "zcode"]);
    return parsePgrepPids(stdout).some((p) => p !== selfPid);
  } catch (e) {
    if (isNoMatch(e)) return false;
    if (isMissingBinary(e) && platform === "linux") {
      return (await listNames()).some((n) => re.test(n));
    }
    if (isMissingBinary(e)) return false; // darwin 无 pgrep（几乎不会发生）且无 /proc
    throw e;
  }
}
