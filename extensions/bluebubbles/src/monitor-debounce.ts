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
 * Default debounce window when `coalesceSameSenderDms` is enabled.
 *
 * The legacy 500 ms default is tuned for BlueBubbles's own text+balloon
 * pairing, which is typically linked by `associatedMessageGuid` and arrives
 * within ~100-300 ms. The new split-send case this flag targets has a wider
 * cadence — live traces show Apple delivers `Dump` and its pasted-URL
 * balloon ~0.8-2.0 s apart — so 500 ms would flush the text alone before the
 * balloon webhook ever reaches the debouncer. 2500 ms comfortably covers the
 * observed range while keeping agent-reply latency acceptable for DMs. Users
 * who want tighter turnaround can still set `messages.inbound.byChannel.bluebubbles`
 * explicitly.
 */
const DEFAULT_COALESCE_INBOUND_DEBOUNCE_MS = 2500;

/**
 * Bounds on the combined output when multiple inbound events are merged into
 * one agent turn. Guards against amplification from a sender who rapid-fires
 * many small DMs inside the debounce window (concern raised on #69258): the
 * merged text, attachment list, and source-message count are each capped so
 * a flood cannot balloon a single agent prompt beyond a safe ceiling.
 * Callers still see every messageId via inbound-dedupe.
 */
const MAX_COALESCED_TEXT_CHARS = 4000;
const MAX_COALESCED_ATTACHMENTS = 20;
const MAX_COALESCED_ENTRIES = 10;

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

  // Cap the number of source entries we fold into the merged view so a sender
  // who rapid-fires many small DMs cannot amplify the downstream prompt.
  // Prefer the first and the most recent — the first preserves the original
  // command/context and the last preserves the most recent payload — rather
  // than dropping either tail of the sequence.
  const boundedEntries =
    entries.length > MAX_COALESCED_ENTRIES
      ? [...entries.slice(0, MAX_COALESCED_ENTRIES - 1), entries[entries.length - 1]]
      : entries;

  // Combine text from bounded entries, filtering out duplicates and empty strings
  const seenTexts = new Set<string>();
  const textParts: string[] = [];

  for (const entry of boundedEntries) {
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

  let combinedText = textParts.join(" ");
  if (combinedText.length > MAX_COALESCED_TEXT_CHARS) {
    combinedText = `${combinedText.slice(0, MAX_COALESCED_TEXT_CHARS)}…[truncated]`;
  }

  // Merge attachments from bounded entries, capped to keep downstream media
  // fan-out proportional to what a single message would carry.
  const allAttachments = boundedEntries
    .flatMap((e) => e.message.attachments ?? [])
    .slice(0, MAX_COALESCED_ATTACHMENTS);

  // Use the latest timestamp
  const timestamps = entries
    .map((e) => e.message.timestamp)
    .filter((t): t is number => typeof t === "number");
  const latestTimestamp = timestamps.length > 0 ? Math.max(...timestamps) : first.timestamp;

  // Collect all message IDs for reference
  const messageId = entries.map((e) => e.message.messageId).find((id): id is string => Boolean(id));

  // Every source messageId we're folding into this merged view must reach
  // inbound-dedupe, so a later BlueBubbles MessagePoller replay of any single
  // source event is recognized as a duplicate rather than re-processed as a
  // fresh agent turn. We walk the unbounded `entries` (not `boundedEntries`)
  // so even IDs whose text/attachments were dropped by the cap are still
  // remembered.
  const seenIds = new Set<string>();
  const coalescedMessageIds: string[] = [];
  for (const entry of entries) {
    const id = entry.message.messageId?.trim();
    if (!id || seenIds.has(id)) {
      continue;
    }
    seenIds.add(id);
    coalescedMessageIds.push(id);
  }

  // Prefer reply context from any entry that has it
  const entryWithReply = entries.find((e) => e.message.replyToId);

  return {
    ...first,
    text: combinedText,
    attachments: allAttachments.length > 0 ? allAttachments : first.attachments,
    timestamp: latestTimestamp,
    // Use first message's ID as primary (for reply reference), but we've coalesced others
    messageId: messageId ?? first.messageId,
    coalescedMessageIds: coalescedMessageIds.length > 0 ? coalescedMessageIds : undefined,
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
  accountConfig: { coalesceSameSenderDms?: boolean },
): number {
  const inbound = config.messages?.inbound;
  const hasExplicitDebounce =
    typeof inbound?.debounceMs === "number" || typeof inbound?.byChannel?.bluebubbles === "number";
  if (!hasExplicitDebounce) {
    // When the opt-in coalesce flag is on, the default must cover Apple's
    // split-send cadence (~0.8-2.0 s) or the flag becomes a no-op. Other
    // users keep the legacy tight default tuned for text+balloon pairs
    // linked via `associatedMessageGuid`.
    return accountConfig.coalesceSameSenderDms
      ? DEFAULT_COALESCE_INBOUND_DEBOUNCE_MS
      : DEFAULT_INBOUND_DEBOUNCE_MS;
  }
  // Explicit config path: delegate to the shared runtime helper so per-
  // channel scaling, clamps, or other future logic in
  // `src/auto-reply/inbound-debounce.ts` stay authoritative for every
  // channel uniformly.
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
        debounceMs: resolveBlueBubblesDebounceMs(config, core, account.config),
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

          // Optional: coalesce consecutive DM messages from the same sender
          // within the debounce window. Two distinct user sends (e.g.
          // `Dump` followed by a pasted URL that iMessage renders as a
          // standalone rich-link balloon) have distinct messageIds and no
          // associatedMessageGuid cross-reference, so the default per-message
          // key dispatches them as separate agent turns. Hashing to
          // chat:sender lets the debounce window merge them. DMs only —
          // group chats continue to key per-message to preserve multi-user
          // conversational structure.
          //
          // We intentionally do NOT guard on `!balloonBundleId` here: an
          // orphan URL-balloon (Apple split-send where the balloon event
          // carries `balloonBundleId` but no `associatedMessageGuid` linking
          // it back to the text) is exactly the traffic this feature
          // targets. The legacy text+balloon pairing case is already
          // captured above by the `balloonBundleId && associatedMessageGuid`
          // branch, so skipping balloons here would defeat the opt-in for
          // its primary motivating case.
          const chatKey =
            msg.chatGuid?.trim() ??
            msg.chatIdentifier?.trim() ??
            (msg.chatId ? String(msg.chatId) : "dm");
          if (account.config.coalesceSameSenderDms && !msg.isGroup && !associatedMessageGuid) {
            return `bluebubbles:${account.accountId}:dm:${chatKey}:${msg.senderId}`;
          }

          const messageId = msg.messageId?.trim();
          if (messageId) {
            return `bluebubbles:${account.accountId}:msg:${messageId}`;
          }

          return `bluebubbles:${account.accountId}:${chatKey}:${msg.senderId}`;
        },
        shouldDebounce: (entry) => {
          const msg = entry.message;
          // Skip debouncing for from-me messages (they're just cached, not processed)
          if (msg.fromMe) {
            return false;
          }
          // Control commands normally flush immediately so the command feels
          // instant. Exception: when `coalesceSameSenderDms` is enabled, a DM
          // control command is frequently the first half of a split-send
          // (e.g. `Dump` followed by a pasted URL that Apple delivers as a
          // separate webhook ~700-2000 ms later). Skipping debounce here
          // would flush the command alone before the URL bucket-mate arrives
          // — defeating the opt-in feature on exactly its target traffic.
          // Gate the delay on the same conditions as the buildKey coalesce
          // branch so group chats, balloon follow-ups, and disabled accounts
          // keep the instant-flush path.
          if (core.channel.text.hasControlCommand(msg.text, config)) {
            const associatedMessageGuid = msg.associatedMessageGuid?.trim();
            if (account.config.coalesceSameSenderDms && !msg.isGroup && !associatedMessageGuid) {
              return true;
            }
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
