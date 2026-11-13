import { createHmac, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { ApiError } from "./errors.js";

export const REVIEW_TIMEZONE = "Asia/Shanghai";
export const eventKinds = ["lookup", "mnemonic", "comparison", "confusion", "incorrect", "correct"] as const;
export const importanceKinds = ["important", "normal", "incidental"] as const;
export type EventKind = typeof eventKinds[number];
export type Importance = typeof importanceKinds[number];
export type Counts = Record<EventKind, number>;
export const eventPoints: Counts = { lookup: 1, mnemonic: 3, comparison: 4, confusion: 5, incorrect: 4, correct: 0 };
export const importanceMultipliers: Record<Importance, number> = { important: 1.5, normal: 1, incidental: 0.2 };
export const validResponses = ["FAMILIAR", "VAGUE", "FORGET", "WELL_FAMILIAR", "CANCEL_WELL_FAMILIAR"] as const;

export function studyDate(timestamp: number | string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: REVIEW_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date(timestamp));
}
export const normalizeSpelling = (spelling: string) => spelling.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
export const daysBetween = (later: string, earlier: string) => (Date.parse(later) - Date.parse(earlier)) / 86_400_000;
export const masteryMultiplier = (streak: number) => 1 / (1 + 0.5 * Math.min(streak, 3));
const emptyCounts = (): Counts => ({ lookup: 0, mnemonic: 0, comparison: 0, confusion: 0, incorrect: 0, correct: 0 });
const isDifficulty = (kind: EventKind) => kind !== "lookup" && kind !== "correct";
export const responsePoints = (response: string | null) => response === "FORGET" ? 6 : response === "VAGUE" ? 3 : 0;

export interface ReportEvent {
  event_id: string;
  spelling: string;
  voc_id?: string;
  kind: EventKind;
  importance?: Importance;
  occurred_at?: string;
}
interface StoredEvent extends ReportEvent {
  word_key: string;
  occurred_at: string;
  study_date: string;
  sequence: number;
}
interface Snapshot {
  word_key: string;
  spelling: string;
  voc_id: string;
  study_date: string;
  response: string;
  observed_at: string;
}
export interface DailyStats {
  study_date: string;
  spelling: string;
  voc_id: string | null;
  counts: Counts;
  ai_error_rate: number | null;
  first_response_today: string | null;
  positive_score: number;
  correct_streak: number;
  importance: Importance;
  first_seen_at: string;
  last_seen_at: string;
  last_difficulty_at: string | null;
  last_answer_at: string | null;
}
export interface WordStats {
  spelling: string;
  voc_id: string | null;
  counts: Counts;
  ai_error_rate: number | null;
  observed_days: number;
  difficult_days: number;
  app_forget_days: number;
  app_vague_days: number;
  app_familiar_days: number;
  correct_streak: number;
  importance: Importance;
  first_seen_at: string;
  last_seen_at: string;
  last_difficulty_at: string | null;
  last_answer_at: string | null;
  anchor_date: string;
  decayed_daily_score: number;
  recent_difficult_dates: string[];
}
const errorRate = (counts: Counts) => counts.correct + counts.incorrect ? counts.incorrect / (counts.correct + counts.incorrect) : null;

// Derive summaries from the deduplicated observations. Replaying one word makes
// late reports and corrected upstream snapshots behave exactly like timely ones.
function summarize(events: StoredEvent[], snapshots: Snapshot[]) {
  const days = new Map<string, DailyStats>();
  const timeline = [
    ...events.map(event => ({ date: event.study_date, at: event.occurred_at, sequence: event.sequence,
      spelling: event.spelling, voc_id: event.voc_id, kind: event.kind, importance: event.importance, response: null as string | null })),
    ...snapshots.map(snapshot => ({ date: snapshot.study_date, at: snapshot.observed_at, sequence: -1,
      spelling: snapshot.spelling, voc_id: snapshot.voc_id, kind: null, importance: undefined, response: snapshot.response }))
  ].sort((a, b) => a.at.localeCompare(b.at) || a.sequence - b.sequence);
  let streak = 0;
  let importance: Importance = "normal";
  let lastDifficulty: string | null = null;
  let lastAnswer: string | null = null;
  for (const item of timeline) {
    let day = days.get(item.date);
    if (!day) {
      day = { study_date: item.date, spelling: item.spelling, voc_id: item.voc_id ?? null, counts: emptyCounts(),
        ai_error_rate: null, first_response_today: null, positive_score: 0, correct_streak: 0, importance: "normal",
        first_seen_at: item.at, last_seen_at: item.at, last_difficulty_at: null, last_answer_at: null };
      days.set(item.date, day);
    }
    day.spelling = item.spelling;
    day.voc_id = item.voc_id ?? day.voc_id;
    day.last_seen_at = item.at;
    if (item.importance) { day.importance = item.importance; importance = item.importance; }
    if (item.kind) day.counts[item.kind]++;
    else day.first_response_today = item.response;
    const difficulty = item.kind ? isDifficulty(item.kind) : responsePoints(item.response) > 0;
    if (difficulty) {
      streak = 0;
      day.correct_streak = 0;
      day.last_difficulty_at = lastDifficulty = item.at;
    } else if (item.kind === "correct") {
      streak++;
      day.correct_streak++;
    }
    if (item.kind === "correct" || item.kind === "incorrect") day.last_answer_at = lastAnswer = item.at;
  }
  const daily = [...days.values()].sort((a, b) => a.study_date.localeCompare(b.study_date));
  if (!daily.length) return null;
  const counts = emptyCounts();
  for (const day of daily) {
    for (const kind of eventKinds) counts[kind] += day.counts[kind];
    day.ai_error_rate = errorRate(day.counts);
    day.positive_score = Math.min(12, eventKinds.reduce((sum, kind) => sum + eventPoints[kind] * day.counts[kind], 0))
      + responsePoints(day.first_response_today);
  }
  const difficultDates = daily.filter(day => day.last_difficulty_at !== null).map(day => day.study_date);
  const last = daily.at(-1)!;
  const latest = timeline.at(-1)!;
  const word: WordStats = { spelling: latest.spelling, voc_id: [...timeline].reverse().find(item => item.voc_id)?.voc_id ?? null,
    counts, ai_error_rate: errorRate(counts), observed_days: daily.length, difficult_days: difficultDates.length,
    app_forget_days: daily.filter(day => day.first_response_today === "FORGET").length,
    app_vague_days: daily.filter(day => day.first_response_today === "VAGUE").length,
    app_familiar_days: daily.filter(day => ["FAMILIAR", "WELL_FAMILIAR"].includes(day.first_response_today ?? "")).length,
    correct_streak: streak, importance, first_seen_at: timeline[0]!.at, last_seen_at: latest.at,
    last_difficulty_at: lastDifficulty, last_answer_at: lastAnswer, anchor_date: last.study_date,
    decayed_daily_score: daily.reduce((sum, day) => sum + day.positive_score * 2 ** (-daysBetween(last.study_date, day.study_date) / 30), 0),
    recent_difficult_dates: difficultDates.filter(date => daysBetween(last.study_date, date) < 90) };
  return { daily, word };
}

export class ReviewStore {
  private readonly db: DatabaseSync;
  private readonly salt: string;

  constructor(path: string) {
    let database: DatabaseSync | undefined;
    try {
      if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      database = new DatabaseSync(path);
      this.db = database;
      if (path !== ":memory:") chmodSync(path, 0o600);
      this.db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;");
      this.migrate();
      this.salt = (this.db.prepare("SELECT value FROM review_meta WHERE key='namespace_salt'").get() as { value: string }).value;
    } catch {
      database?.close();
      throw new ApiError("本地复习数据库无法打开或迁移；原有记录未被清空。", "LOCAL_STORAGE_ERROR");
    }
  }

  private migrate() {
    const version = (this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    if (version > 3) throw new Error("Unsupported review database version");
    if (version === 0) this.transaction(() => {
      this.db.exec(`
        CREATE TABLE review_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE review_events (
          namespace TEXT NOT NULL, event_id TEXT NOT NULL, word_key TEXT NOT NULL, spelling TEXT NOT NULL,
          voc_id TEXT, kind TEXT NOT NULL, importance TEXT, occurred_at TEXT NOT NULL, study_date TEXT NOT NULL,
          fingerprint TEXT NOT NULL, PRIMARY KEY (namespace, event_id));
        CREATE INDEX review_events_word ON review_events(namespace, word_key, occurred_at);
        CREATE TABLE review_snapshots (
          namespace TEXT NOT NULL, study_date TEXT NOT NULL, word_key TEXT NOT NULL, spelling TEXT NOT NULL,
          voc_id TEXT NOT NULL, response TEXT NOT NULL, observed_at TEXT NOT NULL,
          PRIMARY KEY(namespace, study_date, word_key));
        CREATE INDEX review_snapshots_word ON review_snapshots(namespace, word_key);
        CREATE TABLE review_daily (
          namespace TEXT NOT NULL, study_date TEXT NOT NULL, word_key TEXT NOT NULL, data TEXT NOT NULL,
          PRIMARY KEY(namespace, study_date, word_key));
        PRAGMA user_version=1;
      `);
      this.db.prepare("INSERT INTO review_meta VALUES ('namespace_salt', ?)").run(randomBytes(32).toString("hex"));
    });
    if (version < 2) this.transaction(() => {
      this.db.exec("CREATE TABLE review_words (namespace TEXT NOT NULL, word_key TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(namespace, word_key));");
      const words = this.db.prepare("SELECT namespace, word_key FROM review_events UNION SELECT namespace, word_key FROM review_snapshots").all() as { namespace: string; word_key: string }[];
      for (const word of words) this.rebuild(word.namespace, word.word_key);
      this.db.exec("PRAGMA user_version=2;");
    });
    if (version < 3) this.transaction(() => {
      this.db.exec(`
        CREATE TABLE review_retractions (
          namespace TEXT NOT NULL, event_id TEXT NOT NULL, fingerprint TEXT NOT NULL, retracted_at TEXT NOT NULL,
          PRIMARY KEY(namespace, event_id));
        DROP INDEX review_events_word;
        CREATE INDEX review_events_word ON review_events(namespace, word_key, occurred_at, event_id);
        PRAGMA user_version=3;
      `);
    });
  }

  private safely<T>(fn: () => T): T {
    try { return fn(); }
    catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError("本地复习记录读写失败；未确认保存或撤回的操作请使用原事件 ID 重试。", "LOCAL_STORAGE_ERROR");
    }
  }

  private transaction<T>(fn: () => T): T {
    return this.safely(() => {
      this.db.exec("BEGIN IMMEDIATE");
      try { const result = fn(); this.db.exec("COMMIT"); return result; }
      catch (error) { this.db.exec("ROLLBACK"); throw error; }
    });
  }

  namespace(token: string) { return createHmac("sha256", this.salt).update(token).digest("hex"); }

  private rebuild(namespace: string, key: string) {
    const events = this.db.prepare("SELECT *, rowid AS sequence FROM review_events WHERE namespace=? AND word_key=? ORDER BY occurred_at, rowid")
      .all(namespace, key) as unknown as StoredEvent[];
    const snapshots = this.db.prepare("SELECT * FROM review_snapshots WHERE namespace=? AND word_key=?").all(namespace, key) as unknown as Snapshot[];
    const data = summarize(events, snapshots);
    this.db.prepare("DELETE FROM review_daily WHERE namespace=? AND word_key=?").run(namespace, key);
    if (!data) {
      this.db.prepare("DELETE FROM review_words WHERE namespace=? AND word_key=?").run(namespace, key);
      return;
    }
    const insert = this.db.prepare("INSERT INTO review_daily VALUES (?, ?, ?, ?)");
    for (const day of data.daily) insert.run(namespace, day.study_date, key, JSON.stringify(day));
    this.db.prepare("INSERT OR REPLACE INTO review_words VALUES (?, ?, ?)").run(namespace, key, JSON.stringify(data.word));
  }

  report(namespace: string, events: ReportEvent[], now: number) {
    return this.transaction(() => {
      let accepted = 0;
      let retracted = 0;
      const retractedIds = new Set<string>();
      const changed = new Set<string>();
      const dates = new Set<string>();
      for (const event of events) {
        const key = normalizeSpelling(event.spelling);
        const occurred = event.occurred_at ? new Date(event.occurred_at).toISOString() : new Date(now).toISOString();
        const date = studyDate(occurred);
        const fingerprint = createHash("sha256").update(JSON.stringify({ spelling: key, voc_id: event.voc_id ?? null,
          kind: event.kind, importance: event.importance ?? null, occurred_at: event.occurred_at ? occurred : null })).digest("hex");
        const withdrawn = this.db.prepare("SELECT fingerprint FROM review_retractions WHERE namespace=? AND event_id=?")
          .get(namespace, event.event_id) as { fingerprint: string } | undefined;
        if (withdrawn) {
          if (withdrawn.fingerprint !== fingerprint) throw new ApiError("该 event_id 已撤回；更正后的反馈必须使用新 ID。", "INVALID_ARGUMENT");
          retracted++;
          retractedIds.add(event.event_id);
          continue;
        }
        const old = this.db.prepare("SELECT fingerprint FROM review_events WHERE namespace=? AND event_id=?").get(namespace, event.event_id) as { fingerprint: string } | undefined;
        if (old) {
          if (old.fingerprint !== fingerprint) throw new ApiError("同一 event_id 不能用于不同反馈；请为新的提问或作答生成新 ID。", "INVALID_ARGUMENT");
          continue;
        }
        this.db.prepare("INSERT INTO review_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .run(namespace, event.event_id, key, event.spelling.trim(), event.voc_id ?? null, event.kind, event.importance ?? null, occurred, date, fingerprint);
        accepted++;
        changed.add(key);
        dates.add(date);
      }
      for (const key of changed) this.rebuild(namespace, key);
      return { accepted_count: accepted, duplicate_count: events.length - accepted - retracted,
        retracted_count: retracted, retracted_event_ids: [...retractedIds], study_dates: [...dates].sort() };
    });
  }

  retract(namespace: string, eventIds: string[], now: number) {
    return this.transaction(() => {
      const ids = [...new Set(eventIds)];
      const removed: string[] = [], alreadyRemoved: string[] = [], missing: string[] = [];
      const changed = new Set<string>();
      const dates = new Set<string>();
      const retractedAt = new Date(now).toISOString();
      for (const id of ids) {
        const row = this.db.prepare("SELECT word_key, study_date, fingerprint FROM review_events WHERE namespace=? AND event_id=?")
          .get(namespace, id) as { word_key: string; study_date: string; fingerprint: string } | undefined;
        if (!row) {
          const withdrawn = this.db.prepare("SELECT 1 FROM review_retractions WHERE namespace=? AND event_id=?").get(namespace, id);
          (withdrawn ? alreadyRemoved : missing).push(id);
          continue;
        }
        // Retain only the deduplication marker, not the withdrawn word or answer.
        this.db.prepare("INSERT INTO review_retractions VALUES (?, ?, ?, ?)").run(namespace, id, row.fingerprint, retractedAt);
        this.db.prepare("DELETE FROM review_events WHERE namespace=? AND event_id=?").run(namespace, id);
        removed.push(id);
        changed.add(row.word_key);
        dates.add(row.study_date);
      }
      for (const key of changed) this.rebuild(namespace, key);
      return { requested_count: ids.length, retracted_count: removed.length, already_retracted_count: alreadyRemoved.length,
        not_found_count: missing.length, retracted_event_ids: removed, already_retracted_event_ids: alreadyRemoved,
        not_found_event_ids: missing, study_dates: [...dates].sort() };
    });
  }

  observe(namespace: string, date: string, items: { voc_id: string; voc_spelling: string; first_response?: string }[], now: number) {
    this.transaction(() => {
      const changed = new Set<string>();
      for (const item of items) {
        if (!validResponses.includes(item.first_response as typeof validResponses[number])) continue;
        const key = normalizeSpelling(item.voc_spelling);
        const old = this.db.prepare("SELECT response FROM review_snapshots WHERE namespace=? AND study_date=? AND word_key=?")
          .get(namespace, date, key) as { response: string } | undefined;
        if (old?.response === item.first_response) continue;
        this.db.prepare("INSERT OR REPLACE INTO review_snapshots VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run(namespace, date, key, item.voc_spelling, item.voc_id, item.first_response!, new Date(now).toISOString());
        changed.add(key);
      }
      for (const key of changed) this.rebuild(namespace, key);
    });
  }

  daily(namespace: string, date: string): DailyStats[] {
    return this.safely(() => this.db.prepare("SELECT data FROM review_daily WHERE namespace=? AND study_date=? ORDER BY word_key")
      .all(namespace, date).map(row => JSON.parse(row.data as string) as DailyStats));
  }

  words(namespace: string): WordStats[] {
    return this.safely(() => this.db.prepare("SELECT data FROM review_words WHERE namespace=? ORDER BY word_key")
      .all(namespace).map(row => JSON.parse(row.data as string) as WordStats));
  }

  private historyCursor(namespace: string, key: string, event: { occurred_at: string; event_id: string }) {
    const payload = Buffer.from(JSON.stringify({ version: 1, ...event })).toString("base64url");
    const signature = createHmac("sha256", this.salt).update(JSON.stringify([namespace, key, payload])).digest("base64url");
    return `${payload}.${signature}`;
  }

  private parseHistoryCursor(namespace: string, key: string, cursor: string) {
    try {
      if (cursor.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
      const [payload, signature] = cursor.split(".") as [string, string];
      const expected = createHmac("sha256", this.salt).update(JSON.stringify([namespace, key, payload])).digest();
      const provided = Buffer.from(signature, "base64url");
      if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) throw new Error();
      const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
      if (parsed.version !== 1 || typeof parsed.occurred_at !== "string" ||
        !Number.isFinite(Date.parse(parsed.occurred_at)) || typeof parsed.event_id !== "string" ||
        !parsed.event_id.length || parsed.event_id.length > 128) throw new Error();
      return { occurred_at: parsed.occurred_at, event_id: parsed.event_id };
    } catch { throw new ApiError("历史游标无效；请使用同一账户、同一单词返回的 next_cursor。", "INVALID_ARGUMENT"); }
  }

  history(namespace: string, spelling: string, date: string, limit: number, cursor?: string) {
    return this.safely(() => {
      const key = normalizeSpelling(spelling);
      const before = cursor ? this.parseHistoryCursor(namespace, key, cursor) : null;
      const row = this.db.prepare("SELECT data FROM review_words WHERE namespace=? AND word_key=?").get(namespace, key);
      const allTime = row ? JSON.parse(row.data as string) as WordStats : null;
      const daily = this.db.prepare("SELECT data FROM review_daily WHERE namespace=? AND word_key=? AND study_date<=? ORDER BY study_date")
        .all(namespace, key, date).map(row => JSON.parse(row.data as string) as DailyStats);
      const recent = daily.filter(day => daysBetween(date, day.study_date) < 30);
      const counts = emptyCounts();
      for (const day of recent) for (const kind of eventKinds) counts[kind] += day.counts[kind];
      const select = "SELECT event_id, spelling, voc_id, kind, importance, occurred_at, study_date FROM review_events WHERE namespace=? AND word_key=?";
      const order = " ORDER BY occurred_at DESC, event_id DESC LIMIT ?";
      const events = before
        ? this.db.prepare(`${select} AND (occurred_at, event_id) < (?, ?)${order}`)
          .all(namespace, key, before.occurred_at, before.event_id, limit + 1)
        : this.db.prepare(`${select}${order}`).all(namespace, key, limit + 1);
      const page = events.slice(0, limit);
      const hasMore = events.length > limit;
      return { today: daily.find(day => day.study_date === date) ?? null,
        last_30_days: { counts, ai_error_rate: errorRate(counts), observed_days: recent.length,
          difficult_days: recent.filter(day => day.last_difficulty_at !== null).length,
          app_forget_days: recent.filter(day => day.first_response_today === "FORGET").length,
          app_vague_days: recent.filter(day => day.first_response_today === "VAGUE").length },
        all_time: allTime, recent_events: page, events_truncated: hasMore,
        next_cursor: hasMore ? this.historyCursor(namespace, key, { occurred_at: page.at(-1)!.occurred_at as string,
          event_id: page.at(-1)!.event_id as string }) : null };
    });
  }

  close() { this.db.close(); }
}

const stores = new Map<string, ReviewStore>();
export function getReviewStore(path = join(homedir(), ".local", "state", "momo-mcp", "review.sqlite")) {
  let store = stores.get(path);
  if (!store) { store = new ReviewStore(path); stores.set(path, store); }
  return store;
}
export function closeReviewStores() {
  for (const store of stores.values()) store.close();
  stores.clear();
}
