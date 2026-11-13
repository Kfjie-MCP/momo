import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AppConfig } from "../src/config.js";
import { ApiError } from "../src/errors.js";
import { createMcpServer } from "../src/mcp.js";
import { ReviewStore, closeReviewStores, studyDate, type ReportEvent } from "../src/review-store.js";
import { invokeReportWordEvents, invokeRetractWordEvents, invokeTodayReviewWords, invokeLongTermReviewWords, invokeWordReviewHistory,
  sampleReviewWords, longTermItem, todayReviewDataSchema, longTermReviewDataSchema, reviewToolNames } from "../src/review.js";

const cleanup: (() => void)[] = [];
afterEach(() => { closeReviewStores(); for (const fn of cleanup.splice(0).reverse()) fn(); });
const NOW = Date.parse("2026-10-13T08:00:00Z");
const DATE = "2026-10-13";
const result = (data: unknown) => Response.json({ success: true, data });
const mockedFetch = (fn: (url: URL, init: RequestInit) => Response | Promise<Response>) => fn as typeof fetch;
const item = (spelling: string, first_response?: string, is_finished = false) => ({ voc_id: `id-${spelling}`, voc_spelling: spelling,
  first_response, is_finished, is_new: true, order: 1 });
function fixture() {
  const store = new ReviewStore(":memory:");
  cleanup.push(() => { try { store.close(); } catch {} });
  const config = { maimemoApiToken: randomUUID(), authMode: "server", allowMutations: false, cliTimeoutMs: 1000 } as AppConfig;
  const namespace = store.namespace(config.maimemoApiToken!);
  const dependencies = { store, now: () => NOW, random: () => 0.3, fetcher: mockedFetch(url => {
    if (url.pathname.endsWith("get_study_progress")) return result({ progress: { total: 5, finished: 2, study_time: 0 } });
    if (url.pathname.endsWith("get_today_items")) return result({ today_items: [] });
    if (url.pathname.endsWith("query_study_records")) return result({ records: [], count: 0 });
    return result({ voc: [] });
  }) };
  return { store, config, namespace, dependencies };
}
const event = (spelling: string, kind: ReportEvent["kind"], occurred_at?: string, importance?: ReportEvent["importance"]): ReportEvent =>
  ({ event_id: randomUUID(), spelling, kind, ...(occurred_at ? { occurred_at } : {}), ...(importance ? { importance } : {}) });
const code = (expected: string) => (error: unknown) => error instanceof ApiError && error.code === expected;
function temporaryDatabase() {
  const dir = mkdtempSync(join(tmpdir(), "momo-review-test-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "review.sqlite");
}

it("today: uses Beijing midnight rather than the server UTC calendar", () => {
  assert.equal(studyDate("2026-10-13T15:59:59Z"), "2026-10-13");
  assert.equal(studyDate("2026-10-13T16:00:00Z"), "2026-10-14");
});

it("today: separates active questions from quiz mistakes and deduplicates retries with omitted timestamps", async () => {
  const f = fixture();
  const events = [event("  Apple  ", "mnemonic"), event("apple", "comparison"), event("APPLE", "confusion")];
  assert.equal((await invokeReportWordEvents({ events }, f.config, f.dependencies)).accepted_count, 3);
  const retried = await invokeReportWordEvents({ events }, f.config, { ...f.dependencies, now: () => NOW + 1000 });
  assert.equal(retried.duplicate_count, 3);
  const history = await invokeWordReviewHistory({ spelling: "apple" }, f.config, f.dependencies);
  assert.equal(history.today!.counts.mnemonic, 1);
  assert.equal(history.today!.counts.incorrect, 0);
  assert.equal(history.today!.ai_error_rate, null);
  await invokeReportWordEvents({ events: [event("apple", "incorrect"), event("apple", "correct")] }, f.config, f.dependencies);
  assert.equal(f.store.daily(f.namespace, DATE)[0]!.ai_error_rate, 0.5);
  assert.equal(f.store.words(f.namespace).length, 1);
});

it("today: rejects ID reuse for another event and rolls back the whole batch", async () => {
  const f = fixture();
  const original = event("apple", "lookup");
  await invokeReportWordEvents({ events: [original] }, f.config, f.dependencies);
  await assert.rejects(invokeReportWordEvents({ events: [event("banana", "incorrect"), { ...original, kind: "incorrect" }] }, f.config, f.dependencies), code("INVALID_ARGUMENT"));
  assert.equal(f.store.words(f.namespace).length, 1);
  assert.equal(f.store.words(f.namespace)[0]!.counts.incorrect, 0);
});

it("today: rejects invalid and future feedback before any upstream call or storage allocation", async () => {
  const f = fixture();
  let calls = 0;
  const deps = { ...f.dependencies, fetcher: mockedFetch(() => { calls++; return result({ voc: [] }); }) };
  await assert.rejects(invokeReportWordEvents({ events: [event("apple", "correct", "2026-10-14T00:00:00Z")] }, f.config, deps), code("INVALID_ARGUMENT"));
  await assert.rejects(invokeReportWordEvents({ events: [{ event_id: "x", spelling: " ", kind: "correct" }] }, f.config, deps));
  assert.equal(calls, 0);
  assert.deepEqual(f.store.words(f.namespace), []);
});

it("today: weights reset across days and historical edits do not change today's result", async () => {
  const f = fixture();
  await invokeReportWordEvents({ events: [event("today", "comparison"), event("old", "incorrect", "2026-10-12T08:00:00Z")] }, f.config, f.dependencies);
  const before = await invokeTodayReviewWords({}, f.config, f.dependencies);
  assert.deepEqual(before.items.map(word => word.spelling), ["today"]);
  await invokeReportWordEvents({ events: Array.from({ length: 20 }, () => event("today", "incorrect", "2026-10-12T09:00:00Z", "important")) }, f.config, f.dependencies);
  const after = await invokeTodayReviewWords({}, f.config, f.dependencies);
  assert.deepEqual(after.items, before.items);
  const tomorrow = await invokeTodayReviewWords({}, f.config, { ...f.dependencies, now: () => Date.parse("2026-10-14T08:00:00Z") });
  assert.equal(tomorrow.items.length, 0);
});

it("today: snapshots retain completed forgotten words and never count repeated reads as attempts", async () => {
  const f = fixture();
  const deps = { ...f.dependencies, fetcher: mockedFetch(url => url.pathname.endsWith("get_study_progress")
    ? result({ progress: { total: 5, finished: 5, study_time: 0 } })
    : result({ today_items: [item("forgotten", "FORGET", true), item("unknown", "STUDY_RESPONSE_UNSPECIFIED"), item("known", "FAMILIAR", true)] })) };
  const first = await invokeTodayReviewWords({}, f.config, deps);
  await invokeTodayReviewWords({}, f.config, { ...deps, now: () => NOW + 5000 });
  assert.deepEqual(first.items.map(word => word.spelling), ["forgotten"]);
  const history = f.store.history(f.namespace, "forgotten", DATE, 20);
  assert.equal(history.all_time!.app_forget_days, 1);
  assert.equal(history.all_time!.counts.incorrect, 0);
  assert.equal(history.all_time!.ai_error_rate, null);
  assert.equal(history.all_time!.observed_days, 1);
  assert.equal(f.store.history(f.namespace, "unknown", DATE, 20).all_time, null);
});

it("today: valid snapshot updates replace the daily observation without inflating history", () => {
  const f = fixture();
  f.store.observe(f.namespace, DATE, [item("apple", "STUDY_RESPONSE_UNSPECIFIED")], NOW);
  f.store.observe(f.namespace, DATE, [item("apple", "VAGUE")], NOW + 1000);
  f.store.observe(f.namespace, DATE, [item("apple", "FORGET")], NOW + 2000);
  f.store.observe(f.namespace, DATE, [item("apple", "STUDY_RESPONSE_UNSPECIFIED")], NOW + 3000);
  const history = f.store.words(f.namespace)[0]!;
  assert.equal(history.app_vague_days, 0);
  assert.equal(history.app_forget_days, 1);
  assert.equal(history.observed_days, 1);
});

it("today: actual correct answers reduce weight and new difficulty restores priority", async () => {
  const f = fixture();
  await invokeReportWordEvents({ events: [event("apple", "incorrect")] }, f.config, f.dependencies);
  const before = await invokeTodayReviewWords({}, f.config, f.dependencies);
  await invokeReportWordEvents({ events: Array.from({ length: 3 }, () => event("apple", "correct", "2026-10-13T08:00:01Z")) }, f.config, { ...f.dependencies, now: () => NOW + 2000 });
  const improved = await invokeTodayReviewWords({}, f.config, f.dependencies);
  assert.ok(improved.items[0]!.score < before.items[0]!.score);
  await invokeReportWordEvents({ events: [event("apple", "confusion", "2026-10-13T08:00:03Z")] }, f.config, { ...f.dependencies, now: () => NOW + 4000 });
  const difficult = await invokeTodayReviewWords({}, f.config, f.dependencies);
  assert.ok(difficult.items[0]!.score > improved.items[0]!.score);
});

it("today: remaining uses authoritative counts and preserves the suggested upstream prefix", async () => {
  const f = fixture();
  const queue = [item("third"), item("first"), item("second"), item("outside"), item("done", "FORGET", true)];
  const deps = { ...f.dependencies, fetcher: mockedFetch((url, init) => {
    if (url.pathname.endsWith("get_study_progress")) return result({ progress: { total: 5, finished: 2, study_time: 0 } });
    assert.deepEqual(JSON.parse(init.body as string), { is_finished: false, limit: 1000 });
    return result({ today_items: queue });
  }) };
  const data = await invokeTodayReviewWords({ mode: "remaining", limit: 1000 }, f.config, deps);
  assert.equal(data.progress!.remaining, 3);
  assert.deepEqual(data.items.map(word => word.spelling).sort(), ["first", "second", "third"]);
  assert.equal(data.word_list_semantics, "suggested_pending_batch");
  assert.ok(data.warnings.some(warning => warning.includes("建议")));
  assert.equal(data.upstream_requests, 2);
  assert.ok(todayReviewDataSchema.safeParse(data).success);
});

it("today: a completed daily target returns no remaining batch even when the queue has words", async () => {
  const f = fixture();
  const data = await invokeTodayReviewWords({ mode: "remaining" }, f.config, { ...f.dependencies, fetcher: mockedFetch(url =>
    url.pathname.endsWith("get_study_progress") ? result({ progress: { total: 5, finished: 8, study_time: 0 } }) : result({ today_items: [item("apple", "FORGET")] })) });
  assert.equal(data.progress!.remaining, 0);
  assert.deepEqual(data.items, []);
});

it("today: ignores study duration and omits it from the recommendation interface", async () => {
  const f = fixture();
  let duration = 1000;
  const deps = { ...f.dependencies, fetcher: mockedFetch(url => url.pathname.endsWith("get_study_progress")
    ? result({ progress: { total: 5, finished: 2, study_time: duration } })
    : result({ today_items: [item("apple", "FORGET")] })) };
  const short = await invokeTodayReviewWords({}, f.config, deps);
  duration = 86_400_000;
  const idle = await invokeTodayReviewWords({}, f.config, deps);
  assert.deepEqual(short.items, idle.items);
  assert.deepEqual(short.progress, { total: 5, finished: 2, remaining: 3 });
  assert.ok(!JSON.stringify(todayReviewDataSchema.toJSONSchema()).includes("study_time"));
});

it("today: progress failure blocks remaining but focus can return local data with explicit gaps", async () => {
  const f = fixture();
  f.store.report(f.namespace, [event("apple", "mnemonic")], NOW);
  const deps = { ...f.dependencies, fetcher: mockedFetch(() => new Response(null, { status: 503 })) };
  await assert.rejects(invokeTodayReviewWords({ mode: "remaining" }, f.config, deps), code("SERVICE_UNAVAILABLE"));
  const focus = await invokeTodayReviewWords({}, f.config, deps);
  assert.equal(focus.partial, true);
  assert.equal(focus.progress, null);
  assert.equal(focus.items[0]!.spelling, "apple");
  assert.equal(focus.source_completeness.maimemo_queue, "unavailable");
});

it("today: capped queues disclose unknown completeness and exclusions prevent batch repeats", async () => {
  const f = fixture();
  const queue = Array.from({ length: 1000 }, (_, i) => item(`word${i}`, "VAGUE"));
  const deps = { ...f.dependencies, fetcher: mockedFetch(url => url.pathname.endsWith("get_study_progress")
    ? result({ progress: { total: 100, finished: 0, study_time: 0 } }) : result({ today_items: queue })) };
  const data = await invokeTodayReviewWords({ limit: 20, exclude_spellings: ["WORD0"] }, f.config, deps);
  assert.equal(data.source_completeness.maimemo_queue, "unknown");
  assert.equal(data.partial, true);
  assert.equal(data.items.length, 20);
  assert.equal(new Set(data.items.map(word => word.spelling)).size, 20);
  assert.ok(!data.items.some(word => word.spelling === "word0"));
});

it("today: midnight during upstream reads asks for a fresh query instead of mixing dates", async () => {
  const f = fixture();
  let now = Date.parse("2026-10-13T15:59:59Z");
  await assert.rejects(invokeTodayReviewWords({}, f.config, { ...f.dependencies, now: () => now, fetcher: mockedFetch(url => {
    now = Date.parse("2026-10-13T16:00:01Z");
    return url.pathname.endsWith("get_study_progress") ? result({ progress: { total: 5, finished: 2, study_time: 0 } }) : result({ today_items: [] });
  }) }), code("SERVICE_UNAVAILABLE"));
  assert.deepEqual(f.store.words(f.namespace), []);
});

it("today: local storage failure preserves upstream review with a warning and never reports saved events", async () => {
  const f = fixture();
  f.store.close();
  await assert.rejects(invokeReportWordEvents({ events: [event("apple", "lookup")] }, f.config, f.dependencies), code("LOCAL_STORAGE_ERROR"));
  const data = await invokeTodayReviewWords({}, f.config, { ...f.dependencies, fetcher: mockedFetch(url => url.pathname.endsWith("get_study_progress")
    ? result({ progress: { total: 5, finished: 2, study_time: 0 } }) : result({ today_items: [item("apple", "FORGET")] })) });
  assert.equal(data.partial, true);
  assert.equal(data.source_completeness.local, "unavailable");
  assert.equal(data.items[0]!.score, 6);
});

it("tracking: verifies request credentials once, then saves locally until the 15-minute cache expires", async () => {
  const f = fixture();
  f.config.authMode = "maimemo-token";
  let now = NOW;
  let calls = 0;
  const deps = { ...f.dependencies, now: () => now, fetcher: mockedFetch((url, init) => {
    calls++; assert.ok(url.pathname.endsWith("vocabulary/query"));
    assert.equal((init.headers as Record<string, string>).Authorization, `Bearer ${f.config.maimemoApiToken}`);
    return result({ voc: [] });
  }) };
  await invokeReportWordEvents({ events: [event("apple", "lookup")] }, f.config, deps);
  await invokeReportWordEvents({ events: [event("banana", "lookup")] }, f.config, deps);
  await invokeWordReviewHistory({ spelling: "apple" }, f.config, deps);
  assert.equal(calls, 1);
  now += 15 * 60_000;
  await invokeWordReviewHistory({ spelling: "apple" }, f.config, deps);
  assert.equal(calls, 2);
});

it("tracking: invalid credentials cannot allocate a persistent personal namespace", async () => {
  const path = temporaryDatabase();
  const config = { maimemoApiToken: randomUUID(), authMode: "maimemo-token", cliTimeoutMs: 1000, localReviewDbPath: path } as AppConfig;
  await assert.rejects(invokeReportWordEvents({ events: [event("apple", "incorrect")] }, config,
    { now: () => NOW, fetcher: mockedFetch(() => new Response(null, { status: 401 })) }), code("AUTH_INVALID"));
  assert.equal(existsSync(path), false);
});

it("tracking: concurrent first reports share credential validation and preserve all distinct events", async () => {
  const f = fixture();
  f.config.authMode = "maimemo-token";
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const deps = { ...f.dependencies, fetcher: mockedFetch(async () => { calls++; await gate; return result({ voc: [] }); }) };
  const reports = Array.from({ length: 10 }, () => invokeReportWordEvents({ events: [event("apple", "incorrect")] }, f.config, deps));
  release();
  await Promise.all(reports);
  assert.equal(calls, 1);
  assert.equal(f.store.words(f.namespace)[0]!.counts.incorrect, 10);
});

it("tracking: isolates credentials even when event IDs and words match and does not persist raw tokens", () => {
  const path = temporaryDatabase();
  const store = new ReviewStore(path);
  const first = randomUUID();
  const second = randomUUID();
  const shared = event("apple", "incorrect");
  store.report(store.namespace(first), [shared], NOW);
  store.report(store.namespace(second), [{ ...shared, kind: "lookup" }], NOW);
  assert.equal(store.words(store.namespace(first))[0]!.counts.incorrect, 1);
  assert.equal(store.words(store.namespace(second))[0]!.counts.incorrect, 0);
  store.close();
  assert.ok(!readFileSync(path).includes(Buffer.from(first)));
  assert.ok(!readFileSync(path).includes(Buffer.from(second)));
});

it("long-term: restores records after restart and migrates v1 observations into v2 summaries", () => {
  const path = temporaryDatabase();
  const token = randomUUID();
  let store = new ReviewStore(path);
  const namespace = store.namespace(token);
  store.report(namespace, [event("apple", "incorrect"), event("apple", "mnemonic")], NOW);
  store.observe(namespace, DATE, [item("apple", "FORGET")], NOW);
  const expected = store.words(namespace);
  store.close();
  const old = new DatabaseSync(path);
  old.exec("DROP TABLE review_words; DROP TABLE review_retractions; PRAGMA user_version=1;");
  old.close();
  store = new ReviewStore(path);
  assert.equal(store.namespace(token), namespace);
  assert.deepEqual(store.words(namespace), expected);
  store.close();
});

it("long-term: refuses an unknown database version without clearing existing observations", () => {
  const path = temporaryDatabase();
  const store = new ReviewStore(path);
  store.report(store.namespace("fixture"), [event("apple", "lookup")], NOW);
  store.close();
  const database = new DatabaseSync(path);
  database.exec("PRAGMA user_version=99;");
  database.close();
  assert.throws(() => new ReviewStore(path), code("LOCAL_STORAGE_ERROR"));
  const check = new DatabaseSync(path);
  assert.equal(check.prepare("SELECT COUNT(*) AS n FROM review_events").get()!.n, 1);
  check.close();
});

it("long-term: merges local records and sticky labels without inventing historical mistakes", async () => {
  const f = fixture();
  f.store.report(f.namespace, [event("local", "confusion", "2026-10-12T08:00:00Z")], NOW);
  const data = await invokeLongTermReviewWords({}, f.config, { ...f.dependencies, fetcher: mockedFetch((_url, init) => {
    assert.deepEqual(JSON.parse(init.body as string), { tags: "STICKING", limit: 1000 });
    return result({ records: [{ voc_id: "id-tagged", voc_spelling: "tagged", add_date: "2026-10-01T00:00:00Z", study_count: 100, tags: ["STICKING"] }], count: 0 });
  }) });
  assert.equal(data.scope, "long_term");
  assert.equal(data.items.length, 2);
  const tagged = data.items.find(word => word.spelling === "tagged")!;
  assert.equal(tagged.statistics, null);
  assert.equal(tagged.score, 4);
  assert.match(tagged.reasons[0]!, /不能推算答错次数/);
  assert.equal(data.upstream_requests, 1);
  assert.ok(longTermReviewDataSchema.safeParse(data).success);
});

it("long-term: caps sticky coverage and keeps local results on transient upstream failures", async () => {
  const f = fixture();
  f.store.report(f.namespace, [event("local", "incorrect")], NOW);
  const truncated = await invokeLongTermReviewWords({ limit: 1 }, f.config, { ...f.dependencies, fetcher: mockedFetch(() => result({
    records: Array.from({ length: 1000 }, (_, i) => ({ voc_id: `id-${i}`, voc_spelling: `word${i}`, add_date: "2026-10-01T00:00:00Z", study_count: 1, tags: ["STICKING"] })), count: 0 })) });
  assert.equal(truncated.source_completeness.maimemo_sticking, "unknown");
  const local = await invokeLongTermReviewWords({}, f.config, { ...f.dependencies, fetcher: mockedFetch(() => new Response(null, { status: 503 })) });
  assert.equal(local.source_completeness.maimemo_sticking, "unavailable");
  assert.equal(local.items[0]!.spelling, "local");
});

it("long-term: cross-day recurrence matters more than repeated mistakes on a single day", () => {
  const f = fixture();
  f.store.report(f.namespace, Array.from({ length: 50 }, () => event("single", "incorrect")), NOW);
  f.store.report(f.namespace, ["2026-10-11", "2026-10-12", "2026-10-13"].flatMap(date =>
    [event("repeated", "incorrect", `${date}T07:00:00Z`), event("repeated", "confusion", `${date}T07:01:00Z`)]), NOW);
  const words = f.store.words(f.namespace);
  const single = longTermItem(words.find(word => word.spelling === "single")!, DATE, false);
  const repeated = longTermItem(words.find(word => word.spelling === "repeated")!, DATE, false);
  assert.ok(repeated.score > single.score);
  assert.equal((single.statistics as any).counts.incorrect, 50);
  assert.equal((single.statistics as any).difficult_days, 1);
});

it("long-term: old difficulties decay, recent correct answers lower weight and incidental names remain capped", () => {
  const f = fixture();
  f.store.report(f.namespace, [event("apple", "incorrect")], NOW);
  const word = f.store.words(f.namespace)[0]!;
  const baseline = longTermItem(word, DATE, false).score;
  assert.ok(longTermItem(word, "2027-02-13", false).score < baseline);
  f.store.report(f.namespace, Array.from({ length: 3 }, () => event("apple", "correct", "2026-10-13T09:00:00Z")), NOW);
  assert.ok(longTermItem(f.store.words(f.namespace)[0]!, DATE, false).score < baseline);
  f.store.report(f.namespace, Array.from({ length: 100 }, () => event("Obscure Place", "incorrect", undefined, "incidental")), NOW);
  const name = f.store.words(f.namespace).find(word => word.spelling === "Obscure Place")!;
  assert.ok(longTermItem(name, DATE, true).score <= 2);
  assert.equal(name.counts.incorrect, 100);
});

it("long-term: late feedback is attributed to its day and replayed chronologically", () => {
  const f = fixture();
  const events = [event("apple", "incorrect", "2026-10-12T08:00:00Z"), event("apple", "correct", "2026-10-12T09:00:00Z"), event("apple", "correct", "2026-10-13T08:00:00Z")];
  f.store.report(f.namespace, [events[2]!], NOW);
  f.store.report(f.namespace, events.slice(0, 2), NOW);
  assert.equal(f.store.words(f.namespace)[0]!.correct_streak, 2);
  assert.equal(f.store.daily(f.namespace, "2026-10-12")[0]!.counts.incorrect, 1);
  assert.equal(f.store.daily(f.namespace, DATE)[0]!.counts.incorrect, 0);
  const chronological = new ReviewStore(":memory:");
  chronological.report(f.namespace, events, NOW);
  assert.deepEqual(f.store.words(f.namespace), chronological.words(f.namespace));
  chronological.close();
});

it("long-term: history separates today, the last 30 days and cumulative data with bounded event lists", async () => {
  const f = fixture();
  f.store.report(f.namespace, [event("apple", "incorrect", "2026-08-01T08:00:00Z"), event("apple", "lookup", "2026-10-12T08:00:00Z"),
    event("apple", "correct")], NOW);
  const history = await invokeWordReviewHistory({ spelling: "apple", recent_events_limit: 2 }, f.config, f.dependencies);
  assert.equal(history.today!.counts.incorrect, 0);
  assert.equal(history.last_30_days.counts.incorrect, 0);
  assert.equal(history.last_30_days.counts.lookup, 1);
  assert.equal(history.all_time!.counts.incorrect, 1);
  assert.equal(history.all_time!.ai_error_rate, 0.5);
  assert.equal(history.recent_events.length, 2);
  assert.equal(history.events_truncated, true);
  assert.ok(history.next_cursor);
});

it("retraction: removes old mistakes and recomputes all statistics and recommendations without changing today's weights", async () => {
  const f = fixture();
  const old = event("apple", "incorrect", "2026-10-12T08:00:00Z", "important");
  const today = event("apple", "mnemonic");
  await invokeReportWordEvents({ events: [old, today] }, f.config, f.dependencies);
  const before = await invokeTodayReviewWords({}, f.config, f.dependencies);
  const longBefore = await invokeLongTermReviewWords({}, f.config, f.dependencies);
  const removed = await invokeRetractWordEvents({ event_ids: [old.event_id] }, f.config, f.dependencies);
  assert.equal(removed.scope, "local_reported_events");
  assert.equal(removed.retracted_count, 1);
  assert.deepEqual(removed.study_dates, ["2026-10-12"]);
  assert.deepEqual((await invokeTodayReviewWords({}, f.config, f.dependencies)).items, before.items);
  const history = await invokeWordReviewHistory({ spelling: "apple" }, f.config, f.dependencies);
  assert.equal(history.all_time!.counts.incorrect, 0);
  assert.equal(history.last_30_days.counts.incorrect, 0);
  assert.equal(history.all_time!.importance, "normal");
  assert.equal(history.all_time!.observed_days, 1);
  assert.equal(history.all_time!.difficult_days, 1);
  assert.equal(history.all_time!.first_seen_at, new Date(NOW).toISOString());
  assert.deepEqual(history.recent_events.map(row => row.event_id), [today.event_id]);
  assert.deepEqual(f.store.daily(f.namespace, "2026-10-12"), []);
  assert.ok((await invokeLongTermReviewWords({}, f.config, f.dependencies)).items[0]!.score < longBefore.items[0]!.score);
});

it("retraction: replays correct streaks, error rates and importance in event order", async () => {
  const f = fixture();
  const events = [event("apple", "incorrect", "2026-10-13T07:00:00Z", "important"),
    event("apple", "correct", "2026-10-13T07:01:00Z"), event("apple", "confusion", "2026-10-13T07:02:00Z", "incidental"),
    event("apple", "correct", "2026-10-13T07:03:00Z")];
  f.store.report(f.namespace, events, NOW);
  assert.equal(f.store.words(f.namespace)[0]!.correct_streak, 1);
  await invokeRetractWordEvents({ event_ids: [events[2]!.event_id] }, f.config, f.dependencies);
  let history = await invokeWordReviewHistory({ spelling: "apple" }, f.config, f.dependencies);
  assert.equal(history.today!.correct_streak, 2);
  assert.equal(history.all_time!.correct_streak, 2);
  assert.equal(history.today!.importance, "important");
  assert.equal(history.today!.positive_score, 4);
  assert.equal(history.today!.ai_error_rate, 1 / 3);
  await invokeRetractWordEvents({ event_ids: [events[1]!.event_id] }, f.config, f.dependencies);
  history = await invokeWordReviewHistory({ spelling: "apple" }, f.config, f.dependencies);
  assert.equal(history.all_time!.correct_streak, 1);
  assert.equal(history.all_time!.ai_error_rate, 0.5);
  assert.equal(history.all_time!.counts.confusion, 0);
});

it("retraction: deleting the final event removes stale daily and long-term candidates", async () => {
  const f = fixture();
  const original = event("apple", "incorrect");
  f.store.report(f.namespace, [original], NOW);
  await invokeRetractWordEvents({ event_ids: [original.event_id] }, f.config, f.dependencies);
  assert.deepEqual(f.store.words(f.namespace), []);
  assert.deepEqual(f.store.daily(f.namespace, DATE), []);
  const history = await invokeWordReviewHistory({ spelling: "apple" }, f.config, f.dependencies);
  assert.equal(history.all_time, null);
  assert.equal(history.today, null);
  assert.equal(history.last_30_days.observed_days, 0);
  assert.equal(history.last_30_days.ai_error_rate, null);
  assert.deepEqual(history.recent_events, []);
  assert.equal(history.next_cursor, null);
  assert.deepEqual((await invokeTodayReviewWords({}, f.config, f.dependencies)).items, []);
  assert.deepEqual((await invokeLongTermReviewWords({}, f.config, f.dependencies)).items, []);
});

it("retraction: preserves independent MaiMemo daily observations", async () => {
  const f = fixture();
  const original = event("apple", "incorrect");
  f.store.report(f.namespace, [original], NOW);
  f.store.observe(f.namespace, DATE, [item("apple", "FORGET")], NOW);
  await invokeRetractWordEvents({ event_ids: [original.event_id] }, f.config, f.dependencies);
  const history = await invokeWordReviewHistory({ spelling: "apple" }, f.config, f.dependencies);
  assert.equal(history.all_time!.counts.incorrect, 0);
  assert.equal(history.all_time!.app_forget_days, 1);
  assert.equal(history.today!.positive_score, 6);
  assert.equal(history.today!.ai_error_rate, null);
  assert.deepEqual(history.recent_events, []);
  assert.equal((await invokeTodayReviewWords({}, f.config, f.dependencies)).items[0]!.score, 6);
});

it("retraction: deduplicates IDs, distinguishes repeat requests and missing IDs, and isolates accounts", async () => {
  const f = fixture();
  const original = event("apple", "incorrect");
  const other = f.store.namespace("another-account");
  const foreign = event("private", "lookup");
  f.store.report(f.namespace, [original], NOW);
  f.store.report(other, [original, foreign], NOW);
  const ids = [original.event_id, original.event_id, foreign.event_id, "missing"];
  const first = await invokeRetractWordEvents({ event_ids: ids }, f.config, f.dependencies);
  assert.equal(first.requested_count, 3);
  assert.equal(first.retracted_count, 1);
  assert.equal(first.already_retracted_count, 0);
  assert.equal(first.not_found_count, 2);
  assert.deepEqual(first.not_found_event_ids, [foreign.event_id, "missing"]);
  const second = await invokeRetractWordEvents({ event_ids: ids }, f.config, f.dependencies);
  assert.equal(second.retracted_count, 0);
  assert.equal(second.already_retracted_count, 1);
  assert.deepEqual(second.already_retracted_event_ids, [original.event_id]);
  assert.deepEqual(second.study_dates, []);
  assert.equal(f.store.history(other, "apple", DATE, 20).all_time!.counts.incorrect, 1);
  assert.equal(f.store.history(other, "private", DATE, 20).all_time!.counts.lookup, 1);
  f.store.report(f.namespace, [foreign], NOW);
  assert.equal(f.store.history(f.namespace, "private", DATE, 20).all_time!.counts.lookup, 1);
});

it("retraction: old report retries cannot restore records, and corrected feedback requires a fresh ID", async () => {
  const f = fixture();
  const original = event("apple", "incorrect");
  f.store.report(f.namespace, [original], NOW);
  await invokeRetractWordEvents({ event_ids: [original.event_id] }, f.config, f.dependencies);
  const correct = event("apple", "correct");
  const retried = await invokeReportWordEvents({ events: [original, correct] }, f.config, { ...f.dependencies, now: () => NOW + 1000 });
  assert.equal(retried.accepted_count, 1);
  assert.equal(retried.duplicate_count, 0);
  assert.equal(retried.retracted_count, 1);
  assert.deepEqual(retried.retracted_event_ids, [original.event_id]);
  assert.equal(f.store.words(f.namespace)[0]!.counts.incorrect, 0);
  assert.equal(f.store.words(f.namespace)[0]!.counts.correct, 1);
  await assert.rejects(invokeReportWordEvents({ events: [event("banana", "lookup"), { ...original, kind: "correct" }] },
    f.config, f.dependencies), code("INVALID_ARGUMENT"));
  assert.equal(f.store.words(f.namespace).length, 1);
});

it("retraction: validates batches before authentication and rejects invalid credentials before storage access", async () => {
  const f = fixture();
  let calls = 0;
  const deps = { ...f.dependencies, fetcher: mockedFetch(() => { calls++; return result({ voc: [] }); }) };
  for (const args of [{ event_ids: [] }, { event_ids: [" "] }, { event_ids: Array(101).fill("x") },
    { event_ids: ["x"], all: true }]) await assert.rejects(invokeRetractWordEvents(args, f.config, deps));
  assert.equal(calls, 0);
  const path = temporaryDatabase();
  const config = { ...f.config, authMode: "maimemo-token" as const, localReviewDbPath: path };
  await assert.rejects(invokeRetractWordEvents({ event_ids: ["x"] }, config,
    { now: () => NOW, fetcher: mockedFetch(() => new Response(null, { status: 401 })) }), code("AUTH_INVALID"));
  assert.equal(existsSync(path), false);
});

it("retraction: rolls back event removal, deduplication markers and summaries if any deletion fails", () => {
  const path = temporaryDatabase();
  const store = new ReviewStore(path);
  cleanup.push(() => store.close());
  const namespace = store.namespace("fixture");
  const events = [event("apple", "incorrect"), { ...event("banana", "correct"), event_id: "fail-delete" }];
  store.report(namespace, events, NOW);
  const expected = store.words(namespace);
  const database = new DatabaseSync(path);
  cleanup.push(() => database.close());
  database.exec("CREATE TRIGGER refuse_delete BEFORE DELETE ON review_events WHEN OLD.event_id='fail-delete' BEGIN SELECT RAISE(ABORT, 'test failure'); END;");
  assert.throws(() => store.retract(namespace, events.map(row => row.event_id), NOW), code("LOCAL_STORAGE_ERROR"));
  assert.deepEqual(store.words(namespace), expected);
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM review_retractions").get()!.n, 0);
  assert.equal(store.report(namespace, events, NOW).duplicate_count, 2);
});

it("retraction: migrates v2 without changing summaries and preserves withdrawals after restart", () => {
  const path = temporaryDatabase();
  const token = randomUUID();
  const original = event("apple", "incorrect", "2026-08-01T08:00:00Z");
  let store = new ReviewStore(path);
  const namespace = store.namespace(token);
  store.report(namespace, [original], NOW);
  const expected = store.words(namespace);
  store.close();
  const old = new DatabaseSync(path);
  old.exec("DROP TABLE review_retractions; PRAGMA user_version=2;");
  old.close();
  store = new ReviewStore(path);
  assert.equal(store.namespace(token), namespace);
  assert.deepEqual(store.words(namespace), expected);
  assert.equal(store.retract(namespace, [original.event_id], NOW).retracted_count, 1);
  store.close();
  store = new ReviewStore(path);
  assert.equal(store.retract(namespace, [original.event_id], NOW).already_retracted_count, 1);
  assert.equal(store.report(namespace, [original], NOW + 1000).retracted_count, 1);
  assert.deepEqual(store.words(namespace), []);
  store.close();
  const check = new DatabaseSync(path);
  assert.equal(check.prepare("PRAGMA user_version").get()!.user_version, 3);
  assert.equal(check.prepare("SELECT COUNT(*) AS n FROM review_events").get()!.n, 0);
  assert.deepEqual(check.prepare("PRAGMA table_info(review_retractions)").all().map(row => row.name),
    ["namespace", "event_id", "fingerprint", "retracted_at"]);
  check.close();
});

it("history: pages beyond 100 old events without repeating or skipping identical timestamps", async () => {
  const f = fixture();
  const events = Array.from({ length: 215 }, (_, i) => ({ ...event("apple", "lookup",
    i < 115 ? "2026-08-01T08:00:00Z" : "2026-10-12T08:00:00Z"), event_id: `event-${String(i).padStart(3, "0")}` }));
  f.store.report(f.namespace, events, NOW);
  const seen: string[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const page = await invokeWordReviewHistory({ spelling: " APPLE ", recent_events_limit: 100, cursor }, f.config, f.dependencies);
    seen.push(...page.recent_events.map(row => row.event_id as string));
    assert.equal(page.all_time!.counts.lookup, 215);
    assert.equal(page.last_30_days.counts.lookup, 100);
    assert.equal(page.events_truncated, page.next_cursor !== null);
    cursor = page.next_cursor ?? undefined;
    pages++;
  } while (cursor);
  assert.equal(pages, 3);
  assert.equal(seen.length, events.length);
  assert.equal(new Set(seen).size, events.length);
  assert.deepEqual(seen, events.map(row => row.event_id).reverse());
  await invokeRetractWordEvents({ event_ids: [seen.at(-1)!] }, f.config, f.dependencies);
  assert.equal(f.store.words(f.namespace)[0]!.counts.lookup, 214);
});

it("history: rejects malformed, modified, cross-account and cross-word cursors", async () => {
  const f = fixture();
  f.store.report(f.namespace, [event("apple", "lookup"), event("apple", "lookup")], NOW);
  const page = await invokeWordReviewHistory({ spelling: "apple", recent_events_limit: 1 }, f.config, f.dependencies);
  const cursor = page.next_cursor!;
  for (const bad of ["invalid", `${cursor}.extra`, cursor.replace(/^./, cursor[0] === "a" ? "b" : "a")]) {
    await assert.rejects(invokeWordReviewHistory({ spelling: "apple", cursor: bad }, f.config, f.dependencies), code("INVALID_ARGUMENT"));
  }
  await assert.rejects(invokeWordReviewHistory({ spelling: "banana", cursor }, f.config, f.dependencies), code("INVALID_ARGUMENT"));
  await assert.rejects(invokeWordReviewHistory({ spelling: "apple", cursor },
    { ...f.config, maimemoApiToken: randomUUID() }, f.dependencies), code("INVALID_ARGUMENT"));
});

it("history: cursors survive restart and anchor retraction while ignoring newly inserted newer events", () => {
  const path = temporaryDatabase();
  let store = new ReviewStore(path);
  const namespace = store.namespace("fixture");
  const events = ["a", "b", "c"].map(event_id => ({ ...event("apple", "lookup"), event_id }));
  store.report(namespace, events, NOW);
  const first = store.history(namespace, "apple", DATE, 1);
  assert.equal(first.recent_events[0]!.event_id, "c");
  store.retract(namespace, ["c"], NOW);
  store.report(namespace, [event("apple", "incorrect", "2026-10-13T08:01:00Z")], NOW + 60_000);
  store.close();
  store = new ReviewStore(path);
  const next = store.history(namespace, "apple", DATE, 2, first.next_cursor!);
  assert.deepEqual(next.recent_events.map(row => row.event_id), ["b", "a"]);
  assert.equal(next.all_time!.counts.lookup, 2);
  assert.equal(next.all_time!.counts.incorrect, 1);
  assert.equal(next.next_cursor, null);
  store.close();
});

it("sampling: strongly favors difficult words but preserves exploration and never repeats within a batch", () => {
  const candidates = [1, 9].map(score => ({ spelling: `word${score}`, voc_id: null, score, sources: [], reasons: [], statistics: null }));
  let state = 12345;
  const random = () => { state = (Math.imul(1664525, state) + 1013904223) >>> 0; return state / 2 ** 32; };
  let favored = 0;
  for (let i = 0; i < 10_000; i++) if (sampleReviewWords(candidates, 1, random)[0]!.score === 9) favored++;
  assert.ok(favored > 7900 && favored < 8500, `${favored} favored draws`);
  const batch = sampleReviewWords(candidates, 20, random);
  assert.equal(batch.length, 2);
  assert.equal(new Set(batch.map(word => word.spelling)).size, 2);
  assert.equal(sampleReviewWords(candidates.map(word => ({ ...word, score: 0 })), 20, random).length, 2);
});

it("MCP: discovers five scoped tools, guides reporting and retraction, and validates all five outputs", async t => {
  const f = fixture();
  const path = temporaryDatabase();
  f.config.localReviewDbPath = path;
  t.mock.method(globalThis, "fetch", async (url: URL) => {
    if (url.pathname.endsWith("get_study_progress")) return result({ progress: { total: 5, finished: 2, study_time: 0 } });
    if (url.pathname.endsWith("get_today_items")) return result({ today_items: [item("apple", "FORGET")] });
    if (url.pathname.endsWith("query_study_records")) return result({ records: [], count: 0 });
    throw new Error("Unexpected request");
  });
  const server = createMcpServer(f.config);
  const client = new Client({ name: "review-test", version: "1.0.0" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await server.connect(right); await client.connect(left);
  try {
    const tools = (await client.listTools()).tools;
    assert.equal(tools.length, 47);
    for (const name of reviewToolNames) assert.ok(tools.find(tool => tool.name === name)?.outputSchema);
    assert.match(client.getInstructions()!, /默认入口/);
    assert.match(client.getInstructions()!, /本轮及时/);
    assert.match(client.getInstructions()!, /历史错频不参与/);
    assert.match(client.getInstructions()!, /maimemo_retract_word_events/);
    const retractTool = tools.find(tool => tool.name === "maimemo_retract_word_events")!;
    assert.equal(retractTool.annotations!.readOnlyHint, false);
    assert.equal(retractTool.annotations!.destructiveHint, true);
    assert.equal(retractTool.annotations!.idempotentHint, true);
    const prompt = await client.getPrompt({ name: "maimemo_workflow", arguments: { task: "复习今日易错词" } });
    assert.match((prompt.messages[0]!.content as { text: string }).text, /without per-event confirmation/);
    const original = event("apple", "mnemonic");
    const report = await client.callTool({ name: "maimemo_report_word_events", arguments: { events: [original] } });
    assert.equal(report.isError, undefined);
    assert.equal((report.structuredContent as any).data.accepted_count, 1);
    for (const name of ["maimemo_get_today_review_words", "maimemo_get_long_term_review_words", "maimemo_get_word_review_history"]) {
      const response = await client.callTool({ name, arguments: name.endsWith("history") ? { spelling: "apple" } : {} });
      assert.equal(response.isError, undefined, JSON.stringify(response.structuredContent));
      assert.equal((response.structuredContent as any).ok, true);
      if (name.includes("today")) assert.equal((response.structuredContent as any).data.scope, "today");
      if (name.includes("long_term")) assert.equal((response.structuredContent as any).data.scope, "long_term");
    }
    const removed = await client.callTool({ name: "maimemo_retract_word_events", arguments: { event_ids: [original.event_id] } });
    assert.equal(removed.isError, undefined, JSON.stringify(removed.structuredContent));
    assert.equal((removed.structuredContent as any).data.retracted_count, 1);
    const history = await client.callTool({ name: "maimemo_get_word_review_history", arguments: { spelling: "apple" } });
    assert.equal((history.structuredContent as any).data.all_time.counts.mnemonic, 0);
    assert.equal((history.structuredContent as any).data.all_time.app_forget_days, 1);
    const replay = await client.callTool({ name: "maimemo_report_word_events", arguments: { events: [original] } });
    assert.equal((replay.structuredContent as any).data.accepted_count, 0);
    assert.equal((replay.structuredContent as any).data.retracted_count, 1);
    const failed = await client.callTool({ name: "maimemo_report_word_events", arguments: { events: [{ ...event("apple", "correct"), occurred_at: "2099-01-01T00:00:00Z" }] } });
    assert.equal(failed.isError, true);
    assert.equal((failed.structuredContent as any).error_details.code, "INVALID_ARGUMENT");
  } finally { await client.close(); await server.close(); }
});
