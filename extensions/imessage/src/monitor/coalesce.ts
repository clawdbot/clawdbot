// Imessage plugin module implements the same-sender inbound debounce merge.
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { sliceUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import type { IMessagePayload } from "./types.js";

// Keep the merge contract narrow (caps, ID tracking, reply-context preference)
// so a future SDK lift into `openclaw/plugin-sdk/channel-inbound` is a
// mechanical extraction instead of a behavioral redesign. Apple's URL-preview
// split-send pipeline is the iMessage-only behavior this still protects.

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
const IMESSAGE_URL_BALLOON_BUNDLE_ID = "com.apple.messages.URLBalloonProvider";

export function hasIMessageUrlBalloonBundleID(payload: IMessagePayload): boolean {
  return payload.balloon_bundle_id === IMESSAGE_URL_BALLOON_BUNDLE_ID;
}

function isSingleUrlToken(text: string): boolean {
  if (/\s/.test(text)) {
    return false;
  }
  if (/^www\.[^\s.]+\.[^\s]+$/i.test(text)) {
    return true;
  }
  try {
    const url = new URL(text);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function isStandaloneIMessageUrlPreviewPayload(payload: IMessagePayload): boolean {
  if (!hasIMessageUrlBalloonBundleID(payload)) {
    return false;
  }
  const text = (payload.text ?? "").trim();
  return text.length === 0 || isSingleUrlToken(text);
}

// imsg omits `balloon_bundle_id` for non-balloon rows, so a present value is
// the session signal that this bridge build exposes structural balloon
// metadata. Once latched, missing URL metadata is meaningful.
export function hasIMessageBalloonMetadata(payload: IMessagePayload): boolean {
  return typeof payload.balloon_bundle_id === "string" && payload.balloon_bundle_id.length > 0;
}

/**
 * Decide whether a debounced same-sender iMessage bucket should merge.
 *
 * URL-preview rows are merged with their preceding command row so Apple's
 * command+URL split-send still reaches the agent as one turn. Once a bridge
 * session has emitted balloon metadata, ordinary same-sender DMs without the
 * URL marker flush separately instead of being collapsed.
 */
export function shouldCombineIMessagePayloadBucket(
  payloads: readonly IMessagePayload[],
  buildEmitsBalloonMetadata: boolean,
): boolean {
  if (payloads.some(hasIMessageUrlBalloonBundleID)) {
    return true;
  }
  if (buildEmitsBalloonMetadata || payloads.some(hasIMessageBalloonMetadata)) {
    return false;
  }
  // Older imsg builds expose no balloon metadata, so a command+URL split-send
  // is indistinguishable from two ordinary text rows. Keep the internal fallback
  // until imsg advertises upstream coalescing for that exact shape.
  return true;
}

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
 * downstream dispatch. Used for Apple's URL-preview split-send, and for the
 * general inbound debounce (`messages.inbound`, off by default) when configured.
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
    coalescedCatchupCursor:
      Number.isFinite(maxRowid) && Number.isFinite(maxDateMs)
        ? { lastSeenMs: maxDateMs, lastSeenRowid: maxRowid }
        : undefined,
  };
}
