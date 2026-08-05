import type { AgentMessage } from "../../types.js";
import {
  asAgentMessage,
  createBranchSummaryMessage,
  createCompactionSummaryMessage,
  createCustomMessage,
} from "../messages.js";
import type { CompactionEntry, ResetEntry, SessionContext, SessionTreeEntry } from "../types.js";

type ContextBoundary = CompactionEntry | ResetEntry;
const SESSION_HISTORY_PRELUDE = Symbol.for("openclaw.sessionHistoryPrelude");

export type SessionReplayWindow = {
  boundaryPosition: number;
  boundaryType: ContextBoundary["type"];
  postBoundaryPosition: number;
  retainedStartPosition: number;
};

export function projectSessionReplayWindow(params: {
  boundaryPosition: number;
  boundaryType: ContextBoundary["type"];
  entryCount: number;
  firstKeptPosition?: number;
}): SessionReplayWindow | undefined {
  const entryCount = Number.isFinite(params.entryCount)
    ? Math.max(0, Math.floor(params.entryCount))
    : 0;
  const boundaryPosition = Number.isFinite(params.boundaryPosition)
    ? Math.floor(params.boundaryPosition)
    : -1;
  if (boundaryPosition < 0 || boundaryPosition >= entryCount) {
    return undefined;
  }
  const firstKeptPosition = params.firstKeptPosition;
  const retainedStartPosition =
    typeof firstKeptPosition === "number" &&
    Number.isInteger(firstKeptPosition) &&
    firstKeptPosition >= 0 &&
    firstKeptPosition < boundaryPosition
      ? firstKeptPosition
      : boundaryPosition;
  return {
    boundaryPosition,
    boundaryType: params.boundaryType,
    postBoundaryPosition: boundaryPosition + 1,
    retainedStartPosition,
  };
}

function resolveSessionReplayWindow(pathEntries: SessionTreeEntry[]):
  | {
      boundary: ContextBoundary;
      window: SessionReplayWindow;
    }
  | undefined {
  const boundaryPosition = pathEntries.findLastIndex(
    (entry) => entry.type === "compaction" || entry.type === "reset",
  );
  const boundary = pathEntries[boundaryPosition];
  if (!boundary || (boundary.type !== "compaction" && boundary.type !== "reset")) {
    return undefined;
  }
  const firstKeptPosition = pathEntries.findIndex(
    (entry, index) => index < boundaryPosition && entry.id === boundary.firstKeptEntryId,
  );
  const window = projectSessionReplayWindow({
    boundaryPosition,
    boundaryType: boundary.type,
    entryCount: pathEntries.length,
    ...(firstKeptPosition >= 0 ? { firstKeptPosition } : {}),
  });
  return window ? { boundary, window } : undefined;
}

function appendContextMessage(messages: AgentMessage[], entry: SessionTreeEntry): void {
  if (entry.type === "message") {
    messages.push(entry.message);
  } else if (entry.type === "custom_message") {
    messages.push(
      asAgentMessage(
        createCustomMessage(
          entry.customType,
          entry.content,
          entry.display,
          entry.details,
          entry.timestamp,
        ),
      ),
    );
  } else if (entry.type === "branch_summary" && entry.summary) {
    messages.push(
      asAgentMessage(createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp)),
    );
  }
}

function appendResetKeptMessage(messages: AgentMessage[], entry: SessionTreeEntry): void {
  if (
    entry.type === "message" &&
    (entry.message.role === "user" || entry.message.role === "assistant")
  ) {
    const message = { ...entry.message } as AgentMessage & { [SESSION_HISTORY_PRELUDE]?: true };
    Object.defineProperty(message, SESSION_HISTORY_PRELUDE, {
      configurable: true,
      enumerable: false,
      value: true,
    });
    messages.push(message);
  }
}

function collectAssistantToolCallIds(entries: SessionTreeEntry[]): Set<string> {
  const ids = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== "message" || entry.message.role !== "assistant") {
      continue;
    }
    const content = entry.message.content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const block of content) {
      if (!block || typeof block !== "object") {
        continue;
      }
      const record = block as { type?: unknown; id?: unknown };
      if (
        typeof record.id === "string" &&
        record.id &&
        (record.type === "toolCall" || record.type === "toolUse" || record.type === "functionCall")
      ) {
        ids.add(record.id);
      }
    }
  }
  return ids;
}

function extractToolResultIds(message: AgentMessage): string[] {
  if (message.role !== "toolResult") {
    return [];
  }
  const record = message as AgentMessage & {
    toolCallId?: unknown;
    toolUseId?: unknown;
    tool_call_id?: unknown;
    tool_use_id?: unknown;
    callId?: unknown;
    call_id?: unknown;
  };
  return [
    record.toolCallId,
    record.toolUseId,
    record.tool_call_id,
    record.tool_use_id,
    record.callId,
    record.call_id,
  ].flatMap((value) => (typeof value === "string" && value.trim() ? [value.trim()] : []));
}

function appendResetRecoveryMessage(
  messages: AgentMessage[],
  entry: SessionTreeEntry,
  retainedToolCallIds: Set<string>,
): void {
  appendResetKeptMessage(messages, entry);
  if (
    entry.type === "message" &&
    entry.message.role === "toolResult" &&
    extractToolResultIds(entry.message).some((id) => retainedToolCallIds.has(id))
  ) {
    messages.push(entry.message);
  }
}

function buildSessionContextInternal(
  pathEntries: SessionTreeEntry[],
  options?: { pairResetToolResultsForRecovery?: boolean },
): SessionContext {
  let thinkingLevel = "off";
  let model: { provider: string; modelId: string } | null = null;

  for (const entry of pathEntries) {
    if (entry.type === "thinking_level_change") {
      thinkingLevel = entry.thinkingLevel;
    } else if (entry.type === "model_change") {
      model = { provider: entry.provider, modelId: entry.modelId };
    } else if (entry.type === "message" && entry.message.role === "assistant") {
      model = { provider: entry.message.provider, modelId: entry.message.model };
    }
  }

  const messages: AgentMessage[] = [];
  const replay = resolveSessionReplayWindow(pathEntries);
  if (replay) {
    const { boundary, window } = replay;
    if (boundary.type === "compaction") {
      messages.push(
        asAgentMessage(
          createCompactionSummaryMessage(
            boundary.summary,
            boundary.tokensBefore,
            boundary.timestamp,
          ),
        ),
      );
    }
    const retainedEntries = pathEntries.slice(
      window.retainedStartPosition,
      window.boundaryPosition,
    );
    const retainedToolCallIds =
      boundary.type === "reset" && options?.pairResetToolResultsForRecovery
        ? collectAssistantToolCallIds(retainedEntries)
        : undefined;
    // Normal reset replay mirrors the old cross-log contract: only user/assistant
    // rows survive. Safeguard recovery additionally retains tool results paired to
    // those assistant rows so redistillation never sees orphaned tool calls.
    for (const entry of retainedEntries) {
      if (boundary.type === "reset") {
        if (retainedToolCallIds) {
          appendResetRecoveryMessage(messages, entry, retainedToolCallIds);
        } else {
          appendResetKeptMessage(messages, entry);
        }
      } else {
        appendContextMessage(messages, entry);
      }
    }
    for (const entry of pathEntries.slice(window.postBoundaryPosition)) {
      appendContextMessage(messages, entry);
    }
  } else {
    for (const entry of pathEntries) {
      appendContextMessage(messages, entry);
    }
  }

  return { messages, thinkingLevel, model };
}

/** Build model context from an ordered session branch and its latest state markers. */
export function buildSessionContext(pathEntries: SessionTreeEntry[]): SessionContext {
  return buildSessionContextInternal(pathEntries);
}

/** Build safeguard recovery context while retaining paired reset tool results. */
export function buildSessionRecoveryContext(pathEntries: SessionTreeEntry[]): SessionContext {
  return buildSessionContextInternal(pathEntries, { pairResetToolResultsForRecovery: true });
}
