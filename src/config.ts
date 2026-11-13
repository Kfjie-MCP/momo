import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface AppConfig {
  host: string;
  port: number;
  mcpPath: string;
  allowedHosts: string[] | undefined;
  maimemoApiToken: string | undefined;
  mcpBearerToken: string | undefined;
  authMode: "server" | "maimemo-token";
  allowMutations: boolean;
  cliTimeoutMs: number;
  localReviewDbPath?: string;
}

function parseInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  if (["1", "true", "yes", "on"].includes(value.toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(value.toLowerCase())) return false;
  throw new Error(`Invalid boolean value: ${value}`);
}

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function readSecret(
  env: NodeJS.ProcessEnv,
  valueName: string,
  fileName: string
): string | undefined {
  const directValue = env[valueName]?.trim();
  if (directValue) return directValue;
  const path = env[fileName]?.trim();
  if (!path) return undefined;
  const fileValue = readFileSync(path, "utf8").trim();
  if (!fileValue) throw new Error(`${fileName} points to an empty secret file.`);
  return fileValue;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const host = env.HOST?.trim() || "127.0.0.1";
  const mcpBearerToken = readSecret(env, "MCP_BEARER_TOKEN", "MCP_BEARER_TOKEN_FILE");
  const authModeRaw = env.AUTH_MODE?.trim() || "server";
  if (authModeRaw !== "server" && authModeRaw !== "maimemo-token") {
    throw new Error("AUTH_MODE must be 'server' or 'maimemo-token'.");
  }
  const mcpPathRaw = env.MCP_PATH?.trim() || "/mcp";
  const mcpPath = mcpPathRaw.startsWith("/") ? mcpPathRaw : `/${mcpPathRaw}`;
  const allowedHosts = env.ALLOWED_HOSTS?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (!isLoopback(host) && authModeRaw === "server" && !mcpBearerToken) {
    throw new Error("MCP_BEARER_TOKEN is required when HOST is not loopback.");
  }

  return {
    host,
    port: parseInteger(env.PORT, 8787, "PORT"),
    mcpPath,
    allowedHosts: allowedHosts?.length ? allowedHosts : undefined,
    maimemoApiToken: readSecret(env, "MAIMEMO_API_TOKEN", "MAIMEMO_API_TOKEN_FILE"),
    mcpBearerToken,
    authMode: authModeRaw,
    allowMutations: parseBoolean(env.ALLOW_MUTATIONS, false),
    cliTimeoutMs: parseInteger(env.CLI_TIMEOUT_MS, 30_000, "CLI_TIMEOUT_MS"),
    localReviewDbPath: env.LOCAL_REVIEW_DB_PATH?.trim() || join(
      env.STATE_DIRECTORY?.split(":")[0] || join(env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "momo-mcp"),
      "review.sqlite"
    )
  };
}
