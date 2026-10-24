// 阿里云验证码注入脚本：读取本文件内容，在 https://zcode.z.ai/cn 的页面上下文执行一次。
// 等待与判定逻辑全部内置，执行方只需定期读取 window.__capResult（页面本地变量，
// 读取不产生网络请求，不会增加风控压力）：
//   {status:'loading'}                            进行中
//   {status:'ok', param:'<captchaVerifyParam>'}   成功，param 供 claim 使用
//   {status:'slider'}                             风控要求人工滑块，必须停止
//   {status:'sdk_failed', reason:'...'}           SDK 加载/初始化失败，必须停止
// 时长与触发节奏依据 2026-10-04 实测；测试可用 window.__capTiming 覆盖各时长。
// 状态机自带全部超时，终态最迟约 27 秒（10s SDK + 2s 触发 + 15s 回调）必然出现；
// 读取方仍应自设约 40 秒上限，防注入静默失败/页面导航导致变量永不存在。
(() => {
  if (window.__capResult) return; // 防重复注入：已有结果（含进行中）则不重置
  window.__capResult = { status: 'loading' };
  const T = Object.assign({ sdk: 10000, click: 2000, callback: 15000 }, window.__capTiming || {});
  const done = (status, extra) => {
    if (window.__capResult.status === 'loading') window.__capResult = Object.assign({ status }, extra);
  };
  const s = document.createElement('script');
  s.src = 'https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js';
  const el = document.createElement('div'); el.id = 'cap-el';
  const btn = document.createElement('button'); btn.id = 'cap-btn'; btn.type = 'button';
  document.head.appendChild(s);
  document.body.appendChild(el);
  document.body.appendChild(btn);
  let loaded = false;
  s.onerror = () => done('sdk_failed', { reason: 'script load error' });
  setTimeout(() => { if (!loaded) done('sdk_failed', { reason: 'script load timeout' }); }, T.sdk);
  s.onload = () => {
    loaded = true;
    try {
      if (typeof window.initAliyunCaptcha !== 'function') throw new Error('initAliyunCaptcha 未定义');
      window.initAliyunCaptcha({
        SceneId: '11xygtvd', prefix: 'no8xfe', mode: 'popup', region: 'cn', language: 'cn',
        element: '#cap-el', button: '#cap-btn',
        captchaVerifyCallback: async (p) => {
          done('ok', { param: p });
          return { captchaResult: true, bizResult: true };
        },
        onBizResultCallback: () => {},
        getInstance: (i) => { window.__capInst = i; },
      });
      setTimeout(() => btn.click(), T.click); // 复现实测节奏：初始化后约 2 秒再触发
      setTimeout(() => done('slider'), T.click + T.callback); // 触发后 15 秒无回调 = 人工滑块
    } catch (e) {
      done('sdk_failed', { reason: String((e && e.message) || e) });
    }
  };
})();
