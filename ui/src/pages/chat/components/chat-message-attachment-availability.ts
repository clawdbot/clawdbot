import { t } from "../../../i18n/index.ts";
import { formatUiExternalText } from "../../../lib/format-error.ts";
import {
  isLocalAssistantAttachmentSource,
  isLocalAttachmentPreviewAllowed,
} from "./chat-message-local-media.ts";
import {
  isChatMediaResourceCurrent,
  notifyChatMediaResourceSubscribers,
  observeChatMediaResource,
  scheduleChatMediaResourceRefresh,
  type AssistantMediaResolver,
  type ChatMediaResource,
} from "./chat-message-media.ts";

type AssistantAttachmentAvailability =
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
  | {
      status: "unavailable";
      reason: string;
      checkedAt: number;
      recoverable: boolean;
      retryAttempted?: true;
      unconfirmed?: true;
    };

export const ASSISTANT_ATTACHMENT_UNAVAILABLE_RETRY_MS = 5_000;
export const ASSISTANT_ATTACHMENT_MEDIA_TICKET_REFRESH_SKEW_MS = 30_000;
export const ASSISTANT_ATTACHMENT_MEDIA_TICKET_MAX_REFRESH_RETRIES = 2;

// A re-render of one attachment under a new base path or connection epoch
// replaces its subscription, but the main transcript and a task transcript
// rendering the same source through one update callback are distinct
// subscribers, so the subscription scope includes the selected session.
function assistantAttachmentSubscriberScope(
  assistantMediaScope: string | undefined,
  source: string,
): string {
  return `${assistantMediaScope ?? ""}::${source}`;
}

export function resolveAssistantAttachmentAvailability(
  source: string,
  resourceBasePath: string | undefined,
  onRequestUpdate: (() => void) | undefined,
  resolveMedia: AssistantMediaResolver | undefined,
  connectionEpoch: number | undefined,
  assistantMediaScope?: string,
  localMediaPreviewRoots: readonly string[] = [],
): AssistantAttachmentAvailability {
  if (!isLocalAssistantAttachmentSource(source)) {
    return { status: "available" };
  }
  // Session-scoped Gateway resolution is authoritative because bootstrap roots
  // only describe the default agent. Preserve the legacy guard for renderers
  // that do not have a selected session identity.
  if (
    !assistantMediaScope &&
    localMediaPreviewRoots.length > 0 &&
    !isLocalAttachmentPreviewAllowed(source, localMediaPreviewRoots)
  ) {
    return createUnavailableAssistantAttachment(
      t("chat.attachments.outsideAllowedFolders"),
      false,
      { recoverable: false },
    );
  }
  if (!resolveMedia) {
    return createUnavailableAssistantAttachment(t("chat.attachments.unavailable"), false, {
      recoverable: false,
    });
  }
  const cacheKey = `${resourceBasePath ?? ""}::gateway:${connectionEpoch ?? 0}::${assistantMediaScope ?? ""}::${source}`;
  const resource = observeChatMediaResource<AssistantAttachmentAvailability>(
    "assistant-attachment",
    cacheKey,
    onRequestUpdate,
    assistantAttachmentSubscriberScope(assistantMediaScope, source),
  );
  const cached = resource.value;
  let refreshingAvailability: Extract<
    AssistantAttachmentAvailability,
    { status: "available" }
  > | null = null;
  if (cached) {
    const now = Date.now();
    if (
      cached.status === "unavailable" &&
      cached.recoverable &&
      !cached.retryAttempted &&
      now - cached.checkedAt >= ASSISTANT_ATTACHMENT_UNAVAILABLE_RETRY_MS
    ) {
      resource.retryAttempted = true;
      resource.value = undefined;
    } else if (
      cached.status === "available" &&
      cached.mediaTicket &&
      cached.mediaTicketExpiresAt !== undefined &&
      cached.mediaTicketExpiresAt <= now
    ) {
      const unavailable = createUnavailableAssistantAttachment(
        "Attachment unavailable",
        resource.retryAttempted,
        { unconfirmed: true },
      );
      setAssistantAttachmentAvailability(resource, unavailable);
      return unavailable;
    } else if (
      cached.status === "available" &&
      cached.mediaTicket &&
      (cached.refreshAfter !== undefined
        ? cached.refreshAfter <= now
        : !cached.mediaTicketExpiresAt ||
          cached.mediaTicketExpiresAt - now <= ASSISTANT_ATTACHMENT_MEDIA_TICKET_REFRESH_SKEW_MS)
    ) {
      if (resource.pending) {
        return cached;
      }
      refreshingAvailability = cached;
    } else {
      scheduleAssistantAttachmentRefresh(resource, cached);
      return cached;
    }
  }
  if (!refreshingAvailability) {
    setAssistantAttachmentAvailability(resource, { status: "checking" });
  }
  const keepPlayableTicketForRetry = () => {
    if (!refreshingAvailability) {
      return null;
    }
    const now = Date.now();
    const expiresAt = refreshingAvailability.mediaTicketExpiresAt;
    const refreshAttempts = refreshingAvailability.refreshAttempts ?? 0;
    if (
      expiresAt === undefined ||
      expiresAt <= now ||
      refreshAttempts >= ASSISTANT_ATTACHMENT_MEDIA_TICKET_MAX_REFRESH_RETRIES
    ) {
      return null;
    }
    return {
      ...refreshingAvailability,
      refreshAfter: Math.min(now + ASSISTANT_ATTACHMENT_UNAVAILABLE_RETRY_MS, expiresAt),
      refreshAttempts: refreshAttempts + 1,
    };
  };
  const pending = Promise.resolve()
    .then(() => resolveMedia(source, assistantMediaScope))
    .then((payload): AssistantAttachmentAvailability => {
      if (!payload) {
        throw new Error("Attachment metadata unavailable");
      }
      if (!payload.available) {
        return createUnavailableAssistantAttachment(
          formatUiExternalText(payload.reason, t("chat.attachments.unavailable")),
          resource.retryAttempted,
        );
      }
      const mediaTicket = payload.mediaTicket.trim();
      const mediaTicketExpiresAt = Date.parse(payload.mediaTicketExpiresAt);
      if (!mediaTicket || !Number.isFinite(mediaTicketExpiresAt)) {
        throw new Error("Attachment metadata has an invalid ticket");
      }
      resource.retryAttempted = false;
      return {
        status: "available",
        mediaTicket,
        mediaTicketExpiresAt,
        ...(payload.playback === "native" || payload.playback === "transcode"
          ? { playback: payload.playback }
          : {}),
        ...(typeof payload.sizeBytes === "number" ? { sizeBytes: payload.sizeBytes } : {}),
        ...(typeof payload.durationMs === "number" ? { durationMs: payload.durationMs } : {}),
        ...(typeof payload.width === "number" ? { width: payload.width } : {}),
        ...(typeof payload.height === "number" ? { height: payload.height } : {}),
      };
    })
    .catch(
      () =>
        keepPlayableTicketForRetry() ??
        createUnavailableAssistantAttachment(
          t("chat.attachments.unavailable"),
          resource.retryAttempted,
          { unconfirmed: true },
        ),
    )
    .then((availability) => {
      setAssistantAttachmentAvailability(resource, availability);
      return availability;
    })
    .finally(() => {
      if (resource.pending === pending) {
        resource.pending = undefined;
      }
      notifyChatMediaResourceSubscribers(resource);
    });
  resource.pending = pending;
  return refreshingAvailability ?? { status: "checking" };
}

export function retryAssistantAttachmentAvailability(
  source: string,
  resourceBasePath: string | undefined,
  onRequestUpdate: (() => void) | undefined,
  connectionEpoch: number | undefined,
  assistantMediaScope?: string,
): void {
  if (!isLocalAssistantAttachmentSource(source)) {
    onRequestUpdate?.();
    return;
  }
  const cacheKey = `${resourceBasePath ?? ""}::gateway:${connectionEpoch ?? 0}::${assistantMediaScope ?? ""}::${source}`;
  const resource = observeChatMediaResource<AssistantAttachmentAvailability>(
    "assistant-attachment",
    cacheKey,
    onRequestUpdate,
    assistantAttachmentSubscriberScope(assistantMediaScope, source),
  );
  resource.abortController?.abort();
  resource.abortController = undefined;
  resource.pending = undefined;
  resource.value = undefined;
  resource.retryAttempted = false;
  scheduleAssistantAttachmentRefresh(resource, { status: "checking" });
  notifyChatMediaResourceSubscribers(resource);
  onRequestUpdate?.();
}

function createUnavailableAssistantAttachment(
  reason: string,
  retryAttempted: boolean,
  options: { recoverable?: boolean; unconfirmed?: true } = {},
): Extract<AssistantAttachmentAvailability, { status: "unavailable" }> {
  return {
    status: "unavailable",
    reason,
    checkedAt: Date.now(),
    recoverable: options.recoverable !== false,
    ...(options.unconfirmed ? { unconfirmed: true } : {}),
    ...(retryAttempted ? { retryAttempted: true } : {}),
  };
}

function setAssistantAttachmentAvailability(
  resource: ChatMediaResource<AssistantAttachmentAvailability>,
  availability: AssistantAttachmentAvailability,
): void {
  if (!isChatMediaResourceCurrent(resource)) {
    return;
  }
  resource.value = availability;
  scheduleAssistantAttachmentRefresh(resource, availability);
}

function scheduleAssistantAttachmentRefresh(
  resource: ChatMediaResource<AssistantAttachmentAvailability>,
  availability: AssistantAttachmentAvailability,
): void {
  const refreshAt =
    availability.status === "unavailable" &&
    availability.recoverable &&
    !availability.retryAttempted
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
    // Preserve this generation's retry budget and playable ticket while the
    // replacement is minted; a checking card would reset native playback.
    notifyChatMediaResourceSubscribers(resource);
  });
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
