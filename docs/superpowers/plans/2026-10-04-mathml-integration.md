# MathML 导出接入 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 将已在学校暂存回读中验证的原生公式和兼容减号接入本地转换工具，提供可复制的 MathML HTML。

**Architecture:** 保留 DOCX 安全检查、Pandoc JSON AST 和图片资产流程；通过一次批量 Pandoc `--mathml` 写出公式，再将经过白名单处理的数学节点放回原文位置。前端默认选择 MathML，API/CLI 接受显式格式，PNG 原有调用兼容。源码比较加入逐数学叶节点与结构检查，避免保存后的字符损坏被节点数检查漏掉。

**Tech Stack:** Node.js >=22、Pandoc 3.6.4、Cheerio、原生 Edge MathML、node:test。

## Global Constraints

- 不登录、保存或提交学校材料；本次实现只检查本地生成结果和前轮合成证据。
- 不将账号密码、Cookie、学校内部图片 URL 或测试草稿定位信息加入仓库。
- 只在数学显示节点中规范化减号，保持原始 TeX annotation；不能全局替换正文或变量。
- 保留现有简单数字编号，包括全角括号，不自动编号；采用 10% / 80% / 10% 无边框固定三列布局。
- 输出清单始终标记新转换文档未完成学校保存验证，区分样例验证与任意文档兼容。
- 不安装新依赖，不提交或推送 Git。已获得继续实现授权，直接执行本计划；所述 superpowers 子技能当前未提供，使用现有多代理及测试工作流。

---

### Task 1: 转换核心与受限 MathML

**Files:** `src/convert.mjs`、新建 `src/mathml.mjs`、`tests/converter.test.mjs`、新建 `tests/mathml.test.mjs`。

**Interfaces:** `convertDocx(input, { formulaFormat: 'mathml', fontSize: 14 })` 返回现有 result 结构；`manifest.options.formulaFormat === 'mathml'`；原生公式不产生图片资产，`manifest.formulas` 保留 tex/display/index 并记录兼容修改。

- [x] 批量收集 Math AST，构造 `blocks: nodes.map(node => ({t:'Para', c:[node]}))`，以 `['--from=json','--to=html5','--mathml','--wrap=none']` 写出；数学转换警告、数量不一致或不受支持的结构明确失败。
- [x] 为数学标签、命名空间及布局属性建立白名单，移除事件、外部链接、annotation-xml 与可执行节点；只将 `mo` 中减号、独立减号 `mi` 规范化为 ASCII 运算符，TeX 注释不变。
- [x] MathML 根节点使用统一字号与正确 inline/block 显示。编号表格三列宽度分别为 `10%`、`80%`、`10%`，保持原编号。
- [x] `node --test tests/mathml.test.mjs tests/converter.test.mjs`：检验真实 DOCX、减号范围、注释、嵌套结构、图片混合、缺失公式与可执行内容处理。

### Task 2: 界面、API、CLI 和下载

**Files:** `public/index.html`、`public/app.js`、`src/server.mjs`、`src/cli.mjs`、`tests/server.test.mjs`。

**Interfaces:** `/api/convert?formulaFormat=mathml`，CLI `--formula-format mathml`；缺省 API/CLI 仍为 png；浏览器选择默认 mathml。

- [x] 添加 `<select id="formula-format"><option value="mathml" selected>原生公式（MathML）</option><option value="png">高清图片（PNG）</option></select>`，MathML 模式禁用仅影响 PNG 的清晰度设置。
- [x] API 校验 `['mathml','png']`，将 format 传入 convertDocx；CLI 帮助接受 `png | svg | mathml`。
- [x] 无图片的 MathML 结果允许复制并下载 HTML；有图片结果保留上传地址映射。清晰区分普通图片、原生公式、样例已验证和当前文档未验证。
- [x] `node --test tests/server.test.mjs` 检查格式无效输入、MathML API、ZIP、映射保留数学节点；用实际 Edge 试用、上传复杂合成 Word、复制按钮和下载检查交互。

### Task 3: 源码回读检查与交付

**Files:** `src/probe.mjs`、`tests/probe.test.mjs`、README 与相关设计/验证文档。

**Interfaces:** `compareFragments(before, after)` 保留旧字段，并返回数学结构/叶节点/TeX 注释的逐公式差异。

- [x] 加入数学显示叶节点路径、标签、命名空间、文本和码点比较，只忽略节点间缩进空白；结构签名包含语义相关属性；不忽略问号或做 NFKC。
- [x] 将数学变化显示在界面，真实失败证据必须报出减号变化，兼容证据必须一致。
- [x] `npm test`，实际复杂 DOCX 经产品输出与兼容样例逐公式对照；在本地浏览器目视检查全部公式和右侧编号。
- [x] 更新文档，重新打包源码和产品 MathML 示例 ZIP；检查 ZIP CRC、无账号信息与 `git diff --check`。
