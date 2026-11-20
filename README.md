# OminiHive

**在同一个讨论里调度多个本地 Coding Agent 的 macOS 桌面应用。**

OminiHive 把 Codex、Claude Code、Antigravity 等本机已安装的 Agent 客户端组织成「项目 → 讨论」的群聊结构：用 `@` 指派任务，成员之间自动共享上下文，便于让一个 Agent 实现、另一个 Agent 评审，或让多个 Agent 就同一问题并行给出方案。

OminiHive 不托管账号，也不中转流量：所有调用都通过本机已登录的官方客户端或 CLI 完成，并复用它们的原生会话。

---

## 功能概览

**群聊式协作**
- 通过 `@Codex`、`@Claude`、`@all` 或输入框底栏的成员选择器指派任务，支持同时发给多个 Agent。
- 每个讨论可单独管理成员，一次拉入多个 Agent。
- 任一回复可一键转交给其他 Agent 评审。

**共享上下文**
- 发送时，自动向目标 Agent 附带它尚未看过的其他成员的最新回复，过长的内容会被截断。
- 完整历史以只读 Markdown 形式归档在项目目录的 `.ominihive/context/` 下，Agent 需要时可以自行查阅。
- 每条回复的消息头会标注本轮使用的模型、思考强度，以及带入了哪些上下文，点击即可查看明细。

**原生会话**
- 同一讨论与同一 Agent 的对话始终续接同一个原生会话，也可以按需改为新开会话。
- 支持从 Codex、Claude Code、Antigravity 客户端导入已有会话，或把客户端中的最新对话同步回讨论。

**执行过程可见、可干预**
- 工具调用、命令和文件修改以时间线形式展示；执行中只显示最近几步，完成后自动折叠。
- Codex 的命令和文件审批、追问，以及 Antigravity 的权限请求，可以直接在应用内作答。
- Agent 运行期间的新消息可以加入队列，在当前任务完成后自动发送；也可以选择打断当前任务、立即发送。

**模型、权限与技能**
- 每个 Agent 可以单独选择模型、思考强度（effort）、CC Switch 渠道和执行权限。
- 输入 `/` 可以调用该 Agent 的 Skills（项目级和用户级）以及 CC Switch 中的预设 Prompt。
- 支持附带图片和文件（粘贴、拖入或点选均可），右侧面板可以浏览和预览项目文件。

**客户端管理**
- 在「设置与 CLI」中可以查看每个 Agent 实际调用的可执行文件路径，检查更新并一键升级。
- 内置火山方舟用量查询。

---

## 支持的 Agent

| Agent | 接入方式 |
| --- | --- |
| **Codex** | 通过 `codex app-server` 运行，在独立 CLI 与 ChatGPT.app 内置版本之间自动选用较新的一个；会话标题与 Codex / ChatGPT 桌面端同步 |
| **Claude Code** | 原生流式 CLI（`stream-json`），自动跟随 CC Switch 和 `~/.claude/settings.json` 中的路由与模型配置 |
| **Antigravity** | 默认直连本机 Antigravity 桌面端：按真实路径匹配项目，持续续接同一会话，并可等待 Swarm 完成后同步最终结果；选择第三方渠道时改走 `agy` CLI |
| **WorkBuddy** | 复用 WorkBuddy.app 内置 CLI，或独立安装的 `codebuddy` CLI |
| Gemini · OpenCode · Kimi Code · Qwen · OpenClaw · Grok · Hermes · Pi · MiniMax Code · DeepSeek Harness · Oh My Pi | 自动识别本机已安装的对应 CLI，在设置中启用后即可加入讨论 |

> 所有 Agent 都依赖本机对应客户端已安装并登录。各 Agent 实际能执行的操作，以其自身 CLI 的沙箱与权限能力为准。

---

## 使用

1. 打开应用，选择一个本地项目文件夹（`⌘O`）。
2. 在项目下新建讨论（`⌘N`），在输入框中 `@` 一个或多个 Agent 下达任务。
3. 默认以**只读**权限运行；需要修改文件时，在输入框底栏为该 Agent 切换权限。

### 执行权限

权限按 Agent 分别设置，输入框左侧的色条标示当前生效的最高权限。

| 模式 | 说明 |
| --- | --- |
| 只读（默认） | 仅读取项目代码，不修改文件、不联网 |
| 工作区可编辑 | 可修改当前项目内的文件并允许联网（琥珀色标识） |
| 完全访问 | 不受限制地访问网络、SSH 及本机任意文件，请谨慎开启（红色标识） |

### 快捷键

| 快捷键 | 作用 |
| --- | --- |
| `Enter` / `Shift + Enter` | 发送（目标 Agent 忙碌时加入队列）/ 换行 |
| `⌘ Enter` | 目标 Agent 忙碌时，打断当前任务并立即发送 |
| `@` / `/` | 提及 Agent / 调用 Skills 与预设 Prompt |
| `⌘ N` / `⌘ O` | 新建讨论 / 打开本地项目 |
| `⌘ /` | 展开或收起侧栏 |
| `⌘ .` | 停止当前讨论中所有正在执行的任务 |
| `⌘ 1` `⌘ 2` `⌘ 3` | 切换发送对象为 Codex / Claude / Antigravity |
| `⌘ 4` | 切换为全员（`@all`） |

---

## 数据与隐私

- **应用数据**：项目列表、讨论记录和原生会话映射保存在 Electron 用户数据目录下的 `workspace.sqlite` 中（`~/Library/Application Support/OminiHive/`），附件存放在同目录的 `attachments/` 下。
- **项目目录中的归档**：为了让 Agent 能查阅完整的讨论历史，OminiHive 会在项目根目录写入只读归档 `.ominihive/context/<讨论 ID>/`，并自动加入该仓库的 `.git/info/exclude`，不会出现在 `git status` 中。
- **删除**：在侧栏删除项目或讨论时，只会清除 OminiHive 自己的记录及对应的 `.ominihive` 归档，不会改动项目中的其他文件，也不会删除各客户端中的原生会话。
- **网络**：OminiHive 本身不收集数据，也不经过任何中转服务器；请求均由各 Agent 客户端直接发出。

---

## 从源码构建

**环境要求**
- macOS，Apple Silicon
- Node.js 22.18 及以上：需要内置的 `node:sqlite` 和 TypeScript 类型剥离支持（开发环境使用 Node 25）

```bash
npm ci              # 安装依赖
npm start           # 构建并以开发模式启动（首次运行会下载火山方舟 arkcli 组件）
npm test            # 单元测试
npm run package     # 打包为 release/OminiHive-darwin-arm64/OminiHive.app
```

打包说明：
- 打包时会优先复用本机缓存中同版本的 Electron 压缩包，也可以通过 `OMINIHIVE_ELECTRON_ZIPS` 指定所在目录。
- 在 macOS 26 且安装了 Xcode 26 的环境下，会额外编译 `assets/icon-composer/OminiHive.icon`（Liquid Glass 图标）；其他环境只使用 `.icns`。

`npm run test:live` 会启动一个独立的应用实例，并调用真实的 Agent 做端到端验证，会消耗各 Agent 的额度。

### 目录结构

```
desktop/   Electron 主进程：Agent 适配与调度、会话同步、上下文归档、SQLite 存储
src/       渲染进程（React）：界面组件、状态 hooks，以及可单测的纯逻辑模块
tests/     node:test 单元测试与端到端脚本
scripts/   打包与外部组件准备脚本
assets/    应用图标（.icns 及 Icon Composer 源文件）
```

---

