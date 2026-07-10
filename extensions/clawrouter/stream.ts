import { createHash } from "node:crypto";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import { prepareClawRouterRequestModel } from "./provider-catalog.js";

const ENV_API_KEY_MARKER = "CLAWROUTER_API_KEY";
const ATTRIBUTION_VALUE_MAX_LENGTH = 256;
const REQUEST_ID_MAX_LENGTH = 128;
const CLIENT_HEADER = "X-ClawRouter-Client";
const AGENT_HEADER = "X-ClawRouter-Agent-Id";
const SESSION_HEADER = "X-ClawRouter-Session-Id";
const REQUEST_ID_HEADER = "X-Request-ID";
const REQUEST_ID_HASH_LENGTH = 16;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._~:/+@=-]+$/u;
const REQUEST_ID_UNSAFE_CHARACTER_PATTERN = /[^A-Za-z0-9._~:/+@=-]/gu;

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

function normalizeAttributionValue(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized || hasControlCharacter(normalized)) {
    return undefined;
  }
  return normalized;
}

function sanitizeAttributionValue(value: string | undefined): string | undefined {
  const normalized = normalizeAttributionValue(value);
  if (!normalized) {
    return undefined;
  }
  return normalized.slice(0, ATTRIBUTION_VALUE_MAX_LENGTH);
}

function sanitizeRequestId(value: string | undefined): string | undefined {
  const normalized = normalizeAttributionValue(value);
  if (!normalized) {
    return normalized;
  }
  if (normalized.length <= REQUEST_ID_MAX_LENGTH && REQUEST_ID_PATTERN.test(normalized)) {
    return normalized;
  }
  // Retain the per-call suffix while bounding long run ids; the hash keeps
  // distinct long prefixes from collapsing onto the same audit identifier.
  const hash = createHash("sha256")
    .update(normalized)
    .digest("hex")
    .slice(0, REQUEST_ID_HASH_LENGTH);
  const modelSuffix = normalized.match(/:model:\d+$/u)?.[0] ?? "";
  const rawPrefix = modelSuffix ? normalized.slice(0, -modelSuffix.length) : normalized;
  const safePrefix = rawPrefix.replace(REQUEST_ID_UNSAFE_CHARACTER_PATTERN, "_");
  const boundedSuffix = `~${hash}${modelSuffix}`;
  if (boundedSuffix.length >= REQUEST_ID_MAX_LENGTH) {
    return `${safePrefix.slice(0, REQUEST_ID_MAX_LENGTH - hash.length - 1)}~${hash}`;
  }
  return `${safePrefix.slice(0, REQUEST_ID_MAX_LENGTH - boundedSuffix.length)}${boundedSuffix}`;
}

function findHeader(headers: Record<string, string>, target: string): string | undefined {
  const normalizedTarget = target.toLowerCase();
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === normalizedTarget) {
      return value;
    }
  }
  return undefined;
}

function setHeaderDefault(
  headers: Record<string, string>,
  name: string,
  value: string | undefined,
): void {
  if (value !== undefined && findHeader(headers, name) === undefined) {
    headers[name] = value;
  }
}

function withClawRouterHeaders(
  headers: Record<string, string> | undefined,
  params: { agentId?: string; apiKey?: string; requestId?: string; sessionId?: string },
): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (name.toLowerCase() !== "authorization" || !params.apiKey) {
      next[name] = value;
    }
  }
  setHeaderDefault(next, CLIENT_HEADER, "openclaw");
  setHeaderDefault(next, AGENT_HEADER, sanitizeAttributionValue(params.agentId));
  setHeaderDefault(next, SESSION_HEADER, sanitizeAttributionValue(params.sessionId));
  setHeaderDefault(next, REQUEST_ID_HEADER, sanitizeRequestId(params.requestId));
  if (params.apiKey) {
    next.Authorization = `Bearer ${params.apiKey}`;
  }
  return next;
}

function createClawRouterStreamWrapper(ctx: ProviderWrapStreamFnContext): StreamFn | undefined {
  const underlying = ctx.streamFn;
  if (!underlying) {
    return undefined;
  }
  return (model, context, options) => {
    const apiKey = options?.apiKey?.trim();
    const preparedModel = prepareClawRouterRequestModel(model);
    const hasExplicitRequestId =
      findHeader(options?.headers ?? {}, REQUEST_ID_HEADER) !== undefined;
    return underlying(
      {
        ...preparedModel,
        headers: withClawRouterHeaders(preparedModel.headers, {
          agentId: ctx.agentId,
          apiKey: apiKey && apiKey !== ENV_API_KEY_MARKER ? apiKey : undefined,
          requestId: hasExplicitRequestId ? undefined : options?.requestId,
          sessionId: options?.sessionId,
        }),
      },
      context,
      options,
    );
  };
}

export function wrapClawRouterProviderStream(
  ctx: ProviderWrapStreamFnContext,
): StreamFn | undefined {
  return createClawRouterStreamWrapper(ctx);
}
