import type { AssistantMessage } from "@mariozechner/pi-ai";

import type { MoltbotConfig } from "../../config/config.js";
import { formatSandboxToolPolicyBlockedMessage } from "../sandbox.js";
import type { FailoverReason } from "./types.js";

export function isContextOverflowError(errorMessage?: string): boolean {
  if (!errorMessage) return false;
  const lower = errorMessage.toLowerCase();
  const hasRequestSizeExceeds = lower.includes("request size exceeds");
  const hasContextWindow =
    lower.includes("context window") ||
    lower.includes("context length") ||
    lower.includes("maximum context length");
  return (
    lower.includes("request_too_large") ||
    lower.includes("request exceeds the maximum size") ||
    lower.includes("context length exceeded") ||
    lower.includes("maximum context length") ||
    lower.includes("prompt is too long") ||
    lower.includes("exceeds model context window") ||
    (hasRequestSizeExceeds && hasContextWindow) ||
    lower.includes("context overflow") ||
    (lower.includes("413") && lower.includes("too large"))
  );
}

const CONTEXT_WINDOW_TOO_SMALL_RE = /context window.*(too small|minimum is)/i;
const CONTEXT_OVERFLOW_HINT_RE =
  /context.*overflow|context window.*(too (?:large|long)|exceed|over|limit|max(?:imum)?|requested|sent|tokens)|(?:prompt|request|input).*(too (?:large|long)|exceed|over|limit|max(?:imum)?)/i;

export function isLikelyContextOverflowError(errorMessage?: string): boolean {
  if (!errorMessage) return false;
  if (CONTEXT_WINDOW_TOO_SMALL_RE.test(errorMessage)) return false;
  if (isContextOverflowError(errorMessage)) return true;
  return CONTEXT_OVERFLOW_HINT_RE.test(errorMessage);
}

export function isCompactionFailureError(errorMessage?: string): boolean {
  if (!errorMessage) return false;
  if (!isContextOverflowError(errorMessage)) return false;
  const lower = errorMessage.toLowerCase();
  return (
    lower.includes("summarization failed") ||
    lower.includes("auto-compaction") ||
    lower.includes("compaction failed") ||
    lower.includes("compaction")
  );
}

const ERROR_PAYLOAD_PREFIX_RE =
  /^(?:error|api\s*error|apierror|openai\s*error|anthropic\s*error|gateway\s*error)[:\s-]+/i;
const FINAL_TAG_RE = /<\s*\/?\s*final\s*>/gi;
const ERROR_PREFIX_RE =
  /^(?:error|api\s*error|openai\s*error|anthropic\s*error|gateway\s*error|request failed|failed|exception)[:\s-]+/i;
const HTTP_STATUS_PREFIX_RE = /^(?:http\s*)?(\d{3})\s+(.+)$/i;
const HTTP_ERROR_HINTS = [
  "error",
  "bad request",
  "not found",
  "unauthorized",
  "forbidden",
  "internal server",
  "service unavailable",
  "gateway",
  "rate limit",
  "overloaded",
  "timeout",
  "timed out",
  "invalid",
  "too many requests",
  "permission",
];

function stripFinalTagsFromText(text: string): string {
  if (!text) return text;
  return text.replace(FINAL_TAG_RE, "");
}

function collapseConsecutiveDuplicateBlocks(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return text;
  const blocks = trimmed.split(/\n{2,}/);
  if (blocks.length < 2) return text;

  const normalizeBlock = (value: string) => value.trim().replace(/\s+/g, " ");
  const result: string[] = [];
  let lastNormalized: string | null = null;

  for (const block of blocks) {
    const normalized = normalizeBlock(block);
    if (lastNormalized && normalized === lastNormalized) {
      continue;
    }
    result.push(block.trim());
    lastNormalized = normalized;
  }

  if (result.length === blocks.length) return text;
  return result.join("\n\n");
}

function isLikelyHttpErrorText(raw: string): boolean {
  const match = raw.match(HTTP_STATUS_PREFIX_RE);
  if (!match) return false;
  const code = Number(match[1]);
  if (!Number.isFinite(code) || code < 400) return false;
  const message = match[2].toLowerCase();
  return HTTP_ERROR_HINTS.some((hint) => message.includes(hint));
}

type ErrorPayload = Record<string, unknown>;

function isErrorPayloadObject(payload: unknown): payload is ErrorPayload {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const record = payload as ErrorPayload;
  if (record.type === "error") return true;
  if (typeof record.request_id === "string" || typeof record.requestId === "string") return true;
  if ("error" in record) {
    const err = record.error;
    if (err && typeof err === "object" && !Array.isArray(err)) {
      const errRecord = err as ErrorPayload;
      if (
        typeof errRecord.message === "string" ||
        typeof errRecord.type === "string" ||
        typeof errRecord.code === "string"
      ) {
        return true;
      }
    }
  }
  return false;
}

function parseApiErrorPayload(raw: string): ErrorPayload | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const candidates = [trimmed];
  if (ERROR_PAYLOAD_PREFIX_RE.test(trimmed)) {
    candidates.push(trimmed.replace(ERROR_PAYLOAD_PREFIX_RE, "").trim());
  }
  for (const candidate of candidates) {
    if (!candidate.startsWith("{") || !candidate.endsWith("}")) continue;
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (isErrorPayloadObject(parsed)) return parsed;
    } catch {
      // ignore parse errors
    }
  }
  return null;
}

function stableStringify(value: unknown): string {
  if (!value || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const entries = keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
  return `{${entries.join(",")}}`;
}

export function getApiErrorPayloadFingerprint(raw?: string): string | null {
  if (!raw) return null;
  const payload = parseApiErrorPayload(raw);
  if (!payload) return null;
  return stableStringify(payload);
}

export function isRawApiErrorPayload(raw?: string): boolean {
  return getApiErrorPayloadFingerprint(raw) !== null;
}

export type ApiErrorInfo = {
  httpCode?: string;
  type?: string;
  message?: string;
  requestId?: string;
};

export function parseApiErrorInfo(raw?: string): ApiErrorInfo | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  let httpCode: string | undefined;
  let candidate = trimmed;

  const httpPrefixMatch = candidate.match(/^(\d{3})\s+(.+)$/s);
  if (httpPrefixMatch) {
    httpCode = httpPrefixMatch[1];
    candidate = httpPrefixMatch[2].trim();
  }

  const payload = parseApiErrorPayload(candidate);
  if (!payload) return null;

  const requestId =
    typeof payload.request_id === "string"
      ? payload.request_id
      : typeof payload.requestId === "string"
        ? payload.requestId
        : undefined;

  const topType = typeof payload.type === "string" ? payload.type : undefined;
  const topMessage = typeof payload.message === "string" ? payload.message : undefined;

  let errType: string | undefined;
  let errMessage: string | undefined;
  if (payload.error && typeof payload.error === "object" && !Array.isArray(payload.error)) {
    const err = payload.error as Record<string, unknown>;
    if (typeof err.type === "string") errType = err.type;
    if (typeof err.code === "string" && !errType) errType = err.code;
    if (typeof err.message === "string") errMessage = err.message;
  }

  return {
    httpCode,
    type: errType ?? topType,
    message: errMessage ?? topMessage,
    requestId,
  };
}

export function formatRawAssistantErrorForUi(raw?: string): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return "LLM request failed with an unknown error.";

  const httpMatch = trimmed.match(HTTP_STATUS_PREFIX_RE);
  if (httpMatch) {
    const rest = httpMatch[2].trim();
    if (!rest.startsWith("{")) {
      return `HTTP ${httpMatch[1]}: ${rest}`;
    }
  }

  const info = parseApiErrorInfo(trimmed);
  if (info?.message) {
    const prefix = info.httpCode ? `HTTP ${info.httpCode}` : "LLM error";
    const type = info.type ? ` ${info.type}` : "";
    const requestId = info.requestId ? ` (request_id: ${info.requestId})` : "";
    return `${prefix}${type}: ${info.message}${requestId}`;
  }

  return trimmed.length > 600 ? `${trimmed.slice(0, 600)}…` : trimmed;
}

export function formatAssistantErrorText(
  msg: AssistantMessage,
  opts?: { cfg?: MoltbotConfig; sessionKey?: string },
): string | undefined {
  // Also format errors if errorMessage is present, even if stopReason isn't "error"
  const raw = (msg.errorMessage ?? "").trim();
  if (msg.stopReason !== "error" && !raw) return undefined;
  if (!raw) return "LLM request failed with an unknown error.";

  const unknownTool =
    raw.match(/unknown tool[:\s]+["']?([a-z0-9_-]+)["']?/i) ??
    raw.match(/tool\s+["']?([a-z0-9_-]+)["']?\s+(?:not found|is not available)/i);
  if (unknownTool?.[1]) {
    const rewritten = formatSandboxToolPolicyBlockedMessage({
      cfg: opts?.cfg,
      sessionKey: opts?.sessionKey,
      toolName: unknownTool[1],
    });
    if (rewritten) return rewritten;
  }

  if (isContextOverflowError(raw)) {
    return (
      "Context overflow: prompt too large for the model. " +
      "Try again with less input or a larger-context model."
    );
  }

  // Catch role ordering errors - including JSON-wrapped and "400" prefix variants
  if (
    /incorrect role information|roles must alternate|400.*role|"message".*role.*information/i.test(
      raw,
    )
  ) {
    return (
      "Message ordering conflict - please try again. " +
      "If this persists, use /new to start a fresh session."
    );
  }

  const invalidRequest = raw.match(/"type":"invalid_request_error".*?"message":"([^"]+)"/);
  if (invalidRequest?.[1]) {
    return `LLM request rejected: ${invalidRequest[1]}`;
  }

  if (isOverloadedErrorMessage(raw)) {
    return "The AI service is temporarily overloaded. Please try again in a moment.";
  }

  if (isLikelyHttpErrorText(raw) || isRawApiErrorPayload(raw)) {
    return formatRawAssistantErrorForUi(raw);
  }

  // Never return raw unhandled errors - log for debugging but return safe message
  if (raw.length > 600) {
    console.warn("[formatAssistantErrorText] Long error truncated:", raw.slice(0, 200));
  }
  return raw.length > 600 ? `${raw.slice(0, 600)}…` : raw;
}

export function sanitizeUserFacingText(text: string): string {
  if (!text) return text;
  const stripped = stripFinalTagsFromText(text);
  const trimmed = stripped.trim();
  if (!trimmed) return stripped;

  if (/incorrect role information|roles must alternate/i.test(trimmed)) {
    return (
      "Message ordering conflict - please try again. " +
      "If this persists, use /new to start a fresh session."
    );
  }

  if (isContextOverflowError(trimmed)) {
    return (
      "Context overflow: prompt too large for the model. " +
      "Try again with less input or a larger-context model."
    );
  }

  if (isRawApiErrorPayload(trimmed) || isLikelyHttpErrorText(trimmed)) {
    return formatRawAssistantErrorForUi(trimmed);
  }

  if (ERROR_PREFIX_RE.test(trimmed)) {
    if (isOverloadedErrorMessage(trimmed) || isRateLimitErrorMessage(trimmed)) {
      return "The AI service is temporarily overloaded. Please try again in a moment.";
    }
    if (isTimeoutErrorMessage(trimmed)) {
      return "LLM request timed out.";
    }
    return formatRawAssistantErrorForUi(trimmed);
  }

  return collapseConsecutiveDuplicateBlocks(stripped);
}

export function isRateLimitAssistantError(msg: AssistantMessage | undefined): boolean {
  if (!msg || msg.stopReason !== "error") return false;
  return isRateLimitErrorMessage(msg.errorMessage ?? "");
}

type ErrorPattern = RegExp | string;

const ERROR_PATTERNS = {
  rateLimit: [
    /rate[_ ]limit|too many requests|429/,
    "exceeded your current quota",
    "resource has been exhausted",
    "quota exceeded",
    "resource_exhausted",
    "usage limit",
  ],
  overloaded: [/overloaded_error|"type"\s*:\s*"overloaded_error"/i, "overloaded"],
  timeout: ["timeout", "timed out", "deadline exceeded", "context deadline exceeded"],
  billing: [
    /\b402\b/,
    "payment required",
    "insufficient credits",
    "credit balance",
    "plans & billing",
  ],
  auth: [
    /invalid[_ ]?api[_ ]?key/,
    "incorrect api key",
    "invalid token",
    "authentication",
    "re-authenticate",
    "oauth token refresh failed",
    "unauthorized",
    "forbidden",
    "access denied",
    "expired",
    "token has expired",
    /\b401\b/,
    /\b403\b/,
    "no credentials found",
    "no api key found",
  ],
  format: [
    "string should match pattern",
    "tool_use.id",
    "tool_use_id",
    "messages.1.content.1.tool_use.id",
    "invalid request format",
  ],
} as const;

const IMAGE_DIMENSION_ERROR_RE =
  /image dimensions exceed max allowed size for many-image requests:\s*(\d+)\s*pixels/i;
const IMAGE_DIMENSION_PATH_RE = /messages\.(\d+)\.content\.(\d+)\.image/i;
const IMAGE_SIZE_ERROR_RE = /image exceeds\s*(\d+(?:\.\d+)?)\s*mb/i;

function matchesErrorPatterns(raw: string, patterns: readonly ErrorPattern[]): boolean {
  if (!raw) return false;
  const value = raw.toLowerCase();
  return patterns.some((pattern) =>
    pattern instanceof RegExp ? pattern.test(value) : value.includes(pattern),
  );
}

export function isRateLimitErrorMessage(raw: string): boolean {
  return matchesErrorPatterns(raw, ERROR_PATTERNS.rateLimit);
}

export function isTimeoutErrorMessage(raw: string): boolean {
  return matchesErrorPatterns(raw, ERROR_PATTERNS.timeout);
}

export function isBillingErrorMessage(raw: string): boolean {
  const value = raw.toLowerCase();
  if (!value) return false;
  if (matchesErrorPatterns(value, ERROR_PATTERNS.billing)) return true;
  return (
    value.includes("billing") &&
    (value.includes("upgrade") ||
      value.includes("credits") ||
      value.includes("payment") ||
      value.includes("plan"))
  );
}

export function isBillingAssistantError(msg: AssistantMessage | undefined): boolean {
  if (!msg || msg.stopReason !== "error") return false;
  return isBillingErrorMessage(msg.errorMessage ?? "");
}

export function isAuthErrorMessage(raw: string): boolean {
  return matchesErrorPatterns(raw, ERROR_PATTERNS.auth);
}

export function isOverloadedErrorMessage(raw: string): boolean {
  return matchesErrorPatterns(raw, ERROR_PATTERNS.overloaded);
}

export function parseImageDimensionError(raw: string): {
  maxDimensionPx?: number;
  messageIndex?: number;
  contentIndex?: number;
  raw: string;
} | null {
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (!lower.includes("image dimensions exceed max allowed size")) return null;
  const limitMatch = raw.match(IMAGE_DIMENSION_ERROR_RE);
  const pathMatch = raw.match(IMAGE_DIMENSION_PATH_RE);
  return {
    maxDimensionPx: limitMatch?.[1] ? Number.parseInt(limitMatch[1], 10) : undefined,
    messageIndex: pathMatch?.[1] ? Number.parseInt(pathMatch[1], 10) : undefined,
    contentIndex: pathMatch?.[2] ? Number.parseInt(pathMatch[2], 10) : undefined,
    raw,
  };
}

export function isImageDimensionErrorMessage(raw: string): boolean {
  return Boolean(parseImageDimensionError(raw));
}

export function parseImageSizeError(raw: string): {
  maxMb?: number;
  raw: string;
} | null {
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (!lower.includes("image exceeds") || !lower.includes("mb")) return null;
  const match = raw.match(IMAGE_SIZE_ERROR_RE);
  return {
    maxMb: match?.[1] ? Number.parseFloat(match[1]) : undefined,
    raw,
  };
}

export function isImageSizeError(errorMessage?: string): boolean {
  if (!errorMessage) return false;
  return Boolean(parseImageSizeError(errorMessage));
}

export function isCloudCodeAssistFormatError(raw: string): boolean {
  return !isImageDimensionErrorMessage(raw) && matchesErrorPatterns(raw, ERROR_PATTERNS.format);
}

export function isAuthAssistantError(msg: AssistantMessage | undefined): boolean {
  if (!msg || msg.stopReason !== "error") return false;
  return isAuthErrorMessage(msg.errorMessage ?? "");
}

export function classifyFailoverReason(raw: string): FailoverReason | null {
  if (isImageDimensionErrorMessage(raw)) return null;
  if (isImageSizeError(raw)) return null;
  if (isRateLimitErrorMessage(raw)) return "rate_limit";
  if (isOverloadedErrorMessage(raw)) return "rate_limit";
  if (isCloudCodeAssistFormatError(raw)) return "format";
  if (isBillingErrorMessage(raw)) return "billing";
  if (isTimeoutErrorMessage(raw)) return "timeout";
  if (isAuthErrorMessage(raw)) return "auth";
  return null;
}

export function isFailoverErrorMessage(raw: string): boolean {
  return classifyFailoverReason(raw) !== null;
}

export function isFailoverAssistantError(msg: AssistantMessage | undefined): boolean {
  if (!msg || msg.stopReason !== "error") return false;
  return isFailoverErrorMessage(msg.errorMessage ?? "");
}
