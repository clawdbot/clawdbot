/**
 * Single-ownership enforcement for durable generated-media completion handoffs.
 *
 * A completion handoff resumes the requester session with an internal event that
 * names the generated media. Prompt text can only ask the model not to re-attach
 * that media, so the outbound batch owns the invariant instead: one delivery of a
 * handoff artifact per batch, whatever the model emits.
 */
import { copyReplyPayloadMetadata, type ReplyPayload } from "../auto-reply/reply-payload.js";
import { hasEnabledDeliveryOperation } from "../auto-reply/reply/reply-payloads-dedupe.runtime.js";
import { normalizeMediaReferenceForComparison } from "../media/media-reference-comparison.js";
import {
  type AgentGeneratedAttachment,
  mediaUrlsFromGeneratedAttachments,
} from "./generated-attachments.js";
import {
  type AgentInternalEventSource,
  hasGeneratedMediaCompletionEvent,
} from "./internal-event-contract.js";

type HandoffMediaCompletionEvent = {
  type: string;
  source: AgentInternalEventSource;
  mediaUrls?: string[];
  attachments?: AgentGeneratedAttachment[];
};

/** Media references a generated-media completion handoff already owns. */
export function collectHandoffOwnedMediaUrls(
  events: readonly HandoffMediaCompletionEvent[] | undefined,
): string[] {
  const owned = new Set<string>();
  for (const event of events ?? []) {
    if (!hasGeneratedMediaCompletionEvent([event])) {
      continue;
    }
    for (const url of [
      ...(event.mediaUrls ?? []),
      ...mediaUrlsFromGeneratedAttachments(event.attachments),
    ]) {
      const trimmed = url.trim();
      if (trimmed) {
        owned.add(trimmed);
      }
    }
  }
  return Array.from(owned);
}

function hasNonMediaDeliverableContent(payload: ReplyPayload): boolean {
  return Boolean(
    payload.text?.trim() ||
    payload.fallbackText ||
    payload.presentation ||
    payload.interactive ||
    payload.location ||
    payload.spokenText?.trim() ||
    payload.btw ||
    payload.channelData,
  );
}

/**
 * Keeps the first delivery of each handoff-owned media reference in an outbound
 * batch and strips the repeats. Media the handoff does not own is untouched, so
 * ordinary attachments and deliberate resends on other routes still flow.
 */
export function enforceHandoffMediaDeliveryOwnership(params: {
  payloads: ReplyPayload[];
  handoffMediaUrls: readonly string[];
}): ReplyPayload[] {
  const owned = new Set(
    params.handoffMediaUrls
      .map((url) => normalizeMediaReferenceForComparison(url))
      .filter((url) => url.length > 0),
  );
  if (owned.size === 0) {
    return params.payloads;
  }
  const claimed = new Set<string>();
  const constrained: ReplyPayload[] = [];
  let changed = false;
  for (const payload of params.payloads) {
    // Delivery operations act on the message this payload creates, so leave its
    // content alone rather than silently skipping the operation.
    if (hasEnabledDeliveryOperation(payload)) {
      constrained.push(payload);
      continue;
    }
    const decisions = new Map<string, boolean>();
    const keepMedia = (url: string): boolean => {
      const key = normalizeMediaReferenceForComparison(url);
      if (!owned.has(key)) {
        return true;
      }
      const decided = decisions.get(key);
      if (decided !== undefined) {
        return decided;
      }
      const keep = !claimed.has(key);
      claimed.add(key);
      decisions.set(key, keep);
      return keep;
    };
    // `decisions` keeps mediaUrl and mediaUrls consistent for the same key, which
    // also means every equivalent spelling inside one payload would be kept. Merging
    // upstream only dedupes byte-identical strings, so `/tmp/x.png` alongside
    // `/tmp/./x.png` would attach the same artifact twice to one message. Claim each
    // owned artifact once per payload as well as once per batch.
    const seenInPayload = new Set<string>();
    const takeOnce = (url: string): boolean => {
      const key = normalizeMediaReferenceForComparison(url);
      if (owned.has(key)) {
        if (seenInPayload.has(key)) {
          return false;
        }
        seenInPayload.add(key);
      }
      return keepMedia(url);
    };
    const mediaUrl = payload.mediaUrl && takeOnce(payload.mediaUrl) ? payload.mediaUrl : undefined;
    const mediaUrls = payload.mediaUrls?.filter((url) => takeOnce(url));
    if (mediaUrl === payload.mediaUrl && mediaUrls?.length === payload.mediaUrls?.length) {
      constrained.push(payload);
      continue;
    }
    changed = true;
    if (!mediaUrl && !mediaUrls?.length && !hasNonMediaDeliverableContent(payload)) {
      continue;
    }
    constrained.push(
      copyReplyPayloadMetadata(payload, {
        ...payload,
        mediaUrl,
        mediaUrls: mediaUrls?.length ? mediaUrls : undefined,
        ...(payload.audioAsVoice === true && !mediaUrl && !mediaUrls?.length
          ? { audioAsVoice: undefined }
          : {}),
      }),
    );
  }
  return changed ? constrained : params.payloads;
}
