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

export const MAX_TRANSIENT_RETRIES = 8;
const MAX_TRANSIENT_RETRY_TIME_MS = 90_000;
const TRANSIENT_RETRY_BASE_DELAY_MS = 1_000;
const TRANSIENT_RETRY_MAX_DELAY_MS = 30_000;

/** Resolves jittered exponential backoff without exceeding the turn retry ceiling. */
export function resolveTransientRetryDelayMs(params: {
  retryNumber: number;
  retryAfterMs?: number;
  elapsedMs?: number;
}): number | undefined {
  const remainingMs =
    params.elapsedMs === undefined
      ? Infinity
      : MAX_TRANSIENT_RETRY_TIME_MS - Math.max(0, params.elapsedMs);
  // The header parser uses Infinity for a floor too large to represent safely.
  if (remainingMs <= 0 || params.retryAfterMs === Infinity) {
    return undefined;
  }
  const exponentialMs = Math.min(
    TRANSIENT_RETRY_MAX_DELAY_MS,
    TRANSIENT_RETRY_BASE_DELAY_MS * 2 ** Math.max(0, params.retryNumber - 1),
  );
  const jitteredMs = Math.min(
    TRANSIENT_RETRY_MAX_DELAY_MS,
    Math.round(exponentialMs * (0.5 + Math.random())),
  );
  const retryAfterMs = Number.isFinite(params.retryAfterMs)
    ? Math.max(0, Math.ceil(params.retryAfterMs ?? 0))
    : 0;
  const delayMs = Math.max(jitteredMs, retryAfterMs);
  return delayMs <= remainingMs ? delayMs : undefined;
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
}): Pick<EmbeddedAgentMeta, "usage" | "lastCallUsage" | "promptTokens" | "costUsd"> {
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
    ...(usage?.cost ? { costUsd: usage.cost.total } : {}),
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
    ...(usageMeta.costUsd !== undefined ? { costUsd: usageMeta.costUsd } : {}),
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
