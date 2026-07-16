// Chat-owned message thread presentation and thread-local interaction state.
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { VirtualizerController } from "@tanstack/lit-virtual";
import { defaultRangeExtractor, observeElementRect } from "@tanstack/virtual-core";
import {
  html,
  nothing,
  type ReactiveController,
  type ReactiveControllerHost,
  type TemplateResult,
} from "lit";
import { guard } from "lit/directives/guard.js";
import { ref } from "lit/directives/ref.js";
import { repeat } from "lit/directives/repeat.js";
import { styleMap } from "lit/directives/style-map.js";
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
import { i18n, t } from "../../../i18n/index.ts";
import type {
  ChatQueueItem,
  ChatStreamSegment,
  MessageGroup,
} from "../../../lib/chat/chat-types.ts";
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
  collapseCompletedTurnWork,
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
import { renderBackgroundTasksStatusRow } from "./chat-background-tasks-status.ts";
import type { BackgroundTasksProps } from "./chat-background-tasks.ts";
import { renderChatDivider } from "./chat-divider.ts";
import {
  getAssistantAttachmentAvailabilityRenderVersion,
  renderMessageGroup,
  renderStreamGroup,
  renderWorkGroupSummary,
} from "./chat-message.ts";
import { renderRealtimeTalkConversation } from "./chat-realtime-controls.ts";
import { handleChatSelectionPointerUp, removeChatSelectionPopup } from "./chat-selection-popup.ts";
import type { SidebarContent } from "./chat-sidebar.ts";
import { renderWelcomeState, resolveAssistantDisplayAvatar } from "./chat-welcome.ts";

const pinnedMessagesMap = new Map<string, PinnedMessages>();
const deletedMessagesMap = new Map<string, DeletedMessages>();

type ReplyTarget = {
  messageId: string;
  text: string;
  senderLabel?: string | null;
};

type ChatThreadState = {
  searchOpen: boolean;
  searchQuery: string;
  pinnedExpanded: boolean;
  transcriptRenderDependencies: readonly unknown[];
  transcriptRenderContext: object;
};

type ChatThreadProps = {
  paneId: string;
  sessionKey: string;
  announceTranscript?: boolean;
  loading: boolean;
  historyPagination?: {
    loading: boolean;
  };
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
  onChatScroll?: (event: Event) => void;
  onHistoryIntent?: (event: Event) => void;
  onDraftChange: (next: string) => void;
  /** Current composer draft; the selection popup preserves it when prefilling. */
  getDraft?: () => string;
  onSend: () => void;
  onSetReply?: (target: ReplyTarget) => void;
  onFocusComposer?: () => void;
  /** Sends a detached /btw side question built from the selection popup. */
  onSideQuestion?: (command: string) => void;
  onOpenSession?: (sessionKey: string) => void;
  /** Tasks-rail snapshot backing the post-turn running-tasks status row. */
  backgroundTasks?: BackgroundTasksProps;
};

type ChatPinnedMessagesProps = Pick<
  ChatThreadProps,
  "paneId" | "sessionKey" | "messages" | "userName" | "userAvatar"
>;

type ChatRenderItem = ReturnType<typeof collapseCompletedTurnWork>[number];

type ChatTranscriptRow =
  | { kind: "item"; key: string; item: ChatRenderItem }
  | { kind: "content"; key: string; content: unknown };

type ChatTranscriptAnnouncement = {
  key: string;
  text: string;
};

const CHAT_TRANSCRIPT_ESTIMATED_ROW_PX = 120;
const CHAT_TRANSCRIPT_OVERSCAN = 6;
const CHAT_TRANSCRIPT_END_THRESHOLD_PX = 8;
const CHAT_TRANSCRIPT_ANNOUNCEMENT_MAX_CHARS = 500;

function initialTranscriptRect(host: ReactiveControllerHost) {
  const width = host instanceof HTMLElement ? host.clientWidth : 0;
  const height = host instanceof HTMLElement ? host.clientHeight : 0;
  return {
    width: width || (typeof window === "undefined" ? 0 : window.innerWidth),
    height: height || (typeof window === "undefined" ? 0 : window.innerHeight),
  };
}

function transcriptScrollMargin(element: Element | null): number {
  if (!(element instanceof HTMLElement) || typeof getComputedStyle !== "function") {
    return 0;
  }
  const margin = Number.parseFloat(getComputedStyle(element).paddingTop);
  return Number.isFinite(margin) ? margin : 0;
}

function initialTranscriptScrollMargin(host: ReactiveControllerHost): number {
  return host instanceof HTMLElement
    ? transcriptScrollMargin(host.querySelector(".chat-thread"))
    : 0;
}

class ChatSessionVirtualizerHost implements ReactiveControllerHost {
  private readonly controllers = new Set<ReactiveController>();
  private readonly virtualizerController: VirtualizerController<HTMLDivElement, HTMLElement>;
  private scrollElement: HTMLDivElement | null = null;
  private rowKeys: readonly string[] = [];
  private rowIndexesByKey = new Map<string, number>();
  private focusedRowKey: string | null = null;
  private announcementInitialized = false;
  private announcementKey: string | null = null;
  private currentAnnouncementText = "";

  constructor(private readonly host: ReactiveControllerHost) {
    this.virtualizerController = new VirtualizerController(this, {
      count: 0,
      getScrollElement: () => this.scrollElement,
      estimateSize: () => CHAT_TRANSCRIPT_ESTIMATED_ROW_PX,
      getItemKey: () => "",
      initialRect: initialTranscriptRect(host),
      initialOffset: Number.MAX_SAFE_INTEGER,
      scrollMargin: initialTranscriptScrollMargin(host),
      anchorTo: "end",
      followOnAppend: false,
      observeElementRect: (instance, callback) =>
        observeElementRect(instance, (rect) => {
          this.syncScrollMargin(instance.scrollElement);
          callback(rect);
        }),
      rangeExtractor: (range) => {
        const indexes = defaultRangeExtractor(range);
        const focused =
          this.focusedRowKey === null ? undefined : this.rowIndexesByKey.get(this.focusedRowKey);
        if (
          focused === undefined ||
          focused < 0 ||
          focused >= range.count ||
          indexes.includes(focused)
        ) {
          return indexes;
        }
        return [...indexes, focused].toSorted((left, right) => left - right);
      },
      scrollEndThreshold: CHAT_TRANSCRIPT_END_THRESHOLD_PX,
      overscan: CHAT_TRANSCRIPT_OVERSCAN,
    });
  }

  get updateComplete() {
    return this.host.updateComplete;
  }

  get liveAnnouncementText() {
    return this.currentAnnouncementText;
  }

  requestUpdate = () => {
    this.host.requestUpdate();
  };

  addController(controller: ReactiveController): void {
    this.controllers.add(controller);
  }

  removeController(controller: ReactiveController): void {
    this.controllers.delete(controller);
  }

  connect(): void {
    for (const controller of this.controllers) {
      controller.hostConnected?.();
    }
  }

  update(): void {
    for (const controller of this.controllers) {
      controller.hostUpdated?.();
    }
  }

  disconnect(): void {
    for (const controller of this.controllers) {
      controller.hostDisconnected?.();
    }
    this.scrollElement = null;
  }

  render(
    rows: readonly ChatTranscriptRow[],
    renderRow: (row: ChatTranscriptRow) => unknown,
    announcement: ChatTranscriptAnnouncement | null,
    announce: boolean,
    overlay: unknown = nothing,
  ): TemplateResult {
    this.syncRows(rows);
    this.syncAnnouncement(announcement, announce);
    const virtualizer = this.virtualizerController.getVirtualizer();
    const virtualRows = virtualizer.getVirtualItems();
    return html`
      <div
        class="chat-thread-inner chat-thread-inner--virtual"
        ${ref((element) => {
          this.scrollElement =
            element?.parentElement instanceof HTMLDivElement ? element.parentElement : null;
        })}
      >
        <div
          class="chat-virtual-sizer"
          style=${styleMap({ height: `${virtualizer.getTotalSize()}px` })}
        >
          ${overlay}
          ${repeat(
            virtualRows,
            (virtualRow) => virtualRow.key,
            (virtualRow) => {
              const row = rows[virtualRow.index];
              if (!row) {
                return nothing;
              }
              return html`
                <div
                  class="chat-virtual-row ${virtualRow.index === 0
                    ? "chat-virtual-row--first"
                    : ""}"
                  style=${styleMap({
                    transform: `translateY(${
                      virtualRow.start - virtualizer.options.scrollMargin
                    }px)`,
                  })}
                  data-index=${String(virtualRow.index)}
                  data-virtual-row-key=${row.key}
                  ${ref((element) =>
                    virtualizer.measureElement(element instanceof HTMLElement ? element : null),
                  )}
                >
                  ${renderRow(row)}
                </div>
              `;
            },
          )}
        </div>
      </div>
    `;
  }

  scrollToEnd(options: { behavior?: ScrollBehavior } = {}): void {
    this.virtualizerController.getVirtualizer().scrollToEnd(options);
  }

  handleFocusIn(event: FocusEvent): void {
    this.focusedRowKey = this.rowKeyFromEvent(event);
  }

  handleFocusOut(event: FocusEvent): void {
    this.focusedRowKey = this.rowKeyFromEvent(event, event.relatedTarget);
  }

  private rowKeyFromEvent(event: FocusEvent, target: EventTarget | null = event.target) {
    if (!(target instanceof Element) || !this.scrollElement?.contains(target)) {
      return null;
    }
    const row = target.closest<HTMLElement>(".chat-virtual-row[data-virtual-row-key]");
    if (!row || !this.scrollElement.contains(row)) {
      return null;
    }
    return row.dataset.virtualRowKey || null;
  }

  private syncAnnouncement(
    announcement: ChatTranscriptAnnouncement | null,
    announce: boolean,
  ): void {
    if (!this.announcementInitialized || !announce) {
      this.announcementInitialized = true;
      this.announcementKey = announcement?.key ?? null;
      this.currentAnnouncementText = "";
      return;
    }
    if (!announcement || announcement.key === this.announcementKey) {
      return;
    }
    this.announcementKey = announcement.key;
    this.currentAnnouncementText = announcement.text;
  }

  private syncRows(rows: readonly ChatTranscriptRow[]): void {
    const nextKeys = rows.map((row) => row.key);
    if (
      nextKeys.length === this.rowKeys.length &&
      nextKeys.every((key, index) => key === this.rowKeys[index])
    ) {
      return;
    }
    this.rowKeys = Object.freeze(nextKeys);
    this.rowIndexesByKey = new Map(this.rowKeys.map((key, index) => [key, index]));
    const keys = this.rowKeys;
    const virtualizer = this.virtualizerController.getVirtualizer();
    virtualizer.setOptions({
      ...virtualizer.options,
      count: keys.length,
      getItemKey: (index) => keys[index] ?? `missing:${index}`,
    });
  }

  private syncScrollMargin(scrollElement: HTMLDivElement | null): void {
    const scrollMargin = transcriptScrollMargin(scrollElement);
    const virtualizer = this.virtualizerController.getVirtualizer();
    if (scrollMargin === virtualizer.options.scrollMargin) {
      return;
    }
    virtualizer.setOptions({
      ...virtualizer.options,
      scrollMargin,
    });
  }
}

export class ChatTranscriptController implements ReactiveController {
  private sessionKey: string | null = null;
  private sessionVirtualizer: ChatSessionVirtualizerHost | null = null;
  private connected = false;

  constructor(private readonly host: ReactiveControllerHost) {
    host.addController(this);
  }

  render(props: ChatThreadProps): TemplateResult {
    if (
      !this.sessionVirtualizer ||
      this.sessionKey === null ||
      !areUiSessionKeysEquivalent(this.sessionKey, props.sessionKey)
    ) {
      this.sessionVirtualizer?.disconnect();
      this.sessionKey = props.sessionKey;
      this.sessionVirtualizer = new ChatSessionVirtualizerHost(this.host);
      if (this.connected) {
        this.sessionVirtualizer.connect();
      }
    }
    return renderChatThreadContents(props, this.sessionVirtualizer);
  }

  scrollToEnd(options: { behavior?: ScrollBehavior } = {}): void {
    this.sessionVirtualizer?.scrollToEnd(options);
  }

  handleFocusIn(event: FocusEvent): void {
    this.sessionVirtualizer?.handleFocusIn(event);
  }

  handleFocusOut(event: FocusEvent): void {
    this.sessionVirtualizer?.handleFocusOut(event);
  }

  hostConnected(): void {
    this.connected = true;
    this.sessionVirtualizer?.connect();
  }

  hostUpdated(): void {
    this.sessionVirtualizer?.update();
  }

  hostDisconnected(): void {
    this.connected = false;
    this.sessionVirtualizer?.disconnect();
  }
}

function createChatThreadState(): ChatThreadState {
  return {
    searchOpen: false,
    searchQuery: "",
    pinnedExpanded: false,
    transcriptRenderDependencies: [],
    transcriptRenderContext: {},
  };
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
  if (paneId) {
    threadStates.delete(paneId);
    resetChatThreadState(paneId);
  } else {
    threadStates.clear();
    resetChatThreadState();
  }
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
        placeholder=${t("chat.thread.searchPlaceholder")}
        aria-label=${t("chat.thread.search")}
        .value=${state.searchQuery}
        @input=${(event: Event) => {
          state.searchQuery = (event.target as HTMLInputElement).value;
          requestUpdate();
        }}
      />
      <openclaw-tooltip .content=${t("chat.thread.closeSearch")}>
        <button
          class="btn btn--ghost"
          aria-label=${t("chat.thread.closeSearch")}
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
                    <openclaw-tooltip .content=${t("chat.thread.unpin")}>
                      <button
                        class="btn btn--ghost"
                        aria-label=${t("chat.thread.unpin")}
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
    <div class="chat-loading-skeleton" aria-label=${t("chat.thread.loading")}>
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

function renderHistorySentinel(loading: boolean) {
  return html`
    <div class="chat-history-sentinel">
      ${loading
        ? html`
            <div class="chat-history-loading" role="status">
              <span class="session-run-spinner" aria-hidden="true"></span>
              <span>${t("common.loading")}</span>
            </div>
          `
        : nothing}
    </div>
  `;
}

function latestTranscriptAnnouncement(
  items: readonly ChatRenderItem[],
): ChatTranscriptAnnouncement | null {
  for (let itemIndex = items.length - 1; itemIndex >= 0; itemIndex -= 1) {
    const item = items[itemIndex];
    if (!item || item.kind !== "group" || item.role.toLowerCase() !== "assistant") {
      continue;
    }
    for (let messageIndex = item.messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
      const message = item.messages[messageIndex]?.message;
      const text = extractTextCached(message)?.trim();
      if (text) {
        return {
          key: item.key,
          text: truncateUtf16Safe(text, CHAT_TRANSCRIPT_ANNOUNCEMENT_MAX_CHARS),
        };
      }
    }
  }
  return null;
}

function chatRenderItemGuardDependencies(item: ChatRenderItem): readonly unknown[] {
  if (item.kind === "stream-run") {
    return [item.key, ...item.parts];
  }
  if (item.kind === "work-group") {
    return [item.key, item.durationMs, item.hasError, ...item.groups];
  }
  return [item];
}

function trackTranscriptRenderDependencies(
  state: ChatThreadState,
  dependencies: unknown[],
): unknown[] {
  const previous = state.transcriptRenderDependencies;
  const nextLength = dependencies.length - 1;
  let changed = previous.length !== nextLength;
  for (let index = 0; !changed && index < nextLength; index += 1) {
    changed = !Object.is(previous[index], dependencies[index + 1]);
  }
  if (changed) {
    // The first dependency is chatItems. Keep the shared context stable when
    // only the live row changes, but invalidate every row for presentation changes.
    state.transcriptRenderDependencies = dependencies.slice(1);
    state.transcriptRenderContext = {};
  }
  return dependencies;
}

function guardChatRenderItems(state: ChatThreadState, render: (item: ChatRenderItem) => unknown) {
  return (item: ChatRenderItem) =>
    guard([...chatRenderItemGuardDependencies(item), state.transcriptRenderContext], () =>
      render(item),
    );
}

export function renderChatThread(
  props: ChatThreadProps,
  transcript: ChatTranscriptController,
): TemplateResult {
  return transcript.render(props);
}

function renderChatThreadContents(
  props: ChatThreadProps,
  transcript: ChatSessionVirtualizerHost,
): TemplateResult {
  const state = getChatThreadState(props.paneId);
  const requestUpdate = props.onRequestUpdate ?? (() => {});
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
  const deleted = getDeletedMessages(props.sessionKey);
  const locale = i18n.getLocale();
  const chatItems = buildCachedChatItems({
    paneId: props.paneId,
    sessionKey: props.sessionKey,
    runId:
      props.sessions?.sessions.find((row) => areUiSessionKeysEquivalent(row.key, props.sessionKey))
        ?.activeRunIds?.[0] ?? null,
    locale,
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
  const renderGroupItem = (item: MessageGroup) => {
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
        expandedToolCards.set(messageId, !(expanded ?? expandedToolCards.get(messageId) ?? false));
        requestUpdate();
      },
      isToolExpanded: (toolCardId: string) => expandedToolCards.get(toolCardId) ?? false,
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
  };
  const renderItem = guardChatRenderItems(state, (item) => {
    if (item.kind === "divider") {
      return renderChatDivider(item, props.onOpenSessionCheckpoints);
    }
    if (item.kind === "stream-run") {
      return renderStreamGroup(item.parts, {
        onOpenSidebar: props.onOpenSidebar,
        assistant: assistantIdentity,
        basePath: props.basePath,
        authToken: props.assistantAttachmentAuthToken ?? null,
      });
    }
    if (item.kind === "work-group") {
      const workExpanded = expandedToolCards.get(item.key) ?? item.hasError;
      return html`
        ${renderWorkGroupSummary(item, {
          expanded: workExpanded,
          onToggle: () => {
            expandedToolCards.set(item.key, !workExpanded);
            requestUpdate();
          },
        })}
        ${workExpanded ? item.groups.map((group) => renderGroupItem(group)) : nothing}
      `;
    }
    if (item.kind === "group") {
      return renderGroupItem(item);
    }
    return nothing;
  });
  const collapsedItems = collapseCompletedTurnWork(coalesceStreamRuns(chatItems), {
    runWorking: Boolean(props.runWorking),
    searchActive: state.searchOpen && Boolean(state.searchQuery.trim()),
  });
  const transcriptRows: ChatTranscriptRow[] = collapsedItems.map((item) => ({
    kind: "item",
    key: item.key,
    item,
  }));
  const realtimeConversation = renderRealtimeTalkConversation(props);
  if (realtimeConversation !== nothing) {
    transcriptRows.push({
      kind: "content",
      key: "realtime-talk",
      content: realtimeConversation,
    });
  }
  const backgroundTasks =
    !props.runWorking && !isEmpty && !showLoadingSkeleton
      ? renderBackgroundTasksStatusRow(props.backgroundTasks)
      : nothing;
  if (backgroundTasks !== nothing) {
    transcriptRows.push({
      kind: "content",
      key: "background-tasks",
      content: backgroundTasks,
    });
  }
  trackTranscriptRenderDependencies(state, [
    chatItems,
    locale,
    deletedChatItemsSignature(deleted, chatItems),
    stableBooleanMapSignature(expandedToolCards),
    getAssistantAttachmentAvailabilityRenderVersion(),
    // The host minute poll requests an update; this key crosses row guard() memoization.
    Math.floor(Date.now() / 60_000),
    getToolTitlesVersion(),
    props.sessionKey,
    props.fullMessageAgentId,
    showReasoning,
    props.showToolCalls,
    Boolean(props.runActive),
    Boolean(props.runWorking),
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
  ]);
  const transcriptContents =
    showLoadingSkeleton || isEmpty
      ? html`
          <div class="chat-thread-inner">
            ${props.historyPagination
              ? renderHistorySentinel(props.historyPagination.loading)
              : nothing}
            ${showLoadingSkeleton ? renderLoadingSkeleton() : nothing}
            ${isEmpty && !state.searchOpen ? renderWelcomeState(props) : nothing}
            ${isEmpty && state.searchOpen
              ? html` <div class="agent-chat__empty">${t("chat.thread.noMatches")}</div> `
              : nothing}
          </div>
        `
      : transcript.render(
          transcriptRows,
          (row) => (row.kind === "item" ? renderItem(row.item) : row.content),
          latestTranscriptAnnouncement(collapsedItems),
          props.announceTranscript !== false && !state.searchOpen && !props.loading,
          props.historyPagination
            ? renderHistorySentinel(props.historyPagination.loading)
            : nothing,
        );
  return html`
    <div
      class="chat-thread ${isDirectThread ? "chat-thread--direct" : ""}"
      role="log"
      aria-live="off"
      aria-relevant="additions"
      tabindex="0"
      @focusin=${(event: FocusEvent) => transcript.handleFocusIn(event)}
      @focusout=${(event: FocusEvent) => transcript.handleFocusOut(event)}
      @scroll=${props.onChatScroll}
      @wheel=${props.onHistoryIntent ? { handleEvent: props.onHistoryIntent, passive: true } : null}
      @keydown=${props.onHistoryIntent}
      @touchstart=${props.onHistoryIntent
        ? { handleEvent: props.onHistoryIntent, passive: true }
        : null}
      @touchmove=${props.onHistoryIntent
        ? { handleEvent: props.onHistoryIntent, passive: true }
        : null}
      @touchend=${props.onHistoryIntent}
      @touchcancel=${props.onHistoryIntent}
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
      <span
        class="chat-transcript-announcement agent-chat__sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        >${transcript.liveAnnouncementText}</span
      >
      ${transcriptContents}
    </div>
  `;
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
