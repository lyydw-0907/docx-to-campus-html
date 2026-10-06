# 三线表默认格式 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 普通 Word 表格导出为三线表：表顶线、表头下线及表底线；保持正文、合并单元格和数学内容。

**Architecture:** 对完成安全清理的 HTML 表格应用受控内联边框。表格整体画顶线和底线，表头边界画一条较细线，所有普通单元格去掉竖线及正文内部横线。公式编号表格以转换器内部 DOM 集合排除，MathML 矩阵不属于 HTML table。

**Tech Stack:** Node.js >=22、Cheerio、Pandoc 3.6.4、node:test、实际 Edge 本地预览。

## Global Constraints

- 三线表作为普通表格默认输出，不增加额外设置或新依赖。
- 有显式 thead 时在表头组底部画分隔线；没有时按第一行作为表头边界。
- 合并单元格、原始文字、图片和 MathML 保持；嵌套表格各自处理。
- 公式编号的无边框 10% / 80% / 10% 表格保持。
- 本轮只操作本地工具，不登录、保存或提交学校材料。三线表的学校保存持久化尚未验证。
- 不提交或推送 Git。授权执行本计划，使用当前多代理工作流；当前未提供 superpowers 子技能。

---

### Task 1: 默认三线表转换

**Files:** 新建 `src/tables.mjs`、`tests/tables.test.mjs`；修改 `src/convert.mjs`、`tests/converter.test.mjs`。

**Interface:** `formatThreeLineTables($, { excludedTables: Set<Element> })` 修改已清理的 DOM，保留其他安全内联样式。

- [x] 用 `border:0` 清除普通 table、tr、th、td 和行组的原有网格线；只处理各自拥有的行与单元格，不能误删嵌套表格自己的边界。
- [x] table 写入 `border-top:1.5px solid #111;border-bottom:1.5px solid #111`，表头下线为 `1px solid #111`；合并表头跨至最后表头行的单元格也保留分隔线。
- [x] 在 `sanitizeHtml` 清理之前捕获 `table[data-campus-equation="true"]`，清理结束后调用上述函数；CSS 允许列表加入受限 `border-top/right/bottom/left`。
- [x] 运行 `node --test tests/tables.test.mjs tests/converter.test.mjs`，检查实际 DOCX 三线表、合并/多行表头、嵌套表格以及公式编号排除。

### Task 2: 本地验证与交付

**Files:** `public/index.html`、README、`docs/verification.md`、本机 output 样例与源码包。

- [x] 界面文案说明普通表格默认三线表，公式编号仍无边框。
- [x] 实际 Edge 转换 Word 并检查普通与嵌套三线表及公式编号；合并表头通过实际 DOCX 转换测试；下载 ZIP 核对内联边框保留。只检查本地。
- [x] 运行 `npm test`，检查复杂 10 公式仍与已验证数学样例一致；不重复学校保存实验。
- [x] 更新文档与样例包，重建源码 ZIP、检查 CRC 和 `git diff --check`；刷新本地服务，用户重新转换即可取得新格式。
