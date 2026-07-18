/**
 * Transcript repair helpers for tool-call replay.
 *
 * Normalizes raw tool-call blocks and synthesizes missing tool results without rewriting trusted local payloads.
 */
import {
  hasNonEmptyString as hasNonEmptyStringField,
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
  readStringValue,
} from "@openclaw/normalization-core/string-coerce";
import type { AgentMessage } from "./runtime/index.js";
import { isThinkingLikeBlock } from "./thinking-block.js";
import {
  extractToolCallsFromAssistant,
  extractToolResultId,
  extractToolResultIds,
} from "./tool-call-id.js";
import { isAllowedToolCallName, normalizeAllowedToolNames } from "./tool-call-shared.js";

type RawToolCallBlock = {
  type?: unknown;
  id?: unknown;
  call_id?: unknown;
  toolCallId?: unknown;
  toolUseId?: unknown;
  tool_call_id?: unknown;
  tool_use_id?: unknown;
  name?: unknown;
  input?: unknown;
  arguments?: unknown;
  partialJson?: unknown;
};

const RAW_TOOL_CALL_BLOCK_TYPES = new Set([
  "toolCall",
  "toolUse",
  "functionCall",
  "tool_call",
  "tool_use",
  "function_call",
]);

function isRawToolCallBlock(block: unknown): block is RawToolCallBlock {
  if (!block || typeof block !== "object") {
    return false;
  }
  const type = (block as { type?: unknown }).type;
  return typeof type === "string" && RAW_TOOL_CALL_BLOCK_TYPES.has(type);
}

function hasToolCallInput(block: RawToolCallBlock): boolean {
  const hasInput = "input" in block ? block.input !== undefined && block.input !== null : false;
  const hasArguments =
    "arguments" in block ? block.arguments !== undefined && block.arguments !== null : false;
  return hasInput || hasArguments;
}

function hasToolCallId(block: RawToolCallBlock): boolean {
  return (
    hasNonEmptyStringField(block.id) ||
    hasNonEmptyStringField(block.call_id) ||
    hasNonEmptyStringField(block.toolCallId) ||
    hasNonEmptyStringField(block.toolUseId) ||
    hasNonEmptyStringField(block.tool_call_id) ||
    hasNonEmptyStringField(block.tool_use_id)
  );
}

function hasPartialJson(
  block: RawToolCallBlock,
): block is RawToolCallBlock & { partialJson: string } {
  return typeof block.partialJson === "string";
}

function isCompleteJsonObject(value: string): boolean {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

function isFinalizedOpenAIResponsesToolCall(
  message: AgentMessage,
  block: RawToolCallBlock,
): boolean {
  if (
    message.role !== "assistant" ||
    !("stopReason" in message) ||
    message.stopReason !== "toolUse" ||
    !hasPartialJson(block) ||
    typeof block.id !== "string" ||
    "input" in block ||
    !block.arguments ||
    typeof block.arguments !== "object" ||
    Array.isArray(block.arguments) ||
    (!isCompleteJsonObject(block.partialJson) &&
      (block.partialJson.trim() !== "" || Object.keys(block.arguments).length > 0))
  ) {
    return false;
  }

  const separator = block.id.indexOf("|");
  return separator > 0 && separator < block.id.length - 1;
}

function sanitizeToolCallBlock(block: RawToolCallBlock): RawToolCallBlock {
  // This repair path normalizes replay shape only. Tool payloads are local
  // trusted-operator transcript state per SECURITY.md, so do not redact or
  // rewrite sessions_spawn arguments here.
  const rawName = readStringValue(block.name);
  const trimmedName = rawName?.trim();
  const hasTrimmedName = typeof trimmedName === "string" && trimmedName.length > 0;
  const normalizedName = hasTrimmedName ? trimmedName : undefined;
  const nameChanged = hasTrimmedName && rawName !== trimmedName;

  if (!nameChanged) {
    return block;
  }
  const next = { ...(block as Record<string, unknown>) };
  if (nameChanged && normalizedName) {
    next.name = normalizedName;
  }
  return next as RawToolCallBlock;
}

function countRawToolCallBlocks(content: unknown[]): number {
  let count = 0;
  for (const block of content) {
    if (isRawToolCallBlock(block)) {
      count += 1;
    }
  }
  return count;
}

function isReplaySafeThinkingAssistantTurn(
  content: unknown[],
  allowedToolNames: Set<string> | null,
): boolean {
  let sawToolCall = false;
  const seenToolCallIds = new Set<string>();
  for (const block of content) {
    if (!isRawToolCallBlock(block)) {
      continue;
    }
    sawToolCall = true;
    const toolCallId = typeof block.id === "string" ? block.id.trim() : "";
    if (
      !hasToolCallInput(block) ||
      hasPartialJson(block) ||
      !toolCallId ||
      seenToolCallIds.has(toolCallId) ||
      !isAllowedToolCallName(block.name, allowedToolNames)
    ) {
      return false;
    }
    seenToolCallIds.add(toolCallId);
    if (sanitizeToolCallBlock(block) !== block) {
      return false;
    }
  }
  return sawToolCall;
}

function hasSessionsSpawnAttachmentToolCall(content: unknown[]): boolean {
  for (const block of content) {
    if (!isRawToolCallBlock(block) || block.name !== "sessions_spawn") {
      continue;
    }
    const input = block.input;
    if (!input || typeof input !== "object") {
      continue;
    }
    const attachments = (input as { attachments?: unknown }).attachments;
    if (Array.isArray(attachments) && attachments.length > 0) {
      return true;
    }
  }
  return false;
}

const DEFAULT_MISSING_TOOL_RESULT_TEXT =
  "[openclaw] missing tool result in session history; inserted synthetic error result for transcript repair.";
const SYNTHETIC_MISSING_TOOL_RESULT_DETAIL_KEY = "openclawSyntheticMissingToolResult";

function makeMissingToolResult(params: {
  toolCallId: string;
  toolName?: string;
  // OpenAI Responses/Codex replay should match upstream Codex's "aborted"
  // function_call_output normalization; live coverage in
  // openai-reasoning-compat.live.test.ts and tool-replay-repair.live.test.ts
  // sends this repaired history to real models. Other providers keep the older,
  // explicit OpenClaw diagnostic text unless the caller opts in.
  text?: string;
}): Extract<AgentMessage, { role: "toolResult" }> {
  return {
    role: "toolResult",
    toolCallId: params.toolCallId,
    toolName: params.toolName ?? "unknown",
    content: [
      {
        type: "text",
        text: params.text ?? DEFAULT_MISSING_TOOL_RESULT_TEXT,
      },
    ],
    details: { [SYNTHETIC_MISSING_TOOL_RESULT_DETAIL_KEY]: true },
    isError: true,
    timestamp: Date.now(),
  } as Extract<AgentMessage, { role: "toolResult" }>;
}

function isSyntheticMissingToolResult(msg: Extract<AgentMessage, { role: "toolResult" }>): boolean {
  if (!(msg as { isError?: unknown }).isError) {
    return false;
  }
  const details = (msg as { details?: unknown }).details;
  if (
    details &&
    typeof details === "object" &&
    (details as Record<string, unknown>)[SYNTHETIC_MISSING_TOOL_RESULT_DETAIL_KEY] === true
  ) {
    return true;
  }
  const content = (msg as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return false;
  }
  return content.some(
    (block: unknown) =>
      typeof block === "object" &&
      block !== null &&
      (block as { type?: string }).type === "text" &&
      (block as { text?: string }).text === DEFAULT_MISSING_TOOL_RESULT_TEXT,
  );
}

function normalizeToolResultName(
  message: Extract<AgentMessage, { role: "toolResult" }>,
  fallbackName?: string,
): Extract<AgentMessage, { role: "toolResult" }> {
  const rawToolName = (message as { toolName?: unknown }).toolName;
  const normalizedToolName = normalizeOptionalString(rawToolName);
  if (normalizedToolName) {
    if (rawToolName === normalizedToolName) {
      return message;
    }
    return { ...message, toolName: normalizedToolName };
  }

  const normalizedFallback = normalizeOptionalString(fallbackName);
  if (normalizedFallback) {
    return { ...message, toolName: normalizedFallback };
  }

  if (typeof rawToolName === "string") {
    return { ...message, toolName: "unknown" };
  }
  return message;
}

function normalizeLegacyToolResultId(
  message: Extract<AgentMessage, { role: "toolResult" }>,
  toolCalls: Array<{ id: string; name?: string }>,
): Extract<AgentMessage, { role: "toolResult" }> {
  if (extractToolResultId(message) || toolCalls.length !== 1) {
    return message;
  }
  const [toolCall] = toolCalls;
  if (!toolCall) {
    return message;
  }
  const toolResultName = normalizeOptionalString((message as { toolName?: unknown }).toolName);
  const toolCallName = normalizeOptionalString(toolCall.name);
  if (toolResultName && toolCallName && toolResultName !== toolCallName) {
    return message;
  }
  return { ...message, toolCallId: toolCall.id, isError: true };
}

export { makeMissingToolResult };

type ToolCallInputRepairReport = {
  messages: AgentMessage[];
  droppedToolCalls: number;
  droppedAssistantMessages: number;
};

type ToolCallInputRepairOptions = {
  allowedToolNames?: Iterable<string>;
  allowProviderOwnedThinkingReplay?: boolean;
};

type ErroredAssistantResultPolicy = "preserve" | "drop";

type ToolUseResultPairingOptions = {
  erroredAssistantResultPolicy?: ErroredAssistantResultPolicy;
  missingToolResultText?: string;
};

export function stripToolResultDetails(messages: AgentMessage[]): AgentMessage[] {
  let touched = false;
  const out: AgentMessage[] = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== "object" || (msg as { role?: unknown }).role !== "toolResult") {
      out.push(msg);
      continue;
    }
    if (!("details" in msg)) {
      out.push(msg);
      continue;
    }
    const sanitized = { ...(msg as object) } as { details?: unknown };
    delete sanitized.details;
    touched = true;
    out.push(sanitized as unknown as AgentMessage);
  }
  return touched ? out : messages;
}

function collectFollowingToolResults(
  messages: AgentMessage[],
  index: number,
): { ids: Set<string>; displaced: boolean } {
  const ids = new Set<string>();
  const assistant = messages[index];
  const currentToolCalls =
    assistant && typeof assistant === "object" && assistant.role === "assistant"
      ? extractToolCallsFromAssistant(assistant)
      : [];
  let sawNonToolResult = false;
  let displaced = false;
  for (let nextIndex = index + 1; nextIndex < messages.length; nextIndex += 1) {
    const message = messages[nextIndex];
    if (!message || typeof message !== "object") {
      sawNonToolResult = true;
      continue;
    }
    if (message.role === "assistant" && assistantHasToolCalls(message)) {
      break;
    }
    if (message.role === "toolResult") {
      const normalizedLegacyResult = normalizeLegacyToolResultId(message, currentToolCalls);
      const resultIds = extractToolResultIds(normalizedLegacyResult);
      for (const id of resultIds) {
        ids.add(id);
      }
      displaced ||= resultIds.length > 0 && sawNonToolResult;
      continue;
    }
    sawNonToolResult = true;
  }
  return { ids, displaced };
}

function repairToolCallInputs(
  messages: AgentMessage[],
  options?: ToolCallInputRepairOptions,
): ToolCallInputRepairReport {
  let droppedToolCalls = 0;
  let droppedAssistantMessages = 0;
  let changed = false;
  const out: AgentMessage[] = [];
  const allowedToolNames = normalizeAllowedToolNames(options?.allowedToolNames);
  const allowProviderOwnedThinkingReplay = options?.allowProviderOwnedThinkingReplay === true;
  const preservedThinkingToolCallIds = new Set<string>();
  const priorToolCallIds = new Set<string>();

  for (const [index, msg] of messages.entries()) {
    if (!msg || typeof msg !== "object") {
      changed = true;
      continue;
    }

    if (msg.role !== "assistant" || !Array.isArray(msg.content)) {
      out.push(msg);
      continue;
    }

    if (
      allowProviderOwnedThinkingReplay &&
      msg.content.some((block) => isThinkingLikeBlock(block)) &&
      countRawToolCallBlocks(msg.content) > 0
    ) {
      // Signed Anthropic thinking blocks must remain byte-for-byte stable on
      // replay. Preserve the turn when every sibling tool call is already valid;
      // the later pairing repair can synthesize missing legacy tool results
      // without mutating provider-owned assistant content.
      const replaySafeToolCalls = extractToolCallsFromAssistant(msg);
      const followingToolResults = collectFollowingToolResults(messages, index);
      if (
        isReplaySafeThinkingAssistantTurn(msg.content, allowedToolNames) &&
        replaySafeToolCalls.every(
          (toolCall) =>
            !preservedThinkingToolCallIds.has(toolCall.id) &&
            (!hasSessionsSpawnAttachmentToolCall(msg.content) ||
              followingToolResults.ids.has(toolCall.id)) &&
            (!followingToolResults.displaced || !priorToolCallIds.has(toolCall.id)),
        )
      ) {
        for (const toolCall of replaySafeToolCalls) {
          preservedThinkingToolCallIds.add(toolCall.id);
          priorToolCallIds.add(toolCall.id);
        }
        changed ||= followingToolResults.displaced;
        out.push(msg);
      } else {
        droppedToolCalls += countRawToolCallBlocks(msg.content);
        droppedAssistantMessages += 1;
        changed = true;
      }
      continue;
    }

    const nextContent: typeof msg.content = [];
    let droppedInMessage = 0;
    let messageChanged = false;

    for (const block of msg.content) {
      if (isRawToolCallBlock(block)) {
        // Drop genuinely incomplete streaming artifacts (missing required fields).
        if (
          !hasToolCallInput(block) ||
          !hasToolCallId(block) ||
          !isAllowedToolCallName((block as RawToolCallBlock).name, allowedToolNames)
        ) {
          droppedToolCalls += 1;
          droppedInMessage += 1;
          changed = true;
          messageChanged = true;
          continue;
        }
      }
      let workBlock = block;
      if (isRawToolCallBlock(block) && hasPartialJson(block)) {
        if (!isFinalizedOpenAIResponsesToolCall(msg, block)) {
          droppedToolCalls += 1;
          droppedInMessage += 1;
          changed = true;
          messageChanged = true;
          continue;
        }

        // Legacy generic Responses transport persisted successful toolUse turns
        // with the scratch buffer intact. Strip it only when terminal state and
        // the provider-specific finalized shape both prove completion.
        const stripped = { ...block };
        delete (stripped as RawToolCallBlock & { partialJson?: unknown }).partialJson;
        workBlock = stripped;
        changed = true;
        messageChanged = true;
      }
      if (isRawToolCallBlock(workBlock)) {
        if (RAW_TOOL_CALL_BLOCK_TYPES.has((workBlock as { type?: string }).type ?? "")) {
          // Only sanitize (redact) sessions_spawn blocks; all others are passed through
          // unchanged to preserve provider-specific shapes (e.g. toolUse.input for Anthropic).
          const blockName =
            typeof (workBlock as { name?: unknown }).name === "string"
              ? (workBlock as { name: string }).name.trim()
              : undefined;
          if (normalizeLowercaseStringOrEmpty(blockName) === "sessions_spawn") {
            const sanitized = sanitizeToolCallBlock(workBlock);
            if (sanitized !== workBlock) {
              changed = true;
              messageChanged = true;
            }
            nextContent.push(sanitized as typeof block);
          } else if (typeof (workBlock as { name?: unknown }).name === "string") {
            const rawName = (workBlock as { name: string }).name;
            const trimmedName = rawName.trim();
            if (rawName !== trimmedName && trimmedName) {
              const renamed = { ...(workBlock as object), name: trimmedName } as typeof block;
              nextContent.push(renamed);
              changed = true;
              messageChanged = true;
            } else {
              nextContent.push(workBlock);
            }
          } else {
            nextContent.push(workBlock);
          }
          continue;
        }
      }
      nextContent.push(workBlock);
    }

    if (droppedInMessage > 0) {
      if (nextContent.length === 0) {
        droppedAssistantMessages += 1;
        changed = true;
        continue;
      }
      const nextMessage = { ...msg, content: nextContent };
      for (const toolCall of extractToolCallsFromAssistant(nextMessage)) {
        priorToolCallIds.add(toolCall.id);
      }
      out.push(nextMessage);
      continue;
    }

    if (messageChanged) {
      const nextMessage = { ...msg, content: nextContent };
      for (const toolCall of extractToolCallsFromAssistant(nextMessage)) {
        priorToolCallIds.add(toolCall.id);
      }
      out.push(nextMessage);
      continue;
    }

    for (const toolCall of extractToolCallsFromAssistant(msg)) {
      priorToolCallIds.add(toolCall.id);
    }
    out.push(msg);
  }

  return {
    messages: changed ? out : messages,
    droppedToolCalls,
    droppedAssistantMessages,
  };
}

export function sanitizeToolCallInputs(
  messages: AgentMessage[],
  options?: ToolCallInputRepairOptions,
): AgentMessage[] {
  return repairToolCallInputs(messages, options).messages;
}

export function sanitizeToolUseResultPairing(
  messages: AgentMessage[],
  options?: ToolUseResultPairingOptions,
): AgentMessage[] {
  return repairToolUseResultPairing(messages, options).messages;
}

type ToolUseRepairReport = {
  messages: AgentMessage[];
  added: Array<Extract<AgentMessage, { role: "toolResult" }>>;
  droppedDuplicateCount: number;
  droppedOrphanCount: number;
  moved: boolean;
};

function shouldDropErroredAssistantResults(options?: ToolUseResultPairingOptions): boolean {
  return options?.erroredAssistantResultPolicy === "drop";
}

function assistantHasToolCalls(message: AgentMessage): boolean {
  if (!message || typeof message !== "object" || message.role !== "assistant") {
    return false;
  }
  return extractToolCallsFromAssistant(message).length > 0;
}

type ToolResultMessage = Extract<AgentMessage, { role: "toolResult" }>;

type ToolResultRecord = {
  result: ToolResultMessage;
  id?: string;
};

type ToolCallOccurrence = {
  id: string;
  name?: string;
  result?: ToolResultMessage;
};

type SameIdOccurrenceGroup = {
  occurrences: ToolCallOccurrence[];
  nextUnfilledIndex: number;
  syntheticOccurrences: ToolCallOccurrence[];
  nextSyntheticIndex: number;
};

type ToolUseFrame = {
  startIndex: number;
  endIndex: number;
  assistant: Extract<AgentMessage, { role: "assistant" }>;
  remainder: AgentMessage[];
  unclaimedResults: ToolResultRecord[];
  occurrences: ToolCallOccurrence[];
  failed: boolean;
};

function buildToolUseFrames(messages: AgentMessage[], onDuplicate: () => void): ToolUseFrame[] {
  const frameStartIndexes: number[] = [];
  for (const [index, message] of messages.entries()) {
    if (message && typeof message === "object" && assistantHasToolCalls(message)) {
      frameStartIndexes.push(index);
    }
  }

  return frameStartIndexes.map((startIndex, frameIndex) => {
    const assistant = messages[startIndex] as Extract<AgentMessage, { role: "assistant" }>;
    const toolCalls = extractToolCallsFromAssistant(assistant);
    const occurrences: ToolCallOccurrence[] = [];
    const occurrencesById = new Map<string, SameIdOccurrenceGroup>();
    for (const toolCall of toolCalls) {
      const occurrence: ToolCallOccurrence = { id: toolCall.id, name: toolCall.name };
      occurrences.push(occurrence);
      const sameIdGroup = occurrencesById.get(toolCall.id);
      if (sameIdGroup) {
        sameIdGroup.occurrences.push(occurrence);
      } else {
        occurrencesById.set(toolCall.id, {
          occurrences: [occurrence],
          nextUnfilledIndex: 0,
          syntheticOccurrences: [],
          nextSyntheticIndex: 0,
        });
      }
    }

    const endIndex = frameStartIndexes[frameIndex + 1] ?? messages.length;
    const remainder: AgentMessage[] = [];
    const unclaimedResults: ToolResultRecord[] = [];

    for (let index = startIndex + 1; index < endIndex; index += 1) {
      const message = messages[index];
      if (!message || typeof message !== "object") {
        continue;
      }
      if (message.role !== "toolResult") {
        remainder.push(message);
        continue;
      }

      const legacyNormalized = normalizeLegacyToolResultId(message, toolCalls);
      const id = extractToolResultId(legacyNormalized);
      const sameIdGroup = id ? occurrencesById.get(id) : undefined;
      if (!id || !sameIdGroup) {
        unclaimedResults.push({ result: legacyNormalized, id: id ?? undefined });
        continue;
      }

      const unfilledOccurrence = sameIdGroup.occurrences[sameIdGroup.nextUnfilledIndex];
      if (unfilledOccurrence) {
        unfilledOccurrence.result = normalizeToolResultName(
          legacyNormalized,
          unfilledOccurrence.name,
        );
        sameIdGroup.nextUnfilledIndex += 1;
        if (isSyntheticMissingToolResult(unfilledOccurrence.result)) {
          sameIdGroup.syntheticOccurrences.push(unfilledOccurrence);
        }
        continue;
      }

      onDuplicate();
      if (!isSyntheticMissingToolResult(legacyNormalized)) {
        const replaceableOccurrence =
          sameIdGroup.syntheticOccurrences[sameIdGroup.nextSyntheticIndex];
        if (replaceableOccurrence) {
          sameIdGroup.nextSyntheticIndex += 1;
          replaceableOccurrence.result = normalizeToolResultName(
            legacyNormalized,
            replaceableOccurrence.name,
          );
        }
      }
    }

    const stopReason = (assistant as { stopReason?: string }).stopReason;
    const failed = stopReason === "error" || stopReason === "aborted";

    return {
      startIndex,
      endIndex,
      assistant,
      remainder,
      unclaimedResults,
      occurrences,
      failed,
    };
  });
}

export function repairToolUseResultPairing(
  messages: AgentMessage[],
  options?: ToolUseResultPairingOptions,
): ToolUseRepairReport {
  // Anthropic (and Cloud Code Assist) reject transcripts where assistant tool calls are not
  // immediately followed by matching tool results. Session files can end up with results
  // displaced (e.g. after user turns) or duplicated. Repair by:
  // - moving matching toolResult messages directly after their assistant toolCall turn
  // - inserting synthetic error toolResults for missing ids
  // - dropping duplicate toolResults for the same tool-call occurrence
  // Provider ids are opaque and can legitimately repeat on later assistant turns.
  const added: Array<Extract<AgentMessage, { role: "toolResult" }>> = [];
  let droppedDuplicateCount = 0;
  let droppedOrphanCount = 0;
  const frames = buildToolUseFrames(messages, () => {
    droppedDuplicateCount += 1;
  });

  // Cross-frame recovery is intentionally conservative. A displaced result is moved only
  // when exactly one still-unresolved call occurrence can own it; repeated ids otherwise
  // make attribution unknowable, and guessing would feed the model the wrong tool output.
  const unresolvedById = new Map<string, ToolCallOccurrence[]>();
  for (const frame of frames) {
    for (const occurrence of frame.occurrences) {
      if (!occurrence.result || isSyntheticMissingToolResult(occurrence.result)) {
        const unresolved = unresolvedById.get(occurrence.id);
        if (unresolved) {
          unresolved.push(occurrence);
        } else {
          unresolvedById.set(occurrence.id, [occurrence]);
        }
      }
    }

    for (const record of frame.unclaimedResults) {
      if (!record.id) {
        droppedOrphanCount += 1;
        continue;
      }
      const candidates = (unresolvedById.get(record.id) ?? []).filter(
        (candidate) =>
          !candidate.result ||
          (isSyntheticMissingToolResult(candidate.result) &&
            !isSyntheticMissingToolResult(record.result)),
      );
      if (candidates.length !== 1) {
        droppedOrphanCount += 1;
        continue;
      }

      const [candidate] = candidates;
      if (!candidate) {
        droppedOrphanCount += 1;
        continue;
      }
      if (candidate.result) {
        droppedDuplicateCount += 1;
      }
      candidate.result = normalizeToolResultName(record.result, candidate.name);
    }
  }

  const out: AgentMessage[] = [];
  let cursor = 0;
  const pushUnframedRange = (endIndex: number) => {
    for (; cursor < endIndex; cursor += 1) {
      const message = messages[cursor];
      if (!message || typeof message !== "object") {
        continue;
      }
      if (message.role === "toolResult") {
        droppedOrphanCount += 1;
        continue;
      }
      out.push(message);
    }
  };

  for (const frame of frames) {
    pushUnframedRange(frame.startIndex);
    cursor = frame.endIndex;

    if (!(frame.failed && shouldDropErroredAssistantResults(options))) {
      out.push(frame.assistant);
      for (const occurrence of frame.occurrences) {
        if (occurrence.result) {
          out.push(occurrence.result);
          continue;
        }
        if (frame.failed) {
          continue;
        }
        const missing = makeMissingToolResult({
          toolCallId: occurrence.id,
          toolName: occurrence.name,
          text: options?.missingToolResultText,
        });
        occurrence.result = missing;
        added.push(missing);
        out.push(missing);
      }
    }
    out.push(...frame.remainder);
  }
  pushUnframedRange(messages.length);

  const changed =
    out.length !== messages.length || out.some((message, index) => message !== messages[index]);
  return {
    messages: changed ? out : messages,
    added,
    droppedDuplicateCount,
    droppedOrphanCount,
    moved: changed,
  };
}
