import crypto from "node:crypto";
import {
  asDateTimestampMs,
  isFutureDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
} from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { parseGeminiAuth } from "../../infra/gemini-auth.js";
import { normalizeGoogleApiBaseUrl } from "../../infra/google-api-base-url.js";
import { streamWithPayloadPatch } from "../../llm/providers/stream-wrappers/stream-payload-utils.js";
import type { Model } from "../../llm/types.js";
import { buildGuardedModelFetch } from "../provider-transport-fetch.js";
import type { StreamFn } from "../runtime/index.js";
import { isSessionWriteLockAcquireError } from "../session-write-lock-error.js";
import { stableStringify } from "../stable-stringify.js";
import { stripSystemPromptCacheBoundary } from "../system-prompt-cache-boundary.js";
import { mergeTransportHeaders, sanitizeTransportPayloadText } from "../transport-stream-shared.js";
import { log } from "./logger.js";
import { isGooglePromptCacheEligible, resolveCacheRetention } from "./prompt-cache-retention.js";
import { EmbeddedAttemptSessionTakeoverError } from "./run/attempt.session-lock.js";

const GOOGLE_PROMPT_CACHE_CUSTOM_TYPE = "openclaw.google-prompt-cache";
const GOOGLE_PROMPT_CACHE_RETRY_BACKOFF_MS = 10 * 60_000;
const GOOGLE_PROMPT_CACHE_SHORT_REFRESH_WINDOW_MS = 30_000;
const GOOGLE_PROMPT_CACHE_LONG_REFRESH_WINDOW_MS = 5 * 60_000;

type CacheRetention = "short" | "long";
type CustomEntryLike = { type?: unknown; customType?: unknown; data?: unknown };

type GooglePromptCacheSessionManager = {
  appendCustomEntry(customType: string, data?: unknown): void | Promise<void>;
  getEntries(): CustomEntryLike[];
};
type GooglePromptCacheModel = Model & {
  baseUrl?: string;
  headers?: Record<string, string>;
  provider: string;
};
type GooglePromptCacheContext = Parameters<StreamFn>[1];
type GooglePromptCacheOptions = Parameters<StreamFn>[2];

type GooglePromptCacheEntry = {
  timestamp: number;
  provider: string;
  modelId: string;
  modelApi?: string | null;
  baseUrl: string;
  systemPromptDigest: string;
  cacheConfigDigest?: string;
  cacheRetention: CacheRetention;
} & (
  | {
      status: "ready";
      cachedContent: string;
      expireTime?: string;
    }
  | {
      status: "failed";
      retryAfter: number;
      statusCode?: number;
      errorMessage?: string;
    }
);

type PrepareGooglePromptCacheStreamFnParams = {
  apiKey?: string;
  extraParams?: Record<string, unknown>;
  model: GooglePromptCacheModel;
  modelId: string;
  provider: string;
  sessionManager: GooglePromptCacheSessionManager;
  signal?: AbortSignal;
  streamFn: StreamFn | undefined;
  systemPrompt?: string;
};

type GooglePromptCacheDeps = {
  buildGuardedFetch?: typeof buildGuardedModelFetch;
  now?: () => number;
};

function resolveGooglePromptCacheTtl(cacheRetention: CacheRetention): string {
  return cacheRetention === "long" ? "3600s" : "300s";
}

function resolveGooglePromptCacheRefreshWindowMs(cacheRetention: CacheRetention): number {
  return cacheRetention === "long"
    ? GOOGLE_PROMPT_CACHE_LONG_REFRESH_WINDOW_MS
    : GOOGLE_PROMPT_CACHE_SHORT_REFRESH_WINDOW_MS;
}

function digestSystemPrompt(systemPrompt: string): string {
  return crypto.createHash("sha256").update(systemPrompt).digest("hex");
}

function resolveManagedSystemPrompt(systemPrompt: string | undefined): string | undefined {
  const stripped =
    typeof systemPrompt === "string" ? stripSystemPromptCacheBoundary(systemPrompt) : "";
  const sanitized = sanitizeTransportPayloadText(stripped);
  return sanitized.trim() ? sanitized : undefined;
}

function resolveExplicitCachedContent(
  extraParams: Record<string, unknown> | undefined,
): string | undefined {
  const raw =
    typeof extraParams?.cachedContent === "string"
      ? extraParams.cachedContent
      : typeof extraParams?.cached_content === "string"
        ? extraParams.cached_content
        : undefined;
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

function buildGooglePromptCacheMatchKey(params: {
  provider: string;
  modelId: string;
  modelApi?: string | null;
  baseUrl: string;
  systemPromptDigest: string;
  cacheConfigDigest?: string;
}) {
  return stableStringify(params);
}

function stringifyGooglePromptCacheKeyPart(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return "";
}

function readLatestGooglePromptCacheEntry(
  sessionManager: GooglePromptCacheSessionManager,
  matchKey: string,
): GooglePromptCacheEntry | null {
  try {
    const entries = sessionManager.getEntries();
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const entry = entries[i];
      if (entry?.type !== "custom" || entry?.customType !== GOOGLE_PROMPT_CACHE_CUSTOM_TYPE) {
        continue;
      }
      const data = entry.data;
      if (!data || typeof data !== "object") {
        continue;
      }
      const cacheData = data as Record<string, unknown>;
      const candidateKey = buildGooglePromptCacheMatchKey({
        provider: stringifyGooglePromptCacheKeyPart(cacheData.provider),
        modelId: stringifyGooglePromptCacheKeyPart(cacheData.modelId),
        modelApi:
          typeof cacheData.modelApi === "string" || cacheData.modelApi == null
            ? cacheData.modelApi
            : null,
        baseUrl: stringifyGooglePromptCacheKeyPart(cacheData.baseUrl),
        systemPromptDigest: stringifyGooglePromptCacheKeyPart(cacheData.systemPromptDigest),
        cacheConfigDigest:
          typeof cacheData.cacheConfigDigest === "string" ? cacheData.cacheConfigDigest : undefined,
      });
      if (candidateKey === matchKey) {
        return data as GooglePromptCacheEntry;
      }
    }
  } catch {
    return null;
  }
  return null;
}

async function appendGooglePromptCacheEntry(
  sessionManager: GooglePromptCacheSessionManager,
  entry: GooglePromptCacheEntry,
): Promise<void> {
  try {
    await sessionManager.appendCustomEntry(GOOGLE_PROMPT_CACHE_CUSTOM_TYPE, entry);
  } catch (err) {
    if (err instanceof EmbeddedAttemptSessionTakeoverError || isSessionWriteLockAcquireError(err)) {
      throw err;
    }
    // ignore persistence failures
  }
}

function parseExpireTimeMs(expireTime: string | undefined): number | null {
  if (!expireTime) {
    return null;
  }
  return asDateTimestampMs(Date.parse(expireTime)) ?? null;
}

function convertManagedGoogleTools(tools: NonNullable<GooglePromptCacheContext["tools"]>) {
  if (tools.length === 0) {
    return undefined;
  }
  return [
    {
      functionDeclarations: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parametersJsonSchema: tool.parameters,
      })),
    },
  ];
}

function mapManagedGoogleToolChoice(
  choice: unknown,
): { mode: "AUTO" | "NONE" | "ANY"; allowedFunctionNames?: string[] } | undefined {
  if (!choice) {
    return undefined;
  }
  if (
    typeof choice === "object" &&
    choice !== null &&
    (choice as { type?: unknown }).type === "function"
  ) {
    const functionName = (choice as { function?: { name?: unknown } }).function?.name;
    return typeof functionName === "string"
      ? { mode: "ANY", allowedFunctionNames: [functionName] }
      : { mode: "ANY" };
  }
  switch (choice) {
    case "none":
      return { mode: "NONE" };
    case "any":
    case "required":
      return { mode: "ANY" };
    default:
      return { mode: "AUTO" };
  }
}

function buildManagedGooglePromptCacheConfig(
  context: GooglePromptCacheContext,
  options: GooglePromptCacheOptions,
) {
  const tools = context.tools?.length ? convertManagedGoogleTools(context.tools) : undefined;
  const toolChoice = tools
    ? mapManagedGoogleToolChoice((options as { toolChoice?: unknown } | undefined)?.toolChoice)
    : undefined;
  const toolConfig = toolChoice ? { functionCallingConfig: toolChoice } : undefined;
  const cacheConfigDigest =
    tools || toolConfig
      ? stableStringify({
          tools,
          toolConfig,
        })
      : undefined;
  return {
    cacheConfigDigest,
    tools,
    toolConfig,
  };
}

function buildManagedContextForCachedContent(context: GooglePromptCacheContext) {
  if (!context.systemPrompt && !context.tools?.length) {
    return context;
  }
  return {
    ...context,
    systemPrompt: undefined,
    tools: undefined,
  };
}

async function updateGooglePromptCacheTtl(params: {
  apiKey: string;
  baseUrl: string;
  cacheRetention: CacheRetention;
  cachedContent: string;
  fetchImpl: typeof fetch;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}): Promise<{ expireTime?: string } | null> {
  const response = await params.fetchImpl(
    `${params.baseUrl}/${params.cachedContent}?updateMask=ttl`,
    {
      method: "PATCH",
      headers: mergeTransportHeaders(parseGeminiAuth(params.apiKey).headers, params.headers),
      body: JSON.stringify({
        ttl: resolveGooglePromptCacheTtl(params.cacheRetention),
      }),
      signal: params.signal,
    },
  );
  if (!response.ok) {
    return null;
  }
  const json = (await response.json()) as { expireTime?: string };
  return json;
}

async function createGooglePromptCache(params: {
  apiKey: string;
  baseUrl: string;
  cacheRetention: CacheRetention;
  fetchImpl: typeof fetch;
  headers?: Record<string, string>;
  modelId: string;
  signal?: AbortSignal;
  systemPrompt: string;
  tools?: unknown;
  toolConfig?: unknown;
}): Promise<{ cachedContent: string; expireTime?: string } | null> {
  const response = await params.fetchImpl(`${params.baseUrl}/cachedContents`, {
    method: "POST",
    headers: mergeTransportHeaders(parseGeminiAuth(params.apiKey).headers, params.headers),
    body: JSON.stringify({
      model: params.modelId.startsWith("models/") ? params.modelId : `models/${params.modelId}`,
      ttl: resolveGooglePromptCacheTtl(params.cacheRetention),
      systemInstruction: {
        parts: [{ text: params.systemPrompt }],
      },
      ...(params.tools ? { tools: params.tools } : {}),
      ...(params.toolConfig ? { toolConfig: params.toolConfig } : {}),
    }),
    signal: params.signal,
  });
  if (!response.ok) {
    return null;
  }
  const json = (await response.json()) as { name?: string; expireTime?: string };
  const cachedContent = normalizeOptionalString(json.name) ?? "";
  return cachedContent ? { cachedContent, expireTime: json.expireTime } : null;
}

async function ensureGooglePromptCache(
  params: {
    apiKey: string;
    cacheRetention: CacheRetention;
    model: GooglePromptCacheModel;
    provider: string;
    cacheConfigDigest?: string;
    sessionManager: GooglePromptCacheSessionManager;
    signal?: AbortSignal;
    systemPrompt: string;
    tools?: unknown;
    toolConfig?: unknown;
  },
  deps: GooglePromptCacheDeps,
): Promise<string | null> {
  const baseUrl = normalizeGoogleApiBaseUrl(params.model.baseUrl);
  const now = asDateTimestampMs(deps.now?.() ?? Date.now());
  if (now === undefined) {
    return null;
  }
  const systemPromptDigest = digestSystemPrompt(params.systemPrompt);
  const matchKey = buildGooglePromptCacheMatchKey({
    provider: params.provider,
    modelId: params.model.id,
    modelApi: params.model.api,
    baseUrl,
    systemPromptDigest,
    cacheConfigDigest: params.cacheConfigDigest,
  });
  const latestEntry = readLatestGooglePromptCacheEntry(params.sessionManager, matchKey);

  if (
    latestEntry?.status === "failed" &&
    isFutureDateTimestampMs(latestEntry.retryAfter, { nowMs: now })
  ) {
    return null;
  }

  const fetchImpl = (deps.buildGuardedFetch ?? buildGuardedModelFetch)(params.model);
  const refreshWindowMs = resolveGooglePromptCacheRefreshWindowMs(params.cacheRetention);
  if (latestEntry?.status === "ready" && latestEntry.cachedContent) {
    const expiresAt = parseExpireTimeMs(latestEntry.expireTime);
    const isExpired = expiresAt !== null && !isFutureDateTimestampMs(expiresAt, { nowMs: now });
    if (!isExpired) {
      const needsRefresh = expiresAt !== null && expiresAt - now <= refreshWindowMs;
      if (!needsRefresh) {
        return latestEntry.cachedContent;
      }
      const refreshed = await updateGooglePromptCacheTtl({
        apiKey: params.apiKey,
        baseUrl,
        cacheRetention: params.cacheRetention,
        cachedContent: latestEntry.cachedContent,
        fetchImpl,
        headers: params.model.headers,
        signal: params.signal,
      }).catch(() => null);
      if (refreshed) {
        await appendGooglePromptCacheEntry(params.sessionManager, {
          status: "ready",
          timestamp: now,
          provider: params.provider,
          modelId: params.model.id,
          modelApi: params.model.api,
          baseUrl,
          systemPromptDigest,
          cacheConfigDigest: params.cacheConfigDigest,
          cacheRetention: params.cacheRetention,
          cachedContent: latestEntry.cachedContent,
          expireTime: refreshed.expireTime ?? latestEntry.expireTime,
        });
        return latestEntry.cachedContent;
      }
      return latestEntry.cachedContent;
    }
  }

  const created = await createGooglePromptCache({
    apiKey: params.apiKey,
    baseUrl,
    cacheRetention: params.cacheRetention,
    fetchImpl,
    headers: params.model.headers,
    modelId: params.model.id,
    signal: params.signal,
    systemPrompt: params.systemPrompt,
    tools: params.tools,
    toolConfig: params.toolConfig,
  });
  if (!created) {
    await appendGooglePromptCacheEntry(params.sessionManager, {
      status: "failed",
      timestamp: now,
      provider: params.provider,
      modelId: params.model.id,
      modelApi: params.model.api,
      baseUrl,
      systemPromptDigest,
      cacheConfigDigest: params.cacheConfigDigest,
      cacheRetention: params.cacheRetention,
      retryAfter:
        resolveExpiresAtMsFromDurationMs(GOOGLE_PROMPT_CACHE_RETRY_BACKOFF_MS, { nowMs: now }) ?? 0,
    });
    return null;
  }

  await appendGooglePromptCacheEntry(params.sessionManager, {
    status: "ready",
    timestamp: now,
    provider: params.provider,
    modelId: params.model.id,
    modelApi: params.model.api,
    baseUrl,
    systemPromptDigest,
    cacheConfigDigest: params.cacheConfigDigest,
    cacheRetention: params.cacheRetention,
    cachedContent: created.cachedContent,
    expireTime: created.expireTime,
  });
  return created.cachedContent;
}

export async function prepareGooglePromptCacheStreamFn(
  params: PrepareGooglePromptCacheStreamFnParams,
  deps: GooglePromptCacheDeps = {},
): Promise<StreamFn | undefined> {
  if (!params.streamFn) {
    return undefined;
  }
  if (resolveExplicitCachedContent(params.extraParams)) {
    return undefined;
  }
  if (!isGooglePromptCacheEligible({ modelApi: params.model.api, modelId: params.modelId })) {
    return undefined;
  }
  const resolvedRetention = resolveCacheRetention(
    params.extraParams,
    params.provider,
    params.model.api,
    params.modelId,
  );
  if (resolvedRetention !== "short" && resolvedRetention !== "long") {
    return undefined;
  }
  const systemPrompt = resolveManagedSystemPrompt(params.systemPrompt);
  const apiKey = params.apiKey?.trim();
  if (!systemPrompt || !apiKey) {
    return undefined;
  }

  const inner = params.streamFn;
  return async (model, context, options) => {
    const cacheConfig = buildManagedGooglePromptCacheConfig(context, options);
    const cachedContent = await ensureGooglePromptCache(
      {
        apiKey,
        cacheConfigDigest: cacheConfig.cacheConfigDigest,
        cacheRetention: resolvedRetention,
        model: params.model,
        provider: params.provider,
        sessionManager: params.sessionManager,
        signal: params.signal,
        systemPrompt,
        tools: cacheConfig.tools,
        toolConfig: cacheConfig.toolConfig,
      },
      deps,
    );
    if (!cachedContent) {
      log.debug(
        `google prompt cache unavailable for ${params.provider}/${params.modelId}; continuing without cachedContent`,
      );
      return inner(model, context, options);
    }

    return streamWithPayloadPatch(
      inner,
      model,
      buildManagedContextForCachedContent(context),
      options,
      (payload) => {
        payload.cachedContent = cachedContent;
      },
    );
  };
}
