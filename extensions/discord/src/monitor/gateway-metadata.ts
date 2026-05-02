import type { APIGatewayBotInfo } from "discord-api-types/v10";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { captureHttpExchange } from "openclaw/plugin-sdk/proxy-capture";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { Type } from "typebox";
import { Check, Errors } from "typebox/value";
import { isDiscordRateLimitResponseBody, summarizeDiscordResponseBody } from "../error-body.js";
import { withAbortTimeout } from "./timeouts.js";

const DISCORD_GATEWAY_BOT_URL = "https://discord.com/api/v10/gateway/bot";
const DISCORD_API_HOST = "discord.com";
const DEFAULT_DISCORD_GATEWAY_URL = "wss://gateway.discord.gg/";
const DEFAULT_DISCORD_GATEWAY_INFO_TIMEOUT_MS = 30_000;
const MAX_DISCORD_GATEWAY_INFO_TIMEOUT_MS = 120_000;
const DISCORD_GATEWAY_INFO_TIMEOUT_ENV = "OPENCLAW_DISCORD_GATEWAY_INFO_TIMEOUT_MS";
const DISCORD_GATEWAY_METADATA_FALLBACK_LOG_INTERVAL_MS = 60_000;

type DiscordGatewayMetadataResponse = Pick<Response, "ok" | "status" | "text">;
export type DiscordGatewayFetchInit = Record<string, unknown> & {
  headers?: Record<string, string>;
};
export type DiscordGatewayFetch = (
  input: string,
  init?: DiscordGatewayFetchInit,
) => Promise<DiscordGatewayMetadataResponse>;

type DiscordGatewayMetadataError = Error & { transient?: boolean };

const discordGatewayBotInfoSchema = Type.Object({
  url: Type.String({ minLength: 1 }),
  shards: Type.Integer({ minimum: 1 }),
  session_start_limit: Type.Object({
    total: Type.Integer({ minimum: 0 }),
    remaining: Type.Integer({ minimum: 0 }),
    reset_after: Type.Number({ minimum: 0 }),
    max_concurrency: Type.Integer({ minimum: 1 }),
  }),
});

const gatewayMetadataFallbackLogLastAt = new WeakMap<RuntimeEnv, number>();

function resolveFetchInputUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}

async function materializeGuardedResponse(response: Response): Promise<Response> {
  const body = await response.arrayBuffer();
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function normalizeGatewayInfoTimeoutMs(value: unknown): number | undefined {
  const numeric =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return undefined;
  }
  return Math.min(Math.floor(numeric), MAX_DISCORD_GATEWAY_INFO_TIMEOUT_MS);
}

export function resolveDiscordGatewayInfoTimeoutMs(params?: {
  configuredTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}): number {
  return (
    normalizeGatewayInfoTimeoutMs(params?.configuredTimeoutMs) ??
    normalizeGatewayInfoTimeoutMs(params?.env?.[DISCORD_GATEWAY_INFO_TIMEOUT_ENV]) ??
    DEFAULT_DISCORD_GATEWAY_INFO_TIMEOUT_MS
  );
}

function summarizeGatewayResponseBody(body: string): string {
  return summarizeDiscordResponseBody(body, { emptyText: "<empty>" }) ?? "<empty>";
}

function isDiscordGatewayRateLimitResponse(status: number, body: string): boolean {
  return status === 429 && isDiscordRateLimitResponseBody(body);
}

function isTransientDiscordGatewayResponse(status: number, body: string): boolean {
  if (status >= 500) {
    return true;
  }
  if (isDiscordGatewayRateLimitResponse(status, body)) {
    return true;
  }
  const normalized = body.toLowerCase();
  return (
    normalized.includes("upstream connect error") ||
    normalized.includes("disconnect/reset before headers") ||
    normalized.includes("reset reason:")
  );
}

function createGatewayMetadataError(params: {
  detail: string;
  transient: boolean;
  cause?: unknown;
}): Error {
  const error = new Error(
    params.transient
      ? "Failed to get gateway information from Discord: fetch failed"
      : `Failed to get gateway information from Discord: ${params.detail}`,
    {
      cause: params.cause ?? (params.transient ? new Error(params.detail) : undefined),
    },
  ) as DiscordGatewayMetadataError;
  Object.defineProperty(error, "transient", {
    value: params.transient,
    enumerable: false,
  });
  return error;
}

function isTransientGatewayMetadataError(error: unknown): boolean {
  return Boolean((error as DiscordGatewayMetadataError | undefined)?.transient);
}

function createDefaultGatewayInfo(): APIGatewayBotInfo {
  return {
    url: DEFAULT_DISCORD_GATEWAY_URL,
    shards: 1,
    session_start_limit: {
      total: 1,
      remaining: 1,
      reset_after: 0,
      max_concurrency: 1,
    },
  };
}

function summarizeGatewaySchemaErrors(value: unknown): string {
  const errors = Errors(discordGatewayBotInfoSchema, value);
  if (errors.length === 0) {
    return "unknown schema mismatch";
  }
  return errors
    .slice(0, 3)
    .map((error) => `${error.instancePath || "/"} ${error.message}`)
    .join("; ");
}

export function parseDiscordGatewayInfoBody(body: string): APIGatewayBotInfo {
  const parsed = JSON.parse(body) as unknown;
  if (!Check(discordGatewayBotInfoSchema, parsed)) {
    throw new Error(summarizeGatewaySchemaErrors(parsed));
  }
  return parsed;
}

export async function fetchDiscordGatewayInfo(params: {
  token: string;
  fetchImpl: DiscordGatewayFetch;
  fetchInit?: DiscordGatewayFetchInit;
}): Promise<APIGatewayBotInfo> {
  let response: DiscordGatewayMetadataResponse;
  try {
    response = await params.fetchImpl(DISCORD_GATEWAY_BOT_URL, {
      ...params.fetchInit,
      headers: {
        ...params.fetchInit?.headers,
        Authorization: `Bot ${params.token}`,
      },
    });
  } catch (error) {
    throw createGatewayMetadataError({
      detail: formatErrorMessage(error),
      transient: true,
      cause: error,
    });
  }

  let body: string;
  try {
    body = await response.text();
  } catch (error) {
    throw createGatewayMetadataError({
      detail: formatErrorMessage(error),
      transient: true,
      cause: error,
    });
  }
  const summary = summarizeGatewayResponseBody(body);
  const transient = isTransientDiscordGatewayResponse(response.status, body);

  if (!response.ok) {
    throw createGatewayMetadataError({
      detail: `Discord API /gateway/bot failed (${response.status}): ${summary}`,
      transient,
    });
  }

  try {
    return parseDiscordGatewayInfoBody(body);
  } catch (error) {
    throw createGatewayMetadataError({
      detail: `Discord API /gateway/bot returned invalid metadata: ${formatErrorMessage(error)} (${summary})`,
      transient,
      cause: error,
    });
  }
}

export async function fetchDiscordGatewayInfoWithTimeout(params: {
  token: string;
  fetchImpl: DiscordGatewayFetch;
  fetchInit?: DiscordGatewayFetchInit;
  timeoutMs?: number;
}): Promise<APIGatewayBotInfo> {
  const timeoutMs = Math.max(1, params.timeoutMs ?? DEFAULT_DISCORD_GATEWAY_INFO_TIMEOUT_MS);
  return await withAbortTimeout({
    timeoutMs,
    createTimeoutError: () =>
      createGatewayMetadataError({
        detail: `Discord API /gateway/bot timed out after ${timeoutMs}ms`,
        transient: true,
        cause: new Error("gateway metadata timeout"),
      }),
    run: async (signal) =>
      await fetchDiscordGatewayInfo({
        token: params.token,
        fetchImpl: params.fetchImpl,
        fetchInit: {
          ...params.fetchInit,
          signal,
        },
      }),
  });
}

export function resolveGatewayInfoWithFallback(params: { runtime?: RuntimeEnv; error: unknown }): {
  info: APIGatewayBotInfo;
  usedFallback: boolean;
} {
  if (!isTransientGatewayMetadataError(params.error)) {
    throw params.error;
  }
  const message = formatErrorMessage(params.error);
  const now = Date.now();
  if (params.runtime) {
    const previous = gatewayMetadataFallbackLogLastAt.get(params.runtime);
    if (
      previous === undefined ||
      now - previous >= DISCORD_GATEWAY_METADATA_FALLBACK_LOG_INTERVAL_MS
    ) {
      params.runtime.log?.(
        `discord: gateway metadata lookup failed transiently; using default gateway url (${message})`,
      );
      gatewayMetadataFallbackLogLastAt.set(params.runtime, now);
    }
  }
  return {
    info: createDefaultGatewayInfo(),
    usedFallback: true,
  };
}

export async function fetchDiscordGatewayMetadataDirect(
  input: string,
  init?: DiscordGatewayFetchInit,
  capture?: false | { flowId: string; meta: Record<string, unknown> },
): Promise<Response> {
  const guarded = await fetchWithSsrFGuard({
    url: resolveFetchInputUrl(input),
    init: init as RequestInit,
    policy: { allowedHostnames: [DISCORD_API_HOST] },
    capture: false,
    auditContext: "discord.gateway.metadata",
  });
  let response: Response;
  try {
    response = await materializeGuardedResponse(guarded.response);
  } finally {
    await guarded.release();
  }
  if (capture) {
    captureHttpExchange({
      url: input,
      method: (init?.method as string | undefined) ?? "GET",
      requestHeaders: init?.headers as Headers | Record<string, string> | undefined,
      requestBody: (init as RequestInit & { body?: BodyInit | null })?.body ?? null,
      response,
      flowId: capture.flowId,
      meta: capture.meta,
    });
  }
  return response;
}
