// Pane-local search, context menus, selection actions, and presentation resets.
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { html, nothing, type TemplateResult } from "lit";
import { ref } from "lit/directives/ref.js";
import type { SessionsListResult } from "../../../api/types.ts";
import type { QuestionPrompt } from "../../../app/question-prompt.ts";
import { copyMarkdownLabel } from "../../../components/copy-button.ts";
import { icons } from "../../../components/icons.ts";
import type { ImageLightboxItem } from "../../../components/image-lightbox.ts";
import "../../../components/tooltip.ts";
import { t } from "../../../i18n/index.ts";
import type { BoardProvider } from "../../../lib/board/provider.ts";
import type { ChatQueueItem, ChatStreamSegment } from "../../../lib/chat/chat-types.ts";
import {
  buildCompanionQuestionPrefill,
  buildMoreDetailsCompanionQuestion,
} from "../../../lib/chat/companion-question.ts";
import type { EmbedSandboxMode } from "../../../lib/chat/tool-display.ts";
import { copyToClipboard } from "../../../lib/clipboard.ts";
import { fnv1aUtf16 } from "../../../lib/fnv1a.ts";
import type { UiSessionDefaultsHost } from "../../../lib/sessions/session-key.ts";
import type { ChatRunStartupStatus } from "../chat-run-startup.ts";
import { resetChatThreadState } from "../chat-thread.ts";
import type { RealtimeTalkConversationEntry } from "../realtime-talk-conversation.ts";
import type { PlanStatus } from "../tool-stream.ts";
import type { BackgroundTasksProps } from "./chat-background-tasks.types.ts";
import type { ArtifactDownloadResolver } from "./chat-message-media.ts";
import {
  dismissConfirmedActionPopovers,
  openChatRewindConfirmation,
  type MessageReplyTarget,
} from "./chat-message.ts";
import { handleChatSelectionPointerUp, removeChatSelectionPopup } from "./chat-selection-popup.ts";
import type { SidebarContent, SidebarFullMessageLoader } from "./chat-sidebar.ts";

export type ChatThreadState = {
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

export type ReplyMessageAccess = {
  revision: number;
  navigationId: string | null;
  read: (messageId: string) => unknown;
  request: (messageId: string) => void;
  open: (messageId: string) => void;
};

export type ChatThreadProps = {
  paneId: string;
  sessionKey: string;
  boardProvider?: BoardProvider;
  announceTranscript?: boolean;
  loading: boolean;
  historyPagination?: { loading: boolean };
  messages: unknown[];
  toolMessages: unknown[];
  streamSegments: ChatStreamSegment[];
  stream: string | null;
  streamStartedAt: number | null;
  runId?: string | null;
  runOutputTokens?: number | null;
  queue: ChatQueueItem[];
  showThinking: boolean;
  showToolCalls: boolean;
  persistCommentary?: boolean;
  runActive?: boolean;
  runWorking?: boolean;
  startupStatus?: ChatRunStartupStatus | null;
  waitingApproval?: boolean;
  planStatus?: PlanStatus | null;
  questionPrompts?: readonly QuestionPrompt[];
  sessions: SessionsListResult | null;
  sessionHost?: UiSessionDefaultsHost | null;
  assistantName: string;
  assistantAvatar: string | null;
  assistantAvatarUrl?: string | null;
  userId?: string | null;
  userName?: string | null;
  userAvatar?: string | null;
  basePath?: string;
  fullMessageAgentId?: string;
  loadFullAssistantMessage?: SidebarFullMessageLoader | null;
  localMediaPreviewRoots?: string[];
  assistantAttachmentAuthToken?: string | null;
  resolveArtifactDownload?: ArtifactDownloadResolver;
  canvasPluginSurfaceUrl?: string | null;
  embedSandboxMode?: EmbedSandboxMode;
  allowExternalEmbedUrls?: boolean;
  autoExpandToolCalls?: boolean;
  realtimeTalkConversation?: RealtimeTalkConversationEntry[];
  onOpenSidebar?: (content: SidebarContent) => void;
  onOpenWorkspaceFile?: (target: { path: string; line?: number | null }) => void;
  onOpenSessionCheckpoints?: () => void | Promise<void>;
  onAssistantAttachmentLoaded?: () => void;
  onRequestOpenImage?: () => number;
  onOpenImage?: (item: ImageLightboxItem, requestVersion?: number) => void;
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
  onCompanionQuestion?: (question: string) => void;
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
  | "onCompanionQuestion"
  | "onCompanionPrefill"
>;

function createTranscriptState(): ChatThreadState {
  return {
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

function dismissThreadPortals(paneId?: string, owner?: ParentNode): void {
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
        ${state.searchFocusPending
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
          : nothing}
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

let activeReplyContextMenu: HTMLElement | null = null;
let activeReplyContextMenuPaneId: string | null = null;
let contextMenuDocumentClickHandler: ((event: MouseEvent) => void) | null = null;
let contextMenuDocumentContextMenuHandler: ((event: MouseEvent) => void) | null = null;
let contextMenuKeydownHandler: ((event: KeyboardEvent) => void) | null = null;

function removeReplyContextMenu(paneId?: string) {
  if (paneId && paneId !== activeReplyContextMenuPaneId) {
    return;
  }
  if (activeReplyContextMenu) {
    dismissConfirmedActionPopovers(activeReplyContextMenu);
    activeReplyContextMenu.remove();
  }
  activeReplyContextMenu = null;
  activeReplyContextMenuPaneId = null;
  const fallbackMenu = document.querySelector<HTMLElement>(".chat-reply-context-menu");
  if (fallbackMenu) {
    dismissConfirmedActionPopovers(fallbackMenu);
    fallbackMenu.remove();
  }
  if (contextMenuDocumentClickHandler) {
    document.removeEventListener("click", contextMenuDocumentClickHandler);
    contextMenuDocumentClickHandler = null;
  }
  if (contextMenuDocumentContextMenuHandler) {
    document.removeEventListener("contextmenu", contextMenuDocumentContextMenuHandler, true);
    contextMenuDocumentContextMenuHandler = null;
  }
  if (contextMenuKeydownHandler) {
    document.removeEventListener("keydown", contextMenuKeydownHandler);
    contextMenuKeydownHandler = null;
  }
}

function stableReplyMessageId(senderLabel: string | undefined, text: string): string {
  const source = `${senderLabel ?? ""}\n${text}`;
  return `reply:${fnv1aUtf16(source).toString(16)}`;
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
  onClick: () => void;
}): { element: HTMLElement; button: HTMLButtonElement } {
  const button = document.createElement("button");
  button.type = "button";
  button.disabled = params.disabled;
  button.setAttribute("role", "menuitem");
  button.setAttribute("aria-label", params.label);
  button.textContent = params.label;
  button.addEventListener("click", params.onClick);
  const tooltip = document.createElement("openclaw-tooltip");
  tooltip.content = params.tooltip;
  tooltip.append(button);
  return { element: tooltip, button };
}

export function handleTranscriptSelection(event: PointerEvent, props: TranscriptInteractionProps) {
  if (
    typeof props.onCompanionQuestion !== "function" ||
    typeof props.onCompanionPrefill !== "function"
  ) {
    return;
  }
  handleChatSelectionPointerUp(event, {
    onMoreDetails: (selection) => {
      const question = buildMoreDetailsCompanionQuestion(selection);
      if (question) {
        props.onCompanionQuestion?.(question);
      }
    },
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
  const bubble = (event.target as HTMLElement).closest(".chat-bubble");
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
  const senderEl = group.querySelector(".chat-sender-name");
  const senderLabel = senderEl?.textContent?.trim() ?? undefined;
  const text = truncateUtf16Safe((bubble as HTMLElement).dataset.messageText?.trim() ?? "", 500);
  const entryId = (bubble as HTMLElement).dataset.entryId?.trim() ?? "";
  const messageId = (bubble as HTMLElement).dataset.messageId?.trim() ?? "";
  const isUserMessage = group.classList.contains("user") && Boolean(entryId);
  // Grouped rows can contain several bubbles. Match the clicked bubble to its
  // own action owner so copy never targets a sibling message.
  const actionOwner = [...group.querySelectorAll<HTMLElement>("[data-message-actions-for]")].find(
    (element) => element.dataset.messageActionsFor === messageId,
  );
  const copyButton = actionOwner?.querySelector<HTMLButtonElement>(".chat-copy-btn");
  const canReply = Boolean(text && props.onSetReply);
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
      onClick: () => {
        void copyToClipboard(selectedText);
        removeReplyContextMenu();
      },
    });
    menu.append(action.element);
    focusCandidates.push(action.button);
  }
  if (canReply) {
    const replyMessageId = messageId || stableReplyMessageId(senderLabel, text);
    const replyButton = createReplyContextMenuButton(() => {
      props.onSetReply?.({
        messageId: replyMessageId,
        text,
        senderLabel,
        ...(entryId ? { sourceMessageId: entryId } : {}),
      });
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
  activeReplyContextMenu = menu;
  activeReplyContextMenuPaneId = props.paneId;

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
    if (!menu.isConnected || activeReplyContextMenu !== menu) {
      return;
    }
    contextMenuDocumentClickHandler = (nextEvent: MouseEvent) => {
      if (!menu.contains(nextEvent.target as Node | null)) {
        removeReplyContextMenu();
      }
    };
    contextMenuDocumentContextMenuHandler = (nextEvent: MouseEvent) => {
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
    contextMenuKeydownHandler = handleKeydown;
    document.addEventListener("click", contextMenuDocumentClickHandler);
    // Capture closes this owner even when the next menu stops event propagation.
    document.addEventListener("contextmenu", contextMenuDocumentContextMenuHandler, true);
    document.addEventListener("keydown", handleKeydown);
  });
}
