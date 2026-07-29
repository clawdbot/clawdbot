// Generates short labels for sessions from conversation context.
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { splitTrailingAuthProfile } from "../../agents/model-ref-profile.js";
import {
  completeWithPreparedSimpleCompletionModel,
  prepareSimpleCompletionModelForAgent,
  resolveSimpleCompletionSelectionForAgent,
} from "../../agents/simple-completion-runtime.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import type { TextContent } from "../../llm/types.js";

const DEFAULT_MAX_LABEL_LENGTH = 128;
// Reasoning models spend output tokens before emitting the short visible label.
// A tiny cap can leave no text, so keep the bounded title budget large enough
// for reasoning while respecting models with a lower output limit.
const CONVERSATION_LABEL_MAX_TOKENS = 4_096;
const TIMEOUT_MS = 15_000;

type PreparedLabelModel = Awaited<ReturnType<typeof prepareSimpleCompletionModelForAgent>>;
type ReadyLabelModel = Extract<PreparedLabelModel, { model: unknown }>;
type LabelModelPhase = "utility" | "primary fallback";
type ConversationLabelAttempt = {
  modelRef?: string;
  useUtilityModel?: boolean;
  preferredProfile?: string;
  bindAuthOwner?: boolean;
};

/** Inputs for generating a short conversation label from the configured utility model. */
export type ConversationLabelParams = {
  userMessage: string;
  prompt: string;
  cfg: OpenClawConfig;
  agentId?: string;
  agentDir?: string;
  maxLength?: number;
};

type ConversationLabelFallbackParams = ConversationLabelParams & {
  utilityModelRef?: string;
  regularModelRef: string;
  preferredProfile?: string;
  normalizeLabel?: (label: string) => string | null;
};

function isTextContentBlock(block: { type: string }): block is TextContent {
  return block.type === "text";
}

function isCodexSimpleCompletionModel(model: { api?: string; provider?: string }): boolean {
  return model.api === "openai-chatgpt-responses";
}

function extractSimpleCompletionError(result: {
  stopReason?: string;
  errorMessage?: string;
}): string | null {
  if (result.stopReason !== "error") {
    return null;
  }
  return result.errorMessage?.trim() || "unknown error";
}

function resolveMaxLabelLength(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : DEFAULT_MAX_LABEL_LENGTH;
}

function logLabelFailure(phase: LabelModelPhase, message: string): void {
  const prefix = phase === "utility" ? "" : `${phase} `;
  logVerbose(`conversation-label-generator: ${prefix}${message}`);
}

async function prepareLabelModel(params: {
  cfg: OpenClawConfig;
  agentId: string;
  agentDir?: string;
  attempt: ConversationLabelAttempt;
  phase: LabelModelPhase;
}): Promise<PreparedLabelModel | null> {
  try {
    const prepared = await prepareSimpleCompletionModelForAgent({
      cfg: params.cfg,
      agentId: params.agentId,
      agentDir: params.agentDir,
      ...(params.attempt.modelRef ? { modelRef: params.attempt.modelRef } : {}),
      ...(params.attempt.useUtilityModel !== undefined
        ? { useUtilityModel: params.attempt.useUtilityModel }
        : {}),
      ...(params.attempt.preferredProfile
        ? { preferredProfile: params.attempt.preferredProfile }
        : {}),
      ...(params.attempt.bindAuthOwner !== undefined
        ? { bindAuthOwner: params.attempt.bindAuthOwner }
        : {}),
      useAsyncModelResolution: true,
      allowMissingApiKeyModes: ["aws-sdk"],
    });
    if ("error" in prepared) {
      logLabelFailure(params.phase, prepared.error);
    }
    return prepared;
  } catch (err) {
    logLabelFailure(params.phase, `model preparation failed: ${String(err)}`);
    return null;
  }
}

function selectedLabelModelsMatch(
  first: PreparedLabelModel | null,
  second: PreparedLabelModel | null,
): boolean {
  const firstSelection = first && "selection" in first ? first.selection : undefined;
  const secondSelection = second && "selection" in second ? second.selection : undefined;
  return Boolean(
    firstSelection &&
    secondSelection &&
    firstSelection.provider === secondSelection.provider &&
    firstSelection.runtimeProvider === secondSelection.runtimeProvider &&
    firstSelection.modelId === secondSelection.modelId &&
    firstSelection.profileId === secondSelection.profileId,
  );
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
  prepared: ReadyLabelModel;
  cfg: OpenClawConfig;
  userMessage: string;
  prompt: string;
  maxLength: number;
  phase: LabelModelPhase;
}): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const maxTokens = Math.min(
      CONVERSATION_LABEL_MAX_TOKENS,
      Math.floor(params.prepared.model.maxTokens),
    );
    // Label generation should never block normal reply handling for long.
    const result = await completeWithPreparedSimpleCompletionModel({
      model: params.prepared.model,
      auth: params.prepared.auth,
      cfg: params.cfg,
      context: {
        systemPrompt: params.prompt,
        messages: [
          {
            role: "user",
            content: params.userMessage,
            timestamp: Date.now(),
          },
        ],
      },
      options: {
        maxTokens,
        ...(isCodexSimpleCompletionModel(params.prepared.model) ? {} : { temperature: 0.3 }),
        signal: controller.signal,
      },
    });
    const errorMessage = extractSimpleCompletionError(result);
    if (errorMessage) {
      logLabelFailure(params.phase, `completion failed: ${errorMessage}`);
      return null;
    }

    const text = result.content
      .filter(isTextContentBlock)
      .map((block) => block.text)
      .join("")
      .trim();
    return text ? truncateUtf16Safe(text, params.maxLength) || null : null;
  } catch (err) {
    logLabelFailure(params.phase, `completion failed: ${String(err)}`);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/** Generates a bounded human-readable label for a session, or null on failure. */
export async function generateConversationLabel(
  params: ConversationLabelParams,
): Promise<string | null> {
  const { userMessage, prompt, cfg, agentId, agentDir } = params;
  const maxLength = resolveMaxLabelLength(params.maxLength);
  const resolvedAgentId = agentId ?? resolveDefaultAgentId(cfg);
  const utilityPrepared = await prepareLabelModel({
    cfg,
    agentId: resolvedAgentId,
    agentDir,
    attempt: { useUtilityModel: true },
    phase: "utility",
  });
  const utilityCompletionAttempted = Boolean(utilityPrepared && !("error" in utilityPrepared));
  if (utilityPrepared && !("error" in utilityPrepared)) {
    const label = await completeLabel({
      prepared: utilityPrepared,
      cfg,
      userMessage,
      prompt,
      maxLength,
      phase: "utility",
    });
    if (label) {
      return label;
    }
  }

  const primaryPrepared = await prepareLabelModel({
    cfg,
    agentId: resolvedAgentId,
    agentDir,
    attempt: { useUtilityModel: false },
    phase: "primary fallback",
  });
  if (
    !primaryPrepared ||
    "error" in primaryPrepared ||
    (utilityCompletionAttempted && selectedLabelModelsMatch(utilityPrepared, primaryPrepared))
  ) {
    return null;
  }
  return await completeLabel({
    prepared: primaryPrepared,
    cfg,
    userMessage,
    prompt,
    maxLength,
    phase: "primary fallback",
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
    bindAuthOwner: true,
  };
  const utilityRef = params.utilityModelRef?.trim();
  let utilityAttempt: ConversationLabelAttempt | undefined;
  if (utilityRef) {
    const candidate: ConversationLabelAttempt = { modelRef: utilityRef, bindAuthOwner: true };
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
      ? { modelRef: `${utilityRef}@${params.preferredProfile}`, bindAuthOwner: true }
      : candidate;
  }
  const attempts: ConversationLabelAttempt[] = [
    ...(utilityAttempt ? [utilityAttempt] : []),
    regularAttempt,
  ];
  const seen = new Set<string>();
  const maxLength = resolveMaxLabelLength(params.maxLength);
  let previousCompletedModel: PreparedLabelModel | null = null;
  for (const attempt of attempts) {
    const key = resolveAttemptKey({
      cfg: params.cfg,
      agentId,
      agentDir: params.agentDir,
      attempt,
    });
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const phase = attempt === regularAttempt ? "primary fallback" : "utility";
    const prepared = await prepareLabelModel({
      cfg: params.cfg,
      agentId,
      agentDir: params.agentDir,
      attempt,
      phase,
    });
    if (!prepared || "error" in prepared) {
      continue;
    }
    if (previousCompletedModel && selectedLabelModelsMatch(previousCompletedModel, prepared)) {
      continue;
    }
    previousCompletedModel = prepared;
    const label = await completeLabel({
      prepared,
      cfg: params.cfg,
      userMessage: params.userMessage,
      prompt: params.prompt,
      maxLength,
      phase,
    });
    if (label) {
      const normalized = params.normalizeLabel ? params.normalizeLabel(label) : label;
      if (normalized) {
        return normalized;
      }
    }
  }
  return null;
}
