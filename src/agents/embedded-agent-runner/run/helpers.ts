/**
 * Shared run helpers for retry limits, model reporting, and final text.
 */
import { generateSecureToken } from "../../../infra/secure-random.js";
import type { AssistantMessage } from "../../../llm/types.js";
import { extractAssistantTextForPhase } from "../../../shared/chat-message-content.js";
import { extractAssistantVisibleText } from "../../embedded-agent-utils.js";
import {
  deriveContextPromptTokens,
  hasNonzeroUsage,
  normalizeUsage,
  type ContextUsage,
  type NormalizedUsage,
} from "../../usage.js";
import type { EmbeddedAgentMeta } from "../types.js";
import { toNormalizedUsage, type UsageAccumulator } from "../usage-accumulator.js";

type UsageSnapshot = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  contextUsage?: ContextUsage;
  total?: number;
};

export type RuntimeAuthState = {
  generation: number;
  sourceApiKey: string;
  authMode: string;
  profileId?: string;
  expiresAt?: number;
  refreshTimer?: ReturnType<typeof setTimeout>;
  refreshInFlight?: Promise<void>;
};

export const RUNTIME_AUTH_REFRESH_MARGIN_MS = 5 * 60 * 1000;
export const RUNTIME_AUTH_REFRESH_RETRY_MS = 60 * 1000;
export const RUNTIME_AUTH_REFRESH_MIN_DELAY_MS = 5 * 1000;

const DEFAULT_OVERLOAD_FAILOVER_BACKOFF_MS = 0;
const DEFAULT_MAX_OVERLOAD_PROFILE_ROTATIONS = 1;
const DEFAULT_MAX_RATE_LIMIT_PROFILE_ROTATIONS = 1;

// Same-model in-place rate_limit retry: provider RPM caps reset on a
// minute scale, so wait out the current provider/model window before spending
// a profile rotation or model failover.
export const MAX_SAME_MODEL_RATE_LIMIT_RETRIES = 3;
// Linear step: retriesSoFar=0 -> 10s, 1 -> 20s, 2 -> 30s. Total wait across the
// 3-retry budget is 60s, roughly one RPM window.
const SAME_MODEL_RATE_LIMIT_BACKOFF_STEP_MS = 10_000;
const SAME_MODEL_RATE_LIMIT_MAX_BACKOFF_MS = 60_000;

export function resolveOverloadFailoverBackoffMs(): number {
  return DEFAULT_OVERLOAD_FAILOVER_BACKOFF_MS;
}

export function resolveOverloadProfileRotationLimit(): number {
  return DEFAULT_MAX_OVERLOAD_PROFILE_ROTATIONS;
}

export function resolveRateLimitProfileRotationLimit(): number {
  return DEFAULT_MAX_RATE_LIMIT_PROFILE_ROTATIONS;
}

/**
 * Backoff before the next same-model rate_limit retry, given how many such
 * retries already happened. Linear and deterministic (no jitter) so RPM
 * windows clear predictably and tests can assert exact values.
 */
export function resolveSameModelRateLimitRetryDelayMs(params: {
  retriesSoFar: number;
  retryAfterSeconds?: number;
}): number {
  const backoffDelayMs =
    SAME_MODEL_RATE_LIMIT_BACKOFF_STEP_MS * (Math.max(0, params.retriesSoFar) + 1);
  const backoffMs = Math.min(SAME_MODEL_RATE_LIMIT_MAX_BACKOFF_MS, backoffDelayMs);
  const retryAfterMs = Number.isFinite(params.retryAfterSeconds)
    ? Math.ceil(Math.max(0, params.retryAfterSeconds ?? 0) * 1000)
    : 0;
  return Math.max(backoffMs, Math.min(SAME_MODEL_RATE_LIMIT_MAX_BACKOFF_MS, retryAfterMs));
}

export function resolveNextSameModelRateLimitRetryCount(params: {
  retriesSoFar: number;
  retriedSameModelRateLimit: boolean;
}): number {
  return params.retriedSameModelRateLimit ? Math.max(0, params.retriesSoFar) + 1 : 0;
}

const ANTHROPIC_MAGIC_STRING_TRIGGER_REFUSAL = "ANTHROPIC_MAGIC_STRING_TRIGGER_REFUSAL";
const ANTHROPIC_MAGIC_STRING_REPLACEMENT = "[redacted]";

// Keep the replacement neutral: naming the refusal trigger can itself prompt a refusal.
function scrubAnthropicRefusalMagic(prompt: string): string {
  if (!prompt.includes(ANTHROPIC_MAGIC_STRING_TRIGGER_REFUSAL)) {
    return prompt;
  }
  return prompt.replaceAll(
    ANTHROPIC_MAGIC_STRING_TRIGGER_REFUSAL,
    ANTHROPIC_MAGIC_STRING_REPLACEMENT,
  );
}

/** Anthropic's transport interprets this marker even for native-owned attempts. */
export function resolveEmbeddedAttemptBasePrompt(params: {
  provider: string;
  prompt: string;
}): string {
  if (params.provider !== "anthropic") {
    return params.prompt;
  }
  return scrubAnthropicRefusalMagic(params.prompt);
}

export function createRunRecoveryDiagId(): string {
  return `ovf-${Date.now().toString(36)}-${generateSecureToken(4)}`;
}

const BASE_RUN_RETRY_ITERATIONS = 24;
const RUN_RETRY_ITERATIONS_PER_PROFILE = 8;
const MIN_RUN_RETRY_ITERATIONS = 32;
const MAX_RUN_RETRY_ITERATIONS = 160;

// This per-run bound multiplies whole-turn overload replays in
// auto-reply/reply/agent-runner-error-handler.ts; keep their product test aligned.
// Defensive guard for the outer run loop across all retry branches.
export function resolveMaxRunRetryIterations(profileCandidateCount: number): number {
  const scaled =
    BASE_RUN_RETRY_ITERATIONS +
    Math.max(1, profileCandidateCount) * RUN_RETRY_ITERATIONS_PER_PROFILE;
  return Math.min(MAX_RUN_RETRY_ITERATIONS, Math.max(MIN_RUN_RETRY_ITERATIONS, scaled));
}

export function resolveActiveErrorContext(params: {
  provider: string;
  model: string;
  assistant?: { provider?: string; model?: string };
}): {
  provider: string;
  model: string;
} {
  return resolveReportedModelRef(params);
}

export function isAssistantForModelRef(
  assistant: { provider?: string; model?: string } | undefined,
  ref: { provider: string; model: string },
): boolean {
  if (!assistant) {
    return false;
  }
  const resolved = resolveReportedModelRef({
    ...ref,
    assistant,
  });
  return resolved.provider === ref.provider && resolved.model === ref.model;
}

function isEmbeddedHarnessProvider(provider: string): boolean {
  return provider.trim().toLowerCase() === "openclaw";
}

export function resolveReportedModelRef(params: {
  provider: string;
  model: string;
  assistant?: { provider?: string; model?: string } | null;
}): {
  provider: string;
  model: string;
} {
  const assistantProvider = params.assistant?.provider?.trim();
  const assistantModel = params.assistant?.model?.trim();
  if (!assistantProvider) {
    return {
      provider: params.provider,
      model: assistantModel || params.model,
    };
  }
  if (isEmbeddedHarnessProvider(assistantProvider)) {
    return {
      provider: params.provider,
      model: params.model,
    };
  }
  return {
    provider: assistantProvider,
    model: assistantModel || params.model,
  };
}

export function resolveLatestCallUsage(params: {
  currentAttemptCandidates: readonly (NormalizedUsage | undefined)[];
  carriedUsage: NormalizedUsage | undefined;
  transcriptFallback: NormalizedUsage | undefined;
}): {
  currentAttempt: NormalizedUsage | undefined;
  latest: NormalizedUsage | undefined;
} {
  const currentAttempt = params.currentAttemptCandidates.find(hasNonzeroUsage);
  const carriedUsage = hasNonzeroUsage(params.carriedUsage) ? params.carriedUsage : undefined;
  const transcriptFallback = hasNonzeroUsage(params.transcriptFallback)
    ? params.transcriptFallback
    : undefined;
  return {
    currentAttempt,
    latest: currentAttempt ?? carriedUsage ?? transcriptFallback,
  };
}

export function normalizeAssistantUsageForContext(
  assistant: { api?: string; usage?: unknown } | null | undefined,
): NormalizedUsage | undefined {
  if (
    assistant?.api === "cli" &&
    assistant.usage &&
    typeof assistant.usage === "object" &&
    !Array.isArray(assistant.usage) &&
    (assistant.usage as { contextUsage?: unknown }).contextUsage === undefined
  ) {
    return { contextUsage: { state: "unavailable" } };
  }
  return normalizeUsage(assistant?.usage as UsageSnapshot | undefined);
}

export function buildUsageAgentMetaFields(params: {
  usageAccumulator: UsageAccumulator;
  latestUsage?: UsageSnapshot | null;
  lastRunPromptUsage: UsageSnapshot | undefined;
}): Pick<EmbeddedAgentMeta, "usage" | "lastCallUsage" | "promptTokens"> {
  const usage = toNormalizedUsage(params.usageAccumulator);
  const latestUsage = normalizeUsage(params.latestUsage as never);
  const lastCallUsage = hasNonzeroUsage(latestUsage)
    ? latestUsage
    : hasNonzeroUsage(params.lastRunPromptUsage)
      ? params.lastRunPromptUsage
      : undefined;
  const promptTokens = deriveContextPromptTokens({
    lastCallUsage,
  });
  return {
    usage,
    lastCallUsage,
    promptTokens,
  };
}

/**
 * Build agentMeta for error return paths, preserving accumulated usage so that
 * session totalTokens reflects the actual context size rather than going stale.
 * Without this, error returns omit usage and the session keeps whatever
 * totalTokens was set by the previous successful run.
 */
export function buildErrorAgentMeta(params: {
  sessionId: string;
  sessionFile?: string;
  provider: string;
  model: string;
  credentialSource?: EmbeddedAgentMeta["credentialSource"];
  contextTokens?: number;
  usageAccumulator: UsageAccumulator;
  lastRunPromptUsage: UsageSnapshot | undefined;
  currentAttemptAssistant?: { api?: string; usage?: unknown } | null;
}): EmbeddedAgentMeta {
  const usageMeta = buildUsageAgentMetaFields({
    usageAccumulator: params.usageAccumulator,
    latestUsage: normalizeAssistantUsageForContext(params.currentAttemptAssistant),
    lastRunPromptUsage: params.lastRunPromptUsage,
  });
  return {
    sessionId: params.sessionId,
    ...(params.sessionFile ? { sessionFile: params.sessionFile } : {}),
    provider: params.provider,
    model: params.model,
    ...(params.credentialSource ? { credentialSource: params.credentialSource } : {}),
    ...(params.contextTokens ? { contextTokens: params.contextTokens } : {}),
    ...(params.contextTokens ? { contextTokensSource: "resolved" as const } : {}),
    ...(usageMeta.usage ? { usage: usageMeta.usage } : {}),
    ...(usageMeta.lastCallUsage ? { lastCallUsage: usageMeta.lastCallUsage } : {}),
    ...(usageMeta.promptTokens ? { promptTokens: usageMeta.promptTokens } : {}),
  };
}

export function resolveFinalAssistantVisibleText(
  lastAssistant: AssistantMessage | undefined,
): string | undefined {
  if (!lastAssistant) {
    return undefined;
  }
  const visibleText = extractAssistantVisibleText(lastAssistant).trim();
  return visibleText || undefined;
}

export function resolveFinalAssistantRawText(
  lastAssistant: AssistantMessage | undefined,
): string | undefined {
  if (!lastAssistant) {
    return undefined;
  }
  const finalAnswerText = extractAssistantTextForPhase(lastAssistant, { phase: "final_answer" });
  const rawText = (finalAnswerText ?? extractAssistantTextForPhase(lastAssistant) ?? "").trim();
  return rawText || undefined;
}
