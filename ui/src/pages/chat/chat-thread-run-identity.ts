import {
  readAssistantStreamSegmentIdentity,
  readSessionMessageIdentity,
} from "@openclaw/gateway-client/browser";
import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { ChatItem } from "../../lib/chat/chat-types.ts";
import {
  userTurnRunId,
  type ChatProjection,
  type TurnInsertionBounds,
} from "./chat-thread-items.ts";
import { chatItemStartsUserTurn } from "./chat-turn-boundary.ts";
import { readLiveTerminalRunId } from "./terminal-message-identity.ts";
import { buildToolStreamIdentity, extractToolMessageRefs } from "./tool-stream-identity.ts";

export function transcriptRunId(message: unknown): string | undefined {
  const identity = readSessionMessageIdentity(message);
  if (identity?.runId) {
    return identity.runId;
  }
  const record = asRecord(message);
  return (
    readLiveTerminalRunId(message) ??
    normalizeOptionalString(record?.runId) ??
    normalizeOptionalString(asRecord(record?.openclawStreamFallback)?.runId)
  );
}

export function isKeyedAssistantStreamFallbackMessage(message: unknown): boolean {
  return readAssistantStreamSegmentIdentity(message) !== undefined;
}

export function optionalRunIdentity(value: unknown): { runId: string } | undefined {
  const runId = normalizeOptionalString(value);
  return runId ? { runId } : undefined;
}

export function optionalBoundaryIdentity(value: unknown): { boundaryId: string } | undefined {
  const runId = normalizeOptionalString(value);
  return runId ? { boundaryId: `send:${runId}` } : undefined;
}

export function createToolCallLookup<Value>() {
  const exact = new Map<string, Value>();
  const unique = new Map<string, Value | null>();
  return {
    add(runId: string | undefined, callId: string | undefined, value: Value) {
      if (!callId) {
        return;
      }
      if (runId) {
        exact.set(buildToolStreamIdentity(runId, callId), value);
      }
      // Ambiguity belongs to each fact, not the whole call. Even equal values
      // from two occurrences cannot identify an unscoped owner.
      unique.set(callId, unique.has(callId) ? null : value);
    },
    get(runId: string | undefined, callId: string | undefined): Value | undefined {
      return callId
        ? ((runId ? exact.get(buildToolStreamIdentity(runId, callId)) : undefined) ??
            unique.get(callId) ??
            undefined)
        : undefined;
    },
  };
}

function isUserChatItem(item: ChatItem): item is Extract<ChatItem, { kind: "message" }> {
  return item.kind === "message" && chatItemStartsUserTurn(item);
}

export function findCurrentTurnBounds(items: ChatItem[]): TurnInsertionBounds | null {
  const item = items.findLast(isUserChatItem);
  return item ? { afterKey: item.key } : null;
}

export function createRunTurnLookup(items: ChatItem[]) {
  let bounds: Map<string, TurnInsertionBounds> | undefined;
  return (runId: string): TurnInsertionBounds | null => {
    if (!bounds) {
      bounds = new Map();
      let nextUserKey: string | undefined;
      // Keys survive canvas splices. Rebuild after user rows are filtered or
      // inserted; the earliest user for a run owns its next-user ceiling.
      for (let index = items.length - 1; index >= 0; index--) {
        const item = items[index]!;
        if (!isUserChatItem(item)) {
          continue;
        }
        const owner = userTurnRunId(item.message);
        if (owner !== null) {
          bounds.set(owner, {
            afterKey: item.key,
            ...(nextUserKey ? { beforeKey: nextUserKey } : {}),
          });
        }
        nextUserKey = item.key;
      }
    }
    return bounds.get(runId) ?? null;
  };
}

export function resolveRunInsertionBounds(
  findRunBounds: ReturnType<typeof createRunTurnLookup>,
  runId: unknown,
  currentRunId: string | null | undefined,
  currentTurnBounds: TurnInsertionBounds | null,
): TurnInsertionBounds | null {
  if (typeof runId !== "string" || !runId.trim()) {
    return currentRunId != null ? currentTurnBounds : null;
  }
  const runBounds = findRunBounds(runId);
  if (runId === currentRunId) {
    // Active runs can span steers: the original prompt is a floor, not a ceiling.
    return runBounds ? { afterKey: runBounds.afterKey } : currentTurnBounds;
  }
  if (runBounds || currentRunId == null) {
    return runBounds;
  }
  // Legacy rows may lack the user-run identity needed for exact bounds. Keep
  // them ordered before the current prompt instead of attaching them to it.
  return currentTurnBounds?.afterKey ? { beforeKey: currentTurnBounds.afterKey } : null;
}

/** A persisted invocation owns its live echo's interval even without a user send key. */
export function applyPersistedToolInvocationBounds(
  items: ChatItem[],
  tools: Array<ChatProjection<Extract<ChatItem, { kind: "message" }>>>,
): void {
  if (tools.length === 0) {
    return;
  }
  const invocations = new Map<string, TurnInsertionBounds | null>();
  let bounds: TurnInsertionBounds = {};
  for (const item of items) {
    if (item.kind === "divider") {
      invocations.clear();
    }
    if (chatItemStartsUserTurn(item) || item.kind === "divider") {
      bounds.beforeKey = item.key;
      bounds = { afterKey: item.key };
    } else if (item.kind === "message") {
      for (const ref of extractToolMessageRefs(item.message)) {
        if (!ref.runId) {
          continue;
        }
        const key = buildToolStreamIdentity(ref.runId, ref.id);
        // Reused identities on opposite sides of a user/reset remain ambiguous.
        invocations.set(
          key,
          invocations.has(key) && invocations.get(key) !== bounds ? null : bounds,
        );
      }
    }
  }
  for (const tool of tools) {
    const refs = extractToolMessageRefs(tool.item.message);
    const matching = refs.map((ref) =>
      ref.runId ? invocations.get(buildToolStreamIdentity(ref.runId, ref.id)) : undefined,
    );
    const [first] = matching;
    if (first && matching.every((candidate) => candidate === first)) {
      tool.bounds = first;
    }
  }
}
