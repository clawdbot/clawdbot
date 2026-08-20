import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { AgentMessage } from "../../types.js";
import type { SessionTreeEntry } from "../types.js";

const TOOL_CALL_TYPES = new Set(["toolCall", "toolUse", "functionCall"]);
const SYNTHETIC_MISSING_TOOL_RESULT_DETAIL_KEY = "openclawSyntheticMissingToolResult";
const DEFAULT_MISSING_TOOL_RESULT_TEXT =
  "[openclaw] missing tool result in session history; inserted synthetic error result for transcript repair.";

type ToolCallLike = {
  id: string;
  name?: string;
};

type ToolCallOccurrence = {
  id: string;
  name?: string;
  result?: ToolResultMessage;
  sourceResult?: ToolResultMessage;
};

type ToolResultMessage = Extract<AgentMessage, { role: "toolResult" }>;

type ToolResultRecord = {
  result: ToolResultMessage;
  sourceResult: ToolResultMessage;
  id?: string;
};

type ToolUsePairingFrame = {
  startIndex: number;
  endIndex: number;
  assistant: Extract<AgentMessage, { role: "assistant" }>;
  remainder: AgentMessage[];
  occurrences: ToolCallOccurrence[];
  failed: boolean;
};

type ToolUsePairingClassification = {
  frames: ToolUsePairingFrame[];
  droppedDuplicateCount: number;
  droppedOrphanCount: number;
};

type ToolCallOccurrenceQueue<T> = {
  add: (id: string, occurrence: T) => void;
  claim: (id: string) => T | undefined;
  clear: () => void;
  readonly size: number;
};

/** Tracks repeated provider ids by occurrence instead of collapsing them into a set. */
export function createToolCallOccurrenceQueue<T>(): ToolCallOccurrenceQueue<T> {
  const pendingById = new Map<string, T[]>();
  let pendingCount = 0;
  return {
    add(id, occurrence) {
      const pending = pendingById.get(id);
      if (pending) {
        pending.push(occurrence);
      } else {
        pendingById.set(id, [occurrence]);
      }
      pendingCount += 1;
    },
    claim(id) {
      const pending = pendingById.get(id);
      const occurrence = pending?.shift();
      if (!occurrence) {
        return undefined;
      }
      pendingCount -= 1;
      if (pending?.length === 0) {
        pendingById.delete(id);
      }
      return occurrence;
    },
    clear() {
      pendingById.clear();
      pendingCount = 0;
    },
    get size() {
      return pendingCount;
    },
  };
}

export function extractToolCallsFromAssistant(
  message: Extract<AgentMessage, { role: "assistant" }>,
): ToolCallLike[] {
  if (!Array.isArray(message.content)) {
    return [];
  }
  return message.content.flatMap((block) => {
    if (!block || typeof block !== "object") {
      return [];
    }
    const record = block as { type?: unknown; id?: unknown; name?: unknown };
    if (
      typeof record.type !== "string" ||
      !TOOL_CALL_TYPES.has(record.type) ||
      typeof record.id !== "string" ||
      !record.id
    ) {
      return [];
    }
    return [{ id: record.id, name: typeof record.name === "string" ? record.name : undefined }];
  });
}

export function extractToolResultIds(message: ToolResultMessage): string[] {
  const record = message as {
    toolCallId?: unknown;
    toolUseId?: unknown;
    tool_call_id?: unknown;
    tool_use_id?: unknown;
    callId?: unknown;
    call_id?: unknown;
  };
  const ids: string[] = [];
  for (const value of [
    record.toolCallId,
    record.toolUseId,
    record.tool_call_id,
    record.tool_use_id,
    record.callId,
    record.call_id,
  ]) {
    if (typeof value !== "string") {
      continue;
    }
    const id = value.trim();
    if (id && !ids.includes(id)) {
      ids.push(id);
    }
  }
  return ids;
}

export function extractToolResultId(message: ToolResultMessage): string | null {
  return extractToolResultIds(message)[0] ?? null;
}

export function makeMissingToolResult(params: {
  toolCallId: string;
  toolName?: string;
  text?: string;
}): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: params.toolCallId,
    toolName: params.toolName ?? "unknown",
    content: [{ type: "text", text: params.text ?? DEFAULT_MISSING_TOOL_RESULT_TEXT }],
    details: { [SYNTHETIC_MISSING_TOOL_RESULT_DETAIL_KEY]: true, reason: "missing_tool_result" },
    isError: true,
    timestamp: Date.now(),
  } as ToolResultMessage;
}

function isSyntheticMissingToolResult(message: ToolResultMessage): boolean {
  if (!(message as { isError?: unknown }).isError) {
    return false;
  }
  const details = (message as { details?: unknown }).details;
  if (
    details &&
    typeof details === "object" &&
    (details as Record<string, unknown>)[SYNTHETIC_MISSING_TOOL_RESULT_DETAIL_KEY] === true
  ) {
    return true;
  }
  const content = (message as { content?: unknown }).content;
  return (
    Array.isArray(content) &&
    content.some(
      (block) =>
        typeof block === "object" &&
        block !== null &&
        (block as { type?: string }).type === "text" &&
        (block as { text?: string }).text === DEFAULT_MISSING_TOOL_RESULT_TEXT,
    )
  );
}

function normalizeToolResultName(
  message: ToolResultMessage,
  fallbackName?: string,
): ToolResultMessage {
  const rawToolName = (message as { toolName?: unknown }).toolName;
  const normalizedToolName = normalizeOptionalString(rawToolName);
  if (normalizedToolName) {
    return rawToolName === normalizedToolName
      ? message
      : ({ ...message, toolName: normalizedToolName } as ToolResultMessage);
  }
  const normalizedFallback = normalizeOptionalString(fallbackName);
  if (normalizedFallback) {
    return { ...message, toolName: normalizedFallback } as ToolResultMessage;
  }
  return typeof rawToolName === "string"
    ? ({ ...message, toolName: "unknown" } as ToolResultMessage)
    : message;
}

export function normalizeLegacyToolResultId(
  message: ToolResultMessage,
  toolCalls: ToolCallLike[],
): ToolResultMessage {
  if (extractToolResultId(message) || toolCalls.length !== 1) {
    return message;
  }
  const toolCall = toolCalls[0];
  if (!toolCall) {
    return message;
  }
  const resultName = normalizeOptionalString((message as { toolName?: unknown }).toolName);
  const callName = normalizeOptionalString(toolCall.name);
  if (resultName && callName && resultName !== callName) {
    return message;
  }
  return { ...message, toolCallId: toolCall.id, isError: true } as ToolResultMessage;
}

/** Classifies call/result ownership without reordering or synthesizing transcript messages. */
export function classifyToolUseResultPairing(
  messages: readonly AgentMessage[],
  options?: { preserveUnframedToolResults?: boolean },
): ToolUsePairingClassification {
  const frameStartIndexes = messages.flatMap((message, index) =>
    message?.role === "assistant" && extractToolCallsFromAssistant(message).length > 0
      ? [index]
      : [],
  );
  let droppedDuplicateCount = 0;
  let droppedOrphanCount = 0;
  const preserveUnframed = options?.preserveUnframedToolResults === true;
  const frameRecords: Array<ToolUsePairingFrame & { unclaimedResults: ToolResultRecord[] }> =
    frameStartIndexes.map((startIndex, frameIndex) => {
      const assistant = messages[startIndex] as Extract<AgentMessage, { role: "assistant" }>;
      const toolCalls = extractToolCallsFromAssistant(assistant);
      const occurrences: ToolCallOccurrence[] = [];
      const pending = createToolCallOccurrenceQueue<ToolCallOccurrence>();
      const syntheticById = new Map<string, ToolCallOccurrence[]>();
      for (const toolCall of toolCalls) {
        const occurrence = { id: toolCall.id, name: toolCall.name };
        occurrences.push(occurrence);
        pending.add(toolCall.id, occurrence);
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
        const normalized = normalizeLegacyToolResultId(message, toolCalls);
        const id = extractToolResultId(normalized);
        const occurrence = id ? pending.claim(id) : undefined;
        if (occurrence) {
          occurrence.result = normalizeToolResultName(normalized, occurrence.name);
          occurrence.sourceResult = message;
          if (isSyntheticMissingToolResult(occurrence.result)) {
            const synthetic = syntheticById.get(occurrence.id);
            if (synthetic) {
              synthetic.push(occurrence);
            } else {
              syntheticById.set(occurrence.id, [occurrence]);
            }
          }
          continue;
        }
        if (!id || !occurrences.some((candidate) => candidate.id === id)) {
          unclaimedResults.push({ result: normalized, sourceResult: message, id: id ?? undefined });
          if (preserveUnframed) {
            remainder.push(normalized);
          }
          continue;
        }
        droppedDuplicateCount += 1;
        if (!isSyntheticMissingToolResult(normalized)) {
          const replaceable = syntheticById.get(id)?.shift();
          if (replaceable) {
            replaceable.result = normalizeToolResultName(normalized, replaceable.name);
            replaceable.sourceResult = message;
          }
        }
      }
      const stopReason = (assistant as { stopReason?: string }).stopReason;
      return {
        startIndex,
        endIndex,
        assistant,
        remainder,
        unclaimedResults,
        occurrences,
        failed: stopReason === "error" || stopReason === "aborted",
      };
    });

  // Displaced results cross a frame only when one unresolved occurrence can own them.
  const unresolvedById = new Map<string, ToolCallOccurrence[]>();
  for (const frame of frameRecords) {
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
      const candidates = record.id
        ? (unresolvedById.get(record.id) ?? []).filter(
            (candidate) =>
              !candidate.result ||
              (isSyntheticMissingToolResult(candidate.result) &&
                !isSyntheticMissingToolResult(record.result)),
          )
        : [];
      if (candidates.length !== 1) {
        droppedOrphanCount += preserveUnframed ? 0 : 1;
        continue;
      }
      const candidate = candidates[0];
      if (!candidate) {
        continue;
      }
      droppedDuplicateCount += candidate.result ? 1 : 0;
      candidate.result = normalizeToolResultName(record.result, candidate.name);
      candidate.sourceResult = record.sourceResult;
      if (preserveUnframed) {
        frame.remainder = frame.remainder.filter((message) => message !== record.result);
      }
    }
  }

  return { frames: frameRecords, droppedDuplicateCount, droppedOrphanCount };
}

/** Select reset-tail model context without changing persisted entry bytes or order. */
export function selectResetKeptEntries(entries: readonly SessionTreeEntry[]): SessionTreeEntry[] {
  const messages = entries.flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
  const pairing = classifyToolUseResultPairing(messages);
  const pairedResults = new Set(
    pairing.frames.flatMap((frame) =>
      frame.occurrences.flatMap((occurrence) =>
        occurrence.sourceResult ? [occurrence.sourceResult] : [],
      ),
    ),
  );
  return entries.filter(
    (entry) =>
      entry.type === "message" &&
      (entry.message.role === "user" ||
        entry.message.role === "assistant" ||
        (entry.message.role === "toolResult" && pairedResults.has(entry.message))),
  );
}
