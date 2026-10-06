# 一次粘贴学校图片源码 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将逐张填写图片地址改为下载上传用图片包、一次粘贴学校源码识别，并只在对应关系不明确时确认顺序。

**Architecture:** 本地服务解析学校 HTML 中安全图片地址，与当前转换任务的原文件名和编号上传文件名精确匹配。地址不请求、不渲染，未确认的顺序候选保持独立；界面保留手动修正，仍使用现有映射导出。

**Tech Stack:** Node.js、Cheerio、JSZip、node:test、现有浏览器 JavaScript 和 Playwright CLI。

## Global Constraints

- 本轮只改本地工具，不登录、上传、暂存、提交或删除学校内容；不新增学校上传接口。
- 粘贴内容是不可信数据，不执行脚本，不渲染 HTML，不请求提取的 URL。
- HTTP(S) 图片 URL 必须无账号密码；相对 URL 只按用户提供的学校页面地址解析。
- URL basename 精确匹配原资产 filename 或显式 uploadFilename；alt/title 仅线索；重命名图必须用户确认，不能默默按顺序套用。
- 已填写地址不无声覆盖；冲突、多余、重复、数量不符不自动补齐；源图、正文、数学、清单验证状态不改。
- 公共测试使用合成 HTML/Word；用户文件及实际截图仅放忽略的 output/。
- 已有会话授权允许直接实现和验证；未提供 superpowers 子技能，使用本会话委派实现和复核。此轮不提交或推送 Git。

### Task 1: 安全提取与本地 API

**Files:** 新建 src/image-import.mjs、tests/image-import.test.mjs；修改 src/server.mjs、tests/server.test.mjs。

**Interfaces:**

```js
importImageUrls(html, assets, { pageUrl } = {})
// { detectedCount, matches: [{filename,url,method}], unmatchedAssets,
//   unusedImages: [{index,url}], warnings, orderCandidates: [{filename,url,index}], orderReady }
// assets: [{filename,uploadFilename,...}]; HTML最大2MB；不调用网络。
```

- [x] 用合成图片覆盖重排后文件名匹配、编号别名、重命名顺序候选、重复/冲突、相对地址、危险协议与脚本中的伪图片，运行 `node --test tests/image-import.test.mjs`。
- [x] `POST /api/import-images/:jobId` 从现有任务取资产，解析 `{html,pageUrl}`，返回上述结果，不存储粘贴源码或地址；沿用 Origin/Host 防护和有限 body。
- [x] `GET /api/upload-images/:jobId` 只打包实际资产，名字按出现顺序生成；同时添加顺序清单，不含正文或原Word：

```js
const width = String(result.assets.length).length;
const uploadFilename = `${String(index + 1).padStart(Math.max(2, width), '0')}-${asset.filename}`;
```

- [x] 用真实合成 Word 的 HTTP 测试检查地址提取、相对路径、不合法 payload/Origin、未知任务、图片 ZIP CRC 和资产字节；运行 `node --test tests/server.test.mjs`。

### Task 2: 一次粘贴与确认界面

**Files:** public/index.html、public/app.js、public/style.css。

- [x] 映射区提供“下载上传用图片”“学校图片源码”“识别并填入地址”，相对地址时可提供“学校页面地址”；手动填写收进可展开列表，图片仍显示编号和缩略图。
- [x] 只将精确 matches 填入空白输入框；已有不同值保留并提示。更新下载按钮状态及已填数量。调用代码沿用：

```js
const response = await fetch(`/api/import-images/${jobId}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ html: byId('school-image-source').value, pageUrl: byId('school-page-url').value.trim() })
});
```

- [x] 未匹配但可按顺序确认时，展示本地缩略图、图号和候选 URL。点击“确认按此顺序填入”才写入，手填值不覆盖；输入变动、换文档或新请求使旧候选失效。
- [x] 候选地址只作为文字展示。MathML 文案说明只上传普通图片，PNG 单独说明基线限制，不再泛称所有行内公式存在图片基线问题。
- [x] 独立 Edge 主界面检查精确重排匹配、重命名图确认、冲突和少图处理、手填保护、重转换清空、导出及390px布局；记录到忽略目录。
- [x] 增加 mapped JSON 导出及“复制到学校编辑器”，只返回源码和清单，不渲染外链预览；浏览器核查剪贴板文本和189个完整数学树。

### Task 3: 集成验证与交付

**Files:** README.md、docs/verification.md、忽略的 output/ 证据及源码 ZIP。

- [x] `npm test` 全部通过；新的实际9图验证保留原189公式、9编号、图片字节和映射导出语义，不发外部请求。
- [x] 更新简化使用流程和学校上传/保存未验证边界；重建源码包，检查私人材料未包含。
- [x] 重启本地服务使 API 生效，说明刷新页面后新流程和仍需用户在学校完成的上传动作。
