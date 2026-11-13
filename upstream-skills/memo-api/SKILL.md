---
name: memo-api
description: >
  墨墨背单词 MaiMemo Open API skill for vocabulary learning.
  Handles: 单词 vocabulary lookup (voc_id), 释义 interpretations (CRUD),
  助记 mnemonics/notes, 云词本 notepads/word lists, 例句 phrases/example sentences,
  学习数据 study progress/review schedule/study records.
  Triggers on: 墨墨, maimemo, 背单词, 释义, 助记, 云词本, 例句, study progress,
  review schedule, words due, forgotten words, study time, export study data.
version: "1.2.0"
metadata:
  openclaw:
    requires:
      env:
        - MAIMEMO_TOKEN
      binds:
        - curl
---

# MaiMemo Open API

Local MCP adaptation: study routing and terminology below are corrected for this server. Original API paths and JSON keys remain compatible.

## Auth & Base

- **Base URL**: `https://open.maimemo.com/open/api/v1`
- **Token**: env var `$MAIMEMO_TOKEN` — obtain it from either:
  - App: 墨墨背单词 → 开放 API
  - Web: open `https://open.maimemo.com/open/api/v1/tokens/openapi`, log in to the MaiMemo account, ask the user to copy the Token and paste it back, then set it as `$MAIMEMO_TOKEN`
- **Token expiry**: Tokens from the web source are valid for 7 days. If an API call indicates the token is expired/invalid (for example auth failure), tell the user to repeat the web login/copy/paste flow and update `$MAIMEMO_TOKEN`.
- **Auth header**: `Authorization: Bearer $MAIMEMO_TOKEN`

```bash
curl -s -X ${METHOD} "${BASE}/${PATH}" \
  -H "Authorization: Bearer $MAIMEMO_TOKEN" \
  -H "Content-Type: application/json" \
  -d '${BODY}'
```

**Rate limits**: 20/10s, 40/60s, 2000/5h

## Key Concepts

- **voc_id resolution**: Most endpoints need `voc_id`, not spelling. Resolve via `GET /vocabulary?spelling=word` or `POST /vocabulary/query` (batch up to 1000).
- **POST for updates**: Update endpoints use `POST /resource/{id}`, not PUT/PATCH.
- **Status values**: Resources use status enums (`PUBLISHED`, `UNPUBLISHED`, `DELETED`) — vary by domain.
- **Timestamps**: All times are ISO 8601. Study date filters use Beijing timezone (UTC+8).

## Domain Routing

| Task | Read reference file |
|------|-------------------|
| Look up voc_id / spelling → id | `vocabulary-api.md` |
| CRUD custom definitions | `interpretations-api.md` |
| CRUD mnemonics (联想/谐音/派生/词根/词源/固搭/语法/对比 etc.) | `notes-api.md` |
| Manage word lists / cloud notepads | `notepads-api.md` |
| CRUD example sentences | `phrases-api.md` |
| Today's target/progress, study queue, plan records and schedules | `study-api.md` |

**Before calling any endpoint**, read the corresponding reference file for exact params, body schema, and curl examples.

## Study Usage Scenes

All study endpoints are **POST** and **beta** (需要打开自动同步).

Keep three scopes separate: **today's target/progress**, **current study queue**, and **study plan/records**. `get_study_progress.progress.total` is the source of truth for today's target. `get_today_items` and its historical response key `today_items` mean the current study queue, which may contain 233/235 words while today's target is 50. Its default `limit=50` is only a query cap. Plan count is a third, separate metric.

Local MCP adaptation (2026-10-13): default review requests to `maimemo_get_today_review_words` with `mode=focus`. For a suggested remaining batch use `mode=remaining`; it reads progress and the pending queue internally, selects at most `max(0, total-finished)` candidates in upstream array order, then samples them. Label this a **suggested batch from the queue**, not the App's confirmed daily assignment. If remaining is zero the batch is empty; if progress is unavailable do not guess from queue length. Today's score uses only today's signals in Asia/Shanghai, never historical mistake frequency or study duration.

After answering an actual user word question or receiving a scorable quiz answer, call `maimemo_report_word_events` promptly within the same turn. Record lookup/mnemonic/comparison/confusion separately from actual incorrect/correct answers; never report AI-generated lists as user questions. Use unique event IDs and reuse them on retries. Local events and daily snapshots are saved automatically without per-event confirmation or ALLOW_MUTATIONS; official account mutations still require confirmation. Only explicit historical/long-term review requests use `maimemo_get_long_term_review_words`, and explicit individual history requests use `maimemo_get_word_review_history`. Long-term tags are not historical mistake counts.

Local MCP adaptation (2026-10-14): when the user requests a retraction or an earlier report is confirmed incorrect, use `maimemo_retract_word_events` with the exact event IDs. Use `maimemo_get_word_review_history` and its `next_cursor`/`cursor` pagination to locate older events when necessary; never guess IDs or remove real mistakes merely to lower scores. Retraction recomputes local statistics and recommendations but preserves independent upstream snapshots. Repeated retractions are safe, and replaying the original report cannot restore a withdrawn event: report `retracted_count` means it was not saved. Corrected feedback needs a fresh event ID and its actual occurrence time.

### Today's Progress
**Endpoint**: `POST /study/get_study_progress` (empty body)
MCP tool: `maimemo_get_study_progress`. Returns `progress.finished` (today's done count), `progress.total` (authoritative daily target), `progress.study_time` (ms), under MCP `data.progress`. No word list is returned.

| Scene | Endpoint | Key params |
|-------|----------|-----------|
| Today's target | `get_study_progress` | use `progress.total`, never queue length |
| Words left today | `get_study_progress` | compute `max(0, total - finished)` |
| Study time today | `get_study_progress` | `study_time` (ms → min) |

### Current Study Queue
**Endpoint**: `POST /study/get_today_items`

Preferred MCP tool: `maimemo_get_study_queue_items`. `maimemo_get_today_items` remains a compatibility alias. The original `today_items` response key is retained and means queue entries; filters and `limit` may restrict the result. Do not claim a complete queue count from a filtered result or a result at the query cap.

For completeness checks prefer **`maimemo_get_study_queue`** with `body.is_finished=false`. It fetches at most 1000 entries and defaults to displaying 1000. Its `returned_count` counts displayed entries; `total_count` is the current filter's total only if fewer than 1000 were fetched, otherwise null. `has_more` is true when more entries were actually fetched than displayed, false when the fetched set is complete with none left, and null at an unresolved upstream cap. There is no cursor/offset pagination beyond that cap. Preserve upstream response order; the official docs do not guarantee numeric direction, daily recomputation, global stability or daily target membership for `order`.

`first_response` means today's first feedback, not historical first or latest feedback. The enhanced queue also returns `first_response_today` with the same value. Missing/unspecified feedback is unknown; never classify it as forgotten or familiar.

MCP rejects `voc_ids`/`spellings` conflicts and word selectors mixed with ignored status/date/tag filters before an upstream request. `limit` and `as_count` are controls, not these filters. This guard also covers legacy study CLI input/options.

| Scene | Endpoint | Key params |
|-------|----------|-----------|
| Completed queue words forgotten on today's first response | `get_today_items` | `is_finished: true`, filter `first_response = "FORGET"` |
| New words in queue | `get_today_items` | `is_new: true`; not a confirmed daily assignment |
| Pending study/review queue | `get_today_items` | `is_finished: false`; may exceed today's remaining target |
| Specific word's queue state | `get_today_items` | `spellings: ["word"]` or `voc_ids: ["id"]`; use records for history |

### Study Records
**Endpoint**: `POST /study/query_study_records`

| Scene | Endpoint | Key params |
|-------|----------|-----------|
| Words due in next N days | `query_study_records` | `next_study_date.end: "YYYY-MM-DDT00:00:00+08:00"`, `as_count: true` |
| Total words in plan | `query_study_records` | `as_count: true` (no filters); not daily target or queue length |
| Frequently forgotten (sticky) | `query_study_records` | iterate pages, filter `tags = "STICKING"` |
| Well-familiar words | `query_study_records` | iterate pages, filter `tags = "WELL_FAMILIAR"` |
| Export all study data | `query_study_records` | paginate via sliding `next_study_date` window, `limit: 1000` |

Request `body.tags` supports only a single `STICKING` value. Response `records.tags` is an array of `STUDY_RECORD_TAG_UNSPECIFIED`, `STICKING`, and/or `WELL_FAMILIAR`, including an empty array; do not copy its array type to the request filter.

### Batch Word Details

MCP tool: **`maimemo_get_vocabulary_details`**, input `voc_ids` (1–10 IDs) and optional `include` (`interpretations`, `notes`, `phrases`, `study_record`; all by default). IDs are deduplicated. Basic vocabulary is always fetched; content endpoints expose the user's own creations, not the App's entire dictionary. Use `include` to avoid unnecessary upstream calls.

The tool aggregates existing endpoints; it reduces agent calls, not official request quotas. A full 10-word batch attempts at most 32 upstream requests, starts calls 600ms apart, keeps at most 3 active, uses a 50-second total budget and never automatically retries. `partial=true` and per-word `errors` preserve component failures. An empty array is a successful query with no self-created content; null means unrequested/failed, or no study record when that query succeeded. Check `include` and `errors` to distinguish these cases.

### Error Handling

The legacy string `error` is retained. Operation failures add `error_details` with `code`, `message`, `http_status`, `retryable`, `retry_after_seconds`, and `mutation_may_have_succeeded`. Use `AUTH_INVALID` for a 401 without guessing whether it specifically expired; `AUTH_REQUIRED` means no token, `RATE_LIMITED` means quota, and `SERVICE_UNAVAILABLE` represents HTTP 503. For write failures never retry automatically; inspect state if the mutation may have succeeded.

### Adding Words
**Endpoint**: `POST /study/add_words`

| Scene | Endpoint | Key params |
|-------|----------|-----------|
| Add words to plan | `add_words` | `words: [{"id": "voc_id"}]`, max 1000 |
| Add and advance review | `add_words` | `advance: true` (also triggers immediate review, no level limit) |

### Advance Review
**Endpoint**: `POST /study/advance_study`

| Scene | Endpoint | Key params |
|-------|----------|-----------|
| Advance words for immediate review | `advance_study` | `voc_ids: ["voc_id1", ...]`, max 1000 |
| Requires level 10+ to unlock advance review feature | | |

## Multi-domain Workflow Hints

- **Add mnemonic to word**: Vocabulary (get voc_id) → Notes (create)
- **Add example sentence**: Vocabulary (get voc_id) → Phrases (create)
- **Add custom definition**: Vocabulary (get voc_id) → Interpretations (create)
- **Build word list from study data**: Study records (query) → Notepads (create with spellings)
- **Full word info**: Vocabulary (get voc_id) → Interpretations + Notes + Phrases (list all)
