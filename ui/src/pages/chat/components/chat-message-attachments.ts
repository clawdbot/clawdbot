import { html, nothing } from "lit";
import { icons } from "../../../components/icons.ts";
import type { ImageLightboxItem } from "../../../components/image-lightbox.ts";
import { t } from "../../../i18n/index.ts";
import "./chat-audio-player.ts";
import "./chat-video-player.ts";
import { safeAttachmentHref } from "./chat-attachment-href.ts";
import { openResolvedImage } from "./chat-message-image-open.ts";
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
  type AttachmentItem,
  type ArtifactDownloadResolver,
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

const ASSISTANT_ATTACHMENT_UNAVAILABLE_RETRY_MS = 5_000;
const ASSISTANT_ATTACHMENT_METADATA_FETCH_TIMEOUT_MS = 30_000;
const ASSISTANT_ATTACHMENT_MEDIA_TICKET_REFRESH_SKEW_MS = 30_000;
const ASSISTANT_ATTACHMENT_MEDIA_TICKET_MAX_REFRESH_RETRIES = 2;
let assistantAttachmentAvailabilityRenderVersion = 0;

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

export function getAssistantAttachmentAvailabilityRenderVersion(): number {
  return assistantAttachmentAvailabilityRenderVersion;
}

function bumpAssistantAttachmentAvailabilityRenderVersion() {
  assistantAttachmentAvailabilityRenderVersion =
    (assistantAttachmentAvailabilityRenderVersion + 1) % Number.MAX_SAFE_INTEGER;
}

function setAssistantAttachmentAvailability(
  resource: ChatMediaResource<AssistantAttachmentAvailability>,
  availability: AssistantAttachmentAvailability,
) {
  if (!isChatMediaResourceCurrent(resource)) {
    return;
  }
  resource.value = availability;
  bumpAssistantAttachmentAvailabilityRenderVersion();
  scheduleAssistantAttachmentRefresh(resource, availability);
}

function buildAssistantAttachmentMetaUrl(source: string, basePath?: string): string {
  const attachmentUrl = buildAssistantAttachmentUrl(source, basePath);
  return `${attachmentUrl}${attachmentUrl.includes("?") ? "&" : "?"}meta=1`;
}

function scheduleAssistantAttachmentRefresh(
  resource: ChatMediaResource<AssistantAttachmentAvailability>,
  availability: AssistantAttachmentAvailability,
) {
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
      bumpAssistantAttachmentAvailabilityRenderVersion();
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

function renderAssistantAttachmentStatusCard(params: {
  kind: AttachmentItem["attachment"]["kind"];
  label: string;
  badge: string;
  reason?: string;
}) {
  const icon =
    params.kind === "image"
      ? icons.image
      : params.kind === "audio"
        ? icons.mic
        : params.kind === "video"
          ? icons.monitor
          : icons.paperclip;
  return html`
    <div class="chat-assistant-attachment-card chat-assistant-attachment-card--blocked">
      <div class="chat-assistant-attachment-card__header">
        <span class="chat-assistant-attachment-card__icon">${icon}</span>
        <span class="chat-assistant-attachment-card__title">${params.label}</span>
        <span class="chat-assistant-attachment-badge chat-assistant-attachment-badge--muted"
          >${params.badge}</span
        >
      </div>
      ${params.reason
        ? html`<div class="chat-assistant-attachment-card__reason">${params.reason}</div>`
        : nothing}
    </div>
  `;
}

type ManagedAttachmentAvailability =
  | { status: "checking" }
  | {
      status: "available";
      url: string;
      expiresAt?: number;
      refreshAfter?: number;
      refreshAttempts?: number;
    }
  | { status: "unavailable"; reason: string; checkedAt: number };

function isManagedOutgoingMediaSource(source: string): boolean {
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

function resolveManagedOutgoingMediaSessionKey(source: string): string | null {
  try {
    const encodedSessionKey = new URL(source, window.location.origin).pathname.split("/")[5];
    return encodedSessionKey ? decodeURIComponent(encodedSessionKey) : null;
  } catch {
    return null;
  }
}

function setManagedAttachmentAvailability(
  resource: ChatMediaResource<ManagedAttachmentAvailability>,
  availability: ManagedAttachmentAvailability,
): void {
  if (!isChatMediaResourceCurrent(resource)) {
    return;
  }
  resource.value = availability;
  bumpAssistantAttachmentAvailabilityRenderVersion();
  const refreshAt =
    availability.status === "available" && availability.expiresAt !== undefined
      ? (availability.refreshAfter ??
        availability.expiresAt - ASSISTANT_ATTACHMENT_MEDIA_TICKET_REFRESH_SKEW_MS)
      : availability.status === "unavailable" && !resource.retryAttempted
        ? availability.checkedAt + ASSISTANT_ATTACHMENT_UNAVAILABLE_RETRY_MS
        : undefined;
  scheduleChatMediaResourceRefresh(resource, refreshAt, () => {
    if (resource.value !== availability) {
      return;
    }
    if (availability.status === "unavailable") {
      resource.retryAttempted = true;
      resource.value = undefined;
    }
    bumpAssistantAttachmentAvailabilityRenderVersion();
    notifyChatMediaResourceSubscribers(resource);
  });
}

function resolveManagedAttachmentAvailability(
  attachment: AttachmentItem["attachment"],
  resolveArtifactDownload: ArtifactDownloadResolver | undefined,
  onRequestUpdate: (() => void) | undefined,
): ManagedAttachmentAvailability {
  if (!isManagedOutgoingMediaSource(attachment.url)) {
    return { status: "available", url: attachment.url };
  }
  if (!attachment.artifactId || !resolveArtifactDownload) {
    if (new URL(attachment.url, window.location.origin).searchParams.get("mediaTicket")?.trim()) {
      return { status: "available", url: attachment.url };
    }
    return {
      status: "unavailable",
      reason: t("chat.attachments.unavailable"),
      checkedAt: Date.now(),
    };
  }
  const sessionKey = resolveManagedOutgoingMediaSessionKey(attachment.url);
  if (!sessionKey) {
    return {
      status: "unavailable",
      reason: t("chat.attachments.unavailable"),
      checkedAt: Date.now(),
    };
  }
  const cacheKey = `${attachment.url}::${attachment.artifactId}`;
  const resource = observeChatMediaResource<ManagedAttachmentAvailability>(
    "managed-media",
    cacheKey,
    onRequestUpdate,
    attachment.url,
  );
  let cached = resource.value;
  const now = Date.now();
  if (cached?.status === "unavailable") {
    setManagedAttachmentAvailability(resource, cached);
    return cached;
  }
  if (cached?.status === "available" && cached.expiresAt !== undefined && cached.expiresAt <= now) {
    resource.value = undefined;
    cached = undefined;
    bumpAssistantAttachmentAvailabilityRenderVersion();
  }
  if (cached?.status === "available") {
    const refreshAt =
      cached.refreshAfter ??
      (cached.expiresAt === undefined
        ? undefined
        : cached.expiresAt - ASSISTANT_ATTACHMENT_MEDIA_TICKET_REFRESH_SKEW_MS);
    if (refreshAt === undefined || refreshAt > now) {
      setManagedAttachmentAvailability(resource, cached);
      return cached;
    }
  }
  if (resource.pending) {
    return cached?.status === "available" ? cached : { status: "checking" };
  }
  const current = cached?.status === "available" ? cached : null;
  const keepCurrentForRetry = () => {
    if (!current || (current.expiresAt !== undefined && current.expiresAt <= Date.now())) {
      return null;
    }
    const refreshAttempts = current.refreshAttempts ?? 0;
    const refreshAfter =
      current.expiresAt === undefined
        ? undefined
        : refreshAttempts < ASSISTANT_ATTACHMENT_MEDIA_TICKET_MAX_REFRESH_RETRIES
          ? Math.min(Date.now() + ASSISTANT_ATTACHMENT_UNAVAILABLE_RETRY_MS, current.expiresAt)
          : current.expiresAt;
    const retryAvailability: ManagedAttachmentAvailability = {
      ...current,
      ...(refreshAfter !== undefined ? { refreshAfter } : {}),
      refreshAttempts: refreshAttempts + 1,
    };
    setManagedAttachmentAvailability(resource, retryAvailability);
    return retryAvailability;
  };
  if (!current) {
    setManagedAttachmentAvailability(resource, { status: "checking" });
  }
  const pending = Promise.resolve()
    .then(() => resolveArtifactDownload({ sessionKey, artifactId: attachment.artifactId! }))
    .then((result) => {
      if (!isChatMediaResourceCurrent(resource)) {
        return null;
      }
      const url = result?.url.trim();
      if (!url) {
        const retryAvailability = keepCurrentForRetry();
        if (retryAvailability) {
          return retryAvailability;
        }
        const unavailable: ManagedAttachmentAvailability = {
          status: "unavailable",
          reason: t("chat.attachments.unavailable"),
          checkedAt: Date.now(),
        };
        setManagedAttachmentAvailability(resource, unavailable);
        return unavailable;
      }
      const parsedExpiresAt = Date.parse(result?.expiresAt ?? "");
      const expiresAt = Number.isFinite(parsedExpiresAt)
        ? parsedExpiresAt
        : Date.now() + 5 * 60_000;
      const availability: ManagedAttachmentAvailability = {
        status: "available",
        url,
        expiresAt,
      };
      resource.retryAttempted = false;
      setManagedAttachmentAvailability(resource, availability);
      return availability;
    })
    .catch(() => {
      const retryAvailability = keepCurrentForRetry();
      if (retryAvailability) {
        return retryAvailability;
      }
      const unavailable: ManagedAttachmentAvailability = {
        status: "unavailable",
        reason: t("chat.attachments.unavailable"),
        checkedAt: Date.now(),
      };
      setManagedAttachmentAvailability(resource, unavailable);
      return unavailable;
    })
    .finally(() => {
      if (resource.pending === pending) {
        resource.pending = undefined;
      }
      notifyChatMediaResourceSubscribers(resource);
    });
  resource.pending = pending;
  return current ?? { status: "checking" };
}

export function renderAssistantAttachments(
  attachments: AttachmentItem[],
  localMediaPreviewRoots: readonly string[],
  basePath?: string,
  authToken?: string | null,
  onRequestUpdate?: () => void,
  onAssistantAttachmentLoaded?: () => void,
  onRequestOpenImage?: () => number,
  onOpenImage?: (item: ImageLightboxItem, requestVersion?: number) => void,
  resolveArtifactDownload?: ArtifactDownloadResolver,
) {
  if (attachments.length === 0) {
    return nothing;
  }
  return html`
    <div class="chat-assistant-attachments">
      ${attachments.map(({ attachment }) => {
        const assistantAvailability = resolveAssistantAttachmentAvailability(
          attachment.url,
          localMediaPreviewRoots,
          basePath,
          authToken,
          onRequestUpdate,
        );
        const managedAvailability =
          assistantAvailability.status === "available"
            ? resolveManagedAttachmentAvailability(
                attachment,
                resolveArtifactDownload,
                onRequestUpdate,
              )
            : null;
        const availability =
          assistantAvailability.status !== "available"
            ? assistantAvailability
            : managedAvailability?.status === "unavailable"
              ? managedAvailability
              : managedAvailability?.status === "checking"
                ? managedAvailability
                : assistantAvailability;
        const attachmentUrl =
          assistantAvailability.status === "available" &&
          managedAvailability?.status === "available"
            ? isLocalAssistantAttachmentSource(attachment.url)
              ? buildAssistantAttachmentUrl(
                  attachment.url,
                  basePath,
                  assistantAvailability.mediaTicket,
                )
              : managedAvailability.url
            : null;
        const playback =
          assistantAvailability.status === "available"
            ? (assistantAvailability.playback ?? attachment.playback ?? "native")
            : (attachment.playback ?? "native");
        const sizeBytes =
          assistantAvailability.status === "available"
            ? (assistantAvailability.sizeBytes ?? attachment.sizeBytes)
            : attachment.sizeBytes;
        const serverDurationMs =
          isLocalAssistantAttachmentSource(attachment.url) &&
          assistantAvailability.status === "available"
            ? assistantAvailability.durationMs
            : undefined;
        const playbackAuthToken = isLocalAssistantAttachmentSource(attachment.url)
          ? (authToken ?? null)
          : null;
        if (attachment.kind === "image") {
          if (!attachmentUrl) {
            return renderAssistantAttachmentStatusCard({
              kind: "image",
              label: attachment.label,
              badge:
                availability.status === "checking"
                  ? t("chat.attachments.checking")
                  : t("chat.attachments.unavailable"),
              reason: availability.status === "unavailable" ? availability.reason : undefined,
            });
          }
          const title = attachment.label.trim() || t("chat.imageLightbox.untitled");
          return html`
            <button
              type="button"
              class="chat-message-image-button"
              aria-label=${t("chat.imageLightbox.open", { title })}
              @click=${() =>
                openResolvedImage(
                  onOpenImage,
                  attachmentUrl,
                  title,
                  undefined,
                  onRequestOpenImage?.(),
                )}
            >
              <img src=${attachmentUrl} alt=${title} class="chat-message-image" />
            </button>
          `;
        }
        if (attachment.kind === "audio") {
          if (!attachmentUrl) {
            return renderAssistantAttachmentStatusCard({
              kind: "audio",
              label: attachment.label,
              badge:
                availability.status === "checking"
                  ? t("chat.attachments.checking")
                  : t("chat.attachments.unavailable"),
              reason: availability.status === "unavailable" ? availability.reason : undefined,
            });
          }
          return html`
            <openclaw-chat-audio-player
              .src=${attachmentUrl}
              .sourceIdentity=${attachment.url}
              .label=${attachment.label}
              .playback=${playback}
              .authToken=${playbackAuthToken}
              .sizeBytes=${sizeBytes}
              .serverDurationMs=${serverDurationMs}
              .voiceNote=${attachment.isVoiceNote === true}
              .onMediaLoaded=${onAssistantAttachmentLoaded}
            ></openclaw-chat-audio-player>
          `;
        }
        if (attachment.kind === "video") {
          if (!attachmentUrl) {
            return renderAssistantAttachmentStatusCard({
              kind: "video",
              label: attachment.label,
              badge:
                availability.status === "checking"
                  ? t("chat.attachments.checking")
                  : t("chat.attachments.unavailable"),
              reason: availability.status === "unavailable" ? availability.reason : undefined,
            });
          }
          return html`
            <openclaw-chat-video-player
              .src=${attachmentUrl}
              .sourceIdentity=${attachment.url}
              .label=${attachment.label}
              .playback=${playback}
              .authToken=${playbackAuthToken}
              .mediaWidth=${assistantAvailability.status === "available"
                ? (assistantAvailability.width ?? attachment.width)
                : attachment.width}
              .mediaHeight=${assistantAvailability.status === "available"
                ? (assistantAvailability.height ?? attachment.height)
                : attachment.height}
              .onMediaLoaded=${onAssistantAttachmentLoaded}
            ></openclaw-chat-video-player>
          `;
        }
        if (!attachmentUrl) {
          return renderAssistantAttachmentStatusCard({
            kind: "document",
            label: attachment.label,
            badge:
              availability.status === "checking"
                ? t("chat.attachments.checking")
                : t("chat.attachments.unavailable"),
            reason: availability.status === "unavailable" ? availability.reason : undefined,
          });
        }
        const downloadHref = safeAttachmentHref(attachmentUrl);
        return html`
          <div class="chat-assistant-attachment-card">
            <span class="chat-assistant-attachment-card__icon">${icons.paperclip}</span>
            ${downloadHref
              ? html`<a
                  class="chat-assistant-attachment-card__link"
                  href=${downloadHref}
                  target="_blank"
                  rel="noreferrer"
                  >${attachment.label}</a
                >`
              : html`<span class="chat-assistant-attachment-card__title"
                  >${attachment.label}</span
                >`}
          </div>
        `;
      })}
    </div>
  `;
}
