import assert from "node:assert/strict";
import { it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { parse } from "yaml";
import type { AppConfig } from "../src/config.js";
import { createMcpServer } from "../src/mcp.js";
import { specification } from "../src/official.js";

const config = { maimemoApiToken: "test-only-token", allowMutations: false, cliTimeoutMs: 1000 } as AppConfig;

async function connect() {
  const server = createMcpServer(config);
  const client = new Client({ name: "study-semantics-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { server, client };
}

it("exposes distinct study modules and compatible queue schemas to MCP clients", async () => {
  const { server, client } = await connect();
  try {
    const instructions = client.getInstructions()!;
    assert.match(instructions, /progress\.total/);
    assert.match(instructions, /233\/235/);
    assert.match(instructions, /不返回具体单词列表/);
    assert.match(instructions, /建议的今日学习批次/);
    assert.match(instructions, /剩余数为 0/);
    assert.match(instructions, /读取失败/);

    const { tools } = await client.listTools();
    const progress = tools.find(tool => tool.name === "maimemo_get_study_progress")!;
    const queue = tools.find(tool => tool.name === "maimemo_get_study_queue_items")!;
    const legacy = tools.find(tool => tool.name === "maimemo_get_today_items")!;
    const records = tools.find(tool => tool.name === "maimemo_query_study_records")!;
    assert.equal(progress.title, "今日学习目标与完成进度");
    assert.equal(queue.title, "当前学习／复习队列");
    assert.equal(records.title, "学习计划、记录与复习排期");
    assert.match(legacy.description!, /历史兼容别名/);
    assert.deepEqual(legacy.inputSchema, queue.inputSchema);
    assert.deepEqual(legacy.outputSchema, queue.outputSchema);
    for (const tool of [progress, queue, legacy, records]) assert.equal(tool.annotations?.readOnlyHint, true);
    const body = queue.inputSchema.properties!.body as any;
    assert.match(body.properties.limit.description, /默认值 50 是查询上限，不是每日目标/);
    assert.match(body.properties.is_finished.description, /不保证仅包含今日目标/);
    assert.match(JSON.stringify(queue.outputSchema), /历史 API 字段名/);
    assert.doesNotMatch(JSON.stringify(queue.outputSchema), /今日学习列表|今日学习单词/);
    assert.match(JSON.stringify(progress.outputSchema), /唯一权威字段/);
    assert.match(JSON.stringify(records.outputSchema), /无过滤为学习计划总量/);
  } finally {
    await client.close();
    await server.close();
  }
});

it("preserves today's progress, the full returned queue and both queue tool names", async (t) => {
  const progress = { progress: { total: 50, finished: 10, study_time: 120000 } };
  const queue = { today_items: Array.from({ length: 233 }, (_, index) => ({
    voc_id: `fixture-${index}`, voc_spelling: `word${index}`, order: index + 1,
    first_response: "STUDY_RESPONSE_UNSPECIFIED", is_new: false, is_finished: false
  })) };
  const requests: { path: string; body: unknown }[] = [];
  t.mock.method(globalThis, "fetch", async (url: URL, init: RequestInit) => {
    requests.push({ path: url.pathname, body: init.body ? JSON.parse(init.body as string) : undefined });
    assert.equal((init.headers as any).Authorization, "Bearer test-only-token");
    const data = url.pathname.endsWith("get_study_progress") ? progress : queue;
    return Response.json({ success: true, data });
  });
  const { server, client } = await connect();
  try {
    const result = await client.callTool({ name: "maimemo_get_study_progress", arguments: {} });
    assert.deepEqual(result.structuredContent, { ok: true, data: progress, error: null });
    for (const name of ["maimemo_get_study_queue_items", "maimemo_get_today_items"]) {
      const result = await client.callTool({ name, arguments: { body: { is_finished: false, limit: 1000 } } });
      assert.equal(result.isError, undefined);
      assert.deepEqual(result.structuredContent, { ok: true, data: queue, error: null });
      assert.ok(Array.isArray(result.content));
      assert.deepEqual(JSON.parse((result.content[0] as { text: string }).text), result.structuredContent);
    }
    assert.deepEqual(requests, [
      { path: "/open/api/v1/study/get_study_progress", body: undefined },
      { path: "/open/api/v1/study/get_today_items", body: { is_finished: false, limit: 1000 } },
      { path: "/open/api/v1/study/get_today_items", body: { is_finished: false, limit: 1000 } }
    ]);
  } finally {
    await client.close();
    await server.close();
  }
});

it("keeps zero progress and read errors intact without inventing a daily target", async (t) => {
  let failing = false;
  t.mock.method(globalThis, "fetch", async () => failing
    ? new Response(null, { status: 503 })
    : Response.json({ success: true, data: { progress: { total: 0, finished: 0, study_time: 0 } } }));
  const { server, client } = await connect();
  try {
    const zero = await client.callTool({ name: "maimemo_get_study_progress", arguments: {} });
    assert.deepEqual(zero.structuredContent, { ok: true, data: { progress: { total: 0, finished: 0, study_time: 0 } }, error: null });
    failing = true;
    const failure = await client.callTool({ name: "maimemo_get_study_progress", arguments: {} });
    assert.equal(failure.isError, true);
    const content = failure.structuredContent as any;
    assert.deepEqual({ ok: content.ok, data: content.data, error: content.error }, { ok: false, data: null, error: "Official API HTTP 503" });
    assert.equal(content.error_details.code, "SERVICE_UNAVAILABLE");
    assert.equal(content.error_details.http_status, 503);
    assert.equal(content.error_details.retryable, true);
  } finally {
    await client.close();
    await server.close();
  }
});

it("serves corrected study docs and workflows while preserving the upstream snapshot", async () => {
  const { server, client } = await connect();
  try {
    const original = specification.paths["/api/v1/memo/study/get_today_items"].post;
    assert.equal(original.summary, "获取今日学习单词（公测）");
    assert.equal(specification.components.schemas.StudyTodayItem.description, "今日学习单词");

    const resource = await client.readResource({ uri: "maimemo://docs/openapi" });
    const text = (resource.contents[0] as { text: string }).text;
    const effective = parse(text);
    assert.equal(effective.paths["/api/v1/memo/study/get_today_items"].post.summary, "当前学习／复习队列（公测）");
    assert.match(effective.components.schemas.StudyProgress.properties.total.description, /唯一权威字段/);
    const document = await client.callTool({ name: "maimemo_documentation", arguments: { document: "openapi" } });
    assert.deepEqual(document.structuredContent, { text });
    for (const name of ["study", "memo-api"]) {
      const result = await client.readResource({ uri: `maimemo://docs/${name}` });
      const text = (result.contents[0] as { text: string }).text;
      assert.match(text, /maimemo_get_study_queue_items/);
      assert.match(text, /source of truth/);
      assert.doesNotMatch(text, /### Today's Words|Today's word list/);
    }
    const prompt = await client.getPrompt({ name: "maimemo_workflow", arguments: { task: "今天要学多少词？" } });
    const content = prompt.messages[0]!.content as { text: string };
    assert.match(content.text, /唯一权威来源/);
    assert.match(content.text, /建议的今日学习批次/);
  } finally {
    await client.close();
    await server.close();
  }
});
