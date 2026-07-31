import { Buffer } from "node:buffer";
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
const ID_HASH_LENGTH = 16;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._~:/+@=-]+$/u;
const REQUEST_ID_UNSAFE_CHARACTER_PATTERN = /[^A-Za-z0-9._~:/+@=-]/gu;
const ATTRIBUTION_PRINTABLE_ASCII_PATTERN = /^[\x20-\x7E]+$/u;
const ATTRIBUTION_NON_PRINTABLE_ASCII_PATTERN = /[^\x20-\x7E]/gu;
const ATTRIBUTION_ENCODED_SUFFIX_PATTERN = /~[a-f0-9]{16}$/u;
const REQUEST_ID_SUFFIX_PATTERN = /:model:\d+$/u;
const REQUEST_ID_ENCODED_SUFFIX_PATTERN = /~[a-f0-9]{16}(?::model:\d+)?$/u;

type BoundedIdPolicy = {
  encodedSuffixPattern: RegExp;
  maxLength: number;
  safePattern: RegExp;
  unsafeCharacterPattern: RegExp;
  preservedSuffixPattern?: RegExp;
};

const ATTRIBUTION_ID_POLICY: BoundedIdPolicy = {
  encodedSuffixPattern: ATTRIBUTION_ENCODED_SUFFIX_PATTERN,
  maxLength: ATTRIBUTION_VALUE_MAX_LENGTH,
  safePattern: ATTRIBUTION_PRINTABLE_ASCII_PATTERN,
  unsafeCharacterPattern: ATTRIBUTION_NON_PRINTABLE_ASCII_PATTERN,
};
const REQUEST_ID_POLICY: BoundedIdPolicy = {
  encodedSuffixPattern: REQUEST_ID_ENCODED_SUFFIX_PATTERN,
  maxLength: REQUEST_ID_MAX_LENGTH,
  safePattern: REQUEST_ID_PATTERN,
  unsafeCharacterPattern: REQUEST_ID_UNSAFE_CHARACTER_PATTERN,
  preservedSuffixPattern: REQUEST_ID_SUFFIX_PATTERN,
};

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

function normalizeHeaderId(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized || hasControlCharacter(normalized)) {
    return undefined;
  }
  return normalized;
}

function sanitizeBoundedId(value: string | undefined, policy: BoundedIdPolicy): string | undefined {
  const normalized = normalizeHeaderId(value);
  if (!normalized) {
    return undefined;
  }
  if (
    normalized.length <= policy.maxLength &&
    policy.safePattern.test(normalized) &&
    !policy.encodedSuffixPattern.test(normalized)
  ) {
    return normalized;
  }
  // Hash UTF-16 code units losslessly: UTF-8 string hashing replaces lone
  // surrogates with U+FFFD. The reserved encoded suffix keeps a rewritten ID
  // from aliasing an otherwise safe input that already looks encoded.
  const hash = createHash("sha256")
    .update(Buffer.from(normalized, "utf16le"))
    .digest("hex")
    .slice(0, ID_HASH_LENGTH);
  const preservedSuffix = policy.preservedSuffixPattern?.exec(normalized)?.[0] ?? "";
  const rawPrefix = preservedSuffix ? normalized.slice(0, -preservedSuffix.length) : normalized;
  const safePrefix = rawPrefix.replace(policy.unsafeCharacterPattern, "_");
  const hashSuffix = `~${hash}`;
  const boundedSuffix = `${hashSuffix}${preservedSuffix}`;
  const suffix = boundedSuffix.length < policy.maxLength ? boundedSuffix : hashSuffix;
  return `${safePrefix.slice(0, policy.maxLength - suffix.length)}${suffix}`;
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
  setHeaderDefault(next, AGENT_HEADER, sanitizeBoundedId(params.agentId, ATTRIBUTION_ID_POLICY));
  setHeaderDefault(
    next,
    SESSION_HEADER,
    sanitizeBoundedId(params.sessionId, ATTRIBUTION_ID_POLICY),
  );
  setHeaderDefault(next, REQUEST_ID_HEADER, sanitizeBoundedId(params.requestId, REQUEST_ID_POLICY));
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
