import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { SessionManager } from "@mariozechner/pi-coding-agent";
import { stripInboundMetadata } from "../../auto-reply/reply/strip-inbound-meta.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ProviderRuntimeModel } from "../../plugins/provider-runtime-model.types.js";
import {
  sanitizeProviderReplayHistoryWithPlugin,
  validateProviderReplayTurnsWithPlugin,
} from "../../plugins/provider-runtime.js";
import type {
  ProviderReplaySessionEntry,
  ProviderReplaySessionState,
} from "../../plugins/types.js";
import {
  annotateInterSessionPromptText,
  hasInterSessionUserProvenance,
  normalizeInputProvenance,
} from "../../sessions/input-provenance.js";
import { resolveImageSanitizationLimits } from "../image-sanitization.js";
import {
  downgradeOpenAIFunctionCallReasoningPairs,
  downgradeOpenAIReasoningBlocks,
  sanitizeGoogleTurnOrdering,
  sanitizeSessionMessagesImages,
  validateAnthropicTurns,
  validateGeminiTurns,
} from "../pi-embedded-helpers.js";
import {
  sanitizeToolCallInputs,
  sanitizeToolUseResultPairing,
  stripToolResultDetails,
} from "../session-transcript-repair.js";
import { STREAM_ERROR_FALLBACK_TEXT } from "../stream-message-shared.js";
import { sanitizeToolCallIdsForCloudCodeAssist } from "../tool-call-id.js";
import type { TranscriptPolicy } from "../transcript-policy.js";
import {
  resolveTranscriptPolicy,
  shouldAllowProviderOwnedThinkingReplay,
} from "../transcript-policy.js";
import {
  makeZeroUsageSnapshot,
  normalizeUsage,
  type AssistantUsageSnapshot,
  type UsageLike,
} from "../usage.js";
import { isZeroUsageEmptyStopAssistantTurn } from "./empty-assistant-turn.js";
import {
  dropReasoningFromHistory,
  dropThinkingBlocks,
  stripInvalidThinkingSignatures,
} from "./thinking.js";

const MODEL_SNAPSHOT_CUSTOM_TYPE = "model-snapshot";
type CustomEntryLike = { type?: unknown; customType?: unknown; data?: unknown };
type ModelSnapshotEntry = {
  timestamp: number;
  provider?: string;
  modelApi?: string | null;
  modelId?: string;
};

type ProviderReplayHookParams = {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  provider: string;
  modelId?: string;
  modelApi?: string | null;
  model?: ProviderRuntimeModel;
  sessionId?: string;
};

function createProviderReplayPluginParams(params: ProviderReplayHookParams) {
  const context = {
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    provider: params.provider,
    modelId: params.modelId,
    modelApi: params.modelApi,
    model: params.model,
    sessionId: params.sessionId,
  };
  return {
    provider: params.provider,
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    context,
  };
}

function annotateInterSessionUserMessages(messages: AgentMessage[]): AgentMessage[] {
  let touched = false;
  const out: AgentMessage[] = [];
  for (const msg of messages) {
    if (!hasInterSessionUserProvenance(msg as { role?: unknown; provenance?: unknown })) {
      out.push(msg);
      continue;
    }
    const provenance = normalizeInputProvenance((msg as { provenance?: unknown }).provenance);
    const user = msg as Extract<AgentMessage, { role: "user" }>;
    if (typeof user.content === "string") {
      const annotated = annotateInterSessionPromptText(user.content, provenance);
      if (annotated === user.content) {
        out.push(msg);
        continue;
      }
      touched = true;
      out.push({
        ...(msg as unknown as Record<string, unknown>),
        content: annotated,
      } as AgentMessage);
      continue;
    }
    if (!Array.isArray(user.content)) {
      out.push(msg);
      continue;
    }

    const textIndex = user.content.findIndex(
      (block) =>
        block &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string",
    );

    if (textIndex >= 0) {
      const existing = user.content[textIndex] as { type: "text"; text: string };
      const annotated = annotateInterSessionPromptText(existing.text, provenance);
      if (annotated === existing.text) {
        out.push(msg);
        continue;
      }
      const nextContent = [...user.content];
      nextContent[textIndex] = {
        ...existing,
        text: annotated,
      };
      touched = true;
      out.push({
        ...(msg as unknown as Record<string, unknown>),
        content: nextContent,
      } as AgentMessage);
      continue;
    }

    touched = true;
    out.push({
      ...(msg as unknown as Record<string, unknown>),
      content: [
        {
          type: "text",
          text: annotateInterSessionPromptText("Inter-session content follows.", provenance),
        },
        ...user.content,
      ],
    } as AgentMessage);
  }
  return touched ? out : messages;
}

function parseMessageTimestamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function stripStaleAssistantUsageBeforeLatestCompaction(messages: AgentMessage[]): AgentMessage[] {
  let latestCompactionSummaryIndex = -1;
  let latestCompactionTimestamp: number | null = null;
  for (let i = 0; i < messages.length; i += 1) {
    const entry = messages[i];
    if (entry?.role !== "compactionSummary") {
      continue;
    }
    latestCompactionSummaryIndex = i;
    latestCompactionTimestamp = parseMessageTimestamp(
      (entry as { timestamp?: unknown }).timestamp ?? null,
    );
  }
  if (latestCompactionSummaryIndex === -1) {
    return messages;
  }

  const out = [...messages];
  let touched = false;
  for (let i = 0; i < out.length; i += 1) {
    const candidate = out[i] as
      | (AgentMessage & { usage?: unknown; timestamp?: unknown })
      | undefined;
    if (!candidate || candidate.role !== "assistant") {
      continue;
    }
    if (!candidate.usage || typeof candidate.usage !== "object") {
      continue;
    }

    const messageTimestamp = parseMessageTimestamp(candidate.timestamp);
    const staleByTimestamp =
      latestCompactionTimestamp !== null &&
      messageTimestamp !== null &&
      messageTimestamp <= latestCompactionTimestamp;
    const staleByLegacyOrdering = i < latestCompactionSummaryIndex;
    if (!staleByTimestamp && !staleByLegacyOrdering) {
      continue;
    }

    // pi-coding-agent expects assistant usage to always be present during context
    // accounting. Keep stale snapshots structurally valid, but zeroed out.
    const candidateRecord = candidate as unknown as Record<string, unknown>;
    out[i] = {
      ...candidateRecord,
      usage: makeZeroUsageSnapshot(),
    } as unknown as AgentMessage;
    touched = true;
  }
  return touched ? out : messages;
}

// `provider:"openclaw"` assistant entries written by the channel-delivery
// transcript mirror (`model:"delivery-mirror"`, see config/sessions/transcript.ts)
// and by the Gateway transcript-inject helper (`model:"gateway-injected"`, see
// gateway/server-methods/chat-transcript-inject.ts) are user-visible transcript
// records, not model output. Replaying them to the actual provider duplicates
// content and, on Bedrock or strict OpenAI-compatible providers, can also
// trigger turn-ordering rejections.
const TRANSCRIPT_ONLY_OPENCLAW_MODELS = new Set<string>(["delivery-mirror", "gateway-injected"]);

function sanitizeUserReplayContent(message: AgentMessage): AgentMessage | null {
  if (!message || message.role !== "user") {
    return message;
  }
  const replayContent = (message as { content?: unknown }).content;
  if (typeof replayContent === "string") {
    return replayContent.trim() ? message : null;
  }
  if (!Array.isArray(replayContent)) {
    return message;
  }

  let touched = false;
  const sanitizedContent = replayContent.filter((block) => {
    if (!block || typeof block !== "object") {
      return true;
    }
    if ((block as { type?: unknown }).type !== "text") {
      return true;
    }
    const text = (block as { text?: unknown }).text;
    if (typeof text !== "string" || text.trim().length > 0) {
      return true;
    }
    touched = true;
    return false;
  });
  if (sanitizedContent.length === 0) {
    return null;
  }
  return touched ? ({ ...message, content: sanitizedContent } as AgentMessage) : message;
}

function isTranscriptOnlyOpenclawAssistant(message: AgentMessage): boolean {
  if (!message || message.role !== "assistant") {
    return false;
  }
  const provider = (message as { provider?: unknown }).provider;
  const model = (message as { model?: unknown }).model;
  return (
    provider === "openclaw" &&
    typeof model === "string" &&
    TRANSCRIPT_ONLY_OPENCLAW_MODELS.has(model)
  );
}

function normalizeAssistantReplayTextContent(message: AgentMessage, replayContent: string) {
  const strippedText = stripInboundMetadata(replayContent);
  if (!strippedText.trim()) {
    return null;
  }
  return {
    ...message,
    content: [{ type: "text", text: strippedText }],
  } as AgentMessage;
}

function normalizeAssistantReplayBlockContent(message: AgentMessage, replayContent: unknown[]) {
  let touched = false;
  const sanitizedContent: unknown[] = [];
  for (const block of replayContent) {
    if (!block || typeof block !== "object") {
      sanitizedContent.push(block);
      continue;
    }
    const text = (block as { text?: unknown }).text;
    if (typeof text !== "string") {
      sanitizedContent.push(block);
      continue;
    }
    const strippedText = stripInboundMetadata(text);
    if (strippedText === text) {
      sanitizedContent.push(block);
      continue;
    }
    touched = true;
    if (strippedText.trim()) {
      sanitizedContent.push({ ...block, text: strippedText });
    }
  }
  if (!touched) {
    return message;
  }
  if (sanitizedContent.length === 0) {
    return null;
  }
  return { ...message, content: sanitizedContent } as AgentMessage;
}

export function normalizeAssistantReplayContent(messages: AgentMessage[]): AgentMessage[] {
  let touched = false;
  const out: AgentMessage[] = [];
  for (const message of messages) {
    if (message?.role === "user") {
      const sanitizedUserMessage = sanitizeUserReplayContent(message);
      if (sanitizedUserMessage) {
        out.push(sanitizedUserMessage);
      }
      if (sanitizedUserMessage !== message) {
        touched = true;
      }
      continue;
    }
    if (!message || message.role !== "assistant") {
      out.push(message);
      continue;
    }
    if (isTranscriptOnlyOpenclawAssistant(message)) {
      // Drop from the in-memory replay copy; the persisted JSONL keeps the
      // entry so user-facing transcript surfaces are unchanged.
      touched = true;
      continue;
    }
    const replayContent = (message as { content?: unknown }).content;
    if (typeof replayContent === "string") {
      const normalized = normalizeAssistantReplayTextContent(message, replayContent);
      if (normalized) {
        out.push(normalized);
      }
      touched = true;
      continue;
    }
    if (Array.isArray(replayContent)) {
      const normalized = normalizeAssistantReplayBlockContent(message, replayContent);
      if (normalized !== message) {
        if (normalized) {
          out.push(normalized);
        }
        touched = true;
        continue;
      }
    }
    if (Array.isArray(replayContent) && replayContent.length === 0) {
      // An assistant turn can legitimately end with `content: []` — for
      // example the silent-reply / NO_REPLY path locked in by
      // run.empty-error-retry.test.ts ("Clean stop with no output is a
      // legitimate silent reply, not a crash"). We must NOT inject the
      // failure sentinel into those turns: doing so would fabricate a
      // failure statement in the next provider request and change model
      // behavior even when no failure occurred.
      //
      // `stopReason: "error"` turns are Bedrock-Converse replay poison:
      // the provider rejects assistant messages with no ContentBlock, and
      // the persisted error turn was never going to render anything useful
      // to the model anyway. A zero-token `stop` turn is the same shape from
      // the next run's perspective: the provider produced no billable prompt
      // or completion and no content. Leaving other non-error empty-content
      // turns untouched preserves silent-reply semantics on every other code
      // path.
      const stopReason = (message as { stopReason?: unknown }).stopReason;
      if (stopReason === "error" || isZeroUsageEmptyStopAssistantTurn(message)) {
        out.push({
          ...message,
          content: [{ type: "text", text: STREAM_ERROR_FALLBACK_TEXT }],
        });
        touched = true;
        continue;
      }
    }
    out.push(message);
  }
  return touched ? out : messages;
}

function normalizeAssistantUsageSnapshot(usage: unknown) {
  const normalized = normalizeUsage((usage ?? undefined) as UsageLike | undefined);
  if (!normalized) {
    return makeZeroUsageSnapshot();
  }
  const input = normalized.input ?? 0;
  const output = normalized.output ?? 0;
  const cacheRead = normalized.cacheRead ?? 0;
  const cacheWrite = normalized.cacheWrite ?? 0;
  const totalTokens = normalized.total ?? input + output + cacheRead + cacheWrite;
  const cost = normalizeAssistantUsageCost(usage);
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens,
    ...(cost ? { cost } : {}),
  };
}

function normalizeAssistantUsageCost(usage: unknown): AssistantUsageSnapshot["cost"] | undefined {
  const base = makeZeroUsageSnapshot().cost;
  if (!usage || typeof usage !== "object") {
    return undefined;
  }
  const rawCost = (usage as { cost?: unknown }).cost;
  if (!rawCost || typeof rawCost !== "object") {
    return undefined;
  }
  const cost = rawCost as Record<string, unknown>;
  const inputRaw = toFiniteCostNumber(cost.input);
  const outputRaw = toFiniteCostNumber(cost.output);
  const cacheReadRaw = toFiniteCostNumber(cost.cacheRead);
  const cacheWriteRaw = toFiniteCostNumber(cost.cacheWrite);
  const totalRaw = toFiniteCostNumber(cost.total);
  if (
    inputRaw === undefined &&
    outputRaw === undefined &&
    cacheReadRaw === undefined &&
    cacheWriteRaw === undefined &&
    totalRaw === undefined
  ) {
    return undefined;
  }
  const input = inputRaw ?? base.input;
  const output = outputRaw ?? base.output;
  const cacheRead = cacheReadRaw ?? base.cacheRead;
  const cacheWrite = cacheWriteRaw ?? base.cacheWrite;
  const total = totalRaw ?? input + output + cacheRead + cacheWrite;
  return { input, output, cacheRead, cacheWrite, total };
}

function toFiniteCostNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function ensureAssistantUsageSnapshots(messages: AgentMessage[]): AgentMessage[] {
  if (messages.length === 0) {
    return messages;
  }

  let touched = false;
  const out = [...messages];
  for (let i = 0; i < out.length; i += 1) {
    const message = out[i] as (AgentMessage & { role?: unknown; usage?: unknown }) | undefined;
    if (!message || message.role !== "assistant") {
      continue;
    }
    const normalizedUsage = normalizeAssistantUsageSnapshot(message.usage);
    const usageCost =
      message.usage && typeof message.usage === "object"
        ? (message.usage as { cost?: unknown }).cost
        : undefined;
    const normalizedCost = normalizedUsage.cost;
    if (
      message.usage &&
      typeof message.usage === "object" &&
      (message.usage as { input?: unknown }).input === normalizedUsage.input &&
      (message.usage as { output?: unknown }).output === normalizedUsage.output &&
      (message.usage as { cacheRead?: unknown }).cacheRead === normalizedUsage.cacheRead &&
      (message.usage as { cacheWrite?: unknown }).cacheWrite === normalizedUsage.cacheWrite &&
      (message.usage as { totalTokens?: unknown }).totalTokens === normalizedUsage.totalTokens &&
      ((normalizedCost &&
        usageCost &&
        typeof usageCost === "object" &&
        (usageCost as { input?: unknown }).input === normalizedCost.input &&
        (usageCost as { output?: unknown }).output === normalizedCost.output &&
        (usageCost as { cacheRead?: unknown }).cacheRead === normalizedCost.cacheRead &&
        (usageCost as { cacheWrite?: unknown }).cacheWrite === normalizedCost.cacheWrite &&
        (usageCost as { total?: unknown }).total === normalizedCost.total) ||
        (!normalizedCost && usageCost === undefined))
    ) {
      continue;
    }
    out[i] = {
      ...(message as unknown as Record<string, unknown>),
      usage: normalizedUsage,
    } as AgentMessage;
    touched = true;
  }

  return touched ? out : messages;
}

function createProviderReplaySessionState(
  sessionManager: SessionManager,
): ProviderReplaySessionState {
  return {
    getCustomEntries() {
      try {
        const customEntries: ProviderReplaySessionEntry[] = [];
        for (const entry of sessionManager.getEntries()) {
          const candidate = entry as CustomEntryLike;
          if (candidate?.type !== "custom" || typeof candidate.customType !== "string") {
            continue;
          }
          const customType = candidate.customType.trim();
          if (!customType) {
            continue;
          }
          customEntries.push({
            customType,
            data: candidate.data,
          });
        }
        return customEntries;
      } catch {
        return [];
      }
    },
    appendCustomEntry(customType: string, data: unknown) {
      try {
        sessionManager.appendCustomEntry(customType, data);
      } catch {
        // ignore persistence failures
      }
    },
  };
}

function readLastModelSnapshot(sessionManager: SessionManager): ModelSnapshotEntry | null {
  try {
    const entries = sessionManager.getEntries();
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const entry = entries[i] as CustomEntryLike;
      if (entry?.type !== "custom" || entry?.customType !== MODEL_SNAPSHOT_CUSTOM_TYPE) {
        continue;
      }
      const data = entry?.data as ModelSnapshotEntry | undefined;
      if (data && typeof data === "object") {
        return data;
      }
    }
  } catch {
    return null;
  }
  return null;
}

function appendModelSnapshot(sessionManager: SessionManager, data: ModelSnapshotEntry): void {
  try {
    sessionManager.appendCustomEntry(MODEL_SNAPSHOT_CUSTOM_TYPE, data);
  } catch {
    // ignore persistence failures
  }
}

function isSameModelSnapshot(a: ModelSnapshotEntry, b: ModelSnapshotEntry): boolean {
  const normalize = (value?: string | null) => value ?? "";
  return (
    normalize(a.provider) === normalize(b.provider) &&
    normalize(a.modelApi) === normalize(b.modelApi) &&
    normalize(a.modelId) === normalize(b.modelId)
  );
}

/**
 * Applies the generic replay-history cleanup pipeline before provider-owned
 * replay hooks run.
 */
export async function sanitizeSessionHistory(params: {
  messages: AgentMessage[];
  modelApi?: string | null;
  modelId?: string;
  provider?: string;
  allowedToolNames?: Iterable<string>;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  model?: ProviderRuntimeModel;
  sessionManager: SessionManager;
  sessionId: string;
  policy?: TranscriptPolicy;
}): Promise<AgentMessage[]> {
  // Keep docs/reference/transcript-hygiene.md in sync with any logic changes here.
  const policy =
    params.policy ??
    resolveTranscriptPolicy({
      modelApi: params.modelApi,
      provider: params.provider,
      modelId: params.modelId,
      config: params.config,
      workspaceDir: params.workspaceDir,
      env: params.env,
      model: params.model,
    });
  const withInterSessionMarkers = annotateInterSessionUserMessages(params.messages);
  const allowProviderOwnedThinkingReplay = shouldAllowProviderOwnedThinkingReplay({
    modelApi: params.modelApi,
    policy,
  });
  const isOpenAIResponsesApi =
    params.modelApi === "openai-responses" ||
    params.modelApi === "openai-codex-responses" ||
    params.modelApi === "azure-openai-responses";
  const hasSnapshot = Boolean(params.provider || params.modelApi || params.modelId);
  const priorSnapshot = hasSnapshot ? readLastModelSnapshot(params.sessionManager) : null;
  const modelChanged = priorSnapshot
    ? !isSameModelSnapshot(priorSnapshot, {
        timestamp: 0,
        provider: params.provider,
        modelApi: params.modelApi,
        modelId: params.modelId,
      })
    : false;
  const normalizedAssistantReplay = normalizeAssistantReplayContent(withInterSessionMarkers);
  const sanitizedImages = await sanitizeSessionMessagesImages(
    normalizedAssistantReplay,
    "session:history",
    {
      sanitizeMode: policy.sanitizeMode,
      sanitizeToolCallIds:
        policy.sanitizeToolCallIds && !allowProviderOwnedThinkingReplay && !isOpenAIResponsesApi,
      toolCallIdMode: policy.toolCallIdMode,
      preserveNativeAnthropicToolUseIds: policy.preserveNativeAnthropicToolUseIds,
      preserveSignatures: policy.preserveSignatures,
      sanitizeThoughtSignatures: policy.sanitizeThoughtSignatures,
      ...resolveImageSanitizationLimits(params.config),
    },
  );
  const validatedThinkingSignatures = policy.preserveSignatures
    ? stripInvalidThinkingSignatures(sanitizedImages)
    : sanitizedImages;
  const droppedReasoning = policy.dropReasoningFromHistory
    ? dropReasoningFromHistory(validatedThinkingSignatures)
    : validatedThinkingSignatures;
  const droppedThinking = policy.dropThinkingBlocks
    ? dropThinkingBlocks(droppedReasoning)
    : droppedReasoning;
  const sanitizedToolCalls = sanitizeToolCallInputs(droppedThinking, {
    allowedToolNames: params.allowedToolNames,
    allowProviderOwnedThinkingReplay,
  });
  // OpenAI Responses rejects orphan/missing function_call_output items. Upstream
  // Codex repairs those gaps with "aborted"; keep that before the fc_* downgrade
  // so both call and result ids are rewritten together. Covered by unit replay
  // tests plus live OpenAI/Codex and generic replay-repair model tests.
  const openAIRepairedToolCalls =
    isOpenAIResponsesApi && policy.repairToolUseResultPairing
      ? sanitizeToolUseResultPairing(sanitizedToolCalls, {
          erroredAssistantResultPolicy: "drop",
          // Match upstream Codex history normalization for OpenAI Responses:
          // missing function_call_output entries are model-visible "aborted".
          missingToolResultText: "aborted",
        })
      : sanitizedToolCalls;
  const openAISafeToolCalls = isOpenAIResponsesApi
    ? downgradeOpenAIFunctionCallReasoningPairs(
        downgradeOpenAIReasoningBlocks(openAIRepairedToolCalls, {
          dropReplayableReasoning: modelChanged,
        }),
      )
    : sanitizedToolCalls;
  const sanitizedToolIds =
    policy.sanitizeToolCallIds && policy.toolCallIdMode
      ? sanitizeToolCallIdsForCloudCodeAssist(openAISafeToolCalls, policy.toolCallIdMode, {
          preserveNativeAnthropicToolUseIds: policy.preserveNativeAnthropicToolUseIds,
          preserveReplaySafeThinkingToolCallIds: allowProviderOwnedThinkingReplay,
          allowedToolNames: params.allowedToolNames,
        })
      : openAISafeToolCalls;
  // Gemini/Anthropic-class providers also require tool results to stay adjacent
  // to their assistant tool calls. They do not use Codex's "aborted" text, but
  // the same ordering repair is live-tested with Gemini 3 Flash.
  const repairedTools =
    !isOpenAIResponsesApi && policy.repairToolUseResultPairing
      ? sanitizeToolUseResultPairing(sanitizedToolIds, {
          erroredAssistantResultPolicy: "drop",
        })
      : sanitizedToolIds;
  const sanitizedToolResults = stripToolResultDetails(repairedTools);
  const sanitizedCompactionUsage = ensureAssistantUsageSnapshots(
    stripStaleAssistantUsageBeforeLatestCompaction(sanitizedToolResults),
  );
  const provider = params.provider?.trim();
  let providerSanitized: AgentMessage[] | undefined;
  if (provider && provider.length > 0) {
    const pluginParams = createProviderReplayPluginParams({ ...params, provider });
    const providerResult = await sanitizeProviderReplayHistoryWithPlugin({
      ...pluginParams,
      context: {
        ...pluginParams.context,
        sessionId: params.sessionId ?? "",
        messages: sanitizedCompactionUsage,
        allowedToolNames: params.allowedToolNames,
        sessionState: createProviderReplaySessionState(params.sessionManager),
      },
    });
    providerSanitized = providerResult ?? undefined;
  }
  const sanitizedWithProvider = providerSanitized ?? sanitizedCompactionUsage;

  if (hasSnapshot && (!priorSnapshot || modelChanged)) {
    appendModelSnapshot(params.sessionManager, {
      timestamp: Date.now(),
      provider: params.provider,
      modelApi: params.modelApi,
      modelId: params.modelId,
    });
  }

  if (!policy.applyGoogleTurnOrdering) {
    return sanitizedWithProvider;
  }

  // Strict OpenAI-compatible providers (vLLM, Gemma, etc.) also reject
  // conversations that start with an assistant turn (e.g. delivery-mirror
  // messages after /new). Provider hooks may already have applied a
  // provider-owned ordering rewrite above; keep this generic fallback for the
  // strict OpenAI-compatible path and for any provider that leaves assistant-
  // first repair to core. See #38962.
  return sanitizeGoogleTurnOrdering(sanitizedWithProvider);
}

/**
 * Runs provider-owned replay validation before falling back to the remaining
 * generic validator pipeline.
 */
export async function validateReplayTurns(params: {
  messages: AgentMessage[];
  modelApi?: string | null;
  modelId?: string;
  provider?: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  model?: ProviderRuntimeModel;
  sessionId?: string;
  policy?: TranscriptPolicy;
}): Promise<AgentMessage[]> {
  const policy =
    params.policy ??
    resolveTranscriptPolicy({
      modelApi: params.modelApi,
      provider: params.provider,
      modelId: params.modelId,
      config: params.config,
      workspaceDir: params.workspaceDir,
      env: params.env,
      model: params.model,
    });
  const provider = params.provider?.trim();
  if (provider) {
    const pluginParams = createProviderReplayPluginParams({ ...params, provider });
    const providerValidated = await validateProviderReplayTurnsWithPlugin({
      ...pluginParams,
      context: {
        ...pluginParams.context,
        messages: params.messages,
      },
    });
    if (providerValidated) {
      return providerValidated;
    }
  }

  const validatedGemini = policy.validateGeminiTurns
    ? validateGeminiTurns(params.messages)
    : params.messages;
  return policy.validateAnthropicTurns ? validateAnthropicTurns(validatedGemini) : validatedGemini;
}
