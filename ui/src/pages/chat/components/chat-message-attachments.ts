import { html, nothing } from "lit";
import { ref } from "lit/directives/ref.js";
import { styleMap } from "lit/directives/style-map.js";
import { icons } from "../../../components/icons.ts";
import type { ImageLightboxItem } from "../../../components/image-lightbox.ts";
import { t } from "../../../i18n/index.ts";
import "./chat-audio-player.ts";
import { safeAttachmentHref } from "./chat-attachment-href.ts";
import { getChatMediaSourceController } from "./chat-media-source.ts";
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

function videoCardFor(media: HTMLVideoElement): HTMLElement | null {
  return media.closest<HTMLElement>(".chat-assistant-attachment-card--video");
}

function markVideoMetadataLoaded(media: HTMLVideoElement, loaded: boolean): void {
  videoCardFor(media)?.toggleAttribute("data-metadata-loaded", loaded);
}

function markVideoUnplayable(media: HTMLVideoElement, unplayable: boolean): void {
  videoCardFor(media)?.toggleAttribute("data-unplayable", unplayable);
}

function syncVideoSource(media: HTMLVideoElement, source: string, sourceIdentity: string): void {
  getChatMediaSourceController(media).updateSource(media, source, sourceIdentity);
}

function recoverVideoSource(media: HTMLVideoElement): boolean {
  const recovered = getChatMediaSourceController(media).handleError(media);
  if (recovered) {
    markVideoMetadataLoaded(media, false);
    markVideoUnplayable(media, false);
  }
  return recovered;
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
) {
  if (attachments.length === 0) {
    return nothing;
  }
  return html`
    <div class="chat-assistant-attachments">
      ${attachments.map(({ attachment }) => {
        const availability = resolveAssistantAttachmentAvailability(
          attachment.url,
          localMediaPreviewRoots,
          basePath,
          authToken,
          onRequestUpdate,
        );
        const attachmentUrl =
          availability.status === "available"
            ? buildAssistantAttachmentUrl(attachment.url, basePath, availability.mediaTicket)
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
          const dimensions =
            attachment.width && attachment.height
              ? { "aspect-ratio": `${attachment.width} / ${attachment.height}` }
              : {};
          const downloadHref = safeAttachmentHref(attachmentUrl);
          return html`
            <div class="chat-assistant-attachment-card chat-assistant-attachment-card--video">
              <div class="chat-assistant-attachment-card__header">
                <span class="chat-assistant-attachment-card__title">${attachment.label}</span>
                ${downloadHref
                  ? html`<a
                      class="chat-assistant-attachment-card__download"
                      href=${downloadHref}
                      download=${attachment.label}
                      target="_blank"
                      rel="noreferrer"
                      aria-label=${t("chat.mediaPlayer.download", {
                        filename: attachment.label,
                      })}
                      title=${t("chat.mediaPlayer.download", { filename: attachment.label })}
                      >${icons.download}</a
                    >`
                  : nothing}
              </div>
              <div class="chat-assistant-video-frame" style=${styleMap(dimensions)}>
                <span class="chat-assistant-video-frame__placeholder" aria-hidden="true"
                  >${icons.monitor}</span
                >
                <video
                  controls
                  preload="metadata"
                  ${ref((element) => {
                    if (element instanceof HTMLVideoElement) {
                      syncVideoSource(element, attachmentUrl, attachment.url);
                    }
                  })}
                  @loadedmetadata=${(event: Event) => {
                    const media = event.currentTarget as HTMLVideoElement;
                    getChatMediaSourceController(media).handleLoadedMetadata(media);
                    markVideoMetadataLoaded(media, true);
                    markVideoUnplayable(media, false);
                    onAssistantAttachmentLoaded?.();
                  }}
                  @ended=${(event: Event) => {
                    const media = event.currentTarget as HTMLVideoElement;
                    if (getChatMediaSourceController(media).handleEnded(media)) {
                      markVideoMetadataLoaded(media, false);
                    }
                  }}
                  @seeking=${(event: Event) => {
                    const media = event.currentTarget as HTMLVideoElement;
                    if (media.error) {
                      recoverVideoSource(media);
                    }
                  }}
                  @error=${(event: Event) => {
                    const media = event.currentTarget as HTMLVideoElement;
                    if (!recoverVideoSource(media)) {
                      markVideoUnplayable(media, true);
                    }
                  }}
                ></video>
              </div>
              <div class="chat-assistant-video-fallback">
                <div class="chat-assistant-attachment-card__reason">
                  ${t("chat.mediaPlayer.videoUnavailable")}
                </div>
                ${downloadHref
                  ? html`<a
                      class="chat-assistant-attachment-card__link"
                      href=${downloadHref}
                      download=${attachment.label}
                      target="_blank"
                      rel="noreferrer"
                      >${t("chat.mediaPlayer.download", { filename: attachment.label })}</a
                    >`
                  : nothing}
              </div>
            </div>
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
