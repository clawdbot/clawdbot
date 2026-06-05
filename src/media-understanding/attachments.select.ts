// Attachment selection applies per-capability filters, ordering preferences,
// and max-count policy before provider execution.
import type { MediaUnderstandingAttachmentsConfig } from "../config/types.tools.js";
import {
  isAudioAttachment,
  isImageAttachment,
  isVideoAttachment,
} from "./attachments.normalize.js";
import type { MediaAttachment, MediaUnderstandingCapability } from "./types.js";

const DEFAULT_MAX_ATTACHMENTS = 1;

function orderAttachments(
  attachments: MediaAttachment[],
  prefer?: MediaUnderstandingAttachmentsConfig["prefer"],
): MediaAttachment[] {
  // Ordering is stable and non-mutating so downstream decisions can still cite
  // original attachment indexes.
  const list = Array.isArray(attachments) ? attachments.filter(isAttachmentRecord) : [];
  if (!prefer || prefer === "first") {
    return list;
  }
  if (prefer === "last") {
    return [...list].toReversed();
  }
  if (prefer === "path") {
    const withPath = list.filter((item) => item.path);
    const withoutPath = list.filter((item) => !item.path);
    return [...withPath, ...withoutPath];
  }
  if (prefer === "url") {
    const withUrl = list.filter((item) => item.url);
    const withoutUrl = list.filter((item) => !item.url);
    return [...withUrl, ...withoutUrl];
  }
  return list;
}

function isAttachmentRecord(value: unknown): value is MediaAttachment {
  if (!value || typeof value !== "object") {
    return false;
  }
  const entry = value as Record<string, unknown>;
  if (typeof entry.index !== "number") {
    return false;
  }
  if (entry.path !== undefined && typeof entry.path !== "string") {
    return false;
  }
  if (entry.url !== undefined && typeof entry.url !== "string") {
    return false;
  }
  if (entry.mime !== undefined && typeof entry.mime !== "string") {
    return false;
  }
  if (entry.alreadyTranscribed !== undefined && typeof entry.alreadyTranscribed !== "boolean") {
    return false;
  }
  return true;
}

/** Selects attachments for a media-understanding capability under configured ordering limits. */
export function selectAttachments(params: {
  capability: MediaUnderstandingCapability;
  attachments: MediaAttachment[];
  policy?: MediaUnderstandingAttachmentsConfig;
}): MediaAttachment[] {
  const { capability, attachments, policy } = params;
  const input = Array.isArray(attachments) ? attachments.filter(isAttachmentRecord) : [];
  const matches = input.filter((item) => {
    // Preflight audio has already been consumed; rerunning STT would duplicate transcript output.
    if (capability === "audio" && item.alreadyTranscribed) {
      return false;
    }
    if (capability === "image") {
      return isImageAttachment(item);
    }
    if (capability === "audio") {
      return isAudioAttachment(item);
    }
    return isVideoAttachment(item);
  });
  if (matches.length === 0) {
    return [];
  }

  const ordered = orderAttachments(matches, policy?.prefer);
  const mode = policy?.mode ?? "first";
  const maxAttachments = policy?.maxAttachments ?? DEFAULT_MAX_ATTACHMENTS;
  if (mode === "all") {
    return ordered.slice(0, Math.max(1, maxAttachments));
  }
  return ordered.slice(0, 1);
}
