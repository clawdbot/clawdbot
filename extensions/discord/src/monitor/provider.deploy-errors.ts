import { inspect } from "node:util";
import { formatDurationSeconds } from "openclaw/plugin-sdk/runtime-env";
import { formatErrorMessage } from "openclaw/plugin-sdk/ssrf-runtime";
import { RateLimitError } from "../internal/discord.js";

const DISCORD_DEPLOY_REJECTED_ENTRY_LIMIT = 3;

type DiscordDeployErrorLike = {
  status?: unknown;
  statusCode?: unknown;
  discordCode?: unknown;
  retryAfter?: unknown;
  scope?: unknown;
  rawBody?: unknown;
  deployRequestBody?: unknown;
  deployRestMethod?: unknown;
  deployRestPath?: unknown;
  deployRequestMs?: unknown;
  deployTimeoutMs?: unknown;
};

type DiscordDeployRateLimitDetails = {
  status?: number;
  retryAfterMs?: number;
  scope?: string;
  discordCode?: number | string;
};

export function attachDiscordDeployRequestBody(err: unknown, body: unknown) {
  if (!err || typeof err !== "object" || body === undefined) {
    return;
  }
  const deployErr = err as DiscordDeployErrorLike;
  if (deployErr.deployRequestBody === undefined) {
    deployErr.deployRequestBody = body;
  }
}

export function attachDiscordDeployRestContext(
  err: unknown,
  context: {
    method: string;
    path: string;
    requestMs: number;
    timeoutMs?: number;
  },
) {
  if (!err || typeof err !== "object") {
    return;
  }
  const deployErr = err as DiscordDeployErrorLike;
  deployErr.deployRestMethod = context.method;
  deployErr.deployRestPath = context.path;
  deployErr.deployRequestMs = context.requestMs;
  if (typeof context.timeoutMs === "number" && Number.isFinite(context.timeoutMs)) {
    deployErr.deployTimeoutMs = context.timeoutMs;
  }
}

function stringifyDiscordDeployField(value: unknown): string {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return inspect(value, { depth: 2, breakLength: 120 });
  }
}

function readDiscordDeployRejectedFields(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string").slice(0, 6);
  }
  if (!value || typeof value !== "object") {
    return [];
  }
  return Object.keys(value).slice(0, 6);
}

function resolveDiscordRejectedDeployEntriesSource(
  rawBody: unknown,
): Record<string, unknown> | null {
  if (!rawBody || typeof rawBody !== "object") {
    return null;
  }
  const payload = rawBody as { errors?: unknown };
  const errors = payload.errors && typeof payload.errors === "object" ? payload.errors : undefined;
  const source = errors ?? rawBody;
  return source && typeof source === "object" ? (source as Record<string, unknown>) : null;
}

function readDiscordDeployObjectField(value: unknown, field: string): unknown {
  return value && typeof value === "object" && field in value
    ? (value as Record<string, unknown>)[field]
    : undefined;
}

function readFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function formatDurationMs(ms: number): string {
  return formatDurationSeconds(ms, { decimals: ms >= 1000 ? 1 : 0 });
}

function isAbortLikeError(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }
  const name = "name" in err && typeof err.name === "string" ? err.name : undefined;
  const message = formatErrorMessage(err);
  return (
    name === "AbortError" ||
    message === "This operation was aborted" ||
    message === "The operation was aborted" ||
    /\boperation was aborted\b/i.test(message)
  );
}

function formatDiscordDeployRestOperation(err: DiscordDeployErrorLike): string {
  const method =
    typeof err.deployRestMethod === "string" && err.deployRestMethod.trim().length > 0
      ? err.deployRestMethod.toUpperCase()
      : undefined;
  const path =
    typeof err.deployRestPath === "string" && err.deployRestPath.trim().length > 0
      ? err.deployRestPath
      : undefined;
  if (method && path) {
    return `${method} ${path}`;
  }
  if (method) {
    return method;
  }
  if (path) {
    return path;
  }
  return "request";
}

export function formatDiscordDeployErrorMessage(err: unknown): string {
  if (!isAbortLikeError(err)) {
    return formatErrorMessage(err);
  }
  const deployErr =
    err && typeof err === "object"
      ? (err as DiscordDeployErrorLike)
      : ({} as DiscordDeployErrorLike);
  const requestMs = readFiniteNumber(deployErr.deployRequestMs);
  const timeoutMs = readFiniteNumber(deployErr.deployTimeoutMs);
  const operation = formatDiscordDeployRestOperation(deployErr);
  const hasRestContext =
    requestMs !== undefined ||
    timeoutMs !== undefined ||
    deployErr.deployRestMethod !== undefined ||
    deployErr.deployRestPath !== undefined;
  if (!hasRestContext) {
    return "Discord REST request was aborted";
  }
  const timing: string[] = [];
  if (timeoutMs !== undefined) {
    timing.push(`timeout=${formatDurationMs(timeoutMs)}`);
  }
  if (requestMs !== undefined) {
    timing.push(`observed=${formatDurationMs(requestMs)}`);
  }
  const timingText = timing.length > 0 ? ` (${timing.join(", ")})` : "";
  if (timeoutMs !== undefined && requestMs !== undefined && requestMs >= timeoutMs) {
    return `Discord REST ${operation} timed out${timingText}`;
  }
  return `Discord REST ${operation} was aborted${timingText}`;
}

export function resolveDiscordDeployRateLimitDetails(
  err: unknown,
): DiscordDeployRateLimitDetails | undefined {
  if (!err || typeof err !== "object") {
    return undefined;
  }
  const deployErr = err as DiscordDeployErrorLike;
  const status = readFiniteNumber(deployErr.status) ?? readFiniteNumber(deployErr.statusCode);
  const retryAfterSeconds =
    readFiniteNumber(deployErr.retryAfter) ??
    readFiniteNumber(readDiscordDeployObjectField(deployErr.rawBody, "retry_after"));
  const isRateLimit =
    err instanceof RateLimitError || status === 429 || retryAfterSeconds !== undefined;
  if (!isRateLimit) {
    return undefined;
  }
  const rawGlobal = readDiscordDeployObjectField(deployErr.rawBody, "global");
  const scope =
    typeof deployErr.scope === "string" && deployErr.scope.trim().length > 0
      ? deployErr.scope
      : rawGlobal === true
        ? "global"
        : rawGlobal === false
          ? "route"
          : undefined;
  const discordCode =
    typeof deployErr.discordCode === "number" || typeof deployErr.discordCode === "string"
      ? deployErr.discordCode
      : undefined;
  return {
    status,
    retryAfterMs:
      retryAfterSeconds === undefined ? undefined : Math.max(0, retryAfterSeconds * 1000),
    scope,
    discordCode,
  };
}

export function formatDiscordDeployRateLimitDetails(err: unknown): string {
  const rateLimit = resolveDiscordDeployRateLimitDetails(err);
  if (!rateLimit) {
    return "";
  }
  const details: string[] = [];
  if (typeof rateLimit.status === "number") {
    details.push(`status=${rateLimit.status}`);
  }
  if (typeof rateLimit.retryAfterMs === "number") {
    details.push(
      `retryAfter=${formatDurationSeconds(rateLimit.retryAfterMs, {
        decimals: 1,
      })}`,
    );
  }
  if (rateLimit.scope) {
    details.push(`scope=${rateLimit.scope}`);
  }
  if (typeof rateLimit.discordCode === "number" || typeof rateLimit.discordCode === "string") {
    details.push(`code=${rateLimit.discordCode}`);
  }
  return details.length > 0 ? ` (${details.join(", ")})` : "";
}

export function formatDiscordDeployRateLimitWarning(
  err: unknown,
  accountId: string,
): string | undefined {
  const rateLimit = resolveDiscordDeployRateLimitDetails(err);
  if (!rateLimit) {
    return undefined;
  }
  const parts = [`discord: native slash command deploy rate limited for ${accountId}`];
  if (typeof rateLimit.retryAfterMs === "number") {
    parts.push(
      `retry after ${formatDurationSeconds(rateLimit.retryAfterMs, {
        decimals: 1,
      })}`,
    );
  }
  if (rateLimit.scope) {
    parts.push(`scope=${rateLimit.scope}`);
  }
  if (typeof rateLimit.discordCode === "number" || typeof rateLimit.discordCode === "string") {
    parts.push(`code=${rateLimit.discordCode}`);
  }
  return `${parts.join("; ")}. Existing slash commands stay active. Message send/receive is unaffected.`;
}

function formatDiscordRejectedDeployEntries(params: {
  rawBody: unknown;
  requestBody: unknown;
}): string[] {
  const requestBody = Array.isArray(params.requestBody) ? params.requestBody : null;
  const rejectedEntriesSource = resolveDiscordRejectedDeployEntriesSource(params.rawBody);
  if (!rejectedEntriesSource || !requestBody || requestBody.length === 0) {
    return [];
  }
  const rawEntries = Object.entries(rejectedEntriesSource).filter(([key]) => /^\d+$/.test(key));
  return rawEntries.slice(0, DISCORD_DEPLOY_REJECTED_ENTRY_LIMIT).flatMap(([key, value]) => {
    const index = Number.parseInt(key, 10);
    if (!Number.isFinite(index) || index < 0 || index >= requestBody.length) {
      return [];
    }
    const command = requestBody[index];
    if (!command || typeof command !== "object") {
      return [`#${index} fields=${readDiscordDeployRejectedFields(value).join("|") || "unknown"}`];
    }
    const payload = command as {
      name?: unknown;
      description?: unknown;
      options?: unknown;
    };
    const parts = [
      `#${index}`,
      `fields=${readDiscordDeployRejectedFields(value).join("|") || "unknown"}`,
    ];
    if (typeof payload.name === "string" && payload.name.trim().length > 0) {
      parts.push(`name=${payload.name}`);
    }
    if (payload.description !== undefined) {
      parts.push(`description=${stringifyDiscordDeployField(payload.description)}`);
    }
    if (Array.isArray(payload.options) && payload.options.length > 0) {
      parts.push(`options=${payload.options.length}`);
    }
    return [parts.join(" ")];
  });
}

export function formatDiscordDeployErrorDetails(err: unknown): string {
  if (!err || typeof err !== "object") {
    return "";
  }
  const rateLimitDetails = formatDiscordDeployRateLimitDetails(err);
  if (rateLimitDetails) {
    return rateLimitDetails;
  }
  const status = (err as DiscordDeployErrorLike).status;
  const discordCode = (err as DiscordDeployErrorLike).discordCode;
  const rawBody = (err as DiscordDeployErrorLike).rawBody;
  const requestBody = (err as DiscordDeployErrorLike).deployRequestBody;
  const details: string[] = [];
  if (typeof status === "number") {
    details.push(`status=${status}`);
  }
  if (typeof discordCode === "number" || typeof discordCode === "string") {
    details.push(`code=${discordCode}`);
  }
  if (rawBody !== undefined) {
    let bodyText = "";
    try {
      bodyText = JSON.stringify(rawBody);
    } catch {
      bodyText =
        typeof rawBody === "string" ? rawBody : inspect(rawBody, { depth: 3, breakLength: 120 });
    }
    if (bodyText) {
      const maxLen = 800;
      const trimmed = bodyText.length > maxLen ? `${bodyText.slice(0, maxLen)}...` : bodyText;
      details.push(`body=${trimmed}`);
    }
  }
  const rejectedEntries = formatDiscordRejectedDeployEntries({ rawBody, requestBody });
  if (rejectedEntries.length > 0) {
    details.push(`rejected=${rejectedEntries.join("; ")}`);
  }
  return details.length > 0 ? ` (${details.join(", ")})` : "";
}

export function isDiscordDeployDailyCreateLimit(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }
  const deployErr = err as DiscordDeployErrorLike;
  const discordCode = readFiniteNumber(deployErr.discordCode);
  const rawCode = readFiniteNumber(readDiscordDeployObjectField(deployErr.rawBody, "code"));
  return (
    (discordCode === 30034 || rawCode === 30034) &&
    /daily application command creates/i.test(formatErrorMessage(err))
  );
}
