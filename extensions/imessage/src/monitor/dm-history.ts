import {
  formatInboundEnvelope,
  type resolveEnvelopeFormatOptions,
} from "openclaw/plugin-sdk/channel-inbound";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { IMessageRpcClient } from "../client.js";
import { normalizeIMessageHandle } from "../targets.js";
import { parseIMessageNotification } from "./parse-notification.js";
import type { IMessagePayload } from "./types.js";

const DM_HISTORY_RPC_TIMEOUT_MS = 10_000;

type IMessageHistoryResult = {
  messages?: unknown[];
};

type IMessageDmHistoryConfig = {
  dmHistoryLimit?: number;
  dms?: Record<string, { historyLimit?: number }>;
};

export type IMessageDmHistoryEntry = {
  sender: string;
  body: string;
  timestamp?: number;
};

export type IMessageDmHistoryContext = {
  body?: string;
  inboundHistory?: IMessageDmHistoryEntry[];
};

export function resolveIMessageDmHistoryLimit(params: {
  config: IMessageDmHistoryConfig;
  sender?: string;
  senderNormalized?: string;
}): number {
  const senderCandidates = [
    normalizeOptionalString(params.senderNormalized),
    normalizeOptionalString(params.sender),
    params.sender ? normalizeIMessageHandle(params.sender) : undefined,
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of senderCandidates) {
    const override = params.config.dms?.[candidate]?.historyLimit;
    if (override !== undefined) {
      return Math.max(0, override);
    }
  }

  return Math.max(0, params.config.dmHistoryLimit ?? 0);
}

function historyRowSortValue(message: IMessagePayload): number {
  if (typeof message.id === "number" && Number.isFinite(message.id)) {
    return message.id;
  }
  const createdAtMs =
    typeof message.created_at === "string" ? Date.parse(message.created_at) : Number.NaN;
  return Number.isFinite(createdAtMs) ? createdAtMs : 0;
}

function isBeforeCurrentMessage(params: {
  message: IMessagePayload;
  currentMessage: IMessagePayload;
}): boolean {
  const { message, currentMessage } = params;
  if (
    typeof message.id === "number" &&
    typeof currentMessage.id === "number" &&
    Number.isFinite(message.id) &&
    Number.isFinite(currentMessage.id)
  ) {
    return message.id < currentMessage.id;
  }
  const guid = normalizeOptionalString(message.guid);
  const currentGuid = normalizeOptionalString(currentMessage.guid);
  if (guid && currentGuid) {
    return guid !== currentGuid;
  }
  return true;
}

function historyEntryFromMessage(message: IMessagePayload, fallbackSender: string) {
  const body = normalizeOptionalString(message.text);
  if (!body) {
    return null;
  }
  const timestamp =
    typeof message.created_at === "string" ? Date.parse(message.created_at) : Number.NaN;
  return {
    sender:
      message.is_from_me === true
        ? "Me"
        : normalizeIMessageHandle(normalizeOptionalString(message.sender) ?? fallbackSender) ||
          fallbackSender,
    body,
    ...(Number.isFinite(timestamp) ? { timestamp } : {}),
  };
}

export async function resolveIMessageDmHistoryContext(params: {
  client: IMessageRpcClient;
  message: IMessagePayload;
  senderNormalized: string;
  limit: number;
  envelopeOptions: ReturnType<typeof resolveEnvelopeFormatOptions>;
  logVerbose?: (msg: string) => void;
}): Promise<IMessageDmHistoryContext> {
  const maxMessages = Math.max(0, Math.floor(params.limit));
  const chatId =
    typeof params.message.chat_id === "number" && Number.isFinite(params.message.chat_id)
      ? params.message.chat_id
      : undefined;
  if (maxMessages <= 0 || chatId === undefined) {
    return {};
  }

  let result: IMessageHistoryResult | undefined;
  try {
    result = await params.client.request<IMessageHistoryResult>(
      "messages.history",
      {
        chat_id: chatId,
        limit: maxMessages + 1,
        attachments: false,
      },
      { timeoutMs: DM_HISTORY_RPC_TIMEOUT_MS },
    );
  } catch (err) {
    params.logVerbose?.(`imessage: DM history fetch failed for chat_id=${chatId}: ${String(err)}`);
    return {};
  }

  const rows = Array.isArray(result?.messages) ? result.messages : [];
  const history = rows
    .map((row) => parseIMessageNotification({ message: row }))
    .filter((message): message is IMessagePayload => Boolean(message))
    .filter((message) => message.is_group !== true)
    .filter((message) => isBeforeCurrentMessage({ message, currentMessage: params.message }))
    .toSorted((a, b) => historyRowSortValue(a) - historyRowSortValue(b))
    .map((message) => historyEntryFromMessage(message, params.senderNormalized))
    .filter((entry): entry is IMessageDmHistoryEntry => Boolean(entry))
    .slice(-maxMessages);

  if (history.length === 0) {
    return {};
  }

  return {
    inboundHistory: history,
    body: history
      .map((entry) =>
        formatInboundEnvelope({
          channel: "iMessage",
          from: entry.sender,
          timestamp: entry.timestamp,
          body: entry.body,
          chatType: "direct",
          senderLabel: entry.sender,
          envelope: params.envelopeOptions,
        }),
      )
      .join("\n\n"),
  };
}
