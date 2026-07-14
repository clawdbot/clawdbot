import { resolveAgentIdentity } from "../../agents/identity.js";
import { deriveContextPromptTokens, type NormalizedUsage } from "../../agents/usage.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { PluginHookReplyUsageState } from "../../plugins/hook-types.js";
import { estimateUsageCost, resolveModelCostConfig } from "../../utils/usage-format.js";

const TTL_MS = 5 * 60_000;

const store = new Map<string, { snapshot: PluginHookReplyUsageState; expiresAt: number }>();

export function buildReplyUsageState(params: {
  config: OpenClawConfig;
  provider?: string;
  model?: string;
  fallbackExhausted?: boolean;
  winnerProvider?: string;
  winnerModel?: string;
  reasoningEffort?: string;
  fastMode?: boolean;
  fallbackUsed?: boolean;
  agentId: string;
  sessionId: string;
  chatType?: string;
  authMode?: string;
  overrideSource?: string;
  requestedProvider?: string;
  requestedModel?: string;
  compactionCount?: number;
  contextTokenBudget?: number;
  contextUsedTokens?: number;
  promptTokens?: number;
  usage?: NormalizedUsage;
  lastCallUsage?: NormalizedUsage;
  durationMs?: number;
}): PluginHookReplyUsageState {
  const resolvedProvider = params.fallbackExhausted ? undefined : params.winnerProvider;
  const resolvedModel = params.fallbackExhausted ? undefined : params.winnerModel;
  const hasBillableUsageBuckets =
    params.usage &&
    (params.usage.input !== undefined ||
      params.usage.output !== undefined ||
      params.usage.cacheRead !== undefined ||
      params.usage.cacheWrite !== undefined);
  return {
    provider: params.provider,
    model: params.model,
    resolvedRef:
      resolvedProvider && resolvedModel ? `${resolvedProvider}/${resolvedModel}` : undefined,
    reasoningEffort: params.reasoningEffort,
    fastMode: params.fastMode,
    fallbackUsed: params.fallbackUsed,
    agentId: params.agentId,
    sessionId: params.sessionId,
    chatType: params.chatType,
    authMode: params.authMode,
    overrideSource: params.overrideSource,
    requested:
      params.requestedProvider && params.requestedModel
        ? `${params.requestedProvider}/${params.requestedModel}`
        : undefined,
    turnUsd: hasBillableUsageBuckets
      ? estimateUsageCost({
          usage: params.usage,
          cost: resolveModelCostConfig({
            provider: params.provider,
            model: params.model,
            config: params.config,
          }),
        })
      : undefined,
    durationMs: params.durationMs,
    identity: resolveAgentIdentity(params.config, params.agentId),
    compactionCount: params.compactionCount,
    contextTokenBudget:
      typeof params.contextTokenBudget === "number" && Number.isFinite(params.contextTokenBudget)
        ? params.contextTokenBudget
        : undefined,
    contextUsedTokens:
      typeof params.contextUsedTokens === "number" && Number.isFinite(params.contextUsedTokens)
        ? params.contextUsedTokens
        : deriveContextPromptTokens({
            lastCallUsage: params.lastCallUsage,
            promptTokens: params.promptTokens,
            usage: params.usage,
          }),
    usage: params.usage
      ? {
          input: params.usage.input,
          output: params.usage.output,
          cacheRead: params.usage.cacheRead,
          cacheWrite: params.usage.cacheWrite,
          total: params.usage.total,
        }
      : undefined,
    lastUsage: params.lastCallUsage
      ? {
          input: params.lastCallUsage.input,
          output: params.lastCallUsage.output,
          cacheRead: params.lastCallUsage.cacheRead,
          cacheWrite: params.lastCallUsage.cacheWrite,
          total: params.lastCallUsage.total,
        }
      : undefined,
  };
}

function prune(now: number): void {
  for (const [key, value] of store) {
    if (value.expiresAt < now) {
      store.delete(key);
    }
  }
}

export function recordReplyUsageState(
  runId: string | undefined,
  snapshot: PluginHookReplyUsageState,
): void {
  if (!runId) {
    return;
  }
  const now = Date.now();
  store.set(runId, { snapshot, expiresAt: now + TTL_MS });
  prune(now);
}

export function consumeReplyUsageState(runId?: string): PluginHookReplyUsageState | undefined {
  if (!runId) {
    return undefined;
  }
  const value = store.get(runId);
  return value && value.expiresAt >= Date.now() ? value.snapshot : undefined;
}
