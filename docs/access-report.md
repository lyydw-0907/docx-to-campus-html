# 华中农业大学系统访问核查

后续更新（2026-10-04）：用户在独立 Edge 会话中手动登录后，完成进展检查编辑器的配置核查、未保存 MathML 临时测试，以及另行授权的独立草稿暂存、回读和删除。所测两个原生 MathML 公式在编辑页和详情页保留；测试草稿已删除，列表恢复为 0 条。该轮仅 2 次业务写入：新增暂存与删除本次测试草稿，另有 12 次通知模块 POST 被拦截；未上传图片、未覆盖已有材料、未正式提交。前端拒绝 data URI 图片、清除 img 内联样式的限制仍存在。详见 [编辑器核查](school-editor-report.md)。下文保留 2026-10-03 的公开入口网络观测，历史的“未确认编辑器”描述只适用于当天。

核查日期：2026-10-03；时区：Asia/Shanghai。首轮请求时间约为 23:12–23:15，随后对复测脚本进行了实际运行。范围仅为用户指定公开入口的 DNS、TCP、TLS 与 HTTP/HTTPS 读取。未登录、未提交申报材料、未读取浏览器账户。

## 实际结果

| 入口 | HTTPS | HTTP | 能确认的范围 |
| --- | --- | --- | --- |
| [大创系统](https://dxscxcy.hzau.edu.cn/CXCY/HZAU) | HEAD、GET 均在 TCP 连接后发生 TLS 握手失败；curl 35；没有 HTTP 状态 | HEAD 500，但 GET 200，页面标题为“大学生创新创业训练计划管理系统” | HTTP 的公开登录页可读取，包含融合门户登录和本系统登录；未确认登录后编辑器 |
| [融合门户](https://portal-paas.hzau.edu.cn/main.html#/Index) | HEAD、GET 200 | HEAD 301 转 HTTPS，再返回 200 | Edge 隔离会话最终呈现游客首页和“立即登录”；未确认登录后服务 |
| [学校官网](https://www.hzau.edu.cn/) | HEAD 200；web 工具可读取完整页面 | HEAD 302 转 `https://www.hzau.edu.cn/index.htm`，再返回 200 | 公开官网可读取 |

大创系统的 HTTP GET 成功，因此不能用 HEAD 500 推断站点无法访问。HTTPS 的失败发生在 TLS 层，没有证据证明其原因是校园网限制、VPN 要求、DNS 故障或账号权限。公开入口观测本身不能说明登录后的页面和保存功能；后续进展检查验证见开头更新。`#/Index` 是浏览器路由片段，不会发送到 HTTP 服务器；命令行测试的是 `/main.html`。

## 环境限制与分层证据

第一次在受限 shell 中运行：三个域名均可解析，六个 HTTP/HTTPS HEAD 请求均立即返回 curl 7，TCP 未建立。经自动审批允许的只读网络请求后，门户和官网成功、大创 HTTP GET 成功。这说明第一次结果受执行环境影响，不应当作学校站点全部不可访问的依据。

该环境解析为下面的地址，连接记录也返回同一地址。它们属于本次环境的观测值；不能据此填写学校的实际托管地址。

```text
dxscxcy.hzau.edu.cn    198.18.0.240
portal-paas.hzau.edu.cn 198.18.0.34
www.hzau.edu.cn        198.18.0.51
```

以下摘录保留诊断所需状态与时间；匿名响应中的 Set-Cookie 和表单动态值未保存。

```text
# 大创 HTTPS HEAD，2026-10-03 23:13 左右
HTTP_CODE=000
DNS_SEC=0.021380; CONNECT_SEC=0.023621; TLS_SEC=0.000000
curl: (35) schannel: failed to receive handshake, SSL/TLS connection failed
CURL_EXIT=35

# 大创 HTTP HEAD
HTTP/1.1 500 Internal Server Error
Date: Sat, 03 Oct 2026 15:13:33 GMT
Content-Type: text/html; charset=utf-8
Content-Length: 1136
HTTP_CODE=500; REMOTE_IP=198.18.0.240
FINAL_URL=http://dxscxcy.hzau.edu.cn/CXCY/HZAU
CURL_EXIT=0

# 大创 HTTPS GET，独立确认
HTTP_CODE=000; CONNECT_SEC=0.032557; TLS_SEC=0.000000
curl: (35) schannel: failed to receive handshake, SSL/TLS connection failed
CURL_EXIT=35

# 大创 HTTP GET，独立确认
<title>大学生创新创业训练计划管理系统</title>
HTTP_CODE=200; REMOTE_IP=198.18.0.240
FINAL_URL=http://dxscxcy.hzau.edu.cn/CXCY/HZAU
CONNECT_SEC=0.044611; TLS_SEC=0.000000
CURL_EXIT=0

# 门户 HTTPS HEAD
HTTP/1.1 200 OK
Date: Sat, 03 Oct 2026 15:13:37 GMT
Content-Type: text/html; charset=utf-8
Content-Length: 7537
HTTP_CODE=200; REMOTE_IP=198.18.0.34
FINAL_URL=https://portal-paas.hzau.edu.cn/main.html
CONNECT_SEC=0.097003; TLS_SEC=3.984438; TLS_VERIFY=0
CURL_EXIT=0

# 门户 HTTP HEAD，跟随跳转
HTTP/1.1 301 Moved Permanently
Location: https://portal-paas.hzau.edu.cn/main.html
HTTP/1.1 200 OK
HTTP_CODE=200; FINAL_URL=https://portal-paas.hzau.edu.cn/main.html
CURL_EXIT=0

# 门户 HTTPS GET
HTTP_CODE=200; REMOTE_IP=198.18.0.34
CONNECT_SEC=0.023792; TLS_SEC=0.151809
CURL_EXIT=0

# 官网 HTTPS HEAD
HTTP/1.1 200 OK
Date: Sat, 03 Oct 2026 15:13:38 GMT
Content-Type: text/html
Content-Length: 73204
HTTP_CODE=200; REMOTE_IP=198.18.0.51
CONNECT_SEC=0.033601; TLS_SEC=0.281800; TLS_VERIFY=0
CURL_EXIT=0

# 官网 HTTP HEAD，跟随跳转
HTTP/1.1 302 Found
Location: https://www.hzau.edu.cn/index.htm
HTTP/1.1 200 OK
HTTP_CODE=200; FINAL_URL=https://www.hzau.edu.cn/index.htm
CURL_EXIT=0
```

curl 成功退出不表示 HTTP 业务成功：HEAD 500 的退出码仍为 0。TLS 握手失败时，即使指标 `TLS_VERIFY=0`，也不能解释为证书验证成功。

脚本以较短连接/请求超时（3 秒/6 秒）复测时，三个域的独立 TCP 80/443 探测全部成功；大创 HTTP 仍为 HEAD 500、GET 200，门户和官网的 HEAD/GET 均成功。大创 HTTPS 在这一轮返回 curl 28 超时，与前两轮 curl 35 不同。短超时和独立探测的结果应分别记录；超时后为零的计时字段不能单独证明失败所在层。脚本对此保留未确定阶段，而不将其自动归因到校园网络或账号。

web 工具的独立观测：大创 HTTPS 不可读取，门户返回需 JavaScript 的应用壳，官网可读取公开页面。对 HTTP URL 的 web 请求展示了 HTTPS 最终 URL，但工具没有提供跳转响应头，因此 HTTP 跳转类型以上述 curl 原始响应为准。

## 隔离浏览器观测

使用新建的 Edge 会话 `school-access`，没有连接用户现有浏览器，也没有输入账号或点击登录。

- 大创 HTTP：23:22 左右实际页面标题和登录区正常呈现，显示“融合门户登录”“本系统登录”“立即前往”。控制台只记录字体下载慢的提示。
- 大创 HTTPS：同一隔离 Edge 会话导航失败，返回 `net::ERR_CONNECTION_CLOSED`。这与 curl 无 HTTP 响应的观测相符，仍不能单独确定服务端、网络路径或协议配置中的具体原因。
- 门户 HTTPS：23:24 左右初始快照只有“系统加载中”，约 8 秒后已显示游客首页、“华中农业大学 欢迎您!”、“立即登录”和推荐服务。网络记录中的 68 个请求均返回 HTTP 200，静态 JS、主题资源和图片未记录下载失败。主题配置接口返回业务 `code: 0`。
- 门户控制台同时记录一个共享组件版本警告和两个空值 TypeError，但页面最终呈现。因此只能确认这些前端异常存在，不能据此断言门户一直卡在加载，也不能推断用户账号内的体验。

门户前端原始摘录：

```text
[3533ms] 导航栏3
[4150ms] remoteUrl--- https://theme-pass.hzau.edu.cn/remoteEntry.js
[4475ms] WARNING Unsatisfied version 0.1.6-7.alpha.373 from huanong
  of shared singleton module portal-component (required =0.1.67.alpha.373)
[7003ms] factory--加载完成
[7645ms] ERROR TypeError: Cannot read properties of null (reading 'topIcon')
[7647ms] ERROR TypeError: Cannot read properties of null (reading 'addEventListener')

GET /js/chunk-vendors.f57efc11.js => 200
GET /js/main.20aceba4.js => 200
GET https://theme-pass.hzau.edu.cn/remoteEntry.js => 200
GET https://portal-service.hzau.edu.cn/v2/theme/themeInfo => 200; code=0

最终页面可见：
heading: 华中农业大学 欢迎您!
button: 立即登录
推荐服务：办公系统、教育教学在线、研究生一体化管理系统等
```

打开门户时，网页自身自动发出查询和访问统计请求；本次没有主动调用保存接口、没有编辑材料或站点设置，也没有执行申报保存。命令行诊断脚本则只发送固定公开 URL 的 HEAD/GET。

## 编辑器证据与最少补充

大创公开登录页加载 `vendors.bundle.js`、`scripts.bundle.js`、`change.page.3.0.js`、`change-cxcy-site.js` 等脚本。公开入口未展示申报富文本编辑区，不能据这些文件名确定使用 UEditor、TinyMCE 或其他编辑器，也不能确认服务器允许的标签、样式、图片形式和内容长度。原型输出需经学校编辑器保存后回读测试，才能形成实际兼容配置。

2026-10-04 已取得进展检查编辑器配置及所测 MathML 的暂存回读证据。下列最少材料仅用于尚未验证的 PNG 上传、图片显示或其他公式、页面：

1. 同一个匿名测试草稿的保存前 HTML 和重新打开后的 HTML。可直接使用本原型生成的测试片段，无需另提供 Word 文档。
2. 所用字段名称，以及回读页面中的图片是否显示、公式字号和对齐是否正常。若需要判断编辑器种类，另附编辑区的外层 DOM 或加载的编辑器脚本文件名即可。不要提供密码、Cookie 或 token。

若用户的浏览器也打不开大创 HTTPS，再附具体报错文字及当前是否已使用学校提供的网络访问方式。单次报错仍不能自动证明需要 VPN。

## 保存与回读验证

1. 保留原始 DOCX 和当前草稿内容；使用测试草稿或空白字段，避免覆盖已有正式材料。
2. 先用最小样例：中文正文、一个标题、加粗、编号列表、两列表格；需要图片时另测图片。记录字号、段间距和表格边框。
3. 编辑器有源码按钮时粘贴 HTML；没有源码按钮时从浏览器预览复制渲染后的内容。不要把 HTML 代码直接粘进普通编辑区。
4. 对照 DOCX 检查文字、列表编号、表格行列和图片；保存为草稿。
5. 离开该字段，重新进入或刷新页面。再次检查内容；有源码按钮时读取保存后的 HTML，对比标签、内联样式、图片地址和表格结构。保存前的预览正确不足以证明兼容。
6. 将回读结果记录为“保留”“改写”或“丢失”。据此调整转换器允许的标签和样式，再用同一小样例验证。正式申报提交需在这些检查完成后单独执行。

以上是后续兼容性测试的方法。2026-10-03 的公开入口核查没有保存草稿；2026-10-04 已按另行授权完成一次独立 MathML 草稿的暂存、回读和清理。PNG 图片路径及其他范围仍需单独验证，没有正式提交。

## 本机复测

在能够访问学校网站的 Windows PowerShell 中运行：

```powershell
pwsh -NoProfile -File .\tools\network-check.ps1 |
    Out-File -FilePath .\docs\network-evidence.json -Encoding utf8
```

脚本只向六个固定公开 URL 发送 HEAD/GET，默认连接超时 5 秒、每请求最多 12 秒。它输出 DNS、80/443 TCP 连接、HTTP 状态、跳转、TLS 阶段和公开页面标题。响应 Cookie、登录表单值和完整正文不会写入证据；不登录、不执行网页脚本、不提交内容、不禁用 TLS 证书验证。公网入口成功不能替代学校账号下的编辑器回读测试。
