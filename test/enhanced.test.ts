import assert from "node:assert/strict";
import { it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AppConfig } from "../src/config.js";
import { buildCliArgs } from "../src/cli.js";
import { createMcpServer } from "../src/mcp.js";
import { invokeOfficial, operations } from "../src/official.js";
import { invokeStudyQueue, invokeVocabularyDetails, queueDataSchema, detailsDataSchema } from "../src/enhanced.js";
import { ApiError, describeError } from "../src/errors.js";

const config = { maimemoApiToken: "test-only-token", allowMutations: true, cliTimeoutMs: 1000 } as AppConfig;
const operation = (action: string) => operations.find(op => op.action === action)!;
const fetcher = (handler: (url: URL, init: RequestInit) => Promise<Response> | Response) => handler as typeof fetch;
const response = (data: unknown) => Response.json({ success: true, data });
const queueItem = (index: number) => ({ voc_id: `fixture-${index}`, voc_spelling: `word${index}`, order: index + 1,
  is_new: false, is_finished: false });

for (const count of [0, 50, 233, 999, 1000]) it(`describes a ${count}-item queue without fabricating a total or cursor`, async () => {
  let calls = 0;
  const all = Array.from({ length: count }, (_, i) => queueItem(i));
  const data = await invokeStudyQueue({ body: { is_finished: false, limit: 50 } }, config, fetcher((url, init) => {
    calls++;
    assert.equal(url.pathname, "/open/api/v1/study/get_today_items");
    assert.deepEqual(JSON.parse(init.body as string), { is_finished: false, limit: 1000 });
    return response({ today_items: all });
  }));
  assert.equal(calls, 1);
  assert.equal(data.returned_count, Math.min(50, count));
  assert.equal(data.total_count, count < 1000 ? count : null);
  assert.equal(data.has_more, count > 50);
  assert.equal(data.completeness, count < 1000 ? "complete" : "unknown");
  assert.equal(data.count_scope, "matching_query");
  assert.equal(data.pagination_supported, false);
  assert.ok(queueDataSchema.safeParse(data).success);
});

it("defaults the enhanced queue to 1000 and preserves upstream order and first response", async () => {
  const all = [{ ...queueItem(8), first_response: "FORGET" }, queueItem(0),
    { ...queueItem(4), first_response: "STUDY_RESPONSE_UNSPECIFIED" }];
  const data = await invokeStudyQueue({}, config, fetcher(() => response({ today_items: all })));
  assert.equal(data.limit, 1000);
  assert.deepEqual(data.items.map(item => item.order), [9, 1, 5]);
  assert.deepEqual(data.items.map(item => item.first_response_today), ["FORGET", null, "STUDY_RESPONSE_UNSPECIFIED"]);
  assert.deepEqual(data.items.map(({ first_response_today, ...original }) => original), all);
  const full = await invokeStudyQueue({}, config, fetcher(() => response({ today_items: Array.from({ length: 1000 }, (_, i) => queueItem(i)) })));
  assert.equal(full.total_count, null);
  assert.equal(full.has_more, null);
  assert.ok(full.warnings.length > 0);
});

it("rejects ignored study/vocabulary filter combinations before any upstream request", async () => {
  const cases: [string, object][] = [
    ["GetTodayItems", { voc_ids: ["id"], is_finished: false }],
    ["GetTodayItems", { spellings: ["word"], is_new: false }],
    ["GetTodayItems", { voc_ids: ["id"], spellings: ["word"] }],
    ["QueryStudyRecords", { voc_ids: ["id"], next_study_date: { end: "2026-10-05T00:00:00+08:00" } }],
    ["QueryStudyRecords", { spellings: ["word"], tags: "STICKING" }],
    ["QueryStudyRecords", { voc_ids: ["id"], spellings: ["word"] }],
    ["ListVocabulary", { ids: ["id"], spellings: ["word"] }]
  ];
  for (const [action, body] of cases) {
    await assert.rejects(invokeOfficial(operation(action), { body }, config, fetcher(() => {
      assert.fail("Invalid combinations must not reach upstream");
    })), error => describeError(error).code === "INVALID_ARGUMENT_COMBINATION");
  }
  const data = await invokeOfficial(operation("QueryStudyRecords"), { body: { voc_ids: ["id"], as_count: true, limit: 1000 } }, config,
    fetcher(() => response({ records: [], count: 1 })));
  assert.deepEqual(data, { records: [], count: 1 });
});

it("guards legacy CLI filters without confusing spelling with date aliases", () => {
  for (const call of [
    { resource: "study", action: "today", options: { vocId: ["id"], finished: false } },
    { resource: "study", action: "records", options: { "voc-id": ["id"], "next-study-end": "2026-10-05" } },
    { resource: "study", action: "today", input: { voc_ids: ["id"], is_new: false } }
  ]) assert.throws(() => buildCliArgs(call), error => describeError(error).code === "INVALID_ARGUMENT_COMBINATION");
  assert.doesNotThrow(() => buildCliArgs({ resource: "study", action: "records", options: { s: ["word"] } }));
  assert.doesNotThrow(() => buildCliArgs({ resource: "study", action: "today", options: { finished: false }, input: { voc_ids: ["id"] } }));
});

for (const [status, code, retryable] of [[401, "AUTH_INVALID", false], [403, "PERMISSION_DENIED", false],
  [429, "RATE_LIMITED", true], [503, "SERVICE_UNAVAILABLE", true], [422, "INVALID_ARGUMENT", false]] as const) {
  it(`classifies HTTP ${status} without changing the legacy error message`, async () => {
    try {
      await invokeOfficial(operation("GetStudyProgress"), {}, config,
        fetcher(() => new Response(null, { status, headers: { "retry-after": "3" } })));
      assert.fail("Expected HTTP error");
    } catch (error) {
      const details = describeError(error);
      assert.equal(details.code, code);
      assert.equal(details.http_status, status);
      assert.equal(details.retryable, retryable);
      assert.equal(details.retry_after_seconds, 3);
      assert.match(details.message, new RegExp(`Official API HTTP ${status}`));
    }
  });
}

it("distinguishes transport, validation, rejection and schema errors", async () => {
  const failures = [
    { fetch: fetcher(() => { throw new TypeError("fetch failed"); }), code: "NETWORK_ERROR" },
    { fetch: fetcher(() => { throw new DOMException("Timeout", "TimeoutError"); }), code: "TIMEOUT" },
    { fetch: fetcher(() => new Response("invalid JSON")), code: "UPSTREAM_SCHEMA_MISMATCH" },
    { fetch: fetcher(() => response({ progress: { total: "50" } })), code: "UPSTREAM_SCHEMA_MISMATCH" },
    { fetch: fetcher(() => Response.json({ success: false, errors: ["opaque reason"] })), code: "UPSTREAM_REJECTED" }
  ];
  for (const failure of failures) await assert.rejects(invokeOfficial(operation("GetStudyProgress"), {}, config, failure.fetch),
    error => describeError(error).code === failure.code);
  await assert.rejects(invokeOfficial(operation("GetStudyProgress"), {}, { ...config, maimemoApiToken: undefined }),
    error => describeError(error).code === "AUTH_REQUIRED");
  await assert.rejects(invokeStudyQueue({ body: { limit: 0 } }, config), error => describeError(error).code === "INVALID_ARGUMENT");
  assert.equal(describeError(new TypeError("programming error")).code, "INTERNAL_ERROR");
  const secret = describeError(new ApiError("test-only-token leaked", "UPSTREAM_ERROR", 500, true), config.maimemoApiToken, true);
  assert.equal(secret.message, "[REDACTED] leaked");
  assert.equal(secret.retryable, false);
  assert.equal(secret.mutation_may_have_succeeded, true);
});

it("aggregates existing APIs, deduplicates IDs and matches results by ID", async () => {
  const requests: { path: string; body: any; id: string | null }[] = [];
  const data = await invokeVocabularyDetails({ voc_ids: ["one", "two", "one"] }, config, fetcher((url, init) => {
    assert.equal((init.headers as any).Authorization, "Bearer test-only-token");
    const body = init.body ? JSON.parse(init.body as string) : undefined;
    const id = url.searchParams.get("voc_id");
    requests.push({ path: url.pathname, body, id });
    if (url.pathname.endsWith("vocabulary/query")) return response({ voc: [{ id: "two", spelling: "banana" }, { id: "one", spelling: "apple" }] });
    if (url.pathname.endsWith("query_study_records")) return response({ records: [{ voc_id: "one", voc_spelling: "apple", add_date: "2026-10-01T00:00:00Z", study_count: 3, tags: ["STUDY_RECORD_TAG_UNSPECIFIED"] }], count: 0 });
    return response({ [url.pathname.split("/").at(-1)!]: [] });
  }), 0);
  assert.equal(data.requested_count, 3);
  assert.equal(data.unique_count, 2);
  assert.equal(data.upstream_requests, 8);
  assert.equal(data.partial, false);
  assert.deepEqual(data.items.map(item => [item.voc_id, item.spelling]), [["one", "apple"], ["two", "banana"]]);
  assert.ok(data.items[0]!.study_record);
  assert.equal(data.items[1]!.study_record, null);
  assert.deepEqual(requests.find(request => request.path.endsWith("vocabulary/query"))!.body, { ids: ["one", "two"] });
  assert.deepEqual(requests.find(request => request.path.endsWith("query_study_records"))!.body, { voc_ids: ["one", "two"], limit: 1000 });
  assert.equal(requests.filter(request => request.path.endsWith("notes")).length, 2);
  assert.ok(detailsDataSchema.safeParse(data).success);
});

it("supports component selection and limits in-flight batch requests to three", async () => {
  let active = 0, maximum = 0;
  const data = await invokeVocabularyDetails({ voc_ids: ["one", "two", "three"], include: ["notes", "phrases"] }, config,
    fetcher(async url => {
      active++; maximum = Math.max(maximum, active);
      await new Promise(resolve => setTimeout(resolve, 5));
      active--;
      return url.pathname.endsWith("vocabulary/query")
        ? response({ voc: ["one", "two", "three"].map(id => ({ id, spelling: id })) })
        : response({ [url.pathname.split("/").at(-1)!]: [] });
    }), 0);
  assert.ok(maximum <= 3);
  assert.equal(data.upstream_requests, 7);
  assert.equal(data.items[0]!.interpretations, null);
  assert.equal(data.items[0]!.study_record, null);
  assert.deepEqual(data.items[0]!.notes, []);
  assert.deepEqual(data.include, ["notes", "phrases"]);
});

it("preserves actual self-created content fields in the aggregate", async () => {
  const common = { id: "content-id", status: "PUBLISHED", created_time: "2026-10-01T00:00:00Z", updated_time: "2026-10-01T00:00:00Z" };
  const content = {
    interpretations: [{ ...common, interpretation: "n. precision", tags: [] }],
    notes: [{ ...common, note_type: "词根", note: "User-created mnemonic" }],
    phrases: [{ ...common, phrase: "Precision matters.", interpretation: "精度很重要。", tags: [], highlight: [], origin: "自编" }]
  };
  const data = await invokeVocabularyDetails({ voc_ids: ["one"], include: ["interpretations", "notes", "phrases"] }, config,
    fetcher(url => url.pathname.endsWith("vocabulary/query") ? response({ voc: [{ id: "one", spelling: "precision" }] })
      : response({ [url.pathname.split("/").at(-1)!]: content[url.pathname.split("/").at(-1)! as keyof typeof content] })), 0);
  assert.equal(data.partial, false);
  for (const part of ["interpretations", "notes", "phrases"] as const) assert.deepEqual(data.items[0]![part], content[part]);
  assert.ok(detailsDataSchema.safeParse(data).success);
});

it("returns partial results and stops new calls when the batch time budget expires", async (t) => {
  let now = 0;
  t.mock.method(Date, "now", () => now);
  const data = await invokeVocabularyDetails({ voc_ids: ["one"], include: ["notes", "phrases"] }, config, fetcher(() => {
    now = 50_001;
    return response({ voc: [{ id: "one", spelling: "apple" }] });
  }), 0);
  assert.equal(data.upstream_requests, 1);
  assert.equal(data.partial, true);
  assert.equal(data.items[0]!.spelling, "apple");
  assert.equal(data.items[0]!.errors.length, 2);
  assert.ok(data.items[0]!.errors.every(error => error.code === "TIMEOUT"));
});

it("keeps successful batch components when another component fails", async () => {
  const data = await invokeVocabularyDetails({ voc_ids: ["one"], include: ["notes", "phrases"] }, config,
    fetcher(url => url.pathname.endsWith("vocabulary/query") ? response({ voc: [{ id: "one", spelling: "apple" }] })
      : url.pathname.endsWith("notes") ? new Response(null, { status: 404 }) : response({ phrases: [] })), 0);
  assert.equal(data.partial, true);
  assert.equal(data.items[0]!.spelling, "apple");
  assert.equal(data.items[0]!.notes, null);
  assert.deepEqual(data.items[0]!.phrases, []);
  assert.equal(data.items[0]!.errors[0]!.component, "notes");
  assert.equal(data.items[0]!.errors[0]!.code, "NOT_FOUND");
  assert.ok(detailsDataSchema.safeParse(data).success);
});

it("stops pending batch requests on authentication failure or rate limiting", async () => {
  let calls = 0;
  await assert.rejects(invokeVocabularyDetails({ voc_ids: ["one", "two"] }, config, fetcher(() => {
    calls++; return new Response(null, { status: 401 });
  }), 0), error => describeError(error).code === "AUTH_INVALID");
  assert.ok(calls <= 2);
  calls = 0;
  const data = await invokeVocabularyDetails({ voc_ids: ["one", "two"], include: ["notes", "phrases"] }, config, fetcher(url => {
    calls++;
    return url.pathname.endsWith("vocabulary/query") ? response({ voc: ["one", "two"].map(id => ({ id, spelling: id })) })
      : new Response(null, { status: 429, headers: { "retry-after": "5" } });
  }), 0);
  assert.ok(calls <= 4);
  assert.equal(data.partial, true);
  assert.ok(data.items.every(item => item.errors.every(error => error.code === "RATE_LIMITED")));
  assert.ok(data.items[0]!.errors.some(error => error.retry_after_seconds === 5));
});

it("rejects empty or oversized batches before querying the API", async () => {
  for (const voc_ids of [[], [" "], Array.from({ length: 11 }, (_, i) => String(i))]) {
    await assert.rejects(invokeVocabularyDetails({ voc_ids }, config, fetcher(() => {
      assert.fail("Invalid batch must not query upstream");
    }), 0), error => describeError(error).code === "INVALID_ARGUMENT");
  }
});

it("exposes enhanced tools and structured validation errors through MCP", async (t) => {
  t.mock.method(globalThis, "fetch", () => { assert.fail("Conflicting filters must not query upstream"); });
  const server = createMcpServer(config);
  const client = new Client({ name: "enhanced-tools-test", version: "1.0.0" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await server.connect(right);
  await client.connect(left);
  try {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 47);
    assert.ok(tools.find(tool => tool.name === "maimemo_get_vocabulary_details"));
    const result = await client.callTool({ name: "maimemo_get_study_queue", arguments: { body: { voc_ids: ["id"], is_finished: false } } });
    const content = result.structuredContent as any;
    assert.equal(result.isError, true);
    assert.equal(content.error_details.code, "INVALID_ARGUMENT_COMBINATION");
    assert.equal(typeof content.error, "string");
    assert.equal(content.data, null);
    assert.match(client.getInstructions()!, /自建内容/);
    assert.match(client.getInstructions()!, /跨查询全局稳定性/);
    assert.match(client.getInstructions()!, /当天第一次学习反馈/);
  } finally {
    await client.close(); await server.close();
  }
});

it("returns successful enhanced results through MCP output validation", async (t) => {
  t.mock.method(globalThis, "fetch", async (url: URL) => url.pathname.endsWith("get_today_items")
    ? response({ today_items: [{ ...queueItem(0), first_response: "VAGUE" }] })
    : response({ voc: [{ id: "one", spelling: "precision" }] }));
  const server = createMcpServer(config);
  const client = new Client({ name: "enhanced-output-test", version: "1.0.0" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await server.connect(right); await client.connect(left);
  try {
    const queue = await client.callTool({ name: "maimemo_get_study_queue", arguments: { body: { is_finished: false } } });
    assert.equal(queue.isError, undefined);
    assert.equal((queue.structuredContent as any).data.items[0].first_response_today, "VAGUE");
    assert.equal((queue.structuredContent as any).data.total_count, 1);
    const details = await client.callTool({ name: "maimemo_get_vocabulary_details", arguments: { voc_ids: ["one"], include: [] } });
    assert.equal(details.isError, undefined);
    const data = (details.structuredContent as any).data;
    assert.equal(data.items[0].spelling, "precision");
    assert.equal(data.upstream_requests, 1);
    assert.deepEqual(data.items[0].errors, []);
    assert.equal(data.partial, false);
    const docs = await client.readResource({ uri: "maimemo://docs/study" });
    assert.match((docs.contents[0] as { text: string }).text, /maimemo_get_vocabulary_details/);
    assert.match((docs.contents[0] as { text: string }).text, /retry_after_seconds/);
  } finally { await client.close(); await server.close(); }
});
