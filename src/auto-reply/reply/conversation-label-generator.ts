// Generates short labels for sessions from conversation context.
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { runIsolatedCompletion } from "../../agents/isolated-completion.js";
import { splitTrailingAuthProfile } from "../../agents/model-ref-profile.js";
import { resolveSimpleCompletionSelectionForAgent } from "../../agents/simple-completion-runtime.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

const DEFAULT_MAX_LABEL_LENGTH = 128;
// Reasoning models spend output tokens before emitting the short visible label.
const CONVERSATION_LABEL_MAX_TOKENS = 4_096;
const TIMEOUT_MS = 15_000;

type LabelModelPhase = "utility" | "primary fallback";
type ConversationLabelAttempt = {
  modelRef?: string;
  useUtilityModel?: boolean;
  preferredProfile?: string;
};

/** Inputs for generating a short conversation label from the configured utility model. */
export type ConversationLabelParams = {
  userMessage: string;
  prompt: string;
  cfg: OpenClawConfig;
  agentId?: string;
  agentDir?: string;
  agentHarnessRuntimeOverride?: string;
  modelRef?: string;
  timeoutMs?: number;
  maxLength?: number;
};

type ConversationLabelFallbackParams = ConversationLabelParams & {
  utilityModelRef?: string;
  regularModelRef: string;
  preferredProfile?: string;
  normalizeLabel?: (label: string) => string | null;
};

function resolveMaxLabelLength(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : DEFAULT_MAX_LABEL_LENGTH;
}

function resolveTimeoutMs(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : TIMEOUT_MS;
}

function resolveAttemptSelection(params: {
  cfg: OpenClawConfig;
  agentId: string;
  agentDir?: string;
  attempt: ConversationLabelAttempt;
}) {
  return resolveSimpleCompletionSelectionForAgent({
    cfg: params.cfg,
    agentId: params.agentId,
    agentDir: params.agentDir,
    ...(params.attempt.modelRef ? { modelRef: params.attempt.modelRef } : {}),
    ...(params.attempt.useUtilityModel !== undefined
      ? { useUtilityModel: params.attempt.useUtilityModel }
      : {}),
  });
}

function resolveRawModelProvider(modelRef: string | undefined): string | undefined {
  const model = splitTrailingAuthProfile(modelRef?.trim() ?? "").model;
  const separator = model.indexOf("/");
  const provider = separator > 0 ? model.slice(0, separator).trim().toLowerCase() : "";
  return provider || undefined;
}

function resolveAttemptKey(params: {
  cfg: OpenClawConfig;
  agentId: string;
  agentDir?: string;
  attempt: ConversationLabelAttempt;
}): string {
  const selection = resolveAttemptSelection(params);
  if (selection) {
    return [
      "resolved",
      selection.provider,
      selection.runtimeProvider ?? "",
      selection.modelId,
      selection.profileId ?? params.attempt.preferredProfile ?? "",
    ].join("\0");
  }
  const rawRef = splitTrailingAuthProfile(params.attempt.modelRef?.trim() ?? "");
  return ["raw", rawRef.model, rawRef.profile ?? params.attempt.preferredProfile ?? ""].join("\0");
}

async function completeLabel(params: {
  cfg: OpenClawConfig;
  agentId: string;
  agentDir?: string;
  agentHarnessRuntimeOverride?: string;
  attempt: ConversationLabelAttempt;
  userMessage: string;
  prompt: string;
  timeoutMs: number;
  maxLength: number;
}): Promise<string | null> {
  const selection = resolveAttemptSelection(params);
  if (!selection) {
    throw new Error("conversation label model selection unavailable");
  }
  const completion = await runIsolatedCompletion({
    config: params.cfg,
    provider: selection.runtimeProvider ?? selection.provider,
    model: selection.modelId,
    authProfileId: selection.profileId ?? params.attempt.preferredProfile,
    agentId: params.agentId,
    agentDir: params.agentDir ?? selection.agentDir,
    ...(params.agentHarnessRuntimeOverride
      ? { agentHarnessRuntimeOverride: params.agentHarnessRuntimeOverride }
      : {}),
    systemPrompt: params.prompt,
    prompt: params.userMessage,
    timeoutMs: params.timeoutMs,
    streamParams: { maxTokens: CONVERSATION_LABEL_MAX_TOKENS },
  });
  return truncateUtf16Safe(completion.text.trim(), params.maxLength) || null;
}

async function runLabelAttempts(params: {
  cfg: OpenClawConfig;
  agentId: string;
  agentDir?: string;
  agentHarnessRuntimeOverride?: string;
  attempts: readonly ConversationLabelAttempt[];
  userMessage: string;
  prompt: string;
  timeoutMs: number;
  maxLength: number;
  normalizeLabel?: (label: string) => string | null;
}): Promise<string | null> {
  const seen = new Set<string>();
  const failures: LabelModelPhase[] = [];
  for (const [index, attempt] of params.attempts.entries()) {
    const key = resolveAttemptKey({ ...params, attempt });
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    try {
      const label = await completeLabel({ ...params, attempt });
      const normalized = label && params.normalizeLabel ? params.normalizeLabel(label) : label;
      if (normalized) {
        return normalized;
      }
    } catch {
      failures.push(index === params.attempts.length - 1 ? "primary fallback" : "utility");
    }
  }
  if (failures.length > 0) {
    // Keep provider errors and credentials out of logs while still recording the
    // owned operation that failed after every configured route was exhausted.
    throw new Error(`conversation label generation failed (${failures.join(", ")})`);
  }
  return null;
}

/** Generates a bounded human-readable label for a session, or null for empty output. */
export async function generateConversationLabel(
  params: ConversationLabelParams,
): Promise<string | null> {
  const agentId = params.agentId ?? resolveDefaultAgentId(params.cfg);
  const attempts: ConversationLabelAttempt[] = params.modelRef
    ? [{ modelRef: params.modelRef }]
    : [{ useUtilityModel: true }, { useUtilityModel: false }];
  return await runLabelAttempts({
    cfg: params.cfg,
    agentId,
    agentDir: params.agentDir,
    ...(params.agentHarnessRuntimeOverride
      ? { agentHarnessRuntimeOverride: params.agentHarnessRuntimeOverride }
      : {}),
    attempts,
    userMessage: params.userMessage,
    prompt: params.prompt,
    timeoutMs: resolveTimeoutMs(params.timeoutMs),
    maxLength: resolveMaxLabelLength(params.maxLength),
  });
}

/** Tries an explicit utility model once, then the regular model once when needed. */
export async function generateConversationLabelWithFallback(
  params: ConversationLabelFallbackParams,
): Promise<string | null> {
  const agentId = params.agentId ?? resolveDefaultAgentId(params.cfg);
  const regularAttempt: ConversationLabelAttempt = {
    modelRef: params.regularModelRef,
    ...(params.preferredProfile ? { preferredProfile: params.preferredProfile } : {}),
  };
  const utilityRef = params.utilityModelRef?.trim();
  let utilityAttempt: ConversationLabelAttempt | undefined;
  if (utilityRef) {
    const candidate: ConversationLabelAttempt = { modelRef: utilityRef };
    const utilitySelection = resolveAttemptSelection({
      cfg: params.cfg,
      agentId,
      agentDir: params.agentDir,
      attempt: candidate,
    });
    const regularSelection = resolveAttemptSelection({
      cfg: params.cfg,
      agentId,
      agentDir: params.agentDir,
      attempt: regularAttempt,
    });
    const utilityAuthProvider = utilitySelection?.provider ?? resolveRawModelProvider(utilityRef);
    const regularAuthProvider =
      regularSelection?.provider ?? resolveRawModelProvider(params.regularModelRef);
    const utilityRawProfile = splitTrailingAuthProfile(utilityRef).profile;
    const inheritsRegularProfile =
      params.preferredProfile &&
      !utilitySelection?.profileId &&
      !utilityRawProfile &&
      utilityAuthProvider &&
      utilityAuthProvider === regularAuthProvider;
    utilityAttempt = inheritsRegularProfile
      ? { modelRef: `${utilityRef}@${params.preferredProfile}` }
      : candidate;
  }
  return await runLabelAttempts({
    cfg: params.cfg,
    agentId,
    agentDir: params.agentDir,
    ...(params.agentHarnessRuntimeOverride
      ? { agentHarnessRuntimeOverride: params.agentHarnessRuntimeOverride }
      : {}),
    attempts: [...(utilityAttempt ? [utilityAttempt] : []), regularAttempt],
    userMessage: params.userMessage,
    prompt: params.prompt,
    timeoutMs: resolveTimeoutMs(params.timeoutMs),
    maxLength: resolveMaxLabelLength(params.maxLength),
    normalizeLabel: params.normalizeLabel,
  });
}
