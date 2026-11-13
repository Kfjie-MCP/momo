# Study API (学习数据)

Local MCP adaptation: the original endpoint and response names remain unchanged, while the module descriptions below use the corrected business semantics.

**Beta (公测)**: 限时试用，不保证可用性，可能随时调整。需要打开自动同步。如果当日未打开 App 进行初始化则无法准确计算。

## Module routing (必须区分)

| User request | Preferred MCP tool | Meaning |
|-------------|--------------------|---------|
| 今天易错词再复习／未指定时段的复习 | `maimemo_get_today_review_words` (`mode=focus`) | Default: today's user questions, actual AI answers and first upstream feedback only |
| 今天剩余的单词建议 | `maimemo_get_today_review_words` (`mode=remaining`) | Reads progress and queue internally; suggested batch, not confirmed App assignment |
| 完成用户问词讲解／收到实际复习答案 | `maimemo_report_word_events` | Prompt local reporting, separate question and quiz counts, event-ID deduplication |
| 明确查询长期／历史易错词 | `maimemo_get_long_term_review_words` | Separate long_term scope; recent decay, recurring difficult days and sticky tags |
| 某词以前问过／错过多少次，定位误报 | `maimemo_get_word_review_history` | Today, last 30 days, cumulative data and event IDs; `next_cursor`/`cursor` pages older events |
| 撤回本地误报，包括旧事件 | `maimemo_retract_word_events` | Exact event IDs, local statistics recomputed; retries never restore withdrawn events (local adaptation 2026-10-14) |
| 今天要学多少、已完成多少、还剩多少 | `maimemo_get_study_progress` | `data.progress.total` is today's authoritative target; `finished` is completed today |
| 当前待学习／复习队列、队列中新词 | `maimemo_get_study_queue_items` | Current queue, not a confirmed daily word list; old tool name `maimemo_get_today_items` still works |
| 队列返回多少、是否完整、是否还有条目 | `maimemo_get_study_queue` | Enhanced read of up to 1000 queue entries with explicit completeness and unknown totals |
| 批量查询几个词的自建内容及学习记录 | `maimemo_get_vocabulary_details` | Existing API aggregation, not the App's entire dictionary |
| 学习计划总量、某词学习记录、复习排期 | `maimemo_query_study_records` | Plan/history; count with `as_count=true`, no filters for plan total |

`get_today_items` and response key `today_items` are historical names for **study queue items**. A queue of 233/235 words does not mean that today's target is 233/235. Only `get_study_progress.progress.total` determines the daily target. `limit` (default 50, max 1000) only caps this query's result; filters and the cap may prevent an exhaustive queue count.

Local review adaptation (2026-10-13): use the new today tool directly for review rather than assembling per-word details. Today's weights reset by Asia/Shanghai date; historical frequency and study duration do not enter them. New review progress contains only total, finished and remaining. Report real user lookup/mnemonic/comparison/confusion events after explanations and real incorrect/correct answers after quizzes; questions are not mistakes. Event IDs make retries safe. Local observations are saved automatically without confirm, independently of official mutations. Explicit long-term review uses a separate tool, and history covers only reports/observations since connection. Sticky labels never imply known historical mistake counts.

For “today's words”, first get progress. Progress returns counts, not word identities. A practical next batch can be suggested from queue entries with `is_finished=false`, in `order`, selecting at most `max(0, total - finished)` entries. Clearly label it as **按队列顺序建议的今日学习批次**. Do not claim that the first N queue entries are the App's confirmed daily assignment. When remaining is zero, today's target is complete even if the queue is nonempty. If progress is unavailable/uninitialized, the daily target is unknown; do not substitute queue length or the default limit.

## MCP aggregations (existing API functionality)

`maimemo_get_study_queue` accepts `body` with the existing queue filters and an optional display `limit` (1–1000, default 1000). It fetches up to 1000 upstream entries once, preserves upstream order and displays the requested prefix. It returns:

| Field | Meaning |
|-------|---------|
| `items` | Queue entries with the original fields plus same-value `first_response_today`; missing feedback becomes null |
| `returned_count` | Number displayed in `items` |
| `fetched_count` | Number read from upstream, at most 1000 |
| `total_count` | Total matching this query if upstream returned fewer than 1000; otherwise null |
| `has_more` | true if fetched items exist beyond the displayed prefix; false if complete and none left; null if at the cap with no known remaining item |
| `completeness` | complete for a result below the upstream cap; otherwise unknown |
| `count_scope` | matching_query; filtered counts are not the whole queue or daily target |
| `total_count_source` | returned_below_upstream_limit or unknown; never an official count endpoint |
| `pagination_supported` | false; no cursor/offset or claim that entries beyond 1000 can be fetched |
| `order_policy` | upstream_response_order; no inference about today's assigned words |

`maimemo_get_vocabulary_details` accepts 1–10 `voc_ids` and optional `include`: interpretations, notes, phrases, study_record (all by default). It aggregates existing official endpoints. Basic vocabulary is always queried, IDs are deduplicated, and returned items retain the requested order. Definitions/mnemonics/examples are only self-created content. Check `partial`, `include` and each item's `errors`; do not equate null with a successful empty result. Starts are paced 600ms apart, with at most 3 active calls, at most 32 requests per full 10-word batch, a 50-second total budget, and no automatic retry.

All operation failures preserve the old `error` string and add `error_details`: code, message, http_status, retryable, retry_after_seconds, mutation_may_have_succeeded. A 401 is AUTH_INVALID (invalid or expired; no narrower claim). A 429 is RATE_LIMITED, with Retry-After when available. For writes, retryable is false; check state when mutation_may_have_succeeded is true.

## Endpoints

### POST /study/get_study_progress — Today's target and progress

No request body needed.

MCP: `maimemo_get_study_progress`. `progress.total` is the source of truth for today's required count. This endpoint does not return a word list.

**Response**:
```json
{
  "progress": {
    "finished": 10,
    "total": 20,
    "study_time": 114514
  }
}
```

```bash
curl -s -X POST "https://open.maimemo.com/open/api/v1/study/get_study_progress" \
  -H "Authorization: Bearer $MAIMEMO_TOKEN"
```

### POST /study/get_today_items — Current study queue (historical endpoint name)

MCP: prefer `maimemo_get_study_queue_items`; `maimemo_get_today_items` is a compatible alias. Both invoke this same endpoint and preserve its response keys.

**Body params** (all optional):

| Field | Type | Description |
|-------|------|-------------|
| `is_finished` | boolean | Filter queue by today's completion status; false = pending study/review, possibly beyond today's target |
| `is_new` | boolean | Filter new words in the queue; does not prove daily assignment |
| `voc_ids` | string[] | Query by voc_ids (max 1000); MCP rejects combining with spellings or is_finished/is_new because upstream would ignore the other filters |
| `spellings` | string[] | Query by spellings (max 1000); MCP rejects combining with voc_ids or is_finished/is_new |
| `limit` | integer | Query cap by study order (default 50, max 1000), unrelated to the daily target |

**Response**: `{ "today_items": [StudyTodayItem, ...] }`

`today_items` contains queue entries, not a daily target list. Array length is the number returned by this query, not today's required count.

```bash
# Pending study/review queue (not limited to today's target)
curl -s -X POST "https://open.maimemo.com/open/api/v1/study/get_today_items" \
  -H "Authorization: Bearer $MAIMEMO_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"is_finished": false, "limit": 1000}'
```

### POST /study/query_study_records — Query study records

**Body params** (all optional):

| Field | Type | Description |
|-------|------|-------------|
| `next_study_date.start` | ISO 8601 | Filter ≥ date (Beijing timezone) |
| `next_study_date.end` | ISO 8601 | Filter ≤ date (Beijing timezone) |
| `voc_ids` | string[] | Query by voc_ids; MCP rejects spellings or next_study_date/tags conflicts instead of silently ignoring filters |
| `spellings` | string[] | Query by spellings (max 1000); MCP rejects voc_ids or next_study_date/tags conflicts |
| `tags` | string | Request supports single STICKING only; response record tags are arrays, not the request type |
| `as_count` | boolean | Return count only, no data list |
| `limit` | integer | Max results by next_study_date order (default 50, max 1000) |

**Response**: `{ "records": [StudyRecord, ...], "count": 114514 }`

- When `as_count=true`: `records` is empty, `count` has the total.
- When `as_count=false`: `records` has data, `count` is 0.
- With `as_count=true` and no filters, `count` is the study plan total. With filters it is the matching record count. Neither value is today's target or the current queue size.

```bash
# Total words in plan
curl -s -X POST "https://open.maimemo.com/open/api/v1/study/query_study_records" \
  -H "Authorization: Bearer $MAIMEMO_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"as_count": true}'
```

### POST /study/add_words — Add words to study plan

Add words to your study plan. Optionally advance them to immediate review.

**Body params**:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `words` | array | yes | List of word objects, max 1000 |
| `words[].id` | string | yes | Word ID (voc_id), get via vocabulary API |
| `advance` | boolean | yes | Also advance to immediate review (no level limit) |

**Response**: `{ "added_count": 114 }`

- `added_count`: Number successfully added (may be less than requested due to word limits or already in plan)

```bash
# Add words without advancing
curl -s -X POST "https://open.maimemo.com/open/api/v1/study/add_words" \
  -H "Authorization: Bearer $MAIMEMO_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "words": [
      {"id": "word_id_1"},
      {"id": "word_id_2"}
    ],
    "advance": false
  }'

# Add and advance immediately
curl -s -X POST "https://open.maimemo.com/open/api/v1/study/add_words" \
  -H "Authorization: Bearer $MAIMEMO_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "words": [{"id": "word_id_1"}],
    "advance": true
  }'
```

### POST /study/advance_study — Advance words to immediate review

Move words to immediate review (next study date = now). Requires level 10+ to unlock advance review feature.

**Body params**:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `voc_ids` | string[] | yes | Word IDs to advance, max 1000 |

**Response**: `{ "advanced_count": 514 }`

- `advanced_count`: Number successfully advanced (may be less if words not in plan)

```bash
curl -s -X POST "https://open.maimemo.com/open/api/v1/study/advance_study" \
  -H "Authorization: Bearer $MAIMEMO_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "voc_ids": ["word_id_1", "word_id_2"]
  }'
```

## Usage Scenes

### 1. Words left today / study time
```bash
curl -s -X POST ".../study/get_study_progress" \
  -H "Authorization: Bearer $MAIMEMO_TOKEN"
# → max(0, total - finished) = remaining; study_time / 60000 = minutes
```

### 2. Forgotten words today
```bash
curl -s -X POST ".../study/get_today_items" \
  -H "Authorization: Bearer $MAIMEMO_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"is_finished": true, "limit": 1000}'
# → filter items where first_response = "FORGET"
```

### 3. New words in the study queue
```bash
curl -s -X POST ".../study/get_today_items" \
  -H "Authorization: Bearer $MAIMEMO_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"is_new": true, "limit": 1000}'
```

### 4. Pending study/review queue
```bash
curl -s -X POST ".../study/get_today_items" \
  -H "Authorization: Bearer $MAIMEMO_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"is_finished": false, "limit": 1000}'
```

### 5. Specific word's queue state and study history
```bash
curl -s -X POST ".../study/get_today_items" \
  -H "Authorization: Bearer $MAIMEMO_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"spellings": ["apple"]}'
# get_today_items only gives queue state; for study records use query_study_records:
curl -s -X POST ".../study/query_study_records" \
  -H "Authorization: Bearer $MAIMEMO_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"spellings": ["apple"]}'
```

### 6. Words due in next N days
```bash
# Example: words due by April 1st
curl -s -X POST ".../study/query_study_records" \
  -H "Authorization: Bearer $MAIMEMO_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"next_study_date": {"end": "2026-04-01T00:00:00+08:00"}, "as_count": true}'
```

### 7. Total words in plan
```bash
curl -s -X POST ".../study/query_study_records" \
  -H "Authorization: Bearer $MAIMEMO_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"as_count": true}'
```

### 8. Frequently forgotten words (sticky)
```bash
# Paginate with sliding date window, filter tags = "STICKING"
curl -s -X POST ".../study/query_study_records" \
  -H "Authorization: Bearer $MAIMEMO_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"limit": 1000}'
# → filter records where tags = "STICKING"
```

### 9. Well-familiar words
```bash
curl -s -X POST ".../study/query_study_records" \
  -H "Authorization: Bearer $MAIMEMO_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"limit": 1000}'
# → filter records where tags = "WELL_FAMILIAR"
```

### 10. Export all study data
Paginate via sliding `next_study_date` window since API returns max 1000 per call:
```bash
# Page 1: earliest records
curl -s -X POST ".../study/query_study_records" \
  -H "Authorization: Bearer $MAIMEMO_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"limit": 1000}'
# Page 2+: use last record's next_study_date as new start
# -d '{"next_study_date": {"start": "LAST_RECORD_DATE"}, "limit": 1000}'
# Repeat until fewer than 1000 records returned.
```

### 11. Words due on a specific date range
```bash
curl -s -X POST ".../study/query_study_records" \
  -H "Authorization: Bearer $MAIMEMO_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"next_study_date": {"start": "2026-03-20T00:00:00+08:00", "end": "2026-03-25T00:00:00+08:00"}, "limit": 1000}'
```

### 12. Words due on a date
```bash
curl -s -X POST ".../study/query_study_records" \
  -H "Authorization: Bearer $MAIMEMO_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"next_study_date": {"end": "2026-03-25T00:00:00+08:00"}, "limit": 1000}'
```

### 13. Add words to study plan
```bash
# First lookup word IDs
curl -s -X POST ".../vocabulary/query" \
  -H "Authorization: Bearer $MAIMEMO_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"spellings": ["apple", "banana"]}'

# Then add them
curl -s -X POST ".../study/add_words" \
  -H "Authorization: Bearer $MAIMEMO_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "words": [
      {"id": "voc_id_1"},
      {"id": "voc_id_2"}
    ],
    "advance": false
  }'
```

### 14. Add and immediately review words
```bash
# Add words and advance them for immediate review (no level limit)
curl -s -X POST ".../study/add_words" \
  -H "Authorization: Bearer $MAIMEMO_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "words": [{"id": "voc_id_1"}, {"id": "voc_id_2"}],
    "advance": true
  }'
```

### 15. Advance existing words for immediate review
```bash
# Advance words already in your plan (requires level 10+)
curl -s -X POST ".../study/advance_study" \
  -H "Authorization: Bearer $MAIMEMO_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"voc_ids": ["voc_id_1", "voc_id_2"]}'
```

## StudyResponse Enum

| Value | Description |
|-------|-------------|
| `FAMILIAR` | 认识 |
| `VAGUE` | 模糊 |
| `FORGET` | 忘记 |
| `WELL_FAMILIAR` | 熟知 |
| `CANCEL_WELL_FAMILIAR` | 取消熟知 |
| `STUDY_RESPONSE_UNSPECIFIED` | 未指定／无可用反馈，不能当作认识或忘记 |

## StudyProgress Schema

| Field | Type | Description |
|-------|------|-------------|
| `finished` | integer | Words completed today |
| `total` | integer | Authoritative target word count today; never substitute queue length, plan count or limit |
| `study_time` | integer | Study time in milliseconds |

## StudyTodayItem Schema

Historical schema name for one current study queue entry. It does not identify the App's daily assignment.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `voc_id` | string | yes | Word id |
| `voc_spelling` | string | yes | Word spelling |
| `order` | integer | yes | Upstream queue order value; numeric direction/daily recomputation/global stability not documented; service preserves response order and never infers daily assignment |
| `first_response` | StudyResponse | no | Today's first feedback, not historical first/latest; missing or unspecified is unknown. Enhanced queue returns same-value first_response_today |
| `is_new` | boolean | yes | Is a new word in the queue, not necessarily assigned today |
| `is_finished` | boolean | yes | Finished today; a queue filter, not membership in today's target |

## StudyRecord Schema

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `voc_id` | string | yes | Word id |
| `voc_spelling` | string | yes | Word spelling |
| `add_date` | ISO 8601 | yes | Date added |
| `first_study_date` | ISO 8601 | no | First study date |
| `last_study_date` | ISO 8601 | no | Last study date |
| `next_study_date` | ISO 8601 | no | Next study date |
| `last_response` | StudyResponse | no | Last response |
| `study_count` | integer | yes | Study count (max 1/day) |
| `tags` | string[] | yes | Array of STUDY_RECORD_TAG_UNSPECIFIED, STICKING and/or WELL_FAMILIAR, including []; request body.tags remains single STICKING |
