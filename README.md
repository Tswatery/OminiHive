# OminiHive

一个跑在 macOS 上的本地多 Agent 聊天室。

平时干活经常要让 Codex、Claude Code、Antigravity 互相审稿、交叉验证或者分工改代码，在好几个客户端之间复制粘贴上下文实在太烦，干脆做了这个小工具：把它们拉进同一个项目讨论里，像在群里一样 `@` 谁谁干活。

## 大致怎么用

打开应用，选一个本地项目文件夹，新建讨论后就可以直接发任务：

- 输入 `@Codex`、`@Claude`、`@Antigravity`（或底栏直接点选、支持多选和 `@all`）分派任务，`Enter` 发送，`Shift + Enter` 换行。
- 同一场讨论里，每个 Agent 都能看到近期其他成员的已完成回复（自动截断过长上下文），方便直接让 A 审 B 刚写完的东西，或者把某条回复一键转发给另一个 Agent。
- 默认是**只读**模式，确认要动手改文件时在输入框切到「可编辑」即可。

## 和各家客户端的配合

OminiHive 不另起炉灶，尽量复用你本机已经装好、登好的客户端和原生会话：

- **Antigravity**：默认直连本机 Antigravity 桌面端，按文件夹真实路径匹配项目（没有就自动建一个），同一讨论一直续接同一个桌面会话，也支持等待 Swarm 蜂群跑完后把最终结果同步回来；如果切了独立第三方渠道，则走 `agy` CLI。
- **Codex**：通过本机 `codex app-server` 运行，原生会话按项目目录保存并同步标题，在 Codex / ChatGPT 桌面端里也能直接看到。同时会检查独立 CLI 和 ChatGPT 自带版本，优先用较新的那份。
- **Claude Code**：走原生流式 CLI，自动跟随本机 CC Switch 当前的路由和模型配置。
- **其他本机 CLI**：如果装了 Gemini、OpenCode、Kimi、Qwen、OpenClaw、Grok，设置页会自动识别，选了就能用。

输入框里可以单独挑模型和思考强度（effort）、附带图片，右侧能直接翻项目文件；侧栏的「设置与 CLI」里可以看到每个客户端实际走的路径、检查新版并一键更新，顺手也接了火山方舟的额度查询。

> 所有调用都依赖本机对应 CLI 已登录且服务可用，OminiHive 本身不存任何云端账号或中转流量。

## 从源码跑 / 打包

环境需要 macOS（Apple Silicon）和 Node.js（用到了内置的 `node:sqlite`，本机环境为 Node 25）。

```bash
npm ci            # 安装依赖
npm start         # 开发模式启动
npm test          # 跑单元测试
npm run package   # 打包成 macOS .app，输出在 release/ 目录
```

打包完成后双击 `release/OminiHive-darwin-arm64/OminiHive.app`（或拖到 `/Applications`）就能直接用。

项目列表、讨论记录和原生会话映射保存在 Electron 用户数据目录下的 `workspace.sqlite` 里。在侧栏删除项目或讨论只会清掉 OminiHive 自己的记录，不会碰项目文件夹里的任何文件。

## 致谢

部分 Agent 图标来自 [Lobe Icons](https://github.com/lobehub/lobe-icons)（1.103.0），原始 SVG 和许可证保留在 `public/agents/` 目录。
