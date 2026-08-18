import { html, nothing } from "lit";
import { resolveLocalUserName } from "../../../app/user-identity.ts";
import { icons } from "../../../components/icons.ts";
import type { ImageLightboxItem } from "../../../components/image-lightbox.ts";
import { t } from "../../../i18n/index.ts";
import type { BoardProvider } from "../../../lib/board/provider.ts";
import type { MessageGroup } from "../../../lib/chat/chat-types.ts";
import { normalizeRoleForGrouping } from "../../../lib/chat/message-normalizer.ts";
import { formatSenderLabel } from "../../../lib/chat/sender-label.ts";
import { summarizeToolGroup } from "../../../lib/chat/tool-call-grouping.ts";
import { extractToolCardsCached } from "../../../lib/chat/tool-cards.ts";
import type { EmbedSandboxMode } from "../../../lib/chat/tool-display.ts";
import { fnv1aUtf16 } from "../../../lib/fnv1a.ts";
import { resolveIdentityHue } from "../../../lib/identity-avatar.ts";
import { renderChatAvatar } from "../chat-avatar.ts";
import type { TurnRecap } from "../chat-progress.ts";
import {
  isPendingSendMessage,
  persistedMessageEntryId,
  type AssistantMessageExpansionState,
} from "../chat-thread.ts";
import { workspaceResultConflictFromTranscript } from "../workspace-conflict.ts";
import { renderChatAuthorAvatar } from "./chat-author-avatar.ts";
import { renderGroupedMessage } from "./chat-message-bubble.ts";
import { renderRewindButton } from "./chat-message-confirmation.ts";
import {
  renderMessageActionButtons,
  renderReplyButton,
  resolveMessageActionDetails,
  type AssistantMessageDisclosure,
  type MessageActionDetails,
  type MessageReplyTarget,
} from "./chat-message-markdown.ts";
import type { ArtifactDownloadResolver } from "./chat-message-media.ts";
import {
  renderStreamGroupParts,
  type StreamGroupOptions,
  type StreamGroupPart,
} from "./chat-message-stream.ts";
import { extractGroupMeta, renderMessageMeta } from "./chat-message-timestamp.ts";
import type { SidebarContent, SidebarFullMessageLoader } from "./chat-sidebar.ts";
import {
  isRunningToolCard,
  resolveToolRowText,
  shouldToggleSelectableDisclosure,
  syncToolDisclosureOverflow,
  toggleToolDisclosureKeepingScroll,
} from "./chat-tool-cards.ts";
import { renderTurnRecapRow } from "./chat-working-indicator.ts";

type ActiveContinuation = {
  parts: StreamGroupPart[];
  options: StreamGroupOptions;
};

type ReplyPreview = MessageReplyTarget & { sourceMessageId: string };

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
  loadFullAssistantMessage?: SidebarFullMessageLoader;
  getAssistantMessageExpansion?: (messageId: string) => AssistantMessageExpansionState | undefined;
  onToggleAssistantMessageExpanded?: (messageId: string) => void;
  isToolExpanded?: (toolCardId: string) => boolean | undefined;
  onToggleToolExpanded?: (toolCardId: string, expanded?: boolean) => void;
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
  showAssistantAvatar?: boolean;
  basePath?: string;
  localMediaPreviewRoots?: readonly string[];
  assistantAttachmentAuthToken?: string | null;
  resolveArtifactDownload?: ArtifactDownloadResolver;
  canvasPluginSurfaceUrl?: string | null;
  embedSandboxMode?: EmbedSandboxMode;
  allowExternalEmbedUrls?: boolean;
  contextWindow?: number | null;
  onReply?: (target: MessageReplyTarget) => void;
  resolveReplyPreview?: (replyToId: string) => ReplyPreview | undefined;
  onResolveReply?: (replyToId: string) => void;
  onOpenReply?: (replyToId: string) => void;
  replyNavigationId?: string | null;
  onRewind?: () => void;
  rewindDisabled?: boolean;
  activeContinuation?: ActiveContinuation;
  turnRecap?: TurnRecap;
};

type GroupedMessageRenderOptions = Parameters<typeof renderGroupedMessage>[2];

// Each automatic load attempt costs 2 revisions (loading, then error), so
// this bounds auto-retries to 3 before the manual retry affordance takes over.
const FULL_MESSAGE_RETRY_REVISION_LIMIT = 6;

function buildGroupedMessageRenderOptions(
  group: MessageGroup,
  item: MessageGroup["messages"][number],
  index: number,
  opts: RenderMessageGroupOptions,
  actionDetails?: MessageActionDetails | null,
): GroupedMessageRenderOptions {
  let assistantMessageDisclosure: AssistantMessageDisclosure | undefined;
  if (
    actionDetails?.shouldFetchFullMessage &&
    actionDetails.messageId &&
    opts.loadFullAssistantMessage &&
    opts.onToggleAssistantMessageExpanded
  ) {
    const messageId = actionDetails.messageId;
    const expansion = opts.getAssistantMessageExpansion?.(messageId);
    const retriesExhausted =
      expansion?.status === "error" && expansion.revision >= FULL_MESSAGE_RETRY_REVISION_LIMIT;
    assistantMessageDisclosure = {
      expanded: expansion?.status === "loaded",
      ...(expansion?.status === "loaded" ? { markdown: actionDetails.markdown } : {}),
      // Manual re-entry once the bounded automatic retries gave up.
      ...(retriesExhausted
        ? { onRetryFullMessage: () => opts.onToggleAssistantMessageExpanded?.(messageId) }
        : {}),
    };
  }
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
    autoExpandToolCalls: opts.autoExpandToolCalls ?? false,
    isToolMessageExpanded: opts.isToolMessageExpanded,
    onToggleToolMessageExpanded: opts.onToggleToolMessageExpanded,
    isUserMessageExpanded: opts.isUserMessageExpanded,
    onToggleUserMessageExpanded: opts.onToggleUserMessageExpanded,
    assistantMessageDisclosure,
    actionMarkdown: actionDetails?.markdown,
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
    resolveArtifactDownload: opts.resolveArtifactDownload,
    embedSandboxMode: opts.embedSandboxMode,
    allowExternalEmbedUrls: opts.allowExternalEmbedUrls,
    resolveReplyPreview: opts.resolveReplyPreview,
    onResolveReply: opts.onResolveReply,
    onOpenReply: opts.onOpenReply,
    replyNavigationId: opts.replyNavigationId,
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

export function renderActivityGroup(
  groups: readonly MessageGroup[],
  opts: RenderMessageGroupOptions,
) {
  const firstGroup = groups[0];
  if (!firstGroup || opts.showToolCalls === false) {
    return nothing;
  }
  const cards = groups.flatMap((group) =>
    group.messages.flatMap((item) => extractToolCardsCached(item.message, item.key)),
  );
  const latestGroup = groups[groups.length - 1] ?? firstGroup;
  const latestCards = latestGroup.messages.flatMap((item) =>
    extractToolCardsCached(item.message, item.key),
  );
  // While a run is live, the newest still-running call names the group so
  // the collapsed header reads like a status line; afterwards it aggregates.
  const runningCard = opts.runActive
    ? latestCards.findLast((card) => isRunningToolCard(card, opts.runActive))
    : undefined;
  const groupSummaryLabel = runningCard
    ? `${resolveToolRowText(runningCard, opts.runActive)}…`
    : summarizeToolGroup(cards.map((card) => ({ name: card.name, args: card.args })));
  const activityDisclosureId = `activity:${firstGroup.key}`;
  const activityBodyId = `activity-body-${fnv1aUtf16(firstGroup.key).toString(16)}`;
  const activityExpanded = opts.isToolMessageExpanded?.(activityDisclosureId) ?? false;
  return html`
    <div
      class="chat-group tool chat-group--activity chat-group--with-footer"
      data-chat-row-key=${firstGroup.key}
    >
      <div class="chat-group-messages">
        <div class="chat-activity-group ${activityExpanded ? "is-open" : ""}">
          <button
            class="chat-inline-disclosure chat-activity-group__summary"
            type="button"
            aria-expanded=${String(activityExpanded)}
            aria-controls=${activityBodyId}
            @pointerenter=${syncToolDisclosureOverflow}
            @focus=${syncToolDisclosureOverflow}
            @click=${(event: MouseEvent) => {
              if (shouldToggleSelectableDisclosure(event)) {
                toggleToolDisclosureKeepingScroll(event, () =>
                  opts.onToggleToolMessageExpanded?.(activityDisclosureId, activityExpanded),
                );
              }
            }}
          >
            <span class="chat-activity-group__icon">${icons.listTree}</span>
            <span class="chat-tool-disclosure__content">
              <span class="chat-activity-group__label" title=${groupSummaryLabel}
                >${groupSummaryLabel}</span
              >
            </span>
            <span class="chat-tool-row__chevron" aria-hidden="true">${icons.chevronRight}</span>
          </button>
          <div class="chat-activity-group__body" id=${activityBodyId} ?hidden=${!activityExpanded}>
            ${activityExpanded
              ? groups.map((group) =>
                  group.messages.map((item, index) =>
                    renderGroupedMessage(
                      item.message,
                      item.key,
                      buildGroupedMessageRenderOptions(group, item, index, opts),
                      opts.onOpenSidebar,
                    ),
                  ),
                )
              : nothing}
          </div>
        </div>
      </div>
    </div>
  `;
}

export function resolveMessageGroupSenderLabel(
  group: MessageGroup,
  opts: Pick<RenderMessageGroupOptions, "assistantName" | "userId" | "userName" | "userAvatar">,
): string {
  const normalizedRole = normalizeRoleForGrouping(group.role);
  const assistantName = opts.assistantName ?? "Assistant";
  const resolvedUserName = resolveLocalUserName({
    name: opts.userName ?? null,
    avatar: opts.userAvatar ?? null,
  });
  const userLabel = group.senderLabel?.trim();
  const isPeerGroup = normalizedRole === "user" && isPeerSenderGroup(group, opts.userId);
  const isCurrentUser = normalizedRole === "user" && Boolean(group.sender) && !isPeerGroup;
  return normalizedRole === "user"
    ? isCurrentUser
      ? resolvedUserName
      : (userLabel ?? resolvedUserName)
    : normalizedRole === "assistant"
      ? (userLabel ?? assistantName)
      : normalizedRole === "tool"
        ? t("chat.messages.toolSender")
        : group.messages.every((item) =>
              Boolean(workspaceResultConflictFromTranscript(item.message)),
            )
          ? t("chat.workspaceConflict.eventSender")
          : normalizedRole;
}

export function renderMessageGroup(group: MessageGroup, opts: RenderMessageGroupOptions) {
  const normalizedRole = normalizeRoleForGrouping(group.role);
  const isWorkspaceConflict = group.messages.every((item) =>
    Boolean(workspaceResultConflictFromTranscript(item.message)),
  );
  const assistantName = opts.assistantName ?? "Assistant";
  const isPeerGroup = normalizedRole === "user" && isPeerSenderGroup(group, opts.userId);
  const who = resolveMessageGroupSenderLabel(group, opts);
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
  const showAvatarGutter = opts.showAvatarGutter !== false;
  const persistUserIdentity = normalizedRole === "user" && showAvatarGutter;

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
    return renderActivityGroup([group], opts);
  }

  const messageActionDetails = group.messages.map((item) =>
    resolveMessageActionDetails({
      message: item.message,
      messageId: item.key,
      canFetchFullMessage: Boolean(opts.loadFullAssistantMessage && opts.sessionKey),
      getAssistantMessageExpansion: opts.getAssistantMessageExpansion,
      onReply: opts.onReply,
      senderLabel: who,
    }),
  );
  for (const details of messageActionDetails) {
    if (!details?.shouldFetchFullMessage || !details.messageId) {
      continue;
    }
    const expansion = opts.getAssistantMessageExpansion?.(details.messageId);
    // A transient load failure must not pin the truncated preview for the
    // whole session: retry on later render passes, bounded by revision
    // (each attempt costs 2 revisions) so a dead loader cannot hot-loop.
    if (
      !expansion ||
      (expansion.status === "error" && expansion.revision < FULL_MESSAGE_RETRY_REVISION_LIMIT)
    ) {
      opts.onToggleAssistantMessageExpanded?.(details.messageId);
    }
  }
  const lastMessageIndex = group.messages.length - 1;
  const footerActionDetails = messageActionDetails[lastMessageIndex] ?? null;
  const hasUserFooterActions =
    normalizedRole === "user" &&
    Boolean((footerActionDetails?.replyTarget && opts.onReply) || opts.onRewind);

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
      ${normalizedRole !== "tool" &&
      showAvatarGutter &&
      (normalizedRole !== "assistant" || opts.showAssistantAvatar !== false)
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
              buildGroupedMessageRenderOptions(group, item, index, opts, actionDetails),
              opts.onOpenSidebar,
            )}
            ${actionDetails && index < lastMessageIndex
              ? html`
                  <div class="chat-message-actions-row" data-message-actions-for=${item.key}>
                    ${renderMessageActionButtons(actionDetails, opts)}
                  </div>
                `
              : nothing}
          `;
        })}
        ${opts.activeContinuation
          ? renderStreamGroupParts(
              opts.activeContinuation.parts,
              opts.activeContinuation.options,
              "continuation",
            )
          : opts.turnRecap
            ? renderTurnRecapRow(opts.turnRecap, { presentation: "continuation" })
            : nothing}
      </div>
      ${normalizedRole === "tool"
        ? nothing
        : html`<div
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
                      ${opts.onRewind
                        ? renderRewindButton(opts.onRewind, Boolean(opts.rewindDisabled))
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
            ${normalizedRole !== "user" && footerActionDetails
              ? html`
                  <div
                    class="chat-group-footer-actions"
                    data-message-actions-for=${group.messages[lastMessageIndex]?.key ?? nothing}
                  >
                    ${renderMessageActionButtons(footerActionDetails, opts)}
                  </div>
                `
              : nothing}
          </div>`}
    </div>
  `;
}

// ── Per-message metadata (tokens, cost, model, context %) ──
