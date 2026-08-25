import { html, nothing } from "lit";
import { keyed } from "lit/directives/keyed.js";
import { t } from "../../../i18n/index.ts";
import "./chat-audio-player.ts";
import "./chat-video-player.ts";
import { openAttachmentCardFromClick, renderAttachmentCardHeader } from "./chat-attachment-card.ts";
import { safeAttachmentHref } from "./chat-attachment-href.ts";
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
  parseDelimitedPreview,
  renderAttachmentDocumentPreview,
  resolveDocumentPreviewText,
  resolveDocumentPreviewKind,
} from "./chat-message-document-preview.ts";
import { openResolvedImage } from "./chat-message-image-open.ts";
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
  type ArtifactDownloadResolver,
  type ChatMediaResource,
  type ImageRenderOptions,
} from "./chat-message-media.ts";
import type { SidebarContent } from "./chat-sidebar.ts";

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

export function renderAssistantAttachments(
  attachments: AttachmentItem[],
  options: ImageRenderOptions,
  onAssistantAttachmentLoaded?: () => void,
  onOpenSidebar?: (content: SidebarContent) => void,
) {
  if (attachments.length === 0) {
    return nothing;
  }
  const {
    localMediaPreviewRoots = [],
    resourceBasePath,
    authToken,
    onRequestUpdate,
    onRequestOpenImage,
    onOpenImage,
    resolveArtifactDownload,
  } = options;
  const renderAttachment = ({ attachment }: AttachmentItem) => {
    const assistantAvailability = resolveAssistantAttachmentAvailability(
      attachment.url,
      localMediaPreviewRoots,
      resourceBasePath,
      authToken,
      onRequestUpdate,
    );
    const managedAvailability =
      assistantAvailability.status === "available"
        ? resolveManagedAttachmentAvailability(attachment, resolveArtifactDownload, onRequestUpdate)
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
        ? isLocalAssistantAttachmentSource(attachment.url)
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
    const playbackAuthToken = isLocalAssistantAttachmentSource(attachment.url)
      ? (authToken ?? null)
      : null;
    const hasLiveSidebarSource =
      isLocalAssistantAttachmentSource(attachment.url) ||
      (isManagedOutgoingMediaSource(attachment.url) &&
        Boolean(attachment.artifactId && resolveArtifactDownload));
    const retryUnavailableAttachment =
      availability.status === "unavailable" &&
      (!("recoverable" in availability) || availability.recoverable)
        ? () =>
            retryAssistantAttachmentAvailability(
              attachment.url,
              resourceBasePath,
              authToken,
              onRequestUpdate,
            )
        : undefined;
    const openAttachmentSidebar = attachmentUrl
      ? () =>
          onOpenSidebar?.({
            kind: "attachment",
            attachmentKind: attachment.kind,
            title: attachment.label,
            ...(hasLiveSidebarSource ? {} : { src: attachmentUrl }),
            mimeType: attachment.mimeType,
            sourceIdentity: attachment.url,
            playback,
            authToken: playbackAuthToken,
            sizeBytes,
            durationMs: serverDurationMs,
            voiceNote: attachment.isVoiceNote === true,
            ...(hasLiveSidebarSource
              ? {
                  resolveSource: (sidebarUpdate: () => void) => {
                    const nextAssistantAvailability = resolveAssistantAttachmentAvailability(
                      attachment.url,
                      localMediaPreviewRoots,
                      resourceBasePath,
                      authToken,
                      sidebarUpdate,
                    );
                    if (nextAssistantAvailability.status !== "available") {
                      return null;
                    }
                    const nextManagedAvailability = resolveManagedAttachmentAvailability(
                      attachment,
                      resolveArtifactDownload,
                      sidebarUpdate,
                    );
                    if (nextManagedAvailability.status !== "available") {
                      return null;
                    }
                    return {
                      src: isLocalAssistantAttachmentSource(attachment.url)
                        ? buildAssistantAttachmentUrl(
                            attachment.url,
                            resourceBasePath,
                            nextAssistantAvailability.mediaTicket,
                          )
                        : nextManagedAvailability.url,
                      playback:
                        nextAssistantAvailability.playback ?? attachment.playback ?? "native",
                      authToken: isLocalAssistantAttachmentSource(attachment.url)
                        ? (authToken ?? null)
                        : null,
                      sizeBytes: nextAssistantAvailability.sizeBytes ?? attachment.sizeBytes,
                      durationMs: nextAssistantAvailability.durationMs ?? attachment.durationMs,
                    };
                  },
                }
              : {}),
          })
      : undefined;
    if (attachment.kind === "image") {
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
          .mediaWidth=${assistantAvailability.status === "available"
            ? (assistantAvailability.width ?? attachment.width)
            : attachment.width}
          .mediaHeight=${assistantAvailability.status === "available"
            ? (assistantAvailability.height ?? attachment.height)
            : attachment.height}
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
    const previewKind = resolveDocumentPreviewKind(attachment);
    const previewText =
      previewKind === "table"
        ? resolveDocumentPreviewText(attachmentUrl, attachment.url, sizeBytes, onRequestUpdate)
        : null;
    const tablePreviewFailed =
      previewKind === "table" &&
      previewText !== undefined &&
      parseDelimitedPreview(previewText ?? "").rows.length === 0;
    const showPreview = previewKind !== null && !tablePreviewFailed;
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
            showExpandAction: true,
            onExpand: openAttachmentSidebar,
            visualMode: showPreview ? "preview-with-favicon" : "large-placeholder",
          })}
          ${showPreview && previewKind
            ? renderAttachmentDocumentPreview(previewKind, attachment, attachmentUrl, previewText)
            : null}
        </div>
      `,
    );
  };

  return html` <div class="chat-assistant-attachments">${attachments.map(renderAttachment)}</div> `;
}
