// Pane-local search, context menus, selection actions, and presentation resets.
import { html, nothing, type TemplateResult } from "lit";
import { ref } from "lit/directives/ref.js";
import type { ChatPendingInputsPage } from "../../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import type { GatewayBrowserClient } from "../../../api/gateway.ts";
import type {
  AgentsListResult,
  GatewaySessionRow,
  SessionsListResult,
} from "../../../api/types.ts";
import type { QuestionPrompt } from "../../../app/question-prompt.ts";
import { copyMarkdownLabel, handleCopyButton } from "../../../components/copy-button.ts";
import { icons } from "../../../components/icons.ts";
import type { ImageLightboxItem } from "../../../components/image-lightbox.ts";
import type { SessionLinkTarget } from "../../../components/markdown-session-links.ts";
import { releaseMarkdownTables } from "../../../components/markdown-tables.ts";
import type { PersonActivityRouting } from "../../../components/person-activity-link.ts";
import "../../../components/tooltip.ts";
import { t } from "../../../i18n/index.ts";
import type { BoardProvider } from "../../../lib/board/provider.ts";
import type {
  ChatGuardianNotice,
  ChatQueueItem,
  ChatStreamSegment,
} from "../../../lib/chat/chat-types.ts";
import { buildCompanionQuestionPrefill } from "../../../lib/chat/companion-question.ts";
import type { EmbedSandboxMode } from "../../../lib/chat/tool-display.ts";
import type { UiSessionDefaultsHost } from "../../../lib/sessions/session-key.ts";
import type { TurnRecapWatch } from "../chat-progress.ts";
import { resetChatThreadState } from "../chat-thread.ts";
import type { LinkFaviconFetcher } from "../link-favicon-loader.ts";
import type { RealtimeTalkConversationEntry } from "../realtime-talk-conversation.ts";
import type { ChatRunUiStatus } from "../run-lifecycle.ts";
import type { CompactionStatus, RunOutputUsage } from "../tool-stream-contract.ts";
import type { BackgroundTasksProps } from "./chat-background-tasks.types.ts";
import type { ChatHistoryBoundaryProps } from "./chat-history-boundary.ts";
import type { MessageActionDetails } from "./chat-message-markdown.ts";
import type { ArtifactDownloadResolver } from "./chat-message-media.ts";
import type { ChatSendStatusActions } from "./chat-message-send-status.ts";
import {
  dismissConfirmedActionPopovers,
  openChatRewindConfirmation,
  type MessageReplyTarget,
} from "./chat-message.ts";
import { handleChatSelectionPointerUp, removeChatSelectionPopup } from "./chat-selection-popup.ts";
import type { SidebarContent, SidebarFullMessageLoader } from "./chat-sidebar.ts";

export type ChatThreadState = {
  turnRecapWatch: TurnRecapWatch | null;
  searchOpen: boolean;
  searchQuery: string;
  searchFocusPending: boolean;
  searchReturnFocusTarget: HTMLElement | null;
  searchReturnFocusOwner: HTMLElement | null;
  transcriptRenderDependencies: readonly unknown[];
  transcriptRenderContext: {
    onSetReply?: (target: MessageReplyTarget) => void;
    onOpenReply?: (replyToId: string) => void;
  };
};

type ReplyMessageAccess = {
  revision: number;
  navigationId: string | null;
  read: (messageId: string) => unknown;
  request: (messageId: string) => void;
  open: (messageId: string) => void;
};

export type ChatThreadProps = ChatSendStatusActions & {
  compactionStatus?: CompactionStatus | null;
  paneId: string;
  /** Routing for peer sender names in a shared session. */
  personActivity?: PersonActivityRouting;
  sessionKey: string;
  presented?: boolean;
  gatewayClient?: GatewayBrowserClient | null;
  selectedSession: GatewaySessionRow | undefined;
  boardProvider?: BoardProvider;
  announceTranscript?: boolean;
  loading: boolean;
  /** Older-history pagination: renders the auto-load sentinel plus the in-flow boundary row. */
  historyPagination?: ChatHistoryBoundaryProps;
  messages: unknown[];
  toolMessages: unknown[];
  browserTabPreviewsActive?: boolean;
  guardianNotices?: ChatGuardianNotice[];
  streamSegments: ChatStreamSegment[];
  stream: string | null;
  streamStartedAt: number | null;
  /** Browser-local active run identity, retained across transient disconnects. */
  runId?: string | null;
  runUsageById?: ReadonlyMap<string, RunOutputUsage>;
  runStatus?: ChatRunUiStatus | null;
  queue: ChatQueueItem[];
  pendingInputs?: ChatPendingInputsPage["items"];
  showThinking: boolean;
  showToolCalls: boolean;
  persistCommentary?: boolean;
  runActive?: boolean;
  runWorking?: boolean;
  startupLabel?: string;
  waitingApproval?: boolean;
  questionPrompts?: readonly QuestionPrompt[];
  sessions: SessionsListResult | null;
  /** Host context resolving global-alias session keys (scope=global fleets). */
  sessionHost?: UiSessionDefaultsHost | null;
  assistantName: string;
  assistantAvatar: string | null;
  senderAgentAvatars?: ReadonlyMap<string, string | null>;
  agents?: AgentsListResult["agents"];
  /** Configured main-session key; an agent's main source labels as the agent. */
  mainKey?: string;
  currentAgentId?: string;
  assistantAvatarUrl?: string | null;
  userId?: string | null;
  userName?: string | null;
  userAvatar?: string | null;
  basePath?: string;
  resourceBasePath?: string;
  fullMessageAgentId?: string;
  loadFullAssistantMessage?: SidebarFullMessageLoader | null;
  localMediaPreviewRoots?: string[];
  mediaPolicyEpoch?: number;
  connectionEpoch?: number;
  assistantAttachmentAuthToken?: string | null;
  resolveArtifactDownload?: ArtifactDownloadResolver;
  canvasPluginSurfaceUrl?: string | null;
  embedSandboxMode?: EmbedSandboxMode;
  allowExternalEmbedUrls?: boolean;
  fetchLinkFavicon?: LinkFaviconFetcher;
  autoExpandToolCalls?: boolean;
  realtimeTalkConversation?: RealtimeTalkConversationEntry[];
  typingActors?: readonly { id: string; label: string; preview?: string }[];
  onOpenSidebar?: (content: SidebarContent) => void;
  onOpenWorkspaceFile?: (target: { path: string; line?: number | null }) => void;
  onOpenSessionLink?: (target: SessionLinkTarget) => void;
  onOpenSessionCheckpoints?: () => void | Promise<void>;
  onRequestOpenImage?: () => number;
  onOpenImage?: (item: ImageLightboxItem, requestVersion?: number) => void;
  onAssistantAttachmentLoaded?: () => void;
  onRequestUpdate?: () => void;
  onChatScroll?: (event: Event) => void;
  onHistoryIntent?: (event: Event) => void;
  onDraftChange: (next: string) => void;
  onSend: () => void;
  onSetReply?: (target: MessageReplyTarget) => void;
  replyMessageAccess?: ReplyMessageAccess;
  onRewindMessage?: (entryId: string) => Promise<boolean> | boolean;
  onForkMessage?: (entryId: string) => Promise<void> | void;
  onFocusComposer?: () => void;
  onCompanionPrefill?: (question: string) => void;
  onOpenSession?: (sessionKey: string) => void;
  modelSetupRequired?: boolean;
  onModelSetup?: () => void;
  backgroundTasks?: BackgroundTasksProps;
};

type TranscriptInteractionProps = Pick<
  ChatThreadProps,
  | "paneId"
  | "runActive"
  | "runWorking"
  | "onSetReply"
  | "onRewindMessage"
  | "onForkMessage"
  | "onFocusComposer"
  | "onCompanionPrefill"
>;

function createTranscriptState(): ChatThreadState {
  return {
    turnRecapWatch: null,
    searchOpen: false,
    searchQuery: "",
    searchFocusPending: false,
    searchReturnFocusTarget: null,
    searchReturnFocusOwner: null,
    transcriptRenderDependencies: [],
    transcriptRenderContext: {},
  };
}

const transcriptStates = new Map<string, ChatThreadState>();

export function getTranscriptState(paneId: string): ChatThreadState {
  const existing = transcriptStates.get(paneId);
  if (existing) {
    return existing;
  }
  const state = createTranscriptState();
  transcriptStates.set(paneId, state);
  return state;
}

export function dismissThreadPortals(paneId?: string, owner?: ParentNode): void {
  removeReplyContextMenu(paneId);
  if (owner) {
    dismissConfirmedActionPopovers(owner);
  }
  // The selection popup is body-portaled; pane teardown/route changes must
  // drop it so it cannot outlive the render that owns its callbacks.
  removeChatSelectionPopup();
}

export function resetTranscriptSession(paneId: string, owner?: ParentNode): void {
  dismissThreadPortals(paneId, owner);
  // Retained panes keep their DOM, so their native table modals need explicit retirement.
  owner?.querySelectorAll<HTMLElement>(".chat-thread").forEach(releaseMarkdownTables);
  const state = transcriptStates.get(paneId);
  if (state) {
    // Search input belongs to the outgoing transcript. Other fields are pane
    // preferences or dependency memos and invalidate themselves on new props.
    state.searchOpen = false;
    state.searchQuery = "";
    state.searchFocusPending = false;
    state.searchReturnFocusTarget = null;
    state.searchReturnFocusOwner = null;
  }
}

export function resetThreadPresentation(paneId?: string, owner?: ParentNode) {
  dismissThreadPortals(paneId, owner);
  if (paneId) {
    transcriptStates.delete(paneId);
    resetChatThreadState(paneId);
  } else {
    transcriptStates.clear();
    resetChatThreadState();
  }
}

export function renderTranscriptSearch(
  paneId: string,
  requestUpdate: () => void,
): TemplateResult | typeof nothing {
  const state = getTranscriptState(paneId);
  if (!state.searchOpen) {
    return nothing;
  }
  return html`
    <div class="agent-chat__search-bar">
      ${icons.search}
      <input
        type="text"
        placeholder=${t("chat.thread.searchPlaceholder")}
        aria-label=${t("chat.thread.search")}
        .value=${state.searchQuery}
        ${
          state.searchFocusPending
            ? ref((element) => {
                if (element instanceof HTMLInputElement) {
                  state.searchFocusPending = false;
                  queueMicrotask(() => {
                    if (element.isConnected) {
                      element.focus({ preventScroll: true });
                    }
                  });
                }
              })
            : nothing
        }
        @input=${(event: Event) => {
          state.searchQuery = (event.target as HTMLInputElement).value;
          requestUpdate();
        }}
      />
      <openclaw-tooltip .content=${t("chat.thread.closeSearch")}>
        <button
          class="btn btn--ghost"
          aria-label=${t("chat.thread.closeSearch")}
          @click=${() => closeTranscriptSearch(state, requestUpdate)}
        >
          ${icons.x}
        </button>
      </openclaw-tooltip>
    </div>
  `;
}

export function closeTranscriptSearch(state: ChatThreadState, requestUpdate: () => void): void {
  const returnFocusTarget = state.searchReturnFocusTarget;
  const returnFocusOwner = state.searchReturnFocusOwner;
  state.searchOpen = false;
  state.searchQuery = "";
  state.searchFocusPending = false;
  state.searchReturnFocusTarget = null;
  state.searchReturnFocusOwner = null;
  requestUpdate();
  queueMicrotask(() => {
    const target = returnFocusTarget?.isConnected
      ? returnFocusTarget
      : returnFocusOwner?.querySelector<HTMLTextAreaElement>(
          ".agent-chat__composer-combobox > textarea",
        );
    target?.focus({ preventScroll: true });
  });
}

/** Toggles transcript search and retains the shortcut origin for focus restoration. */
export function toggleTranscriptSearch(
  paneId: string,
  requestUpdate: () => void,
  triggerEvent?: Event,
): void {
  const state = getTranscriptState(paneId);
  if (state.searchOpen) {
    closeTranscriptSearch(state, requestUpdate);
    return;
  }

  state.searchOpen = true;
  state.searchFocusPending = true;
  const returnFocusTarget = triggerEvent?.target;
  const returnFocusOwner = triggerEvent?.currentTarget;
  state.searchReturnFocusTarget =
    returnFocusTarget instanceof HTMLElement && returnFocusTarget.isConnected
      ? returnFocusTarget
      : null;
  state.searchReturnFocusOwner =
    returnFocusOwner instanceof HTMLElement && returnFocusOwner.isConnected
      ? returnFocusOwner
      : null;
  requestUpdate();
}

let activeReplyContextMenu: {
  element: HTMLElement;
  paneId: string;
  listeners: AbortController;
} | null = null;

function removeReplyContextMenu(paneId?: string) {
  const owner = activeReplyContextMenu;
  if (paneId && paneId !== owner?.paneId) {
    return;
  }
  if (owner) {
    dismissConfirmedActionPopovers(owner.element);
    owner.element.remove();
  }
  activeReplyContextMenu = null;
  const fallbackMenu = document.querySelector<HTMLElement>(".chat-reply-context-menu");
  if (fallbackMenu) {
    dismissConfirmedActionPopovers(fallbackMenu);
    fallbackMenu.remove();
  }
  owner?.listeners.abort();
}

function createReplyContextMenuButton(onClick: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.setAttribute("role", "menuitem");
  button.setAttribute("aria-label", t("chat.messages.replyToMessage"));
  button.textContent = t("chat.messages.reply");
  button.addEventListener("click", onClick);
  return button;
}

function createMessageActionContextButton(params: {
  label: string;
  disabled: boolean;
  tooltip: string;
  onClick: (event: Event) => void;
}): { element: HTMLElement; button: HTMLButtonElement } {
  const button = document.createElement("button");
  button.type = "button";
  button.disabled = params.disabled;
  button.setAttribute("role", "menuitem");
  const label = document.createElement("span");
  label.dataset.copyLabel = "";
  label.textContent = params.label;
  button.append(label);
  button.addEventListener("click", params.onClick);
  const tooltip = document.createElement("openclaw-tooltip");
  tooltip.content = params.tooltip;
  tooltip.append(button);
  return { element: tooltip, button };
}

function toggleTouchMessageMeta(event: PointerEvent): void {
  const transcript = event.currentTarget;
  const target = event.target;
  if (
    event.pointerType !== "touch" ||
    !(transcript instanceof HTMLElement) ||
    !(target instanceof Element)
  ) {
    return;
  }
  const group = target.closest(".chat-group--with-footer");
  if (
    !(group instanceof HTMLElement) ||
    !transcript.contains(group) ||
    target.closest("a, button, details, input, label, select, textarea, [contenteditable]")
  ) {
    return;
  }
  const selection = window.getSelection();
  if (selection && !selection.isCollapsed) {
    return;
  }
  const reveal = !group.classList.contains("chat-group--meta-revealed");
  for (const revealed of transcript.querySelectorAll(".chat-group--meta-revealed")) {
    revealed.classList.remove("chat-group--meta-revealed");
  }
  group.classList.toggle("chat-group--meta-revealed", reveal);
}

export function handleTranscriptPointerUp(event: PointerEvent, props: TranscriptInteractionProps) {
  toggleTouchMessageMeta(event);
  if (event.button !== 0 || event.ctrlKey || typeof props.onCompanionPrefill !== "function") {
    return;
  }
  handleChatSelectionPointerUp(event, {
    onAskSideChat: (selection) => {
      const question = buildCompanionQuestionPrefill(selection);
      if (question) {
        props.onCompanionPrefill?.(question);
      }
    },
  });
}

function selectionIntersectsElement(selection: Selection | null, element: Element): boolean {
  if (!selection || selection.isCollapsed) {
    return false;
  }
  for (let index = 0; index < selection.rangeCount; index += 1) {
    if (selection.getRangeAt(index).intersectsNode(element)) {
      return true;
    }
  }
  return false;
}

export function handleTranscriptContextMenu(event: MouseEvent, props: TranscriptInteractionProps) {
  if (event.composedPath().some((target) => target instanceof HTMLAnchorElement)) {
    return;
  }
  const bubble = (event.target as HTMLElement).closest<
    HTMLElement & { messageActions?: MessageActionDetails | null }
  >(".chat-bubble");
  if (!bubble) {
    return;
  }
  const group = bubble.closest<HTMLElement>(".chat-group");
  if (!group) {
    return;
  }
  if (
    group.querySelector(".chat-reading-indicator") ||
    group.querySelector(".chat-bubble.streaming")
  ) {
    return;
  }
  // The menu and footer consume the same target, including attachment-only replies.
  const replyTarget = bubble.messageActions?.replyTarget;
  const entryId = bubble.dataset.entryId?.trim() ?? "";
  const messageId = bubble.dataset.messageId?.trim() ?? "";
  const isUserMessage = group.classList.contains("user") && Boolean(entryId);
  // Grouped rows can contain several bubbles. Match the clicked bubble to its
  // own action owner so copy never targets a sibling message.
  const actionOwner = [...group.querySelectorAll<HTMLElement>("[data-message-actions-for]")].find(
    (element) => element.dataset.messageActionsFor === messageId,
  );
  const copyButton = actionOwner?.querySelector<HTMLButtonElement>(".chat-copy-btn");
  const ownsRunFrame = group.dataset.chatRowKey?.startsWith("agent-run:") === true;
  const canReply = Boolean(replyTarget && props.onSetReply && (!ownsRunFrame || actionOwner));
  const canRewind = isUserMessage && typeof props.onRewindMessage === "function";
  const canCopy = Boolean(copyButton);
  const canFork = isUserMessage && typeof props.onForkMessage === "function";
  if (!canReply && !canRewind && !canCopy && !canFork) {
    return;
  }

  const selection = window.getSelection();
  const selectedText = selectionIntersectsElement(selection, bubble) ? selection?.toString() : "";

  event.preventDefault();
  event.stopPropagation();
  removeReplyContextMenu();
  const menu = document.createElement("div");
  menu.className = "chat-reply-context-menu";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", t("chat.messages.actions"));
  menu.style.left = `${event.clientX}px`;
  menu.style.top = `${event.clientY}px`;
  const focusCandidates: HTMLButtonElement[] = [];
  if (selectedText) {
    const action = createMessageActionContextButton({
      label: t("chat.messages.copySelection"),
      disabled: false,
      tooltip: t("chat.messages.copySelection"),
      onClick: (copyEvent) => {
        void handleCopyButton(copyEvent, selectedText, t("chat.messages.copySelection")).then(
          (copied) => {
            if (copied) {
              removeReplyContextMenu(props.paneId);
            }
          },
        );
      },
    });
    menu.append(action.element);
    focusCandidates.push(action.button);
  }
  if (canReply && replyTarget) {
    const replyButton = createReplyContextMenuButton(() => {
      props.onSetReply?.(replyTarget);
      removeReplyContextMenu();
      props.onFocusComposer?.();
    });
    menu.append(replyButton);
    focusCandidates.push(replyButton);
  }
  const working = Boolean(props.runActive || props.runWorking);
  if (canRewind) {
    const action = createMessageActionContextButton({
      label: t("chat.messages.rewindToHere"),
      disabled: working,
      tooltip: working ? t("chat.messages.rewindUnavailable") : t("chat.messages.rewindToHere"),
      onClick: () => {
        openChatRewindConfirmation(action.button, () => {
          removeReplyContextMenu();
          void Promise.resolve(props.onRewindMessage?.(entryId)).then((rewound) => {
            if (rewound) {
              props.onFocusComposer?.();
            }
          });
        });
      },
    });
    action.element.classList.add("chat-confirm-wrap", "chat-rewind-wrap");
    menu.append(action.element);
    focusCandidates.push(action.button);
  }
  if (canCopy) {
    const action = createMessageActionContextButton({
      label: copyMarkdownLabel(),
      disabled: false,
      tooltip: copyMarkdownLabel(),
      onClick: () => {
        removeReplyContextMenu();
        copyButton?.click();
      },
    });
    menu.append(action.element);
    focusCandidates.push(action.button);
  }
  if (canFork) {
    const action = createMessageActionContextButton({
      label: t("chat.messages.forkFromHere"),
      disabled: working,
      tooltip: working ? t("chat.messages.forkUnavailable") : t("chat.messages.forkFromHere"),
      onClick: () => {
        removeReplyContextMenu();
        void props.onForkMessage?.(entryId);
      },
    });
    menu.append(action.element);
    focusCandidates.push(action.button);
  }
  document.body.appendChild(menu);
  const owner = { element: menu, paneId: props.paneId, listeners: new AbortController() };
  activeReplyContextMenu = owner;

  const menuRect = menu.getBoundingClientRect();
  let left = event.clientX;
  let top = event.clientY;
  if (left + menuRect.width > window.innerWidth) {
    left = window.innerWidth - menuRect.width - 8;
  }
  if (top + menuRect.height > window.innerHeight) {
    top = window.innerHeight - menuRect.height - 8;
  }
  menu.style.left = `${Math.max(0, left)}px`;
  menu.style.top = `${Math.max(0, top)}px`;
  focusCandidates.find((button) => !button.disabled)?.focus();
  requestAnimationFrame(() => {
    if (!menu.isConnected || activeReplyContextMenu !== owner) {
      return;
    }
    const handleOutsideEvent = (nextEvent: MouseEvent) => {
      if (!menu.contains(nextEvent.target as Node | null)) {
        removeReplyContextMenu();
      }
    };
    const handleKeydown = (nextEvent: KeyboardEvent) => {
      if (nextEvent.key === "Escape") {
        nextEvent.preventDefault();
        nextEvent.stopPropagation();
        removeReplyContextMenu();
        props.onFocusComposer?.();
      }
    };
    const { signal } = owner.listeners;
    document.addEventListener("click", handleOutsideEvent, { signal });
    // Capture closes this owner even when the next menu stops event propagation.
    document.addEventListener("contextmenu", handleOutsideEvent, { capture: true, signal });
    document.addEventListener("keydown", handleKeydown, { signal });
  });
}
