/**
 * Shared helpers for live prompt-cache integration tests.
 */
import { getRuntimeConfig } from "../config/config.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { parseStrictInteger } from "../infra/parse-finite-number.js";
import { completeSimple } from "../llm/stream.js";
import type { Api, AssistantMessage, Model } from "../llm/types.js";
import { discoverAuthStorage, discoverModels } from "./agent-model-discovery.js";
import { resolveDefaultAgentDir } from "./agent-scope.js";
import { collectProviderApiKeys } from "./live-auth-keys.js";
import { isLiveTestEnabled } from "./live-test-helpers.js";
import {
  getApiKeyForModel,
  isMissingProviderAuthError,
  isProviderAuthError,
  requireApiKey,
} from "./model-auth.js";
import { normalizeProviderId, parseModelRef } from "./model-selection.js";
import { ensureOpenClawModelsJson } from "./models-config.js";
import { buildAssistantMessageWithZeroUsage } from "./stream-message-shared.js";

// Shared helpers for live prompt-cache regression tests. They resolve real
// provider credentials/models, wrap live calls with timeouts, and build stable
// cacheable prompts.
export const LIVE_CACHE_TEST_ENABLED =
  isLiveTestEnabled() && isTruthyEnvValue(process.env.OPENCLAW_LIVE_CACHE_TEST);

const DEFAULT_HEARTBEAT_MS = 20_000;
const DEFAULT_TIMEOUT_MS = 90_000;

export type LiveResolvedModel = {
  apiKey: string;
  model: Model;
};

export type LiveResolvedModelPool = {
  apiKeys: string[];
  fixture: LiveResolvedModel;
};

export class LiveCachePrerequisiteSkip extends Error {
  constructor(
    readonly provider: "anthropic" | "openai",
    reason: string,
  ) {
    super(reason);
    this.name = "LiveCachePrerequisiteSkip";
  }
}

/** Return whether an error is a live-cache prerequisite skip. */
export function isLiveCachePrerequisiteSkip(error: unknown): error is LiveCachePrerequisiteSkip {
  return error instanceof LiveCachePrerequisiteSkip;
}

/** Convert missing provider auth failures into skip errors for live tests. */
export function toLiveCachePrerequisiteSkip(
  provider: "anthropic" | "openai",
  error: unknown,
): LiveCachePrerequisiteSkip | undefined {
  if (isMissingProviderAuthError(error) || isProviderAuthError(error, "missing-provider-auth")) {
    return new LiveCachePrerequisiteSkip(provider, error.message);
  }
  return undefined;
}

function toInt(value: string | undefined, fallback: number): number {
  const trimmed = value?.trim();
  if (!trimmed) {
    return fallback;
  }
  return parseStrictInteger(trimmed) ?? fallback;
}

/** Write a namespaced live-cache progress line to stderr. */
export function logLiveCache(message: string): void {
  process.stderr.write(`[live-cache] ${message}\n`);
}

/** Wrap a live-cache operation with periodic progress logging. */
export async function withLiveCacheHeartbeat<T>(
  operation: Promise<T>,
  context: string,
): Promise<T> {
  const heartbeatMs = Math.max(
    1_000,
    toInt(process.env.OPENCLAW_LIVE_HEARTBEAT_MS, DEFAULT_HEARTBEAT_MS),
  );
  const startedAt = Date.now();
  let heartbeatCount = 0;
  const timer = setInterval(() => {
    heartbeatCount += 1;
    logLiveCache(
      `${context}: still running (${Math.max(1, Math.round((Date.now() - startedAt) / 1_000))}s)`,
    );
  }, heartbeatMs);
  timer.unref?.();
  try {
    return await operation;
  } finally {
    clearInterval(timer);
    if (heartbeatCount > 0) {
      logLiveCache(
        `${context}: completed (${Math.max(1, Math.round((Date.now() - startedAt) / 1_000))}s)`,
      );
    }
  }
}

/** Run completeSimple with abort and hard-timeout guards for live tests. */
export async function completeSimpleWithLiveTimeout<TApi extends Api>(
  model: Model<TApi>,
  context: Parameters<typeof completeSimple<TApi>>[1],
  options: Parameters<typeof completeSimple<TApi>>[2],
  progressContext: string,
  timeoutMs = Math.max(
    1_000,
    toInt(process.env.OPENCLAW_LIVE_MODEL_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
  ),
): Promise<AssistantMessage> {
  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), timeoutMs);
  abortTimer.unref?.();
  let hardTimer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    hardTimer = setTimeout(() => {
      reject(new Error(`${progressContext} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    hardTimer.unref?.();
  });
  try {
    return await withLiveCacheHeartbeat(
      Promise.race([
        completeSimple(model, context, {
          ...options,
          signal: controller.signal,
        }),
        timeout,
      ]),
      progressContext,
    );
  } finally {
    clearTimeout(abortTimer);
    if (hardTimer) {
      clearTimeout(hardTimer);
    }
  }
}

/** Build deterministic prompt text large enough to exercise provider prompt caches. */
export function buildStableCachePrefix(tag: string, sections = 160): string {
  const lines = [
    `Stable cache prefix for ${tag}.`,
    "Preserve this prefix byte-for-byte across retries.",
    "Return only the requested marker from the final user message.",
  ];
  for (let index = 0; index < sections; index += 1) {
    lines.push(
      `Section ${index + 1}: deterministic cache prose with repeated lexical material about routing, invariants, transcript stability, prefix locality, provider usage accounting, and session affinity.`,
    );
  }
  return lines.join("\n");
}

/** Extract normalized assistant text from a streamed/completed assistant message. */
export function extractAssistantText(message: AssistantMessage): string {
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join(" ");
}

/** Build a zero-usage assistant history turn for cache fixture setup. */
export function buildAssistantHistoryTurn(
  text: string,
  model?: Pick<Model, "api" | "provider" | "id">,
): AssistantMessage {
  return buildAssistantMessageWithZeroUsage({
    model: {
      api: model?.api ?? "openai-responses",
      provider: model?.provider ?? "openai",
      id: model?.id ?? "test-model",
    },
    content: [{ type: "text", text }],
    stopReason: "stop",
    timestamp: Date.now(),
  });
}

/** Compute cache-hit ratio from OpenClaw usage counters. */
export function computeCacheHitRate(usage: {
  input?: number;
  cacheRead?: number;
  cacheWrite?: number;
}): number {
  const input = usage.input ?? 0;
  const cacheRead = usage.cacheRead ?? 0;
  const cacheWrite = usage.cacheWrite ?? 0;
  const totalPrompt = input + cacheRead + cacheWrite;
  if (totalPrompt <= 0 || cacheRead <= 0) {
    return 0;
  }
  return cacheRead / totalPrompt;
}

/** Resolve a live provider model pool from env keys or configured auth storage. */
export async function resolveLiveDirectModelPool(params: {
  provider: "anthropic" | "openai";
  api: "anthropic-messages" | "openai-responses";
  envVar: string;
  preferredModelIds: readonly string[];
}): Promise<LiveResolvedModelPool> {
  const cfg = getRuntimeConfig();
  await ensureOpenClawModelsJson(cfg);
  const agentDir = resolveDefaultAgentDir(cfg);
  const authStorage = discoverAuthStorage(agentDir);
  const models = discoverModels(authStorage, agentDir).getAll();
  const candidates = models.filter(
    (model) => normalizeProviderId(model.provider) === params.provider && model.api === params.api,
  );
  const rawModel = process.env[params.envVar]?.trim();
  const parsed = rawModel ? parseModelRef(rawModel, params.provider) : null;
  const requestedModelId =
    parsed && normalizeProviderId(parsed.provider) === params.provider ? parsed.model : rawModel;
  const selectModel = (): Model | undefined => {
    if (parsed) {
      return candidates.find(
        (model) =>
          normalizeProviderId(model.provider) === parsed.provider && model.id === parsed.model,
      );
    }
    if (requestedModelId) {
      return candidates.find((model) => model.id === requestedModelId);
    }
    return params.preferredModelIds
      .map((id) => candidates.find((model) => model.id === id))
      .find(Boolean);
  };
  const liveKeys = collectProviderApiKeys(params.provider);
  if (liveKeys.length > 0) {
    // Explicit live env keys win because live regression lanes often inject
    // short-lived provider credentials outside profile storage.
    const selectedModel = selectModel();
    if (!selectedModel || selectedModel.api !== params.api) {
      const message = requestedModelId
        ? `Model not found for ${params.provider}: ${requestedModelId}`
        : `No built-in ${params.provider} ${params.api} model available.`;
      if (requestedModelId) {
        throw new Error(message);
      }
      throw new LiveCachePrerequisiteSkip(params.provider, message);
    }
    logLiveCache(`resolved ${params.provider} model ${selectedModel.id} from live env key`);
    return {
      apiKeys: liveKeys,
      fixture: {
        model: selectedModel,
        apiKey: liveKeys[0] ?? "",
      },
    };
  }

  logLiveCache(`resolving ${params.provider} model from configured auth storage`);
  const resolvedModel = selectModel();
  if (!resolvedModel) {
    const message = rawModel
      ? `Model not found for ${params.provider}: ${rawModel}`
      : `No ${params.provider} ${params.api} model available in registry.`;
    if (rawModel) {
      throw new Error(message);
    }
    throw new LiveCachePrerequisiteSkip(params.provider, message);
  }

  let apiKey: string;
  try {
    apiKey = requireApiKey(
      await getApiKeyForModel({
        model: resolvedModel,
        cfg,
        agentDir,
      }),
      resolvedModel.provider,
    );
  } catch (error) {
    const skip = toLiveCachePrerequisiteSkip(params.provider, error);
    if (skip) {
      throw skip;
    }
    throw error;
  }
  logLiveCache(
    `resolved ${params.provider} model ${resolvedModel.id} from configured auth storage`,
  );
  return {
    apiKeys: [apiKey],
    fixture: {
      model: resolvedModel,
      apiKey,
    },
  };
}

/** Resolve the first live direct model fixture for a provider. */
export async function resolveLiveDirectModel(
  params: Parameters<typeof resolveLiveDirectModelPool>[0],
): Promise<LiveResolvedModel> {
  return (await resolveLiveDirectModelPool(params)).fixture;
}

/** Return a copy of a live direct fixture with a specific API key. */
export function withLiveDirectModelApiKey(
  fixture: LiveResolvedModel,
  apiKey: string,
): LiveResolvedModel {
  return { ...fixture, apiKey };
}
