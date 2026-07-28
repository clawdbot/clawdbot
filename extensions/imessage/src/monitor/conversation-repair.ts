// Imessage plugin module implements conversation repair behavior.
import type { IMessageRpcClient } from "../client.js";
import type { IMessagePayload } from "./types.js";

const DEFAULT_CHATS_LIMIT = 20;
const DEFAULT_PER_CHAT_HISTORY_LIMIT = 50;
const DEFAULT_RPC_TIMEOUT_MS = 5_000;

type RuntimeLogger = {
  error?: (message: string) => void;
  log?: (message: string) => void;
};

type ChatsListEntry = {
  id?: number | null;
};

type MessagesHistoryResult = {
  messages?: unknown[];
};

type RepairIMessageConversationAnchorParams = {
  client: IMessageRpcClient;
  message: IMessagePayload;
  runtime?: RuntimeLogger;
  chatsLimit?: number;
  perChatHistoryLimit?: number;
  rpcTimeoutMs?: number;
};

type AuthoritativeRecoveryProjection = {
  chat_id?: number;
  chat_guid?: string;
  chat_identifier?: string;
  chat_name?: string;
  participants?: string[];
  is_group: boolean;
  sender: string;
  destination_caller_id?: string;
  is_from_me: boolean;
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function hasPositiveChatId(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isExplicitEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim() === "";
}

function hasUsableConversationAnchor(projection: {
  chat_id?: number;
  chat_guid?: string;
  chat_identifier?: string;
}): boolean {
  return (
    hasPositiveChatId(projection.chat_id) ||
    isNonEmptyString(projection.chat_guid) ||
    isNonEmptyString(projection.chat_identifier)
  );
}

function isIMessageAnchorless(message: IMessagePayload): boolean {
  const hasUsableAnchor =
    hasPositiveChatId(message.chat_id) ||
    isNonEmptyString(message.chat_guid) ||
    isNonEmptyString(message.chat_identifier);
  if (hasUsableAnchor) {
    return false;
  }

  const hasExplicitBrokenAnchor =
    message.chat_id === null ||
    (typeof message.chat_id === "number" &&
      (!Number.isFinite(message.chat_id) || message.chat_id <= 0)) ||
    isExplicitEmptyString(message.chat_guid) ||
    isExplicitEmptyString(message.chat_identifier);

  return hasExplicitBrokenAnchor;
}

function extractAuthoritativeRecoveryProjection(
  entry: Record<string, unknown>,
): AuthoritativeRecoveryProjection | null {
  if (typeof entry.is_group !== "boolean" || typeof entry.is_from_me !== "boolean") {
    return null;
  }
  if (!isNonEmptyString(entry.sender)) {
    return null;
  }

  const projection: AuthoritativeRecoveryProjection = {
    sender: entry.sender.trim(),
    is_from_me: entry.is_from_me,
    is_group: entry.is_group,
  };
  if (isNonEmptyString(entry.destination_caller_id)) {
    projection.destination_caller_id = entry.destination_caller_id.trim();
  }

  if (hasPositiveChatId(entry.chat_id)) {
    projection.chat_id = entry.chat_id;
  }
  if (isNonEmptyString(entry.chat_guid)) {
    projection.chat_guid = entry.chat_guid;
  }
  if (isNonEmptyString(entry.chat_identifier)) {
    projection.chat_identifier = entry.chat_identifier;
  }
  if (typeof entry.chat_name === "string") {
    projection.chat_name = entry.chat_name;
  }
  if (
    Array.isArray(entry.participants) &&
    entry.participants.every((participant) => typeof participant === "string")
  ) {
    projection.participants = entry.participants;
  }

  return hasUsableConversationAnchor(projection) ? projection : null;
}

function projectionConflictKey(projection: AuthoritativeRecoveryProjection): string {
  return JSON.stringify({
    chat_id: projection.chat_id ?? null,
    chat_guid: projection.chat_guid ?? null,
    chat_identifier: projection.chat_identifier ?? null,
    is_group: projection.is_group,
    sender: projection.sender,
    destination_caller_id: projection.destination_caller_id ?? null,
    is_from_me: projection.is_from_me,
  });
}

function applyAuthoritativeRecoveryProjection(
  message: IMessagePayload,
  projection: AuthoritativeRecoveryProjection,
): IMessagePayload {
  return {
    ...message,
    ...(projection.chat_id !== undefined ? { chat_id: projection.chat_id } : {}),
    ...(projection.chat_guid !== undefined ? { chat_guid: projection.chat_guid } : {}),
    ...(projection.chat_identifier !== undefined
      ? { chat_identifier: projection.chat_identifier }
      : {}),
    ...(projection.chat_name !== undefined ? { chat_name: projection.chat_name } : {}),
    ...(projection.participants !== undefined ? { participants: projection.participants } : {}),
    is_group: projection.is_group,
    sender: projection.sender,
    // Exact-GUID history is authoritative for this outgoing-only field: when
    // history omits it, clear any stale notification value instead of inheriting.
    destination_caller_id: projection.destination_caller_id ?? null,
    is_from_me: projection.is_from_me,
  };
}

export async function repairIMessageConversationAnchor(
  params: RepairIMessageConversationAnchorParams,
): Promise<IMessagePayload | null> {
  const { client, message, runtime } = params;

  if (!isIMessageAnchorless(message)) {
    return message;
  }

  const guid = message.guid?.trim();
  if (!guid) {
    runtime?.error?.("imessage: dropping anchorless message without GUID");
    return null;
  }

  let chatsResult: { chats?: ChatsListEntry[] } | undefined;
  try {
    chatsResult = await client.request<{ chats?: ChatsListEntry[] }>(
      "chats.list",
      { limit: params.chatsLimit ?? DEFAULT_CHATS_LIMIT },
      { timeoutMs: params.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS },
    );
  } catch (err) {
    runtime?.error?.(`imessage: anchorless message recovery failed listing chats: ${String(err)}`);
    return null;
  }

  const matchedProjections: AuthoritativeRecoveryProjection[] = [];
  const chats = chatsResult?.chats ?? [];
  for (const chat of chats) {
    const chatId = hasPositiveChatId(chat.id) ? chat.id : null;
    if (chatId === null) {
      continue;
    }

    let historyResult: MessagesHistoryResult | undefined;
    try {
      historyResult = await client.request<MessagesHistoryResult>(
        "messages.history",
        {
          attachments: false,
          chat_id: chatId,
          limit: params.perChatHistoryLimit ?? DEFAULT_PER_CHAT_HISTORY_LIMIT,
        },
        { timeoutMs: params.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS },
      );
    } catch {
      continue;
    }

    const messages = Array.isArray(historyResult?.messages) ? historyResult.messages : [];
    for (const raw of messages) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        continue;
      }
      const entry = raw as Record<string, unknown>;
      if (entry.guid !== guid) {
        continue;
      }

      const projection = extractAuthoritativeRecoveryProjection(entry);
      if (!projection) {
        runtime?.error?.(
          `imessage: dropping anchorless message GUID=${guid}; exact-GUID history row is incomplete`,
        );
        return null;
      }
      matchedProjections.push(projection);
    }
  }

  const [projection] = matchedProjections;
  if (!projection) {
    runtime?.error?.(`imessage: dropping anchorless message GUID=${guid}; no recent chat matched`);
    return null;
  }

  const conflictKeys = new Set(matchedProjections.map(projectionConflictKey));
  if (conflictKeys.size > 1) {
    runtime?.error?.(
      `imessage: dropping anchorless message GUID=${guid}; conflicting exact-GUID history projections`,
    );
    return null;
  }

  if (projection.is_from_me) {
    runtime?.error?.(
      `imessage: dropping anchorless message GUID=${guid}; recovered authoritative row is from-me`,
    );
    return null;
  }

  const repaired = applyAuthoritativeRecoveryProjection(message, projection);
  if (isIMessageAnchorless(repaired)) {
    runtime?.error?.(
      `imessage: dropping anchorless message GUID=${guid} after recovery found no usable conversation anchor`,
    );
    return null;
  }
  runtime?.log?.(
    `imessage: recovered anchorless message GUID=${guid} chat_id=${repaired.chat_id ?? "unknown"} is_group=${repaired.is_group === true}`,
  );
  return repaired;
}
