# OminiHive 开发与交付规范

## 必须执行的打包交付流程

用户日常直接使用本仓库打包产物 `/Users/lin/code/OminiHive/release/OminiHive-darwin-arm64/OminiHive.app`。

**每次完成功能开发或 Bug 修复后（无论修改的是 `src/` 前端还是 `desktop/` 桌面端），在交付给用户前必须依次完成以下步骤：**

1. 运行测试确认无回归：
   ```bash
   npm test
   ```
2. 执行完整打包（会自动执行 `tsc --noEmit && vite build` 并重新生成 `release/OminiHive-darwin-arm64/OminiHive.app`）：
   ```bash
   npm run package
   ```
3. 打包完成后告知用户产物已更新，可重启 `OminiHive.app` 使用最新改动（如需立即拉起新包，确认无正在运行的 Agent 任务后再重启）。

> 不要只跑 `npm run build` 就结束任务——未执行 `npm run package` 时，用户的 `OminiHive.app` 仍是旧包，所有改动都不会生效。

## 阶段性提交与可回滚规范

- 每当一个功能迭代完成并通过测试与打包验证后，**主动与用户商量是否需要执行 `git commit`（以及按需 `git push`）**，确保每个可用版本都有清晰、可回滚的提交记录。
- 提交前确认 `git status` 不包含临时文件、构建产物或敏感凭证，提交信息简洁概括本轮核心改动。
