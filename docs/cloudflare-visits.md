# Cloudflare 页面访问次数

首页底部显示“累计访问 N 次”，从启用数据库计数时开始累计。这是页面访问次数（PV），不是独立访客人数，也不是转换成功次数。打开或刷新一次主页发送一个计数请求；转换、预览、复制、下载和测试示例不另加一次。

正式站点 [docx-to-campus-html.pages.dev](https://docx-to-campus-html.pages.dev/) 已启用 D1 累计计数。2026-10-07 的实际网页检查确认：首页显示累计值，刷新增加一次，转换不额外计数，只读 GET 不递增；预览部署域名不能使用生产计数接口。下面的部署方法用于复现或更新站点。

## 部署产物

```powershell
npm run build:cloudflare
```

- `output/cloudflare/` 与 `output/campus-cloudflare.zip`：完整静态页面及编译后的 `_worker.js`。
- `output/cloudflare-setup.sql`：数据库初始化 SQL，不需要上传为站点静态资源。
- `output/cloudflare-setup.md`：本说明的副本。

普通 `npm run build:browser` 保持访问统计关闭，适用于无需统计的静态托管。Cloudflare 包使用同源 `/api/visits`，不加载外部统计脚本。localhost、127.0.0.1、IPv6 回环、HTTP、file 和嵌入预览不发计数请求。本机测试不产生公开累计值。

## 接到现有 Cloudflare Pages 项目

先确认工具的实际站点网址和 Pages 项目名称；`https://dash.cloudflare.com/login` 是账户登录入口，不是站点地址。以下配置需要在实际项目中完成，代码构建本身不会修改 Cloudflare 账户。

1. 在 Cloudflare 创建一个用于本工具的 D1 数据库，或使用为本工具准备的已有数据库。在 D1 控制台运行 `output/cloudflare-setup.sql`。迁移可重复执行，已有累计值不会重置。
2. 在 Pages 项目的生产环境设置中添加 D1 绑定，变量名为 `VISITS_DB`，选择刚初始化的数据库。不要将生产计数库绑定到预览环境。
3. 添加生产环境变量 `VISIT_COUNTER_ORIGIN`，填写实际公开站点的 HTTPS origin，只含协议和域名，不带末尾斜杠、路径或查询。例如站点使用 `https://项目名.pages.dev/`，变量对应其协议与域名；使用自定义域名时填写实际访问的主域名。不要填写 Cloudflare 控制台地址。接口只接受该 origin，预览部署域名和其他域名不计入。
4. 将 `output/cloudflare/` 的全部内容部署到该项目的生产环境，保留 `_worker.js`、`_routes.json`、浏览器 `worker.js`、`pandoc.wasm.gz` 与许可文件。绑定和环境变量修改后需要重新部署。
5. 打开实际站点，确认底部累计值显示，刷新后增加。`GET /api/visits` 可只读检查累计值和起算时间，不会增加计数。

Cloudflare 控制台的拖放上传支持预先编译的 `_worker.js`，不负责编译普通 `functions/` 文件夹，所以本包已将接口编译为高级模式 Worker。[官方上传说明](https://developers.cloudflare.com/pages/get-started/direct-upload/#functions)、[高级模式与静态资源转发](https://developers.cloudflare.com/pages/functions/advanced-mode/)。数据库绑定位置和重新部署要求见 [Pages D1 绑定说明](https://developers.cloudflare.com/pages/functions/bindings/#d1-databases)。更新站点可直接上传本机产物，无需更新 GitHub。

如果现有项目是 Cloudflare Workers 而非 Pages，应使用现有 Worker 的部署配置接入 `cloudflare/worker.js`，并配置静态资源 `ASSETS`、D1 `VISITS_DB` 和 `VISIT_COUNTER_ORIGIN`；不要将 Pages 包直接当作 Workers 控制台的新项目覆盖。实际项目未确定前不创建第二个站点。

## 数据与故障处理

前端只向本站接口发送空 POST，不附加文件、文件名、学校源码、图片地址、cookie、访客标识或查询参数。应用数据库只保存一条累计数及其起算时间，不保存 IP、浏览器指纹或逐次访问记录；Cloudflare 仍会按普通 HTTP 请求处理网络元数据。

计数通过一条 SQL 原子递增，并返回服务端确认的值；响应禁止缓存。没有配置绑定/生产 origin、数据库初始化失败、超时或接口异常时不显示数字，不用零或本地 storage 值代替。Word 转换不等待访问统计，仍可操作。关闭计数后数据库累计值保留，下次使用同一数据库时继续累计。

`_routes.json` 仅把 `/api/visits` 交给统计函数，页面、转换引擎与其他资源走静态资源服务。上传文档的网络 POST 不属于转换流程；转换仍在浏览器 WASM Worker 中完成。接口只针对累计 PV，脚本被禁用或计数请求未成功的访问不会纳入累计值。

## 验证记录与启用条件

2026-10-07，本地完整回归 340 项全部通过；真实 SQLite 验证并发递增、重开持久化及迁移不重置。独立 Edge 验证本地不计数、模拟公开 HTTPS 显示与刷新计数、转换不额外计数和统计接口故障时仍能转换。两份 ZIP 通过 CRC、许可和私有输入排除检查；编译后的 Worker 也通过本地 SQLite 检查。这些结果不代表已接入真实 Cloudflare D1。

上述记录对应部署前的本地准备。构建命令本身不会创建云数据库、部署站点或更新 GitHub；公开访问次数只有在实际生产站点配置完成且接口成功返回累计值后才开始统计。部署完成后，应另行核对真实站点的转换、计数和预览环境配置。
