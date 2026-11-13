import { z } from "zod";

export const errorDetailsSchema = z.object({
  code: z.enum(["AUTH_REQUIRED", "AUTH_INVALID", "PERMISSION_DENIED", "RATE_LIMITED", "NOT_FOUND",
    "INVALID_ARGUMENT", "INVALID_ARGUMENT_COMBINATION", "MUTATIONS_DISABLED", "UPSTREAM_REJECTED",
    "UPSTREAM_SCHEMA_MISMATCH", "UPSTREAM_ERROR", "SERVICE_UNAVAILABLE", "NETWORK_ERROR", "TIMEOUT",
    "RESPONSE_TOO_LARGE", "LOCAL_STORAGE_ERROR", "INTERNAL_ERROR"]),
  message: z.string(),
  http_status: z.number().int().nullable(),
  retryable: z.boolean(),
  retry_after_seconds: z.number().nullable(),
  mutation_may_have_succeeded: z.boolean()
});
export type ErrorDetails = z.infer<typeof errorDetailsSchema>;

export class ApiError extends Error {
  constructor(message: string, readonly code: ErrorDetails["code"], readonly httpStatus: number | null = null,
    readonly retryable = false, readonly retryAfterSeconds: number | null = null) {
    super(message);
  }
}

export function describeError(error: unknown, secret?: string, mutation = false): ErrorDetails {
  let message = error instanceof Error ? error.message : "Operation failed";
  if (secret) message = message.split(secret).join("[REDACTED]");
  let code: ErrorDetails["code"] = "INTERNAL_ERROR";
  let retryable = false;
  if (error instanceof ApiError) { code = error.code; retryable = error.retryable; }
  else if (error instanceof z.ZodError) code = "INVALID_ARGUMENT";
  else if (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name)) { code = "TIMEOUT"; retryable = true; }
  const uncertainMutation = mutation && ["NETWORK_ERROR", "TIMEOUT", "UPSTREAM_ERROR", "SERVICE_UNAVAILABLE",
    "UPSTREAM_SCHEMA_MISMATCH", "RESPONSE_TOO_LARGE", "INTERNAL_ERROR"].includes(code);
  return { code, message, http_status: error instanceof ApiError ? error.httpStatus : null,
    retryable: !mutation && retryable, retry_after_seconds: error instanceof ApiError ? error.retryAfterSeconds : null,
    mutation_may_have_succeeded: uncertainMutation };
}

export function toolSuccess(data: unknown) {
  const structuredContent = { ok: true, data, error: null };
  return { structuredContent, content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }] };
}

export function toolFailure(error: unknown, secret?: string, mutation = false) {
  const error_details = describeError(error, secret, mutation);
  const structuredContent = { ok: false, data: null, error: error_details.message, error_details };
  return { isError: true as const, structuredContent, content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }] };
}

export function httpError(status: number, retryAfter: string | null): ApiError {
  const code = status === 401 ? "AUTH_INVALID" : status === 403 ? "PERMISSION_DENIED" : status === 429 ? "RATE_LIMITED"
    : status === 404 ? "NOT_FOUND" : status === 400 || status === 422 ? "INVALID_ARGUMENT"
    : status === 503 ? "SERVICE_UNAVAILABLE" : "UPSTREAM_ERROR";
  const delay = retryAfter === null ? NaN : /^\d+(\.\d+)?$/.test(retryAfter.trim())
    ? Number(retryAfter) : (Date.parse(retryAfter) - Date.now()) / 1000;
  return new ApiError(`Official API HTTP ${status}${status === 401 ? ": token expired or invalid; re-authorize with MaiMemo" : status === 429 ? ": rate limit; retry later" : ""}`,
    code, status, status === 429 || status >= 500, Number.isFinite(delay) ? Math.max(0, delay) : null);
}
