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
import { extractToolCardsCached, isToolCardError } from "../../../lib/chat/tool-cards.ts";
import type { EmbedSandboxMode } from "../../../lib/chat/tool-display.ts";
import { resolveIdentityHue } from "../../../lib/identity-avatar.ts";
import { renderChatAvatar } from "../chat-avatar.ts";
import { isPendingSendMessage, persistedMessageEntryId } from "../chat-thread.ts";
import { workspaceResultConflictFromTranscript } from "../workspace-conflict.ts";
import { renderChatAuthorAvatar } from "./chat-author-avatar.ts";
import { renderGroupedMessage } from "./chat-message-bubble.ts";
import { renderDeleteButton, renderRewindButton } from "./chat-message-confirmation.ts";
import {
  renderMessageActionButtons,
  renderReplyButton,
  resolveMessageActionDetails,
  type MessageReplyTarget,
} from "./chat-message-markdown.ts";
import {
  extractGroupMeta,
  renderChatTimestamp,
  renderMessageMeta,
} from "./chat-message-timestamp.ts";
import type { SidebarContent } from "./chat-sidebar.ts";
import {
  isRunningToolCard,
  resolveToolRowText,
  shouldToggleSelectableDisclosure,
} from "./chat-tool-cards.ts";

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
