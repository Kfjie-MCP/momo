import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import type { AppConfig } from "./config.js";
import { ApiError } from "./errors.js";
import { validateStudyFilters } from "./study.js";

export type OptionScalar = string | number | boolean;
export type OptionValue = OptionScalar | Array<string | number>;
export type CliOptions = Record<string, OptionValue | undefined>;

export interface MemoCliCall {
  resource: string;
  action: string;
  positionals?: Array<string | number>;
  options?: CliOptions;
  input?: unknown;
  confirmed?: boolean;
}

export interface CliResult {
  stdout: string;
  stderr: string;
  parsed: unknown;
}

const CLI_ENTRY = fileURLToPath(
  new URL("../node_modules/@maimemo/memo-api/dist/index.js", import.meta.url)
);
const MAX_OUTPUT_BYTES = 1024 * 1024;
const RESERVED_OPTIONS = new Set([
  "token",
  "t",
  "output",
  "o",
  "color",
  "verbose",
  "help",
  "version",
  "force",
  "f"
]);

const MUTATIONS = new Set([
  "note:create",
  "note:update",
  "note:delete",
  "interpretation:create",
  "interpretation:update",
  "interpretation:delete",
  "interp:create",
  "interp:update",
  "interp:delete",
  "phrase:create",
  "phrase:update",
  "phrase:delete",
  "notepad:create",
  "notepad:update",
  "notepad:delete",
  "study:add",
  "study:advance"
]);

const DELETIONS = new Set([
  "note:delete",
  "interpretation:delete",
  "interp:delete",
  "phrase:delete",
  "notepad:delete"
]);

function toKebabCase(value: string): string {
  return value
    .replace(/_/g, "-")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase();
}

function validateSegment(value: string, label: string): void {
  if (!/^[a-z][a-z0-9-]*$/i.test(value)) {
    throw new Error(`${label} contains unsupported characters.`);
  }
}

export function isMutation(resource: string, action: string): boolean {
  return MUTATIONS.has(`${resource}:${action}`);
}

export function isDeletion(resource: string, action: string): boolean {
  return DELETIONS.has(`${resource}:${action}`);
}

export function buildCliArgs(call: MemoCliCall, jsonOutput = true): string[] {
  validateSegment(call.resource, "resource");
  validateSegment(call.action, "action");
  if (call.resource === "study" && ["today", "records"].includes(call.action)) {
    const flags = Object.fromEntries(Object.entries(call.options ?? {}).map(([key, value]) => [toKebabCase(key), value]));
    const flag = (...names: string[]) => names.map(name => flags[name]).find(value => value !== undefined);
    const arrayFlag = (...names: string[]) => { const value = flag(...names); return value === undefined ? [] : Array.isArray(value) ? value : [value]; };
    const body = call.input && typeof call.input === "object" ? call.input as Record<string, any> : {
      voc_ids: arrayFlag("voc-id", "v"), spellings: arrayFlag("spelling", "s"),
      ...(call.action === "today" ? { is_finished: flag("finished", "f"), is_new: flag("new", "n") } : {
        ...(flag("next-study-start") !== undefined || flag("next-study-end") !== undefined
          ? { next_study_date: {} } : {})
      })
    };
    validateStudyFilters(call.action === "today" ? "GetTodayItems" : "QueryStudyRecords", body);
  }
  const args = [call.resource, call.action];

  for (const positional of call.positionals ?? []) {
    if (String(positional).startsWith("-")) throw new Error("Positional arguments cannot be CLI flags.");
    args.push(String(positional));
  }

  for (const [rawKey, value] of Object.entries(call.options ?? {})) {
    if (value === undefined) continue;
    validateSegment(rawKey.replaceAll("_", "-"), "option name");
    const key = toKebabCase(rawKey);
    if (RESERVED_OPTIONS.has(key) || key.startsWith("no-")) {
      throw new Error(`Option '${rawKey}' is managed by the server and cannot be supplied.`);
    }

    const flag = `--${key}`;
    if (typeof value === "boolean") {
      args.push(value ? flag : `--no-${key}`);
    } else if (Array.isArray(value)) {
      for (const item of value) args.push(flag, String(item));
    } else {
      args.push(flag, String(value));
    }
  }

  if (isDeletion(call.resource, call.action) && call.confirmed) args.push("-f");
  if (jsonOutput) args.push("-O", "json", "--no-color");
  return args;
}

function parseOutput(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

function redact(value: string, secret: string | undefined): string {
  return secret ? value.split(secret).join("[REDACTED]") : value;
}

async function spawnCli(
  args: string[],
  config: AppConfig,
  input: unknown,
  requireToken: boolean
): Promise<CliResult> {
  if (requireToken && !config.maimemoApiToken) {
    throw new ApiError("MAIMEMO_API_TOKEN is not configured on the server.", "AUTH_REQUIRED");
  }

  return await new Promise<CliResult>((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: {
        ...process.env,
        ...(config.maimemoApiToken
          ? { MAIMEMO_API_TOKEN: config.maimemoApiToken }
          : {})
      },
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => reject(new ApiError(`memo-api timed out after ${config.cliTimeoutMs}ms.`, "TIMEOUT", null, true)));
    }, config.cliTimeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > MAX_OUTPUT_BYTES) child.kill("SIGKILL");
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (Buffer.byteLength(stderr) > MAX_OUTPUT_BYTES) child.kill("SIGKILL");
    });
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (code, signal) => {
      finish(() => {
        const safeStdout = redact(stdout, config.maimemoApiToken);
        const safeStderr = redact(stderr, config.maimemoApiToken);
        if (Buffer.byteLength(stdout) > MAX_OUTPUT_BYTES || Buffer.byteLength(stderr) > MAX_OUTPUT_BYTES) {
          reject(new Error("memo-api output exceeded the 1 MiB safety limit."));
          return;
        }
        if (code !== 0) {
          reject(
            new Error(
              safeStderr.trim() ||
                safeStdout.trim() ||
                `memo-api exited with code ${String(code)}${signal ? ` (${signal})` : ""}.`
            )
          );
          return;
        }
        resolve({ stdout: safeStdout, stderr: safeStderr, parsed: parseOutput(safeStdout) });
      });
    });

    if (input === undefined) child.stdin.end();
    else child.stdin.end(`${JSON.stringify(input)}\n`);
  });
}

export async function runMemoCli(call: MemoCliCall, config: AppConfig): Promise<CliResult> {
  return await spawnCli(buildCliArgs(call), config, call.input, true);
}

export async function runMemoHelp(
  resource: string | undefined,
  action: string | undefined,
  config: AppConfig
): Promise<CliResult> {
  const args: string[] = [];
  if (resource) {
    validateSegment(resource, "resource");
    args.push(resource);
  }
  if (action) {
    validateSegment(action, "action");
    args.push(action);
  }
  args.push("--help", "--no-color");
  return await spawnCli(args, config, undefined, false);
}
