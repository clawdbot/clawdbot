// Discord plugin module implements rest errors behavior.
import { parseStrictNonNegativeInteger } from "openclaw/plugin-sdk/number-runtime";
import { parseDiscordRetryAfterBodySeconds, parseRetryAfterHeaderSeconds } from "../retry-after.js";

export function readDiscordCode(body: unknown): number | undefined {
  const value =
    body && typeof body === "object" && "code" in body
      ? (body as { code?: unknown }).code
      : undefined;
  return parseStrictNonNegativeInteger(value);
}

export function readDiscordMessage(body: unknown, fallback: string): string {
  const value =
    body && typeof body === "object" && "message" in body
      ? (body as { message?: unknown }).message
      : undefined;
  return typeof value === "string" && value.trim() ? value : fallback;
}

export function readRetryAfter(body: unknown, response: Response, fallbackSeconds = 0): number {
  const bodyValue =
    body && typeof body === "object" && "retry_after" in body
      ? (body as { retry_after?: unknown }).retry_after
      : undefined;
  return (
    parseDiscordRetryAfterBodySeconds(bodyValue) ??
    parseRetryAfterHeaderSeconds(response.headers.get("Retry-After")) ??
    fallbackSeconds
  );
}

export class DiscordError extends Error {
  readonly status: number;
  readonly statusCode: number;
  readonly rawBody: unknown;
  readonly rawError: unknown;
  discordCode?: number;

  constructor(response: Response, body: unknown) {
    super(readDiscordMessage(body, `Discord API request failed (${response.status})`));
    this.name = "DiscordError";
    this.status = response.status;
    this.statusCode = response.status;
    this.rawBody = body;
    this.rawError = body;
    this.discordCode = readDiscordCode(body);
  }
}

export class RateLimitError extends DiscordError {
  readonly retryAfter: number;
  readonly scope: string | null;
  readonly bucket: string | null;

  constructor(
    response: Response,
    body: { message: string; retry_after: number; global: boolean; code?: number | string },
  ) {
    super(response, body);
    this.name = "RateLimitError";
    this.retryAfter = readRetryAfter(body, response, 1);
    this.scope = body.global ? "global" : response.headers.get("X-RateLimit-Scope");
    this.bucket = response.headers.get("X-RateLimit-Bucket");
  }
}
