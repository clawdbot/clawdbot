// Control UI chat module implements grouped render behavior.
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { html, nothing } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { until } from "lit/directives/until.js";
import type { QuestionPrompt } from "../../../app/question-prompt.ts";
import { resolveLocalUserName } from "../../../app/user-identity.ts";
import { renderCopyAsMarkdownButton } from "../../../components/copy-button.ts";
import { icons, type IconName } from "../../../components/icons.ts";
import type { ImageLightboxItem } from "../../../components/image-lightbox.ts";
import type { MarkdownRenderOptions } from "../../../components/markdown-render-options.ts";
import { toSanitizedMarkdownHtml, toStreamingMarkdownHtml } from "../../../components/markdown.ts";
import { t } from "../../../i18n/index.ts";
import type { AssistantIdentity } from "../../../lib/assistant-identity.ts";
import type { BoardProvider } from "../../../lib/board/provider.ts";
import type {
  ChatItem,
  MessageContentItem,
  MessageGroup,
  NormalizedMessage,
  ToolCard,
} from "../../../lib/chat/chat-types.ts";
import {
  extractThinkingCached,
  formatReasoningMarkdown,
} from "../../../lib/chat/message-extract.ts";
import {
  isStandaloneToolMessageForDisplay,
  normalizeMessage,
} from "../../../lib/chat/message-normalizer.ts";
import { normalizeRoleForGrouping } from "../../../lib/chat/message-normalizer.ts";
import { formatSenderLabel } from "../../../lib/chat/sender-label.ts";
import { summarizeToolGroup } from "../../../lib/chat/tool-call-grouping.ts";
import {
  extractToolCardsCached,
  formatDistinctCollapsedToolSummaryText,
  formatCollapsedToolPreviewText,
  formatCollapsedToolSummaryText,
  isToolCardError,
} from "../../../lib/chat/tool-cards.ts";
import type { EmbedSandboxMode } from "../../../lib/chat/tool-display.ts";
import { resolveToolDisplay } from "../../../lib/chat/tool-display.ts";
import { resolveUiHourCycleOptions } from "../../../lib/format.ts";
import {
  formatCompactTokenCount,
  formatDurationCompact,
  formatTimeAgo,
} from "../../../lib/format.ts";
import { resolveIdentityHue } from "../../../lib/identity-avatar.ts";
import { getMediaFileExtension } from "../../../lib/media-file-extension.ts";
import "../../../components/tooltip.ts";
import {
  openExternalUrlSafe,
  reserveExternalWindowForDeferredNavigation,
  resolveSafeExternalUrl,
} from "../../../lib/open-external-url.ts";
import { stripThinkingTags } from "../../../lib/strip-thinking-tags.ts";
import { detectTextDirection } from "../../../lib/text-direction.ts";
import { getSafeLocalStorage } from "../../../local-storage.ts";
import { renderChatAvatar } from "../chat-avatar.ts";
import type { ChatRunStartupPhase } from "../chat-run-startup.ts";
import { isPendingSendMessage, persistedMessageEntryId } from "../chat-thread.ts";
import type { PlanStatus } from "../tool-stream.ts";
import {
  visibleWorkspaceConflictPaths,
  workspaceConflictCount,
  workspaceConflictPathForDisplay,
  workspaceResultConflictFromTranscript,
  type WorkspaceResultConflict,
} from "../workspace-conflict.ts";
import { renderChatAuthorAvatar } from "./chat-author-avatar.ts";
import { renderChatPlanChecklist } from "./chat-plan-checklist.ts";
import { renderChatQuestionSummary } from "./chat-question-card.ts";
import type { SidebarContent } from "./chat-sidebar.ts";
import {
  isRunningToolCard,
  renderExpandedToolCardContent,
  renderRawOutputToggle,
  renderToolCard,
  renderToolPreview,
  resolveCollapsedToolDetail,
  resolveToolRowText,
  shouldToggleSelectableDisclosure,
} from "./chat-tool-cards.ts";
import { renderChatWorkingIndicator } from "./chat-working-indicator.ts";

function renderChatIcon(name: string) {
  return icons[name as IconName] ?? icons.zap;
}

type AssistantAttachmentAvailability =
  | { status: "checking" }
  | { status: "available"; mediaTicket?: string; mediaTicketExpiresAt?: number }
  | { status: "unavailable"; reason: string; checkedAt: number };
type PairingQrExpiryNotice = {
  title: string;
  reason: string;
};
type PairingQrExpiryRefreshTimer = {
  expiresAtMs: number;
  onRequestUpdate: () => void;
  timer: ReturnType<typeof setTimeout>;
};

const assistantAttachmentAvailabilityCache = new Map<string, AssistantAttachmentAvailability>();
const assistantAttachmentRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pairingQrExpiryRefreshTimers = new Map<string, PairingQrExpiryRefreshTimer>();
const ASSISTANT_ATTACHMENT_UNAVAILABLE_RETRY_MS = 5_000;
const ASSISTANT_ATTACHMENT_METADATA_FETCH_TIMEOUT_MS = 30_000;
const ASSISTANT_ATTACHMENT_MEDIA_TICKET_REFRESH_SKEW_MS = 30_000;
let assistantAttachmentAvailabilityRenderVersion = 0;

type ChatTimestampDisplay = {
  label: string;
  title: string;
  dateTime: string;
};

function formatChatTimestampForDisplay(timestamp: number): ChatTimestampDisplay {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) {
    return {
      label: t("chat.messages.unknownDate"),
      title: t("chat.messages.unknownDate"),
      dateTime: "",
    };
  }

  const hourCycle = resolveUiHourCycleOptions();
  return {
    label: date.toLocaleString([], {
      ...hourCycle,
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    }),
    title: date.toLocaleString([], {
      ...hourCycle,
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
      timeZoneName: "short",
    }),
    dateTime: date.toISOString(),
  };
}

const CHAT_RELATIVE_TIMESTAMP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const CHAT_RELATIVE_TIMESTAMP_FUTURE_SKEW_MS = 2 * 60 * 1000;

/** Footer label: relative for recent messages, compact date beyond a week. */
function formatChatRelativeTimestampLabel(timestamp: number, nowMs = Date.now()): string {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) {
    return t("chat.messages.unknownDate");
  }
  const ageMs = nowMs - date.getTime();
  // Derive from ageMs so the injected clock stays the single time source.
  // Slightly-future (clock-skewed) messages clamp to "just now"; anything
  // further out falls through to the compact date instead of lying forever.
  if (
    ageMs >= -CHAT_RELATIVE_TIMESTAMP_FUTURE_SKEW_MS &&
    ageMs < CHAT_RELATIVE_TIMESTAMP_MAX_AGE_MS
  ) {
    return formatTimeAgo(Math.max(0, ageMs));
  }
  return date.toLocaleDateString([], {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() === new Date(nowMs).getFullYear() ? {} : { year: "numeric" }),
  });
}

// Footer times read relative ("5m ago"); the absolute timestamp lives in the
// tooltip, or in the msg-meta popover when usage metadata makes the
// timestamp interactive (a nested tooltip would fight the popover).
function renderChatTimestamp(timestamp: number, interactive = false) {
  const display = formatChatTimestampForDisplay(timestamp);
  const timeEl = html`
    <time class="chat-group-timestamp" datetime=${display.dateTime} aria-live="off">
      ${formatChatRelativeTimestampLabel(timestamp)}
    </time>
  `;
  if (interactive) {
    return timeEl;
  }
  return html`<openclaw-tooltip content=${display.label}>${timeEl}</openclaw-tooltip>`;
}

function resolveMessageMetaDetails(target: EventTarget | null): HTMLDetailsElement | null {
  if (target instanceof HTMLDetailsElement) {
    return target;
  }
  return target instanceof HTMLElement
    ? target.closest<HTMLDetailsElement>("details.msg-meta")
    : null;
}

function previewMessageMeta(event: PointerEvent | FocusEvent) {
  const details = resolveMessageMetaDetails(event.currentTarget);
  if (!details || details.open || ("pointerType" in event && event.pointerType === "touch")) {
    return;
  }
  details.dataset.preview = "true";
  details.open = true;
}

function closeMessageMetaPreview(event: PointerEvent | FocusEvent) {
  const details = resolveMessageMetaDetails(event.currentTarget);
  if (!details || details.dataset.preview !== "true" || details.matches(":hover, :focus-within")) {
    return;
  }
  delete details.dataset.preview;
  details.open = false;
}

function pinMessageMetaPreview(event: MouseEvent) {
  const details = resolveMessageMetaDetails(event.currentTarget);
  if (details?.dataset.preview !== "true") {
    return;
  }
  event.preventDefault();
  delete details.dataset.preview;
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
) {
  assistantAttachmentAvailabilityCache.set(cacheKey, availability);
  bumpAssistantAttachmentAvailabilityRenderVersion();
}

function deleteAssistantAttachmentAvailability(cacheKey: string) {
  if (assistantAttachmentAvailabilityCache.delete(cacheKey)) {
    bumpAssistantAttachmentAvailabilityRenderVersion();
  }
}

type ImageBlock = {
  url: string;
  openUrl?: string;
  alt?: string;
  width?: number;
  height?: number;
};

type ImageRenderOptions = {
  localMediaPreviewRoots?: readonly string[];
  basePath?: string;
  authToken?: string | null;
  onRequestUpdate?: () => void;
  onRequestOpenImage?: () => number;
  onOpenImage?: (item: ImageLightboxItem, requestVersion?: number) => void;
};

type RenderableImageBlock = ImageBlock & {
  displayUrl: string;
};

type AttachmentItem = Extract<MessageContentItem, { type: "attachment" }>;

const managedImageBlobUrlCache = new Map<string, Promise<string | null>>();
const managedImageBlobUrlResolvedCache = new Map<string, string>();
const managedImageBlobUrlMissCache = new Map<string, number>();
const managedImageBlobUrlRetainCounts = new Map<string, number>();
const MANAGED_IMAGE_BLOB_URL_CACHE_MAX_ENTRIES = 64;
const MANAGED_IMAGE_BLOB_URL_MISS_RETRY_MS = 5_000;
const MANAGED_OUTGOING_IMAGE_FETCH_TIMEOUT_MS = 30_000;

function readManagedImageBlobUrl(cacheKey: string): string | undefined {
  const cached = managedImageBlobUrlResolvedCache.get(cacheKey);
  if (!cached) {
    return undefined;
  }
  managedImageBlobUrlResolvedCache.delete(cacheKey);
  managedImageBlobUrlResolvedCache.set(cacheKey, cached);
  return cached;
}

function trimManagedImageBlobUrlCache() {
  while (managedImageBlobUrlResolvedCache.size > MANAGED_IMAGE_BLOB_URL_CACHE_MAX_ENTRIES) {
    const evictable = [...managedImageBlobUrlResolvedCache.keys()].find(
      (cacheKey) => (managedImageBlobUrlRetainCounts.get(cacheKey) ?? 0) === 0,
    );
    if (!evictable) {
      return;
    }
    const evicted = managedImageBlobUrlResolvedCache.get(evictable);
    managedImageBlobUrlResolvedCache.delete(evictable);
    if (evicted) {
      URL.revokeObjectURL(evicted);
    }
  }
}

function retainManagedImageBlobUrl(cacheKey: string): (() => void) | undefined {
  if (!managedImageBlobUrlResolvedCache.has(cacheKey)) {
    return undefined;
  }
  managedImageBlobUrlRetainCounts.set(
    cacheKey,
    (managedImageBlobUrlRetainCounts.get(cacheKey) ?? 0) + 1,
  );
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    const remaining = (managedImageBlobUrlRetainCounts.get(cacheKey) ?? 1) - 1;
    if (remaining <= 0) {
      managedImageBlobUrlRetainCounts.delete(cacheKey);
    } else {
      managedImageBlobUrlRetainCounts.set(cacheKey, remaining);
    }
    trimManagedImageBlobUrlCache();
  };
}

function cacheManagedImageBlobUrl(cacheKey: string, blobUrl: string) {
  const previous = managedImageBlobUrlResolvedCache.get(cacheKey);
  managedImageBlobUrlResolvedCache.delete(cacheKey);
  managedImageBlobUrlResolvedCache.set(cacheKey, blobUrl);
  managedImageBlobUrlMissCache.delete(cacheKey);
  if (previous && previous !== blobUrl) {
    URL.revokeObjectURL(previous);
  }

  // Blob URLs retain browser-managed image data. Keep recent previews reusable,
  // but protect an image while its lightbox still uses that object URL.
  trimManagedImageBlobUrlCache();
}

function hasRecentManagedImageBlobUrlMiss(cacheKey: string): boolean {
  const missAt = managedImageBlobUrlMissCache.get(cacheKey);
  if (missAt === undefined) {
    return false;
  }
  if (Date.now() - missAt >= MANAGED_IMAGE_BLOB_URL_MISS_RETRY_MS) {
    managedImageBlobUrlMissCache.delete(cacheKey);
    return false;
  }
  managedImageBlobUrlMissCache.delete(cacheKey);
  managedImageBlobUrlMissCache.set(cacheKey, missAt);
  return true;
}

function cacheManagedImageBlobUrlMiss(cacheKey: string) {
  managedImageBlobUrlMissCache.delete(cacheKey);
  managedImageBlobUrlMissCache.set(cacheKey, Date.now());
  while (managedImageBlobUrlMissCache.size > MANAGED_IMAGE_BLOB_URL_CACHE_MAX_ENTRIES) {
    const oldest = managedImageBlobUrlMissCache.keys().next();
    if (oldest.done) {
      break;
    }
    managedImageBlobUrlMissCache.delete(oldest.value);
  }
}

function appendImageBlock(images: ImageBlock[], block: ImageBlock) {
  if (!images.some((entry) => entry.url === block.url && entry.alt === block.alt)) {
    images.push(block);
  }
}

function buildBase64ImageUrl(params: { data: string; mediaType?: string }): string {
  return params.data.startsWith("data:")
    ? params.data
    : `data:${params.mediaType ?? "image/png"};base64,${params.data}`;
}

function isImageTranscriptMediaPath(path: string, mediaType: unknown): boolean {
  if (typeof mediaType === "string" && mediaType.trim()) {
    const normalized = mediaType.trim().toLowerCase();
    if (normalized.startsWith("image/")) {
      return true;
    }
    if (normalized !== "application/octet-stream") {
      return false;
    }
  }
  const ext = getMediaFileExtension(path);
  return (
    ext !== undefined &&
    ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "heic", "heif", "avif"].includes(ext)
  );
}

function isAudioTranscriptMediaPath(path: string, mediaType: unknown): boolean {
  if (typeof mediaType === "string" && mediaType.trim().toLowerCase().startsWith("audio/")) {
    return true;
  }
  const ext = getMediaFileExtension(path);
  return (
    ext !== undefined &&
    ["aac", "flac", "m2a", "m4a", "mp3", "oga", "ogg", "opus", "wav"].includes(ext)
  );
}

function isVideoTranscriptMediaPath(path: string, mediaType: unknown): boolean {
  if (typeof mediaType === "string" && mediaType.trim().toLowerCase().startsWith("video/")) {
    return true;
  }
  const ext = getMediaFileExtension(path);
  return ext !== undefined && ["m4v", "mov", "mp4", "webm"].includes(ext);
}

function labelForMediaPath(mediaPath: string): string {
  const trimmed = mediaPath.trim();
  try {
    if (/^https?:\/\//i.test(trimmed)) {
      const parsed = new URL(trimmed);
      return parsed.pathname.split("/").pop()?.trim() || parsed.hostname || trimmed;
    }
  } catch {}
  return trimmed.split(/[\\/]/).pop()?.trim() || trimmed;
}

function extractTranscriptMediaEntries(message: unknown): Array<{
  path: string;
  mediaType: unknown;
}> {
  const m = message as Record<string, unknown>;
  const transcriptMediaPaths = Array.isArray(m.MediaPaths)
    ? m.MediaPaths.filter((value): value is string => typeof value === "string")
    : typeof m.MediaPath === "string"
      ? [m.MediaPath]
      : [];
  const transcriptMediaTypes = Array.isArray(m.MediaTypes)
    ? m.MediaTypes
    : typeof m.MediaType === "string"
      ? [m.MediaType]
      : [];
  return transcriptMediaPaths.map((mediaPath, index) => ({
    path: mediaPath,
    mediaType: transcriptMediaTypes[index],
  }));
}

function extractImages(message: unknown): ImageBlock[] {
  const m = message as Record<string, unknown>;
  const content = m.content;
  const images: ImageBlock[] = [];

  if (Array.isArray(content)) {
    for (const block of content) {
      if (typeof block !== "object" || block === null) {
        continue;
      }
      const b = block as Record<string, unknown>;

      if (b.type === "image") {
        // Handle source object format from optimistic user sends.
        const source = b.source as Record<string, unknown> | undefined;
        const imageMeta = {
          alt: typeof b.alt === "string" ? b.alt : undefined,
          openUrl: typeof b.openUrl === "string" ? b.openUrl : undefined,
          width: typeof b.width === "number" ? b.width : undefined,
          height: typeof b.height === "number" ? b.height : undefined,
        };
        if (source?.type === "base64" && typeof source.data === "string") {
          appendImageBlock(images, {
            url: buildBase64ImageUrl({
              data: source.data,
              mediaType: typeof source.media_type === "string" ? source.media_type : undefined,
            }),
            ...imageMeta,
          });
        } else if (typeof b.data === "string") {
          // Direct tool-result image block from imageResult() / read tool.
          appendImageBlock(images, {
            url: buildBase64ImageUrl({
              data: b.data,
              mediaType: typeof b.mimeType === "string" ? b.mimeType : undefined,
            }),
            ...imageMeta,
          });
        } else if (typeof b.url === "string") {
          appendImageBlock(images, { url: b.url, ...imageMeta });
        }
      } else if (b.type === "image_url") {
        // OpenAI format
        const imageUrl = b.image_url as Record<string, unknown> | undefined;
        if (typeof imageUrl?.url === "string") {
          appendImageBlock(images, { url: imageUrl.url });
        }
      } else if (b.type === "input_image") {
        const imageUrl = b.image_url;
        if (typeof imageUrl === "string") {
          appendImageBlock(images, { url: imageUrl });
        } else if (imageUrl && typeof imageUrl === "object") {
          const url = (imageUrl as Record<string, unknown>).url;
          if (typeof url === "string") {
            appendImageBlock(images, { url });
          }
        }
        const source = b.source as Record<string, unknown> | undefined;
        if (typeof source?.url === "string") {
          appendImageBlock(images, { url: source.url });
        } else if (typeof source?.data === "string") {
          appendImageBlock(images, {
            url: buildBase64ImageUrl({
              data: source.data,
              mediaType: typeof source.media_type === "string" ? source.media_type : undefined,
            }),
          });
        }
      } else if (b.type === "openclaw_pairing_qr") {
        if (isExpiredPairingQrBlock(b)) {
          continue;
        }
        const imageUrl = b.image_url;
        if (typeof imageUrl === "string") {
          appendImageBlock(images, {
            url: imageUrl,
            alt: typeof b.alt === "string" ? b.alt : undefined,
          });
        }
      }
    }
  }

  for (const { path: mediaPath, mediaType } of extractTranscriptMediaEntries(message)) {
    if (!isImageTranscriptMediaPath(mediaPath, mediaType)) {
      continue;
    }
    appendImageBlock(images, { url: mediaPath });
  }

  return images;
}

function readPairingQrExpiresAtMs(block: Record<string, unknown>): number | undefined {
  const expiresAtMs = block.expiresAtMs;
  return typeof expiresAtMs === "number" && Number.isFinite(expiresAtMs) ? expiresAtMs : undefined;
}

function isExpiredPairingQrBlock(block: Record<string, unknown>, nowMs = Date.now()): boolean {
  const expiresAtMs = readPairingQrExpiresAtMs(block);
  return expiresAtMs !== undefined && expiresAtMs <= nowMs;
}

function extractPairingQrExpiryNotices(
  message: unknown,
  nowMs = Date.now(),
): PairingQrExpiryNotice[] {
  const m = message as Record<string, unknown>;
  const content = m.content;
  if (!Array.isArray(content)) {
    return [];
  }
  const notices: PairingQrExpiryNotice[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const b = block as Record<string, unknown>;
    if (b.type === "openclaw_pairing_qr" && isExpiredPairingQrBlock(b, nowMs)) {
      notices.push({
        title: t("chat.pairingQrExpired.title"),
        reason: t("chat.pairingQrExpired.reason"),
      });
    }
  }
  return notices;
}

function resolveNearestFuturePairingQrExpiresAtMs(
  message: unknown,
  nowMs = Date.now(),
): number | undefined {
  const m = message as Record<string, unknown>;
  const content = m.content;
  if (!Array.isArray(content)) {
    return undefined;
  }
  let nearestExpiresAtMs: number | undefined;
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const b = block as Record<string, unknown>;
    if (b.type !== "openclaw_pairing_qr") {
      continue;
    }
    const expiresAtMs = readPairingQrExpiresAtMs(b);
    if (expiresAtMs === undefined || expiresAtMs <= nowMs) {
      continue;
    }
    nearestExpiresAtMs =
      nearestExpiresAtMs === undefined ? expiresAtMs : Math.min(nearestExpiresAtMs, expiresAtMs);
  }
  return nearestExpiresAtMs;
}

function clearPairingQrExpiryRefreshTimer(messageKey: string) {
  const existing = pairingQrExpiryRefreshTimers.get(messageKey);
  if (!existing) {
    return;
  }
  clearTimeout(existing.timer);
  pairingQrExpiryRefreshTimers.delete(messageKey);
}

function schedulePairingQrExpiryRefresh(
  messageKey: string,
  message: unknown,
  onRequestUpdate: (() => void) | undefined,
) {
  const nowMs = Date.now();
  const expiresAtMs = resolveNearestFuturePairingQrExpiresAtMs(message, nowMs);
  const existing = pairingQrExpiryRefreshTimers.get(messageKey);
  if (!expiresAtMs || !onRequestUpdate) {
    if (existing) {
      clearPairingQrExpiryRefreshTimer(messageKey);
    }
    return;
  }
  if (existing?.expiresAtMs === expiresAtMs && existing.onRequestUpdate === onRequestUpdate) {
    return;
  }
  clearPairingQrExpiryRefreshTimer(messageKey);
  const timer = setTimeout(
    () => {
      pairingQrExpiryRefreshTimers.delete(messageKey);
      onRequestUpdate();
    },
    Math.max(0, expiresAtMs - nowMs),
  );
  pairingQrExpiryRefreshTimers.set(messageKey, { expiresAtMs, onRequestUpdate, timer });
}

function extractTranscriptAttachments(message: unknown): AttachmentItem[] {
  const attachments: AttachmentItem[] = [];
  for (const { path: mediaPath, mediaType } of extractTranscriptMediaEntries(message)) {
    if (isImageTranscriptMediaPath(mediaPath, mediaType)) {
      continue;
    }
    const kind = isAudioTranscriptMediaPath(mediaPath, mediaType)
      ? "audio"
      : isVideoTranscriptMediaPath(mediaPath, mediaType)
        ? "video"
        : "document";
    attachments.push({
      type: "attachment",
      attachment: {
        url: mediaPath,
        kind,
        label: labelForMediaPath(mediaPath),
        ...(typeof mediaType === "string" ? { mimeType: mediaType } : {}),
      },
    });
  }
  return attachments;
}

/** A contiguous run of in-flight streaming items rendered under one assistant group. */
type StreamGroupPart = Extract<
  ChatItem,
  { kind: "stream" } | { kind: "reading-indicator" } | { kind: "question" } | { kind: "plan" }
>;

type StreamGroupOptions = {
  onOpenSidebar?: (content: SidebarContent) => void;
  assistant?: AssistantIdentity;
  basePath?: string;
  authToken?: string | null;
  planStatus?: PlanStatus | null;
  planActive?: boolean;
  startupPhase?: ChatRunStartupPhase;
  waitingApproval?: boolean;
  runOutputTokens?: number | null;
  questionPrompts?: ReadonlyMap<string, QuestionPrompt>;
};

function renderQuestionStreamPart(
  part: Extract<StreamGroupPart, { kind: "question" }>,
  opts: StreamGroupOptions,
) {
  const prompt = opts.questionPrompts?.get(part.questionId);
  return prompt ? renderChatQuestionSummary(prompt) : nothing;
}

// One assistant group per contiguous run of streaming items: a reply that
// arrives as several stream segments renders under a single avatar/footer
// instead of flashing a separate avatar+bubble per segment (#63956).
export function renderStreamGroup(parts: StreamGroupPart[], opts: StreamGroupOptions = {}) {
  const { onOpenSidebar, assistant, basePath, authToken } = opts;
  const name = assistant?.name ?? "Assistant";
  // Footer (sender + time) anchors to the earliest streamed segment; a run that
  // is only the reading indicator has no timestamp and therefore no footer.
  const streamStarts = parts.flatMap((part) => (part.kind === "stream" ? [part.startedAt] : []));
  const footerStartedAt = streamStarts.length > 0 ? Math.min(...streamStarts) : null;
  // While the agent works with nothing streamed yet the run is pure claw: no
  // avatar next to it - the punching pincer is the whole signal. The avatar
  // arrives with the first stream part.
  const workingOnly = parts.every((part) => part.kind !== "stream");
  const avatar = workingOnly
    ? nothing
    : renderChatAvatar("assistant", assistant, undefined, basePath, authToken);
  const groupClass = `chat-group assistant${workingOnly ? " chat-group--working" : ""}${footerStartedAt !== null ? " chat-group--with-footer" : ""}`;

  return html`
    <div class=${groupClass} data-chat-row-key=${parts[0]?.key ?? nothing}>
      ${avatar}
      <div class="chat-group-messages">
        ${parts.map((part) =>
          part.kind === "reading-indicator"
            ? renderChatWorkingIndicator(
                part,
                opts.waitingApproval === true,
                opts.startupPhase,
                opts.runOutputTokens,
              )
            : part.kind === "question"
              ? renderQuestionStreamPart(part, opts)
              : part.kind === "plan"
                ? renderChatPlanChecklist(opts.planStatus, {
                    active: opts.planActive === true,
                    variant: "card",
                  })
                : renderGroupedMessage(
                    {
                      role: "assistant",
                      content: [{ type: "text", text: part.text }],
                      timestamp: part.startedAt,
                    },
                    part.key,
                    { isStreaming: part.isStreaming, showReasoning: false },
                    onOpenSidebar,
                  ),
        )}
      </div>
      ${footerStartedAt !== null
        ? html`
            <div class="chat-group-footer">
              <div class="chat-group-footer__meta">
                <span class="chat-sender-name">${name}</span>
                ${renderChatTimestamp(footerStartedAt)}
              </div>
            </div>
          `
        : nothing}
    </div>
  `;
}

/**
 * Collapsed-turn rollup header: one slim "Worked for X" disclosure standing in
 * for the turn's intermediate work once the run is done. The check/x icon is
 * the turn's done indicator; the expanded groups render after this row.
 */
export function renderWorkGroupSummary(
  item: { key: string; durationMs: number | null; hasError: boolean },
  opts: { expanded: boolean; onToggle: () => void },
) {
  const duration = formatDurationCompact(item.durationMs, { spaced: true });
  const label = duration ? t("chat.workRun.workedFor", { duration }) : t("chat.workRun.worked");
  return html`
    <div class="chat-group tool chat-group--work" data-chat-row-key=${item.key}>
      <span class="chat-work-group__gutter" aria-hidden="true"></span>
      <div class="chat-group-messages">
        <div class="chat-activity-group chat-work-group ${opts.expanded ? "is-open" : ""}">
          <button
            class="chat-activity-group__summary ${item.hasError
              ? "chat-activity-group__summary--error"
              : ""}"
            type="button"
            aria-expanded=${String(opts.expanded)}
            aria-label=${item.hasError
              ? duration
                ? t("chat.workRun.workedForError", { duration })
                : t("chat.workRun.workedError")
              : nothing}
            @click=${(event: MouseEvent) => {
              if (shouldToggleSelectableDisclosure(event)) {
                opts.onToggle();
              }
            }}
          >
            <span class="chat-activity-group__icon">
              ${item.hasError ? icons.x : icons.check}
            </span>
            <span class="chat-activity-group__label" title=${label}>${label}</span>
            <span
              class="collapse-chevron ${opts.expanded ? "" : "collapse-chevron--collapsed"}"
              aria-hidden="true"
              >${icons.chevronDown}</span
            >
          </button>
        </div>
      </div>
    </div>
  `;
}

type RenderMessageGroupOptions = {
  onOpenSidebar?: (content: SidebarContent) => void;
  onOpenWorkspaceFile?: (target: { path: string; line?: number | null }) => void;
  sessionKey?: string;
  boardProvider?: BoardProvider;
  agentId?: string;
  showReasoning: boolean;
  showToolCalls?: boolean;
  runActive?: boolean;
  autoExpandToolCalls?: boolean;
  isToolMessageExpanded?: (messageId: string) => boolean | undefined;
  onToggleToolMessageExpanded?: (messageId: string, expanded?: boolean) => void;
  isUserMessageExpanded?: (messageId: string) => boolean;
  onToggleUserMessageExpanded?: (messageId: string) => void;
  isToolExpanded?: (toolCardId: string) => boolean;
  onToggleToolExpanded?: (toolCardId: string) => void;
  onRequestUpdate?: () => void;
  onAssistantAttachmentLoaded?: () => void;
  onRequestOpenImage?: () => number;
  onOpenImage?: (item: ImageLightboxItem, requestVersion?: number) => void;
  assistantName?: string;
  assistantAvatar?: string | null;
  userId?: string | null;
  userName?: string | null;
  userAvatar?: string | null;
  showAvatarGutter?: boolean;
  basePath?: string;
  localMediaPreviewRoots?: readonly string[];
  assistantAttachmentAuthToken?: string | null;
  canvasPluginSurfaceUrl?: string | null;
  embedSandboxMode?: EmbedSandboxMode;
  allowExternalEmbedUrls?: boolean;
  contextWindow?: number | null;
  onDelete?: () => void;
  onReply?: (target: MessageReplyTarget) => void;
  onRewind?: () => void;
  rewindDisabled?: boolean;
};

export type MessageReplyTarget = {
  messageId: string;
  text: string;
  senderLabel?: string | null;
  sourceMessageId?: string | null;
};

type GroupedMessageRenderOptions = Parameters<typeof renderGroupedMessage>[2];

function buildGroupedMessageRenderOptions(
  group: MessageGroup,
  item: MessageGroup["messages"][number],
  index: number,
  opts: RenderMessageGroupOptions,
): GroupedMessageRenderOptions {
  return {
    isStreaming: group.isStreaming && index === group.messages.length - 1,
    sessionKey: opts.sessionKey,
    boardProvider: opts.boardProvider,
    agentId: opts.agentId,
    entryId: persistedMessageEntryId(item.message) ?? undefined,
    entryAnimated:
      normalizeRoleForGrouping(group.role) === "user" &&
      shouldAnimateUserTurnEntry(item.key, item.message),
    onOpenWorkspaceFile: opts.onOpenWorkspaceFile,
    duplicateCount: item.duplicateCount ?? 1,
    showReasoning: opts.showReasoning,
    showToolCalls: opts.showToolCalls ?? true,
    runActive: opts.runActive,
    turnSucceeded: group.turnSucceeded,
    autoExpandToolCalls: opts.autoExpandToolCalls ?? false,
    isToolMessageExpanded: opts.isToolMessageExpanded,
    onToggleToolMessageExpanded: opts.onToggleToolMessageExpanded,
    isUserMessageExpanded: opts.isUserMessageExpanded,
    onToggleUserMessageExpanded: opts.onToggleUserMessageExpanded,
    isToolExpanded: opts.isToolExpanded,
    onToggleToolExpanded: opts.onToggleToolExpanded,
    onRequestUpdate: opts.onRequestUpdate,
    onAssistantAttachmentLoaded: opts.onAssistantAttachmentLoaded,
    onRequestOpenImage: opts.onRequestOpenImage,
    onOpenImage: opts.onOpenImage,
    canvasPluginSurfaceUrl: opts.canvasPluginSurfaceUrl,
    basePath: opts.basePath,
    localMediaPreviewRoots: opts.localMediaPreviewRoots,
    assistantAttachmentAuthToken: opts.assistantAttachmentAuthToken,
    embedSandboxMode: opts.embedSandboxMode,
    allowExternalEmbedUrls: opts.allowExternalEmbedUrls,
  };
}

/** One-shot entry animation state for submitted user turns, keyed by message
 * key (send identity). An entry records first sight for the send's lifetime —
 * value is the animation start, or 0 for seen-without-animating — so
 * re-renders during the animation keep the class while later renders or
 * virtualizer remounts of the same (possibly still pending) row never replay
 * it. Insertion-ordered cap bounds the map instead of time-based pruning,
 * which would forget long-lived pending rows; keys are per-send UUIDs, so the
 * map is never reset across panes or sessions. */
const userTurnEntrySeenByMessageKey = new Map<string, number>();
const USER_TURN_ENTRY_ANIMATION_WINDOW_MS = 400;
/** Only just-submitted bubbles animate; restored outbox rows render still.
 * Accepted tradeoff: a full page reload within this window re-animates the
 * just-submitted bubble once, which matches the fresh paint around it. */
const USER_TURN_ENTRY_FRESH_SUBMIT_MS = 2_000;
const USER_TURN_ENTRY_SEEN_CAP = 256;

function isPeerSenderGroup(group: MessageGroup, userId: string | null | undefined): boolean {
  return Boolean(group.sender && !(userId && group.sender.id === userId));
}

function shouldAnimateUserTurnEntry(messageKey: string, message: unknown): boolean {
  const now = Date.now();
  const seen = userTurnEntrySeenByMessageKey.get(messageKey);
  if (seen !== undefined) {
    return seen > 0 && now - seen < USER_TURN_ENTRY_ANIMATION_WINDOW_MS;
  }
  // Only a locally pending submit starts the animation; loaded history and
  // remote echoes render without one.
  if (!isPendingSendMessage(message)) {
    return false;
  }
  const submittedAt = (message as { timestamp?: unknown }).timestamp;
  const freshSubmit =
    typeof submittedAt === "number" && now - submittedAt < USER_TURN_ENTRY_FRESH_SUBMIT_MS;
  while (userTurnEntrySeenByMessageKey.size >= USER_TURN_ENTRY_SEEN_CAP) {
    const oldest = userTurnEntrySeenByMessageKey.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    userTurnEntrySeenByMessageKey.delete(oldest);
  }
  userTurnEntrySeenByMessageKey.set(messageKey, freshSubmit ? now : 0);
  return freshSubmit;
}

export function renderMessageGroup(group: MessageGroup, opts: RenderMessageGroupOptions) {
  const normalizedRole = normalizeRoleForGrouping(group.role);
  const isWorkspaceConflict = group.messages.every((item) =>
    Boolean(workspaceResultConflictFromTranscript(item.message)),
  );
  const assistantName = opts.assistantName ?? "Assistant";
  const resolvedUserName = resolveLocalUserName({
    name: opts.userName ?? null,
    avatar: opts.userAvatar ?? null,
  });
  const userLabel = group.senderLabel?.trim();
  const isPeerGroup = normalizedRole === "user" && isPeerSenderGroup(group, opts.userId);
  const isCurrentUser = normalizedRole === "user" && Boolean(group.sender) && !isPeerGroup;
  const who =
    normalizedRole === "user"
      ? isCurrentUser
        ? resolvedUserName
        : (userLabel ?? resolvedUserName)
      : normalizedRole === "assistant"
        ? (userLabel ?? assistantName)
        : normalizedRole === "tool"
          ? "Tool"
          : isWorkspaceConflict
            ? t("chat.workspaceConflict.eventSender")
            : normalizedRole;
  const showAvatarGutter = opts.showAvatarGutter !== false;
  const persistUserIdentity = normalizedRole === "user" && showAvatarGutter;
  const roleClass =
    normalizedRole === "user"
      ? "user"
      : normalizedRole === "assistant"
        ? "assistant"
        : normalizedRole === "tool"
          ? "tool"
          : isWorkspaceConflict
            ? "workspace-conflict"
            : "other";

  // Aggregate usage/cost/model across all messages in the group
  const meta = extractGroupMeta(group, opts.contextWindow ?? null);

  if (normalizedRole === "tool" && opts.showToolCalls === false) {
    return nothing;
  }

  const groupedToolCards =
    normalizedRole === "tool"
      ? group.messages.flatMap((item) => extractToolCardsCached(item.message, item.key))
      : [];

  if (normalizedRole === "tool" && (group.messages.length > 1 || groupedToolCards.length > 1)) {
    const cards = groupedToolCards;
    const toolCount = cards.length || group.messages.length;
    const hasError = cards.some(isToolCardError) && group.turnSucceeded !== true;
    // While a run is live, the newest still-running call names the group so
    // the collapsed header reads like a status line; afterwards it aggregates.
    const runningCard = opts.runActive
      ? cards.findLast((card) => isRunningToolCard(card, opts.runActive))
      : undefined;
    const groupSummaryLabel = runningCard
      ? `${resolveToolRowText(runningCard, opts.runActive)}…`
      : summarizeToolGroup(
          cards.map((card) => ({
            name: card.name,
            args: card.args,
            isError: isToolCardError(card),
          })),
        );
    const activityDisclosureId = `activity:${group.key}`;
    const activityExpanded = opts.isToolMessageExpanded?.(activityDisclosureId) ?? hasError;

    return html`
      <div
        class="chat-group tool chat-group--activity chat-group--with-footer"
        data-chat-row-key=${group.key}
      >
        ${showAvatarGutter
          ? renderChatAvatar(
              group.role,
              {
                name: assistantName,
                avatar: opts.assistantAvatar ?? null,
              },
              {
                name: opts.userName ?? null,
                avatar: opts.userAvatar ?? null,
              },
              opts.basePath,
              opts.assistantAttachmentAuthToken,
              group.sender,
            )
          : nothing}
        <div class="chat-group-messages">
          <div class="chat-activity-group ${activityExpanded ? "is-open" : ""}">
            <button
              class="chat-activity-group__summary ${hasError
                ? "chat-activity-group__summary--error"
                : ""}"
              type="button"
              aria-expanded=${String(activityExpanded)}
              aria-label=${hasError
                ? t(
                    toolCount === 1
                      ? "chat.toolCards.group.activityErrorOne"
                      : "chat.toolCards.group.activityErrorMany",
                    { count: String(toolCount) },
                  )
                : nothing}
              @click=${(event: MouseEvent) => {
                if (shouldToggleSelectableDisclosure(event)) {
                  opts.onToggleToolMessageExpanded?.(activityDisclosureId, activityExpanded);
                }
              }}
            >
              <span class="chat-activity-group__icon">${hasError ? icons.x : icons.activity}</span>
              <span class="chat-activity-group__label" title=${groupSummaryLabel}
                >${groupSummaryLabel}</span
              >
              <span
                class="collapse-chevron ${activityExpanded ? "" : "collapse-chevron--collapsed"}"
                aria-hidden="true"
                >${icons.chevronDown}</span
              >
            </button>
            ${activityExpanded
              ? html`
                  <div class="chat-activity-group__body">
                    ${group.messages.map((item, index) =>
                      renderGroupedMessage(
                        item.message,
                        item.key,
                        buildGroupedMessageRenderOptions(group, item, index, opts),
                        opts.onOpenSidebar,
                      ),
                    )}
                  </div>
                `
              : nothing}
          </div>
        </div>
        <div class="chat-group-footer">
          <span class="chat-sender-name">${t("chat.messages.activity")}</span>
          ${renderChatTimestamp(group.timestamp)}
          ${opts.onDelete ? renderDeleteButton(opts.onDelete, "right") : nothing}
        </div>
      </div>
    `;
  }

  const messageActionDetails = group.messages.map((item) =>
    resolveMessageActionDetails({
      message: item.message,
      messageId: item.key,
      onOpenSidebar: opts.onOpenSidebar,
      onReply: opts.onReply,
      senderLabel: who,
    }),
  );
  const lastMessageIndex = group.messages.length - 1;
  const footerActionDetails = messageActionDetails[lastMessageIndex] ?? null;
  const hasUserFooterActions =
    normalizedRole === "user" &&
    Boolean((footerActionDetails?.replyTarget && opts.onReply) || opts.onDelete || opts.onRewind);

  // Attributed (logged-in) senders tint their bubbles with the same stable
  // identity hue as their avatar initials; CSS owns per-theme lightness so
  // the tint stays readable in both light and dark modes. Unattributed local
  // messages keep the accent skin.
  const senderHue =
    normalizedRole === "user" && group.sender ? resolveIdentityHue(group.sender) : null;
  const replyToLabel =
    normalizedRole === "assistant" ? formatSenderLabel(group.replyToSender) : null;
  const replyToTitle = replyToLabel ? t("chat.messages.replyingTo", { name: replyToLabel }) : null;

  return html`
    <div
      class="chat-group ${roleClass} chat-group--with-footer${isPeerGroup
        ? " chat-group--peer"
        : ""}${senderHue === null ? "" : " chat-group--sender-tint"}"
      style=${senderHue === null ? nothing : `--chat-sender-hue: ${senderHue}`}
      data-chat-row-key=${group.key}
    >
      ${showAvatarGutter
        ? renderChatAvatar(
            group.role,
            {
              name: assistantName,
              avatar: opts.assistantAvatar ?? null,
            },
            {
              name: opts.userName ?? null,
              avatar: opts.userAvatar ?? null,
            },
            opts.basePath,
            opts.assistantAttachmentAuthToken,
            group.sender,
          )
        : nothing}
      <div class="chat-group-messages">
        ${replyToLabel
          ? html`
              <div class="chat-reply-attribution" title=${replyToTitle} aria-label=${replyToTitle}>
                <span class="chat-reply-attribution__icon" aria-hidden="true"
                  >${icons.cornerDownLeft}</span
                >
                <span>${replyToLabel}</span>
              </div>
            `
          : nothing}
        ${group.messages.map((item, index) => {
          const actionDetails = messageActionDetails[index];
          return html`
            ${renderGroupedMessage(
              item.message,
              item.key,
              buildGroupedMessageRenderOptions(group, item, index, opts),
              opts.onOpenSidebar,
            )}
            ${actionDetails && index < lastMessageIndex
              ? html`
                  <div class="chat-message-actions-row" data-message-actions-for=${item.key}>
                    ${renderMessageActionButtons(actionDetails, opts, opts.onOpenSidebar)}
                  </div>
                `
              : nothing}
          `;
        })}
      </div>
      <div
        class="chat-group-footer ${persistUserIdentity
          ? "chat-group-footer--persistent-identity"
          : ""}"
      >
        <div class="chat-group-footer__meta">
          ${hasUserFooterActions
            ? html`
                <div
                  class="chat-group-footer-actions"
                  data-message-actions-for=${group.messages[lastMessageIndex]?.key ?? nothing}
                >
                  ${footerActionDetails?.replyTarget && opts.onReply
                    ? renderReplyButton(footerActionDetails.replyTarget, opts.onReply)
                    : nothing}
                  ${opts.onDelete ? renderDeleteButton(opts.onDelete, "left") : nothing}
                  ${opts.onRewind
                    ? renderRewindButton(opts.onRewind, Boolean(opts.rewindDisabled), "left")
                    : nothing}
                </div>
              `
            : nothing}
          ${normalizedRole === "user" && !showAvatarGutter
            ? renderChatAuthorAvatar(group.sender)
            : nothing}
          <span class="chat-sender-name">${who}</span>
          ${renderMessageMeta(group.timestamp, meta)}
        </div>
        ${normalizedRole !== "user" && (footerActionDetails || opts.onDelete)
          ? html`
              <div
                class="chat-group-footer-actions"
                data-message-actions-for=${group.messages[lastMessageIndex]?.key ?? nothing}
              >
                ${footerActionDetails
                  ? renderMessageActionButtons(
                      footerActionDetails,
                      opts,
                      opts.onOpenSidebar,
                      normalizedRole !== "user" ? opts.onDelete : undefined,
                    )
                  : opts.onDelete
                    ? renderDeleteButton(opts.onDelete, "right")
                    : nothing}
              </div>
            `
          : nothing}
      </div>
    </div>
  `;
}

// ── Per-message metadata (tokens, cost, model, context %) ──

type GroupMeta = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  model: string | null;
  contextPercent: number | null;
};

function extractGroupMeta(group: MessageGroup, contextWindow: number | null): GroupMeta | null {
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let cost = 0;
  let model: string | null = null;
  let hasUsage = false;
  let maxPromptTokens = 0;

  for (const { message } of group.messages) {
    const m = message as Record<string, unknown>;
    if (m.role !== "assistant") {
      continue;
    }
    const usage = m.usage as Record<string, number> | undefined;
    if (usage) {
      hasUsage = true;
      const callInput = usage.input ?? usage.inputTokens ?? 0;
      const callOutput = usage.output ?? usage.outputTokens ?? 0;
      const callCacheRead = usage.cacheRead ?? usage.cache_read_input_tokens ?? 0;
      const callCacheWrite = usage.cacheWrite ?? usage.cache_creation_input_tokens ?? 0;
      input += callInput;
      output += callOutput;
      cacheRead += callCacheRead;
      cacheWrite += callCacheWrite;
      maxPromptTokens = Math.max(maxPromptTokens, callInput + callCacheRead + callCacheWrite);
    }
    const c = m.cost as Record<string, number> | undefined;
    if (c?.total) {
      cost += c.total;
    }
    if (typeof m.model === "string" && m.model !== "gateway-injected") {
      model = m.model;
    }
  }

  if (!hasUsage && !model) {
    return null;
  }

  const contextPercent =
    contextWindow && maxPromptTokens > 0
      ? Math.min(Math.round((maxPromptTokens / contextWindow) * 100), 100)
      : null;

  return { input, output, cacheRead, cacheWrite, cost, model, contextPercent };
}

function renderMessageMeta(timestamp: number, meta: GroupMeta | null) {
  if (!meta) {
    return renderChatTimestamp(timestamp);
  }

  const parts: Array<ReturnType<typeof html>> = [];

  // Token counts: ↑input ↓output
  if (meta.input) {
    parts.push(html`<span class="msg-meta__tokens">↑${formatCompactTokenCount(meta.input)}</span>`);
  }
  if (meta.output) {
    parts.push(
      html`<span class="msg-meta__tokens">↓${formatCompactTokenCount(meta.output)}</span>`,
    );
  }

  // Cache: R/W
  if (meta.cacheRead) {
    parts.push(
      html`<span class="msg-meta__cache">R${formatCompactTokenCount(meta.cacheRead)}</span>`,
    );
  }
  if (meta.cacheWrite) {
    parts.push(
      html`<span class="msg-meta__cache">W${formatCompactTokenCount(meta.cacheWrite)}</span>`,
    );
  }

  // Cost
  if (meta.cost > 0) {
    parts.push(html`<span class="msg-meta__cost">$${meta.cost.toFixed(4)}</span>`);
  }

  // Context %
  if (meta.contextPercent !== null) {
    const pct = meta.contextPercent;
    const cls =
      pct >= 90
        ? "msg-meta__ctx msg-meta__ctx--danger"
        : pct >= 75
          ? "msg-meta__ctx msg-meta__ctx--warn"
          : "msg-meta__ctx";
    parts.push(html`<span class="${cls}">${pct}% ctx</span>`);
  }

  // Model
  if (meta.model) {
    // Shorten model name: strip provider prefix if present (e.g. "anthropic/claude-3.5-sonnet" → "claude-3.5-sonnet")
    const shortModel = meta.model.includes("/") ? meta.model.split("/").pop()! : meta.model;
    parts.push(html`<span class="msg-meta__model">${shortModel}</span>`);
  }

  if (parts.length === 0) {
    return renderChatTimestamp(timestamp);
  }

  const display = formatChatTimestampForDisplay(timestamp);
  // Absolute time leads the popover; the summary label itself stays relative.
  parts.unshift(html`<span class="msg-meta__time">${display.label}</span>`);

  return html`
    <details
      class="msg-meta"
      @pointerenter=${previewMessageMeta}
      @pointerleave=${closeMessageMetaPreview}
      @focusin=${previewMessageMeta}
      @focusout=${closeMessageMetaPreview}
    >
      <summary
        class="msg-meta__summary"
        aria-label=${`Message context for ${display.title}`}
        @click=${pinMessageMetaPreview}
      >
        ${renderChatTimestamp(timestamp, true)}
      </summary>
      <span class="msg-meta__details">${parts}</span>
    </details>
  `;
}

const SKIP_DELETE_CONFIRM_PREFERENCE = "openclaw:skipDeleteConfirm";
const SKIP_REWIND_CONFIRM_PREFERENCE = "openclaw:skip-rewind-confirm";
const DELETE_CONFIRM_VIEWPORT_MARGIN_PX = 8;
const DELETE_CONFIRM_TRIGGER_GAP_PX = 6;

type DeleteConfirmSide = "left" | "right";
type DeleteConfirmDismissOptions = { restoreFocus?: boolean };
type DeleteConfirmDismisser = (options?: DeleteConfirmDismissOptions) => void;

const deleteConfirmDismissers = new WeakMap<Element, DeleteConfirmDismisser>();

function shouldSkipActionConfirm(preferenceName: string): boolean {
  try {
    return getSafeLocalStorage()?.getItem(preferenceName) === "1";
  } catch {
    return false;
  }
}

function dismissDeleteConfirm(element: Element, options?: DeleteConfirmDismissOptions) {
  const dismiss = deleteConfirmDismissers.get(element);
  if (dismiss) {
    dismiss(options);
    return;
  }
  element.remove();
}

export function dismissConfirmedActionPopovers(owner: ParentNode): void {
  owner.querySelectorAll(".chat-delete-confirm").forEach((popover) => {
    dismissDeleteConfirm(popover);
  });
}

function resolveViewportBounds() {
  const viewport = window.visualViewport;
  const left = viewport?.offsetLeft ?? 0;
  const top = viewport?.offsetTop ?? 0;
  const width = viewport?.width ?? window.innerWidth ?? document.documentElement.clientWidth;
  const height = viewport?.height ?? window.innerHeight ?? document.documentElement.clientHeight;

  return {
    bottom: top + height,
    left,
    right: left + width,
    top,
  };
}

function clampDeleteConfirmPosition(value: number, min: number, max: number) {
  if (max < min) {
    return min;
  }
  return Math.min(Math.max(value, min), max);
}

function placeDeleteConfirmPopover(
  trigger: HTMLElement,
  popover: HTMLElement,
  side: DeleteConfirmSide,
) {
  const triggerRect = trigger.getBoundingClientRect();
  const popoverRect = popover.getBoundingClientRect();
  const viewport = resolveViewportBounds();
  const margin = DELETE_CONFIRM_VIEWPORT_MARGIN_PX;
  const gap = DELETE_CONFIRM_TRIGGER_GAP_PX;
  const viewportWidth = viewport.right - viewport.left;
  const viewportHeight = viewport.bottom - viewport.top;
  const popoverWidth = Math.min(popoverRect.width, viewportWidth - margin * 2);
  const popoverHeight = Math.min(popoverRect.height, viewportHeight - margin * 2);
  const spaceAbove = triggerRect.top - viewport.top - margin - gap;
  const spaceBelow = viewport.bottom - triggerRect.bottom - margin - gap;
  const placeBelow = spaceAbove < popoverHeight && spaceBelow >= spaceAbove;
  const desiredLeft = side === "left" ? triggerRect.right - popoverWidth : triggerRect.left;
  const left = clampDeleteConfirmPosition(
    desiredLeft,
    viewport.left + margin,
    viewport.right - margin - popoverWidth,
  );
  const desiredTop = placeBelow ? triggerRect.bottom + gap : triggerRect.top - gap - popoverHeight;
  const top = clampDeleteConfirmPosition(
    desiredTop,
    viewport.top + margin,
    viewport.bottom - margin - popoverHeight,
  );

  popover.style.left = `${Math.round(left)}px`;
  popover.style.top = `${Math.round(top)}px`;
  popover.dataset.placement = placeBelow ? "below" : "above";
}

function renderDeleteButton(onDelete: () => void, side: DeleteConfirmSide) {
  // "Hide" is honest copy: this action only hides the bubble in this browser's
  // localStorage; the message stays in the transcript and in agent context.
  return renderConfirmedActionButton({
    action: onDelete,
    ariaLabel: t("chat.messages.hideMessage"),
    buttonClass: "chat-group-delete",
    confirmLabel: t("chat.messages.hide"),
    confirmText: t("chat.messages.hideConfirm"),
    icon: icons.eyeOff ?? icons.x,
    preferenceName: SKIP_DELETE_CONFIRM_PREFERENCE,
    side,
    tooltip: t("chat.messages.hideTooltip"),
  });
}

function renderRewindButton(onRewind: () => void, disabled: boolean, side: DeleteConfirmSide) {
  return renderConfirmedActionButton({
    action: onRewind,
    ariaLabel: t("chat.messages.rewind"),
    buttonClass: "chat-group-rewind",
    confirmLabel: t("chat.messages.rewind"),
    confirmText: t("chat.messages.rewindConfirm"),
    disabled,
    icon: icons.refresh,
    preferenceName: SKIP_REWIND_CONFIRM_PREFERENCE,
    side,
    tooltip: disabled ? t("chat.messages.rewindUnavailable") : t("chat.messages.rewind"),
    wrapClass: "chat-rewind-wrap",
  });
}

type ConfirmedActionParams = {
  action: () => void;
  ariaLabel: string;
  buttonClass?: string;
  confirmLabel: string;
  confirmText: string;
  disabled?: boolean;
  icon: unknown;
  preferenceName: string;
  side: DeleteConfirmSide;
  tooltip: string;
  wrapClass?: string;
};

export function openChatRewindConfirmation(trigger: HTMLElement, action: () => void): void {
  openConfirmedActionPopover(trigger, {
    action,
    confirmLabel: t("chat.messages.rewind"),
    confirmText: t("chat.messages.rewindConfirm"),
    preferenceName: SKIP_REWIND_CONFIRM_PREFERENCE,
    side: "left",
  });
}

export function openChatHideConfirmation(trigger: HTMLElement, action: () => void): void {
  openConfirmedActionPopover(trigger, {
    action,
    confirmLabel: t("chat.messages.hide"),
    confirmText: t("chat.messages.hideConfirm"),
    preferenceName: SKIP_DELETE_CONFIRM_PREFERENCE,
    side: "right",
  });
}

function openConfirmedActionPopover(
  btn: HTMLElement,
  params: Pick<
    ConfirmedActionParams,
    "action" | "confirmLabel" | "confirmText" | "preferenceName" | "side"
  >,
): void {
  if (shouldSkipActionConfirm(params.preferenceName)) {
    params.action();
    return;
  }
  const wrap = btn.closest(".chat-delete-wrap") as HTMLElement | null;
  if (!wrap) {
    return;
  }
  const existing = wrap.querySelector(".chat-delete-confirm");
  if (existing) {
    dismissDeleteConfirm(existing, { restoreFocus: true });
    return;
  }
  const popover = document.createElement("div");
  popover.className = `chat-delete-confirm chat-delete-confirm--${params.side}`;
  popover.setAttribute("role", "dialog");
  popover.setAttribute("aria-modal", "true");
  popover.setAttribute("aria-label", params.confirmText);
  popover.innerHTML = `
    <p class="chat-delete-confirm__text"></p>
    <label class="chat-delete-confirm__remember">
      <input type="checkbox" class="chat-delete-confirm__check" />
      <span>Don't ask again</span>
    </label>
    <div class="chat-delete-confirm__actions">
      <button class="chat-delete-confirm__cancel" type="button">Cancel</button>
      <button class="chat-delete-confirm__yes" type="button"></button>
    </div>
  `;
  const confirmText = popover.querySelector(".chat-delete-confirm__text");
  const confirmButton = popover.querySelector(".chat-delete-confirm__yes");
  if (confirmText) {
    confirmText.textContent = params.confirmText;
  }
  if (confirmButton) {
    confirmButton.textContent = params.confirmLabel;
  }
  wrap.appendChild(popover);
  placeDeleteConfirmPopover(btn, popover, params.side);

  const cancel = popover.querySelector<HTMLButtonElement>(".chat-delete-confirm__cancel")!;
  const yes = popover.querySelector<HTMLButtonElement>(".chat-delete-confirm__yes")!;
  const check = popover.querySelector<HTMLInputElement>(".chat-delete-confirm__check")!;
  let dismissed = false;
  function dismissPopover(options?: DeleteConfirmDismissOptions) {
    if (dismissed) {
      return;
    }
    dismissed = true;
    document.removeEventListener("click", closeOnOutside, true);
    document.removeEventListener("contextmenu", closeOnContextMenu, true);
    window.removeEventListener("keydown", closeOnEscape, true);
    deleteConfirmDismissers.delete(popover);
    popover.remove();
    if (options?.restoreFocus && btn.isConnected) {
      btn.focus({ preventScroll: true });
    }
  }
  function closeOnOutside(evt: MouseEvent) {
    const target = evt.target;
    if (target instanceof Node && !popover.contains(target) && !btn.contains(target)) {
      dismissPopover();
    }
  }
  function closeOnContextMenu(evt: MouseEvent) {
    const target = evt.target;
    if (target instanceof Node && !popover.contains(target)) {
      dismissPopover();
    }
  }
  function closeOnEscape(evt: KeyboardEvent) {
    if (evt.key !== "Escape" || !popover.contains(document.activeElement)) {
      return;
    }
    evt.preventDefault();
    evt.stopImmediatePropagation();
    dismissPopover({ restoreFocus: true });
  }
  function containKeyboardFocus(evt: KeyboardEvent) {
    if (evt.key !== "Tab") {
      return;
    }
    const first = check;
    const last = yes;
    if (evt.shiftKey && document.activeElement === first) {
      evt.preventDefault();
      last.focus();
    } else if (!evt.shiftKey && document.activeElement === last) {
      evt.preventDefault();
      first.focus();
    }
  }
  deleteConfirmDismissers.set(popover, dismissPopover);
  cancel.addEventListener("click", () => dismissPopover({ restoreFocus: true }));
  yes.addEventListener("click", () => {
    if (check.checked) {
      try {
        getSafeLocalStorage()?.setItem(params.preferenceName, "1");
      } catch {}
    }
    dismissPopover();
    params.action();
  });
  popover.addEventListener("keydown", containKeyboardFocus);
  document.addEventListener("contextmenu", closeOnContextMenu, true);
  window.addEventListener("keydown", closeOnEscape, true);
  cancel.focus({ preventScroll: true });
  requestAnimationFrame(() => {
    if (!dismissed && popover.isConnected) {
      placeDeleteConfirmPopover(btn, popover, params.side);
      document.addEventListener("click", closeOnOutside, true);
    }
  });
}

function renderConfirmedActionButton(params: ConfirmedActionParams) {
  return html`
    <span class="chat-delete-wrap ${params.wrapClass ?? ""}">
      <openclaw-tooltip .content=${params.tooltip}>
        <button
          class=${params.buttonClass ?? ""}
          aria-label=${params.ariaLabel}
          ?disabled=${params.disabled}
          @click=${(event: Event) =>
            openConfirmedActionPopover(event.currentTarget as HTMLElement, params)}
        >
          ${params.icon}
        </button>
      </openclaw-tooltip>
    </span>
  `;
}

function resolveRenderableMessageImages(
  images: ImageBlock[],
  opts?: ImageRenderOptions,
): RenderableImageBlock[] {
  return images.flatMap((img) => {
    const isLocalImage = isLocalAssistantAttachmentSource(img.url);
    const canProxyLocalImage =
      isLocalImage && isLocalAttachmentPreviewAllowed(img.url, opts?.localMediaPreviewRoots ?? []);
    if (isLocalImage && !canProxyLocalImage) {
      return [];
    }
    const availability = canProxyLocalImage
      ? resolveAssistantAttachmentAvailability(
          img.url,
          opts?.localMediaPreviewRoots ?? [],
          opts?.basePath,
          opts?.authToken,
          opts?.onRequestUpdate,
        )
      : { status: "available" as const };
    if (availability.status !== "available") {
      return [];
    }
    const displayUrl = canProxyLocalImage
      ? buildAssistantAttachmentUrl(img.url, opts?.basePath, availability.mediaTicket)
      : img.url;
    return [{ ...img, displayUrl }];
  });
}

function openResolvedImage(
  onOpenImage: ((item: ImageLightboxItem, requestVersion?: number) => void) | undefined,
  src: string,
  title: string,
  release?: () => void,
  requestVersion?: number,
) {
  const safeSrc = resolveSafeExternalUrl(src, window.location.href, { allowDataImage: true });
  if (!safeSrc) {
    release?.();
    return;
  }
  if (onOpenImage) {
    const item: ImageLightboxItem = { src: safeSrc, title, ...(release ? { release } : {}) };
    if (requestVersion === undefined) {
      onOpenImage(item);
    } else {
      onOpenImage(item, requestVersion);
    }
    return;
  }
  release?.();
  openExternalUrlSafe(safeSrc, { allowDataImage: true });
}

function renderMessageImages(images: RenderableImageBlock[], opts?: ImageRenderOptions) {
  if (images.length === 0) {
    return nothing;
  }

  const openImage = (img: RenderableImageBlock, previewUrl: string) => {
    const title = img.alt?.trim() || t("chat.imageLightbox.untitled");
    const requestVersion = opts?.onRequestOpenImage?.();
    const managedSource = isManagedOutgoingImageSource(img.displayUrl);
    const cacheKey = managedSource
      ? resolveManagedOutgoingImageBlobUrlCacheKey(img.displayUrl, opts)
      : undefined;
    const previewIsCurrent =
      !managedSource || readManagedOutgoingImageBlobUrl(img.displayUrl, opts) === previewUrl;
    if (previewIsCurrent) {
      const release =
        opts?.onOpenImage && cacheKey ? retainManagedImageBlobUrl(cacheKey) : undefined;
      openResolvedImage(opts?.onOpenImage, previewUrl, title, release, requestVersion);
      return;
    }

    // A managed-image Blob URL may have been evicted after this row rendered.
    // Re-resolve before opening so the modal never receives a revoked URL.
    if (!opts?.onOpenImage) {
      const pendingWindow = reserveExternalWindowForDeferredNavigation();
      void resolveManagedOutgoingImageBlobUrl(img.displayUrl, opts)
        .then((freshUrl) => {
          const safeUrl = freshUrl
            ? resolveSafeExternalUrl(freshUrl, window.location.href, { allowDataImage: true })
            : null;
          if (!safeUrl) {
            pendingWindow?.close();
          } else if (pendingWindow) {
            pendingWindow.location.replace(safeUrl);
          } else {
            openExternalUrlSafe(safeUrl, { allowDataImage: true });
          }
        })
        .catch(() => pendingWindow?.close());
      return;
    }
    void resolveManagedOutgoingImageBlobUrl(img.displayUrl, opts)
      .then((freshUrl) => {
        if (!freshUrl) {
          return;
        }
        const release = cacheKey ? retainManagedImageBlobUrl(cacheKey) : undefined;
        openResolvedImage(opts.onOpenImage, freshUrl, title, release, requestVersion);
      })
      .catch(() => {});
  };

  const renderImageElement = (img: RenderableImageBlock, previewUrl: string) => {
    const title = img.alt?.trim() || t("chat.imageLightbox.untitled");
    return html`
      <button
        type="button"
        class="chat-message-image-button"
        aria-label=${t("chat.imageLightbox.open", { title })}
        @click=${() => openImage(img, previewUrl)}
      >
        <img
          src=${previewUrl}
          alt=${title}
          class="chat-message-image"
          width=${img.width ?? nothing}
          height=${img.height ?? nothing}
        />
      </button>
    `;
  };

  const renderImage = (img: RenderableImageBlock) => {
    if (!isManagedOutgoingImageSource(img.displayUrl)) {
      return renderImageElement(img, img.displayUrl);
    }
    const preview = resolveManagedOutgoingImageBlobUrl(img.displayUrl, opts).then((previewUrl) => {
      if (!previewUrl) {
        return nothing;
      }
      return renderImageElement(img, previewUrl);
    });
    return until(preview, nothing);
  };

  return html` <div class="chat-message-images">${images.map((img) => renderImage(img))}</div> `;
}

function renderReplyPill(replyTarget: NormalizedMessage["replyTarget"]) {
  if (!replyTarget) {
    return nothing;
  }
  return html`
    <div class="chat-reply-pill">
      <span class="chat-reply-pill__icon">${icons.messageSquare}</span>
      <span class="chat-reply-pill__label">
        ${replyTarget.kind === "current"
          ? "Replying to current message"
          : `Replying to ${replyTarget.id}`}
      </span>
    </div>
  `;
}

function renderPairingQrExpiryNotices(notices: PairingQrExpiryNotice[]) {
  if (notices.length === 0) {
    return nothing;
  }
  return html`
    <div class="chat-pairing-qr-notices">
      ${notices.map(
        (notice) => html`
          <div
            class="chat-assistant-attachment-card chat-assistant-attachment-card--blocked chat-pairing-qr-expired"
          >
            <div class="chat-assistant-attachment-card__header">
              <span class="chat-assistant-attachment-card__icon">${icons.alertTriangle}</span>
              <span class="chat-assistant-attachment-card__title">${notice.title}</span>
              <span class="chat-assistant-attachment-badge chat-assistant-attachment-badge--muted"
                >${t("chat.pairingQrExpired.badge")}</span
              >
            </div>
            <div class="chat-assistant-attachment-card__reason">${notice.reason}</div>
          </div>
        `,
      )}
    </div>
  `;
}

function isLocalAssistantAttachmentSource(source: string): boolean {
  const trimmed = source.trim();
  if (/^\/(?:__openclaw__|media|api\/chat\/media\/outgoing)\//.test(trimmed)) {
    return false;
  }
  return (
    isCanonicalInboundMediaSource(trimmed) ||
    trimmed.startsWith("file://") ||
    trimmed.startsWith("~") ||
    trimmed.startsWith("/") ||
    /^[a-zA-Z]:[\\/]/.test(trimmed)
  );
}

function isCanonicalInboundMediaSource(source: string): boolean {
  // Match the raw one-segment form first; URL parsing would erase dot segments.
  const match = /^media:\/\/inbound\/([^/?#]+)$/i.exec(source.trim());
  if (!match?.[1]) {
    return false;
  }
  try {
    const id = decodeURIComponent(match[1]);
    return (
      id !== "." && id !== ".." && !id.includes("/") && !id.includes("\\") && !id.includes("\0")
    );
  } catch {
    return false;
  }
}

function normalizeLocalAttachmentPath(source: string): string | null {
  const trimmed = source.trim();
  if (!isLocalAssistantAttachmentSource(trimmed)) {
    return null;
  }
  if (isCanonicalInboundMediaSource(trimmed)) {
    return null;
  }
  if (trimmed.startsWith("file://")) {
    try {
      const url = new URL(trimmed);
      const pathname = decodeURIComponent(url.pathname);
      if (/^\/[a-zA-Z]:\//.test(pathname)) {
        return pathname.slice(1);
      }
      return pathname;
    } catch {
      return null;
    }
  }
  if (trimmed.startsWith("~")) {
    return null;
  }
  return trimmed;
}

function resolveHomeCandidatesFromRoots(localMediaPreviewRoots: readonly string[]): string[] {
  const candidates = new Set<string>();
  for (const root of localMediaPreviewRoots) {
    const normalized = canonicalizeLocalPathForComparison(root.trim());
    const unixHome = normalized.match(/^(\/Users\/[^/]+|\/home\/[^/]+)(?:\/|$)/);
    if (unixHome?.[1]) {
      candidates.add(unixHome[1]);
      continue;
    }
    const windowsHome = normalized.match(/^([a-z]:\/Users\/[^/]+)(?:\/|$)/i);
    if (windowsHome?.[1]) {
      candidates.add(windowsHome[1]);
    }
  }
  return [...candidates];
}

function canonicalizeLocalPathForComparison(value: string): string {
  let slashNormalized = value.replace(/\\/g, "/").replace(/\/+$/, "");
  if (/^\/[a-zA-Z]:\//.test(slashNormalized)) {
    slashNormalized = slashNormalized.slice(1);
  }
  if (/^[a-zA-Z]:\//.test(slashNormalized)) {
    return slashNormalized.toLowerCase();
  }
  return slashNormalized;
}

function isLocalAttachmentPreviewAllowed(
  source: string,
  localMediaPreviewRoots: readonly string[],
): boolean {
  if (isCanonicalInboundMediaSource(source)) {
    return true;
  }
  const normalizedSource = normalizeLocalAttachmentPath(source);
  const comparableSources = normalizedSource
    ? [canonicalizeLocalPathForComparison(normalizedSource)]
    : source.trim().startsWith("~")
      ? resolveHomeCandidatesFromRoots(localMediaPreviewRoots).map((home) =>
          canonicalizeLocalPathForComparison(source.trim().replace(/^~(?=$|[\\/])/, home)),
        )
      : [];
  if (comparableSources.length === 0) {
    return false;
  }
  return localMediaPreviewRoots.some((root) => {
    const normalizedRoot = canonicalizeLocalPathForComparison(root.trim());
    return (
      normalizedRoot.length > 0 &&
      comparableSources.some(
        (comparableSource) =>
          comparableSource === normalizedRoot || comparableSource.startsWith(`${normalizedRoot}/`),
      )
    );
  });
}

function buildAssistantAttachmentUrl(
  source: string,
  basePath?: string,
  mediaTicket?: string | null,
): string {
  if (!isLocalAssistantAttachmentSource(source)) {
    return source;
  }
  const normalizedBasePath =
    basePath && basePath !== "/" ? (basePath.endsWith("/") ? basePath.slice(0, -1) : basePath) : "";
  const params = new URLSearchParams({ source });
  const normalizedMediaTicket = mediaTicket?.trim();
  if (normalizedMediaTicket) {
    params.set("mediaTicket", normalizedMediaTicket);
  }
  return `${normalizedBasePath}/__openclaw__/assistant-media?${params.toString()}`;
}

function isManagedOutgoingImageSource(source: string): boolean {
  const trimmed = source.trim();
  if (trimmed.startsWith("/api/chat/media/outgoing/")) {
    return true;
  }
  try {
    const parsed = new URL(trimmed, window.location.origin);
    return (
      parsed.origin === window.location.origin &&
      parsed.pathname.startsWith("/api/chat/media/outgoing/")
    );
  } catch {
    return false;
  }
}

function resolveManagedOutgoingImageRequesterSessionKey(source: string): string | null {
  try {
    const parsed = new URL(source, window.location.origin);
    const parts = parsed.pathname.split("/");
    const encodedSessionKey = parts[5];
    return encodedSessionKey ? decodeURIComponent(encodedSessionKey) : null;
  } catch {
    return null;
  }
}

function resolveManagedOutgoingImageBlobUrlCacheKey(
  source: string,
  opts?: ImageRenderOptions,
): string {
  const authToken = opts?.authToken?.trim() ?? "";
  return `${source}::${authToken}`;
}

function readManagedOutgoingImageBlobUrl(
  source: string,
  opts?: ImageRenderOptions,
): string | undefined {
  return readManagedImageBlobUrl(resolveManagedOutgoingImageBlobUrlCacheKey(source, opts));
}

async function resolveManagedOutgoingImageBlobUrl(
  source: string,
  opts?: ImageRenderOptions,
): Promise<string | null> {
  const authToken = opts?.authToken?.trim() ?? "";
  const cacheKey = resolveManagedOutgoingImageBlobUrlCacheKey(source, opts);
  const cached = readManagedImageBlobUrl(cacheKey);
  if (cached) {
    return cached;
  }
  if (hasRecentManagedImageBlobUrlMiss(cacheKey)) {
    return null;
  }
  let pending = managedImageBlobUrlCache.get(cacheKey);
  if (!pending) {
    pending = (async () => {
      const requesterSessionKey = resolveManagedOutgoingImageRequesterSessionKey(source);
      const headers = new Headers({ Accept: "image/*" });
      if (authToken) {
        headers.set("Authorization", `Bearer ${authToken}`);
      }
      if (requesterSessionKey) {
        headers.set("x-openclaw-requester-session-key", requesterSessionKey);
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => {
        controller.abort(
          new DOMException("managed outgoing image fetch timed out", "TimeoutError"),
        );
      }, MANAGED_OUTGOING_IMAGE_FETCH_TIMEOUT_MS);
      try {
        // Managed media is a Gateway API at the origin root. Rebasing it under
        // the Control UI mount path serves the HTML shell instead of image bytes.
        const res = await fetch(source, {
          method: "GET",
          headers,
          credentials: "same-origin",
          signal: controller.signal,
        });
        if (!res.ok) {
          cacheManagedImageBlobUrlMiss(cacheKey);
          return null;
        }
        const blob = await res.blob();
        if (!blob.type.startsWith("image/")) {
          cacheManagedImageBlobUrlMiss(cacheKey);
          return null;
        }
        const blobUrl = URL.createObjectURL(blob);
        cacheManagedImageBlobUrl(cacheKey, blobUrl);
        return blobUrl;
      } catch {
        // The render path treats a missing preview as `nothing`; never reject
        // its `until` promise for an optional image fetch or body failure.
        cacheManagedImageBlobUrlMiss(cacheKey);
        return null;
      } finally {
        clearTimeout(timeout);
      }
    })().finally(() => {
      managedImageBlobUrlCache.delete(cacheKey);
    });
    managedImageBlobUrlCache.set(cacheKey, pending);
  }
  return pending;
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
  if (
    availability.status !== "available" ||
    !availability.mediaTicket ||
    !availability.mediaTicketExpiresAt ||
    !onRequestUpdate
  ) {
    return;
  }
  const refreshInMs = Math.max(
    0,
    availability.mediaTicketExpiresAt -
      Date.now() -
      ASSISTANT_ATTACHMENT_MEDIA_TICKET_REFRESH_SKEW_MS,
  );
  const timer = setTimeout(() => {
    assistantAttachmentRefreshTimers.delete(cacheKey);
    const cached = assistantAttachmentAvailabilityCache.get(cacheKey);
    if (cached?.status !== "available" || cached.mediaTicket !== availability.mediaTicket) {
      return;
    }
    deleteAssistantAttachmentAvailability(cacheKey);
    onRequestUpdate();
  }, refreshInMs);
  assistantAttachmentRefreshTimers.set(cacheKey, timer);
}

function resolveAssistantAttachmentAvailability(
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
  if (cached) {
    const now = Date.now();
    if (
      cached.status === "unavailable" &&
      now - cached.checkedAt >= ASSISTANT_ATTACHMENT_UNAVAILABLE_RETRY_MS
    ) {
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
            clearAssistantAttachmentRefreshTimer(cacheKey);
            setAssistantAttachmentAvailability(cacheKey, {
              status: "unavailable",
              reason: "Attachment unavailable",
              checkedAt: Date.now(),
            });
            return;
          }
          const availability: AssistantAttachmentAvailability = {
            status: "available",
            ...(mediaTicket ? { mediaTicket, mediaTicketExpiresAt } : {}),
          };
          setAssistantAttachmentAvailability(cacheKey, availability);
          scheduleAssistantAttachmentRefresh(cacheKey, availability, onRequestUpdate);
        } else {
          clearAssistantAttachmentRefreshTimer(cacheKey);
          setAssistantAttachmentAvailability(cacheKey, {
            status: "unavailable",
            reason: payload?.reason?.trim() || "Attachment unavailable",
            checkedAt: Date.now(),
          });
        }
      })
      .catch(() => {
        clearAssistantAttachmentRefreshTimer(cacheKey);
        setAssistantAttachmentAvailability(cacheKey, {
          status: "unavailable",
          reason: "Attachment unavailable",
          checkedAt: Date.now(),
        });
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

function renderAssistantAttachments(
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

function renderInlineToolCards(
  toolCards: ToolCard[],
  opts: {
    messageKey: string;
    sessionKey?: string;
    agentId?: string;
    onOpenSidebar?: (content: SidebarContent) => void;
    onOpenWorkspaceFile?: (target: { path: string; line?: number | null }) => void;
    isToolExpanded?: (toolCardId: string) => boolean;
    onToggleToolExpanded?: (toolCardId: string) => void;
    runActive?: boolean;
    canvasPluginSurfaceUrl?: string | null;
    embedSandboxMode?: EmbedSandboxMode;
    allowExternalEmbedUrls?: boolean;
  },
) {
  return html`
    <div class="chat-tools-inline">
      ${toolCards.map((card, index) =>
        renderToolCard(card, {
          expanded: opts.isToolExpanded?.(`${opts.messageKey}:toolcard:${index}`) ?? false,
          runActive: opts.runActive,
          onToggleExpanded: opts.onToggleToolExpanded
            ? () => opts.onToggleToolExpanded?.(`${opts.messageKey}:toolcard:${index}`)
            : () => undefined,
          sessionKey: opts.sessionKey,
          agentId: opts.agentId,
          onOpenSidebar: opts.onOpenSidebar,
          onOpenWorkspaceFile: opts.onOpenWorkspaceFile,
          canvasPluginSurfaceUrl: opts.canvasPluginSurfaceUrl,
          embedSandboxMode: opts.embedSandboxMode ?? "scripts",
          allowExternalEmbedUrls: opts.allowExternalEmbedUrls ?? false,
        }),
      )}
    </div>
  `;
}

/**
 * Max characters for auto-detecting and pretty-printing JSON.
 * Prevents DoS from large JSON payloads in assistant/tool messages.
 */
const MAX_JSON_AUTOPARSE_CHARS = 20_000;

/**
 * Detect whether a trimmed string is a JSON object or array.
 * Must start with `{`/`[` and end with `}`/`]` and parse successfully.
 * Size-capped to prevent render-loop DoS from large JSON messages.
 */
function detectJson(text: string): { parsed: unknown; pretty: string } | null {
  const trimmed = text.trim();

  // Enforce size cap to prevent UI freeze from multi-MB JSON payloads
  if (trimmed.length > MAX_JSON_AUTOPARSE_CHARS) {
    return null;
  }

  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      const parsed = JSON.parse(trimmed);
      return { parsed, pretty: JSON.stringify(parsed, null, 2) };
    } catch {
      return null;
    }
  }
  return null;
}

/** Build a short summary label for collapsed JSON (type + key count or array length). */
function jsonSummaryLabel(parsed: unknown): string {
  if (Array.isArray(parsed)) {
    return `Array (${parsed.length} item${parsed.length === 1 ? "" : "s"})`;
  }
  if (parsed && typeof parsed === "object") {
    const keys = Object.keys(parsed as Record<string, unknown>);
    if (keys.length <= 4) {
      return `{ ${keys.join(", ")} }`;
    }
    return `Object (${keys.length} keys)`;
  }
  return "JSON";
}

function renderExpandButton(
  markdown: string,
  onOpenSidebar: (content: SidebarContent) => void,
  options?: {
    sessionKey?: string;
    agentId?: string;
    messageId?: string;
  },
) {
  return html`
    <openclaw-tooltip .content=${t("chat.messages.openInCanvas")}>
      <button
        class="chat-expand-btn"
        type="button"
        aria-label=${t("chat.messages.openInCanvas")}
        @click=${() =>
          onOpenSidebar({
            kind: "markdown",
            content: markdown,
            ...(options?.sessionKey && options?.messageId
              ? {
                  fullMessageRequest: {
                    sessionKey: options.sessionKey,
                    ...(options.agentId ? { agentId: options.agentId } : {}),
                    messageId: options.messageId,
                    kind: "assistant_message" as const,
                  },
                }
              : {}),
          })}
      >
        <span class="chat-expand-btn__icon" aria-hidden="true">${icons.panelRightOpen}</span>
      </button>
    </openclaw-tooltip>
  `;
}

type MessageActionDetails = {
  markdown?: string;
  messageId?: string;
  replyTarget?: MessageReplyTarget;
  shouldFetchFullMessage: boolean;
};

function resolveNormalizedMessageMarkdown(normalizedMessage: NormalizedMessage): string {
  return normalizedMessage.content
    .reduce<string[]>((lines, item) => {
      if (item.type === "text" && typeof item.text === "string") {
        lines.push(item.text);
      }
      return lines;
    }, [])
    .join("\n")
    .trim();
}

function resolveMessageActionDetails(params: {
  message: unknown;
  messageId: string;
  onOpenSidebar?: (content: SidebarContent) => void;
  onReply?: (target: MessageReplyTarget) => void;
  senderLabel: string;
}): MessageActionDetails | null {
  const { message, messageId: renderMessageId, onOpenSidebar, onReply, senderLabel } = params;
  const record = message as Record<string, unknown>;
  const normalizedMessage = normalizeMessage(message);
  const normalizedMarkdown = resolveNormalizedMessageMarkdown(normalizedMessage);
  const role = normalizeRoleForGrouping(normalizedMessage.role);
  const visibleMarkdown =
    role === "assistant" ? stripThinkingTags(normalizedMarkdown).trim() : normalizedMarkdown.trim();
  const markdown = role === "assistant" ? visibleMarkdown : undefined;
  const replyText = onReply ? truncateUtf16Safe(visibleMarkdown, 500) : "";
  if (!markdown && !replyText) {
    return null;
  }
  const transcriptMeta =
    record["__openclaw"] &&
    typeof record["__openclaw"] === "object" &&
    !Array.isArray(record["__openclaw"])
      ? (record["__openclaw"] as Record<string, unknown>)
      : null;
  const messageId =
    typeof transcriptMeta?.id === "string"
      ? transcriptMeta.id
      : typeof record.messageId === "string"
        ? record.messageId
        : undefined;
  const sourceMessageId = persistedMessageEntryId(message);
  return {
    ...(markdown ? { markdown } : {}),
    messageId,
    ...(replyText
      ? {
          replyTarget: {
            messageId: renderMessageId,
            text: replyText,
            senderLabel,
            ...(sourceMessageId ? { sourceMessageId } : {}),
          },
        }
      : {}),
    shouldFetchFullMessage: Boolean(
      onOpenSidebar &&
      messageId &&
      !record.openclawMessageToolMirror &&
      (transcriptMeta?.truncated === true || markdown?.includes("\n...(truncated)...")),
    ),
  };
}

function renderMessageActionButtons(
  details: MessageActionDetails,
  opts: {
    sessionKey?: string;
    agentId?: string;
    onReply?: (target: MessageReplyTarget) => void;
  },
  onOpenSidebar?: (content: SidebarContent) => void,
  onDelete?: () => void,
) {
  return html`
    ${details.replyTarget && opts.onReply
      ? renderReplyButton(details.replyTarget, opts.onReply)
      : nothing}
    ${onDelete ? renderDeleteButton(onDelete, "right") : nothing}
    ${details.markdown && onOpenSidebar
      ? renderExpandButton(details.markdown, onOpenSidebar, {
          sessionKey: opts.sessionKey,
          agentId: opts.agentId,
          messageId: details.shouldFetchFullMessage ? details.messageId : undefined,
        })
      : nothing}
    ${details.markdown ? renderCopyAsMarkdownButton(details.markdown) : nothing}
  `;
}

function renderReplyButton(
  target: MessageReplyTarget,
  onReply: (target: MessageReplyTarget) => void,
) {
  return html`
    <openclaw-tooltip .content=${t("chat.messages.reply")}>
      <button
        class="chat-reply-btn"
        type="button"
        aria-label=${t("chat.messages.replyToMessage")}
        @click=${() => onReply(target)}
      >
        ${icons.messageSquare}
      </button>
    </openclaw-tooltip>
  `;
}

const USER_MESSAGE_COLLAPSED_LINE_LIMIT = 12;
const USER_MESSAGE_COLLAPSED_CHAR_LIMIT = 700;

function collapsedUserMessagePreview(markdown: string): string | null {
  let end = Math.min(markdown.length, USER_MESSAGE_COLLAPSED_CHAR_LIMIT);
  let lineCount = 1;
  for (let index = 0; index < end; index += 1) {
    if (markdown[index] !== "\n") {
      continue;
    }
    if (lineCount === USER_MESSAGE_COLLAPSED_LINE_LIMIT) {
      end = index;
      break;
    }
    lineCount += 1;
  }
  if (end === markdown.length) {
    return null;
  }
  const sliced = markdown.slice(0, end);
  const lastCodeUnit = sliced.charCodeAt(sliced.length - 1);
  const preview = lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff ? sliced.slice(0, -1) : sliced;
  return `${preview.trimEnd()}…`;
}

function renderUserMessageMarkdown(
  markdown: string,
  messageKey: string,
  opts: {
    isStreaming: boolean;
    isUserMessageExpanded?: (messageId: string) => boolean;
    onToggleUserMessageExpanded?: (messageId: string) => void;
  },
  markdownRenderOptions: MarkdownRenderOptions,
) {
  const preview = collapsedUserMessagePreview(markdown);
  if (!opts.onToggleUserMessageExpanded || preview === null) {
    return renderMarkdownText(markdown, opts.isStreaming, markdownRenderOptions);
  }

  const disclosureId = `user-message:${messageKey}`;
  const expanded = opts.isUserMessageExpanded?.(disclosureId) ?? false;
  return html`
    <div class="chat-user-message-disclosure ${expanded ? "is-expanded" : ""}">
      <div class="chat-user-message-disclosure__content">
        ${expanded
          ? renderMarkdownText(markdown, opts.isStreaming, markdownRenderOptions)
          : html`<div class="chat-user-message-disclosure__preview">${preview}</div>`}
      </div>
      <button
        class="chat-user-message-disclosure__toggle"
        type="button"
        aria-expanded=${String(expanded)}
        @click=${() => opts.onToggleUserMessageExpanded?.(disclosureId)}
      >
        ${t(expanded ? "chat.messages.showLess" : "chat.messages.showMore")}
      </button>
    </div>
  `;
}

function renderGroupedMessage(
  message: unknown,
  messageKey: string,
  opts: {
    isStreaming: boolean;
    sessionKey?: string;
    boardProvider?: BoardProvider;
    agentId?: string;
    duplicateCount?: number;
    showReasoning: boolean;
    showToolCalls?: boolean;
    runActive?: boolean;
    turnSucceeded?: boolean;
    autoExpandToolCalls?: boolean;
    isToolMessageExpanded?: (messageId: string) => boolean | undefined;
    onToggleToolMessageExpanded?: (messageId: string, expanded?: boolean) => void;
    isUserMessageExpanded?: (messageId: string) => boolean;
    onToggleUserMessageExpanded?: (messageId: string) => void;
    isToolExpanded?: (toolCardId: string) => boolean;
    onToggleToolExpanded?: (toolCardId: string) => void;
    onRequestUpdate?: () => void;
    canvasPluginSurfaceUrl?: string | null;
    basePath?: string;
    localMediaPreviewRoots?: readonly string[];
    assistantAttachmentAuthToken?: string | null;
    onAssistantAttachmentLoaded?: () => void;
    onRequestOpenImage?: () => number;
    onOpenImage?: (item: ImageLightboxItem, requestVersion?: number) => void;
    embedSandboxMode?: EmbedSandboxMode;
    allowExternalEmbedUrls?: boolean;
    onOpenWorkspaceFile?: (target: { path: string; line?: number | null }) => void;
    entryId?: string;
    /** Freshly submitted user turn: play the one-shot composer entry animation. */
    entryAnimated?: boolean;
  },
  onOpenSidebar?: (content: SidebarContent) => void,
) {
  const m = message as Record<string, unknown>;
  const role = typeof m.role === "string" ? m.role : "unknown";
  const sourceRole = normalizeRoleForGrouping(role);
  const normalizedMessage = normalizeMessage(message);
  const normalizedRole = normalizeRoleForGrouping(normalizedMessage.role);
  const workspaceConflict = workspaceResultConflictFromTranscript(message);
  if (workspaceConflict) {
    return renderWorkspaceConflictTranscriptMessage(workspaceConflict, messageKey, opts.entryId);
  }
  const isToolShell = normalizedRole === "tool";
  const isStandaloneToolMessage = isStandaloneToolMessageForDisplay(message);

  const toolCards = (opts.showToolCalls ?? true) ? extractToolCardsCached(message, messageKey) : [];
  const hasToolCards = toolCards.length > 0;
  const imageRenderOptions = {
    localMediaPreviewRoots: opts.localMediaPreviewRoots ?? [],
    basePath: opts.basePath,
    authToken: opts.assistantAttachmentAuthToken,
    onRequestUpdate: opts.onRequestUpdate,
    onRequestOpenImage: opts.onRequestOpenImage,
    onOpenImage: opts.onOpenImage,
  };
  schedulePairingQrExpiryRefresh(messageKey, message, opts.onRequestUpdate);
  const images = resolveRenderableMessageImages(extractImages(message), imageRenderOptions);
  const hasImages = images.length > 0;
  const pairingQrExpiryNotices = extractPairingQrExpiryNotices(message);
  const hasPairingQrExpiryNotices = pairingQrExpiryNotices.length > 0;

  const extractedText = resolveNormalizedMessageMarkdown(normalizedMessage);
  const assistantAttachments = normalizedMessage.content.filter(
    (item): item is AttachmentItem => item.type === "attachment",
  );
  const visibleAttachments = [...assistantAttachments, ...extractTranscriptAttachments(message)];
  const assistantViewBlocks = normalizedMessage.content.filter(
    (item): item is Extract<MessageContentItem, { type: "canvas" }> => item.type === "canvas",
  );
  const extractedThinking =
    opts.showReasoning && role === "assistant" ? extractThinkingCached(message) : null;
  const reasoningMarkdown = extractedThinking ? formatReasoningMarkdown(extractedThinking) : null;
  const markdown = extractedText?.trim() ? extractedText : null;
  const markdownRenderOptions: MarkdownRenderOptions = {
    assistantTranscriptRoleHeaders: role === "assistant",
    codeBlockChrome: role === "user" ? "none" : "copy",
    fileLinks: true,
    interactiveImages: opts.onOpenImage !== undefined,
  };

  // Detect pure-JSON messages and render as collapsible block
  const jsonResult = markdown && !opts.isStreaming ? detectJson(markdown) : null;

  const bubbleClasses = [
    "chat-bubble",
    isToolShell ? "chat-bubble--tool-shell" : "",
    opts.isStreaming ? "streaming" : "",
    opts.entryAnimated ? "chat-bubble--user-turn-enter" : "",
  ]
    .filter(Boolean)
    .join(" ");

  // Suppress empty bubbles when tool cards are the only content and toggle is off
  const visibleToolCards = hasToolCards && (opts.showToolCalls ?? true);
  if (
    !markdown &&
    !visibleToolCards &&
    !hasImages &&
    !hasPairingQrExpiryNotices &&
    visibleAttachments.length === 0 &&
    assistantViewBlocks.length === 0 &&
    !normalizedMessage.replyTarget
  ) {
    return nothing;
  }

  const toolMessageDisclosureId = `toolmsg:${messageKey}`;
  const toolMessageExpanded = opts.isToolMessageExpanded?.(toolMessageDisclosureId) ?? false;
  const toolNames = [...new Set(toolCards.map((c) => c.name))];
  const singleToolCard = toolCards.length === 1 ? toolCards[0] : null;
  const toolMessageHasError = toolCards.some(isToolCardError) && opts.turnSucceeded !== true;
  const singleToolDisplay = singleToolCard
    ? resolveToolDisplay({
        name: singleToolCard.name,
        args: singleToolCard.args,
        detailMode: "explain",
      })
    : null;
  const singleToolDisplayDetail =
    !toolMessageHasError && singleToolCard && singleToolDisplay
      ? resolveCollapsedToolDetail(singleToolCard, singleToolDisplay.detail)
      : undefined;
  const toolSummaryLabelRaw = toolMessageHasError
    ? singleToolDisplay
      ? singleToolDisplay.label
      : toolNames.length <= 3
        ? toolNames.join(", ")
        : `${toolNames.slice(0, 2).join(", ")} +${toolNames.length - 2} more`
    : singleToolDisplayDetail
      ? !markdown && !hasImages
        ? singleToolDisplayDetail
        : singleToolCard?.outputText?.trim()
          ? "output"
          : undefined
      : toolNames.length <= 3
        ? toolNames.join(", ")
        : `${toolNames.slice(0, 2).join(", ")} +${toolNames.length - 2} more`;
  const toolPreview = markdown ? (formatCollapsedToolPreviewText(markdown) ?? "") : "";
  const toolMessageLabelRaw = toolMessageHasError
    ? t("chat.toolCards.toolError")
    : singleToolDisplay && !markdown && !hasImages
      ? singleToolDisplay.label
      : t("chat.toolCards.toolOutput");
  const toolMessageLabel =
    formatCollapsedToolSummaryText(toolMessageLabelRaw) ?? toolMessageLabelRaw;
  const toolSummaryLabel = formatDistinctCollapsedToolSummaryText(
    toolSummaryLabelRaw,
    toolMessageLabel,
  );
  const toolMessageIcon = singleToolDisplay ? renderChatIcon(singleToolDisplay.icon) : icons.zap;
  const assistantViewContent =
    sourceRole === "assistant" && assistantViewBlocks.length > 0
      ? html`${assistantViewBlocks.map(
          (block) => html`${renderToolPreview(block.preview, "chat_message", {
            onOpenSidebar,
            rawText: block.rawText ?? null,
            canvasPluginSurfaceUrl: opts.canvasPluginSurfaceUrl,
            boardProvider: opts.boardProvider,
            embedSandboxMode: opts.embedSandboxMode ?? "scripts",
            sessionKey: opts.sessionKey,
          })}
          ${block.rawText ? renderRawOutputToggle(block.rawText) : nothing}`,
        )}`
      : nothing;

  const duplicateCount = Math.max(1, Math.floor(opts.duplicateCount ?? 1));

  // Pure tool messages (no text/images/attachments) skip the "Tool output"
  // shell and render as flat kind-aware rows, one disclosure level deep.
  const onlyToolCards =
    isStandaloneToolMessage &&
    hasToolCards &&
    !markdown &&
    !hasImages &&
    !hasPairingQrExpiryNotices &&
    visibleAttachments.length === 0 &&
    assistantViewBlocks.length === 0 &&
    !reasoningMarkdown;

  if (onlyToolCards) {
    return html`
      <div
        class="${bubbleClasses}"
        data-message-id=${messageKey}
        data-entry-id=${opts.entryId || nothing}
        data-message-text=${extractedText || nothing}
      >
        ${renderReplyPill(normalizedMessage.replyTarget)}
        ${renderInlineToolCards(toolCards, {
          messageKey,
          sessionKey: opts.sessionKey,
          agentId: opts.agentId,
          onOpenSidebar,
          onOpenWorkspaceFile: opts.onOpenWorkspaceFile,
          isToolExpanded: opts.isToolExpanded,
          onToggleToolExpanded: opts.onToggleToolExpanded,
          runActive: opts.runActive,
          canvasPluginSurfaceUrl: opts.canvasPluginSurfaceUrl,
          embedSandboxMode: opts.embedSandboxMode ?? "scripts",
          allowExternalEmbedUrls: opts.allowExternalEmbedUrls ?? false,
        })}
        ${duplicateCount > 1
          ? html`<div
              class="chat-duplicate-count"
              aria-label=${`${duplicateCount} consecutive identical messages collapsed`}
            >
              ×${duplicateCount}
            </div>`
          : nothing}
      </div>
    `;
  }

  return html`
    <div
      class="${bubbleClasses}"
      data-message-id=${messageKey}
      data-entry-id=${opts.entryId || nothing}
      data-message-text=${extractedText || nothing}
    >
      ${renderReplyPill(normalizedMessage.replyTarget)}
      ${isStandaloneToolMessage
        ? html`
            <div
              class="chat-tool-msg-collapse chat-tool-msg-collapse--manual ${toolMessageExpanded
                ? "is-open"
                : ""}"
            >
              <button
                class="chat-tool-msg-summary ${toolMessageHasError
                  ? "chat-tool-msg-summary--error"
                  : ""}"
                type="button"
                aria-expanded=${String(toolMessageExpanded)}
                @click=${(event: MouseEvent) => {
                  if (shouldToggleSelectableDisclosure(event)) {
                    opts.onToggleToolMessageExpanded?.(toolMessageDisclosureId);
                  }
                }}
              >
                <span class="chat-tool-msg-summary__icon">${toolMessageIcon}</span>
                <span class="chat-tool-msg-summary__label">${toolMessageLabel}</span>
                ${toolSummaryLabel
                  ? html`<span class="chat-tool-msg-summary__names">${toolSummaryLabel}</span>`
                  : toolPreview
                    ? html`<span class="chat-tool-msg-summary__preview">${toolPreview}</span>`
                    : nothing}
              </button>
              ${toolMessageExpanded
                ? html`
                    <div class="chat-tool-msg-body">
                      ${renderPairingQrExpiryNotices(pairingQrExpiryNotices)}
                      ${renderMessageImages(images, imageRenderOptions)}
                      ${renderAssistantAttachments(
                        visibleAttachments,
                        opts.localMediaPreviewRoots ?? [],
                        opts.basePath,
                        opts.assistantAttachmentAuthToken,
                        opts.onRequestUpdate,
                        opts.onAssistantAttachmentLoaded,
                        opts.onRequestOpenImage,
                        opts.onOpenImage,
                      )}
                      ${assistantViewContent}
                      ${reasoningMarkdown
                        ? html`<div class="chat-thinking">
                            ${unsafeHTML(toSanitizedMarkdownHtml(reasoningMarkdown))}
                          </div>`
                        : nothing}
                      ${jsonResult
                        ? html`<details
                            class="chat-json-collapse"
                            ?open=${Boolean(opts.autoExpandToolCalls)}
                          >
                            <summary class="chat-json-summary">
                              <span class="chat-json-badge">JSON</span>
                              <span class="chat-json-label"
                                >${jsonSummaryLabel(jsonResult.parsed)}</span
                              >
                            </summary>
                            <pre class="chat-json-content"><code>${jsonResult.pretty}</code></pre>
                          </details>`
                        : markdown
                          ? renderMarkdownText(markdown, opts.isStreaming, markdownRenderOptions)
                          : nothing}
                      ${hasToolCards
                        ? singleToolCard && !markdown && !hasImages
                          ? renderExpandedToolCardContent(
                              singleToolCard,
                              opts.sessionKey,
                              onOpenSidebar,
                              opts.canvasPluginSurfaceUrl,
                              opts.embedSandboxMode ?? "scripts",
                              opts.allowExternalEmbedUrls ?? false,
                              opts.runActive,
                              opts.onOpenWorkspaceFile,
                            )
                          : renderInlineToolCards(toolCards, {
                              messageKey,
                              sessionKey: opts.sessionKey,
                              agentId: opts.agentId,
                              onOpenSidebar,
                              onOpenWorkspaceFile: opts.onOpenWorkspaceFile,
                              isToolExpanded: opts.isToolExpanded,
                              onToggleToolExpanded: opts.onToggleToolExpanded,
                              runActive: opts.runActive,
                              canvasPluginSurfaceUrl: opts.canvasPluginSurfaceUrl,
                              embedSandboxMode: opts.embedSandboxMode ?? "scripts",
                              allowExternalEmbedUrls: opts.allowExternalEmbedUrls ?? false,
                            })
                        : nothing}
                    </div>
                  `
                : nothing}
            </div>
          `
        : html`
            ${renderPairingQrExpiryNotices(pairingQrExpiryNotices)}
            ${renderMessageImages(images, imageRenderOptions)}
            ${renderAssistantAttachments(
              visibleAttachments,
              opts.localMediaPreviewRoots ?? [],
              opts.basePath,
              opts.assistantAttachmentAuthToken,
              opts.onRequestUpdate,
              opts.onAssistantAttachmentLoaded,
              opts.onRequestOpenImage,
              opts.onOpenImage,
            )}
            ${reasoningMarkdown
              ? html`<div class="chat-thinking">
                  ${unsafeHTML(toSanitizedMarkdownHtml(reasoningMarkdown))}
                </div>`
              : nothing}
            ${assistantViewContent}
            ${jsonResult
              ? html`<details class="chat-json-collapse">
                  <summary class="chat-json-summary">
                    <span class="chat-json-badge">JSON</span>
                    <span class="chat-json-label">${jsonSummaryLabel(jsonResult.parsed)}</span>
                  </summary>
                  <pre class="chat-json-content"><code>${jsonResult.pretty}</code></pre>
                </details>`
              : markdown
                ? normalizedRole === "user"
                  ? renderUserMessageMarkdown(markdown, messageKey, opts, markdownRenderOptions)
                  : renderMarkdownText(markdown, opts.isStreaming, markdownRenderOptions)
                : nothing}
            ${hasToolCards
              ? renderInlineToolCards(toolCards, {
                  messageKey,
                  sessionKey: opts.sessionKey,
                  agentId: opts.agentId,
                  onOpenSidebar,
                  onOpenWorkspaceFile: opts.onOpenWorkspaceFile,
                  isToolExpanded: opts.isToolExpanded,
                  onToggleToolExpanded: opts.onToggleToolExpanded,
                  runActive: opts.runActive,
                  canvasPluginSurfaceUrl: opts.canvasPluginSurfaceUrl,
                  embedSandboxMode: opts.embedSandboxMode ?? "scripts",
                  allowExternalEmbedUrls: opts.allowExternalEmbedUrls ?? false,
                })
              : nothing}
          `}
      ${duplicateCount > 1
        ? html`<div
            class="chat-duplicate-count"
            aria-label=${`${duplicateCount} consecutive identical messages collapsed`}
          >
            ×${duplicateCount}
          </div>`
        : nothing}
    </div>
  `;
}

function renderWorkspaceConflictTranscriptMessage(
  conflict: WorkspaceResultConflict,
  messageKey: string,
  entryId?: string,
) {
  const count = workspaceConflictCount(conflict);
  const visible = visibleWorkspaceConflictPaths(conflict);
  return html`
    <div
      class="chat-bubble chat-bubble--workspace-conflict"
      data-message-id=${messageKey}
      data-entry-id=${entryId || nothing}
    >
      <div class="chat-workspace-conflict-event" role="status">
        <div class="chat-workspace-conflict-event__header">
          <span aria-hidden="true">${icons.alertTriangle}</span>
          <strong
            >${t(
              count === 1
                ? "chat.workspaceConflict.eventTitleOne"
                : "chat.workspaceConflict.eventTitleMany",
              { count: String(count) },
            )}</strong
          >
        </div>
        <p>${t("chat.workspaceConflict.eventDescription")}</p>
        <ul class="chat-workspace-conflict-paths">
          ${visible.paths.map(
            (entryPath) =>
              html`<li><code>${workspaceConflictPathForDisplay(entryPath)}</code></li>`,
          )}
        </ul>
        ${visible.remaining > 0
          ? html`<div class="chat-workspace-conflict-more">
              ${t("chat.workspaceConflict.morePaths", { count: String(visible.remaining) })}
            </div>`
          : nothing}
        <div class="chat-workspace-conflict-ref">
          <span>${t("chat.workspaceConflict.stagedResult")}</span>
          <code>${conflict.stagedResultRef}</code>
        </div>
      </div>
    </div>
  `;
}

function renderMarkdownText(
  markdown: string,
  isStreaming: boolean,
  markdownRenderOptions?: MarkdownRenderOptions,
) {
  if (isStreaming) {
    return html`
      <div class="chat-text" dir="${detectTextDirection(markdown)}">
        ${unsafeHTML(toStreamingMarkdownHtml(markdown, markdownRenderOptions))}
      </div>
    `;
  }
  return html`
    <div class="chat-text" dir="${detectTextDirection(markdown)}">
      ${unsafeHTML(toSanitizedMarkdownHtml(markdown, markdownRenderOptions))}
    </div>
  `;
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
