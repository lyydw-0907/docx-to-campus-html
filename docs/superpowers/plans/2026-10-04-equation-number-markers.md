# Word 公式编号标记修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 独立公式中的 Word `#(数字)` 标记输出为右侧编号，同时保留原始公式来源。

**Architecture:** 在 Pandoc AST 的单公式段落中检查外部编号及公式末端的顶层标记，在批量渲染前分离编号。保留原始 TeX 注释，渲染正文单独记录；复用原无边框三列布局，不修改未确认数学结构。

**Tech Stack:** Node.js、Pandoc、Cheerio、node:test、独立本地 Edge。

## Global Constraints

- 不操作学校、不提交正式材料、不自动增加编号、不改写原 Word。
- 不提取正文中的行内公式编号、嵌套文本中的哈希、不完整或非数字标签。
- 原始 TeX 保存在 manifest 和 MathML annotation；分离与渲染 TeX 有显式记录。
- 未取得用户原 Word 前，不宣称所有截图问题已经修复。
- 当前 superpowers 子技能未提供；使用已委派复现和数学结构复核。

---

### Task 1: 复现并实现编号分离

**Files:** 新建 src/equations.mjs、tests/equations.test.mjs；修改 src/convert.mjs、tests/converter.test.mjs。

- [x] 以合成 OMML 复现公式内及外部 `#(1)`、拆分 run、全角标签；记录实际 Pandoc 表示。
- [x] 单公式段落采用受限顶层尾部识别，保留原始 TeX，向本次转换 Map 写入 renderTex 与原编号；不确定结构保留并发出提示。
- [x] MathML 和 PNG 使用分离后的数学内容，编号使用既有三列无边框布局；原始 annotation 和清单一致。
- [x] 测试正例以及嵌套文本、正文行内、多公式段落、不完整 # 和冲突编号，避免误删公式内容。

### Task 2: 验证与交付

**Files:** docs/verification.md、docs/formula-design.md、README.md，本机 output/。

- [x] 运行完整 npm test，复核既有复杂数学树和三线表；本地 Edge 验证公式与右侧编号。
- [x] 有用户路径或 HTML 时对照用户材料复现；未提供时明确具体未验证项。本轮尚未取得实际材料，已明确边界。
- [x] 更新说明、重建样例与源码包、检查 ZIP CRC 和 git diff --check，刷新本地服务。
