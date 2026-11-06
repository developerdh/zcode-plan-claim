---
description: 注册全局 zcwatch 命令（可选，供会话外手动管理 daemon）
---

把本插件（zcode-claim-watcher）作为本地包注册到 npm 全局，得到 `zcwatch`（daemon 管理 CLI）与 `zcode-claim`（技能查询/领取 CLI）两个命令。

**这是可选步骤**：插件日常使用不需要它——SessionStart 钩子已自动拉起 daemon，status / check 等管理动作在会话内经 MCP 工具即可完成。仅当用户明确需要会话外手动执行 `zcwatch` 时才做。

插件根目录用 `${CLAUDE_PLUGIN_ROOT}`；若该占位符未展开，则在 `~/.zcode/cli/plugins/cache/` 下定位 `zcode-claim-watcher` 的最新版本目录。

1. **前置检查**：`node -v`（需 ≥ 18）与 `npm -v` 均可用；任一缺失则报告并结束，不尝试替代方案。
2. **注册**：`npm install -g "<插件根目录>"`（本地目录安装，零依赖、不访问网络；bin 来自插件 package.json）。
3. **验证**：运行 `zcwatch status`。输出运行状态或"daemon 未在运行"都算安装成功（判据是命令本身可用，而非退出码）；找不到命令时提示用户重开终端后重试。
4. **报告**：说明已注册的 `zcwatch`（status/stop/check）与 `zcode-claim`（status/pending/active/claim）用途、卸载方式（`npm uninstall -g zcode-claim-watcher`），并提醒：`zcode plugins update` 更新插件后需重跑本命令刷新全局副本。

约束：不打印任何解密后的凭证；本命令不产生对 zcode.z.ai 的请求。
