# 公式转换设计

浏览器界面默认使用 Word 原生 OMML → Pandoc JSON → 批量原生 MathML → 数学允许列表清理 → HTML，默认按 Word 原文字号，缺少原字号时回退为 14 px；PNG 作为显式备选。库 API 和 CLI 保持默认 PNG，使用 `formulaFormat: 'mathml'` 或 `--formula-format mathml` 选择原生公式。当前已接入运算符减号规范化与原编号的三列布局；每份新输出清单仍为 `verification: 'unverified'`，表示工具未自动执行学校保存回读。2026-10-06，用户确认当前版本学校端发布验证已全部完成，见 [验证记录](verification.md)。

此前学校独立合成草稿的原始版本出现 5 个减号被保存为问号；规范化后 10 个公式和 8 个右侧编号通过编辑页、详情页回读。该实验只记录当时样例的验证结果，未测试 PNG 公式图片；当前版本的用户发布验收另记于验证记录。详见 [复杂公式验证](mathml-advanced-verification.md) 和 [编辑器核查](school-editor-report.md)。

## 为什么使用 Pandoc

[Pandoc 的 docx reader](https://github.com/jgm/pandoc/blob/3.6.4/src/Text/Pandoc/Readers/Docx/Parse.hs) 调用 texmath 的 OMML reader，区分行内公式与公式段落。它将 Word 数学结构转换成数学表达式，而不是提取文本或截图。[texmath 的 OMML 实现](https://github.com/jgm/texmath/blob/master/src/Text/TeXMath/Readers/OMML.hs) 处理分数、根式、上下标、求和积分、矩阵、定界符和方程数组等结构。

先将 docx 读为 Pandoc JSON AST，再转换数学节点，可保留正文、标题、强调、表格和图片的结构与公式位置，避免用正则从 HTML 猜测公式。公式编号优先保留原文中的文本或表格单元格；原型不擅自重新编号。

[Mammoth 官方说明](https://github.com/mwilliamson/mammoth.js) 列出标题、表格、图片、加粗、上下标等支持项，但公式支持的[议题 #83](https://github.com/mwilliamson/mammoth.js/issues/83) 仍未关闭，因此不能把 Mammoth 单独作为保留 OMML 的链路。历史 npm 库 [scienceai/omml2mathml](https://github.com/scienceai/omml2mathml) 是 Office 转换样式表的 JavaScript 移植，采用 Apache-2.0；仓库已归档并声明不再维护，不作为本原型的主要依赖。

Pandoc 提供 Windows 便携 zip，可使用独立二进制，无须安装 Office 或完整 LaTeX。[安装说明](https://pandoc.org/installing.html)

## MathML 的批量转换与清理

先从原 DOCX 的 Pandoc AST 收集数学节点及其原始 TeX，将它们按出现顺序组成一个批次，实际调用 Pandoc `--from=json --to=html5 --mathml`，再按同一顺序写回正文。核对原生公式数、批次数和清理后的 MathML 数；数量不一致或数学转换警告会停止导出。MathML 不生成公式图片，也不要求页面加载 MathJax 或 KaTeX。

数学清理单独处理 MathML 命名空间、允许的数学标签和属性、分式/根式/上下标的子节点数及矩阵行列结构。移除脚本、非数学可执行节点和非允许属性；未知数学结构、错误命名空间、无效层级、缺失或改写的原始 TeX 注释会显式失败。TeX annotation 必须为 `application/x-tex` 的纯文本。

Windows Pandoc 输出可能将矩阵等多行 TeX 的 LF 变为 CRLF。注释核查只允许行尾传输等价，其他字符和空白变化仍拒绝；核查后重建为原 AST 中的精确注释。不能用任意空白折叠掩盖原始表达式的改写。

MathML 字号由正文逻辑字号控制。已有简单公式编号采用无边框、0 padding、`table-layout: fixed` 的 10% / 80% / 10% 三列表格，左右等宽，公式在中列居中，原编号在右列靠右。不自动新增编号，不因本地输出成功标记为学校已验证。普通图片仍按原图片资产路径导出，需要学校上传和真实地址映射。

编号规划在批量渲染前进行，只接受独立段落中的单个数学节点。外部编号及可确认的顶层末尾 `#(数字)` 标记分离为右列，保留括号字形；TeX 组、环境、括号及顶层换行限制提取。整条公式是 `array{r}` 且只有一行一列、末尾为完整数字标记时，可解包这一 Word 方程数组，再分离编号。多行、多列、嵌套环境、正文混排、重复标签及明显缺少操作数的表达式保留。明确标记的独占 InlineMath 可提升为 DisplayMath，没有标记的行内数学不擅自提升。

不完整标记默认保留。例外仅限原 OMML 确认为整条单行 `eqArr`，Pandoc 也输出单行 `array{r}`，且已结束的数学语句在句号后只有孤立 `#`。此时导出清理包装和该排版残留，保持行内/独立模式、不新增编号，清单记录 `markerCleanup` 并告警。原始 TeX 注释保留完整标记；库选项 `removeIncompleteNumberMarkers: false` 可关闭清理。

规划不改原 AST。MathML 先以 `renderTex` 写出并核验，再将 annotation 回写为原始 `tex`，最终清理再次核验原注释。清单保存 `number`、`numberSource`、`renderTex` 和 `sourceDisplay`。PNG 同样渲染分离后的正文，以正文及显示参数建缓存。

受控样例中，当前 Pandoc 3.6.4 将 OMML 求和 `limLoc=undOvr/subSup` 差异读取为相同 TeX。因此读取正文 XML 中每条原生公式的 `m:nary` 符号及显式 `limLoc`，按公式顺序和运算符数量、字符、顺序准确匹配后恢复位置。MathML 只在对应运算符基式的脚标与上下限结构间转换；compact 上下文中的明确上下限使用 `movablelimits=false`。PNG 则将明确位置写入渲染 TeX 的 `\limits` 或 `\nolimits`，原 TeX 不改。

没有明确限位时不推测；符号或数量不匹配时整条公式不改并提示。正文和脚注的顺序无法确认时禁用源限位映射，避免关联错误。普通变量上下标和原始 annotation 不改，变化记录在 `sourceLayoutChanges`。这恢复了源文件的明确排版设置，仍不保证 Word 像素级间距或任意数学结构；本轮没有新学校保存实验。

普通 HTML 表格默认采用三线样式，嵌套表格分别处理，保留合并单元格和内容；公式编号表格仍无边框，MathML 的 `mtable` 矩阵不受影响。最新排版的学校保存回读已获用户实测确认，范围见验证记录。

## PNG 的字号、自然宽度与基线

渲染模块使用 MathJax **v3.2.2** 的直接 Node API；本项目没有使用 v4 的 bundle 路径和异步字体机制。[v3 官方 API 说明](https://docs.mathjax.org/en/v3.2/server/direct.html)

[v3.2.2 的 SVG 输出源码](https://github.com/mathjax/MathJax-src/blob/3.2.2/ts/output/svg.ts) 将外框写为 `viewBox="0 -h*1000 w*1000 (h+d)*1000"`，并用 `vertical-align` 表达基线下深度。模块据此定义 `1000 SVG 单位 = 1 em`：

- `width = viewBox.width × fontSize / 1000`；
- `height = viewBox.height × fontSize / 1000`；
- `depth = (viewBox.y + viewBox.height) × fontSize / 1000`。

正文采用相同 CSS 字号；行内图片使用 `vertical-align: -depth px`。公式宽度按内容自然确定，不把所有公式设成同一宽度或高度。独立公式使用同一 `fontSize`，`display=true` 仅启用数学排版本身的独立公式规则，例如积分限与分数的布局。

SVG 的宽高改为明确像素值，`fontCache: none` 将字形写成路径；颜色和数组边线的必要样式放入 SVG 内。数学字形不需要学校页面加载字体或 JavaScript。若 MathJax 使用依赖系统字体的 SVG `<text>` 后备字形，模块会报错，避免无提示输出不同字形。

PNG 像素画布为 `ceil(width × scale)`、`ceil(height × scale)`，默认 `scale=3`。HTML 仍使用返回的原始 CSS 浮点宽高，因此密度提升不会放大公式字号。整个外框保留，不使用 `trim()`，避免裁剪改变基线。SVG 栅格化由 [sharp 官方 SVG 输入接口](https://sharp.pixelplumbing.com/api-constructor/) 完成；PNG 可透明，默认黑色字形。

## 错误与能力边界

PNG 备选链路为 TeX → **mathjax-full 3.2.2** → 自包含 SVG → 高清 PNG。MathJax 并非完整 LaTeX 引擎。原型启用其已安装的常用数学扩展，关闭 `noerrors` 和 `noundefined` 错误隐藏，以及交互内容、外部链接和依赖特定字体的扩展。[v3.2.2 TeX 扩展列表](https://github.com/mathjax/MathJax-src/blob/3.2.2/ts/input/tex/AllPackages.ts)、[TeX 错误接口](https://github.com/mathjax/MathJax-src/blob/3.2.2/ts/input/tex.ts)

语法错误、未知命令、MathJax `merror`、字体后备、没有自然外框的容器依赖公式会导致显式错误；不会用一张错误文本图片冒充成功公式。极少数完全提升到基线以上的表达式无法由当前非负 `depth` 图片接口准确表达，也会报错。每次渲染创建独立解析器，防止宏定义和编号状态泄漏到其他公式。

OMML → TeX 是结构转换，并非 Word 的像素级复制：特殊格式、复杂方程对齐、旧版 OLE/MathType 对象、WMF/EMF 图片需单独检查。应对照原 DOCX 的公式数量和转换输出，并对包含根式、积分、矩阵、长公式和编号的样例做视觉核验。Pandoc/texmath 也存在[已记录的 OMML 对齐与定界符差异](https://github.com/jgm/texmath/blob/master/OMML-BUGS)，不能宣称完整、无损支持所有 OMML。

## 学校编辑器验证

已确认当前进展检查编辑器会替换 `data:` 图片地址、清除 img 内联样式并将显示尺寸写入宽高属性。图片需先通过学校图片入口上传，再用真实返回地址替换 `src`。此前 MathML 合成草稿实验没有上传图片；2026-10-06，用户确认当前版本学校端发布验证已全部完成。图片基线样式被清除的实现限制仍按实际格式处理。

本地产品已接入 MathML 输出，可显式选择图片备选。此前学校样例中的 8 个独立公式已用 10% / 80% / 10% 的固定三列表格，实现公式居中和原编号同一行靠右；左右等宽、0 边框及 0 padding 在回读后保留。产品接入时，复杂样例在本地与该兼容样例完整数学树逐项一致，该轮没有重新写入学校。当前版本学校端发布验证已获用户全部完成的确认，具体来源见验证记录；每份新转换文档仍须独立核查。超宽公式及不同容器宽度须按实际内容调整，不保证任意公式自动适配。无需将账户密码、登录 Cookie 或学校内部图片 URL 写入开源仓库。

## MathML 字符兼容的实验结果

复杂样例的原始版本保存后，10 个 math 节点及数学结构不变，但 5 个显示减号 `−`（U+2212）成为 `?`（U+003F），原始版本语义失败。保存后的 HTML 已包含问号，不能把问题视为字体显示差异；本次没有确定后台具体原因。

独立兼容版本只对 MathML 显示叶节点执行 U+2212 → 字面 U+002D，5 处变更中两处单目 `mi` 改为运算符 `mo`；不改 TeX annotation，不使用 HTML 实体绕过。再次暂存后，10 个公式的显示叶节点路径、标签、命名空间、文本和码点与修正版保存前严格一致，10 条原始 annotation 完全保留；编辑页和详情页均无字符替代。

本地转换器已采用该运算符适配：仅规范 `mo` 中的数学减号和作为单目减号的单字符 `mi`，后者转为 `mo`；变量、普通正文、数字和原始 annotation 不做全局替换。变更记录保留位置、前后标签和字符。验收分别检查公式数量、结构、全部显示字符、视觉布局和保存状态；源码比较器按数学树路径比较标签、命名空间、属性、字符码点及注释，能检出节点数相同的减号损坏。U+002D 与 U+2212 的源字符及字形不同，规范化不等于像素无损还原；所测之外的字符和数学结构仍需单独验证。
