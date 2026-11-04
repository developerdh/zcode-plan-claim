// procscan 单测：注入 runner/文件系统参数，覆盖 win32 tasklist CSV 解析、pgrep 输出解析、
// /proc comm 扫描回退、自身 pid 排除、ZCODE_DAEMON_PROCESS_RE 覆盖与非法正则忽略。
import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_PROCESS_RE, compileProcessRe, parseTasklistNames, parsePgrepPids, listProcComm, isZcodeRunning } from "../lib/procscan.mjs";

const TASKLIST_CSV = [
  '"ZCode.exe","1234","Console","1","1,234 K"',
  '"chrome.exe","567","Console","1","98,765 K"',
  '"some app, beta.exe","9","Console","1","100 K"',
  '"zcode","42","Console","1","10 K"',
  '""', // 空行容忍
].join("\r\n");

test("parseTasklistNames：镜像名解析（含逗号字段与引号转义）", () => {
  assert.deepEqual(
    parseTasklistNames(TASKLIST_CSV),
    ["ZCode.exe", "chrome.exe", "some app, beta.exe", "zcode"],
  );
  // 带引号转义的镜像名（合法 CSV 转义：内嵌引号写成 ""）
  assert.deepEqual(parseTasklistNames('"""a""b"".exe","7"'), ['"a"b".exe']);
  assert.deepEqual(parseTasklistNames(""), []);
  assert.deepEqual(parseTasklistNames(undefined), []);
});

test("parsePgrepPids：空白分隔 pid 列表", () => {
  assert.deepEqual(parsePgrepPids("101\n202\n"), [101, 202]);
  assert.deepEqual(parsePgrepPids("  7  8  "), [7, 8]);
  assert.deepEqual(parsePgrepPids("abc\n"), []);
  assert.deepEqual(parsePgrepPids(""), []);
});

test("compileProcessRe：空值 null、合法编译、非法忽略并告警", () => {
  const warnings = [];
  assert.equal(compileProcessRe(undefined, (w) => warnings.push(w)), null);
  assert.equal(compileProcessRe("", (w) => warnings.push(w)), null);
  assert.deepEqual(compileProcessRe("^zc", (w) => warnings.push(w)), /^zc/i);
  assert.equal(compileProcessRe("(((", (w) => warnings.push(w)), null);
  assert.ok(warnings.some((w) => w.includes("非法正则")));
});

test("isZcodeRunning win32：tasklist 镜像名匹配", async () => {
  const calls = [];
  const runner = async (cmd, args) => {
    calls.push([cmd, args]);
    return { stdout: TASKLIST_CSV };
  };
  assert.equal(await isZcodeRunning({ runner, platform: "win32" }), true);
  assert.deepEqual(calls, [["tasklist", ["/NH", "/FO", "CSV"]]]);

  const noZcode = async () => ({ stdout: '"chrome.exe","1","Console","1","1 K"\r\n' });
  assert.equal(await isZcodeRunning({ runner: noZcode, platform: "win32" }), false);
});

test("isZcodeRunning win32：ZCODE_DAEMON_PROCESS_RE 覆盖默认正则", async () => {
  const runner = async () => ({ stdout: '"ZCode Helper.exe","9","Console","1","1 K"\r\n' });
  assert.equal(await isZcodeRunning({ runner, platform: "win32" }), false); // 默认正则不匹配 Helper
  assert.equal(
    await isZcodeRunning({ runner, platform: "win32", env: { ZCODE_DAEMON_PROCESS_RE: "zcode helper" } }),
    true,
  );
});

test("isZcodeRunning：非法 ZCODE_DAEMON_PROCESS_RE 忽略并回退默认", async () => {
  const warnings = [];
  const runner = async () => ({ stdout: '"ZCode.exe","9","Console","1","1 K"\r\n' });
  assert.equal(
    await isZcodeRunning({ runner, platform: "win32", env: { ZCODE_DAEMON_PROCESS_RE: "(((" }, logger: (w) => warnings.push(w) }),
    true,
  );
  assert.ok(warnings.some((w) => w.includes("非法正则")));
});

test("isZcodeRunning unix：pgrep 精确名匹配并排除自身 pid", async () => {
  const calls = [];
  const runner = async (cmd, args) => {
    calls.push([cmd, args]);
    return { stdout: "101\n202\n" };
  };
  assert.equal(await isZcodeRunning({ runner, platform: "linux", selfPid: 101 }), true);
  assert.equal(await isZcodeRunning({ runner, platform: "linux", selfPid: 202 }), true);
  assert.deepEqual(calls[0], ["pgrep", ["-ix", "zcode"]]);

  const onlySelf = async () => ({ stdout: "202\n" });
  assert.equal(await isZcodeRunning({ runner: onlySelf, platform: "linux", selfPid: 202 }), false);

  const none = async () => ({ stdout: "" });
  assert.equal(await isZcodeRunning({ runner: none, platform: "darwin", selfPid: 1 }), false);
});

test("isZcodeRunning unix：pgrep 无匹配（exit 1）→ false", async () => {
  const noMatch = async () => {
    throw Object.assign(new Error("pgrep exit 1"), { code: 1 });
  };
  assert.equal(await isZcodeRunning({ runner: noMatch, platform: "linux" }), false);
});

test("isZcodeRunning unix：pgrep 缺失（ENOENT）→ linux 回退 /proc comm 扫描", async () => {
  const entries = ["1", "42", "999", "abc"]; // abc 非数字跳过，999 是自身 pid 跳过
  const commFiles = { "/proc/1/comm": "init\n", "/proc/42/comm": "zcode\n", "/proc/999/comm": "node\n" };
  const readdirImpl = async () => entries;
  const readFileImpl = async (f) => {
    if (!(f in commFiles)) throw new Error("enoent");
    return commFiles[f];
  };
  const missing = async () => {
    throw Object.assign(new Error("spawn pgrep ENOENT"), { code: "ENOENT" });
  };
  assert.equal(await isZcodeRunning({ runner: missing, platform: "linux", selfPid: 999, readdirImpl, readFileImpl }), true);

  const commFilesNoZcode = { "/proc/1/comm": "init\n", "/proc/42/comm": "chrome\n", "/proc/999/comm": "node\n" };
  assert.equal(
    await isZcodeRunning({ runner: missing, platform: "linux", selfPid: 999, readdirImpl, readFileImpl: async (f) => {
      if (!(f in commFilesNoZcode)) throw new Error("enoent");
      return commFilesNoZcode[f];
    } }),
    false,
  );
});

test("isZcodeRunning unix：pgrep 缺失（ENOENT）→ darwin 无 /proc 回退 → false", async () => {
  let readdirCalled = false;
  const missing = async () => {
    throw Object.assign(new Error("spawn pgrep ENOENT"), { code: "ENOENT" });
  };
  assert.equal(
    await isZcodeRunning({
      runner: missing, platform: "darwin", selfPid: 999,
      readdirImpl: async () => { readdirCalled = true; return []; },
      readFileImpl: async () => "x",
    }),
    false,
  );
  assert.equal(readdirCalled, false, "darwin 不应尝试扫 /proc");
});

test("isZcodeRunning unix：自定义正则 → linux 按 /proc 名称枚举匹配（不经 pgrep）", async () => {
  const calls = [];
  const runner = async (cmd, args) => {
    calls.push([cmd, args]);
    return { stdout: "" };
  };
  const readdirImpl = async () => ["7"];
  const readFileImpl = async () => "zcode-helper\n";
  assert.equal(
    await isZcodeRunning({ runner, platform: "linux", selfPid: 1, env: { ZCODE_DAEMON_PROCESS_RE: "zcode.helper" }, readdirImpl, readFileImpl }),
    true,
  );
  assert.ok(calls.every(([cmd]) => cmd !== "pgrep"), "自定义正则不应走 pgrep");
});

test("isZcodeRunning：其他检测错误向上抛出（调用方保守处理）", async () => {
  const boom = async () => {
    throw Object.assign(new Error("tasklist failed"), { code: 2 });
  };
  await assert.rejects(() => isZcodeRunning({ runner: boom, platform: "win32" }));
});

test("listProcComm：非数字/自身 pid 跳过，读取失败容忍", async () => {
  const entries = ["1", "abc", "42", "42"];
  const readFileImpl = async (f) => {
    if (f === "/proc/42/comm") return "zcode\n";
    throw new Error("permission denied");
  };
  const list = await listProcComm({ readdirImpl: async () => entries, readFileImpl, selfPid: 1 });
  assert.deepEqual(list, [
    { pid: 42, name: "zcode" },
    { pid: 42, name: "zcode" },
  ]);
  assert.deepEqual(await listProcComm({ readdirImpl: async () => { throw new Error("no /proc"); }, readFileImpl, selfPid: 1 }), []);
});

test("DEFAULT_PROCESS_RE：默认口径", () => {
  assert.equal(DEFAULT_PROCESS_RE.test("ZCode.exe"), true);
  assert.equal(DEFAULT_PROCESS_RE.test("zcode"), true);
  assert.equal(DEFAULT_PROCESS_RE.test("ZCode Helper.exe"), false);
  assert.equal(DEFAULT_PROCESS_RE.test("chrome.exe"), false);
});
