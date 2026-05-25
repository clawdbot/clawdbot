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

export type RepairIMessageConversationAnchorParams = {
  client: IMessageRpcClient;
  message: IMessagePayload;
  runtime?: RuntimeLogger;
  chatsLimit?: number;
  perChatHistoryLimit?: number;
  rpcTimeoutMs?: number;
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

export function isIMessageAnchorless(message: IMessagePayload): boolean {
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

function overlayRecoveredConversation(
  message: IMessagePayload,
  entry: Record<string, unknown>,
): IMessagePayload {
  const repaired = { ...message };

  if (hasPositiveChatId(entry.chat_id)) {
    repaired.chat_id = entry.chat_id;
  }
  if (isNonEmptyString(entry.chat_guid)) {
    repaired.chat_guid = entry.chat_guid;
  }
  if (isNonEmptyString(entry.chat_identifier)) {
    repaired.chat_identifier = entry.chat_identifier;
  }
  if (typeof entry.is_group === "boolean") {
    repaired.is_group = entry.is_group;
  }
  if (typeof entry.chat_name === "string") {
    repaired.chat_name = entry.chat_name;
  }
  if (
    Array.isArray(entry.participants) &&
    entry.participants.every((participant) => typeof participant === "string")
  ) {
    repaired.participants = entry.participants;
  }

  return repaired;
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

      const repaired = overlayRecoveredConversation(message, entry);
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
  }

  runtime?.error?.(`imessage: dropping anchorless message GUID=${guid}; no recent chat matched`);
  return null;
}
