import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "./config.js";
import { invokeOfficial, operations, resolveSchema } from "./official.js";
import { ApiError, describeError, errorDetailsSchema, toolFailure, toolSuccess } from "./errors.js";
import { FIRST_RESPONSE_DESCRIPTION, ORDER_DESCRIPTION } from "./study.js";

export const enhancedToolNames = ["maimemo_get_study_queue", "maimemo_get_vocabulary_details"];
const op = (action: string) => operations.find(operation => operation.action === action)!;
const component = (name: string) => z.fromJSONSchema(resolveSchema({ $ref: `#/components/schemas/${name}` }));
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const envelope = (data: z.ZodType) => z.object({ ok: z.boolean(), data: data.nullable(), error: z.string().nullable(), error_details: errorDetailsSchema.optional() });

export const queueInput = z.object({ body: z.object({
  is_finished: z.boolean().optional().describe("false 查询待学习队列；true 查询当天已完成的队列条目。"),
  is_new: z.boolean().optional(),
  voc_ids: z.array(z.string().min(1)).max(1000).optional().describe("与 spellings 互斥，不能混用 is_finished/is_new。"),
  spellings: z.array(z.string().min(1)).max(1000).optional().describe("与 voc_ids 互斥，不能混用 is_finished/is_new。"),
  limit: z.number().int().min(1).max(1000).default(1000).describe("本次展示上限，默认 1000；后台读取最多 1000 条以判断完整性。不是每日目标。")
}).default({ limit: 1000 }) });
const queueItem = (component("StudyTodayItem") as z.ZodObject).extend({
  first_response_today: component("StudyResponse").nullable().describe(FIRST_RESPONSE_DESCRIPTION)
});
export const queueDataSchema = z.object({
  items: z.array(queueItem), returned_count: z.number().int(),
  total_count: z.number().int().nullable().describe("本次筛选范围的总条目数；上游返回不足 1000 条时由返回数确定，达到 1000 时为 null，不能当作 0。"),
  has_more: z.boolean().nullable().describe("已读到展示范围以外条目时为 true；完整且无剩余为 false；达到上游上限且无已知剩余时为 null。上游无分页游标。"),
  completeness: z.enum(["complete", "unknown"]), count_scope: z.literal("matching_query"),
  total_count_source: z.enum(["returned_below_upstream_limit", "unknown"]),
  fetched_count: z.number().int(), upstream_limit: z.literal(1000), limit: z.number().int(),
  pagination_supported: z.literal(false), order_policy: z.literal("upstream_response_order").describe(ORDER_DESCRIPTION),
  warnings: z.array(z.string())
});
type QueueItem = { voc_id: string; voc_spelling: string; order: number; first_response?: string; is_new: boolean; is_finished: boolean };

export async function invokeStudyQueue(raw: unknown, config: AppConfig, fetcher: typeof fetch = fetch) {
  const { body } = queueInput.parse(raw);
  const { limit, ...filters } = body;
  const result = await invokeOfficial(op("GetTodayItems"), { body: { ...filters, limit: 1000 } }, config, fetcher);
  const all = result.today_items as QueueItem[];
  const complete = all.length < 1000;
  const items = all.slice(0, limit).map(item => ({ ...item, first_response_today: item.first_response ?? null }));
  return { items, returned_count: items.length, total_count: complete ? all.length : null,
    has_more: all.length > items.length ? true : complete ? false : null,
    completeness: complete ? "complete" as const : "unknown" as const, count_scope: "matching_query" as const,
    total_count_source: complete ? "returned_below_upstream_limit" as const : "unknown" as const,
    fetched_count: all.length, upstream_limit: 1000 as const, limit, pagination_supported: false as const,
    order_policy: "upstream_response_order" as const,
    warnings: complete ? [] : ["上游返回达到 1000 条上限，无法确认完整总数，也无法通过 cursor/offset 获取后续条目。"] };
}

const includes = ["interpretations", "notes", "phrases", "study_record"] as const;
type Include = typeof includes[number];
export const detailsInput = z.object({
  voc_ids: z.array(z.string().trim().min(1)).min(1).max(10).describe("最多 10 个单词 ID；重复 ID 去重并保留首次出现顺序。"),
  include: z.array(z.enum(includes)).max(4).default([...includes]).describe("默认全部自建内容及学习记录，可只请求需要的部分；基础词汇信息总会查询。")
});
const detailItemSchema = z.object({
  voc_id: z.string(), spelling: z.string().nullable(), vocabulary: (component("Vocabulary") as z.ZodType<{ id: string; spelling: string }>).nullable(),
  interpretations: z.array(component("Interpretation")).nullable(), notes: z.array(component("Note")).nullable(),
  phrases: z.array(component("Phrase")).nullable(), study_record: component("StudyRecord").nullable(),
  errors: z.array(z.object({ component: z.enum(["vocabulary", ...includes]), ...errorDetailsSchema.shape }))
});
export const detailsDataSchema = z.object({ items: z.array(detailItemSchema), partial: z.boolean(),
  requested_count: z.number().int(), unique_count: z.number().int(), include: z.array(z.enum(includes)),
  upstream_requests: z.number().int(), content_scope: z.literal("user_created"), warnings: z.array(z.string()) });

// Request-local pacing avoids a 30-request burst. At most 3 requests are active,
// with starts spaced by 600 ms; a maximum-size batch makes at most 32 requests.
// Other requests sharing the account can still consume its official quota.
export async function invokeVocabularyDetails(raw: unknown, config: AppConfig, fetcher: typeof fetch = fetch, paceMs = 600) {
  const args = detailsInput.parse(raw);
  const ids = [...new Set(args.voc_ids)];
  const selected = [...new Set(args.include)];
  const items: z.infer<typeof detailItemSchema>[] = ids.map(voc_id => ({ voc_id, spelling: null, vocabulary: null,
    interpretations: null, notes: null, phrases: null, study_record: null, errors: [] }));
  let requests = 0;
  let stopped: unknown;
  let nextStart = 0;
  const deadline = Date.now() + 50_000;
  let gate = Promise.resolve();
  const call = async (action: string, parameters: unknown) => {
    const turn = gate.then(async () => {
      if (stopped) throw stopped;
      const wait = nextStart - Date.now();
      if (wait > 0) await delay(wait);
      if (stopped) throw stopped;
      if (Date.now() >= deadline) {
        stopped = new ApiError("Vocabulary detail batch exceeded its 50-second time budget; request fewer components or words.", "TIMEOUT", null, true);
        throw stopped;
      }
      nextStart = Date.now() + paceMs;
    });
    gate = turn.catch(() => {});
    await turn;
    requests++;
    try { return await invokeOfficial(op(action), parameters, { ...config, cliTimeoutMs: Math.min(config.cliTimeoutMs, Math.max(1, deadline - Date.now())) }, fetcher); }
    catch (error) {
      if (["AUTH_REQUIRED", "AUTH_INVALID", "PERMISSION_DENIED", "RATE_LIMITED", "SERVICE_UNAVAILABLE", "NETWORK_ERROR", "TIMEOUT"].includes(describeError(error).code)) stopped = error;
      throw error;
    }
  };
  const addError = (item: typeof items[number], part: "vocabulary" | Include, error: unknown) =>
    item.errors.push({ component: part, ...describeError(error, config.maimemoApiToken) });
  const initial = await Promise.allSettled([
    call("ListVocabulary", { body: { ids } }),
    ...(selected.includes("study_record") ? [call("QueryStudyRecords", { body: { voc_ids: ids, limit: 1000 } })] : [])
  ]);
  const vocab = initial[0]!;
  const records = initial[1];
  for (const item of items) {
    if (vocab.status === "fulfilled") {
      item.vocabulary = vocab.value.voc.find((word: any) => word.id === item.voc_id) ?? null;
      item.spelling = item.vocabulary?.spelling ?? null;
      if (!item.vocabulary) addError(item, "vocabulary", new ApiError("Vocabulary ID was not returned by the official API.", "NOT_FOUND"));
    } else addError(item, "vocabulary", vocab.reason);
    if (records?.status === "fulfilled") item.study_record = records.value.records.find((record: any) => record.voc_id === item.voc_id) ?? null;
    else if (records?.status === "rejected") addError(item, "study_record", records.reason);
  }
  if (stopped && initial.every(result => result.status === "rejected")) throw stopped;
  const actions = { interpretations: "ListInterpretations", notes: "ListNotes", phrases: "ListPhrases" };
  const jobs = items.flatMap(item => selected.filter((part): part is keyof typeof actions => part !== "study_record")
    .map(part => async () => {
      try { const result = await call(actions[part], { query: { voc_id: item.voc_id } }); item[part] = result[part]; }
      catch (error) { addError(item, part, error); }
    }));
  let jobIndex = 0;
  await Promise.all(Array.from({ length: Math.min(3, jobs.length) }, async () => {
    while (jobIndex < jobs.length) await jobs[jobIndex++]!();
  }));
  const data = { items, partial: items.some(item => item.errors.length > 0), requested_count: args.voc_ids.length,
    unique_count: ids.length, include: selected, upstream_requests: requests, content_scope: "user_created" as const,
    warnings: ["释义、助记和例句仅为用户自建内容；空数组不表示 App 词典没有该词的内容。", "一次 MCP 调用聚合现有官方请求，不减少官方请求配额；同账户的其他调用仍可能触发限流。"] };
  if (Buffer.byteLength(JSON.stringify(data)) > 8 * 1024 * 1024) throw new ApiError("Aggregated vocabulary details exceed 8 MiB; request fewer words or components.", "RESPONSE_TOO_LARGE");
  return data;
}

export function registerEnhanced(server: McpServer, config: AppConfig) {
  server.registerTool("maimemo_get_study_queue", {
    title: "学习队列与查询完整性",
    description: "基于现有 get_today_items 的只读聚合工具，优先用于检查队列完整性。默认读取／展示最多 1000 条，提供 returned_count、total_count、has_more 和 completeness。达到上游上限时未知总数返回 null；无 cursor/offset 分页。total_count 是本次筛选范围，不是今日目标。保留上游返回顺序，并提供 first_response_today 别名（当天首次反馈）。",
    inputSchema: queueInput, outputSchema: envelope(queueDataSchema), annotations: readOnly
  }, async args => {
    try { return toolSuccess(await invokeStudyQueue(args, config)); }
    catch (error) { return toolFailure(error, config.maimemoApiToken); }
  });
  server.registerTool("maimemo_get_vocabulary_details", {
    title: "批量获取词汇、自建内容与学习记录",
    description: "基于现有官方 API 聚合最多 10 个 voc_id 的基础信息、自建释义／助记／例句和学习记录。include 可减少请求，默认全部；重复 ID 去重。一次 MCP 调用仍消耗多次官方请求，最多 32 次，按 600ms 间隔启动、最多 3 个并发，50 秒预算，不自动重试。partial 和每词 errors 表明部分失败；null 不能等同空数组。仅提供用户自建内容，不是 App 全部词典资源。",
    inputSchema: detailsInput, outputSchema: envelope(detailsDataSchema), annotations: readOnly
  }, async args => {
    try { return toolSuccess(await invokeVocabularyDetails(args, config)); }
    catch (error) { return toolFailure(error, config.maimemoApiToken); }
  });
}
