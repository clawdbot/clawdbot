import { html, nothing } from "lit";
import { icons } from "../../../components/icons.ts";
import type { ImageLightboxItem } from "../../../components/image-lightbox.ts";
import { t } from "../../../i18n/index.ts";
import { openResolvedImage } from "./chat-message-image-open.ts";
import {
  buildAssistantAttachmentUrl,
  isLocalAssistantAttachmentSource,
  isLocalAttachmentPreviewAllowed,
} from "./chat-message-local-media.ts";
import type { AttachmentItem } from "./chat-message-media.ts";

type AssistantAttachmentAvailability =
  | { status: "checking" }
  | { status: "available"; mediaTicket?: string; mediaTicketExpiresAt?: number }
  | { status: "unavailable"; reason: string; checkedAt: number; retryAttempted?: true };

const assistantAttachmentAvailabilityCache = new Map<string, AssistantAttachmentAvailability>();
const assistantAttachmentRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
const ASSISTANT_ATTACHMENT_UNAVAILABLE_RETRY_MS = 5_000;
const ASSISTANT_ATTACHMENT_METADATA_FETCH_TIMEOUT_MS = 30_000;
const ASSISTANT_ATTACHMENT_MEDIA_TICKET_REFRESH_SKEW_MS = 30_000;
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
  cacheKey: string,
  availability: AssistantAttachmentAvailability,
  onRequestUpdate?: () => void,
) {
  assistantAttachmentAvailabilityCache.set(cacheKey, availability);
  bumpAssistantAttachmentAvailabilityRenderVersion();
  scheduleAssistantAttachmentRefresh(cacheKey, availability, onRequestUpdate);
}

function deleteAssistantAttachmentAvailability(cacheKey: string) {
  if (assistantAttachmentAvailabilityCache.delete(cacheKey)) {
    bumpAssistantAttachmentAvailabilityRenderVersion();
  }
}

function buildAssistantAttachmentMetaUrl(source: string, basePath?: string): string {
  const attachmentUrl = buildAssistantAttachmentUrl(source, basePath);
  return `${attachmentUrl}${attachmentUrl.includes("?") ? "&" : "?"}meta=1`;
}

function clearAssistantAttachmentRefreshTimer(cacheKey: string) {
  const timer = assistantAttachmentRefreshTimers.get(cacheKey);
  if (timer) {
    clearTimeout(timer);
    assistantAttachmentRefreshTimers.delete(cacheKey);
  }
}

function scheduleAssistantAttachmentRefresh(
  cacheKey: string,
  availability: AssistantAttachmentAvailability,
  onRequestUpdate: (() => void) | undefined,
) {
  clearAssistantAttachmentRefreshTimer(cacheKey);
  if (!onRequestUpdate) {
    return;
  }
  const refreshAt =
    availability.status === "unavailable" && !availability.retryAttempted
      ? availability.checkedAt + ASSISTANT_ATTACHMENT_UNAVAILABLE_RETRY_MS
      : availability.status === "available" &&
          availability.mediaTicket &&
          availability.mediaTicketExpiresAt
        ? availability.mediaTicketExpiresAt - ASSISTANT_ATTACHMENT_MEDIA_TICKET_REFRESH_SKEW_MS
        : undefined;
  if (refreshAt === undefined) {
    return;
  }
  const refreshInMs = Math.max(0, refreshAt - Date.now());
  const timer = setTimeout(() => {
    assistantAttachmentRefreshTimers.delete(cacheKey);
    if (assistantAttachmentAvailabilityCache.get(cacheKey) !== availability) {
      return;
    }
    // Keep the failed generation until its retry can inherit the one-attempt
    // budget; ticket refreshes must still invalidate their current generation.
    if (availability.status !== "unavailable") {
      deleteAssistantAttachmentAvailability(cacheKey);
    }
    onRequestUpdate();
  }, refreshInMs);
  assistantAttachmentRefreshTimers.set(cacheKey, timer);
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
  if (!isLocalAttachmentPreviewAllowed(source, localMediaPreviewRoots)) {
    return { status: "unavailable", reason: "Outside allowed folders", checkedAt: Date.now() };
  }
  const normalizedAuthToken = authToken?.trim() ?? "";
  const cacheKey = `${basePath ?? ""}::${normalizedAuthToken}::${source}`;
  const cached = assistantAttachmentAvailabilityCache.get(cacheKey);
  let retryAttempted = false;
  if (cached) {
    const now = Date.now();
    if (
      cached.status === "unavailable" &&
      !cached.retryAttempted &&
      now - cached.checkedAt >= ASSISTANT_ATTACHMENT_UNAVAILABLE_RETRY_MS
    ) {
      retryAttempted = true;
      deleteAssistantAttachmentAvailability(cacheKey);
    } else if (
      cached.status === "available" &&
      cached.mediaTicket &&
      (!cached.mediaTicketExpiresAt ||
        cached.mediaTicketExpiresAt - now <= ASSISTANT_ATTACHMENT_MEDIA_TICKET_REFRESH_SKEW_MS)
    ) {
      deleteAssistantAttachmentAvailability(cacheKey);
    } else {
      scheduleAssistantAttachmentRefresh(cacheKey, cached, onRequestUpdate);
      return cached;
    }
  }
  clearAssistantAttachmentRefreshTimer(cacheKey);
  setAssistantAttachmentAvailability(cacheKey, { status: "checking" });
  if (typeof fetch === "function") {
    const headers = new Headers({ Accept: "application/json" });
    if (normalizedAuthToken) {
      headers.set("Authorization", `Bearer ${normalizedAuthToken}`);
    }
    const controller = new AbortController();
    const timeout = setTimeout(
      () =>
        controller.abort(
          new DOMException("assistant attachment metadata fetch timed out", "TimeoutError"),
        ),
      ASSISTANT_ATTACHMENT_METADATA_FETCH_TIMEOUT_MS,
    );
    void fetch(buildAssistantAttachmentMetaUrl(source, basePath), {
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
            setAssistantAttachmentAvailability(
              cacheKey,
              createUnavailableAssistantAttachment("Attachment unavailable", retryAttempted),
              onRequestUpdate,
            );
            return;
          }
          const availability: AssistantAttachmentAvailability = {
            status: "available",
            ...(mediaTicket ? { mediaTicket, mediaTicketExpiresAt } : {}),
          };
          setAssistantAttachmentAvailability(cacheKey, availability, onRequestUpdate);
        } else {
          setAssistantAttachmentAvailability(
            cacheKey,
            createUnavailableAssistantAttachment(
              payload?.reason?.trim() || "Attachment unavailable",
              retryAttempted,
            ),
            onRequestUpdate,
          );
        }
      })
      .catch(() => {
        setAssistantAttachmentAvailability(
          cacheKey,
          createUnavailableAssistantAttachment("Attachment unavailable", retryAttempted),
          onRequestUpdate,
        );
      })
      .finally(() => {
        clearTimeout(timeout);
        onRequestUpdate?.();
      });
  }
  return { status: "checking" };
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
              badge: availability.status === "checking" ? "Checking..." : "Unavailable",
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
          return html`
            <div class="chat-assistant-attachment-card chat-assistant-attachment-card--audio">
              <div class="chat-assistant-attachment-card__header">
                <span class="chat-assistant-attachment-card__title">${attachment.label}</span>
                ${!attachmentUrl
                  ? html`<span
                      class="chat-assistant-attachment-badge chat-assistant-attachment-badge--muted"
                      >${availability.status === "checking" ? "Checking..." : "Unavailable"}</span
                    >`
                  : attachment.isVoiceNote
                    ? html`<span class="chat-assistant-attachment-badge"
                        >${t("chat.messages.voiceNote")}</span
                      >`
                    : nothing}
              </div>
              ${attachmentUrl
                ? html`<audio
                    controls
                    preload="metadata"
                    src=${attachmentUrl}
                    @loadedmetadata=${() => onAssistantAttachmentLoaded?.()}
                  ></audio>`
                : availability.status === "unavailable"
                  ? html`<div class="chat-assistant-attachment-card__reason">
                      ${availability.reason}
                    </div>`
                  : nothing}
            </div>
          `;
        }
        if (attachment.kind === "video") {
          if (!attachmentUrl) {
            return renderAssistantAttachmentStatusCard({
              kind: "video",
              label: attachment.label,
              badge: availability.status === "checking" ? "Checking..." : "Unavailable",
              reason: availability.status === "unavailable" ? availability.reason : undefined,
            });
          }
          return html`
            <div class="chat-assistant-attachment-card chat-assistant-attachment-card--video">
              <video
                controls
                preload="metadata"
                src=${attachmentUrl}
                @loadedmetadata=${() => onAssistantAttachmentLoaded?.()}
              ></video>
              <a
                class="chat-assistant-attachment-card__link"
                href=${attachmentUrl}
                target="_blank"
                rel="noreferrer"
                >${attachment.label}</a
              >
            </div>
          `;
        }
        if (!attachmentUrl) {
          return renderAssistantAttachmentStatusCard({
            kind: "document",
            label: attachment.label,
            badge: availability.status === "checking" ? "Checking..." : "Unavailable",
            reason: availability.status === "unavailable" ? availability.reason : undefined,
          });
        }
        return html`
          <div class="chat-assistant-attachment-card">
            <span class="chat-assistant-attachment-card__icon">${icons.paperclip}</span>
            <a
              class="chat-assistant-attachment-card__link"
              href=${attachmentUrl}
              target="_blank"
              rel="noreferrer"
              >${attachment.label}</a
            >
          </div>
        `;
      })}
    </div>
  `;
}
