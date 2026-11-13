import { ApiError } from "./errors.js";

// Shared by MCP initialization, tools, schemas, documentation and workflows.
export const ORDER_DESCRIPTION = "上游提供的学习顺序值。服务保留接口返回顺序；官方未说明数值方向、是否每日重算或跨查询全局稳定性。可通过 is_finished 查询已完成或未完成条目。不得用 order 前 N 项推断 App 今日目标归属。";
export const FIRST_RESPONSE_DESCRIPTION = "当天第一次学习反馈（first_response_today），不是历史首次或最近一次反馈。缺省或 STUDY_RESPONSE_UNSPECIFIED 表示没有可用首次反馈，不能当作认识或忘记。";

export const STUDY_SEMANTICS = `学习数据分为三个模块：今日目标与进度、当前学习队列、学习计划与记录。
- 今日目标与进度：maimemo_get_study_progress 返回 progress.total（今日应完成数，唯一权威来源）、progress.finished（今日已完成数）、progress.study_time（今日学习时长，毫秒）。MCP 响应位于 data.progress。今日剩余数为 max(0, total - finished)。此接口不返回具体单词列表。
- 当前学习队列：优先使用 maimemo_get_study_queue_items；maimemo_get_today_items 是同一接口的历史兼容名。返回字段 today_items 也是历史名称，实际含义为学习/复习队列条目，不是仅限今日目标的词表。查询未完成队列使用 body.is_finished=false。队列可能有 233/235 个，而今日目标只有 50 个；不得用队列长度替代 progress.total。
- 要判断队列是否完整，优先使用聚合工具 maimemo_get_study_queue：一次读取至多 1000 条，默认展示 1000 条，提供 returned_count、total_count、has_more 和 completeness；total_count=null 或 has_more=null 表示无法确认，不是零或 false。官方未提供 cursor/offset，不能宣称可以翻到第 1000 条之后。total_count 仅针对本次筛选范围。
- limit 仅是本次查询的返回上限，默认 50、最多 1000，与每日目标无关。有过滤或达到返回上限时，不得把返回数量声称为完整队列总量。
- 用户问“今天学多少／还剩多少”时，先查 maimemo_get_study_progress。用户要“今天的单词”时，先查今日进度；如需安排接下来学习的词，按队列 order 选择未完成条目，数量至多为今日剩余数，并明确称为“按队列顺序建议的今日学习批次”。仅凭 progress.total 和队列前 N 项不能证明这些就是 App 官方分配的今日词表。剩余数为 0 时，今日目标已完成，不得因队列仍有词而称今天还有任务。
- 学习计划与记录：maimemo_query_study_records 查询历史记录和复习排期；body.as_count=true 且不加过滤时，count 才是学习计划总量。它与今日目标、当前队列长度是三个不同指标。
- 如果今日数据未初始化或读取失败，应说明今日目标暂不可确定；不要改用队列长度或默认 limit=50 猜测。学习接口为公测，需要 App 当日初始化并开启自动同步。`;
export const AGENT_GUIDANCE = `${STUDY_SEMANTICS}
- order：${ORDER_DESCRIPTION}
- first_response：${FIRST_RESPONSE_DESCRIPTION} 增强队列工具提供同值别名 first_response_today，不编造今日尝试次数或最近反馈。
- 按 voc_ids 或 spellings 查询时，不得混用状态、日期、标签等会被上游忽略的筛选条件；MCP 会在请求前返回 INVALID_ARGUMENT_COMBINATION。limit/as_count 是查询控制参数。
- 批量单词详情使用 maimemo_get_vocabulary_details，一次最多 10 个 voc_id；include 可只取需要的部分。返回的是现有 API 聚合，释义、助记、例句仅限用户自建内容，不是 App 全部词典资源。空数组表示成功但无自建内容；null 配合 errors 表示失败或未请求。partial=true 时不要把缺失部分当作不存在。
- 错误时保留兼容字符串 error，并提供 error_details.code/http_status/retryable/retry_after_seconds。AUTH_INVALID 仅表示令牌无效或过期，不能断言具体原因。写操作不应自动重试；mutation_may_have_succeeded=true 时先检查状态。
- records.tags 是标签数组；请求筛选 body.tags 仍为单值 STICKING，不能照搬为多值数组。
- 今日复习是默认入口：用户问今天的易错词、再复习一下或未指定时段的高频错词，直接使用 maimemo_get_today_review_words(mode=focus)；问剩余单词建议使用 mode=remaining，工具内部读取今日进度和队列。不得默认转成全局历史复习。只有明确询问长期、历史、累计或全部记录中的易错词，才使用 maimemo_get_long_term_review_words；明确问某词过去的记录才用 maimemo_get_word_review_history。
- 今日工具只按 Asia/Shanghai 当天的事件及墨墨首次反馈计算，历史错频不参与；第二天重新算。长期统计分别展示主动提问、AI 实际作答错率、困难天数和墨墨观察天数，未观察到的历史不能编造，未作答的错率为 null。
- 完成用户主动查词、怎么背、词义对比或易混讲解后，以及收到实际复习答案后，必须在本轮及时调用 maimemo_report_word_events。只记录用户主动关注的词和实际作答，不记录 AI 自己列出的词。提问不能算答错；同一提问选最贴切的一类，只有真实且可判断的答案才报告 correct/incorrect。每次真实事件生成唯一 event_id，重试复用原 ID，不同问题和不同作答必须换 ID；迟到事件带真实 occurred_at。上报失败时不能宣称已保存。
- 用户要求撤回旧学习记录或确认此前误报时，使用 maimemo_retract_word_events 按准确 event_ids 撤回本地上报。ID 不明确时先查 maimemo_get_word_review_history，使用 next_cursor 继续翻页定位；不得猜 ID 或为降低权重删除真实错误。撤回后自动重算各时段统计；重复撤回安全，旧上报重试不会恢复，retracted_count 不表示已保存。更正先撤回误报，再用新 ID 上报真实反馈。仅撤回本地上报事件，墨墨官方数据与独立每日快照仍按来源统计。
- 重要程度按上下文报告：用户明确重点学习的词为 important，普通为 normal，冷门或顺带问到的专名为 incidental；不得仅凭大写判定冷门。抽词批内不重复；要下一批时把已抽过的拼写放入 exclude_spellings。
- 本地反馈及今日观察快照自动保存，无需逐次确认，独立于 ALLOW_MUTATIONS；墨墨官方写操作仍须启用并确认。本地数据库按凭据隔离，不保存原始 Token 或聊天全文；更换 Token 暂不合并历史。`;

export function validateStudyFilters(action: string, body: Record<string, any> = {}): void {
  if (!["GetTodayItems", "QueryStudyRecords", "ListVocabulary"].includes(action)) return;
  const idKey = action === "ListVocabulary" ? "ids" : "voc_ids";
  const hasIds = Array.isArray(body[idKey]) && body[idKey].length > 0;
  const hasSpellings = Array.isArray(body.spellings) && body.spellings.length > 0;
  const ignored = action === "GetTodayItems" ? ["is_finished", "is_new"] : action === "QueryStudyRecords" ? ["next_study_date", "tags"] : [];
  const conflicts = ignored.filter(key => body[key] !== undefined);
  if ((hasIds && hasSpellings) || ((hasIds || hasSpellings) && conflicts.length)) {
    throw new ApiError(`Invalid argument combination: ${idKey} and spellings are mutually exclusive; word selectors cannot be combined with ${ignored.join("/") || "each other"}. Use separate calls or filter the returned results locally.`, "INVALID_ARGUMENT_COMBINATION");
  }
}

export const STUDY_TOOLS: Record<string, { name: string; title: string; description: string }> = {
  GetStudyProgress: {
    name: "maimemo_get_study_progress",
    title: "今日学习目标与完成进度",
    description: "获取今日应完成数、已完成数及学习时长（公测）。回答今天学多少或还剩多少必须先调用本工具，以 data.progress.total 为准；不返回具体词表。"
  },
  GetTodayItems: {
    name: "maimemo_get_study_queue_items",
    title: "当前学习／复习队列",
    description: "获取当前学习／复习队列条目（公测），可能包含远多于今日目标的单词。要查待学习条目传 body.is_finished=false。today_items 为历史返回字段名；其长度和 limit 都不代表今日应完成数。今日目标须查询 maimemo_get_study_progress。"
  },
  QueryStudyRecords: {
    name: "maimemo_query_study_records",
    title: "学习计划、记录与复习排期",
    description: "查询学习记录、复习排期和学习计划总量（公测）。body.as_count=true 返回 count；无过滤时为计划总量，有过滤时为匹配记录数。它不是今日学习目标，也不是当前待学习队列。"
  }
};

// Modify only the effective MCP specification, leaving the pinned upstream file intact.
export function applyStudySemantics(spec: Record<string, any>): void {
  const schemas = spec.components.schemas;
  const progress = schemas.StudyProgress;
  progress.description = "今日学习目标、完成进度与学习时长；不提供具体词表。";
  progress.properties.total.description = "今日计划应完成的单词总数，是今日目标的唯一权威字段（source of truth）。不得使用 today_items 长度、队列总量、学习计划 count 或 limit 替代。";
  progress.properties.finished.description = "今日已完成的单词数；今日剩余数为 max(0, total - finished)。";
  schemas.StudyTodayItem.description = "学习／复习队列中的一个单词条目。StudyTodayItem 是历史 schema 名称，不表示属于今日目标词表。";
  schemas.StudyTodayItem.properties.order.description = ORDER_DESCRIPTION;
  schemas.StudyTodayItem.properties.first_response.description = FIRST_RESPONSE_DESCRIPTION;
  schemas.StudyTodayItem.properties.is_new.description = "是否为队列中的新学单词；不表示今日计划内的新词。";
  schemas.StudyTodayItem.properties.is_finished.description = "是否已完成当日学习；可用于筛选队列，不能据此推断今日目标词表。";

  for (const item of Object.values(spec.paths) as any[]) {
    for (const op of Object.values(item) as any[]) {
      const action = op.operationId?.split(".").at(-1);
      const metadata = STUDY_TOOLS[action];
      if (!metadata) continue;
      op.summary = metadata.title + "（公测）";
      op.description = metadata.description + "\n\n" + STUDY_SEMANTICS;
      const response = op.responses["200"].content["application/json"].schema;
      response.description = metadata.description;
      if (action === "GetTodayItems") {
        const body = op.requestBody.content["application/json"].schema;
        body.description = "当前学习队列的筛选和查询上限；这些参数不能确定今日目标。";
        body.properties.is_finished.description = "按当日完成状态筛选队列；false 获取待学习／复习条目，不保证仅包含今日目标内的词。";
        body.properties.is_new.description = "按是否新学单词筛选队列；新学不等于今日计划。";
        body.properties.limit.description = "本次队列查询的返回上限，按学习顺序取前若干条，默认 50、最多 1000。默认值 50 是查询上限，不是每日目标；今日应完成数以 get_study_progress.progress.total 为准。";
        response.properties.today_items.description = "当前学习／复习队列条目，受查询条件和 limit 限制。today_items 是历史 API 字段名，其业务含义不是今日目标词表；数组长度不代表今日应完成数。";
      } else if (action === "QueryStudyRecords") {
        const body = op.requestBody.content["application/json"].schema;
        body.properties.as_count.description = "仅返回匹配学习记录的总数；不加过滤时为学习计划总量，不代表今日目标或队列总量。";
        body.properties.tags.description = "请求筛选目前仅支持单值 STICKING（难记词），不是多值 OR 查询；响应 records.tags 为标签数组。";
        response.properties.count.description = "仅在 body.as_count=true 时有效：无过滤为学习计划总量，有过滤为匹配记录数；不代表今日学习目标或当前队列长度。";
      }
      if (["GetTodayItems", "QueryStudyRecords"].includes(action)) {
        const body = op.requestBody.content["application/json"].schema;
        body.properties.voc_ids.description = "按单词 ID 查询。与 spellings 互斥，不能与状态／日期／标签筛选混用；MCP 会报 INVALID_ARGUMENT_COMBINATION，防止上游静默忽略筛选。";
        body.properties.spellings.description = "按单词拼写查询，最多 1000。与 voc_ids 互斥，不能与状态／日期／标签筛选混用；MCP 会报 INVALID_ARGUMENT_COMBINATION。";
      }
    }
  }
}
