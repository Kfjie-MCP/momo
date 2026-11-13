import assert from "node:assert/strict";
import { it } from "node:test";
import { z } from "zod";
import { operations, invokeOfficial } from "../src/official.js";
import type { AppConfig } from "../src/config.js";

const config = { maimemoApiToken: "test-only-token", allowMutations: true, cliTimeoutMs: 1000 } as AppConfig;
function sample(s: any): any {
  if (s.const !== undefined) return s.const;
  if (s.enum) return s.enum[0];
  if (s.anyOf) return sample(s.anyOf[0]);
  if (s.type === "object") return Object.fromEntries((s.required ?? []).map((k: string) => [k, sample(s.properties[k])]));
  if (s.type === "array") return Array.from({ length: s.minItems ?? 0 }, () => sample(s.items));
  if (s.type === "integer" || s.type === "number") return s.minimum ?? 1;
  if (s.type === "boolean") return true;
  if (s.type === "null") return null;
  if (s.format === "date-time") return "2026-09-22T00:00:00Z";
  if (s.format === "date") return "2026-09-22";
  return "sample";
}
it("covers every published operation with unique names", () => {
  assert.equal(operations.length, 34);
  assert.equal(new Set(operations.map(o => o.name)).size, 34);
  assert.equal(operations.filter(o => o.name.startsWith("markji_")).length, 10);
});
for (const op of operations) it(`maps ${op.name} to its official HTTP contract`, async () => {
  const args = sample(z.toJSONSchema(op.input));
  if (op.action === "UploadFile") args.body.file = { filename: "test.txt", content_base64: "aGk=" };
  const response = sample(z.toJSONSchema(op.data));
  let called = false;
  await invokeOfficial(op, args, config, (async (url: URL, init: RequestInit) => {
    called = true;
    assert.equal(url.origin, "https://open.maimemo.com");
    assert.equal(url.pathname, `/open${op.path.replace(/\{([^}]+)\}/g, (_, k) => encodeURIComponent(args.path?.[k] ?? args.body?.[k]))}`);
    assert.equal(init.method, op.method);
    assert.equal(init.redirect, "error");
    assert.equal((init.headers as any).Authorization, "Bearer test-only-token");
    if (op.action === "UploadFile") {
      assert.ok(init.body instanceof FormData);
      assert.equal(await (init.body.get("file") as Blob).text(), "hi");
    } else if (args.body) assert.deepEqual(JSON.parse(init.body as string), args.body);
    return Response.json({ success: true, data: response });
  }) as typeof fetch);
  assert.ok(called);
  if (op.write) {
    await assert.rejects(invokeOfficial(op, { ...args, confirm: false }, config));
    await assert.rejects(invokeOfficial(op, args, { ...config, allowMutations: false }), /disabled/);
  }
});
it("does not retry unauthorized or rate-limited requests", async () => {
  const op = operations.find(o => o.action === "ListFolders")!;
  for (const status of [401, 429, 500]) {
    let count = 0;
    await assert.rejects(invokeOfficial(op, {}, config, (async () => { count++; return new Response(null, { status }); }) as typeof fetch), new RegExp(String(status)));
    assert.equal(count, 1);
  }
});
it("marks POST query operations read-only", () => {
  for (const action of ["QueryFiles", "GetStudyProgress", "GetTodayItems", "QueryStudyRecords", "ListVocabulary"]) assert.equal(operations.find(o => o.action === action)!.write, false);
});

it("preserves uncompleted items with the observed unspecified response", async () => {
  const op = operations.find(o => o.action === "GetTodayItems")!;
  const data = { today_items: [{ voc_id: "fixture-id", voc_spelling: "atmospheric", order: 1,
    first_response: "STUDY_RESPONSE_UNSPECIFIED", is_new: false, is_finished: false }] };
  const result = await invokeOfficial(op, { body: { is_finished: false, limit: 5 } }, config,
    (async () => Response.json({ success: true, errors: [], data })) as typeof fetch);
  assert.deepEqual(result, data);
  assert.ok(op.data.safeParse(data).success);
});

it("accepts actual study tag arrays and still rejects malformed records", async () => {
  const op = operations.find(o => o.action === "QueryStudyRecords")!;
  for (const tags of [[], ["WELL_FAMILIAR"], ["STICKING", "WELL_FAMILIAR"]]) {
    const record = { voc_id: "fixture-id", voc_spelling: "think", add_date: "2026-09-22T00:00:00Z",
      last_response: "STUDY_RESPONSE_UNSPECIFIED", study_count: 1, tags };
    const data = { records: [record], count: 0 };
    assert.deepEqual(await invokeOfficial(op, { body: { limit: 1 } }, config,
      (async () => Response.json({ success: true, errors: [], data })) as typeof fetch), data);
    assert.equal(op.data.safeParse({ records: [{ ...record, tags: 42 }], count: 0 }).success, false);
  }
});

it("requires concrete word IDs for add_words before any request", async () => {
  const op = operations.find(o => o.action === "AddWords")!;
  for (const words of [[], ["word"], [{}], [{ id: 4 }], [{ id: "" }]]) {
    await assert.rejects(invokeOfficial(op, { body: { words, advance: false }, confirm: true }, config,
      (async () => { assert.fail("Invalid mutation must not reach network"); }) as typeof fetch));
  }
  assert.ok(op.input.safeParse({ body: { words: [{ id: "fixture-id" }], advance: false }, confirm: true }).success);
});

it("uses the verified CLI study route convention for all five operations", () => {
  const study = operations.filter(o => o.path.includes("/study/"));
  assert.equal(study.length, 5);
  for (const op of study) assert.match(op.path, /^\/api\/v1\/study\//);
});
