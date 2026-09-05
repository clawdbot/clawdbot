import { recordDroppedChannelInboundHistory } from "openclaw/plugin-sdk/channel-inbound";
import {
  buildHistoryContext,
  createChannelHistoryWindow,
  type HistoryEntry,
} from "openclaw/plugin-sdk/reply-history";
import { truncateUtf8Prefix } from "openclaw/plugin-sdk/text-utility-runtime";
import type { BuzzDirectoryState } from "./directory-state.js";
import type { BuzzInboundMessage } from "./message-event.js";

const ENTRY_BYTES = 512;
const CONTEXT_BYTES = 1_024;

export async function recordBuzzPendingHistory(params: {
  historyMap: Map<string, HistoryEntry[]>;
  key: string;
  limit: number;
  message: BuzzInboundMessage;
  text: string;
  shouldRecord: () => boolean;
}) {
  await recordDroppedChannelInboundHistory({
    input: {
      id: params.message.id,
      timestamp: params.message.createdAt * 1_000,
      rawText: truncateUtf8Prefix(params.text, ENTRY_BYTES),
    },
    preflight: {
      admission: { kind: "drop", reason: "missing-mention", recordHistory: true },
      message: { senderLabel: params.message.senderPubkey },
      history: {
        historyMap: params.historyMap,
        key: params.key,
        limit: params.limit,
        shouldRecord: params.shouldRecord,
      },
    },
  });
}

export function snapshotBuzzPendingHistory(params: {
  historyMap: Map<string, HistoryEntry[]>;
  key: string;
  limit: number;
  channelId: string;
  directory: BuzzDirectoryState;
  currentMessage: string;
}) {
  const { historyMap, key, directory } = params;
  const pending =
    createChannelHistoryWindow({ historyMap }).buildInboundHistory({
      historyKey: key,
      limit: params.limit,
    }) ?? [];
  const entries: HistoryEntry[] = [];
  let historyText = "";
  // Keep the newest complete entries; count alone cannot bound model-visible context.
  for (const entry of pending.toReversed()) {
    if (!directory.isMember(params.channelId, entry.sender)) {
      continue;
    }
    const label = truncateUtf8Prefix(directory.resolveSenderName(entry.sender), 128);
    const nextText = [`${label}: ${entry.body}`, historyText].filter(Boolean).join("\n");
    if (
      Buffer.byteLength(buildHistoryContext({ historyText: nextText, currentMessage: "" })) >
      CONTEXT_BYTES
    ) {
      break;
    }
    entries.unshift(entry);
    historyText = nextText;
  }
  if (entries.length) {
    historyMap.set(key, entries);
  } else {
    historyMap.delete(key);
  }
  const consumedIds = new Set(entries.map((entry) => entry.messageId));
  return {
    bodyForAgent: buildHistoryContext({ historyText, currentMessage: params.currentMessage }),
    consume: () => {
      // A reply may finish after another passive message arrives. Consume only this snapshot.
      const remaining = historyMap.get(key)?.filter((entry) => !consumedIds.has(entry.messageId));
      if (remaining?.length) {
        historyMap.set(key, remaining);
      } else {
        historyMap.delete(key);
      }
    },
  };
}
