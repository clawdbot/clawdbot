import { html, nothing } from "lit";
import { keyed } from "lit/directives/keyed.js";
import { t } from "../../../i18n/index.ts";
import "./chat-audio-player.ts";
import "./chat-document-preview.ts";
import "./chat-svg-attachment.ts";
import "./chat-video-player.ts";
import { openAttachmentCardFromClick, renderAttachmentCardHeader } from "./chat-attachment-card.ts";
import { isSameOriginAttachmentHref, safeAttachmentHref } from "./chat-attachment-href.ts";
import {
  ASSISTANT_ATTACHMENT_MEDIA_TICKET_MAX_REFRESH_RETRIES,
  ASSISTANT_ATTACHMENT_MEDIA_TICKET_REFRESH_SKEW_MS,
  ASSISTANT_ATTACHMENT_UNAVAILABLE_RETRY_MS,
  isManagedOutgoingMediaSource,
  managedAttachmentRefreshDelayMs,
  resolveAssistantAttachmentAvailability,
  resolveManagedOutgoingMediaSessionKey,
  retryAssistantAttachmentAvailability,
  selectLaterExpiringManagedAttachment,
  type ManagedAttachmentAvailability,
} from "./chat-message-attachment-availability.ts";
import { renderAssistantAttachmentStatusCard } from "./chat-message-attachment-status.ts";
import {
  parseAttachmentDelimitedPreview,
  peekDocumentPreviewText,
  resolveDocumentFramePreviewState,
  resolveDocumentPreviewKind,
} from "./chat-message-document-preview.ts";
import { openResolvedImage } from "./chat-message-image-open.ts";
import {
  buildAssistantAttachmentUrl,
  isLocalAssistantAttachmentSource,
} from "./chat-message-local-media.ts";
import {
  isChatMediaResourceCurrent,
  isImageMediaPath,
  isSvgImageMediaPath,
  notifyChatMediaResourceSubscribers,
  observeChatMediaResource,
  scheduleChatMediaResourceRefresh,
  type AttachmentItem,
  type ArtifactDownloadResolver,
  type ChatMediaResource,
  type ImageRenderOptions,
} from "./chat-message-media.ts";
import type { SidebarContent } from "./chat-sidebar.ts";

let attachmentStyles: Promise<unknown> | undefined;

function retainManagedAttachmentUntilExpiry(
  resource: ChatMediaResource<ManagedAttachmentAvailability>,
  availability: Extract<ManagedAttachmentAvailability, { status: "available" }> | null,
  refreshAttempts: number,
): Extract<ManagedAttachmentAvailability, { status: "available" }> | null {
  if (!availability?.expiresAt || availability.expiresAt <= Date.now()) {
    return null;
  }
  const retained = {
    ...availability,
    refreshAfter: availability.expiresAt,
    refreshAttempts,
  };
  setManagedAttachmentAvailability(resource, retained);
  return retained;
}

function setManagedAttachmentAvailability(
  resource: ChatMediaResource<ManagedAttachmentAvailability>,
  availability: ManagedAttachmentAvailability,
  scheduleExpiryOnly = false,
): void {
  if (!isChatMediaResourceCurrent(resource)) {
    return;
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
  const cacheKey = `${connectionEpoch ?? 0}::${attachment.url}::${attachment.artifactId}`;
  const resource = observeChatMediaResource<ManagedAttachmentAvailability>(
    "managed-media",
    cacheKey,
    onRequestUpdate,
    attachment.url,
  );
  const cached = resource.value;
  const now = Date.now();
  if (cached?.status === "unavailable") {
    setManagedAttachmentAvailability(resource, cached);
    return cached;
  }
  if (
    cached?.status === "checking" &&
    cached.refreshAfter !== undefined &&
    cached.refreshAfter > now
  ) {
    setManagedAttachmentAvailability(resource, cached);
    return cached;
  }
  if (cached?.status === "available") {
    if (
      cached.expiresAt !== undefined &&
      cached.expiresAt <= now &&
      (cached.refreshAttempts ?? 0) >= ASSISTANT_ATTACHMENT_MEDIA_TICKET_MAX_REFRESH_RETRIES
    ) {
      resource.retryAttempted = true;
      const unavailable: ManagedAttachmentAvailability = {
        status: "unavailable",
        reason: t("chat.attachments.unavailable"),
        checkedAt: now,
      };
      setManagedAttachmentAvailability(resource, unavailable);
      return unavailable;
    }
    if (
      cached.expiresAt !== undefined &&
      cached.expiresAt <= now &&
      (resource.pending || (cached.refreshAfter !== undefined && cached.refreshAfter > now))
    ) {
      const checking: ManagedAttachmentAvailability = {
        status: "checking",
        ...(!resource.pending && cached.refreshAfter !== undefined
          ? { refreshAfter: cached.refreshAfter }
          : {}),
        refreshAttempts: cached.refreshAttempts,
      };
      setManagedAttachmentAvailability(resource, checking);
      return checking;
    }
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
  const current =
    cached?.status === "available" && (cached.expiresAt === undefined || cached.expiresAt > now)
      ? cached
      : null;
  const keepCurrentForRetry = () => {
    if (!current && cached?.status !== "checking") {
      return null;
    }
    const refreshAttempts = current?.refreshAttempts ?? cached?.refreshAttempts ?? 0;
    if (refreshAttempts >= ASSISTANT_ATTACHMENT_MEDIA_TICKET_MAX_REFRESH_RETRIES) {
      return retainManagedAttachmentUntilExpiry(resource, current, refreshAttempts);
    }
    const nextRefreshAttempts = refreshAttempts + 1;
    const refreshAfter = Date.now() + managedAttachmentRefreshDelayMs(nextRefreshAttempts);
    const retryAvailability: ManagedAttachmentAvailability =
      !current || (current.expiresAt !== undefined && current.expiresAt <= Date.now())
        ? { status: "checking", refreshAfter, refreshAttempts: nextRefreshAttempts }
        : { ...current, refreshAfter, refreshAttempts: nextRefreshAttempts };
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
        if (
          (cached?.refreshAttempts ?? 0) >= ASSISTANT_ATTACHMENT_MEDIA_TICKET_MAX_REFRESH_RETRIES
        ) {
          resource.retryAttempted = true;
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
      const refreshAttempts = cached?.refreshAttempts ?? 0;
      if (
        expiresAt - Date.now() <= ASSISTANT_ATTACHMENT_MEDIA_TICKET_REFRESH_SKEW_MS &&
        refreshAttempts >= ASSISTANT_ATTACHMENT_MEDIA_TICKET_MAX_REFRESH_RETRIES
      ) {
        const incoming: Extract<ManagedAttachmentAvailability, { status: "available" }> = {
          status: "available",
          url,
          expiresAt,
        };
        const retained = retainManagedAttachmentUntilExpiry(
          resource,
          selectLaterExpiringManagedAttachment(current, incoming),
          refreshAttempts,
        );
        if (retained) {
          return retained;
        }
        resource.retryAttempted = true;
        const unavailable: ManagedAttachmentAvailability = {
          status: "unavailable",
          reason: t("chat.attachments.unavailable"),
          checkedAt: Date.now(),
        };
        setManagedAttachmentAvailability(resource, unavailable);
        return unavailable;
      }
      const nextRefreshAttempts = refreshAttempts + 1;
      const needsEarlyRefresh =
        expiresAt - Date.now() <= ASSISTANT_ATTACHMENT_MEDIA_TICKET_REFRESH_SKEW_MS;
      if (expiresAt <= Date.now()) {
        const retryAvailability: ManagedAttachmentAvailability = {
          status: "checking",
          refreshAfter: Date.now() + managedAttachmentRefreshDelayMs(nextRefreshAttempts),
          refreshAttempts: nextRefreshAttempts,
        };
        setManagedAttachmentAvailability(resource, retryAvailability);
        return retryAvailability;
      }
      const availability: ManagedAttachmentAvailability = {
        status: "available",
        url,
        expiresAt,
        ...(needsEarlyRefresh
          ? {
              refreshAfter: Date.now() + managedAttachmentRefreshDelayMs(nextRefreshAttempts),
              refreshAttempts: nextRefreshAttempts,
            }
          : {}),
      };
      if (!needsEarlyRefresh) {
        resource.retryAttempted = false;
      }
      setManagedAttachmentAvailability(resource, availability);
      return availability;
    })
    .catch(() => {
      const retryAvailability = keepCurrentForRetry();
      if (retryAvailability) {
        return retryAvailability;
      }
      if ((cached?.refreshAttempts ?? 0) >= ASSISTANT_ATTACHMENT_MEDIA_TICKET_MAX_REFRESH_RETRIES) {
        resource.retryAttempted = true;
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

export function renderAssistantAttachments(
  attachments: AttachmentItem[],
  options: ImageRenderOptions,
  onAssistantAttachmentLoaded?: () => void,
  onOpenSidebar?: (content: SidebarContent) => void,
) {
  if (attachments.length === 0) {
    return nothing;
  }
  // Keep preview/icon rules off the core chat route until a transcript actually has attachments.
  attachmentStyles ??= import("../../../styles/chat/attachments.css");
  void attachmentStyles;
  const {
    connectionEpoch,
    localMediaPreviewRoots = [],
    resourceBasePath,
    authToken,
    onRequestUpdate,
    onRequestOpenImage,
    onOpenImage,
    resolveArtifactDownload,
  } = options;
  const renderAttachment = ({ attachment }: AttachmentItem) => {
    const localSource = isLocalAssistantAttachmentSource(attachment.url);
    const assistantAvailability = resolveAssistantAttachmentAvailability(
      attachment.url,
      localMediaPreviewRoots,
      resourceBasePath,
      authToken,
      onRequestUpdate,
    );
    const managedAvailability =
      assistantAvailability.status === "available"
        ? resolveManagedAttachmentAvailability(
            attachment,
            resolveArtifactDownload,
            onRequestUpdate,
            connectionEpoch,
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
      assistantAvailability.status === "available" && managedAvailability?.status === "available"
        ? localSource
          ? buildAssistantAttachmentUrl(
              attachment.url,
              resourceBasePath,
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
      assistantAvailability.status === "available"
        ? (assistantAvailability.durationMs ?? attachment.durationMs)
        : attachment.durationMs;
    const mediaWidth =
      assistantAvailability.status === "available"
        ? (assistantAvailability.width ?? attachment.width)
        : attachment.width;
    const mediaHeight =
      assistantAvailability.status === "available"
        ? (assistantAvailability.height ?? attachment.height)
        : attachment.height;
    const playbackAuthToken = localSource ? (authToken ?? null) : null;
    const safeAttachmentUrl = safeAttachmentHref(attachmentUrl ?? "");
    const hasLiveSidebarSource =
      localSource ||
      (isManagedOutgoingMediaSource(attachment.url) &&
        Boolean(attachment.artifactId && resolveArtifactDownload));
    const retryUnavailableAttachment =
      assistantAvailability.status === "unavailable" && assistantAvailability.recoverable
        ? () =>
            retryAssistantAttachmentAvailability(
              attachment.url,
              resourceBasePath,
              authToken,
              onRequestUpdate,
            )
        : managedAvailability?.status === "unavailable" &&
            Boolean(attachment.artifactId && resolveArtifactDownload)
          ? () => retryManagedAttachmentAvailability(attachment, onRequestUpdate, connectionEpoch)
          : undefined;
    const openAttachmentSidebar =
      attachmentUrl && (hasLiveSidebarSource || safeAttachmentUrl)
        ? () =>
            onOpenSidebar?.({
              kind: "attachment",
              attachmentKind: attachment.kind,
              title: attachment.label,
              ...(hasLiveSidebarSource ? {} : { src: safeAttachmentUrl }),
              mimeType: attachment.mimeType,
              sourceIdentity: attachment.url,
              playback,
              authToken: playbackAuthToken,
              sizeBytes,
              durationMs: serverDurationMs,
              width: mediaWidth,
              height: mediaHeight,
              voiceNote: attachment.isVoiceNote === true,
              ...(hasLiveSidebarSource
                ? {
                    resolveSource: (sidebarUpdate, runtime) => {
                      const nextAssistantAvailability = resolveAssistantAttachmentAvailability(
                        attachment.url,
                        runtime.localMediaPreviewRoots,
                        runtime.resourceBasePath,
                        runtime.authToken,
                        sidebarUpdate,
                      );
                      if (nextAssistantAvailability.status !== "available") {
                        return null;
                      }
                      const nextManagedAvailability = resolveManagedAttachmentAvailability(
                        attachment,
                        runtime.resolveArtifactDownload,
                        sidebarUpdate,
                        runtime.connectionEpoch,
                      );
                      if (nextManagedAvailability.status !== "available") {
                        return null;
                      }
                      return {
                        src: localSource
                          ? buildAssistantAttachmentUrl(
                              attachment.url,
                              runtime.resourceBasePath,
                              nextAssistantAvailability.mediaTicket,
                            )
                          : nextManagedAvailability.url,
                        playback:
                          nextAssistantAvailability.playback ?? attachment.playback ?? "native",
                        authToken: localSource ? (runtime.authToken ?? null) : null,
                        sizeBytes: nextAssistantAvailability.sizeBytes ?? attachment.sizeBytes,
                        durationMs: nextAssistantAvailability.durationMs ?? attachment.durationMs,
                        width: nextAssistantAvailability.width ?? attachment.width,
                        height: nextAssistantAvailability.height ?? attachment.height,
                      };
                    },
                  }
                : {}),
            })
        : undefined;
    if (
      attachment.kind === "image" ||
      (attachment.kind === "document" && isImageMediaPath(attachment.label, attachment.mimeType))
    ) {
      if (!attachmentUrl) {
        return renderAssistantAttachmentStatusCard({
          kind: "image",
          label: attachment.label,
          mimeType: attachment.mimeType,
          badge:
            availability.status === "checking"
              ? t("chat.attachments.checking")
              : t("chat.attachments.unavailable"),
          reason: availability.status === "unavailable" ? availability.reason : undefined,
          onRetry: retryUnavailableAttachment,
        });
      }
      const title = attachment.label.trim() || t("chat.imageLightbox.untitled");
      if (isSvgImageMediaPath(attachment.label, attachment.mimeType)) {
        return html`<openclaw-chat-svg-attachment
          .src=${attachmentUrl}
          .sourceIdentity=${attachment.url}
          .label=${title}
          .mimeType=${attachment.mimeType ?? "image/svg+xml"}
          .sizeBytes=${sizeBytes}
          .downloadHref=${safeAttachmentHref(attachmentUrl)}
          .onOpen=${(src: string, release: () => void) =>
            openResolvedImage(onOpenImage, src, title, release, onRequestOpenImage?.())}
          .onExpand=${openAttachmentSidebar}
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
    if (attachment.kind === "audio") {
      if (!attachmentUrl) {
        return renderAssistantAttachmentStatusCard({
          kind: "audio",
          label: attachment.label,
          mimeType: attachment.mimeType,
          badge:
            availability.status === "checking"
              ? t("chat.attachments.checking")
              : t("chat.attachments.unavailable"),
          reason: availability.status === "unavailable" ? availability.reason : undefined,
          onRetry: retryUnavailableAttachment,
        });
      }
      return html`
        <openclaw-chat-audio-player
          .src=${attachmentUrl}
          .sourceIdentity=${attachment.url}
          .label=${attachment.label}
          .mimeType=${attachment.mimeType ?? ""}
          .playback=${playback}
          .authToken=${playbackAuthToken}
          .sizeBytes=${sizeBytes}
          .serverDurationMs=${serverDurationMs}
          .voiceNote=${attachment.isVoiceNote === true}
          .onExpand=${openAttachmentSidebar}
          .onMediaLoaded=${onAssistantAttachmentLoaded}
        ></openclaw-chat-audio-player>
      `;
    }
    if (attachment.kind === "video") {
      if (!attachmentUrl) {
        return renderAssistantAttachmentStatusCard({
          kind: "video",
          label: attachment.label,
          mimeType: attachment.mimeType,
          badge:
            availability.status === "checking"
              ? t("chat.attachments.checking")
              : t("chat.attachments.unavailable"),
          reason: availability.status === "unavailable" ? availability.reason : undefined,
          onRetry: retryUnavailableAttachment,
        });
      }
      return html`
        <openclaw-chat-video-player
          .src=${attachmentUrl}
          .sourceIdentity=${attachment.url}
          .label=${attachment.label}
          .mimeType=${attachment.mimeType ?? ""}
          .playback=${playback}
          .authToken=${playbackAuthToken}
          .sizeBytes=${sizeBytes}
          .mediaWidth=${mediaWidth}
          .mediaHeight=${mediaHeight}
          .onExpand=${openAttachmentSidebar}
          .onMediaLoaded=${onAssistantAttachmentLoaded}
        ></openclaw-chat-video-player>
      `;
    }
    if (!attachmentUrl) {
      return renderAssistantAttachmentStatusCard({
        kind: "document",
        label: attachment.label,
        mimeType: attachment.mimeType,
        badge:
          availability.status === "checking"
            ? t("chat.attachments.checking")
            : t("chat.attachments.unavailable"),
        reason: availability.status === "unavailable" ? availability.reason : undefined,
        onRetry: retryUnavailableAttachment,
      });
    }
    const downloadHref = safeAttachmentHref(attachmentUrl);
    const previewKind = isSameOriginAttachmentHref(attachmentUrl, window.location.href)
      ? resolveDocumentPreviewKind(attachment)
      : null;
    const previewText =
      previewKind === "table"
        ? peekDocumentPreviewText(attachmentUrl, attachment.url, sizeBytes)
        : null;
    const framePreviewState =
      previewKind === "html" || previewKind === "page"
        ? resolveDocumentFramePreviewState(
            attachmentUrl,
            attachment.url,
            onRequestUpdate,
            previewKind === "html",
            sizeBytes,
          )
        : undefined;
    const tablePreviewFailed =
      previewKind === "table" &&
      previewText !== undefined &&
      parseAttachmentDelimitedPreview(previewText ?? "", attachment).rows.length === 0;
    const showPreview =
      previewKind !== null && !tablePreviewFailed && framePreviewState !== "failed";
    return keyed(
      attachmentUrl,
      html`
        <div
          class="chat-assistant-attachment-card chat-assistant-attachment-card--document ${showPreview
            ? "chat-assistant-attachment-card--preview"
            : "chat-assistant-attachment-card--compact"}"
          ?data-openable=${Boolean(openAttachmentSidebar)}
          @click=${(event: MouseEvent) => openAttachmentCardFromClick(event, openAttachmentSidebar)}
        >
          ${renderAttachmentCardHeader({
            kind: "document",
            label: attachment.label,
            mimeType: attachment.mimeType,
            sizeBytes,
            downloadHref,
            onExpand: openAttachmentSidebar,
            visualMode: showPreview ? "preview-with-favicon" : "large-placeholder",
          })}
          ${showPreview && previewKind
            ? html`<openclaw-chat-document-preview
                .attachment=${attachment}
                .attachmentUrl=${attachmentUrl}
                .previewKind=${previewKind}
                .sizeBytes=${sizeBytes}
                .onRequestUpdate=${onRequestUpdate}
              ></openclaw-chat-document-preview>`
            : null}
        </div>
      `,
    );
  };

  return html` <div class="chat-assistant-attachments">${attachments.map(renderAttachment)}</div> `;
}
