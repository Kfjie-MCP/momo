import { createHash } from "node:crypto";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "./config.js";
import { invokeOfficial, operations } from "./official.js";
import { ApiError, describeError, errorDetailsSchema, toolFailure, toolSuccess } from "./errors.js";
import {
  REVIEW_TIMEZONE, ReviewStore, getReviewStore, studyDate, normalizeSpelling, daysBetween,
  eventKinds, importanceKinds, importanceMultipliers, masteryMultiplier, responsePoints,
  type DailyStats, type WordStats
} from "./review-store.js";

export const reviewToolNames = ["maimemo_get_today_review_words", "maimemo_report_word_events",
  "maimemo_get_long_term_review_words", "maimemo_get_word_review_history", "maimemo_retract_word_events"];
const spellingSchema = z.string().trim().min(1).max(160).refine(value => normalizeSpelling(value).length > 0);
const eventIdSchema = z.string().trim().min(1).max(128);
const limitSchema = z.number().int().min(1).max(1000).default(20);
const exclusionsSchema = z.array(spellingSchema).max(1000).default([]);
export const todayReviewInput = z.object({ mode: z.enum(["focus", "remaining"]).default("focus"), limit: limitSchema,
  exclude_spellings: exclusionsSchema });
export const longTermReviewInput = z.object({ limit: limitSchema, exclude_spellings: exclusionsSchema });
export const reportEventsInput = z.object({ events: z.array(z.object({
  event_id: eventIdSchema.describe("每次用户提问或实际作答的唯一 ID；重试必须复用，新的事件必须换 ID。"),
  spelling: spellingSchema,
  voc_id: z.string().trim().min(1).max(160).optional(),
  kind: z.enum(eventKinds).describe("lookup 查词、mnemonic 怎么背、comparison 对比、confusion 明确混淆、incorrect 实际答错、correct 实际答对。提问不能算答错；同一提问选最贴切的一类。"),
  importance: z.enum(importanceKinds).optional().describe("important 用户明确重点学习；normal 普通；incidental 冷门或顺带询问。按上下文标记，不凭大写认定专名。"),
  occurred_at: z.iso.datetime({ offset: true }).optional().describe("真实发生时间；缺省使用服务器接收时间。迟到反馈带原发生时间，勿编造历史。")
}).strict()).min(1).max(100) });
export const retractEventsInput = z.object({ event_ids: z.array(eventIdSchema).min(1).max(100)
  .describe("要撤回的本地上报事件 ID；从上报时保存的 ID 或单词历史 recent_events 中取得。重复 ID 只处理一次。") }).strict();
export const wordHistoryInput = z.object({ spelling: spellingSchema, recent_events_limit: z.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).max(2048).optional().describe("沿用上一页的 next_cursor 查看更早记录；保持同一账户和单词。") });

const countsSchema = z.object(Object.fromEntries(eventKinds.map(kind => [kind, z.number().int().nonnegative()])) as Record<typeof eventKinds[number], z.ZodNumber>);
const commonStatsSchema = z.object({ spelling: z.string(), voc_id: z.string().nullable(), counts: countsSchema,
  ai_error_rate: z.number().min(0).max(1).nullable().describe("仅实际 AI 复习作答的错误比例；提问和墨墨反馈不计入，未作答为 null。"),
  correct_streak: z.number().int().nonnegative(), importance: z.enum(importanceKinds), first_seen_at: z.string(),
  last_seen_at: z.string(), last_difficulty_at: z.string().nullable(), last_answer_at: z.string().nullable() });
const dailyStatsSchema = commonStatsSchema.extend({ study_date: z.string(), first_response_today: z.string().nullable(), positive_score: z.number() });
const wordStatsSchema = commonStatsSchema.extend({ observed_days: z.number().int(), difficult_days: z.number().int(),
  app_forget_days: z.number().int(), app_vague_days: z.number().int(), app_familiar_days: z.number().int(),
  anchor_date: z.string(), decayed_daily_score: z.number(), recent_difficult_dates: z.array(z.string()) });
const itemSchema = z.object({ spelling: z.string(), voc_id: z.string().nullable(), score: z.number().nonnegative(),
  sources: z.array(z.enum(["local_events", "maimemo_today", "maimemo_sticking", "pending_queue"])), reasons: z.array(z.string()),
  statistics: z.union([dailyStatsSchema, wordStatsSchema]).nullable() });
type ReviewItem = z.infer<typeof itemSchema>;
const metaSchema = { study_date: z.string(), time_zone: z.literal(REVIEW_TIMEZONE), warnings: z.array(z.string()) };
const recommendationsSchema = z.object({ ...metaSchema, items: z.array(itemSchema), returned_count: z.number().int(),
  candidate_count: z.number().int(), upstream_requests: z.number().int(), partial: z.boolean() });
export const todayReviewDataSchema = recommendationsSchema.extend({ scope: z.literal("today"), mode: z.enum(["focus", "remaining"]),
  word_list_semantics: z.enum(["observed_today_focus", "suggested_pending_batch"]),
  progress: z.object({ total: z.number().int(), finished: z.number().int(), remaining: z.number().int() }).nullable(),
  source_completeness: z.object({ maimemo_queue: z.enum(["complete", "unknown", "unavailable"]), local: z.enum(["complete", "unavailable"]) }) });
export const longTermReviewDataSchema = recommendationsSchema.extend({ scope: z.literal("long_term"),
  source_completeness: z.object({ maimemo_sticking: z.enum(["complete", "unknown", "unavailable"]), local: z.enum(["complete", "unavailable"]) }),
  history_scope: z.literal("reported_or_observed_since_connection") });
const reportDataSchema = z.object({ accepted_count: z.number().int(), duplicate_count: z.number().int(),
  retracted_count: z.number().int(), retracted_event_ids: z.array(z.string()).describe("这些事件已撤回，本次重试未保存或恢复。"),
  study_dates: z.array(z.string()), time_zone: z.literal(REVIEW_TIMEZONE) });
const retractDataSchema = z.object({ scope: z.literal("local_reported_events"), requested_count: z.number().int(),
  retracted_count: z.number().int(), already_retracted_count: z.number().int(), not_found_count: z.number().int(),
  retracted_event_ids: z.array(z.string()), already_retracted_event_ids: z.array(z.string()), not_found_event_ids: z.array(z.string()),
  study_dates: z.array(z.string()), time_zone: z.literal(REVIEW_TIMEZONE) });
const historyDataSchema = z.object({ ...metaSchema, scope: z.literal("word_history"), spelling: z.string(), today: dailyStatsSchema.nullable(),
  last_30_days: z.object({ counts: countsSchema, ai_error_rate: z.number().nullable(), observed_days: z.number().int(),
    difficult_days: z.number().int(), app_forget_days: z.number().int(), app_vague_days: z.number().int() }),
  all_time: wordStatsSchema.nullable(), recent_events: z.array(z.object({ event_id: z.string(), spelling: z.string(), voc_id: z.string().nullable(),
    kind: z.enum(eventKinds), importance: z.enum(importanceKinds).nullable(), occurred_at: z.string(), study_date: z.string() })),
  events_truncated: z.boolean(), next_cursor: z.string().nullable() });
const envelope = (data: z.ZodType) => z.object({ ok: z.boolean(), data: data.nullable(), error: z.string().nullable(), error_details: errorDetailsSchema.optional() });

export interface ReviewDependencies { fetcher?: typeof fetch; now?: () => number; random?: () => number; store?: ReviewStore }
const validated = new Map<string, number>();
const authenticating = new Map<string, Promise<void>>();
const credentialKey = (config: AppConfig) => {
  if (!config.maimemoApiToken) throw new ApiError("MaiMemo access token is required.", "AUTH_REQUIRED");
  return createHash("sha256").update(config.maimemoApiToken).digest("hex");
};
function markValidated(config: AppConfig, now: number) {
  const key = credentialKey(config);
  validated.delete(key);
  validated.set(key, now + 15 * 60_000);
  while (validated.size > 1000) validated.delete(validated.keys().next().value!);
}
const isAuthError = (error: unknown) => ["AUTH_INVALID", "PERMISSION_DENIED", "AUTH_REQUIRED"].includes(describeError(error).code);

function context(config: AppConfig, dependencies: ReviewDependencies) {
  credentialKey(config);
  const now = dependencies.now ?? Date.now;
  let requests = 0;
  const call = async (action: string, parameters: unknown) => {
    requests++;
    try {
      const data = await invokeOfficial(operations.find(operation => operation.action === action)!, parameters, config, dependencies.fetcher ?? fetch);
      markValidated(config, now());
      return data;
    } catch (error) {
      if (isAuthError(error)) validated.delete(credentialKey(config));
      throw error;
    }
  };
  const authenticate = async (spelling: string) => {
    if (config.authMode === "server") return;
    const key = credentialKey(config);
    if ((validated.get(key) ?? 0) > now()) return;
    let pending = authenticating.get(key);
    if (!pending) {
      pending = call("ListVocabulary", { body: { spellings: [spelling] } }).then(() => {});
      authenticating.set(key, pending);
    }
    try { await pending; } finally { if (authenticating.get(key) === pending) authenticating.delete(key); }
  };
  const local = () => {
    const store = dependencies.store ?? getReviewStore(config.localReviewDbPath);
    return { store, namespace: store.namespace(config.maimemoApiToken!) };
  };
  return { now, call, authenticate, local, requestCount: () => requests };
}

/** Mixed sampling without replacement; injectable randomness makes probability
 * and exclusion checks deterministic without exposing a seed in the API. */
export function sampleReviewWords(items: ReviewItem[], limit: number, random = Math.random) {
  const pool = [...items];
  const result: ReviewItem[] = [];
  while (pool.length && result.length < limit) {
    const sum = pool.reduce((total, item) => total + item.score, 0);
    const uniform = !sum || random() < 0.2;
    const target = random() * (uniform ? pool.length : sum);
    let cumulative = 0;
    let index = pool.length - 1;
    for (let i = 0; i < pool.length; i++) {
      cumulative += uniform ? 1 : pool[i]!.score;
      if (target < cumulative) { index = i; break; }
    }
    result.push(pool.splice(index, 1)[0]!);
  }
  return result;
}

function dailyItem(day: DailyStats): ReviewItem {
  const sources: ReviewItem["sources"] = [];
  const reasons: string[] = [];
  if (eventKinds.some(kind => day.counts[kind] > 0)) sources.push("local_events");
  if (day.first_response_today) sources.push("maimemo_today");
  const labels = { lookup: "主动查词", mnemonic: "询问记忆方法", comparison: "询问词义对比", confusion: "明确易混", incorrect: "实际答错", correct: "实际答对" };
  for (const kind of eventKinds) if (day.counts[kind]) reasons.push(`今天${labels[kind]} ${day.counts[kind]} 次`);
  if (responsePoints(day.first_response_today)) reasons.push(`墨墨今天首次反馈：${day.first_response_today === "FORGET" ? "忘记" : "模糊"}`);
  if (day.importance === "incidental") reasons.push("冷门或顺带询问，降低复习权重");
  return { spelling: day.spelling, voc_id: day.voc_id,
    score: day.positive_score * importanceMultipliers[day.importance] * masteryMultiplier(day.correct_streak),
    sources, reasons, statistics: day };
}

export function longTermItem(word: WordStats, date: string, sticking: boolean): ReviewItem {
  const recentDays = word.recent_difficult_dates.filter(day => daysBetween(date, day) >= 0 && daysBetween(date, day) < 90).length;
  const decayed = word.decayed_daily_score * 2 ** (-Math.max(0, daysBetween(date, word.anchor_date)) / 30);
  let score = (Math.min(24, decayed) + 2 * Math.min(5, recentDays) + (sticking ? 4 : 0))
    * importanceMultipliers[word.importance] * masteryMultiplier(word.correct_streak);
  if (word.importance === "incidental") score = Math.min(2, score);
  const reasons: string[] = [];
  const questions = word.counts.lookup + word.counts.mnemonic + word.counts.comparison + word.counts.confusion;
  if (questions) reasons.push(`累计主动问词 ${questions} 次；提问不算答错`);
  if (word.counts.incorrect) reasons.push(`AI 复习累计答错 ${word.counts.incorrect} 次`);
  if (recentDays) reasons.push(`近 90 天在 ${recentDays} 天出现记忆困难`);
  if (word.app_forget_days || word.app_vague_days) reasons.push(`观察到墨墨首次忘记 ${word.app_forget_days} 天、模糊 ${word.app_vague_days} 天`);
  if (sticking) reasons.push("墨墨难记词标签；不代表已知历史答错次数");
  if (word.correct_streak) reasons.push(`最近连续答对 ${word.correct_streak} 次，降低复习权重`);
  if (word.importance === "incidental") reasons.push("冷门或顺带询问，长期权重封顶 2 分");
  return { spelling: word.spelling, voc_id: word.voc_id, score,
    sources: [...(eventKinds.some(kind => word.counts[kind] > 0) ? ["local_events" as const] : []),
      ...(word.app_forget_days || word.app_vague_days || word.app_familiar_days ? ["maimemo_today" as const] : []),
      ...(sticking ? ["maimemo_sticking" as const] : [])], reasons, statistics: word };
}

export async function invokeReportWordEvents(raw: unknown, config: AppConfig, dependencies: ReviewDependencies = {}) {
  const { events } = reportEventsInput.parse(raw);
  const ctx = context(config, dependencies);
  const now = ctx.now();
  for (const event of events) if (event.occurred_at && Date.parse(event.occurred_at) > now) {
    throw new ApiError("反馈的 occurred_at 不能晚于服务器当前时间。", "INVALID_ARGUMENT");
  }
  await ctx.authenticate(events[0]!.spelling);
  const { store, namespace } = ctx.local();
  return { ...store.report(namespace, events, now), time_zone: REVIEW_TIMEZONE };
}

export async function invokeRetractWordEvents(raw: unknown, config: AppConfig, dependencies: ReviewDependencies = {}) {
  const { event_ids } = retractEventsInput.parse(raw);
  const ctx = context(config, dependencies);
  await ctx.authenticate("apple");
  const { store, namespace } = ctx.local();
  return { scope: "local_reported_events" as const, ...store.retract(namespace, event_ids, ctx.now()), time_zone: REVIEW_TIMEZONE };
}

type QueueItem = { voc_id: string; voc_spelling: string; first_response?: string; is_finished: boolean; is_new: boolean; order: number };
export async function invokeTodayReviewWords(raw: unknown, config: AppConfig, dependencies: ReviewDependencies = {}) {
  const args = todayReviewInput.parse(raw);
  const ctx = context(config, dependencies);
  const started = ctx.now();
  const date = studyDate(started);
  const results = await Promise.allSettled([
    ctx.call("GetStudyProgress", {}),
    ctx.call("GetTodayItems", { body: { ...(args.mode === "remaining" ? { is_finished: false } : {}), limit: 1000 } })
  ]);
  for (const result of results) if (result.status === "rejected" && isAuthError(result.reason)) {
    validated.delete(credentialKey(config));
    throw result.reason;
  }
  if (studyDate(ctx.now()) !== date) throw new ApiError("北京时间日期已切换，请重新查询今日复习。", "SERVICE_UNAVAILABLE", null, true);
  const progressResult = results[0]!;
  const queueResult = results[1]!;
  const progress = progressResult.status === "fulfilled" ? { total: progressResult.value.progress.total,
    finished: progressResult.value.progress.finished,
    remaining: Math.max(0, progressResult.value.progress.total - progressResult.value.progress.finished) } : null;
  if (args.mode === "remaining" && progressResult.status === "rejected") throw progressResult.reason;
  if (args.mode === "remaining" && progress!.remaining > 0 && queueResult.status === "rejected") throw queueResult.reason;
  const queue: QueueItem[] = queueResult.status === "fulfilled" ? queueResult.value.today_items : [];
  await ctx.authenticate(queue[0]?.voc_spelling ?? "apple");
  const warnings: string[] = [];
  if (progressResult.status === "rejected") warnings.push(`今日进度不可用：${describeError(progressResult.reason, config.maimemoApiToken).code}；不能确定剩余数。`);
  if (queueResult.status === "rejected") warnings.push(`墨墨今日队列不可用：${describeError(queueResult.reason, config.maimemoApiToken).code}；仅使用本地今日记录。`);
  if (queue.length >= 1000) warnings.push("墨墨队列达到 1000 条上限，来源完整性未知，不能声称已覆盖全部今日困难词。");
  let localComplete = true;
  let daily: DailyStats[] = [];
  try {
    const { store, namespace } = ctx.local();
    store.observe(namespace, date, queue, started);
    daily = store.daily(namespace, date);
  } catch (error) {
    if (!(error instanceof ApiError) || error.code !== "LOCAL_STORAGE_ERROR") throw error;
    localComplete = false;
    warnings.push(error.message);
  }
  const bySpelling = new Map(daily.map(day => [normalizeSpelling(day.spelling), dailyItem(day)]));
  // Even if the database is unavailable, today's upstream feedback remains usable.
  for (const item of queue) {
    const key = normalizeSpelling(item.voc_spelling);
    if (responsePoints(item.first_response ?? null) && !bySpelling.has(key)) bySpelling.set(key, {
      spelling: item.voc_spelling, voc_id: item.voc_id, score: responsePoints(item.first_response!),
      sources: ["maimemo_today"], reasons: [`墨墨今天首次反馈：${item.first_response === "FORGET" ? "忘记" : "模糊"}`], statistics: null });
  }
  let candidates: ReviewItem[];
  if (args.mode === "remaining") {
    // Preserve upstream array order when defining this explicitly suggested batch;
    // never infer daily assignment from the numeric order field.
    const uniquePending = [...new Map(queue.filter(item => !item.is_finished)
      .map(item => [normalizeSpelling(item.voc_spelling), item])).values()];
    candidates = uniquePending.slice(0, progress!.remaining).map(item => {
      const known = bySpelling.get(normalizeSpelling(item.voc_spelling));
      return { spelling: item.voc_spelling, voc_id: item.voc_id, score: known?.score ?? 0,
        sources: [...(known?.sources ?? []), "pending_queue" as const],
        reasons: [...(known?.reasons ?? []), "按未完成队列顺序建议的今日学习批次，非 App 确认的今日词表"], statistics: known?.statistics ?? null };
    });
    warnings.push("返回的是未完成队列的建议学习批次；上游没有提供 App 今日安排的逐词标记。");
  } else candidates = [...bySpelling.values()].filter(item => item.score > 0);
  const excluded = new Set(args.exclude_spellings.map(normalizeSpelling));
  candidates = candidates.filter(item => !excluded.has(normalizeSpelling(item.spelling)));
  const items = sampleReviewWords(candidates, args.limit, dependencies.random);
  return { scope: "today" as const, mode: args.mode, study_date: date, time_zone: REVIEW_TIMEZONE,
    word_list_semantics: args.mode === "remaining" ? "suggested_pending_batch" as const : "observed_today_focus" as const,
    progress, items, returned_count: items.length, candidate_count: candidates.length, upstream_requests: ctx.requestCount(),
    source_completeness: { maimemo_queue: queueResult.status === "rejected" ? "unavailable" as const : queue.length >= 1000 ? "unknown" as const : "complete" as const,
      local: localComplete ? "complete" as const : "unavailable" as const },
    partial: !localComplete || results.some(result => result.status === "rejected") || queue.length >= 1000, warnings };
}

export async function invokeLongTermReviewWords(raw: unknown, config: AppConfig, dependencies: ReviewDependencies = {}) {
  const args = longTermReviewInput.parse(raw);
  const ctx = context(config, dependencies);
  const date = studyDate(ctx.now());
  const warnings = ["历史统计仅覆盖接入后实际上报或观察到的数据；墨墨难记标签不提供完整历史答错次数。"];
  let records: { voc_id: string; voc_spelling: string; tags: string[] }[] = [];
  let officialComplete: "complete" | "unknown" | "unavailable" = "complete";
  try {
    const data = await ctx.call("QueryStudyRecords", { body: { tags: "STICKING", limit: 1000 } });
    records = data.records;
    if (records.length >= 1000) { officialComplete = "unknown"; warnings.push("墨墨难记词达到 1000 条上限，来源未确认取全。"); }
  } catch (error) {
    if (isAuthError(error)) throw error;
    officialComplete = "unavailable";
    warnings.push(`墨墨难记词不可用：${describeError(error, config.maimemoApiToken).code}；仅使用本地历史。`);
  }
  await ctx.authenticate(records[0]?.voc_spelling ?? "apple");
  let words: WordStats[] = [];
  let localComplete = true;
  try { const { store, namespace } = ctx.local(); words = store.words(namespace); }
  catch (error) {
    if (!(error instanceof ApiError) || error.code !== "LOCAL_STORAGE_ERROR") throw error;
    localComplete = false; warnings.push(error.message);
  }
  const sticking = new Map(records.filter(record => record.tags.includes("STICKING")).map(record => [normalizeSpelling(record.voc_spelling), record]));
  const bySpelling = new Map(words.map(word => [normalizeSpelling(word.spelling), longTermItem(word, date, sticking.has(normalizeSpelling(word.spelling)))]));
  for (const [key, record] of sticking) {
    if (bySpelling.has(key)) { const item = bySpelling.get(key)!; item.voc_id ??= record.voc_id; continue; }
    bySpelling.set(key, { spelling: record.voc_spelling, voc_id: record.voc_id, score: 4, sources: ["maimemo_sticking"],
      reasons: ["墨墨难记词标签；尚无本地历史，不能推算答错次数"], statistics: null });
  }
  const excluded = new Set(args.exclude_spellings.map(normalizeSpelling));
  const candidates = [...bySpelling.values()].filter(item => item.score > 0 && !excluded.has(normalizeSpelling(item.spelling)));
  const items = sampleReviewWords(candidates, args.limit, dependencies.random);
  return { scope: "long_term" as const, study_date: date, time_zone: REVIEW_TIMEZONE, items, returned_count: items.length,
    candidate_count: candidates.length, upstream_requests: ctx.requestCount(), partial: !localComplete || officialComplete !== "complete",
    source_completeness: { maimemo_sticking: officialComplete, local: localComplete ? "complete" as const : "unavailable" as const },
    history_scope: "reported_or_observed_since_connection" as const, warnings };
}

export async function invokeWordReviewHistory(raw: unknown, config: AppConfig, dependencies: ReviewDependencies = {}) {
  const args = wordHistoryInput.parse(raw);
  const ctx = context(config, dependencies);
  const date = studyDate(ctx.now());
  await ctx.authenticate(args.spelling);
  const { store, namespace } = ctx.local();
  return { scope: "word_history" as const, study_date: date, time_zone: REVIEW_TIMEZONE, spelling: args.spelling,
    ...store.history(namespace, args.spelling, date, args.recent_events_limit, args.cursor),
    warnings: ["提问次数、AI 实际作答和墨墨每日首次反馈分别统计；历史只覆盖接入后的实际上报与观察。"] };
}

export function registerReview(server: McpServer, config: AppConfig) {
  const definitions = [
    { name: reviewToolNames[0]!, title: "今日重点复习与剩余学习建议", input: todayReviewInput, output: todayReviewDataSchema,
      invoke: invokeTodayReviewWords, readOnly: false, idempotent: false,
      description: "默认复习入口。用户问今天的易错词、再复习一下或未指定时段的高频错词时调用。focus 只用今天的提问、作答和墨墨首次反馈；remaining 按权威今日剩余数建议队列批次。隔天重新计算权重，历史错频不参与。服务批量筛选并随机抽取，支持 exclude_spellings。成功读取的今日反馈会本地保存为每日快照，不修改墨墨；无需逐次确认本地记录。" },
    { name: reviewToolNames[1]!, title: "及时上报用户问词与复习反馈", input: reportEventsInput, output: reportDataSchema,
      invoke: invokeReportWordEvents, readOnly: false, idempotent: true,
      description: "完成用户主动查词、怎么背、词义对比或易混讲解后，以及收到实际复习答案后，必须在本轮及时调用。不要记录 AI 自己列出的词，不把提问算答错；同一提问选最贴切的一种 kind。只根据实际用户答案报告 correct/incorrect，未确认的作答不评分。一次最多 100 条，每次真实事件用新 event_id，重试复用原 ID。已撤回的事件重试不会恢复，retracted_count 不算成功保存；更正用新 ID。只写本地学习库，独立于 ALLOW_MUTATIONS，无需逐次确认；失败不能宣称已保存。" },
    { name: reviewToolNames[2]!, title: "长期易错词与历史重点复习", input: longTermReviewInput, output: longTermReviewDataSchema,
      invoke: invokeLongTermReviewWords, readOnly: true, idempotent: false,
      description: "仅在用户明确要求长期、历史、累计或全部记录中的易错词时调用。不要用于今天的复习或未指定时段的普通复习。独立 long_term 范围，综合近期表现、跨天反复困难和墨墨难记标签；旧困难逐渐衰减、连续答对降权、冷门词低权重，随机抽取且不虚构历史错频。" },
    { name: reviewToolNames[3]!, title: "查看单词的今日与长期复习历史", input: wordHistoryInput, output: historyDataSchema,
      invoke: invokeWordReviewHistory, readOnly: true, idempotent: true,
      description: "用户明确询问某词过去是否经常错、问过几次、想查看学习历史或需要定位误报时调用。分别返回今日、近 30 天、累计统计和事件 ID。每页最多 100 条，有 next_cursor 时继续传 cursor 可查看更早事件；翻页不改变统计范围。ai_error_rate 只算实际 AI 作答，提问与墨墨首次反馈独立统计；未作答为 null，不代表零错误。" },
    { name: reviewToolNames[4]!, title: "撤回误报的单词学习记录", input: retractEventsInput, output: retractDataSchema,
      invoke: invokeRetractWordEvents, readOnly: false, idempotent: true, destructive: true,
      description: "用户要求撤回学习记录或确认此前上报有误时，按准确 event_ids 撤回当前账户的本地反馈，支持旧记录，一次最多 100 条。ID 不明确时先查单词历史并翻页定位，不按猜测批量删除，不为降低权重撤回真实错误。撤回后立即重算今日、近 30 天、累计统计和长期权重；重复撤回安全，旧上报重试不会恢复。更正应先撤回误报，再用新 ID 上报真实反馈。独立于 ALLOW_MUTATIONS，无需对已明确要求的本地撤回再次确认。仅撤回 AI 本地上报事件；墨墨官方记录和独立观察到的每日快照仍按来源统计。必须按返回的已撤回、已撤回过、未找到分别说明结果。" }
  ];
  for (const definition of definitions) server.registerTool(definition.name, {
    title: definition.title, description: definition.description, inputSchema: definition.input,
    outputSchema: envelope(definition.output), annotations: { readOnlyHint: definition.readOnly,
      destructiveHint: definition.destructive ?? false, idempotentHint: definition.idempotent, openWorldHint: true }
  }, async (args: unknown) => {
    try { return toolSuccess(await definition.invoke(args, config)); }
    catch (error) { return toolFailure(error, config.maimemoApiToken); }
  });
}
