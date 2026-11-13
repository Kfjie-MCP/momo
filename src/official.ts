import { readFileSync } from "node:fs";
import { parse, stringify } from "yaml";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "./config.js";
import { AGENT_GUIDANCE, applyStudySemantics, STUDY_TOOLS, validateStudyFilters } from "./study.js";
import { ApiError, errorDetailsSchema, httpError, toolFailure, toolSuccess } from "./errors.js";

// The checked-in official specification is the capability inventory, not CLI help.
export const specification = parse(readFileSync(new URL("../reference/api_bundle.yaml", import.meta.url), "utf8"));
export const mcpSpecification = structuredClone(specification);
applyStudySemantics(mcpSpecification);
// Explicit compatibility overrides for observed wire responses. Preserve the
// upstream snapshot unchanged so these deviations remain reviewable.
const wireSchemas = mcpSpecification.components.schemas;
wireSchemas.StudyResponse.enum = [...new Set([...wireSchemas.StudyResponse.enum, "STUDY_RESPONSE_UNSPECIFIED"])];
wireSchemas.StudyRecord.properties.tags = {
  description: "响应标签数组（包括空数组）；不同于请求筛选 body.tags 的单值 STICKING。",
  type: "array", items: { type: "string", enum: ["STUDY_RECORD_TAG_UNSPECIFIED", "STICKING", "WELL_FAMILIAR"] }
};
type Schema = Record<string, any>;
export function resolveSchema(value: any): any {
  if (Array.isArray(value)) return value.map(resolveSchema);
  if (!value || typeof value !== "object") return value;
  if (value.$ref) {
    const target = value.$ref.startsWith("#/components/schemas/")
      ? wireSchemas[value.$ref.split("/").at(-1)]
      : undefined;
    if (!target) throw new Error("Unresolved official schema reference");
    return resolveSchema({ ...value, ...target, description: value.description ?? target.description, $ref: undefined });
  }
  return Object.fromEntries(Object.entries(value)
    .filter(([k, v]) => !["$ref", "example", "xml", "deprecated"].includes(k) && v !== undefined)
    .map(([k, v]) => [k, k === "type" && v === "Object(any)" ? "object" : resolveSchema(v)]));
}
const object = (properties: Schema = {}, required: string[] = []) => ({ type: "object" as const, properties, required, additionalProperties: false });
export const operations = Object.entries(mcpSpecification.paths).flatMap(([path, item]: [string, any]) =>
  Object.entries(item).filter(([, op]: [string, any]) => op.operationId).map(([method, op]: [string, any]) => {
    const action = op.operationId.split(".").at(-1) as string;
    const name = STUDY_TOOLS[action]?.name ?? `${path.includes("/markji/") ? "markji" : "maimemo"}_${action.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase()}`;
    const write = !/^(Get|List|Query)/.test(action);
    const properties: Schema = {};
    const required: string[] = [];
    for (const location of ["path", "query"]) {
      const params = (op.parameters ?? []).filter((p: any) => p.in === location);
      if (params.length) {
        properties[location] = object(Object.fromEntries(params.map((p: any) => [p.name, resolveSchema(p.schema)])), params.filter((p: any) => p.required).map((p: any) => p.name));
        if (properties[location].required.length) required.push(location);
      }
    }
    const body = op.requestBody?.content?.["application/json"]?.schema;
    if (body) { properties.body = resolveSchema(body); required.push("body"); }
    if (action === "AddWords") {
      properties.body.properties.words.items = object({ id: { type: "string", minLength: 1 } }, ["id"]);
      properties.body.properties.words.minItems = 1;
    }
    if (action === "UploadFile") properties.body.properties.file = object({
      filename: { type: "string", minLength: 1, maxLength: 255, pattern: "^[^/\\\\\\r\\n]+$" },
      mime_type: { type: "string", maxLength: 150 },
      content_base64: { type: "string", maxLength: 1000000, pattern: "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$" }
    }, ["filename", "content_base64"]);
    if (write) { properties.confirm = { type: "boolean", const: true, description: "Only set after the user confirms this exact mutation." }; required.push("confirm"); }
    const input = z.fromJSONSchema(object(properties, required)) as z.ZodObject;
    const response = resolveSchema(op.responses?.["200"]?.content?.["application/json"]?.schema ?? { type: "object" });
    const data = z.fromJSONSchema(response);
    // Study routes follow the official CLI and the user-reported successful
    // demo requests. Description and transport share this one effective path.
    const effectivePath = path.replace(/^\/api\/v1\/memo\/study\//, "/api/v1/study/");
    return { name, path: effectivePath, method: method.toUpperCase(), action, write, input, data, summary: op.summary as string,
      description: [op.summary, op.description].filter(Boolean).join("\n") };
  })
);
export type Operation = typeof operations[number];
export const compatibilityToolNames = ["maimemo_get_today_items"];

export async function invokeOfficial(op: Operation, raw: unknown, config: AppConfig, fetcher: typeof fetch = fetch) {
  const args = op.input.parse(raw) as Record<string, any>;
  validateStudyFilters(op.action, args.body);
  if (op.write && !config.allowMutations) throw new ApiError("Mutations are disabled on this server.", "MUTATIONS_DISABLED");
  if (!config.maimemoApiToken) throw new ApiError("MaiMemo access token is required.", "AUTH_REQUIRED");
  const path = op.path.replace(/\{([^}]+)\}/g, (_, key) => {
    const value = args.path?.[key] ?? args.body?.[key];
    if (value === undefined || value === "" || value === "." || value === "..") throw new ApiError(`Invalid path parameter: ${key}`, "INVALID_ARGUMENT");
    return encodeURIComponent(String(value));
  });
  const url = new URL(`https://open.maimemo.com/open${path}`);
  for (const [key, value] of Object.entries(args.query ?? {})) {
    if (Array.isArray(value)) url.searchParams.set(key, value.join(","));
    else if (value !== undefined) url.searchParams.set(key, String(value));
  }
  const headers: Record<string, string> = { Authorization: `Bearer ${config.maimemoApiToken}` };
  let body: BodyInit | undefined;
  if (op.action === "UploadFile") {
    const form = new FormData();
    const file = args.body.file;
    form.append("file", new Blob([Buffer.from(file.content_base64, "base64")], { type: file.mime_type ?? "application/octet-stream" }), file.filename);
    if (args.body.deck_id) form.append("deck_id", args.body.deck_id);
    body = form;
  } else if (args.body) { headers["Content-Type"] = "application/json"; body = JSON.stringify(args.body); }
  // Never forward credentials on redirects; never automatically retry mutations.
  let res: Response;
  try {
    res = await fetcher(url, { method: op.method, headers, body, redirect: "error", signal: AbortSignal.timeout(config.cliTimeoutMs) });
  } catch (error) {
    if (error instanceof TypeError) throw new ApiError(error.message, "NETWORK_ERROR", null, true);
    throw error;
  }
  if (!res.ok) {
    await res.body?.cancel();
    throw httpError(res.status, res.headers.get("retry-after"));
  }
  const chunks: Uint8Array[] = []; let size = 0;
  if (res.body) for await (const chunk of res.body as any) {
    size += chunk.length;
    if (size > 8 * 1024 * 1024) throw new ApiError("Official API response exceeds 8 MiB; use smaller pages.", "RESPONSE_TOO_LARGE", res.status);
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  let json;
  try { json = text ? JSON.parse(text) : {}; }
  catch { throw new ApiError("Official API response is not valid JSON.", "UPSTREAM_SCHEMA_MISMATCH", res.status); }
  if (!json || typeof json !== "object") throw new ApiError("Official API response is not an object.", "UPSTREAM_SCHEMA_MISMATCH", res.status);
  if (json.success === false || json.errors?.length) throw new ApiError("Official API rejected the operation.", "UPSTREAM_REJECTED", res.status);
  const data = json.data ?? json;
  if (!op.data.safeParse(data).success) throw new ApiError(`Official API response does not match its published schema.${op.write ? " The mutation may already have succeeded; check state before retrying." : ""}`, "UPSTREAM_SCHEMA_MISMATCH", res.status);
  return data;
}

export function registerOfficial(server: McpServer, config: AppConfig) {
  for (const op of operations) {
    const names = op.action === "GetTodayItems" ? [op.name, ...compatibilityToolNames] : [op.name];
    for (const name of names) server.registerTool(name, {
      title: name === op.name ? STUDY_TOOLS[op.action]?.title : "学习队列（历史工具名，建议使用 maimemo_get_study_queue_items）",
      description: `${name === op.name ? "" : "历史兼容别名：get_today_items 实际查询当前学习队列，优先使用 maimemo_get_study_queue_items。\n"}${op.description}. Official ${op.method} ${op.path}.${op.write ? " Requires explicit user confirmation." : ""}`,
      inputSchema: op.input,
      outputSchema: z.object({ ok: z.boolean(), data: op.data.nullable(), error: z.string().nullable(), error_details: errorDetailsSchema.optional() }),
      annotations: { readOnlyHint: !op.write, destructiveHint: op.write, idempotentHint: !op.write, openWorldHint: true }
    }, async (args) => {
      try {
        return toolSuccess(await invokeOfficial(op, args, config));
      } catch (error) {
        return toolFailure(error, config.maimemoApiToken, op.write);
      }
    });
  }
  const documents: Record<string, URL> = {
    openapi: new URL("../reference/api_bundle.yaml", import.meta.url),
    "memo-api": new URL("../upstream-skills/memo-api/SKILL.md", import.meta.url),
    "markji-card-syntax": new URL("../upstream-skills/markji-card-syntax/references/markji-card-syntax.md", import.meta.url)
  };
  for (const name of ["vocabulary", "notes", "interpretations", "phrases", "notepads", "study"]) {
    documents[name] = new URL(`../upstream-skills/memo-api/references/${name}-api.md`, import.meta.url);
  }
  const readDocument = (name: string): string => name === "openapi"
    ? `# Effective MCP specification with study semantics and wire compatibility overrides.\n${stringify(mcpSpecification)}`
    : readFileSync(documents[name]!, "utf8");
  for (const name of Object.keys(documents)) server.registerResource(name, `maimemo://docs/${name}`, { mimeType: "text/plain" }, async (uri) => ({ contents: [{ uri: uri.href, text: readDocument(name) }] }));
  server.registerTool("maimemo_documentation", {
    description: "Read API or memo-skills documentation, including Markji card grammar. openapi includes explicit MCP study semantics and compatibility overrides; the pinned upstream snapshot is preserved on disk. Current tool schemas take precedence over older CLI names and examples.",
    inputSchema: { document: z.enum(Object.keys(documents) as [string, ...string[]]) },
    outputSchema: { text: z.string() }, annotations: { readOnlyHint: true, openWorldHint: false }
  }, async ({ document }) => { const text = readDocument(document); return { structuredContent: { text }, content: [{ type: "text", text }] }; });
  server.registerPrompt("maimemo_workflow", {
    description: "Plan vocabulary, today's review, explicit long-term review, local feedback and retraction, and content workflows.",
    argsSchema: { task: z.string() }
  }, ({ task }) => ({ messages: [{ role: "user", content: { type: "text", text: `${AGENT_GUIDANCE}\n\n${readDocument("memo-api")}\n\nUse the dedicated MCP tools and their current schemas rather than old curl paths. Default review requests to today's review; long-term review requires an explicit historical scope. Report actual user word questions and quiz responses locally before completing the turn. Ask for confirmation before official MaiMemo/Markji mutations; local review events and observation snapshots are automatically saved without per-event confirmation. Do not claim pagination is exhaustive without checking boundary ties.\n\nTask: ${task}` } }] }));
  server.registerPrompt("markji_cards", {
    description: "Create or revise Markji card text following the official syntax guide; saving requires separate confirmation.",
    argsSchema: { task: z.string() }
  }, ({ task }) => ({ messages: [{ role: "user", content: { type: "text", text: `${readFileSync(new URL("../upstream-skills/markji-card-syntax/SKILL.md", import.meta.url), "utf8")}\n\n${readFileSync(documents["markji-card-syntax"]!, "utf8")}\n\nTask: ${task}\nDo not save or update cards without explicit user confirmation.` } }] }));
}
