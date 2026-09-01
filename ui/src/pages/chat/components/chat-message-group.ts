import { html, nothing } from "lit";
import { resolveLocalUserName } from "../../../app/user-identity.ts";
import type { BrowserTabSelection } from "../../../components/browser/browser-target.ts";
import { icons } from "../../../components/icons.ts";
import {
  personActivityLink,
  renderPersonName,
  type PersonActivityRouting,
} from "../../../components/person-activity-link.ts";
import { t } from "../../../i18n/index.ts";
import type { MessageGroup } from "../../../lib/chat/chat-types.ts";
import { normalizeRoleForGrouping } from "../../../lib/chat/message-normalizer.ts";
import { formatSenderLabel } from "../../../lib/chat/sender-label.ts";
import {
  readToolApprovalReviewOutcome,
  readToolApprovalReviews,
  resolveToolApprovalReviewOutcome,
} from "../../../lib/chat/tool-approval-reviews.ts";
import { summarizeToolGroup } from "../../../lib/chat/tool-call-grouping.ts";
import { extractToolCardsCached } from "../../../lib/chat/tool-cards.ts";
import { fnv1aUtf16 } from "../../../lib/fnv1a.ts";
import { resolveIdentityHue } from "../../../lib/identity-avatar.ts";
import { renderChatAvatar, renderForwardedAvatar } from "../chat-avatar.ts";
import type { TurnRecap } from "../chat-progress.ts";
import {
  persistedMessageEntryId,
  readPendingSendFailure,
  type AssistantMessageExpansionState,
} from "../chat-thread.ts";
import { hasForwardedSource } from "../chat-turn-boundary.ts";
import { workspaceResultConflictFromTranscript } from "../workspace-conflict.ts";
import { renderChatAuthorAvatar } from "./chat-author-avatar.ts";
import { renderForwardedAttribution } from "./chat-forwarded-attribution.ts";
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
import { renderChatSendStatus, type ChatSendStatusActions } from "./chat-message-send-status.ts";
import {
  renderStreamGroupParts,
  type StreamGroupOptions,
  type StreamGroupPart,
} from "./chat-message-stream.ts";
import { extractGroupMeta, renderMessageMeta } from "./chat-message-timestamp.ts";
import type { SidebarContent, SidebarFullMessageLoader } from "./chat-sidebar.ts";
import {
  isRunningToolCard,
  renderBrowserTabPreviews,
  resolveToolRowText,
  shouldToggleSelectableDisclosure,
  syncToolDisclosureOverflow,
} from "./chat-tool-cards.ts";
import { shouldAnimateUserTurnEntry } from "./chat-user-turn-entry.ts";
import { renderTurnRecapRow } from "./chat-working-indicator.ts";

type ActiveContinuation = {
  parts: StreamGroupPart[];
  options: StreamGroupOptions;
};

type ReplyPreview = MessageReplyTarget & { sourceMessageId: string };

type GroupedMessageRenderOptions = Parameters<typeof renderGroupedMessage>[2];

type RenderMessageGroupOptions = Omit<
  GroupedMessageRenderOptions,
  | "isStreaming"
  | "duplicateCount"
  | "assistantMessageDisclosure"
  | "messageActions"
  | "entryId"
  | "entryAnimated"
  | "resolveReplyPreview"
> &
  ChatSendStatusActions &
  Parameters<typeof renderForwardedAvatar>[1] & {
    latestBrowserTabs?: ReadonlyMap<string, BrowserTabSelection>;
    /** Configured main-session key; an agent's main source labels as the agent. */
    mainKey?: string;
    onOpenSidebar?: (content: SidebarContent) => void;
    loadFullAssistantMessage?: SidebarFullMessageLoader;
    getAssistantMessageExpansion?: (
      messageId: string,
    ) => AssistantMessageExpansionState | undefined;
    onToggleAssistantMessageExpanded?: (messageId: string) => void;
    userId?: string | null;
    userName?: string | null;
    /** Routing for peer sender names; absent leaves them plain text. */
    personActivity?: PersonActivityRouting;
    userAvatar?: string | null;
    showAvatarGutter?: boolean;
    showAssistantAvatar?: boolean;
    contextWindow?: number | null;
    onReply?: (target: MessageReplyTarget) => void;
    resolveReplyPreview?: (replyToId: string) => ReplyPreview | undefined;
    onRewind?: () => void;
    rewindDisabled?: boolean;
    activeContinuation?: ActiveContinuation;
    turnRecap?: TurnRecap;
    frameContent?: unknown;
    frameActionOwner?: MessageGroup["messages"][number] | null;
    latestAssistant?: boolean;
  };

// Each automatic load attempt costs 2 revisions (loading, then error), so
// this bounds auto-retries to 3 before the manual retry affordance takes over.
const FULL_MESSAGE_RETRY_REVISION_LIMIT = 6;

function prepareMessageActions(
  group: MessageGroup,
  item: MessageGroup["messages"][number],
  opts: RenderMessageGroupOptions,
): MessageActionDetails | null {
  const details = resolveMessageActionDetails({
    ...opts,
    message: item.message,
    messageId: item.key,
    canFetchFullMessage: Boolean(opts.loadFullAssistantMessage && opts.sessionKey),
    senderLabel: resolveMessageGroupSenderLabel(group, opts),
  });
  const messageId = details?.fullMessage?.messageId;
  if (messageId) {
    // Projected rows can share a source ID; a preceding row may have started its load.
    const expansion = opts.getAssistantMessageExpansion?.(messageId);
    // Retry transient failures on later renders, bounded so a dead loader cannot hot-loop.
    if (
      !expansion ||
      (expansion.status === "error" && expansion.revision < FULL_MESSAGE_RETRY_REVISION_LIMIT)
    ) {
      opts.onToggleAssistantMessageExpanded?.(messageId);
    }
  }
  return details;
}

function buildGroupedMessageRenderOptions(
  group: MessageGroup,
  item: MessageGroup["messages"][number],
  index: number,
  opts: RenderMessageGroupOptions,
  actionDetails: MessageActionDetails | null = prepareMessageActions(group, item, opts),
): GroupedMessageRenderOptions {
  let assistantMessageDisclosure: AssistantMessageDisclosure | undefined;
  const fullMessage = actionDetails?.fullMessage;
  if (fullMessage && opts.loadFullAssistantMessage && opts.onToggleAssistantMessageExpanded) {
    const { messageId, state: expansion } = fullMessage;
    const retriesExhausted =
      expansion?.status === "error" && expansion.revision >= FULL_MESSAGE_RETRY_REVISION_LIMIT;
    assistantMessageDisclosure = {
      expanded: expansion?.status === "loaded",
      ...(expansion?.status === "loaded" ? { markdown: actionDetails?.markdown } : {}),
      // Manual re-entry once the bounded automatic retries gave up.
      ...(retriesExhausted
        ? { onRetryFullMessage: () => opts.onToggleAssistantMessageExpanded?.(messageId) }
        : {}),
    };
  }
  return {
    ...opts,
    isStreaming: group.isStreaming && index === group.messages.length - 1,
    entryId: persistedMessageEntryId(item.message) ?? undefined,
    entryAnimated:
      normalizeRoleForGrouping(group.role) === "user" &&
      shouldAnimateUserTurnEntry(item.key, item.message),
    duplicateCount: item.duplicateCount ?? 1,
    showToolCalls: opts.showToolCalls ?? true,
    autoExpandToolCalls: opts.autoExpandToolCalls ?? false,
    assistantMessageDisclosure,
    messageActions: actionDetails,
  };
}

function isPeerSenderGroup(group: MessageGroup, userId: string | null | undefined): boolean {
  const identity = group.sender?.identity;
  return Boolean(
    group.sender && !(userId && identity?.type === "profile" && identity.id === userId),
  );
}

export function renderActivityGroup(
  groups: readonly MessageGroup[],
  opts: RenderMessageGroupOptions,
  presentation: "standalone" | "continuation" = "standalone",
) {
  const firstGroup = groups[0];
  if (!firstGroup || opts.showToolCalls === false) {
    return nothing;
  }
  const cards = groups.flatMap((group) =>
    group.messages.flatMap((item) => extractToolCardsCached(item.message)),
  );
  const latestGroup = groups[groups.length - 1] ?? firstGroup;
  const latestCards = latestGroup.messages.flatMap((item) => extractToolCardsCached(item.message));
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
  const approvalReviews = cards.flatMap((card) => readToolApprovalReviews(card.details));
  const recordedReviewOutcomes = cards.flatMap((card) => {
    const outcome = readToolApprovalReviewOutcome(card.details);
    return outcome ? [outcome] : [];
  });
  const reviewOutcome = resolveToolApprovalReviewOutcome(approvalReviews, recordedReviewOutcomes);
  const reviewer = approvalReviews[0]?.label ?? "Review";
  const reviewAriaLabel = reviewOutcome
    ? t(`chat.toolCards.review.${reviewOutcome === "reviewing" ? "reviewing" : reviewOutcome}`, {
        reviewer,
      })
    : "";
  const content = html`
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
            opts.onToggleToolMessageExpanded?.(activityDisclosureId, activityExpanded);
          }
        }}
      >
        <span class="chat-activity-group__icon">${icons.listTree}</span>
        <span class="chat-tool-disclosure__content">
          <span class="chat-activity-group__label" title=${groupSummaryLabel}
            >${groupSummaryLabel}</span
          >
        </span>
        ${reviewOutcome
          ? html`<span
              class="chat-activity-group__review-status"
              data-outcome=${reviewOutcome}
              role="img"
              aria-label=${reviewAriaLabel}
              >${reviewOutcome === "denied"
                ? icons.shieldX
                : reviewOutcome === "reviewing"
                  ? icons.shieldQuestion
                  : icons.shieldCheck}</span
            >`
          : nothing}
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
      ${renderBrowserTabPreviews(groups, opts)}
    </div>
  `;
  return presentation === "continuation"
    ? content
    : html`
        <div
          class="chat-group tool chat-group--activity chat-group--with-footer"
          data-chat-row-key=${firstGroup.key}
        >
          <div class="chat-group-messages">${content}</div>
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

function isActivityMessageGroup(group: MessageGroup): boolean {
  if (normalizeRoleForGrouping(group.role) !== "tool") {
    return false;
  }
  const cards = group.messages.flatMap((item) => extractToolCardsCached(item.message));
  return (
    group.messages.length > 1 ||
    cards.length > 1 ||
    cards.some((card) => readToolApprovalReviews(card.details).length > 0)
  );
}

export function renderMessageGroupContent(group: MessageGroup, opts: RenderMessageGroupOptions) {
  if (isActivityMessageGroup(group)) {
    return renderActivityGroup([group], opts, "continuation");
  }
  const messages = group.messages.map((item, index) =>
    renderGroupedMessage(
      item.message,
      item.key,
      buildGroupedMessageRenderOptions(group, item, index, opts),
      opts.onOpenSidebar,
    ),
  );
  return html`${messages}${opts.showToolCalls === false
    ? nothing
    : renderBrowserTabPreviews([group], opts)}`;
}

export function renderMessageGroup(group: MessageGroup, opts: RenderMessageGroupOptions) {
  const normalizedRole = normalizeRoleForGrouping(group.role);
  const isWorkspaceConflict = group.messages.every((item) =>
    Boolean(workspaceResultConflictFromTranscript(item.message)),
  );
  const assistantName = opts.assistantName ?? "Assistant";
  const isPeerGroup = normalizedRole === "user" && isPeerSenderGroup(group, opts.userId);
  const isForwarded = normalizedRole === "assistant" && hasForwardedSource(group);
  const sourceSessionKey = group.senderSession?.sessionKey;
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
  const assistantAvatarIdentity = { name: assistantName, avatar: opts.assistantAvatar ?? null };
  const persistUserIdentity = normalizedRole === "user" && showAvatarGutter;

  // Aggregate usage/cost/model across all messages in the group
  const meta = extractGroupMeta(group, opts.contextWindow ?? null);

  if (normalizedRole === "tool" && opts.showToolCalls === false) {
    return nothing;
  }

  if (isActivityMessageGroup(group)) {
    return renderActivityGroup([group], opts);
  }

  const ownsRunFrame = opts.frameContent !== undefined;
  const actionOwners = ownsRunFrame
    ? opts.frameActionOwner
      ? [opts.frameActionOwner]
      : []
    : group.messages;
  const messageActionDetails = actionOwners.map((item) => prepareMessageActions(group, item, opts));
  const lastMessageIndex = group.messages.length - 1;
  const footerActionDetails = ownsRunFrame
    ? (messageActionDetails[0] ?? null)
    : (messageActionDetails[lastMessageIndex] ?? null);
  const footerActionMessageKey = ownsRunFrame
    ? opts.frameActionOwner?.key
    : group.messages[lastMessageIndex]?.key;
  const hasUserFooterActions =
    normalizedRole === "user" &&
    Boolean(
      (footerActionDetails?.replyTarget && opts.onReply) ||
      opts.onRewind ||
      footerActionDetails?.markdown,
    );
  const userFooterActions = hasUserFooterActions
    ? html`
        <div
          class="chat-group-footer-actions"
          data-message-actions-for=${footerActionMessageKey ?? nothing}
        >
          ${footerActionDetails?.replyTarget && opts.onReply
            ? renderReplyButton(footerActionDetails.replyTarget, opts.onReply)
            : nothing}
          ${opts.onRewind
            ? renderRewindButton(opts.onRewind, Boolean(opts.rewindDisabled))
            : nothing}
          ${footerActionDetails?.markdown
            ? renderMessageActionButtons(footerActionDetails, {})
            : nothing}
        </div>
      `
    : nothing;

  // Source sessions share the stable sender hue machinery; CSS owns contrast
  // in each theme. Unattributed local messages keep the accent skin.
  const senderHue =
    isForwarded && sourceSessionKey
      ? resolveIdentityHue({ id: sourceSessionKey })
      : normalizedRole === "user" && group.sender
        ? resolveIdentityHue(group.sender)
        : null;
  const sendFailure = readPendingSendFailure(group.messages.at(-1)?.message);
  const replyToLabel =
    normalizedRole === "assistant" ? formatSenderLabel(group.replyToSender) : null;
  const replyToTitle = replyToLabel ? t("chat.messages.replyingTo", { name: replyToLabel }) : null;

  return html`
    <div
      class="chat-group ${roleClass} chat-group--with-footer${opts.latestAssistant
        ? " chat-group--latest-assistant"
        : ""}${isPeerGroup ? " chat-group--peer" : ""}${isForwarded
        ? " chat-group--forwarded"
        : ""}${senderHue === null ? "" : " chat-group--sender-tint"}"
      style=${senderHue === null ? nothing : `--chat-sender-hue: ${senderHue}`}
      data-chat-row-key=${group.key}
    >
      ${normalizedRole !== "tool" &&
      showAvatarGutter &&
      (isForwarded || normalizedRole !== "assistant" || opts.showAssistantAvatar !== false)
        ? isForwarded
          ? renderForwardedAvatar(group.senderSession?.agentId, opts)
          : renderChatAvatar(
              group.role,
              assistantAvatarIdentity,
              {
                name: opts.userName ?? null,
                avatar: opts.userAvatar ?? null,
              },
              opts.resourceBasePath,
              opts.assistantAttachmentAuthToken,
              group.sender,
            )
        : nothing}
      <div class="chat-group-messages">
        ${isForwarded ? renderForwardedAttribution(group, opts) : nothing}
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
        ${opts.frameContent ??
        group.messages.map((item, index) => {
          const actionDetails = messageActionDetails[index];
          return html`
            ${renderGroupedMessage(
              item.message,
              item.key,
              buildGroupedMessageRenderOptions(group, item, index, opts, actionDetails),
              opts.onOpenSidebar,
            )}
            ${actionDetails && index < lastMessageIndex && !ownsRunFrame
              ? html`
                  <div class="chat-message-actions-row" data-message-actions-for=${item.key}>
                    ${renderMessageActionButtons(actionDetails, opts)}
                  </div>
                `
              : nothing}
          `;
        })}
        ${ownsRunFrame || opts.showToolCalls === false
          ? nothing
          : renderBrowserTabPreviews([group], opts)}
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
      ${normalizedRole === "tool" || group.isStreaming || opts.activeContinuation
        ? nothing
        : html`<div
            class="chat-group-footer ${persistUserIdentity
              ? "chat-group-footer--persistent-identity"
              : ""}${sendFailure ? " chat-group-footer--send-failure" : ""}"
          >
            <div class="chat-group-footer__meta">
              ${isPeerGroup ? nothing : userFooterActions}
              ${normalizedRole === "user" && !showAvatarGutter
                ? renderChatAuthorAvatar(group.sender)
                : nothing}
              ${isForwarded
                ? nothing
                : renderPersonName(
                    who,
                    // Only other people's messages: your own name links nowhere useful.
                    isPeerGroup && group.sender?.identity?.type === "profile"
                      ? personActivityLink(group.sender.identity.id, opts.personActivity)
                      : null,
                    "chat-sender-name",
                  )}
              ${renderChatSendStatus(sendFailure, opts)} ${renderMessageMeta(group.timestamp, meta)}
            </div>
            ${isPeerGroup
              ? userFooterActions
              : normalizedRole !== "user" && footerActionDetails
                ? html`
                    <div
                      class="chat-group-footer-actions"
                      data-message-actions-for=${footerActionMessageKey ?? nothing}
                    >
                      ${renderMessageActionButtons(footerActionDetails, opts)}
                    </div>
                  `
                : nothing}
          </div>`}
    </div>
  `;
}
