import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { joinPresentTextSegments } from "../../../shared/text/join-segments.js";
import { normalizeStructuredPromptSection } from "../../prompt-cache-stability.js";
import { resolveProviderEndpoint } from "../../provider-attribution.js";

export const ATTEMPT_CACHE_TTL_CUSTOM_TYPE = "openclaw.cache-ttl";

export function composeSystemPromptWithHookContext(params: {
  baseSystemPrompt?: string;
  prependSystemContext?: string;
  appendSystemContext?: string;
}): string | undefined {
  const prependSystem =
    typeof params.prependSystemContext === "string"
      ? normalizeStructuredPromptSection(params.prependSystemContext)
      : "";
  const appendSystem =
    typeof params.appendSystemContext === "string"
      ? normalizeStructuredPromptSection(params.appendSystemContext)
      : "";
  if (!prependSystem && !appendSystem) {
    return undefined;
  }
  return joinPresentTextSegments([prependSystem, params.baseSystemPrompt, appendSystem], {
    trim: true,
  });
}

export function resolveAttemptSpawnWorkspaceDir(params: {
  sandbox?: {
    enabled?: boolean;
    workspaceAccess?: string;
  } | null;
  resolvedWorkspace: string;
}): string | undefined {
  return params.sandbox?.enabled && params.sandbox.workspaceAccess !== "rw"
    ? params.resolvedWorkspace
    : undefined;
}

export function shouldUseOpenAIWebSocketTransport(params: {
  provider: string;
  modelApi?: string | null;
  modelBaseUrl?: string | null;
}): boolean {
  if (params.modelApi !== "openai-responses" || params.provider !== "openai") {
    return false;
  }

  // openai-codex normalizes to the ChatGPT backend HTTP path, not the public
  // OpenAI Responses websocket endpoint. Local mocks, proxies, and custom
  // baseUrls must stay on HTTP because the websocket runtime targets the
  // native api.openai.com endpoint directly.
  const endpointClass = resolveProviderEndpoint(params.modelBaseUrl).endpointClass;
  return endpointClass === "default" || endpointClass === "openai-public";
}

function hasExplicitSseTransport(sources: Array<Record<string, unknown> | undefined>): boolean {
  return sources.some((source) => {
    const transport = typeof source?.transport === "string" ? source.transport : "";
    return transport.trim().toLowerCase() === "sse";
  });
}

export function shouldUseOpenAIWebSocketTransportForAttempt(params: {
  provider: string;
  modelApi?: string | null;
  modelBaseUrl?: string | null;
  streamParams?: Record<string, unknown>;
  effectiveExtraParams?: Record<string, unknown>;
  modelParams?: Record<string, unknown>;
}): boolean {
  if (
    hasExplicitSseTransport([params.streamParams, params.effectiveExtraParams, params.modelParams])
  ) {
    return false;
  }
  return shouldUseOpenAIWebSocketTransport(params);
}

function shouldAppendAttemptCacheTtl(params: {
  timedOutDuringCompaction: boolean;
  compactionOccurredThisAttempt: boolean;
  config?: OpenClawConfig;
  provider: string;
  modelId: string;
  modelApi?: string;
  isCacheTtlEligibleProvider: (provider: string, modelId: string, modelApi?: string) => boolean;
}): boolean {
  if (params.timedOutDuringCompaction || params.compactionOccurredThisAttempt) {
    return false;
  }
  return (
    params.config?.agents?.defaults?.contextPruning?.mode === "cache-ttl" &&
    params.isCacheTtlEligibleProvider(params.provider, params.modelId, params.modelApi)
  );
}

export function appendAttemptCacheTtlIfNeeded(params: {
  sessionManager: {
    appendCustomEntry?: (customType: string, data: unknown) => void;
  };
  timedOutDuringCompaction: boolean;
  compactionOccurredThisAttempt: boolean;
  config?: OpenClawConfig;
  provider: string;
  modelId: string;
  modelApi?: string;
  isCacheTtlEligibleProvider: (provider: string, modelId: string, modelApi?: string) => boolean;
  now?: number;
}): boolean {
  if (!shouldAppendAttemptCacheTtl(params)) {
    return false;
  }
  params.sessionManager.appendCustomEntry?.(ATTEMPT_CACHE_TTL_CUSTOM_TYPE, {
    timestamp: params.now ?? Date.now(),
    provider: params.provider,
    modelId: params.modelId,
  });
  return true;
}

export function shouldPersistCompletedBootstrapTurn(params: {
  shouldRecordCompletedBootstrapTurn: boolean;
  promptError: unknown;
  aborted: boolean;
  timedOutDuringCompaction: boolean;
  compactionOccurredThisAttempt: boolean;
}): boolean {
  if (!params.shouldRecordCompletedBootstrapTurn || params.promptError || params.aborted) {
    return false;
  }
  if (params.timedOutDuringCompaction || params.compactionOccurredThisAttempt) {
    return false;
  }
  return true;
}
