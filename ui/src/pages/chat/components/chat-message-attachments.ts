import { html, nothing } from "lit";
import { normalizeBasePath } from "../../../app-route-paths.ts";
import { t } from "../../../i18n/index.ts";
import { formatBytes } from "../../../lib/agents/display.ts";
import type { MessageContentItem } from "../../../lib/chat/chat-types.ts";
import { isImageMediaPath, isSvgImageMediaPath } from "../../../lib/media-file-extension.ts";
import "./chat-audio-player.ts";
import "./chat-svg-attachment.ts";
import "./chat-video-player.ts";
import { renderCompactAttachmentCard } from "./chat-attachment-card.ts";
import { safeAttachmentHref, safeMediaAttachmentHref } from "./chat-attachment-href.ts";
import {
  ASSISTANT_ATTACHMENT_MEDIA_TICKET_MAX_REFRESH_RETRIES,
  ASSISTANT_ATTACHMENT_MEDIA_TICKET_REFRESH_SKEW_MS,
  ASSISTANT_ATTACHMENT_UNAVAILABLE_RETRY_MS,
  isManagedOutgoingMediaSource,
  resolveAssistantAttachmentAvailability,
  resolveManagedOutgoingMediaSessionKey,
  retryAssistantAttachmentAvailability,
} from "./chat-message-attachment-availability.ts";
import {
  attachmentFailureReason,
  renderAssistantAttachmentStatusCard,
} from "./chat-message-attachment-status.ts";
import { openResolvedImage } from "./chat-message-image-open.ts";
import { renderMessageImages } from "./chat-message-images.ts";
import {
  buildAssistantAttachmentUrl,
  isLocalAssistantAttachmentSource,
} from "./chat-message-local-media.ts";
import {
  isChatMediaResourceCurrent,
  notifyChatMediaResourceSubscribers,
  observeChatMediaResource,
  scheduleChatMediaResourceRefresh,
  type AttachmentItem,
  type AssistantAttachmentItem,
  type ArtifactDownloadResolver,
  type ChatMediaResource,
  type ImageRenderOptions,
} from "./chat-message-media.ts";
import type { SidebarContent } from "./chat-sidebar.ts";

type OmittedMediaItem = Extract<MessageContentItem, { type: "omitted_media" }>;

export function renderOmittedMedia(items: OmittedMediaItem[]) {
  if (items.length === 0) {
    return nothing;
  }
  return html`${items.map((item) => {
    const reason =
      item.media.sizeBytes === undefined
        ? t("chat.attachments.omittedFromHistory")
        : t("chat.attachments.omittedFromHistoryWithSize", {
            size: formatBytes(item.media.sizeBytes),
          });
    return renderAssistantAttachmentStatusCard({
      label: t("chat.attachments.image"),
      badge: t("chat.attachments.history"),
      reason,
    });
  })}`;
}

type ManagedAttachmentAvailability =
  | { status: "checking"; refreshAfter?: number; refreshAttempts?: number }
  | {
      status: "available";
      url: string;
      expiresAt?: number;
      refreshAfter?: number;
      refreshAttempts?: number;
    }
  | { status: "unavailable"; reason: string; checkedAt: number };

function unavailableManagedAttachment(): ManagedAttachmentAvailability {
  return {
    status: "unavailable",
    reason: t("chat.attachments.unavailable"),
    checkedAt: Date.now(),
  };
}

function retryManagedAttachment(
  candidate: Extract<ManagedAttachmentAvailability, { status: "available" }> | null,
  refreshAttempts: number,
  now = Date.now(),
): ManagedAttachmentAvailability {
  const available =
    candidate?.expiresAt !== undefined && candidate.expiresAt <= now ? null : candidate;
  if (refreshAttempts >= ASSISTANT_ATTACHMENT_MEDIA_TICKET_MAX_REFRESH_RETRIES) {
    // Exhaustion stops renewal, not playback: retain a valid ticket only until its expiry.
    return available?.expiresAt
      ? { ...available, refreshAfter: available.expiresAt, refreshAttempts }
      : unavailableManagedAttachment();
  }
  return {
    ...(available ?? { status: "checking" }),
    refreshAfter: now + ASSISTANT_ATTACHMENT_UNAVAILABLE_RETRY_MS * 2 ** refreshAttempts,
    refreshAttempts: refreshAttempts + 1,
  };
}

function applyResourceBasePath(source: string, resourceBasePath: string | undefined): string {
  if (!source.startsWith("/") || source.startsWith("//")) {
    return source;
  }
  try {
    const parsed = new URL(source, window.location.origin);
    const basePath = normalizeBasePath(resourceBasePath ?? "");
    const pathname =
      basePath && parsed.pathname !== basePath && !parsed.pathname.startsWith(`${basePath}/`)
        ? `${basePath}${parsed.pathname}`
        : parsed.pathname;
    return `${pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return source;
  }
}

function setManagedAttachmentAvailability(
  resource: ChatMediaResource<ManagedAttachmentAvailability>,
  availability: ManagedAttachmentAvailability,
  scheduleExpiryOnly = false,
): ManagedAttachmentAvailability {
  if (!isChatMediaResourceCurrent(resource)) {
    return availability;
  }
  resource.value = availability;
  const refreshAt =
    availability.status === "checking"
      ? availability.refreshAfter
      : availability.status === "available" && availability.expiresAt !== undefined
        ? scheduleExpiryOnly
          ? availability.expiresAt
          : Math.min(
              availability.refreshAfter ??
                availability.expiresAt - ASSISTANT_ATTACHMENT_MEDIA_TICKET_REFRESH_SKEW_MS,
              availability.expiresAt,
            )
        : availability.status === "unavailable" && !resource.retryAttempted
          ? availability.checkedAt + ASSISTANT_ATTACHMENT_UNAVAILABLE_RETRY_MS
          : undefined;
  scheduleChatMediaResourceRefresh(resource, refreshAt, () => {
    if (resource.value?.status === "unavailable") {
      resource.retryAttempted = true;
      resource.value = undefined;
    }
    notifyChatMediaResourceSubscribers(resource);
  });
  return availability;
}

function resolveManagedAttachmentAvailability(
  attachment: AttachmentItem["attachment"],
  resolveArtifactDownload: ArtifactDownloadResolver | undefined,
  onRequestUpdate: (() => void) | undefined,
  connectionEpoch: number | undefined,
): ManagedAttachmentAvailability {
  if (!isManagedOutgoingMediaSource(attachment.url)) {
    return { status: "available", url: attachment.url };
  }
  if (!attachment.artifactId || !resolveArtifactDownload) {
    if (new URL(attachment.url, window.location.origin).searchParams.get("mediaTicket")?.trim()) {
      return { status: "available", url: attachment.url };
    }
    return unavailableManagedAttachment();
  }
  const sessionKey = resolveManagedOutgoingMediaSessionKey(attachment.url);
  if (!sessionKey) {
    return unavailableManagedAttachment();
  }
  const cacheKey = `${connectionEpoch ?? 0}::${attachment.url}::${attachment.artifactId}`;
  const resource = observeChatMediaResource<ManagedAttachmentAvailability>(
    "managed-media",
    cacheKey,
    onRequestUpdate,
    attachment.url,
  );
  const cached = resource.value;
  const now = Date.now();
  if (
    cached?.status === "unavailable" ||
    (cached?.status === "checking" &&
      cached.refreshAfter !== undefined &&
      cached.refreshAfter > now)
  ) {
    return setManagedAttachmentAvailability(resource, cached);
  }
  if (cached?.status === "available") {
    const expired = cached.expiresAt !== undefined && cached.expiresAt <= now;
    if (
      expired &&
      (cached.refreshAttempts ?? 0) >= ASSISTANT_ATTACHMENT_MEDIA_TICKET_MAX_REFRESH_RETRIES
    ) {
      resource.retryAttempted = true;
      return setManagedAttachmentAvailability(resource, unavailableManagedAttachment());
    }
    if (
      expired &&
      (resource.pending || (cached.refreshAfter !== undefined && cached.refreshAfter > now))
    ) {
      return setManagedAttachmentAvailability(resource, {
        status: "checking",
        refreshAfter: resource.pending ? undefined : cached.refreshAfter,
        refreshAttempts: cached.refreshAttempts,
      });
    }
    const refreshAt =
      cached.refreshAfter ??
      (cached.expiresAt === undefined
        ? undefined
        : cached.expiresAt - ASSISTANT_ATTACHMENT_MEDIA_TICKET_REFRESH_SKEW_MS);
    if (refreshAt === undefined || refreshAt > now) {
      return setManagedAttachmentAvailability(resource, cached);
    }
  }
  if (resource.pending) {
    return cached?.status === "available" ? cached : { status: "checking" };
  }
  const current =
    cached?.status === "available" && (cached.expiresAt === undefined || cached.expiresAt > now)
      ? cached
      : null;
  const refreshAttempts = cached?.refreshAttempts ?? 0;
  const handleResolutionFailure = () =>
    current || cached?.status === "checking"
      ? retryManagedAttachment(current, refreshAttempts)
      : unavailableManagedAttachment();
  if (!current) {
    setManagedAttachmentAvailability(resource, { status: "checking" });
  }
  const pending = Promise.resolve()
    .then(async () => {
      let availability: ManagedAttachmentAvailability;
      try {
        const result = await resolveArtifactDownload({
          sessionKey,
          artifactId: attachment.artifactId!,
        });
        const url = result?.url.trim();
        if (!url) {
          availability = handleResolutionFailure();
        } else {
          const parsedExpiresAt = Date.parse(result?.expiresAt ?? "");
          const resolvedAt = Date.now();
          const expiresAt = Number.isFinite(parsedExpiresAt)
            ? parsedExpiresAt
            : resolvedAt + 5 * 60_000;
          const incoming: Extract<ManagedAttachmentAvailability, { status: "available" }> = {
            status: "available",
            url,
            expiresAt,
          };
          availability =
            expiresAt - resolvedAt > ASSISTANT_ATTACHMENT_MEDIA_TICKET_REFRESH_SKEW_MS
              ? incoming
              : retryManagedAttachment(
                  refreshAttempts >= ASSISTANT_ATTACHMENT_MEDIA_TICKET_MAX_REFRESH_RETRIES &&
                    current?.expiresAt !== undefined &&
                    current.expiresAt >= expiresAt
                    ? current
                    : incoming,
                  refreshAttempts,
                  resolvedAt,
                );
        }
      } catch {
        availability = handleResolutionFailure();
      }
      if (!isChatMediaResourceCurrent(resource)) {
        return null;
      }
      if (availability.status === "available" && availability.refreshAttempts === undefined) {
        resource.retryAttempted = false;
      } else if (
        availability.status === "unavailable" &&
        refreshAttempts >= ASSISTANT_ATTACHMENT_MEDIA_TICKET_MAX_REFRESH_RETRIES
      ) {
        resource.retryAttempted = true;
      }
      return setManagedAttachmentAvailability(resource, availability);
    })
    .finally(() => {
      if (resource.pending === pending) {
        resource.pending = undefined;
      }
      notifyChatMediaResourceSubscribers(resource);
    });
  resource.pending = pending;
  if (current) {
    setManagedAttachmentAvailability(resource, current, true);
  }
  return current ?? { status: "checking" };
}

function retryManagedAttachmentAvailability(
  attachment: AttachmentItem["attachment"],
  onRequestUpdate: (() => void) | undefined,
  connectionEpoch: number | undefined,
): void {
  if (!attachment.artifactId || !isManagedOutgoingMediaSource(attachment.url)) {
    return;
  }
  const resource = observeChatMediaResource<ManagedAttachmentAvailability>(
    "managed-media",
    `${connectionEpoch ?? 0}::${attachment.url}::${attachment.artifactId}`,
    onRequestUpdate,
    attachment.url,
  );
  resource.value = undefined;
  resource.retryAttempted = false;
  resource.unavailableAt = undefined;
  notifyChatMediaResourceSubscribers(resource);
  onRequestUpdate?.();
}

function resolveAttachmentSource(
  attachment: AttachmentItem["attachment"],
  options: ImageRenderOptions,
) {
  const { resourceBasePath, authToken, onRequestUpdate, resolveArtifactDownload, connectionEpoch } =
    options;
  const assistantAvailability = resolveAssistantAttachmentAvailability(attachment.url, options);
  if (assistantAvailability.status !== "available") {
    return {
      status: assistantAvailability.status,
      reason:
        assistantAvailability.status === "unavailable" ? assistantAvailability.reason : undefined,
      onAllow:
        assistantAvailability.status === "unavailable" && assistantAvailability.canAllow
          ? () => retryAssistantAttachmentAvailability(attachment.url, options, true)
          : undefined,
      onRetry:
        assistantAvailability.status === "unavailable" && assistantAvailability.recoverable
          ? () => retryAssistantAttachmentAvailability(attachment.url, options)
          : undefined,
    };
  }
  const managedAvailability = resolveManagedAttachmentAvailability(
    attachment,
    resolveArtifactDownload,
    onRequestUpdate,
    connectionEpoch,
  );
  if (managedAvailability.status !== "available") {
    return {
      status: managedAvailability.status,
      reason: managedAvailability.status === "unavailable" ? managedAvailability.reason : undefined,
      onRetry:
        managedAvailability.status === "unavailable" &&
        attachment.artifactId &&
        resolveArtifactDownload
          ? () => retryManagedAttachmentAvailability(attachment, onRequestUpdate, connectionEpoch)
          : undefined,
    };
  }
  const localSource = isLocalAssistantAttachmentSource(attachment.url);
  const src = localSource
    ? buildAssistantAttachmentUrl(
        attachment.url,
        resourceBasePath,
        assistantAvailability.mediaTicket,
        options,
      )
    : isManagedOutgoingMediaSource(attachment.url)
      ? applyResourceBasePath(managedAvailability.url, resourceBasePath)
      : managedAvailability.url;
  if (!src) {
    return { status: "checking" as const, reason: undefined, onRetry: undefined };
  }
  const playback = assistantAvailability.playback ?? attachment.playback ?? "native";
  return {
    status: "available" as const,
    source: {
      src,
      playback,
      authToken: localSource ? (authToken ?? null) : null,
      sizeBytes: assistantAvailability.sizeBytes ?? attachment.sizeBytes,
      durationMs: assistantAvailability.durationMs ?? attachment.durationMs,
      width: assistantAvailability.width ?? attachment.width,
      height: assistantAvailability.height ?? attachment.height,
    },
  };
}

export function renderAssistantAttachments(
  attachments: AssistantAttachmentItem[],
  options: ImageRenderOptions,
  onOpenSidebar?: (content: SidebarContent) => void,
  onAssistantAttachmentLoaded?: () => void,
  inlinePlayback = true,
) {
  if (attachments.length === 0) {
    return nothing;
  }
  const { onRequestOpenImage, onOpenImage, resolveArtifactDownload } = options;
  const renderAttachment = (item: AssistantAttachmentItem) => {
    if (item.type === "attachment_error") {
      const { attachment } = item;
      return renderAssistantAttachmentStatusCard({
        label: attachment.label,
        mimeType: attachment.mimeType,
        badge: t("chat.attachments.notSent"),
        reason: attachmentFailureReason(attachment.code),
      });
    }
    const { attachment } = item;
    const normalizedMimeType = attachment.mimeType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
    const inferTypeFromExtension =
      !normalizedMimeType || normalizedMimeType === "application/octet-stream";
    const imageAttachment =
      attachment.kind === "image" ||
      (attachment.kind === "document" &&
        (isImageMediaPath(attachment.url, normalizedMimeType) ||
          (inferTypeFromExtension && isImageMediaPath(attachment.label, undefined))));
    const svgImage =
      normalizedMimeType === "image/svg+xml" ||
      (inferTypeFromExtension &&
        (isSvgImageMediaPath(attachment.url, undefined) ||
          isSvgImageMediaPath(attachment.label, undefined)));
    if (imageAttachment && !svgImage && !isManagedOutgoingMediaSource(attachment.url)) {
      return renderMessageImages(
        [{ ...attachment, alt: attachment.label, fileName: attachment.label }],
        options,
      );
    }
    const resolved = resolveAttachmentSource(attachment, options);
    if (resolved.status !== "available") {
      return renderAssistantAttachmentStatusCard({
        label: attachment.label,
        mimeType: attachment.mimeType,
        badge: resolved.status === "unavailable" ? t("chat.attachments.unavailable") : "",
        reason: resolved.status === "unavailable" ? resolved.reason : undefined,
        onRetry: resolved.onRetry,
        onAllow: imageAttachment ? resolved.onAllow : undefined,
        path: isLocalAssistantAttachmentSource(attachment.url) ? attachment.url : undefined,
      });
    }
    const { src: attachmentUrl, ...media } = resolved.source;
    const safeAttachmentUrl =
      attachment.kind === "audio" || attachment.kind === "video"
        ? safeMediaAttachmentHref(attachmentUrl, attachment.kind)
        : safeAttachmentHref(attachmentUrl);
    const openVideoOverlay =
      attachment.kind === "video" && onOpenImage && safeAttachmentUrl
        ? (src: string) => {
            const requestVersion = onRequestOpenImage?.();
            const overlayItem = {
              kind: "video" as const,
              src,
              originalSrc: safeAttachmentUrl,
              title: attachment.label,
            };
            if (requestVersion === undefined) {
              onOpenImage(overlayItem);
            } else {
              onOpenImage(overlayItem, requestVersion);
            }
          }
        : undefined;
    const hasLiveSidebarSource =
      isLocalAssistantAttachmentSource(attachment.url) ||
      (isManagedOutgoingMediaSource(attachment.url) &&
        Boolean(attachment.artifactId && resolveArtifactDownload));
    const openAttachmentSidebar =
      onOpenSidebar && (hasLiveSidebarSource || safeAttachmentUrl)
        ? () =>
            onOpenSidebar({
              kind: "attachment",
              attachmentKind: attachment.kind,
              title: attachment.label,
              ...(hasLiveSidebarSource ? {} : { src: safeAttachmentUrl }),
              mimeType: attachment.mimeType,
              sourceIdentity: attachment.url,
              ...media,
              voiceNote: attachment.isVoiceNote === true,
              ...(hasLiveSidebarSource
                ? {
                    resolveSource: (sidebarUpdate, runtime) => {
                      const next = resolveAttachmentSource(attachment, {
                        ...runtime,
                        onRequestUpdate: sidebarUpdate,
                      });
                      return next.status === "available" ? next.source : null;
                    },
                  }
                : {}),
            })
        : undefined;
    if (imageAttachment) {
      const title = attachment.label.trim() || t("chat.imageLightbox.untitled");
      if (svgImage) {
        return html`<openclaw-chat-svg-attachment
          .src=${attachmentUrl}
          .sourceIdentity=${attachment.url}
          .label=${title}
          .mimeType=${attachment.mimeType ?? "image/svg+xml"}
          .sizeBytes=${media.sizeBytes}
          .downloadHref=${safeAttachmentHref(attachmentUrl)}
          .onOpen=${(src: string, release: () => void) =>
            openResolvedImage(onOpenImage, src, title, release, onRequestOpenImage?.())}
          .onExpand=${openAttachmentSidebar}
          .onMediaLoaded=${onAssistantAttachmentLoaded}
        ></openclaw-chat-svg-attachment>`;
      }
      return html`
        <button
          type="button"
          class="chat-message-image-button"
          aria-label=${t("chat.imageLightbox.open", { title })}
          @click=${() =>
            openResolvedImage(onOpenImage, attachmentUrl, title, undefined, onRequestOpenImage?.())}
        >
          <img src=${attachmentUrl} alt=${title} class="chat-message-image" />
        </button>
      `;
    }
    if ((attachment.kind === "audio" || attachment.kind === "video") && !safeAttachmentUrl) {
      return renderAssistantAttachmentStatusCard({
        label: attachment.label,
        mimeType: attachment.mimeType,
        badge: t("chat.attachments.unavailable"),
        reason: t("chat.attachments.previewUnavailable"),
      });
    }
    if (inlinePlayback && attachment.kind === "audio") {
      return html`<openclaw-chat-audio-player
        .src=${safeAttachmentUrl}
        .sourceIdentity=${attachment.url}
        .label=${attachment.label}
        .mimeType=${attachment.mimeType ?? ""}
        .playback=${media.playback}
        .authToken=${media.authToken}
        .sizeBytes=${media.sizeBytes}
        .serverDurationMs=${media.durationMs}
        .voiceNote=${attachment.isVoiceNote === true}
        .onExpand=${openAttachmentSidebar}
        .onMediaLoaded=${onAssistantAttachmentLoaded}
      ></openclaw-chat-audio-player>`;
    }
    if (inlinePlayback && attachment.kind === "video") {
      return html`<openclaw-chat-video-player
        .src=${safeAttachmentUrl}
        .sourceIdentity=${attachment.url}
        .label=${attachment.label}
        .mimeType=${attachment.mimeType ?? ""}
        .playback=${media.playback}
        .authToken=${media.authToken}
        .sizeBytes=${media.sizeBytes}
        .mediaWidth=${media.width}
        .mediaHeight=${media.height}
        .onExpand=${openVideoOverlay}
        .onFallbackExpand=${openAttachmentSidebar}
        .onMediaLoaded=${onAssistantAttachmentLoaded}
      ></openclaw-chat-video-player>`;
    }
    return renderCompactAttachmentCard({
      kind: attachment.kind,
      label: attachment.label,
      mimeType: attachment.mimeType,
      sizeBytes: media.sizeBytes,
      downloadHref: safeAttachmentUrl,
      onExpand: openAttachmentSidebar,
      voiceNote: attachment.isVoiceNote === true,
    });
  };

  return html` <div class="chat-assistant-attachments">${attachments.map(renderAttachment)}</div> `;
}
