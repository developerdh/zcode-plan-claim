// captcha-inject.js 状态机单测：用 DOM/window 桩模拟阿里云 SDK 各分支，
// 断言终态分类、触发节奏与防重注入。全程无网络访问。
//
// 运行：node captcha-inject-test.mjs
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SNIPPET_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "captcha-inject.js");
const SNIPPET = await readFile(SNIPPET_PATH, "utf8");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 搭建最小页面环境。onClick 决定点击 #cap-btn 后 SDK 的行为：
//   'pass'   → 模拟无感验证通过，调用 captchaVerifyCallback
//   'silent' → 模拟滑块场景，回调永不触发
let pass = 0, failed = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? " — " + detail : ""}`); }
}

function setupPage(onClick) {
  const env = { clicks: 0, config: null, scriptEl: {} };
  const button = {
    id: "", type: "",
    click() { env.clicks++; if (onClick === "pass") env.config.captchaVerifyCallback("MOCK-PARAM"); },
  };
  globalThis.document = {
    createElement: (tag) => (tag === "script" ? env.scriptEl : tag === "button" ? button : { id: "" }),
    head: { appendChild: () => {} },
    body: { appendChild: () => {} },
  };
  // 测试用 __capTiming 把各时长压到毫秒级（生产环境不设置，走默认秒级）
  globalThis.window = {
    __capTiming: { sdk: 40, click: 20, callback: 60 },
    initAliyunCaptcha: (config) => { env.config = config; config.getInstance({}); },
  };
  (0, eval)(SNIPPET);
  return env;
}
function teardown() {
  delete globalThis.document;
  delete globalThis.window;
}

// 场景1：无感验证通过 → ok + param，点击恰好一次
console.log("[1] 无感验证通过（→ ok）");
{
  const env = setupPage("pass");
  env.scriptEl.onload();
  await sleep(120);
  const r = globalThis.window.__capResult;
  check("终态 ok 且带 param", r.status === "ok" && r.param === "MOCK-PARAM", JSON.stringify(r));
  check("按钮点击恰好 1 次", env.clicks === 1, `clicks=${env.clicks}`);
  const ret = await env.config.captchaVerifyCallback("X");
  check("callback 返回 captchaResult/bizResult 均 true", ret.captchaResult === true && ret.bizResult === true);
  check("终态不被后续动作改写", globalThis.window.__capResult.status === "ok");
  teardown();
}

// 场景2：回调静默（滑块场景）→ 超时判 slider
console.log("[2] 回调静默 15 秒（→ slider）");
{
  const env = setupPage("silent");
  env.scriptEl.onload();
  await sleep(50);
  check("等待期内仍为 loading", globalThis.window.__capResult.status === "loading");
  await sleep(80);
  check("超时后判 slider", globalThis.window.__capResult.status === "slider", JSON.stringify(globalThis.window.__capResult));
  check("按钮点击恰好 1 次（未反复触发）", env.clicks === 1);
  teardown();
}

// 场景3：SDK 脚本加载出错 → 立即 sdk_failed
console.log("[3] SDK 加载出错（→ sdk_failed）");
{
  const env = setupPage("pass");
  env.scriptEl.onerror();
  check("立即终态 sdk_failed", globalThis.window.__capResult.status === "sdk_failed");
  check("带 reason", typeof globalThis.window.__capResult.reason === "string");
  await sleep(140); // 确认后续计时器不会覆盖终态
  check("终态不被计时器改写", globalThis.window.__capResult.status === "sdk_failed");
  teardown();
}

// 场景4：SDK 加载超时（onload 一直不来）→ sdk_failed
console.log("[4] SDK 加载超时（→ sdk_failed）");
{
  const env = setupPage("pass");
  await sleep(90);
  check("超时后判 sdk_failed", globalThis.window.__capResult.status === "sdk_failed", JSON.stringify(globalThis.window.__capResult));
  check("未点击按钮", env.clicks === 0);
  teardown();
}

// 场景5：初始化抛错（如场景参数失效）→ sdk_failed
console.log("[5] 初始化抛错（→ sdk_failed）");
{
  const env = setupPage("pass");
  globalThis.window.initAliyunCaptcha = () => { throw new Error("scene invalid"); };
  env.scriptEl.onload();
  check("终态 sdk_failed 且 reason 含错误信息", globalThis.window.__capResult.status === "sdk_failed" && /scene invalid/.test(globalThis.window.__capResult.reason), JSON.stringify(globalThis.window.__capResult));
  teardown();
}

// 场景6：防重注入——已有结果时再次执行不重置
console.log("[6] 防重注入");
{
  const env = setupPage("pass");
  env.scriptEl.onload();
  await sleep(120);
  (0, eval)(SNIPPET); // 二次注入
  await sleep(120);
  check("二次注入不重置终态", globalThis.window.__capResult.status === "ok" && globalThis.window.__capResult.param === "MOCK-PARAM");
  check("按钮仍只点击 1 次", env.clicks === 1, `clicks=${env.clicks}`);
  teardown();
}

// 场景7：最迟终态上界——onload 压线到达（与 SDK 超时计时器竞态）时，
// 无论哪个计时器先触发，超时总和之内必然出终态（读取方 40 秒上限依赖此不变量）
console.log("[7] 最迟终态上界");
{
  const env = setupPage("silent");
  setTimeout(() => env.scriptEl.onload(), 35); // 压在 sdk=40ms 计时器之前
  await sleep(200); // > sdk+click+callback = 40+20+60 的总上界
  const st = globalThis.window.__capResult.status;
  check("总上界内必出终态（slider 或 sdk_failed）", st === "slider" || st === "sdk_failed", JSON.stringify(globalThis.window.__capResult));
  teardown();
}

console.log(`\n结果: ${pass} 通过, ${failed} 失败`);
process.exit(failed ? 1 : 0);
