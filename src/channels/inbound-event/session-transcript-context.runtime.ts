import { isSessionBoundaryCommandText } from "../../auto-reply/command-detection.js";
import type { HistoryEntry } from "../../auto-reply/reply/history.types.js";
import type { FinalizedMsgContext } from "../../auto-reply/templating.js";
import { readRecentUserAssistantTextForSession } from "../../config/sessions/transcript.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { stripInlineDirectiveTagsForDelivery } from "../../utils/directive-tags.js";

type PromptMessage = Record<string, unknown>;

function messageKeys(message: PromptMessage): string[] {
  const id = typeof message.message_id === "string" ? message.message_id.trim() : "";
  const body = typeof message.body === "string" ? message.body.trim() : "";
  const timestamp = message.timestamp_ms;
  return [
    id ? `id:${id}` : "",
    body && typeof timestamp === "number" ? `text:${timestamp}:${body}` : "",
  ].filter(Boolean);
}

function historyMessage(entry: HistoryEntry): PromptMessage {
  return {
    ...(entry.messageId ? { message_id: entry.messageId } : {}),
    sender: entry.sender,
    ...(entry.timestamp !== undefined ? { timestamp_ms: entry.timestamp } : {}),
    body: entry.body,
  };
}

function compareMessages(left: PromptMessage, right: PromptMessage): number {
  const leftTimestamp = typeof left.timestamp_ms === "number" ? left.timestamp_ms : 0;
  const rightTimestamp = typeof right.timestamp_ms === "number" ? right.timestamp_ms : 0;
  return leftTimestamp - rightTimestamp;
}

function mergeMessages(params: {
  existing: PromptMessage[];
  transcript: Array<{
    entry: HistoryEntry;
    role: "assistant" | "user";
    transcriptId?: string;
  }>;
  dedupeAssistantTextKeys: Set<string>;
  dedupeTranscriptIds: Set<string>;
  limit: number;
}): { added: number; messages: PromptMessage[] } {
  const seen = new Set(params.existing.flatMap(messageKeys));
  const seenTranscript = new Set<string>();
  const added: PromptMessage[] = [];
  for (const item of params.transcript) {
    if (item.transcriptId && params.dedupeTranscriptIds.has(item.transcriptId)) {
      continue;
    }
    const message = historyMessage(item.entry);
    const keys = messageKeys(message);
    const assistantTextKeys =
      item.role === "assistant"
        ? messageKeys({
            ...message,
            body: stripInlineDirectiveTagsForDelivery(item.entry.body).text,
          })
        : keys;
    if (
      keys.some((key) => seenTranscript.has(key)) ||
      (item.role === "assistant" &&
        assistantTextKeys.some((key) => params.dedupeAssistantTextKeys.has(key))) ||
      (item.role === "user" && keys.some((key) => seen.has(key)))
    ) {
      continue;
    }
    keys.forEach((key) => seenTranscript.add(key));
    added.push(message);
  }
  const sorted = [...added, ...params.existing].toSorted(compareMessages);
  if (sorted.length <= params.limit) {
    return { added: added.length, messages: sorted };
  }
  const pinned = sorted.filter((message) => message.is_reply_target === true);
  const available = Math.max(0, params.limit - pinned.length);
  const recent =
    available === 0
      ? []
      : sorted.filter((message) => message.is_reply_target !== true).slice(-available);
  return {
    added: added.length,
    messages: [...pinned.slice(-params.limit), ...recent].toSorted(compareMessages),
  };
}

function chatWindowEntries(ctx: FinalizedMsgContext) {
  return (ctx.UntrustedStructuredContext ?? []).filter(
    (entry): entry is typeof entry & { payload: Record<string, unknown> } =>
      entry.type === "chat_window" &&
      Boolean(entry.payload) &&
      typeof entry.payload === "object" &&
      !Array.isArray(entry.payload),
  );
}

/** Merges active canonical transcript turns into the prepared channel history in place. */
export async function mergeSessionTranscriptContext(params: {
  agentId?: string;
  ctx: FinalizedMsgContext;
  sessionKey: string;
  storePath: string;
}): Promise<void> {
  const options = params.ctx.SessionTranscriptContext;
  const limit = Math.max(0, Math.floor(options?.historyLimit ?? 0));
  if (
    limit === 0 ||
    isSessionBoundaryCommandText(params.ctx.CommandBody ?? params.ctx.RawBody, {
      botUsername: params.ctx.BotUsername,
    })
  ) {
    return;
  }
  // Routed channel turns provide agentId; direct callers may derive only an
  // explicitly scoped owner. Unscoped keys without routing context fail closed.
  const agentId = params.agentId?.trim() || parseAgentSessionKey(params.sessionKey)?.agentId;
  if (!agentId) {
    throw new Error("Session transcript context requires an agent owner.");
  }
  const turns = await readRecentUserAssistantTextForSession({
    agentId,
    sessionKey: params.sessionKey,
    storePath: params.storePath,
    limit,
    ...((options?.beforeTimestampMs ?? params.ctx.Timestamp) !== undefined
      ? { beforeTimestampMs: options?.beforeTimestampMs ?? params.ctx.Timestamp }
      : {}),
    ...(options?.minTimestampMs !== undefined ? { minTimestampMs: options.minTimestampMs } : {}),
  });
  const labels = options?.senderLabels ?? { assistant: "Assistant", user: "User" };
  const transcript = turns.map((turn) => {
    const item: {
      entry: HistoryEntry;
      role: "assistant" | "user";
      transcriptId?: string;
    } = {
      entry: {
        sender: `${labels[turn.role]}${turn.sourceChannel ? ` (${turn.sourceChannel})` : ""}`,
        body: turn.text,
      },
      role: turn.role,
    };
    if (turn.id) {
      item.transcriptId = turn.id;
      item.entry.messageId = `session:${turn.id}`;
    }
    if (turn.timestamp !== undefined) {
      item.entry.timestamp = turn.timestamp;
    }
    return item;
  });
  if (transcript.length === 0) {
    return;
  }
  const windows = chatWindowEntries(params.ctx);
  if (windows.length === 0 && options?.chatWindow) {
    params.ctx.UntrustedStructuredContext = [
      ...(params.ctx.UntrustedStructuredContext ?? []),
      {
        label: "Conversation context",
        source: "session",
        type: "chat_window",
        payload: {
          order: "chronological",
          relation: "selected_for_current_message",
          messages: transcript.map(({ entry }) => historyMessage(entry)).slice(-limit),
        },
      },
    ];
    return;
  }
  if (windows.length === 0) {
    const existing = params.ctx.InboundHistory ?? [];
    const seen = new Set(existing.flatMap((entry) => messageKeys(historyMessage(entry))));
    const added = transcript.flatMap(({ entry }) => {
      const keys = messageKeys(historyMessage(entry));
      if (keys.some((key) => seen.has(key))) {
        return [];
      }
      keys.forEach((key) => seen.add(key));
      return [entry];
    });
    params.ctx.InboundHistory = [...existing, ...added]
      .toSorted((left, right) => (left.timestamp ?? 0) - (right.timestamp ?? 0))
      .slice(-limit);
    return;
  }
  for (const window of windows) {
    const existing = Array.isArray(window.payload.messages)
      ? window.payload.messages.filter(
          (message): message is PromptMessage =>
            Boolean(message) && typeof message === "object" && !Array.isArray(message),
        )
      : [];
    const dedupeIds = window.sessionTranscriptDedupeMessageIds;
    const assistantTextKeys = window.sessionTranscriptAssistantTextDedupeKeys;
    const ids = Array.isArray(dedupeIds)
      ? new Set(dedupeIds.filter((id): id is string => typeof id === "string"))
      : new Set<string>();
    const merged = mergeMessages({
      existing,
      transcript,
      dedupeTranscriptIds: ids,
      dedupeAssistantTextKeys: new Set(assistantTextKeys ?? []),
      limit,
    });
    window.payload = { ...window.payload, messages: merged.messages };
    if (merged.added > 0) {
      window.source = "session";
    }
  }
}
