# 部署说明

`deploy/` 提供 systemd 服务和 Nginx 配置模板。生产环境文件单独放在 `/etc/momo-mcp.env`，本地实际配置不进入 Git。

## 选择认证方式

请求 Token 模式适合客户端分别提供自己的墨墨凭据：

```dotenv
AUTH_MODE=maimemo-token
HOST=127.0.0.1
PORT=8787
MCP_PATH=/momo
ALLOW_MUTATIONS=false
CLI_TIMEOUT_MS=30000
```

客户端传入 `Authorization: Bearer <墨墨开放 API Token>`。服务将 Token 放进当前请求配置，专用工具用于直接 HTTP 请求，旧版工具传给当次 CLI 子进程。应用不将请求 Token 保存到数据库或文件。

服务端 Token 模式适合内部使用同一账户：

```dotenv
AUTH_MODE=server
MAIMEMO_API_TOKEN_FILE=/etc/momo-maimemo-token
MCP_BEARER_TOKEN_FILE=/etc/momo-endpoint-token
HOST=127.0.0.1
PORT=8787
MCP_PATH=/momo
ALLOW_MUTATIONS=false
```

此时客户端使用独立的 MCP Bearer Token，墨墨凭据由服务端提供。凭据文件应仅允许服务用户读取。`AUTH_MODE=server` 绑定非 loopback 地址时，代码要求配置 `MCP_BEARER_TOKEN` 或对应文件。

外部访问通过 HTTPS 反向代理提供，并按需要设置 `ALLOWED_HOSTS`。握手成功说明入口认证通过，Token 是否过期会在调用官方 API 时体现。

## systemd

模板使用 `/opt/mcp/momo` 作为工作目录，服务用户和组都为 `momo-mcp`，配置文件为 `/etc/momo-mcp.env`。先创建服务用户、安装源码和依赖、构建，再安装服务文件：

运行环境要求 Node 24。systemd 提供 STATE_DIRECTORY，因此 SQLite 默认位于 `/var/lib/momo-mcp/review.sqlite`，已有 ReadWritePaths 允许写入；也可显式配置 LOCAL_REVIEW_DB_PATH，确保父目录可写。启动时初始化／迁移数据库，失败则服务启动失败，不伪装成成功保存。库文件和 WAL 不提交到 Git。数据库连接在服务关闭时释放，构建或重启不删除学习记录。

0.3.1 启动时将版本 1／2 的复习库迁移到版本 3，增加撤回去重表和历史分页索引，保留原事件、快照、汇总与命名空间盐。无需手动清库。已撤回事件的去重标记跨重启保留，原上报重试不会恢复。

```bash
sudo install -m 644 deploy/momo-mcp.service /etc/systemd/system/momo-mcp.service
sudo systemctl daemon-reload
sudo systemctl enable --now momo-mcp.service
```

服务用户需要读取项目文件和环境文件。运行时需要 `dist/`、`reference/`、`upstream-skills/` 和 `node_modules/`。模板启用了只读系统目录、独立临时目录和 `/var/lib/momo-mcp` 状态目录。

改动代码后，在项目目录执行 `npm run check`，再运行 `sudo systemctl restart momo-mcp.service` 加载新构建。

## Nginx

仓库提供通用 `deploy/nginx.conf.example`。将里面的域名和 TLS 证书路径换成自己的配置，并安装 `deploy/mcp-streamable-http.conf` 到 `/etc/nginx/snippets/`。

`deploy/mcp.example.com.nginx.conf` 保留已有部署的域名示例。它将 `/momo` 转发到 `127.0.0.1:8787/momo`，`/momo/healthz` 转发到服务的 `/healthz`。共享片段转发 Authorization，关闭缓冲，并给工具调用留出较长超时时间。

浏览器的 HTML 请求跳转到同站点的 `/center/` 管理中心，MCP 继续使用原路径的 POST 接口。当前 transport 不提供 SSE GET 会话或 DELETE 会话；相应协议请求返回 405，并继续进行入口认证检查。

## 凭据、写操作与日志

墨墨／Markji 官方写操作默认关闭。开启 `ALLOW_MUTATIONS=true` 后，客户端仍需在用户确认具体操作后传 `confirm: true`。服务不自动重试官方写请求；错误标明操作可能已成功时，先查看官方状态。

本地问词反馈、实际 AI 作答的对错以及读取到的今日首次反馈自动保存到复习库，无需逐条确认。学习记录长期保留，按带本地随机盐的凭据指纹隔离；原始 Token、聊天全文和答案内容不保存，更换 Token 暂不合并历史。本地上报事件支持按 ID 撤回并重算统计，保留最小去重标记；独立的每日首次反馈快照仍保留。日常查询仍限定当天，历史仅供明确的长期请求或定位误报。存储与权重详见 [复习追踪](review.md)。

客户端和反向代理各自可能保留日志。反向代理不要记录 Authorization，Token 不应放进 URL；客户端或 AI 平台如何保存工具结果，取决于其自身设置。

OAuth 登录、refresh-token 存储和自动续期尚未实现。需要 OAuth 的客户端不能仅凭登记回调地址接入；当前必须使用支持 Bearer 认证的客户端。

## 检查部署

本地健康检查：

```bash
curl -fsS http://127.0.0.1:8787/healthz
```

它报告服务状态和脱敏配置，不验证墨墨账户授权。MCP 连通后，用 `maimemo_status` 检查配置，再通过一个只读工具验证 Token。Token 不会出现在状态响应中。
