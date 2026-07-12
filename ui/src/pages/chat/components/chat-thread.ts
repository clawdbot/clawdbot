// Chat-owned message thread presentation and thread-local interaction state.
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { html, nothing, type TemplateResult } from "lit";
import { guard } from "lit/directives/guard.js";
import { ref } from "lit/directives/ref.js";
import { repeat } from "lit/directives/repeat.js";
import { classifySessionKind } from "../../../../../src/sessions/classify-session-kind.js";
import type { SessionsListResult } from "../../../api/types.ts";
import { beginNativeWindowDragFromTopInset } from "../../../app/native-window-drag.ts";
import { resolveLocalUserName } from "../../../app/user-identity.ts";
import { icons } from "../../../components/icons.ts";
import "../../../components/tooltip.ts";
import {
  handleMarkdownCodeBlockCopy,
  markdownFileLinkFromEvent,
} from "../../../components/markdown.ts";
import { CHAT_HISTORY_RENDER_LIMIT } from "../../../lib/chat/chat-types.ts";
import type { ChatQueueItem, ChatStreamSegment } from "../../../lib/chat/chat-types.ts";
import { extractTextCached } from "../../../lib/chat/message-extract.ts";
import {
  buildMoreDetailsSideCommand,
  combineSideChatComposerDraft,
} from "../../../lib/chat/side-question.ts";
import type { EmbedSandboxMode } from "../../../lib/chat/tool-display.ts";
import {
  areUiSessionKeysEquivalent,
  isUiGlobalScopeConfigured,
  parseAgentSessionKey,
  resolveUiGlobalAliasAgentId,
  type UiSessionDefaultsHost,
} from "../../../lib/sessions/session-key.ts";
import {
  buildCachedChatItems,
  coalesceStreamRuns,
  deletedChatItemsSignature,
  getExpandedToolCards,
  resetChatThreadState,
  stableBooleanMapSignature,
  syncToolCardExpansionState,
} from "../chat-thread.ts";
import { DeletedMessages } from "../deleted-messages.ts";
import { PinnedMessages } from "../pinned-messages.ts";
import type { RealtimeTalkConversationEntry } from "../realtime-talk-conversation.ts";
import { getOrCreateSessionCacheValue } from "../session-cache.ts";
import { getToolTitlesVersion } from "../tool-titles.ts";
import {
  getAssistantAttachmentAvailabilityRenderVersion,
  renderMessageGroup,
  renderStreamGroup,
} from "./chat-message.ts";
import { renderRealtimeTalkConversation } from "./chat-realtime-controls.ts";
import { handleChatSelectionPointerUp, removeChatSelectionPopup } from "./chat-selection-popup.ts";
import type { SidebarContent } from "./chat-sidebar.ts";
import { renderWelcomeState, resolveAssistantDisplayAvatar } from "./chat-welcome.ts";

const pinnedMessagesMap = new Map<string, PinnedMessages>();
const deletedMessagesMap = new Map<string, DeletedMessages>();
const INITIAL_CHAT_HISTORY_RENDER_WINDOW = 30;
const CHAT_HISTORY_RENDER_WINDOW_BATCH = 30;
const CHAT_HISTORY_RENDER_EXPAND_SCROLL_TOP_PX = 48;

type ReplyTarget = {
  messageId: string;
  text: string;
  senderLabel?: string | null;
};

type ChatThreadState = {
  searchOpen: boolean;
  searchQuery: string;
  pinnedExpanded: boolean;
  historyRenderSessionKey: string | null;
  historyRenderMessagesRef: unknown[] | null;
  historyRenderMessageCount: number;
  historyRenderLimit: number;
  historyRenderLastScrollTop: number | null;
  historyRenderExpansionFrame: number | null;
  historyRenderAnchorAdjustment: {
    scrollHeight: number;
    scrollTop: number;
  } | null;
  historyRenderAnchorFrame: number | null;
  relativeTimeTimer: ReturnType<typeof setInterval> | null;
  relativeTimeRequestUpdate: (() => void) | null;
  relativeTimeVersion: number;
};

type ChatThreadProps = {
  paneId: string;
  sessionKey: string;
  loading: boolean;
  messages: unknown[];
  toolMessages: unknown[];
  streamSegments: ChatStreamSegment[];
  stream: string | null;
  streamStartedAt: number | null;
  queue: ChatQueueItem[];
  showThinking: boolean;
  showToolCalls: boolean;
  /** True while the session has an abortable live run (marks running tool rows). */
  runActive?: boolean;
  /** True while the agent is visibly working (isChatRunWorking); shows the working spark. */
  runWorking?: boolean;
  sessions: SessionsListResult | null;
  /** Host context resolving global-alias session keys (scope=global fleets). */
  /** Includes assistantAgentId so bare-global welcome recents scope to the selected agent. */
  sessionHost?: UiSessionDefaultsHost | null;
  assistantName: string;
  assistantAvatar: string | null;
  assistantAvatarUrl?: string | null;
  userName?: string | null;
  userAvatar?: string | null;
  basePath?: string;
  fullMessageAgentId?: string;
  localMediaPreviewRoots?: string[];
  assistantAttachmentAuthToken?: string | null;
  canvasPluginSurfaceUrl?: string | null;
  embedSandboxMode?: EmbedSandboxMode;
  allowExternalEmbedUrls?: boolean;
  autoExpandToolCalls?: boolean;
  realtimeTalkConversation?: RealtimeTalkConversationEntry[];
  onOpenSidebar?: (content: SidebarContent) => void;
  onOpenWorkspaceFile?: (target: { path: string; line?: number | null }) => void;
  onOpenSessionCheckpoints?: () => void | Promise<void>;
  onAssistantAttachmentLoaded?: () => void;
  onRequestUpdate?: () => void;
  onScrollToBottom?: () => void;
  onChatScroll?: (event: Event) => void;
  onDraftChange: (next: string) => void;
  /** Current composer draft; the selection popup preserves it when prefilling. */
  getDraft?: () => string;
  onSend: () => void;
  onSetReply?: (target: ReplyTarget) => void;
  onFocusComposer?: () => void;
  /** Sends a detached /btw side question built from the selection popup. */
  onSideQuestion?: (command: string) => void;
  onOpenSession?: (sessionKey: string) => void;
};

type ChatPinnedMessagesProps = Pick<
  ChatThreadProps,
  "paneId" | "sessionKey" | "messages" | "userName" | "userAvatar"
>;

function createChatThreadState(): ChatThreadState {
  return {
    searchOpen: false,
    searchQuery: "",
    pinnedExpanded: false,
    historyRenderSessionKey: null,
    historyRenderMessagesRef: null,
    historyRenderMessageCount: 0,
    historyRenderLimit: 0,
    historyRenderLastScrollTop: null,
    historyRenderExpansionFrame: null,
    historyRenderAnchorAdjustment: null,
    historyRenderAnchorFrame: null,
    relativeTimeTimer: null,
    relativeTimeRequestUpdate: null,
    relativeTimeVersion: 0,
  };
}

const RELATIVE_TIME_REFRESH_MS = 60_000;

// Footer timestamps render relative labels ("5m ago") that go stale on idle
// panes; one per-pane minute tick keeps them fresh without per-message timers.
// The version bump must accompany requestUpdate: the message subtree is
// memoized by guard(), so a tick only re-renders it via this dependency.
function ensureRelativeTimeRefresh(state: ChatThreadState, requestUpdate: () => void) {
  state.relativeTimeRequestUpdate = requestUpdate;
  state.relativeTimeTimer ??= setInterval(() => {
    state.relativeTimeVersion = (state.relativeTimeVersion + 1) % Number.MAX_SAFE_INTEGER;
    state.relativeTimeRequestUpdate?.();
  }, RELATIVE_TIME_REFRESH_MS);
}

const threadStates = new Map<string, ChatThreadState>();

function getChatThreadState(paneId: string): ChatThreadState {
  const existing = threadStates.get(paneId);
  if (existing) {
    return existing;
  }
  const state = createChatThreadState();
  threadStates.set(paneId, state);
  return state;
}

function getPinnedMessages(sessionKey: string): PinnedMessages {
  return getOrCreateSessionCacheValue(
    pinnedMessagesMap,
    sessionKey,
    () => new PinnedMessages(sessionKey),
  );
}

function getDeletedMessages(sessionKey: string): DeletedMessages {
  return getOrCreateSessionCacheValue(
    deletedMessagesMap,
    sessionKey,
    () => new DeletedMessages(sessionKey),
  );
}

function getPinnedMessageSummary(message: unknown): string {
  return extractTextCached(message) ?? "";
}

export function resetChatThreadPresentationState(paneId?: string) {
  removeReplyContextMenu(paneId);
  // The selection popup is body-portaled; pane teardown/route changes must
  // drop it so it cannot outlive the render that owns its callbacks.
  removeChatSelectionPopup();
  const states = paneId
    ? ([threadStates.get(paneId)].filter(Boolean) as ChatThreadState[])
    : [...threadStates.values()];
  for (const state of states) {
    if (state.historyRenderExpansionFrame != null) {
      cancelAnimationFrame(state.historyRenderExpansionFrame);
    }
    if (state.historyRenderAnchorFrame != null) {
      cancelAnimationFrame(state.historyRenderAnchorFrame);
    }
    if (state.relativeTimeTimer != null) {
      clearInterval(state.relativeTimeTimer);
      state.relativeTimeTimer = null;
      state.relativeTimeRequestUpdate = null;
    }
  }
  if (paneId) {
    threadStates.delete(paneId);
  } else {
    threadStates.clear();
    resetChatThreadState();
  }
}

function resolveChatHistoryRenderCap(messageCount: number): number {
  return Math.min(Math.max(0, messageCount), CHAT_HISTORY_RENDER_LIMIT);
}

function shouldRenderFullChatHistoryWindow(state: ChatThreadState, messageCount: number): boolean {
  return (
    messageCount <= INITIAL_CHAT_HISTORY_RENDER_WINDOW ||
    (state.searchOpen && state.searchQuery.trim().length > 0)
  );
}

function resolveChatHistoryRenderWindow(
  props: Pick<ChatThreadProps, "paneId" | "sessionKey" | "messages">,
) {
  const state = getChatThreadState(props.paneId);
  const messages = Array.isArray(props.messages) ? props.messages : [];
  const cap = resolveChatHistoryRenderCap(messages.length);
  const sessionChanged = state.historyRenderSessionKey !== props.sessionKey;
  const refChanged = state.historyRenderMessagesRef !== messages;
  const previousCount = state.historyRenderMessageCount;
  if (sessionChanged || (refChanged && previousCount === 0)) {
    state.historyRenderLastScrollTop = null;
  }

  if (cap === 0) {
    state.historyRenderSessionKey = props.sessionKey;
    state.historyRenderMessagesRef = messages;
    state.historyRenderMessageCount = messages.length;
    state.historyRenderLimit = 0;
    state.historyRenderLastScrollTop = null;
    return 0;
  }

  if (shouldRenderFullChatHistoryWindow(state, messages.length)) {
    state.historyRenderSessionKey = props.sessionKey;
    state.historyRenderMessagesRef = messages;
    state.historyRenderMessageCount = messages.length;
    state.historyRenderLimit = cap;
    return cap;
  }

  if (sessionChanged || (refChanged && previousCount === 0)) {
    state.historyRenderLimit = Math.min(INITIAL_CHAT_HISTORY_RENDER_WINDOW, cap);
  } else if (refChanged) {
    const grewBy = messages.length - previousCount;
    if (state.historyRenderLimit >= previousCount) {
      state.historyRenderLimit = cap;
    } else if (grewBy > 0 && grewBy <= CHAT_HISTORY_RENDER_WINDOW_BATCH) {
      state.historyRenderLimit = Math.min(cap, state.historyRenderLimit + grewBy);
    } else {
      state.historyRenderLimit = Math.min(
        Math.max(state.historyRenderLimit, INITIAL_CHAT_HISTORY_RENDER_WINDOW),
        cap,
      );
    }
  }

  state.historyRenderSessionKey = props.sessionKey;
  state.historyRenderMessagesRef = messages;
  state.historyRenderMessageCount = messages.length;
  state.historyRenderLimit = Math.min(Math.max(1, state.historyRenderLimit), cap);
  return state.historyRenderLimit;
}

function maybeExpandChatHistoryRenderWindow(
  state: ChatThreadState,
  event: Event,
  requestUpdate: () => void,
) {
  const target = event.currentTarget;
  if (!(target instanceof HTMLElement)) {
    return;
  }
  const scrollTop = Math.max(0, target.scrollTop);
  const previousScrollTop = state.historyRenderLastScrollTop;
  state.historyRenderLastScrollTop = scrollTop;
  const distanceFromBottom = Math.max(0, target.scrollHeight - scrollTop - target.clientHeight);
  const isTop = scrollTop <= CHAT_HISTORY_RENDER_EXPAND_SCROLL_TOP_PX;
  const isBottomAutoScroll =
    scrollTop > 0 && distanceFromBottom <= CHAT_HISTORY_RENDER_EXPAND_SCROLL_TOP_PX;
  const isTopScrollUp =
    isTop &&
    (scrollTop === 0 ||
      (!isBottomAutoScroll && (previousScrollTop == null || scrollTop < previousScrollTop)));
  if (!isTopScrollUp) {
    return;
  }
  const cap = resolveChatHistoryRenderCap(state.historyRenderMessageCount);
  if (state.historyRenderLimit >= cap) {
    return;
  }
  state.historyRenderAnchorAdjustment = {
    scrollHeight: target.scrollHeight,
    scrollTop,
  };
  scheduleChatHistoryRenderAnchorPreservation(state, target);
  state.historyRenderLimit = Math.min(
    cap,
    state.historyRenderLimit + CHAT_HISTORY_RENDER_WINDOW_BATCH,
  );
  requestUpdate();
}

function scheduleChatHistoryRenderAnchorPreservation(state: ChatThreadState, thread: HTMLElement) {
  const adjustment = state.historyRenderAnchorAdjustment;
  if (!adjustment || state.historyRenderAnchorFrame != null) {
    return;
  }
  state.historyRenderAnchorFrame = requestAnimationFrame(() => {
    state.historyRenderAnchorFrame = null;
    state.historyRenderAnchorAdjustment = null;
    const heightDelta = thread.scrollHeight - adjustment.scrollHeight;
    if (heightDelta <= 0) {
      return;
    }
    thread.scrollTop = adjustment.scrollTop + heightDelta;
  });
}

function scheduleChatHistoryRenderWindowFill(
  state: ChatThreadState,
  thread: HTMLElement | null,
  requestUpdate: () => void,
  scrollToBottom: () => void,
) {
  if (!thread || state.historyRenderExpansionFrame != null) {
    return;
  }
  const cap = resolveChatHistoryRenderCap(state.historyRenderMessageCount);
  if (state.historyRenderLimit >= cap) {
    return;
  }
  state.historyRenderExpansionFrame = requestAnimationFrame(() => {
    state.historyRenderExpansionFrame = null;
    const nextCap = resolveChatHistoryRenderCap(state.historyRenderMessageCount);
    if (state.historyRenderLimit >= nextCap) {
      return;
    }
    const canScroll = thread.scrollHeight - thread.clientHeight > 1;
    if (canScroll) {
      return;
    }
    state.historyRenderLimit = Math.min(
      nextCap,
      state.historyRenderLimit + CHAT_HISTORY_RENDER_WINDOW_BATCH,
    );
    requestUpdate();
    scrollToBottom();
  });
}

export function renderChatSearchBar(
  paneId: string,
  requestUpdate: () => void,
): TemplateResult | typeof nothing {
  const state = getChatThreadState(paneId);
  if (!state.searchOpen) {
    return nothing;
  }
  return html`
    <div class="agent-chat__search-bar">
      ${icons.search}
      <input
        type="text"
        placeholder="Search messages..."
        aria-label="Search messages"
        .value=${state.searchQuery}
        @input=${(event: Event) => {
          state.searchQuery = (event.target as HTMLInputElement).value;
          requestUpdate();
        }}
      />
      <openclaw-tooltip content="Close search">
        <button
          class="btn btn--ghost"
          aria-label="Close search"
          @click=${() => {
            state.searchOpen = false;
            state.searchQuery = "";
            requestUpdate();
          }}
        >
          ${icons.x}
        </button>
      </openclaw-tooltip>
    </div>
  `;
}

export function isChatThreadSearchOpen(paneId: string): boolean {
  return getChatThreadState(paneId).searchOpen;
}

export function toggleChatThreadSearch(paneId: string, requestUpdate: () => void): void {
  const state = getChatThreadState(paneId);
  state.searchOpen = !state.searchOpen;
  if (!state.searchOpen) {
    state.searchQuery = "";
  }
  requestUpdate();
}

export function renderChatPinnedMessages(
  props: ChatPinnedMessagesProps,
  requestUpdate: () => void,
): TemplateResult | typeof nothing {
  const state = getChatThreadState(props.paneId);
  const pinned = getPinnedMessages(props.sessionKey);
  const userRoleLabel = resolveLocalUserName({
    name: props.userName ?? null,
    avatar: props.userAvatar ?? null,
  });
  const messages = Array.isArray(props.messages) ? props.messages : [];
  const entries: Array<{ index: number; text: string; role: string }> = [];
  for (const idx of pinned.indices) {
    const msg = messages[idx] as Record<string, unknown> | undefined;
    if (!msg) {
      continue;
    }
    const text = getPinnedMessageSummary(msg);
    const role = typeof msg.role === "string" ? msg.role : "unknown";
    entries.push({ index: idx, text, role });
  }
  if (entries.length === 0) {
    return nothing;
  }
  return html`
    <div class="agent-chat__pinned">
      <button
        class="agent-chat__pinned-toggle"
        aria-expanded=${state.pinnedExpanded}
        @click=${() => {
          state.pinnedExpanded = !state.pinnedExpanded;
          requestUpdate();
        }}
      >
        ${icons.bookmark} ${entries.length} pinned
        <span class="collapse-chevron ${state.pinnedExpanded ? "" : "collapse-chevron--collapsed"}"
          >${icons.chevronDown}</span
        >
      </button>
      ${state.pinnedExpanded
        ? html`
            <div class="agent-chat__pinned-list">
              ${entries.map(
                ({ index, text, role }) => html`
                  <div class="agent-chat__pinned-item">
                    <span class="agent-chat__pinned-role"
                      >${role === "user" ? userRoleLabel : "Assistant"}</span
                    >
                    <span class="agent-chat__pinned-text"
                      >${truncateUtf16Safe(text, 100)}${text.length > 100 ? "..." : ""}</span
                    >
                    <openclaw-tooltip content="Unpin">
                      <button
                        class="btn btn--ghost"
                        aria-label="Unpin"
                        @click=${() => {
                          pinned.unpin(index);
                          requestUpdate();
                        }}
                      >
                        ${icons.x}
                      </button>
                    </openclaw-tooltip>
                  </div>
                `,
              )}
            </div>
          `
        : nothing}
    </div>
  `;
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
  activeReplyContextMenu?.remove();
  activeReplyContextMenu = null;
  activeReplyContextMenuPaneId = null;
  document.querySelector(".chat-reply-context-menu")?.remove();
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
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `reply:${(hash >>> 0).toString(16)}`;
}

function createReplyContextMenuButton(onClick: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.setAttribute("role", "menuitem");
  button.setAttribute("aria-label", "Reply to message");

  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("width", "16");
  icon.setAttribute("height", "16");
  icon.setAttribute("fill", "currentColor");
  icon.setAttribute("stroke", "none");
  icon.setAttribute("aria-hidden", "true");
  icon.setAttribute("focusable", "false");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z");
  icon.appendChild(path);

  const label = document.createElement("span");
  label.textContent = "Reply";

  button.append(icon, label);
  button.addEventListener("click", onClick);
  return button;
}

function handleChatThreadSelectionPointerUp(event: PointerEvent, props: ChatThreadProps) {
  if (typeof props.onSideQuestion !== "function") {
    return;
  }
  handleChatSelectionPointerUp(event, {
    onMoreDetails: (selection) => {
      const command = buildMoreDetailsSideCommand(selection);
      if (command) {
        props.onSideQuestion?.(command);
      }
    },
    onAskSideChat: (selection) => {
      const draft = combineSideChatComposerDraft(selection, props.getDraft?.());
      if (draft) {
        props.onDraftChange(draft);
        props.onRequestUpdate?.();
        props.onFocusComposer?.();
      }
    },
  });
}

function handleChatContextMenu(event: MouseEvent, props: ChatThreadProps) {
  const bubble = (event.target as HTMLElement).closest(".chat-bubble");
  if (!bubble || typeof props.onSetReply !== "function") {
    return;
  }
  const group = bubble.closest(".chat-group");
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
  if (!text) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  const messageId =
    (bubble as HTMLElement).dataset.messageId?.trim() || stableReplyMessageId(senderLabel, text);
  removeReplyContextMenu();
  const menu = document.createElement("div");
  menu.className = "chat-reply-context-menu";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", "Message actions");
  menu.style.left = `${event.clientX}px`;
  menu.style.top = `${event.clientY}px`;
  const button = createReplyContextMenuButton(() => {
    props.onSetReply?.({ messageId, text, senderLabel });
    removeReplyContextMenu();
    props.onFocusComposer?.();
  });
  menu.append(button);
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
  button.focus();
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

function renderLoadingSkeleton() {
  return html`
    <div class="chat-loading-skeleton" aria-label="Loading chat">
      <div class="chat-line assistant">
        <div class="chat-msg">
          <div class="chat-bubble">
            <div
              class="skeleton skeleton-line skeleton-line--long"
              style="margin-bottom: 8px"
            ></div>
            <div
              class="skeleton skeleton-line skeleton-line--medium"
              style="margin-bottom: 8px"
            ></div>
            <div class="skeleton skeleton-line skeleton-line--short"></div>
          </div>
        </div>
      </div>
      <div class="chat-line user" style="margin-top: 12px">
        <div class="chat-msg">
          <div class="chat-bubble">
            <div class="skeleton skeleton-line skeleton-line--medium"></div>
          </div>
        </div>
      </div>
      <div class="chat-line assistant" style="margin-top: 12px">
        <div class="chat-msg">
          <div class="chat-bubble">
            <div
              class="skeleton skeleton-line skeleton-line--long"
              style="margin-bottom: 8px"
            ></div>
            <div class="skeleton skeleton-line skeleton-line--short"></div>
          </div>
        </div>
      </div>
    </div>
  `;
}

export function renderChatThread(props: ChatThreadProps) {
  const state = getChatThreadState(props.paneId);
  const requestUpdate = props.onRequestUpdate ?? (() => {});
  ensureRelativeTimeRefresh(state, requestUpdate);
  const displayStream = props.stream ?? null;
  const sessionHost = props.sessionHost ?? null;
  // Equivalence, not exact match: the default session travels under alias
  // keys ("main" vs "agent:main:main") depending on the caller.
  const activeSession = props.sessions?.sessions?.find((row) =>
    areUiSessionKeysEquivalent(row.key, props.sessionKey),
  );
  // Global-alias detection needs no session row: under configured global
  // scope, agent:<id>:global and configured-main aliases route to the global
  // stream even when the capped sessions list omits the canonical row (or it
  // does not exist yet). The scope gate keeps per-sender main threads direct.
  const isGlobalAliasKey =
    parseAgentSessionKey(props.sessionKey)?.rest === "global" ||
    (sessionHost !== null &&
      isUiGlobalScopeConfigured(sessionHost) &&
      resolveUiGlobalAliasAgentId(sessionHost, props.sessionKey) !== null);
  const reasoningLevel = activeSession?.reasoningLevel ?? "off";
  const showReasoning = props.showThinking && reasoningLevel !== "off";
  const assistantIdentity = {
    name: props.assistantName,
    avatar: resolveAssistantDisplayAvatar(props),
  };
  const historyRenderLimit = resolveChatHistoryRenderWindow(props);
  const deleted = getDeletedMessages(props.sessionKey);
  const chatItems = buildCachedChatItems({
    sessionKey: props.sessionKey,
    messages: props.messages,
    toolMessages: props.toolMessages,
    streamSegments: props.streamSegments,
    stream: displayStream,
    streamStartedAt: props.streamStartedAt,
    queue: props.queue,
    showToolCalls: props.showToolCalls,
    runWorking: Boolean(props.runWorking),
    loading: props.loading,
    searchOpen: state.searchOpen,
    searchQuery: state.searchQuery,
    historyRenderLimit,
  });
  syncToolCardExpansionState(props.sessionKey, chatItems, Boolean(props.autoExpandToolCalls));
  const expandedToolCards = getExpandedToolCards(props.sessionKey);
  const toggleToolCardExpanded = (toolCardId: string) => {
    expandedToolCards.set(toolCardId, !expandedToolCards.get(toolCardId));
    requestUpdate();
  };
  const hasRealtimeTalkConversation = (props.realtimeTalkConversation?.length ?? 0) > 0;
  const isEmpty = chatItems.length === 0 && !props.loading && !hasRealtimeTalkConversation;
  // 1:1 sessions drop the avatar gutter entirely; group threads keep avatars
  // as the always-visible identity marker. The canonical session kind decides;
  // the sessions list is capped, so absent/unknown rows classify by key:
  // global aliases first, then the same core key-shape helper the gateway
  // uses. Message senderLabels are not a signal here: gateway sanitization
  // labels 1:1 channel DM rows too.
  const rowKind = activeSession?.kind;
  const sessionKind =
    rowKind && rowKind !== "unknown"
      ? rowKind
      : isGlobalAliasKey
        ? "global"
        : classifySessionKind(props.sessionKey);
  // Only agent-solo kinds qualify: "global" aggregates every inbound context
  // under session.scope="global" (including group/channel senders), so it
  // keeps avatars like "group" and "unknown" do.
  const isDirectThread =
    sessionKind === "direct" || sessionKind === "cron" || sessionKind === "spawn-child";
  const showLoadingSkeleton = props.loading && chatItems.length === 0;
  const threadContextWindow =
    activeSession?.contextTokens ?? props.sessions?.defaults?.contextTokens ?? null;
  const handleChatThreadScroll = (event: Event) => {
    maybeExpandChatHistoryRenderWindow(state, event, requestUpdate);
    props.onChatScroll?.(event);
  };

  return html`
    <div
      class="chat-thread ${isDirectThread ? "chat-thread--direct" : ""}"
      role="log"
      aria-live="polite"
      ${ref((element) => {
        const threadElement = element instanceof HTMLElement ? element : null;
        scheduleChatHistoryRenderWindowFill(
          state,
          threadElement,
          requestUpdate,
          props.onScrollToBottom ?? (() => {}),
        );
      })}
      @scroll=${handleChatThreadScroll}
      @mousedown=${beginNativeWindowDragFromTopInset}
      @click=${(event: Event) => {
        handleMarkdownCodeBlockCopy(event);
        const target = markdownFileLinkFromEvent(event);
        if (target) {
          props.onOpenWorkspaceFile?.(target);
        }
      }}
      @contextmenu=${(event: MouseEvent) => handleChatContextMenu(event, props)}
      @pointerup=${(event: PointerEvent) => handleChatThreadSelectionPointerUp(event, props)}
    >
      <div class="chat-thread-inner">
        ${showLoadingSkeleton ? renderLoadingSkeleton() : nothing}
        ${isEmpty && !state.searchOpen ? renderWelcomeState(props) : nothing}
        ${isEmpty && state.searchOpen
          ? html` <div class="agent-chat__empty">No matching messages</div> `
          : nothing}
        ${guard(
          [
            chatItems,
            deletedChatItemsSignature(deleted, chatItems),
            stableBooleanMapSignature(expandedToolCards),
            getAssistantAttachmentAvailabilityRenderVersion(),
            state.relativeTimeVersion,
            getToolTitlesVersion(),
            props.sessionKey,
            props.fullMessageAgentId,
            showReasoning,
            props.showToolCalls,
            Boolean(props.runActive),
            Boolean(props.autoExpandToolCalls),
            props.assistantName,
            assistantIdentity.avatar,
            props.userName,
            props.userAvatar,
            props.basePath,
            (props.localMediaPreviewRoots ?? []).join("\u0000"),
            props.assistantAttachmentAuthToken,
            props.canvasPluginSurfaceUrl,
            props.embedSandboxMode ?? "scripts",
            props.allowExternalEmbedUrls ?? false,
            threadContextWindow,
          ],
          () =>
            repeat(
              coalesceStreamRuns(chatItems),
              (item) => item.key,
              (item) => {
                if (item.kind === "divider") {
                  return html`
                    <div class="chat-divider" data-ts=${String(item.timestamp)}>
                      <div class="chat-divider__rule" role="separator" aria-label=${item.label}>
                        <span class="chat-divider__line"></span>
                        <span class="chat-divider__label">${item.label}</span>
                        <span class="chat-divider__line"></span>
                      </div>
                      ${item.description || item.action
                        ? html`
                            <div class="chat-divider__details">
                              ${item.description
                                ? html`<span class="chat-divider__description">
                                    ${item.description}
                                  </span>`
                                : nothing}
                              ${item.action?.kind === "session-checkpoints" &&
                              props.onOpenSessionCheckpoints
                                ? html`
                                    <button
                                      type="button"
                                      class="btn btn--subtle btn--sm chat-divider__action"
                                      @click=${() => props.onOpenSessionCheckpoints?.()}
                                    >
                                      ${item.action.label}
                                    </button>
                                  `
                                : nothing}
                            </div>
                          `
                        : nothing}
                    </div>
                  `;
                }
                if (item.kind === "stream-run") {
                  return renderStreamGroup(item.parts, {
                    onOpenSidebar: props.onOpenSidebar,
                    assistant: assistantIdentity,
                    basePath: props.basePath,
                    authToken: props.assistantAttachmentAuthToken ?? null,
                  });
                }
                if (item.kind === "group") {
                  if (deleted.has(item.key)) {
                    return nothing;
                  }
                  return renderMessageGroup(item, {
                    onOpenSidebar: props.onOpenSidebar,
                    onOpenWorkspaceFile: props.onOpenWorkspaceFile,
                    sessionKey: props.sessionKey,
                    agentId: props.fullMessageAgentId,
                    showReasoning,
                    showToolCalls: props.showToolCalls,
                    runActive: props.runActive,
                    autoExpandToolCalls: Boolean(props.autoExpandToolCalls),
                    isToolMessageExpanded: (messageId: string) => expandedToolCards.get(messageId),
                    onToggleToolMessageExpanded: (messageId: string, expanded?: boolean) => {
                      expandedToolCards.set(
                        messageId,
                        !(expanded ?? expandedToolCards.get(messageId) ?? false),
                      );
                      requestUpdate();
                    },
                    isToolExpanded: (toolCardId: string) =>
                      expandedToolCards.get(toolCardId) ?? false,
                    onToggleToolExpanded: toggleToolCardExpanded,
                    onRequestUpdate: requestUpdate,
                    onAssistantAttachmentLoaded: props.onAssistantAttachmentLoaded,
                    assistantName: props.assistantName,
                    assistantAvatar: assistantIdentity.avatar,
                    userName: props.userName ?? null,
                    userAvatar: props.userAvatar ?? null,
                    basePath: props.basePath,
                    localMediaPreviewRoots: props.localMediaPreviewRoots ?? [],
                    assistantAttachmentAuthToken: props.assistantAttachmentAuthToken ?? null,
                    canvasPluginSurfaceUrl: props.canvasPluginSurfaceUrl,
                    embedSandboxMode: props.embedSandboxMode ?? "scripts",
                    allowExternalEmbedUrls: props.allowExternalEmbedUrls ?? false,
                    contextWindow: threadContextWindow,
                    onDelete: () => {
                      deleted.delete(item.key);
                      requestUpdate();
                    },
                  });
                }
                return nothing;
              },
            ),
        )}
        ${renderRealtimeTalkConversation(props)}
      </div>
    </div>
  `;
}
