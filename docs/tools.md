# 工具说明

服务提供 47 个工具：34 个官方业务操作、1 个队列兼容别名、2 个聚合工具、5 个复习追踪工具、4 个兼容及状态工具、1 个文档工具。参数以 MCP 返回的当前 schema 为准。

## 今日与长期复习

| 工具 | 参数 | 用途 |
| --- | --- | --- |
| `maimemo_get_today_review_words` | `mode=focus/remaining`（默认 focus）、`limit=20`、`exclude_spellings=[]` | 默认今日重点复习或剩余学习建议；范围固定 today |
| `maimemo_report_word_events` | `events`，每批 1–100 条 | 及时上报主动问词、实际答对或答错；本地保存、事件 ID 去重 |
| `maimemo_get_long_term_review_words` | `limit=20`、`exclude_spellings=[]` | 用户明确询问历史或长期时使用；范围固定 long_term |
| `maimemo_get_word_review_history` | `spelling`、`recent_events_limit=20`（每页最多 100）、可选 `cursor` | 今日、近 30 天、累计统计和事件 ID；沿用 `next_cursor` 翻页 |
| `maimemo_retract_word_events` | `event_ids`，每批 1–100 个 | 撤回当前账户的本地误报，包括旧事件；重算统计，保留重试去重标记 |

两个抽词工具的 limit 为 1–1000。今日权重只使用北京时间当天的记录；长期查询独立处理近期衰减、跨天反复和难记标签。查询今日词表会本地保存每日首次反馈快照，上报和撤回也只写本地库；都不修改墨墨账户，不要求 confirm。撤回仅作用于本地上报事件，独立的墨墨每日快照仍保留。使用墨墨官方写工具仍受 ALLOW_MUTATIONS 和 confirm 控制。

每项返回拼写、可选词汇 ID、推荐分数、来源、入选原因和统计。提问不能当作答错，ai_error_rate 只统计实际 AI 作答，未作答为 null；推荐分数不是错率。详情与调用示例见 [复习追踪](review.md)。

上报的 `accepted_count`、`duplicate_count`、`retracted_count` 分别表示新增、重复和已撤回而未恢复的条目；已撤回 ID 返回于 `retracted_event_ids`，不能声称本次已保存这些事件。撤回返回去重后的 `requested_count`，以及 `retracted_count`、`already_retracted_count`、`not_found_count` 和对应 ID 列表。只按已定位的准确 ID 操作，更正用新 ID 上报。

## 今日目标、队列和学习计划

| 工具 | 参数入口 | 返回内容 |
| --- | --- | --- |
| `maimemo_get_study_progress` | 无参数 | `data.progress` 中的今日目标、完成数和学习时长 |
| `maimemo_get_study_queue` | `body`，可省略 | 队列条目、查询数量和完整性信息 |
| `maimemo_get_study_queue_items` | `body`，没有条件时传 `{}` | 原接口返回的 `data.today_items` |
| `maimemo_get_today_items` | 同上 | `maimemo_get_study_queue_items` 的兼容别名 |
| `maimemo_query_study_records` | `body` | 学习记录、排期；`as_count=true` 时返回计数 |

`progress.total` 是今日目标，`finished` 是今日已完成数，`study_time` 的单位是毫秒。今日剩余数为 `max(0, total - finished)`。当目标已完成时，队列里仍然可以有待学词。

学习计划总量使用 `maimemo_query_study_records`，传 `body.as_count=true`，并且不加过滤。有过滤时，`count` 是匹配记录数。它与队列数量、今日目标分别统计不同范围。

## 队列完整性

查看未完成队列，显示前 50 条：

```json
{"name":"maimemo_get_study_queue","arguments":{"body":{"is_finished":false,"limit":50}}}
```

增强工具会向上游请求最多 1000 条，再按展示 `limit` 截取。默认展示上限也是 1000。假设这次从上游取到 233 条：

```json
{
  "returned_count": 50,
  "fetched_count": 233,
  "total_count": 233,
  "has_more": true,
  "completeness": "complete",
  "count_scope": "matching_query",
  "pagination_supported": false
}
```

完整返回还包括 `items`、`limit`、`upstream_limit`、`total_count_source`、`order_policy` 和 `warnings`。

| 字段 | 含义 |
| --- | --- |
| `returned_count` | 本次显示的条目数，即 `items.length` |
| `fetched_count` | 本次从上游读到的条目数 |
| `total_count` | 未达到 1000 条上限时，按返回数确定的匹配总量；达到上限时为 `null` |
| `has_more` | 已读到显示范围之外的条目时为 `true`；读完整且无剩余时为 `false`；达到上限、没有已知剩余时为 `null` |
| `completeness` | 未达到上游上限为 `complete`，达到上限为 `unknown` |
| `count_scope` | 固定为 `matching_query`，计数只针对本次条件 |
| `total_count_source` | `returned_below_upstream_limit` 或 `unknown`，说明总数来自哪里 |
| `pagination_supported` | 固定为 `false`，上游没有 cursor 或 offset |
| `order_policy` | 固定为 `upstream_response_order`，服务保留上游数组顺序 |

`completeness=complete` 表示后台这次读取完整，展示列表仍可能因 `limit` 而缩短。`has_more=true` 只表示已经读取的数据中还有条目；它不代表上游提供了下一页接口。

`total_count=null` 表示未知。不能把它当成 0，也不能把恰好读到的 1000 条当成完整总量。

### 单词状态

`order` 是上游给出的学习顺序值。官方没有说明数值方向、是否每日重算或跨查询是否稳定，也没有规则保证前 `progress.total` 个词就是今日安排。智能体可以建议按队列学习的批次，具体今日归属仍然未知。

`first_response` 是当天首次学习反馈。增强工具增加同值的 `first_response_today` 字段；原字段缺省时，这个别名为 `null`。`STUDY_RESPONSE_UNSPECIFIED` 表示没有可用反馈，不能当作认识或忘记。

`is_finished` 表示是否已完成当日学习，`is_new` 表示是否为新学词。用它们筛选队列，不会确认一个词是否属于今日目标。

## 批量单词详情

```json
{"name":"maimemo_get_vocabulary_details","arguments":{"voc_ids":["VOC_ID_1","VOC_ID_2"],"include":["notes","phrases","study_record"]}}
```

`voc_ids` 接受 1 到 10 个非空 ID。重复 ID 会去重，结果保留第一次出现的顺序。`include` 可选 `interpretations`、`notes`、`phrases`、`study_record`，默认全部；基础词汇信息总会查询。

每项返回 `voc_id`、`spelling`、`vocabulary`、所选内容和 `errors`。整体还返回 `requested_count`、`unique_count`、`include`、`upstream_requests`、`partial`、`content_scope` 和 `warnings`。

释义、助记、例句是用户自建内容。成功查询后返回空数组，表示没有对应自建内容。`null` 可能表示未请求、请求失败，或者成功查询后没有学习记录；结合 `include` 和每项 `errors` 判断。`partial=true` 时，成功部分仍然可用。

聚合工具使用现有接口：基础词汇和学习记录各批量查询一次，内容接口按词查询。完整的 10 词批次最多发出 32 次官方请求，启动间隔 600 毫秒，最多 3 个请求同时执行，整批预算 50 秒。认证、限流或服务故障会停止尚未发出的请求。每个请求和聚合结果均有 8 MiB 上限。

同一账户的其他调用仍然共享官方配额。可用 `include` 减少请求；服务不会自动重试。

## 筛选参数

| 接口 | 不能混用的条件 |
| --- | --- |
| 队列查询 | `voc_ids` 和 `spellings` 互斥；任一词选择条件不能与 `is_finished`、`is_new` 混用 |
| 学习记录 | `voc_ids` 和 `spellings` 互斥；任一词选择条件不能与 `next_study_date`、`tags` 混用 |
| 批量词汇查询 | `ids` 和 `spellings` 互斥 |

这些组合会在请求前返回 `INVALID_ARGUMENT_COMBINATION`，防止上游成功返回数据却忽略部分条件。显式传 `false` 也算筛选条件。`limit` 和 `as_count` 是控制参数，可以与词选择条件一起使用。旧版学习 CLI 的 JSON 输入和选项同样检查冲突。

学习记录请求里的 `body.tags` 目前只接受单值 `STICKING`。返回的 `records.tags` 是数组，可含 `STUDY_RECORD_TAG_UNSPECIFIED`、`STICKING`、`WELL_FAMILIAR`，也可为空。请求与响应的类型不同。

## 返回与错误

成功返回保留以下结构：

```json
{"ok":true,"data":{},"error":null}
```

操作失败时，原有 `error` 字符串仍然可用，同时提供 `error_details`：

```json
{
  "ok": false,
  "data": null,
  "error": "Official API HTTP 429: rate limit; retry later",
  "error_details": {
    "code": "RATE_LIMITED",
    "message": "Official API HTTP 429: rate limit; retry later",
    "http_status": 429,
    "retryable": true,
    "retry_after_seconds": 5,
    "mutation_may_have_succeeded": false
  }
}
```

| 错误代码 | 说明 |
| --- | --- |
| `AUTH_REQUIRED` | 未提供墨墨 Token |
| `AUTH_INVALID` | 官方返回 401，Token 无效或过期，无法进一步断定原因 |
| `PERMISSION_DENIED` | 官方返回 403 |
| `RATE_LIMITED` | 官方返回 429；存在有效 Retry-After 时给出等待秒数 |
| `NOT_FOUND` | 官方返回 404，或批量词汇结果没有对应 ID |
| `INVALID_ARGUMENT` | 参数无效，或官方返回 400、422 |
| `INVALID_ARGUMENT_COMBINATION` | 会被忽略的冲突条件，尚未发送上游请求 |
| `MUTATIONS_DISABLED` | 服务未启用写操作 |
| `UPSTREAM_REJECTED` | 官方响应明确表示操作失败 |
| `UPSTREAM_SCHEMA_MISMATCH` | 官方响应不是有效 JSON 或不符合当前 schema |
| `UPSTREAM_ERROR` | 其他官方 HTTP 错误 |
| `SERVICE_UNAVAILABLE` | 官方返回 503 |
| `NETWORK_ERROR`、`TIMEOUT` | 官方请求的网络故障或超时 |
| `RESPONSE_TOO_LARGE` | 单次或聚合响应超过大小上限 |
| `LOCAL_STORAGE_ERROR` | 本地复习库打开、迁移或读写失败；未确认保存或撤回的操作用原事件 ID 重试 |
| `INTERNAL_ERROR` | 未归入上述类别的执行错误；旧版 CLI 无法确定类别时也可能使用此代码 |

`http_status=null` 表示没有对应 HTTP 状态，`retry_after_seconds=null` 表示没有有效等待时间。`retryable` 只供调用端判断，服务不自动重试。

写操作的 `retryable` 为 `false`。`mutation_may_have_succeeded=true` 时，先查状态再决定下一步。SDK 参数校验等协议层错误可能使用标准 MCP 错误，不经过上述操作响应。

## 其他入口

专用 API 工具按 `path`、`query`、`body` 分组传参；写工具另需 `confirm: true`。`maimemo_status` 查看脱敏配置，`maimemo_help` 查看 CLI 参数。日常调用优先使用专用工具，`maimemo_read` 和 `maimemo_write` 用于旧版 CLI 兼容。

`maimemo_documentation` 读取 `openapi`、`memo-api`、`study`、`vocabulary`、`notes`、`interpretations`、`phrases`、`notepads` 和 `markji-card-syntax` 文档。这些材料也通过 9 个 `maimemo://docs/*` 资源提供。`maimemo_workflow` 和 `markji_cards` 是客户端可读取的工作流提示。
