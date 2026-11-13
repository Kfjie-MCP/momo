export const homePage = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="Memorize MCP 是独立开发的第三方学习助手，通过 MCP 连接学习工具。非墨墨官方应用，目前处于开发者测试阶段。">
<title>Memorize MCP · 第三方学习助手</title>
<style>
:root{color-scheme:light dark;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:#10191c;color:#e8f0ef}*{box-sizing:border-box}body{margin:0}main{max-width:960px;margin:auto;padding:64px 24px}a{color:#92e5c5}header{padding-bottom:36px;border-bottom:1px solid #34464a}.badge{display:inline-block;padding:6px 12px;border:1px solid #51776c;border-radius:24px;color:#a8e4cf;font-size:14px}h1{font-size:clamp(36px,7vw,64px);letter-spacing:-2px;margin:20px 0 12px}h2{font-size:23px;margin-top:0}h3{font-size:17px}p,li{line-height:1.85;color:#c5d4d5}section{margin-top:32px;padding:28px;background:#18262a;border:1px solid #304449;border-radius:16px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:20px}.grid section{margin-top:24px}code{overflow-wrap:anywhere;color:#ade6d2}nav{display:flex;flex-wrap:wrap;gap:20px;margin-top:24px}ul{padding-left:22px}footer{padding-top:30px;color:#a6b9bc;font-size:14px}@media(max-width:640px){main{padding:36px 18px}.grid{grid-template-columns:1fr;gap:0}section{padding:22px}}
</style>
</head>
<body><main>
<header><span class="badge">独立开发 · 开发者测试阶段</span>
<h1>Memorize MCP</h1><p>把单词、学习记录和自建内容，连接到你使用的 MCP 客户端。</p>
<p><strong>第三方学习助手，非墨墨官方应用。</strong>本服务由独立开发者维护，不代表墨墨或其关联方。</p>
<nav aria-label="页面导航"><a href="#features">应用功能</a><a href="#connection">接入状态</a><a href="#privacy">隐私与数据</a><a href="#support">支持与反馈</a></nav></header>
<div class="grid" id="features"><section><h2>查询与学习</h2><ul><li>查询单词及词汇信息</li><li>查询今日学习目标与完成进度</li><li>今日易错词随机复习与剩余学习建议</li><li>记录主动问词和实际复习反馈</li><li>按需查询长期易错词与单词历史</li><li>翻页查找并撤回误报的学习记录</li><li>查询待学习／复习队列、学习计划与记录</li></ul><p>日常复习默认只看今天，长期复习单独查询。待学习队列可能多于今日目标。学习数据以官方 API 返回为准，可能与 App 本地尚未同步的数据不同。</p></section>
<section><h2>管理自己的内容</h2><ul><li>释义、助记、例句和云词本</li><li>记忆卡、章节和相关文件</li><li>添加学习单词与提前复习</li></ul><p>修改官方账户内容要求调用端先取得用户明确确认，并提交确认参数。本地复习反馈和每日观察自动保存，无需逐条确认。仅应使用可信客户端。</p></section></div>
<section id="connection"><h2>接入状态</h2><p>MCP 服务地址：<code>{{MCP_PATH}}</code></p><p>同一地址在浏览器中展示本页，通过 POST 提供 MCP 服务。目前使用用户提供的官方访问令牌进行请求级认证；没有令牌不能调用 MCP 工具。</p><p><strong>OAuth 登录与自动续期尚未启用。</strong>OAuth 应用接入计划已暂停。本页不提供登录入口，也不会收集登录密码、授权码或刷新令牌。回调地址的登记不代表授权流程已完成。</p><p>当前仅供开发者测试，尚未开放公众注册。后续多用户服务需要分别授权，并完成凭据隔离和管理功能后才会开放。</p></section>
<section id="privacy"><h2>隐私与数据说明</h2><p>适用范围：当前测试版本。更新日期：2026 年 10 月 14 日。</p>
<h3>处理哪些信息</h3><p>执行请求时，服务器会在内存中处理访问令牌、工具参数及官方 API 的返回数据。相关业务请求发送至墨墨官方 API，结果返回给发起请求的 MCP 客户端。客户端或 AI 平台如何保存、使用这些内容，受其自身设置和隐私政策约束。</p>
<h3>保存与使用</h3><p>应用不把请求携带的原始访问令牌写入数据库。本地复习库长期保存最小学习记录：单词、主动提问类型、实际 AI 作答的对错、时间、重要程度以及读取到的墨墨每日首次反馈，按凭据的不可逆指纹隔离。不保存聊天全文或答案内容。记录用于今日和按需长期复习；提问不算答错，学习时长和单词停留时间不影响推荐。本地上报事件可以撤回，撤回后保留事件 ID、内容指纹和撤回时间作为去重标记，防止旧请求重试恢复。更换令牌暂不自动合并记录。为运行和排障，服务器可能保留访问及错误日志，包括 IP、访问时间、请求路径和状态码。不要把令牌、授权码或学习内容放在 URL 中；请勿在反馈中提供密钥。</p>
<h3>权限与删除</h3><p>权限仅用于用户要求的学习查询及内容管理。修改、删除等操作可能影响用户的官方账户数据。可以通过单词历史翻页定位本地上报事件，再要求 AI 按事件 ID 撤回；撤回会重算复习统计，独立的墨墨每日首次反馈仍保留。停止使用可断开 MCP 客户端并移除其中保存的令牌；如需使凭据失效，应使用官方提供的令牌或授权管理方式。断开客户端不会自动删除本地复习历史，整库或独立快照清理请联系部署维护者。官方账户内的数据需通过官方应用或相应 API 管理。</p>
<p>未来启用 OAuth 后，如需保存刷新令牌，将先补充凭据存储、保留期限及删除方式说明，再开放相应功能。</p></section>
<section id="support"><h2>支持与反馈</h2><p>本项目目前由开发者自用测试，尚未设置对公众开放的客服渠道。如通过开发者邀请参与测试，请通过原邀请渠道反馈，并提供发生时间、工具名称与脱敏错误信息，不要提供 Token 或密钥。</p><p>公开联系方式及数据请求渠道将在面向其他用户开放前补充。墨墨账户或官方 API 问题，请通过其官方支持渠道处理。</p></section>
<footer>Memorize MCP · 独立第三方项目 · 不提供官方身份或审核通过的保证。</footer>
</main></body></html>`;
