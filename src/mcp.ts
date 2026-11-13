import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerOfficial } from "./official.js";
import { AGENT_GUIDANCE } from "./study.js";
import { registerEnhanced } from "./enhanced.js";
import { registerReview } from "./review.js";
import { ApiError, errorDetailsSchema, toolFailure } from "./errors.js";

import { isMutation, runMemoCli, runMemoHelp } from "./cli.js";
import type { CliOptions } from "./cli.js";
import type { AppConfig } from "./config.js";

const RESOURCES = [
  "voc",
  "vocabulary",
  "note",
  "interp",
  "interpretation",
  "phrase",
  "notepad",
  "study"
] as const;

const optionScalarSchema = z.union([z.string(), z.number(), z.boolean()]);
const optionValueSchema = z.union([
  optionScalarSchema,
  z.array(z.union([z.string(), z.number()]))
]);
const optionsSchema = z.record(z.string(), optionValueSchema).optional();

const READ_ACTIONS = new Set([
  "voc:get",
  "voc:query",
  "vocabulary:get",
  "vocabulary:query",
  "note:list",
  "interp:list",
  "interpretation:list",
  "phrase:list",
  "notepad:list",
  "notepad:get",
  "study:progress",
  "study:today",
  "study:records"
]);

const resultSchema = {
  ok: z.boolean().describe("Whether the operation succeeded."),
  data: z.json().describe("Operation result; null on failure."),
  error: z.string().nullable().describe("Error message on failure; null on success."),
  error_details: errorDetailsSchema.optional().describe("Structured error classification, provided on operation failures; the legacy error string is retained.")
};

function successResult(data: unknown) {
  const structuredContent = { ok: true, data: data ?? null, error: null };
  return { structuredContent, content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }] };
}

function errorResult(error: unknown, secret?: string, mutation = false) {
  return toolFailure(error, secret, mutation);
}

export function createMcpServer(config: AppConfig): McpServer {
  const server = new McpServer({ name: "momo-mcp", version: "0.3.1" }, { instructions: AGENT_GUIDANCE });
  registerOfficial(server, config);
  registerEnhanced(server, config);
  registerReview(server, config);

  server.registerTool(
    "maimemo_status",
    {
      description: "Report server configuration status without exposing credentials.",
      outputSchema: {
        ...resultSchema,
        data: z.object({
          service: z.literal("momo-mcp"),
          maimemoTokenConfigured: z.boolean(),
          authenticationMode: z.enum(["server", "maimemo-token"]),
          endpointAuthConfigured: z.boolean(),
          mutationsEnabled: z.boolean(),
          cliVersion: z.string()
        }).nullable()
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
    },
    async () => successResult(
            {
              service: "momo-mcp",
              maimemoTokenConfigured: Boolean(config.maimemoApiToken),
              authenticationMode: config.authMode,
              endpointAuthConfigured:
                config.authMode === "maimemo-token" || Boolean(config.mcpBearerToken),
              mutationsEnabled: config.allowMutations,
              cliVersion: "@maimemo/memo-api@1.2.0"
            }
    )
  );

  server.registerTool(
    "maimemo_help",
    {
      description:
        "Show official memo-api CLI help for a resource or action. Use this before a call when option names are unclear. Historical study today means the study queue, not the daily target; use maimemo_get_study_progress for today's target.",
      outputSchema: { ...resultSchema, data: z.object({ help: z.string() }).nullable() },
      inputSchema: {
        resource: z.enum(RESOURCES).optional(),
        action: z.string().regex(/^[a-z][a-z0-9-]*$/i).optional()
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
    },
    async ({ resource, action }) => {
      try {
        if (action && !resource) throw new ApiError("resource is required when action is supplied.", "INVALID_ARGUMENT");
        const result = await runMemoHelp(resource, action, config);
        return successResult({ help: result.stdout.trim() });
      } catch (error) {
        return errorResult(error, config.maimemoApiToken);
      }
    }
  );

  server.registerTool(
    "maimemo_read",
    {
      description:
        "Legacy memo-api CLI compatibility. Prefer dedicated maimemo_* API tools with current schemas. Read-only: voc get/query, note/interp/phrase list, notepad list/get, study progress/today/records. Study routing: progress = today's target and progress; today = current study queue (prefer maimemo_get_study_queue_items), NOT today's assigned words; records = study plan/history. Queue length and default limit=50 must not replace progress.total.",
      outputSchema: resultSchema,
      inputSchema: {
        resource: z.enum(RESOURCES),
        action: z.enum(["get", "query", "list", "progress", "today", "records"]),
        positionals: z.array(z.union([z.string(), z.number()])).optional(),
        options: optionsSchema,
        input: z.record(z.string(), z.json()).optional().describe("Optional JSON request body. Consult maimemo_help for the operation schema.")
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
    },
    async ({ resource, action, positionals, options, input }) => {
      try {
        if (!READ_ACTIONS.has(`${resource}:${action}`)) {
          throw new ApiError("This resource/action is not in the read-only allowlist.", "INVALID_ARGUMENT");
        }
        const result = await runMemoCli(
          { resource, action, positionals, options: options as CliOptions | undefined, input },
          config
        );
        return successResult(result.parsed);
      } catch (error) {
        return errorResult(error, config.maimemoApiToken);
      }
    }
  );

  server.registerTool(
    "maimemo_write",
    {
      description:
        "Legacy memo-api CLI compatibility. Prefer dedicated maimemo_* API tools with current schemas. Mutations require server enablement and explicit user confirmation.",
      outputSchema: resultSchema,
      inputSchema: {
        resource: z.enum(RESOURCES),
        action: z.enum(["create", "update", "delete", "add", "advance"]),
        positionals: z.array(z.union([z.string(), z.number()])).optional(),
        options: optionsSchema,
        input: z.record(z.string(), z.json()).optional().describe("Optional JSON request body. Consult maimemo_help for the operation schema."),
        confirm: z.literal(true).describe("Must be true after the user confirms the exact mutation.")
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false }
    },
    async ({ resource, action, positionals, options, input, confirm }) => {
      try {
        if (!config.allowMutations) {
          throw new ApiError("Mutations are disabled. Set ALLOW_MUTATIONS=true on the server.", "MUTATIONS_DISABLED");
        }
        if (!isMutation(resource, action)) {
          throw new ApiError("This resource/action is not in the mutation allowlist.", "INVALID_ARGUMENT");
        }
        const result = await runMemoCli(
          {
            resource,
            action,
            positionals,
            options: options as CliOptions | undefined,
            input,
            confirmed: confirm
          },
          config
        );
        return successResult(result.parsed);
      } catch (error) {
        return errorResult(error, config.maimemoApiToken, true);
      }
    }
  );

  return server;
}
