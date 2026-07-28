import type { ChannelInboundMediaInput } from "openclaw/plugin-sdk/channel-inbound";
// Signal plugin helpers isolate active-run control scheduling from the inbound handler.
import {
  listChatCommands,
  maybeResolveTextAlias,
  normalizeCommandBody,
} from "openclaw/plugin-sdk/command-auth-native";
import { isAbortRequestText } from "openclaw/plugin-sdk/command-primitives-runtime";
import type { SignalIngressLifecycle } from "../signal-ingress.js";

export type SignalInboundEntry = {
  senderName: string;
  senderDisplay: string;
  senderRecipient: string;
  senderPeerId: string;
  groupId?: string;
  groupName?: string;
  isGroup: boolean;
  bodyText: string;
  nativeReplyBody?: string;
  commandBody: string;
  timestamp?: number;
  messageId?: string;
  replyToId?: string;
  isBatched?: boolean;
  media?: ChannelInboundMediaInput[];
  commandAuthorized: boolean;
  canDetectMention?: boolean;
  requireMention?: boolean;
  wasMentioned?: boolean;
  replyToBody?: string;
  replyToSender?: string;
  replyToIsQuote?: boolean;
  turnAdoptionLifecycle?: SignalIngressLifecycle;
};

type TrackedSignalInboundLane = {
  conversationKey: string;
  inboundKey: string;
};

const SIGNAL_ACTIVE_RUN_CONTROL_COMMAND_KEYS = new Set([
  "approve",
  "commands",
  "context",
  "help",
  "status",
  "steer",
  "tasks",
  "tools",
  "whoami",
]);

function resolveSignalConversationId(entry: SignalInboundEntry): string | null {
  const conversationId = entry.isGroup ? entry.groupId : entry.senderPeerId;
  return conversationId?.trim() || null;
}

export function resolveSignalInboundDebounceKey(
  accountId: string,
  entry: SignalInboundEntry,
): string | null {
  const conversationId = resolveSignalConversationId(entry);
  if (!conversationId || !entry.senderPeerId) {
    return null;
  }
  return `signal:${accountId}:${conversationId}:${entry.senderPeerId}`;
}

function resolveSignalInboundConversationKey(
  accountId: string,
  entry: SignalInboundEntry,
): string | null {
  const conversationId = resolveSignalConversationId(entry);
  return conversationId ? `signal:${accountId}:${conversationId}` : null;
}

function isSignalActiveRunControlText(text: string): boolean {
  if (isAbortRequestText(text)) {
    return true;
  }
  const normalizedBody = normalizeCommandBody(text.trim());
  const alias = maybeResolveTextAlias(normalizedBody);
  if (!alias) {
    return false;
  }
  const command = listChatCommands().find((entry) =>
    entry.textAliases.some((candidate) => candidate.trim().toLowerCase() === alias),
  );
  if (command?.key === "queue") {
    // Bare `/queue` only reads current settings. Every argument form can mutate them.
    return normalizedBody.slice(alias.length).trim() === "";
  }
  return command ? SIGNAL_ACTIVE_RUN_CONTROL_COMMAND_KEYS.has(command.key) : false;
}

export function resolveSignalControlLaneKey(
  accountId: string,
  entry: SignalInboundEntry,
): string | null {
  if (!entry.commandAuthorized || !isSignalActiveRunControlText(entry.commandBody)) {
    return null;
  }
  const conversationId = resolveSignalConversationId(entry);
  return conversationId ? `signal:${accountId}:${conversationId}:control` : null;
}

export function createSignalPendingInboundRegistry(accountId: string) {
  const trackedEntries = new WeakMap<SignalInboundEntry, TrackedSignalInboundLane>();
  const countsByConversation = new Map<string, Map<string, number>>();

  const track = (entry: SignalInboundEntry) => {
    if (trackedEntries.has(entry)) {
      return;
    }
    const conversationKey = resolveSignalInboundConversationKey(accountId, entry);
    const inboundKey = resolveSignalInboundDebounceKey(accountId, entry);
    if (!conversationKey || !inboundKey) {
      return;
    }
    const counts = countsByConversation.get(conversationKey) ?? new Map<string, number>();
    counts.set(inboundKey, (counts.get(inboundKey) ?? 0) + 1);
    countsByConversation.set(conversationKey, counts);
    trackedEntries.set(entry, { conversationKey, inboundKey });
  };

  const complete = (entries: SignalInboundEntry[]) => {
    for (const entry of entries) {
      const tracked = trackedEntries.get(entry);
      if (!tracked) {
        continue;
      }
      trackedEntries.delete(entry);
      const counts = countsByConversation.get(tracked.conversationKey);
      const nextCount = (counts?.get(tracked.inboundKey) ?? 0) - 1;
      if (nextCount > 0) {
        counts?.set(tracked.inboundKey, nextCount);
        continue;
      }
      counts?.delete(tracked.inboundKey);
      if (counts?.size === 0) {
        countsByConversation.delete(tracked.conversationKey);
      }
    }
  };

  const cancelPendingOnAbort = (entry: SignalInboundEntry, cancelKey: (key: string) => boolean) => {
    if (!entry.commandAuthorized || !isAbortRequestText(entry.commandBody)) {
      return;
    }
    const conversationKey = resolveSignalInboundConversationKey(accountId, entry);
    if (!conversationKey) {
      return;
    }
    // Group members have distinct normal debounce keys, but stop applies to the shared session.
    // Cancel every still-tracked sender lane before core interrupts the active run.
    for (const inboundKey of countsByConversation.get(conversationKey)?.keys() ?? []) {
      cancelKey(inboundKey);
    }
  };

  const completeAfter =
    (flush: (entries: SignalInboundEntry[]) => Promise<void>) =>
    async (entries: SignalInboundEntry[]) => {
      try {
        await flush(entries);
      } finally {
        complete(entries);
      }
    };

  return { track, complete, completeAfter, cancelPendingOnAbort };
}
