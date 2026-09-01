import { preserveCompactionReplayWindow } from "@openclaw/ai/transports";
/**
 * Prepares user-message boundaries, restored history, and transcript policy for an attempt.
 * It may assume normalized attempt and session inputs are ready.
 */
import { stableStringify } from "@openclaw/normalization-core";
import { buildHierarchyReinforcementMessage } from "../../../auto-reply/handoff-summarizer.js";
import { filterHeartbeatTranscriptArtifacts } from "../../../auto-reply/heartbeat-filter.js";
import { formatContextJsonBlock } from "../../../auto-reply/reply/channel-prompt-context.js";
import { markInboundContextLabel } from "../../../auto-reply/reply/inbound-context-marker.js";
import { resolveSessionStorePathCore } from "../../../config/sessions/paths.js";
import {
  listSessionEntriesReadOnly,
  updateSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST } from "../../../context-engine/host-compat.js";
import type { AssembleResult } from "../../../context-engine/types.js";
import { resolveHeartbeatSummaryForAgent } from "../../../infra/heartbeat-summary.js";
import type { ProviderRuntimeModel } from "../../../plugins/provider-runtime-model.types.js";
import {
  hasInterSessionUserProvenance,
  INTER_SESSION_PROMPT_PREFIX_BASE,
} from "../../../sessions/input-provenance.js";
import type { createPreparedEmbeddedAgentSettingsManager } from "../../agent-project-settings.js";
import type { createCacheTrace } from "../../cache-trace.js";
import { DEFAULT_CONTEXT_TOKENS } from "../../defaults.js";
import { assembleHarnessContextEngine } from "../../harness/context-engine-lifecycle.js";
import type { AgentRuntimePlan } from "../../runtime-plan/types.js";
import type { AgentMessage } from "../../runtime/index.js";
import { sanitizeToolUseResultPairingForModel } from "../../session-transcript-repair.js";
import type { AgentSession, SessionManager } from "../../sessions/index.js";
import { buildActiveSubagentSystemPromptAddition } from "../../subagents/registry/subagent-active-context.js";
import { resolveTranscriptPolicy, type TranscriptPolicy } from "../../transcript-policy.js";
import { getHistoryLimitFromSessionKey, limitHistoryTurns } from "../history.js";
import { log } from "../logger.js";
import { sanitizeSessionHistory, validateReplayTurns } from "../replay-history.js";
import type { AttemptContextEngine } from "./attempt-context-engine-helpers.js";
import type { resolveOrphanRepairPlan } from "./attempt-orphan-repair.js";
import { prependSystemPromptAddition } from "./attempt-prompt-helpers.js";
import { resolveAttemptStreamAuthProfileId } from "./attempt-run-decisions.js";
import { isRunnerToolCallBlockType } from "./attempt-tool-call-block-type.js";
import { loadAttemptSessionEntryAfterQuotaMaintenance } from "./attempt-transcript-helpers.js";
import { estimateRenderedLlmBoundaryTokenPressure } from "./preemptive-compaction.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

export type UserTranscriptContext = {
  runtimeMessage: AgentMessage;
  transcriptMessage: AgentMessage;
};

export type CurrentUserTimestampMatch = {
  timestamp: number;
  text: string;
  alternateText?: string;
  runtimeTimestamp?: number;
};

// Mirrors LEADING_TIMESTAMP_PREFIX_RE in strip-inbound-meta.ts so sender
// projection never displaces or duplicates a cache-stable timestamp envelope.
const LEADING_TIMESTAMP_ENVELOPE_RE = /^\[[A-Za-z]{3} \d{4}-\d{2}-\d{2} \d{2}:\d{2}[^\]]*\] */;
const CONVERSATION_INFO_LABEL = markInboundContextLabel("Conversation info:");

export function splitLeadingTimestampEnvelope(text: string): {
  body: string;
  envelope: string;
} {
  const envelope = text.match(LEADING_TIMESTAMP_ENVELOPE_RE)?.[0] ?? "";
  return { envelope, body: envelope ? text.slice(envelope.length) : text };
}

export function readFirstUserText(content: unknown): string | undefined {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  const firstTextBlock = content.find((block): block is { text: string; type?: unknown } => {
    if (!block || typeof block !== "object") {
      return false;
    }
    const typedBlock = block as { type?: unknown; text?: unknown };
    return typedBlock.type === "text" && typeof typedBlock.text === "string";
  });
  return firstTextBlock?.text;
}

export function hasNonBlankUserText(content: unknown): boolean {
  return typeof content === "string"
    ? Boolean(content.trim())
    : Array.isArray(content) &&
        content.some((block) => Boolean(readFirstUserText([block])?.trim()));
}

function contentMatchesTimestampOverride(
  content: unknown,
  override: CurrentUserTimestampMatch,
): boolean {
  const text = readFirstUserText(content);
  return text !== undefined && (text === override.text || text === override.alternateText);
}

export function resolveUserTranscriptMessages(
  messages: AgentMessage[],
  contexts: readonly UserTranscriptContext[] | undefined,
  override: CurrentUserTimestampMatch | undefined,
): Array<AgentMessage | undefined> | undefined {
  if (!contexts?.length) {
    return undefined;
  }
  const resolved = Array.from(
    { length: messages.length },
    () => undefined as AgentMessage | undefined,
  );
  const unusedContexts = new Set(contexts);
  const byRuntimeMessage = new Map<AgentMessage, UserTranscriptContext[]>();
  for (const context of unusedContexts) {
    const bucket = byRuntimeMessage.get(context.runtimeMessage);
    if (bucket) {
      bucket.push(context);
    } else {
      byRuntimeMessage.set(context.runtimeMessage, [context]);
    }
  }
  // Reserve object-identity matches before structural fallback so duplicate
  // timestamp/text turns cannot consume a later message's exact pairing.
  for (const [index, message] of messages.entries()) {
    if (message.role !== "user") {
      continue;
    }
    const context = byRuntimeMessage.get(message)?.shift();
    if (!context) {
      continue;
    }
    resolved[index] = context.transcriptMessage;
    unusedContexts.delete(context);
  }
  if (unusedContexts.size === 0) {
    return resolved;
  }
  const byTimestamp = new Map<number, UserTranscriptContext[]>();
  for (const context of unusedContexts) {
    const timestamp = context.runtimeMessage.timestamp;
    if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) {
      continue;
    }
    const bucket = byTimestamp.get(timestamp);
    if (bucket) {
      bucket.push(context);
    } else {
      byTimestamp.set(timestamp, [context]);
    }
  }
  const activeUserMessageIndex = findActiveUserMessageIndex(messages);
  for (const [index, message] of messages.entries()) {
    if (message.role !== "user" || resolved[index]) {
      continue;
    }
    const timestamp = message.timestamp;
    const candidates = typeof timestamp === "number" ? byTimestamp.get(timestamp) : undefined;
    const context = candidates?.find(
      (candidate) =>
        unusedContexts.has(candidate) &&
        userMessageMatchesTranscriptContext(
          message,
          candidate,
          index === activeUserMessageIndex ? override : undefined,
        ),
    );
    if (!context) {
      continue;
    }
    resolved[index] = context.transcriptMessage;
    unusedContexts.delete(context);
  }
  return resolved;
}

function userMessageMatchesTranscriptContext(
  message: AgentMessage,
  context: UserTranscriptContext,
  override: CurrentUserTimestampMatch | undefined,
): boolean {
  if (message === context.runtimeMessage) {
    return true;
  }
  const messageTimestamp = message.timestamp;
  const runtimeTimestamp = context.runtimeMessage.timestamp;
  if (
    typeof messageTimestamp !== "number" ||
    !Number.isFinite(messageTimestamp) ||
    messageTimestamp !== runtimeTimestamp
  ) {
    return false;
  }
  const messageContent = (message as { content?: unknown }).content;
  const runtimeContent = (context.runtimeMessage as { content?: unknown }).content;
  const messageText = readFirstUserText(messageContent);
  const runtimeText = readFirstUserText(runtimeContent);
  if (messageText !== undefined && messageText === runtimeText) {
    return true;
  }
  if (
    messageText === undefined &&
    runtimeText === undefined &&
    Array.isArray(messageContent) &&
    Array.isArray(runtimeContent) &&
    stableStringify(messageContent) === stableStringify(runtimeContent)
  ) {
    return true;
  }
  return Boolean(
    override &&
    contentMatchesTimestampOverride(messageContent, override) &&
    contentMatchesTimestampOverride(runtimeContent, override),
  );
}

function normalizePersistedSenderValue(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.replaceAll("\u0000", "").trim();
  return normalized || undefined;
}

type PersistedSender = {
  id?: string;
  name?: string;
  username?: string;
};

function readPersistedSender(message: AgentMessage): PersistedSender | undefined {
  const openclaw = Reflect.get(message, "__openclaw");
  if (!openclaw || typeof openclaw !== "object" || Array.isArray(openclaw)) {
    return undefined;
  }
  const meta = openclaw as Record<string, unknown>;
  const sender = {
    id: normalizePersistedSenderValue(meta["senderId"]),
    name: normalizePersistedSenderValue(meta["senderName"]),
    username: normalizePersistedSenderValue(meta["senderUsername"]),
  };
  if (Object.values(sender).every((value) => value === undefined)) {
    return undefined;
  }
  return sender;
}

function formatPersistedSenderContext(sender: PersistedSender): string {
  return formatContextJsonBlock(CONVERSATION_INFO_LABEL, { sender });
}

function mergeSenderIntoLeadingConversationInfo(
  text: string,
  sender: PersistedSender,
): string | undefined {
  const { body, envelope } = splitLeadingTimestampEnvelope(text);
  const jsonPrefix = `${CONVERSATION_INFO_LABEL}\n\`\`\`json\n`;
  if (!body.startsWith(jsonPrefix)) {
    return undefined;
  }
  const jsonEnd = body.indexOf("\n```", jsonPrefix.length);
  if (jsonEnd === -1) {
    return undefined;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(body.slice(jsonPrefix.length, jsonEnd));
  } catch {
    return undefined;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }
  const suffix = body.slice(jsonEnd + "\n```".length);
  return `${envelope}${formatContextJsonBlock(CONVERSATION_INFO_LABEL, {
    ...(payload as Record<string, unknown>),
    sender,
  })}${suffix}`;
}

function prependContextToUserMessage(message: AgentMessage, sender: PersistedSender): AgentMessage {
  const context = formatPersistedSenderContext(sender);
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") {
    const { body, envelope } = splitLeadingTimestampEnvelope(content);
    if (body === context || body.startsWith(`${context}\n\n`)) {
      return message;
    }
    const merged = mergeSenderIntoLeadingConversationInfo(content, sender);
    if (merged !== undefined) {
      return merged === content ? message : ({ ...message, content: merged } as AgentMessage);
    }
    return {
      ...message,
      content: `${envelope}${body ? `${context}\n\n${body}` : context}`,
    } as AgentMessage;
  }
  if (!Array.isArray(content)) {
    return message;
  }

  const textIndex = content.findIndex((block) => {
    if (!block || typeof block !== "object") {
      return false;
    }
    const textBlock = block as { type?: unknown; text?: unknown };
    return textBlock.type === "text" && typeof textBlock.text === "string";
  });
  if (textIndex === -1) {
    return {
      ...message,
      content: [{ type: "text", text: context }, ...content],
    } as AgentMessage;
  }
  const textBlock = content[textIndex] as { text: string };
  const { body, envelope } = splitLeadingTimestampEnvelope(textBlock.text);
  if (body === context || body.startsWith(`${context}\n\n`)) {
    return message;
  }
  const merged = mergeSenderIntoLeadingConversationInfo(textBlock.text, sender);
  const nextContent = content.slice();
  nextContent[textIndex] = {
    ...textBlock,
    text: merged ?? `${envelope}${body ? `${context}\n\n${body}` : context}`,
  };
  return { ...message, content: nextContent } as AgentMessage;
}

function hasInterSessionPromptPrefix(message: AgentMessage): boolean {
  const text = readFirstUserText((message as { content?: unknown }).content);
  if (text === undefined) {
    return false;
  }
  return splitLeadingTimestampEnvelope(text).body.startsWith(INTER_SESSION_PROMPT_PREFIX_BASE);
}

export function projectPersistedSenderContext(
  messages: AgentMessage[],
  transcriptMessages?: readonly (AgentMessage | undefined)[],
): AgentMessage[] {
  let changed = false;
  const nextMessages = messages.map((message, index) => {
    if (message.role !== "user") {
      return message;
    }
    const transcriptMessage = transcriptMessages?.[index] ?? message;
    // Inter-session provenance must remain the first model-facing safety text.
    // Its own source envelope already identifies the routed origin.
    if (
      hasInterSessionUserProvenance(message) ||
      hasInterSessionUserProvenance(transcriptMessage) ||
      hasInterSessionPromptPrefix(message) ||
      hasInterSessionPromptPrefix(transcriptMessage)
    ) {
      return message;
    }
    // Group/channel persistence is the product boundary that opts into these
    // existing sender fields. Project every turn, including the active one, so
    // provider bytes stay stable when that same turn becomes historical.
    const sender = readPersistedSender(transcriptMessage);
    if (!sender) {
      return message;
    }
    const nextMessage = prependContextToUserMessage(message, sender);
    changed ||= nextMessage !== message;
    return nextMessage;
  });
  return changed ? nextMessages : messages;
}

export function findActiveUserMessageIndex(messages: AgentMessage[]): number {
  // A prompt turn may be followed by assistant tool-call scaffolding during
  // retry reconstruction. A normal assistant reply means the latest user turn is
  // historical, not the active prompt boundary.
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) {
      continue;
    }
    if (message.role === "user") {
      return index;
    }
    if (message.role === "assistant" && !isToolCallAssistantMessage(message)) {
      return -1;
    }
  }
  return -1;
}

function isToolCallAssistantMessage(message: AgentMessage): boolean {
  if (message.role !== "assistant") {
    return false;
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return false;
  }
  return content.some((block) => {
    if (!block || typeof block !== "object") {
      return false;
    }
    const type = (block as { type?: unknown }).type;
    return isRunnerToolCallBlockType(type);
  });
}

/**
 * Prepares restored transcript history and applies context-engine assembly.
 */

type CacheTrace = ReturnType<typeof createCacheTrace>;
type OrphanRepairPlan = ReturnType<typeof resolveOrphanRepairPlan>;
type SettingsManager = Pick<
  ReturnType<typeof createPreparedEmbeddedAgentSettingsManager>,
  "getCompactionReserveTokens"
>;

type PreparedEmbeddedAttemptHistory = {
  contextEnginePromptAuthority: NonNullable<AssembleResult["promptAuthority"]>;
  contextEngineAssemblySucceeded: boolean;
  unwindowedContextEngineMessagesForPrecheck?: AgentMessage[];
};

export async function prepareEmbeddedAttemptHistory(input: {
  attempt: EmbeddedRunAttemptParams;
  activeSession: AgentSession;
  sessionManager: SessionManager;
  activeContextEngine?: AttemptContextEngine;
  cacheTrace: CacheTrace;
  capabilityToolNames: ReadonlySet<string>;
  compactionReplayEnabled: boolean;
  effectiveWorkspace: string;
  isOpenAIResponsesApi: boolean;
  isRawModelRun: boolean;
  orphanRepair?: OrphanRepairPlan;
  replayAllowedToolNames: Set<string>;
  sandboxed: boolean;
  sessionAgentId: string;
  settingsManager: SettingsManager;
  systemPromptText: string;
  transcriptPolicy: TranscriptPolicy;
  setActiveSessionSystemPrompt: (systemPrompt: string) => void;
}): Promise<PreparedEmbeddedAttemptHistory> {
  const { activeSession, attempt } = input;
  const isSettledTurnFinalization = attempt.operation === "settled-tool-finalization";
  let systemPromptText = input.systemPromptText;
  const setSystemPrompt = (nextSystemPrompt: string) => {
    systemPromptText = nextSystemPrompt;
    input.setActiveSessionSystemPrompt(nextSystemPrompt);
  };

  if (input.isRawModelRun) {
    activeSession.agent.reset();
    setSystemPrompt("");
    input.cacheTrace?.recordStage("session:raw-model-run", {
      messages: activeSession.messages,
      system: systemPromptText,
    });
  } else {
    const prior = await sanitizeSessionHistory({
      messages: activeSession.messages,
      modelApi: attempt.model.api,
      modelId: attempt.modelId,
      provider: attempt.provider,
      allowedToolNames: input.replayAllowedToolNames,
      config: attempt.config,
      workspaceDir: input.effectiveWorkspace,
      env: process.env,
      model: attempt.model,
      sessionManager: input.sessionManager,
      sessionId: attempt.sessionId,
      policy: input.transcriptPolicy,
    });
    input.cacheTrace?.recordStage("session:sanitized", { messages: prior });
    const validated = await validateReplayTurns({
      messages: prior,
      modelApi: attempt.model.api,
      modelId: attempt.modelId,
      provider: attempt.provider,
      config: attempt.config,
      workspaceDir: input.effectiveWorkspace,
      env: process.env,
      model: attempt.model,
      sessionId: attempt.sessionId,
      policy: input.transcriptPolicy,
    });

    if (
      attempt.sessionKey &&
      attempt.sessionPersistence !== "detached" &&
      !isSettledTurnFinalization
    ) {
      const storePath = resolveSessionStorePathCore(attempt.config?.session?.store, {
        agentId: input.sessionAgentId,
      });
      const sessionEntry = await loadAttemptSessionEntryAfterQuotaMaintenance({
        agentId: input.sessionAgentId,
        storePath,
        sessionKey: attempt.sessionKey,
      });
      const suspension = sessionEntry?.quotaSuspension;
      if (sessionEntry && suspension?.state === "resuming") {
        const subagents = listSessionEntriesReadOnly({
          agentId: input.sessionAgentId,
          storePath,
          clone: false,
        })
          .map(({ entry }) => entry)
          .filter((entry) => entry.spawnedBy === sessionEntry.sessionId)
          .map((entry) => ({
            sessionId: entry.sessionId,
            role: entry.subagentRole,
            lastStatus: entry.status,
          }));
        validated.push(
          buildHierarchyReinforcementMessage({
            summary: suspension.summary ?? "No recovery briefing was captured.",
            activeSubagents: subagents,
          }),
        );
        await updateSessionEntry(
          { agentId: input.sessionAgentId, storePath, sessionKey: attempt.sessionKey },
          async (entry) => {
            if (entry.quotaSuspension?.state !== "resuming") {
              return null;
            }
            return {
              quotaSuspension: { ...entry.quotaSuspension, state: "active" },
            };
          },
          { skipMaintenance: true, takeCacheOwnership: true },
        );
      }
    }

    if (attempt.sessionKey && attempt.config && !isSettledTurnFinalization) {
      // Capability guidance must include deferred OpenClaw tools without
      // interpreting arbitrary client tool names as native capabilities.
      const activeSubagentPromptAddition = buildActiveSubagentSystemPromptAddition({
        cfg: attempt.config,
        controllerSessionKey: attempt.sessionKey,
        controllerAgentId: input.sessionAgentId,
        hasSessionsYield: input.capabilityToolNames.has("sessions_yield"),
      });
      if (activeSubagentPromptAddition) {
        setSystemPrompt(
          prependSystemPromptAddition({
            systemPrompt: systemPromptText,
            systemPromptAddition: activeSubagentPromptAddition,
          }),
        );
      }
    }

    const limited = (() => {
      if (isSettledTurnFinalization) {
        return validated;
      }
      const heartbeatSummary =
        attempt.config && input.sessionAgentId
          ? resolveHeartbeatSummaryForAgent(attempt.config, input.sessionAgentId)
          : undefined;
      const heartbeatFiltered = filterHeartbeatTranscriptArtifacts(
        validated,
        heartbeatSummary?.ackMaxChars,
        heartbeatSummary?.prompt,
      );
      const truncated = preserveCompactionReplayWindow(
        heartbeatFiltered,
        limitHistoryTurns(
          heartbeatFiltered,
          getHistoryLimitFromSessionKey(attempt.sessionKey, attempt.config, {
            accountId: attempt.agentAccountId,
            peerId: attempt.conversationRoutePeerId,
            chatType: attempt.chatType,
          }),
        ),
        attempt.model,
        {
          sessionId: attempt.sessionId,
          authProfileId: resolveAttemptStreamAuthProfileId(attempt),
          enabled: input.compactionReplayEnabled,
        },
      );
      // Truncation can orphan tool_result blocks by removing the assistant message
      // that contained the matching tool_use, so repair the pairs once more.
      return input.transcriptPolicy.repairToolUseResultPairing
        ? sanitizeToolUseResultPairingForModel(truncated, input.isOpenAIResponsesApi)
        : truncated;
    })();
    input.cacheTrace?.recordStage("session:limited", { messages: limited });
    if (limited.length > 0 || prior.length > 0) {
      activeSession.agent.state.messages = limited;
    }
  }

  let contextEnginePromptAuthority: NonNullable<AssembleResult["promptAuthority"]> = "assembled";
  let contextEngineAssemblySucceeded = false;
  let unwindowedContextEngineMessagesForPrecheck: AgentMessage[] | undefined;
  if (input.activeContextEngine) {
    try {
      // Assemble may window the input in place. Preserve the original history for
      // the overflow precheck when the engine says preassembly can still overflow.
      const preassemblyMessages = activeSession.messages.slice();
      const reserveTokens = Math.max(
        0,
        Math.floor(input.settingsManager.getCompactionReserveTokens()),
      );
      const contextTokenBudget = Math.max(
        1,
        Math.floor(
          attempt.contextTokenBudget ??
            attempt.model.contextWindow ??
            attempt.model.maxTokens ??
            DEFAULT_CONTEXT_TOKENS,
        ),
      );
      const promptBudget = Math.max(1, contextTokenBudget - reserveTokens);
      const prompt = input.orphanRepair?.contextEnginePrompt ?? attempt.prompt ?? "";
      const renderedPromptTokens = estimateRenderedLlmBoundaryTokenPressure({
        systemPrompt: systemPromptText,
        prompt,
      });
      const messageBudget = Math.max(1, promptBudget - renderedPromptTokens);
      const transcriptReadFence = attempt.userTurnTranscriptRecorder?.getAdmissionReceipt();
      const assembled = await assembleHarnessContextEngine({
        contextEngine: input.activeContextEngine,
        sessionId: attempt.sessionId,
        sessionKey: attempt.sessionKey,
        agentId: input.sessionAgentId,
        messages: activeSession.messages,
        tokenBudget: messageBudget,
        availableTools: new Set(input.capabilityToolNames),
        citationsMode: attempt.config?.memory?.citations,
        sandboxed: input.sandboxed,
        modelId: attempt.modelId,
        maxOutputTokens: reserveTokens,
        contextEngineHostSupport: OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST,
        providerId: attempt.provider,
        requestedModelId: attempt.requestedModelId,
        fallbackReason: attempt.fallbackReason,
        degradedReason: attempt.degradedReason,
        transcriptReadFence,
        ...(attempt.prompt !== undefined ? { prompt } : {}),
      });
      if (!assembled) {
        throw new Error("context engine assemble returned no result");
      }
      const assembledMessages = input.transcriptPolicy.repairToolUseResultPairing
        ? sanitizeToolUseResultPairingForModel(assembled.messages, input.isOpenAIResponsesApi)
        : assembled.messages;
      if (assembledMessages !== activeSession.messages) {
        activeSession.agent.state.messages = assembledMessages;
      }
      contextEnginePromptAuthority = assembled.promptAuthority ?? "assembled";
      contextEngineAssemblySucceeded = true;
      if (contextEnginePromptAuthority === "preassembly_may_overflow") {
        unwindowedContextEngineMessagesForPrecheck = preassemblyMessages;
      }
      if (assembled.systemPromptAddition) {
        setSystemPrompt(
          prependSystemPromptAddition({
            systemPrompt: systemPromptText,
            systemPromptAddition: assembled.systemPromptAddition,
          }),
        );
        log.debug(
          `context engine: prepended system prompt addition (${assembled.systemPromptAddition.length} chars)`,
        );
      }
    } catch (error) {
      log.warn(`context engine assemble failed, using pipeline messages: ${String(error)}`);
    }
  }

  return {
    contextEnginePromptAuthority,
    contextEngineAssemblySucceeded,
    ...(unwindowedContextEngineMessagesForPrecheck
      ? { unwindowedContextEngineMessagesForPrecheck }
      : {}),
  };
}

/**
 * Resolves transcript persistence policy for a single embedded-agent attempt.
 */

type AttemptRuntimeModelContext = NonNullable<
  Parameters<AgentRuntimePlan["transcript"]["resolvePolicy"]>[0]
>;

/**
 * Adapts the RuntimePlan model context to the legacy provider-runtime model
 * shape used by transcript-policy fallbacks.
 */
function asProviderRuntimeModel(
  model: AttemptRuntimeModelContext["model"],
): ProviderRuntimeModel | undefined {
  return typeof model?.id === "string" ? (model as ProviderRuntimeModel) : undefined;
}

/**
 * Resolves the transcript policy for an embedded attempt. RuntimePlan owns the
 * policy when present; otherwise the older provider/config/env resolver remains
 * the compatibility path for callers that have not produced a runtime plan yet.
 */
export function resolveAttemptTranscriptPolicy(params: {
  runtimePlan?: AgentRuntimePlan;
  runtimePlanModelContext: AttemptRuntimeModelContext;
  provider: string;
  modelId: string;
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): TranscriptPolicy {
  return (
    params.runtimePlan?.transcript.resolvePolicy(params.runtimePlanModelContext) ??
    resolveTranscriptPolicy({
      modelApi: params.runtimePlanModelContext.modelApi,
      provider: params.provider,
      modelId: params.modelId,
      config: params.config,
      workspaceDir: params.runtimePlanModelContext.workspaceDir,
      env: params.env ?? process.env,
      model: asProviderRuntimeModel(params.runtimePlanModelContext.model),
    })
  );
}
