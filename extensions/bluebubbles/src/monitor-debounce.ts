import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import type { NormalizedWebhookMessage } from "./monitor-normalize.js";
import type { BlueBubblesCoreRuntime, WebhookTarget } from "./monitor-shared.js";
import type { OpenClawConfig } from "./runtime-api.js";

/**
 * Entry type for debouncing inbound messages.
 * Captures the normalized message and its target for later combined processing.
 */
type BlueBubblesDebounceEntry = {
  message: NormalizedWebhookMessage;
  target: WebhookTarget;
};

function normalizeDebounceMessageText(text: unknown): string {
  return typeof text === "string" ? text : "";
}

function sanitizeDebounceEntry(entry: BlueBubblesDebounceEntry): BlueBubblesDebounceEntry {
  if (typeof entry.message.text === "string") {
    return entry;
  }
  return {
    ...entry,
    message: {
      ...entry.message,
      text: "",
    },
  };
}

export type BlueBubblesDebouncer = {
  enqueue: (item: BlueBubblesDebounceEntry) => Promise<void>;
  flushKey: (key: string) => Promise<void>;
};

export type BlueBubblesDebounceRegistry = {
  getOrCreateDebouncer: (target: WebhookTarget) => BlueBubblesDebouncer;
  removeDebouncer: (target: WebhookTarget) => void;
};

/**
 * Default debounce window for inbound message coalescing (ms).
 * This helps combine URL text + link preview balloon messages that BlueBubbles
 * sends as separate webhook events when no explicit inbound debounce config exists.
 */
const DEFAULT_INBOUND_DEBOUNCE_MS = 500;

/**
 * Combines multiple debounced messages into a single message for processing.
 * Used when multiple webhook events arrive within the debounce window.
 */
function combineDebounceEntries(entries: BlueBubblesDebounceEntry[]): NormalizedWebhookMessage {
  if (entries.length === 0) {
    throw new Error("Cannot combine empty entries");
  }
  if (entries.length === 1) {
    return entries[0].message;
  }

  // Use the first message as the base (typically the text message)
  const first = entries[0].message;

  // Combine text from all entries, filtering out duplicates and empty strings
  const seenTexts = new Set<string>();
  const textParts: string[] = [];

  for (const entry of entries) {
    const text = normalizeDebounceMessageText(entry.message.text).trim();
    if (!text) {
      continue;
    }
    // Skip duplicate text (URL might be in both text message and balloon)
    const normalizedText = normalizeLowercaseStringOrEmpty(text);
    if (seenTexts.has(normalizedText)) {
      continue;
    }
    seenTexts.add(normalizedText);
    textParts.push(text);
  }

  // Merge attachments from all entries
  const allAttachments = entries.flatMap((e) => e.message.attachments ?? []);

  // Use the latest timestamp
  const timestamps = entries
    .map((e) => e.message.timestamp)
    .filter((t): t is number => typeof t === "number");
  const latestTimestamp = timestamps.length > 0 ? Math.max(...timestamps) : first.timestamp;

  // Collect all message IDs for reference
  const messageId = entries.map((e) => e.message.messageId).find((id): id is string => Boolean(id));

  // Prefer reply context from any entry that has it
  const entryWithReply = entries.find((e) => e.message.replyToId);

  return {
    ...first,
    text: textParts.join(" "),
    attachments: allAttachments.length > 0 ? allAttachments : first.attachments,
    timestamp: latestTimestamp,
    // Use first message's ID as primary (for reply reference), but we've coalesced others
    messageId: messageId ?? first.messageId,
    // Preserve reply context if present
    replyToId: entryWithReply?.message.replyToId ?? first.replyToId,
    replyToBody: entryWithReply?.message.replyToBody ?? first.replyToBody,
    replyToSender: entryWithReply?.message.replyToSender ?? first.replyToSender,
    // Clear balloonBundleId since we've combined (the combined message is no longer just a balloon)
    balloonBundleId: undefined,
  };
}

function resolveBlueBubblesDebounceMs(
  config: OpenClawConfig,
  core: BlueBubblesCoreRuntime,
): number {
  const inbound = config.messages?.inbound;
  const hasExplicitDebounce =
    typeof inbound?.debounceMs === "number" || typeof inbound?.byChannel?.bluebubbles === "number";
  if (!hasExplicitDebounce) {
    return DEFAULT_INBOUND_DEBOUNCE_MS;
  }
  return core.channel.debounce.resolveInboundDebounceMs({ cfg: config, channel: "bluebubbles" });
}

export function createBlueBubblesDebounceRegistry(params: {
  processMessage: (message: NormalizedWebhookMessage, target: WebhookTarget) => Promise<void>;
}): BlueBubblesDebounceRegistry {
  const targetDebouncers = new Map<WebhookTarget, BlueBubblesDebouncer>();

  return {
    getOrCreateDebouncer: (target) => {
      const existing = targetDebouncers.get(target);
      if (existing) {
        return existing;
      }

      const { account, config, runtime, core } = target;
      const baseDebouncer = core.channel.debounce.createInboundDebouncer<BlueBubblesDebounceEntry>({
        debounceMs: resolveBlueBubblesDebounceMs(config, core),
        buildKey: (entry) => {
          const msg = entry.message;
          // Prefer stable, shared identifiers to coalesce rapid-fire webhook events for the
          // same message (e.g., text-only then text+attachment).
          //
          // For balloons (URL previews, stickers, etc), BlueBubbles often uses a different
          // messageId than the originating text. When present, key by associatedMessageGuid
          // to keep text + balloon coalescing working.
          const balloonBundleId = msg.balloonBundleId?.trim();
          const associatedMessageGuid = msg.associatedMessageGuid?.trim();
          if (balloonBundleId && associatedMessageGuid) {
            return `bluebubbles:${account.accountId}:msg:${associatedMessageGuid}`;
          }

          const messageId = msg.messageId?.trim();
          if (messageId) {
            return `bluebubbles:${account.accountId}:msg:${messageId}`;
          }

          const chatKey =
            msg.chatGuid?.trim() ??
            msg.chatIdentifier?.trim() ??
            (msg.chatId ? String(msg.chatId) : "dm");
          return `bluebubbles:${account.accountId}:${chatKey}:${msg.senderId}`;
        },
        shouldDebounce: (entry) => {
          const msg = entry.message;
          // Skip debouncing for from-me messages (they're just cached, not processed)
          if (msg.fromMe) {
            return false;
          }
          // Skip debouncing for control commands - process immediately
          if (core.channel.text.hasControlCommand(msg.text, config)) {
            return false;
          }
          // Debounce all other messages to coalesce rapid-fire webhook events
          // (e.g., text+image arriving as separate webhooks for the same messageId)
          return true;
        },
        onFlush: async (entries) => {
          if (entries.length === 0) {
            return;
          }

          // Use target from first entry (all entries have same target due to key structure)
          const flushTarget = entries[0].target;

          if (entries.length === 1) {
            // Single message - process normally
            await params.processMessage(entries[0].message, flushTarget);
            return;
          }

          // Multiple messages - combine and process
          const combined = combineDebounceEntries(entries);

          if (core.logging.shouldLogVerbose()) {
            const count = entries.length;
            const preview = combined.text.slice(0, 50);
            runtime.log?.(
              `[bluebubbles] coalesced ${count} messages: "${preview}${combined.text.length > 50 ? "..." : ""}"`,
            );
          }

          await params.processMessage(combined, flushTarget);
        },
        onError: (err) => {
          runtime.error?.(
            `[${account.accountId}] [bluebubbles] debounce flush failed: ${String(err)}`,
          );
        },
      });

      const debouncer: BlueBubblesDebouncer = {
        enqueue: async (item) => {
          await baseDebouncer.enqueue(sanitizeDebounceEntry(item));
        },
        flushKey: (key) => baseDebouncer.flushKey(key),
      };

      targetDebouncers.set(target, debouncer);
      return debouncer;
    },
    removeDebouncer: (target) => {
      targetDebouncers.delete(target);
    },
  };
}
