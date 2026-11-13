# 今日复习与长期追踪

普通“今天的易错词”“高频错的再复习一遍”“复习一下”默认使用今日入口。只有明确要求长期、历史、累计或全部记录中的易错词时，才用长期入口；明确问某词过去是否经常错或需要定位误报时使用历史查询。五个工具共用数据库，但今日计算不读取长期汇总。

## 今日抽词

```json
{"name":"maimemo_get_today_review_words","arguments":{"mode":"focus","limit":20}}
```

`focus` 合并北京时间当天主动问词、AI 实际作答和墨墨首次忘记／模糊反馈。完成当日学习目标后仍可复习这些困难词。没有相关信号时返回空列表，不推断全部单词已掌握。

`remaining` 内部读取今日进度，按 `max(0, total - finished)` 限制建议批次的数量。从未完成队列的上游数组顺序取候选，再随机抽取；不是 App 确认的今日安排。今日剩余为零时为空，进度失败时返回错误，不用队列长度猜测。

两个模式都支持 `exclude_spellings`，再次抽取时传入前一批拼写，避免重复。默认 limit=20，范围 1–1000；候选不足时返回实际数量。结果带 `scope=today`、`study_date`、`time_zone=Asia/Shanghai`、`word_list_semantics`、`progress`、`items`、`candidate_count`、`returned_count`、`upstream_requests`、`partial` 和 `source_completeness`。

复习接口的 progress 只返回 total、finished、remaining，不返回学习时长。权重不使用累计学习时长、单词停留时间或回答速度，避免挂机和不同学习节奏影响推荐。事件发生时间只用于日期归属、先后顺序和历史衰减。

上游读取为进度与队列两个批量请求，不逐词查详情。队列最多 1000 条，达到上限则完整性 unknown。暂时性故障允许重点复习返回本地今日结果并标记缺失；认证失败直接报错。本地库失败时可以保留上游今日结果，标明 local=unavailable。日期在读取过程中切换时要求重新查询。

## AI 及时上报

```json
{"name":"maimemo_report_word_events","arguments":{"events":[{"event_id":"turn-17-apple-mnemonic","spelling":"apple","kind":"mnemonic","importance":"normal"},{"event_id":"quiz-8-apple-answer","spelling":"apple","kind":"incorrect"}]}}
```

用户主动查词、怎么背、对比或易混讲解完成后，以及收到实际复习答案后，本轮及时上报。不要等整场复习结束，也不要记录 AI 自己列出的所有词。对比问题只记录用户实际关注的词。同一问题选最贴切的一种类型，不能同时堆叠多种问题加分。

| kind | 含义 | 基础分 |
| --- | --- | --- |
| lookup | 主动查词 | 1 |
| mnemonic | 怎么背、记忆方法 | 3 |
| comparison | 词义对比 | 4 |
| confusion | 明确表示易混 | 5 |
| incorrect | 实际且可判断的答错 | 4 |
| correct | 实际且可判断的答对 | 0，降低后续权重 |

每条 event_id 是真实事件的唯一 ID，重试复用，新问题和新作答使用新 ID。一次最多 100 条。同 ID 同内容不重复计数；同 ID 不同内容报错并回滚整批。voc_id 可省略。occurred_at 可传带时区的 ISO 时间，缺省为接收时间，不接受未来时间；迟到反馈必须带真实发生时间，按发生日期入账并重算顺序。

提问与实际答错分别计数，未评分的答案不报 correct/incorrect。AI 错率为 incorrect/(correct+incorrect)，没有实际作答时为 null。保存失败不能告诉用户已保存；使用原 ID 重试安全。

上报返回 accepted_count（新增）、duplicate_count（已存在）和 retracted_count（已撤回，未恢复），三项相加等于输入条数。已撤回的 ID 列在 retracted_event_ids 中，不能告诉用户它们已保存。更正后的反馈须使用新 ID。

## 撤回误报与旧记录

```json
{"name":"maimemo_retract_word_events","arguments":{"event_ids":["quiz-8-apple-answer"]}}
```

用户要求撤回记录或确认此前上报有误时，按准确 event_id 撤回，支持任意日期的本地上报事件。ID 来自原上报或历史查询的 recent_events；记录超过一页时沿 next_cursor 翻页，不猜 ID，也不为降低推荐权重撤回真实答错。

一次提交 1–100 个 ID，重复 ID 只处理一次。返回 requested_count、retracted_count、already_retracted_count、not_found_count，以及各类对应的 event_ids 和受影响的 study_dates。未找到的 ID 不会预先封禁；其他账户的 ID 与不存在的 ID 同样返回未找到。重复撤回安全；失败可复用原 ID 重试，数据库事务确保撤回和统计重算一起提交或回滚。

撤回后重放受影响词的剩余事件与快照，修正今日、近 30 天、累计次数、错率、困难天数、重要程度、连续答对状态和长期推荐权重。旧日期的撤回不改变当天权重；最后一条观察被移除时清理每日／长期汇总，不残留推荐候选。撤回仅作用于 AI 本地上报事件，墨墨官方学习记录与独立观察到的每日首次反馈仍按各自来源统计。

撤回会删除事件正文，保留当前账户的 event_id、内容指纹和撤回时间作为去重标记。相同旧上报再次提交会返回 retracted_count，不重新记入统计；同 ID 换内容报错。更正流程为先撤回误报，再使用新 ID 上报真实反馈，迟到的更正仍带真实 occurred_at。无需对已明确要求的本地撤回再传 confirm，独立于 ALLOW_MUTATIONS。

## 权重与随机

今日本地基础分累计封顶 12，墨墨当天首次 FORGET 加 6、VAGUE 加 3。缺省或未指定反馈不加分。每词同天只有一份墨墨快照，重复读取不增加次数；有效反馈变化时替换该日快照。

`importance` 可标记 important（用户明确重点学习，倍率 1.5）、normal（普通，1）、incidental（冷门或顺带询问，0.2）。不凭大写认定冷门专名。未明确标记时为普通，当天的重要程度与当天反馈共同计算。

连续答对按 `1/(1+0.5×min(连续答对次数,3))` 降权，新的记忆方法、对比、明确混淆、答错或新观察到的忘记／模糊反馈重置连续答对状态。今日连续状态只看当天，隔天重算。

每次抽取以 80% 概率按分数加权、20% 概率均匀探索，抽中即从本批候选移除；所有分数为零时均匀抽取。分数仅为推荐权重，不是统计错率。

## 长期复习与历史

```json
{"name":"maimemo_get_long_term_review_words","arguments":{"limit":20}}
```

本地历史候选与墨墨 STICKING 难记词批量合并。上游单次最多 1000 个；达到上限说明来源未确认取全。难记标签增加候选权重，但不伪造历史答错次数、错误比例或困难天数。暂时性上游故障可返回本地历史并标明来源缺失。

长期分数由以下部分组成，再乘重要程度与连续答对降权：

- 每日基础困难分按 30 天半衰期衰减后累计，封顶 24。
- 近 90 天每个困难日加 2 分，最多加 10；普通查词不单独算困难日。
- 当前墨墨难记标签加 4。
- incidental 最终长期分数封顶 2。

实际事件计数不封顶、不衰减，只有推荐分数衰减。跨天困难与单日大量重复分别处理。连续答对降低后续概率，但不删除历史；没有新反馈不等于已经掌握。

```json
{"name":"maimemo_get_word_review_history","arguments":{"spelling":"apple","recent_events_limit":20}}
```

返回 today、last_30_days、all_time 和按时间倒序的 recent_events，每条事件含可用于撤回的 event_id。默认每页 20 条、最多 100 条；events_truncated=true 表示还有更早事件，将 next_cursor 作为下次的 cursor，并保持同一账户和拼写，即可继续查询。最后一页 next_cursor=null。翻页不改变统计范围；已撤回事件不出现在列表中。

游标按发生时间和事件 ID 定位并绑定账户及规范化拼写，同时间事件不会重复或漏掉。翻页时不采用易受撤回影响的 offset；对应事件被撤回或服务重启后游标仍可使用。翻页期间新增的更晚事件需从第一页查看。提问、AI 作答、困难天数和观察到的墨墨首次忘记／模糊天数分别统计。ai_error_rate 是 0–1 的比例。

历史从接入开始积累，只覆盖实际上报与成功观察的数据，不是 App 全部学习历史。墨墨日反馈仅在成功查询今日词表时观察；没有定时后台抓取。自动上报依赖 AI 遵循指引，服务不能直接读取纯聊天内容。

## 本地库与认证

需要 Node 24。SQLite 默认放在 systemd 的 StateDirectory 中，本部署为 `/var/lib/momo-mcp/review.sqlite`；本地遵循 XDG_STATE_HOME，缺省为 `~/.local/state/momo-mcp/review.sqlite`。可用 LOCAL_REVIEW_DB_PATH 覆盖。库文件权限 0600，使用 WAL 和事务；启动时迁移，版本 1 会补建长期汇总，版本 1／2 均会迁移至版本 3，增加撤回去重标记与历史索引，保留原事件、快照及账户隔离。

本地写入独立于 ALLOW_MUTATIONS，不需要逐次 confirm，不修改官方学习排期或词本。官方写操作仍需原有确认。按带本地随机盐的凭据指纹隔离，不保存原始 Token、聊天全文或答案内容；更换 Token 暂不合并历史。复习库长期保留最小观察记录，便于长期复习；本地上报事件可通过撤回接口移除，最小去重标记保留。整库清理或清理独立快照需联系部署维护者。

请求 Token 模式首次调用本地能力时通过一次批量词汇查询验证凭据，成功认证缓存 15 分钟，同一凭据并发首次认证合并；缓存有效时上报只写本地。今日或长期查询的成功官方响应也可验证凭据。认证失败不会降级返回本地学习数据。
