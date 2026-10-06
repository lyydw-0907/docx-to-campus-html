# 文件选择与拖入修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 点击可见文件按钮或拖入一个 Word 文件后，确认文件名并转换。

**Architecture:** 移除透明覆盖层；file input 和拖入共同更新 selectedFile。失败清除选中状态，拖入不自动上传，转换沿用本机 API。

**Tech Stack:** 原生 HTML/CSS/JavaScript、Node.js、独立 Edge / Playwright CLI。

## Global Constraints

- 单个 .docx，最大 20 MB，两种入口限制相同。
- 无新依赖、不改变引擎、不操作学校、不提交 Git。
- 当前 superpowers 子技能未提供，使用已委派只读复核和主代理实现。

---

### Task 1: 文件控件与共享状态

**Files:** public/index.html、public/style.css、public/app.js。

**Interface:** `selectFiles(files)` 校验后设置 `selectedFile`、文件名、状态；转换读取 `selectedFile`。

- [x] 保留 `<input id="file" type="file" accept=".docx">`，移除 opacity:0/绝对定位，添加拖入帮助。
- [x] `files.length !== 1`、`.name.toLowerCase().endsWith('.docx')`、`size > 20 * 1024 * 1024` 校验单文件、格式、上限；失败清空 selectedFile/input.value。
- [x] dragover/drop preventDefault，drop 调用 `selectFiles(event.dataTransfer.files)`，不转换。

### Task 2: 本机验证与交付

**Files:** output/playwright/ 验证脚本和截图；README.md、docs/verification.md。

- [x] Edge 点击原生 input，由 CLI filechooser 上传原有合成 advanced.docx 并转换；模拟空选择后保持先前文件。
- [x] 实际 DOCX 字节构造 DataTransfer，核对拖入文件名、无自动请求、点击后转换；错误格式/多文件/超限拒绝且不能误转换旧文件。
- [x] `node --check public/app.js`、`git -c core.autocrlf=false diff --check` 通过，更新说明、重建源码包。服务按请求读取前端，刷新即可。
