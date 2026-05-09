import type { IMessagePayload } from "./types.js";

// Keep the coalescing contract narrow (caps, ID tracking, reply-context
// preference) so a future SDK lift into `openclaw/plugin-sdk/channel-inbound`
// is a mechanical extraction instead of a behavioral redesign. Apple's
// split-send pipeline is the behavior this protects.

/**
 * Bounds on the merged output when multiple inbound iMessage payloads are
 * folded into one agent turn. Caps each merge so a sender who
 * rapid-fires DMs inside the debounce window cannot amplify the downstream
 * prompt past a safe ceiling. Every source GUID still surfaces via
 * `coalescedMessageGuids` so a future replay path can recognize duplicates.
 */
export const MAX_COALESCED_TEXT_CHARS = 4000;
export const MAX_COALESCED_ATTACHMENTS = 20;
export const MAX_COALESCED_ENTRIES = 10;

export type CoalescedIMessagePayload = IMessagePayload & {
  /**
   * Source GUIDs folded into this merged payload, in arrival order. Includes
   * GUIDs from entries that were dropped by the entry cap so downstream
   * dedupe paths can still recognize them.
   */
  coalescedMessageGuids?: string[];
};

/**
 * Combine consecutive same-sender iMessage payloads into a single payload for
 * downstream dispatch. Used when the debouncer flushes a bucket containing
 * more than one event — e.g. Apple's split-send for `Dump https://example.com`
 * arriving as two separate `chat.db` rows ~0.8-2.0 s apart.
 *
 * The first payload anchors the merged shape (preserving its GUID for reply
 * threading). Text is concatenated with deduplication, attachments are merged
 * (capped), and the latest `created_at` wins so downstream sees the most
 * recent activity timestamp.
 */
export function combineIMessagePayloads(payloads: IMessagePayload[]): CoalescedIMessagePayload {
  if (payloads.length === 0) {
    throw new Error("combineIMessagePayloads: cannot combine empty payloads");
  }
  if (payloads.length === 1) {
    return payloads[0];
  }

  const first = payloads[0];
  const last = payloads[payloads.length - 1];

  // Cap entries: keep first (preserves command/context) + most recent
  // (preserves latest payload) when a flood exceeds the cap.
  const boundedPayloads =
    payloads.length > MAX_COALESCED_ENTRIES
      ? [...payloads.slice(0, MAX_COALESCED_ENTRIES - 1), last]
      : payloads;

  // Combine text across bounded entries. Skip duplicates so a URL appearing
  // both as plain text and as a separately-rendered link-preview row does not
  // get repeated in the merged prompt.
  const seenTexts = new Set<string>();
  const textParts: string[] = [];
  for (const payload of boundedPayloads) {
    const text = (payload.text ?? "").trim();
    if (!text) {
      continue;
    }
    const normalized = text.toLowerCase();
    if (seenTexts.has(normalized)) {
      continue;
    }
    seenTexts.add(normalized);
    textParts.push(text);
  }
  let combinedText = textParts.join(" ");
  if (combinedText.length > MAX_COALESCED_TEXT_CHARS) {
    combinedText = `${combinedText.slice(0, MAX_COALESCED_TEXT_CHARS)}…[truncated]`;
  }

  // Merge attachments across bounded entries, capped to keep downstream media
  // fan-out proportional to a single message.
  const allAttachments = boundedPayloads
    .flatMap((p) => p.attachments ?? [])
    .slice(0, MAX_COALESCED_ATTACHMENTS);

  // Latest `created_at` (lexically max ISO-8601 string) so downstream sees
  // the freshest activity timestamp. Falls back to `first.created_at` if no
  // entries carry a usable timestamp.
  const createdAts = payloads
    .map((p) => p.created_at)
    .filter((c): c is string => typeof c === "string" && c.length > 0);
  const latestCreatedAt =
    createdAts.length > 0 ? createdAts.reduce((a, b) => (a > b ? a : b)) : first.created_at;

  // Walk the unbounded `payloads` so even GUIDs whose text/attachments were
  // dropped by the cap are still remembered for downstream dedupe.
  const seenGuids = new Set<string>();
  const coalescedMessageGuids: string[] = [];
  for (const payload of payloads) {
    const guid = payload.guid?.trim();
    if (!guid || seenGuids.has(guid)) {
      continue;
    }
    seenGuids.add(guid);
    coalescedMessageGuids.push(guid);
  }

  // Reply context: prefer any entry that carries one; the last balloon in a
  // split-send rarely does, but a manual quote-reply earlier in the bucket
  // might.
  const entryWithReply = payloads.find((p) => p.reply_to_id != null);

  return {
    ...first,
    text: combinedText,
    attachments: allAttachments.length > 0 ? allAttachments : null,
    created_at: latestCreatedAt,
    reply_to_id: entryWithReply?.reply_to_id ?? first.reply_to_id ?? null,
    reply_to_text: entryWithReply?.reply_to_text ?? first.reply_to_text ?? null,
    reply_to_sender: entryWithReply?.reply_to_sender ?? first.reply_to_sender ?? null,
    coalescedMessageGuids: coalescedMessageGuids.length > 0 ? coalescedMessageGuids : undefined,
  };
}
