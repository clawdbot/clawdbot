// Imessage plugin module implements the same-sender inbound debounce merge.
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { sliceUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import type { IMessagePayload } from "./types.js";

// Keep the merge contract narrow (caps, ID tracking, reply-context preference)
// so a future SDK lift into `openclaw/plugin-sdk/channel-inbound` is a
// mechanical extraction instead of a behavioral redesign.

/**
 * Bounds on the merged output when multiple inbound iMessage payloads are
 * folded into one agent turn. Caps each merge so a sender who
 * rapid-fires DMs inside the debounce window cannot amplify the downstream
 * prompt past a safe ceiling. Every source GUID still surfaces via
 * `coalescedMessageGuids` so a future replay path can recognize duplicates.
 */
const MAX_COALESCED_TEXT_CHARS = 4000;
const MAX_COALESCED_ATTACHMENTS = 20;
const MAX_COALESCED_ENTRIES = 10;

type CoalescedIMessagePayload = IMessagePayload & {
  /**
   * Source GUIDs folded into this merged payload, in arrival order. Includes
   * GUIDs from entries that were dropped by the entry cap so downstream
   * dedupe paths can still recognize them.
   */
  coalescedMessageGuids?: string[];
  coalescedCatchupCursor?: {
    lastSeenMs: number;
    lastSeenRowid: number;
  };
};

/**
 * Combine consecutive same-sender iMessage payloads into a single payload for
 * downstream dispatch. Used for the general inbound debounce
 * (`messages.inbound`, off by default) when configured.
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
  const first = expectDefined(payloads[0], "first iMessage payload to coalesce");
  if (payloads.length === 1) {
    return first;
  }

  const last = expectDefined(payloads.at(-1), "last iMessage payload to coalesce");

  // Cap entries: keep first (preserves command/context) + most recent
  // (preserves latest payload) when a flood exceeds the cap.
  const boundedPayloads =
    payloads.length > MAX_COALESCED_ENTRIES
      ? [...payloads.slice(0, MAX_COALESCED_ENTRIES - 1), last]
      : payloads;

  // Combine text across bounded entries, skipping duplicate message text.
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
    combinedText = `${sliceUtf16Safe(combinedText, 0, MAX_COALESCED_TEXT_CHARS)}…[truncated]`;
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

  let maxRowid = -Infinity;
  let maxDateMs = -Infinity;
  for (const payload of payloads) {
    if (typeof payload.id === "number" && Number.isFinite(payload.id)) {
      maxRowid = Math.max(maxRowid, payload.id);
    }
    const dateMs =
      typeof payload.created_at === "string" ? Date.parse(payload.created_at) : Number.NaN;
    if (Number.isFinite(dateMs)) {
      maxDateMs = Math.max(maxDateMs, dateMs);
    }
  }

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

  // Reply context: prefer any entry that carries one.
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
    coalescedCatchupCursor:
      Number.isFinite(maxRowid) && Number.isFinite(maxDateMs)
        ? { lastSeenMs: maxDateMs, lastSeenRowid: maxRowid }
        : undefined,
  };
}
