import { t } from "../../../i18n/index.ts";
import {
  buildAssistantAttachmentUrl,
  isLocalAssistantAttachmentSource,
  isLocalAttachmentPreviewAllowed,
} from "./chat-message-local-media.ts";
import {
  isChatMediaResourceCurrent,
  notifyChatMediaResourceSubscribers,
  observeChatMediaResource,
  scheduleChatMediaResourceRefresh,
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
const ASSISTANT_ATTACHMENT_METADATA_FETCH_TIMEOUT_MS = 30_000;
export const ASSISTANT_ATTACHMENT_MEDIA_TICKET_REFRESH_SKEW_MS = 30_000;
export const ASSISTANT_ATTACHMENT_MEDIA_TICKET_MAX_REFRESH_RETRIES = 2;

export function resolveAssistantAttachmentAvailability(
  source: string,
  localMediaPreviewRoots: readonly string[],
  basePath: string | undefined,
  authToken: string | null | undefined,
  onRequestUpdate: (() => void) | undefined,
): AssistantAttachmentAvailability {
  if (!isLocalAssistantAttachmentSource(source)) {
    return { status: "available" };
  }
  // Bootstrap has no client roots yet; authenticated Gateway metadata remains authoritative.
  if (
    localMediaPreviewRoots.length > 0 &&
    !isLocalAttachmentPreviewAllowed(source, localMediaPreviewRoots)
  ) {
    return {
      status: "unavailable",
      reason: t("chat.attachments.outsideAllowedFolders"),
      checkedAt: Date.now(),
    };
  }
  const normalizedAuthToken = authToken?.trim() ?? "";
  const cacheKey = `${basePath ?? ""}::${normalizedAuthToken}::${source}`;
  const resource = observeChatMediaResource<AssistantAttachmentAvailability>(
    "assistant-attachment",
    cacheKey,
    onRequestUpdate,
    source,
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
    const retryAvailability: AssistantAttachmentAvailability = {
      ...refreshingAvailability,
      refreshAfter: Math.min(now + ASSISTANT_ATTACHMENT_UNAVAILABLE_RETRY_MS, expiresAt),
      refreshAttempts: refreshAttempts + 1,
    };
    setAssistantAttachmentAvailability(resource, retryAvailability);
    return retryAvailability;
  };
  if (typeof fetch === "function") {
    const headers = new Headers({ Accept: "application/json" });
    if (normalizedAuthToken) {
      headers.set("Authorization", `Bearer ${normalizedAuthToken}`);
    }
    const controller = new AbortController();
    resource.abortController = controller;
    const timeout = setTimeout(
      () =>
        controller.abort(
          new DOMException("assistant attachment metadata fetch timed out", "TimeoutError"),
        ),
      ASSISTANT_ATTACHMENT_METADATA_FETCH_TIMEOUT_MS,
    );
    const pending = fetch(buildAssistantAttachmentMetaUrl(source, basePath), {
      method: "GET",
      headers,
      credentials: "same-origin",
      signal: controller.signal,
    })
      .then(async (res) => {
        const payload = (await res.json().catch(() => null)) as {
          available?: boolean;
          mediaTicket?: string;
          mediaTicketExpiresAt?: string;
          playback?: "native" | "transcode";
          sizeBytes?: number;
          durationMs?: number;
          width?: number;
          height?: number;
          reason?: string;
        } | null;
        if (payload?.available === true) {
          const mediaTicket = payload.mediaTicket?.trim();
          const mediaTicketExpiresAt = Date.parse(payload.mediaTicketExpiresAt ?? "");
          if (mediaTicket && !Number.isFinite(mediaTicketExpiresAt)) {
            const retryAvailability = keepPlayableTicketForRetry();
            if (retryAvailability) {
              return retryAvailability;
            }
            const unavailable = createUnavailableAssistantAttachment(
              t("chat.attachments.unavailable"),
              resource.retryAttempted,
            );
            setAssistantAttachmentAvailability(resource, unavailable);
            return unavailable;
          }
          const availability: AssistantAttachmentAvailability = {
            status: "available",
            ...(mediaTicket ? { mediaTicket, mediaTicketExpiresAt } : {}),
            ...(payload.playback === "native" || payload.playback === "transcode"
              ? { playback: payload.playback }
              : {}),
            ...(typeof payload.sizeBytes === "number" ? { sizeBytes: payload.sizeBytes } : {}),
            ...(typeof payload.durationMs === "number" ? { durationMs: payload.durationMs } : {}),
            ...(typeof payload.width === "number" ? { width: payload.width } : {}),
            ...(typeof payload.height === "number" ? { height: payload.height } : {}),
          };
          resource.retryAttempted = false;
          setAssistantAttachmentAvailability(resource, availability);
          return availability;
        }
        const unavailable = createUnavailableAssistantAttachment(
          payload?.reason?.trim() || t("chat.attachments.unavailable"),
          resource.retryAttempted,
        );
        setAssistantAttachmentAvailability(resource, unavailable);
        return unavailable;
      })
      .catch(() => {
        const retryAvailability = keepPlayableTicketForRetry();
        if (retryAvailability) {
          return retryAvailability;
        }
        const unavailable = createUnavailableAssistantAttachment(
          t("chat.attachments.unavailable"),
          resource.retryAttempted,
        );
        setAssistantAttachmentAvailability(resource, unavailable);
        return unavailable;
      })
      .finally(() => {
        clearTimeout(timeout);
        if (resource.abortController === controller) {
          resource.abortController = undefined;
        }
        if (resource.pending === pending) {
          resource.pending = undefined;
        }
        notifyChatMediaResourceSubscribers(resource);
      });
    resource.pending = pending;
  }
  return refreshingAvailability ?? { status: "checking" };
}

function createUnavailableAssistantAttachment(
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

function buildAssistantAttachmentMetaUrl(source: string, basePath?: string): string {
  const attachmentUrl = buildAssistantAttachmentUrl(source, basePath);
  return `${attachmentUrl}${attachmentUrl.includes("?") ? "&" : "?"}meta=1`;
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
    if (availability.status === "checking") {
      resource.value = undefined;
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
