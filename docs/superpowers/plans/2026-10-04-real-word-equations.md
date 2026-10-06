# 实际申报书公式兼容修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 对照用户实际 Word 的公式结构，修复单行方程数组内编号及显式求和上下限，并交付该文档的本地输出。

**Architecture:** 在受限编号规划中解包仅有一行一列且含完整编号的 array{r}；从原 OMML 按公式顺序提取明确 nary 限位，并在批量数学输出中只修改对应运算符。原始 TeX、Word文件、公式数量及普通数学字符保留。

**Tech Stack:** JSZip、Cheerio、Pandoc、MathML、node:test、本地 Edge。

## Global Constraints

- 用户文件及全部派生正文仅保存在忽略的 output/user-proposal/，不进入开源源码或源码 ZIP。
- 原文件只读，前后 SHA-256 核对；不保存或提交学校材料。
- 多行、多列、内部标记、无法映射的限位不推测；原始来源留存。
- 原稿某公式仅有裸 #，是否去掉该排版标记按用户选择处理，不编造编号。
- 只将去敏的合成 XML/数学测试加入源码；当前 superpowers 子技能未提供，使用已委派实现和复核。

---

### Task 1: 单行数组与源限位

**Files:** src/equations.mjs、src/omml-layout.mjs、src/convert.mjs 及对应 tests/。

- [x] `array{r}` 包装、单顶层行、无未转义 &、完整末尾数字标记时解包，渲染正文去包装与标记；其余数组不动。
- [x] `extractOMMLLayout(xml)` 收集 m:oMath 中 m:nary 操作符和明确 limLoc；`applyOMMLLimits(html, layout)` 只在数量/符号准确匹配时改限位标签并设置 movablelimits=false。
- [x] MathML 和 PNG 保持源 tex，记录 renderTex、wrapperRemoved 和 sourceLayoutChanges；存在脚注等无法按序对应时禁用源映射并提示。
- [x] 测试单行/多行数组、单/双 nary、无法映射、源字符与原注释保持；核对实际 189 个公式和 9 个编号。

### Task 2: 实际文档检查与交付

**Files:** output/user-proposal/ 私有 HTML、预览、清单及检查记录；文档中的去敏验证摘要。

- [x] 核对源与输出数学字符、189个公式、9个编号、8个明确求和上下限、真正行内公式及 9 张普通图片。
- [x] 可选询问后按已告知的推荐假设，仅清理源确认边界内的孤立 #，保持无编号、原 Word 和源注释；记录这一导出差异及关闭选项。
- [x] 浏览器查看出错段落和导出 ZIP，运行所需测试；不做学校保存实验。
- [x] 更新公共验证摘要、重建源码包并检查私有内容未进入源码；交付私有转换包和原文件未改证明。
