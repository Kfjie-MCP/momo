# Momo MCP

连接墨墨背单词与墨墨记忆卡：查询学习进度、复习易错词，管理自建词汇内容和卡组。

## 功能

| 场景 | 常用工具 |
| --- | --- |
| 今日目标与完成进度 | `maimemo_get_study_progress` |
| 今日复习与剩余词表建议 | `maimemo_get_today_review_words` |
| 上报学习反馈、撤回误报 | `maimemo_report_word_events`、`maimemo_retract_word_events` |
| 长期易错词与单词历史 | `maimemo_get_long_term_review_words`、`maimemo_get_word_review_history` |
| 待学习队列与批量词汇详情 | `maimemo_get_study_queue`、`maimemo_get_vocabulary_details` |
| 云词本、释义、助记和记忆卡 | `maimemo_*`、`markji_*` |

日常复习按当天记录推荐，长期复习单独查询。今日学习目标与队列长度是不同指标；释义、助记和例句接口返回用户自建内容。

## 快速开始

需要 Node.js 24+ 和墨墨开放 API Token。

```bash
git clone https://github.com/Kfjie-MCP/momo.git
cd momo
npm ci
npm run build
cp .env.example .env
node --env-file=.env dist/index.js
```

示例配置使用 `http://127.0.0.1:8787/momo`。客户端通过 Bearer 请求头提供墨墨 Token；也可选择服务端凭据模式。`npm start` 不会自动加载 `.env`。

官方账户写操作默认关闭，启用后仍需 `confirm: true`。复习反馈保存在本地 SQLite，详情见[复习追踪](docs/review.md)。当前接入使用 Bearer，不支持 OAuth。

## 文档

[工具说明](docs/tools.md) · [部署与认证](docs/deployment.md) · [复习追踪](docs/review.md) · [API 覆盖](docs/capabilities.md)

开发检查：`npm run check`。

本项目为第三方集成，数据来自墨墨官方开放 API。来源及许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
