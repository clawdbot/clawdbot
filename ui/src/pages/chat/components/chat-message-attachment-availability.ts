import type { AssistantMediaContext } from "../../../app/assistant-media.ts";
import { t } from "../../../i18n/index.ts";
import { formatUiExternalText } from "../../../lib/format-error.ts";
import {
  buildAssistantAttachmentUrl,
  isLocalAssistantAttachmentSource,
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
  | {
      status: "unavailable";
      reason: string;
      checkedAt: number;
      recoverable: boolean;
      retryAttempted?: true;
      unconfirmed?: true;
      canAllow?: boolean;
    };

export const ASSISTANT_ATTACHMENT_UNAVAILABLE_RETRY_MS = 5_000;
const ASSISTANT_ATTACHMENT_METADATA_FETCH_TIMEOUT_MS = 30_000;
export const ASSISTANT_ATTACHMENT_MEDIA_TICKET_REFRESH_SKEW_MS = 30_000;
export const ASSISTANT_ATTACHMENT_MEDIA_TICKET_MAX_REFRESH_RETRIES = 2;

export function resolveAssistantAttachmentAvailability(
  source: string,
  resourceBasePath: string | undefined,
  authToken: string | null | undefined,
  onRequestUpdate: (() => void) | undefined,
  context?: AssistantMediaContext,
  allowImage = false,
): AssistantAttachmentAvailability {
  if (!isLocalAssistantAttachmentSource(source)) {
    return { status: "available" };
  }
  const normalizedAuthToken = authToken?.trim() ?? "";
  const cacheKey = assistantAttachmentCacheKey(
    source,
    resourceBasePath,
    normalizedAuthToken,
    context,
  );
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
    const attachmentUrl = buildAssistantAttachmentUrl(
      source,
      resourceBasePath,
      refreshingAvailability?.mediaTicket,
      context,
    );
    const pending = fetch(`${attachmentUrl}&meta=1${allowImage ? "&allow=1" : ""}`, {
      method: allowImage ? "POST" : "GET",
      headers,
      credentials: "same-origin",
      signal: controller.signal,
    })
      .then(async (res): Promise<AssistantAttachmentAvailability> => {
        if (res.status === 408 || res.status === 429 || res.status >= 500) {
          throw new Error("Attachment metadata temporarily unavailable");
        }
        if (!res.ok) {
          return createUnavailableAssistantAttachment(
            t("chat.attachments.unavailable"),
            resource.retryAttempted,
          );
        }
        const payload = (await res.json()) as {
          available?: boolean;
          mediaTicket?: string;
          mediaTicketExpiresAt?: string;
          playback?: "native" | "transcode";
          sizeBytes?: number;
          durationMs?: number;
          width?: number;
          height?: number;
          code?: string;
          reason?: string;
          retryable?: boolean;
          canAllow?: boolean;
        } | null;
        if (payload?.available === false) {
          return createUnavailableAssistantAttachment(
            payload.code === "outside-allowed-folders"
              ? t("chat.attachments.outsideAllowedFolders")
              : formatUiExternalText(payload.reason, t("chat.attachments.unavailable")),
            resource.retryAttempted,
            { recoverable: payload.retryable !== false, canAllow: payload.canAllow === true },
          );
        }
        if (payload?.available === true) {
          const mediaTicket = payload.mediaTicket?.trim();
          const mediaTicketExpiresAt = Date.parse(payload.mediaTicketExpiresAt ?? "");
          if (mediaTicket && !Number.isFinite(mediaTicketExpiresAt)) {
            throw new Error("Attachment metadata has an invalid ticket expiry");
          }
          resource.retryAttempted = false;
          return {
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
        }
        throw new Error("Attachment metadata has no availability result");
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

export function retryAssistantAttachmentAvailability(
  source: string,
  resourceBasePath: string | undefined,
  authToken: string | null | undefined,
  onRequestUpdate: (() => void) | undefined,
  context?: AssistantMediaContext,
  allowImage = false,
): void {
  if (!isLocalAssistantAttachmentSource(source)) {
    onRequestUpdate?.();
    return;
  }
  const normalizedAuthToken = authToken?.trim() ?? "";
  const cacheKey = assistantAttachmentCacheKey(
    source,
    resourceBasePath,
    normalizedAuthToken,
    context,
  );
  const resource = observeChatMediaResource<AssistantAttachmentAvailability>(
    "assistant-attachment",
    cacheKey,
    onRequestUpdate,
    source,
  );
  resource.abortController?.abort();
  resource.abortController = undefined;
  resource.pending = undefined;
  resource.value = undefined;
  resource.retryAttempted = false;
  scheduleAssistantAttachmentRefresh(resource, { status: "checking" });
  if (allowImage) {
    resolveAssistantAttachmentAvailability(
      source,
      resourceBasePath,
      authToken,
      onRequestUpdate,
      context,
      true,
    );
  }
  notifyChatMediaResourceSubscribers(resource);
  onRequestUpdate?.();
}

function createUnavailableAssistantAttachment(
  reason: string,
  retryAttempted: boolean,
  options: { recoverable?: boolean; unconfirmed?: true; canAllow?: boolean } = {},
): Extract<AssistantAttachmentAvailability, { status: "unavailable" }> {
  return {
    status: "unavailable",
    reason,
    checkedAt: Date.now(),
    recoverable: options.recoverable !== false,
    ...(options.unconfirmed ? { unconfirmed: true } : {}),
    ...(retryAttempted ? { retryAttempted: true } : {}),
    ...(options.canAllow ? { canAllow: true } : {}),
  };
}

function assistantAttachmentCacheKey(
  source: string,
  resourceBasePath: string | undefined,
  authToken: string,
  context: AssistantMediaContext | undefined,
): string {
  // Identical paths can have different project/protection policy in different sessions.
  return JSON.stringify([
    resourceBasePath ?? "",
    authToken,
    context?.sessionKey,
    context?.agentId,
    context?.policyKey,
    source,
  ]);
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
