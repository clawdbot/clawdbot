import { buildAssistantAttachmentUrl } from "./chat-message-local-media.ts";
import {
  isChatMediaResourceCurrent,
  notifyChatMediaResourceSubscribers,
  scheduleChatMediaResourceRefresh,
  type ChatMediaResource,
} from "./chat-message-media.ts";

export type AssistantAttachmentAvailability =
  | { status: "checking" }
  | {
      status: "available";
      mediaTicket?: string;
      mediaTicketExpiresAt?: number;
      refreshAfter?: number;
      refreshAttempts?: number;
      playback?: "native" | "transcode";
      sizeBytes?: number;
      durationMs?: number;
      width?: number;
      height?: number;
    }
  | { status: "unavailable"; reason: string; checkedAt: number; retryAttempted?: true };

export type ManagedAttachmentAvailability =
  | { status: "checking"; refreshAfter?: number; refreshAttempts?: number }
  | {
      status: "available";
      url: string;
      expiresAt?: number;
      refreshAfter?: number;
      refreshAttempts?: number;
    }
  | { status: "unavailable"; reason: string; checkedAt: number };

export const ASSISTANT_ATTACHMENT_UNAVAILABLE_RETRY_MS = 5_000;
export const ASSISTANT_ATTACHMENT_METADATA_FETCH_TIMEOUT_MS = 30_000;
export const ASSISTANT_ATTACHMENT_MEDIA_TICKET_REFRESH_SKEW_MS = 30_000;
export const ASSISTANT_ATTACHMENT_MEDIA_TICKET_MAX_REFRESH_RETRIES = 2;

let assistantAttachmentAvailabilityRenderVersion = 0;

export function createUnavailableAssistantAttachment(
  reason: string,
  retryAttempted: boolean,
): Extract<AssistantAttachmentAvailability, { status: "unavailable" }> {
  return {
    status: "unavailable",
    reason,
    checkedAt: Date.now(),
    ...(retryAttempted ? { retryAttempted: true } : {}),
  };
}

export function getAssistantAttachmentAvailabilityRenderVersion(): number {
  return assistantAttachmentAvailabilityRenderVersion;
}

export function bumpAssistantAttachmentAvailabilityRenderVersion(): void {
  assistantAttachmentAvailabilityRenderVersion =
    (assistantAttachmentAvailabilityRenderVersion + 1) % Number.MAX_SAFE_INTEGER;
}

export function buildAssistantAttachmentMetaUrl(source: string, basePath?: string): string {
  const attachmentUrl = buildAssistantAttachmentUrl(source, basePath);
  return `${attachmentUrl}${attachmentUrl.includes("?") ? "&" : "?"}meta=1`;
}

export function setAssistantAttachmentAvailability(
  resource: ChatMediaResource<AssistantAttachmentAvailability>,
  availability: AssistantAttachmentAvailability,
): void {
  if (!isChatMediaResourceCurrent(resource)) {
    return;
  }
  resource.value = availability;
  bumpAssistantAttachmentAvailabilityRenderVersion();
  scheduleAssistantAttachmentRefresh(resource, availability);
}

export function scheduleAssistantAttachmentRefresh(
  resource: ChatMediaResource<AssistantAttachmentAvailability>,
  availability: AssistantAttachmentAvailability,
): void {
  const refreshAt =
    availability.status === "unavailable" && !availability.retryAttempted
      ? availability.checkedAt + ASSISTANT_ATTACHMENT_UNAVAILABLE_RETRY_MS
      : availability.status === "available" &&
          availability.mediaTicket &&
          availability.mediaTicketExpiresAt
        ? (availability.refreshAfter ??
          availability.mediaTicketExpiresAt - ASSISTANT_ATTACHMENT_MEDIA_TICKET_REFRESH_SKEW_MS)
        : undefined;
  scheduleChatMediaResourceRefresh(resource, refreshAt, () => {
    if (resource.value !== availability) {
      return;
    }
    // Keep the failed generation until its retry can inherit the one-attempt
    // budget. A ticket refresh keeps the playable generation mounted while
    // its replacement is minted, otherwise the checking card resets playback.
    if (availability.status === "available") {
      // Virtual rows use this version as their media invalidation key. Notify
      // alone updates the host but can leave the attachment row memoized.
      bumpAssistantAttachmentAvailabilityRenderVersion();
    } else if (availability.status !== "unavailable") {
      resource.value = undefined;
      bumpAssistantAttachmentAvailabilityRenderVersion();
    }
    notifyChatMediaResourceSubscribers(resource);
  });
}

export function managedAttachmentRefreshDelayMs(refreshAttempts: number): number {
  return ASSISTANT_ATTACHMENT_UNAVAILABLE_RETRY_MS * 2 ** Math.max(0, refreshAttempts - 1);
}

export function selectLaterExpiringManagedAttachment(
  current: Extract<ManagedAttachmentAvailability, { status: "available" }> | null,
  incoming: Extract<ManagedAttachmentAvailability, { status: "available" }>,
): Extract<ManagedAttachmentAvailability, { status: "available" }> {
  return current?.expiresAt !== undefined && current.expiresAt >= (incoming.expiresAt ?? 0)
    ? current
    : incoming;
}

export function isManagedOutgoingMediaSource(source: string): boolean {
  try {
    const parsed = new URL(source, window.location.origin);
    return (
      parsed.origin === window.location.origin &&
      parsed.pathname.startsWith("/api/chat/media/outgoing/")
    );
  } catch {
    return false;
  }
}

export function resolveManagedOutgoingMediaSessionKey(source: string): string | null {
  try {
    const encodedSessionKey = new URL(source, window.location.origin).pathname.split("/")[5];
    return encodedSessionKey ? decodeURIComponent(encodedSessionKey) : null;
  } catch {
    return null;
  }
}
