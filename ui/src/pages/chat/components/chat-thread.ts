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
import type { QuestionPrompt } from "../../../app/question-prompt.ts";
import { resolveLocalUserName } from "../../../app/user-identity.ts";
import { copyMarkdownLabel } from "../../../components/copy-button.ts";
import { icons } from "../../../components/icons.ts";
import type { ImageLightboxItem } from "../../../components/image-lightbox.ts";
import { handleMarkdownCodeBlockCopy } from "../../../components/markdown-code-blocks.ts";
import {
  markdownFileLinkFromEvent,
  markdownFileLinkFromKeyboardEvent,
} from "../../../components/markdown-file-links.ts";
import "../../../components/tooltip.ts";
import { McpAppUnmountGate } from "../../../components/mcp-app-unmount.ts";
import { i18n, t } from "../../../i18n/index.ts";
import type { BoardProvider } from "../../../lib/board/provider.ts";
import type {
  ChatQueueItem,
  ChatStreamSegment,
  MessageGroup,
} from "../../../lib/chat/chat-types.ts";
import {
  buildCompanionQuestionPrefill,
  buildMoreDetailsCompanionQuestion,
} from "../../../lib/chat/companion-question.ts";
import { extractTextCached } from "../../../lib/chat/message-extract.ts";
import type { EmbedSandboxMode } from "../../../lib/chat/tool-display.ts";
import { copyToClipboard } from "../../../lib/clipboard.ts";
import { fnv1aUtf16 } from "../../../lib/fnv1a.ts";
import {
  areUiSessionKeysEquivalent,
  isUiGlobalScopeConfigured,
  parseAgentSessionKey,
  resolveUiGlobalAliasAgentId,
  type UiSessionDefaultsHost,
} from "../../../lib/sessions/session-key.ts";
import { resolveTurnRecap, type TurnRecap } from "../chat-progress.ts";
import type { ChatRunStartupStatus } from "../chat-run-startup.ts";
import {
  assistantGroupCanOwnActiveRunStatus,
  assistantMessageExpansionSignature,
  buildCachedChatItems,
  coalesceActivityRuns,
  coalesceStreamRuns,
  collapseCompletedTurnWork,
  deletedChatItemsSignature,
  getExpansionStateVersion,
  getExpandedToolCards,
  getExpandedAssistantMessages,
  getExpandedUserMessages,
  persistedMessageEntryId,
  resetChatThreadState,
  setExpansionState,
  syncToolCardExpansionState,
} from "../chat-thread.ts";
import { DeletedMessages } from "../deleted-messages.ts";
import { PinnedMessages } from "../pinned-messages.ts";
import type { RealtimeTalkConversationEntry } from "../realtime-talk-conversation.ts";
import {
  CHAT_TRANSCRIPT_END_THRESHOLD_PX,
  getChatSessionScrollPosition,
  saveChatSessionScrollPosition,
  type ChatSessionScrollPosition,
} from "../scroll.ts";
import { getOrCreateSessionCacheValue } from "../session-cache.ts";
import type { PlanStatus } from "../tool-stream.ts";
import { getToolTitlesVersion } from "../tool-titles.ts";
import { renderBackgroundTasksStatusRow } from "./chat-background-tasks-status.ts";
import type { BackgroundTasksProps } from "./chat-background-tasks.types.ts";
import { renderChatDivider, renderChatNotice } from "./chat-divider.ts";
import type { ArtifactDownloadResolver } from "./chat-message-media.ts";
import {
  dismissConfirmedActionPopovers,
  getAssistantAttachmentAvailabilityRenderVersion,
  openChatHideConfirmation,
  openChatRewindConfirmation,
  renderMessageGroup,
  renderActivityGroup,
  renderStreamGroup,
  renderWorkGroupSummary,
  type MessageReplyTarget,
  type StreamGroupOptions,
  type StreamGroupPart,
} from "./chat-message.ts";
import { renderRealtimeTalkConversation } from "./chat-realtime-controls.ts";
import { handleChatSelectionPointerUp, removeChatSelectionPopup } from "./chat-selection-popup.ts";
import type { SidebarContent, SidebarFullMessageLoader } from "./chat-sidebar.ts";
import { renderWelcomeState, resolveAssistantDisplayAvatar } from "./chat-welcome.ts";
import { renderTurnRecapRow } from "./chat-working-indicator.ts";

const pinnedMessagesMap = new Map<string, PinnedMessages>();
const deletedMessagesMap = new Map<string, DeletedMessages>();

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
  boardProvider?: BoardProvider;
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
  runId?: string | null;
  runOutputTokens?: number | null;
  queue: ChatQueueItem[];
  showThinking: boolean;
  showToolCalls: boolean;
  persistCommentary?: boolean;
  /** Suppresses transcript mutations while preserving read-only presentation controls. */
  readOnly?: boolean;
  /** True while the session has an abortable live run (marks running tool rows). */
  runActive?: boolean;
  /** True while the agent is visibly working (isChatRunWorking); shows the working spark. */
  runWorking?: boolean;
  /** Coarse startup stage shown until assistant or tool activity becomes visible. */
  startupStatus?: ChatRunStartupStatus | null;
  /** Re-labels the working spark while the active run is parked on an approval. */
  waitingApproval?: boolean;
  planStatus?: PlanStatus | null;
  questionPrompts?: readonly QuestionPrompt[];
  sessions: SessionsListResult | null;
  /** Host context resolving global-alias session keys (scope=global fleets). */
  /** Includes assistantAgentId so bare-global welcome recents scope to the selected agent. */
  sessionHost?: UiSessionDefaultsHost | null;
  gatewayUrl?: string;
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
  onRewindMessage?: (entryId: string) => Promise<boolean> | boolean;
  onForkMessage?: (entryId: string) => Promise<void> | void;
  onFocusComposer?: () => void;
  onCompanionQuestion?: (question: string) => void;
  onCompanionPrefill?: (question: string) => void;
  onOpenSession?: (sessionKey: string) => void;
  modelSetupRequired?: boolean;
  onModelSetup?: () => void;
  /** Tasks-rail snapshot backing the post-turn running-tasks status row. */
  backgroundTasks?: BackgroundTasksProps;
};

type ChatPinnedMessagesProps = Pick<
  ChatThreadProps,
  "paneId" | "sessionKey" | "messages" | "userName" | "userAvatar"
>;

type ChatRenderItem = ReturnType<typeof coalesceActivityRuns>[number];

type ChatTranscriptRow =
  | { kind: "item"; key: string; item: ChatRenderItem }
  | { kind: "content"; key: string; content: unknown };

type ChatTranscriptAnnouncement = {
  key: string;
  text: string;
};

const CHAT_TRANSCRIPT_ESTIMATED_ROW_PX = 120;
const CHAT_TRANSCRIPT_OVERSCAN = 6;
const CHAT_TRANSCRIPT_ANNOUNCEMENT_MAX_CHARS = 500;
// Initial virtual rows can correct their estimates for several frames. Hold a
// restored offset for ~200ms so those corrections cannot reapply the end anchor.
const CHAT_TRANSCRIPT_SCROLL_RESTORE_STABLE_FRAMES = 12;
// A committed short transcript can legitimately remain at maxOffset=0. Give
// initial measurement one second before treating that zero range as final.
const CHAT_TRANSCRIPT_ZERO_MAX_SETTLE_FRAMES = 60;
// Keep the active transcript plus two recent sessions. Eviction always tears
// down observers first; otherwise a discarded host would leak row observers.
const CHAT_TRANSCRIPT_VIRTUALIZER_CACHE_LIMIT = 3;

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
  private threadInnerElement: HTMLDivElement | null = null;
  private connected = false;
  private observedWidth: number | null = null;
  private contentReady = false;
  private pendingScrollOffset: {
    offset: number;
    stableFrames: number;
    zeroMaxFrames: number;
    onSettled?: (position: ChatSessionScrollPosition) => void;
  } | null = null;
  private pendingScrollFrame: number | null = null;
  // Lit calls refs before newly rendered nodes are connected. Resolve the
  // scroll parent lazily or a stable ref can permanently capture null.
  private get scrollElement(): HTMLDivElement | null {
    const parent = this.threadInnerElement?.parentElement;
    return parent instanceof HTMLDivElement ? parent : null;
  }
  // Stable Lit refs: inline arrows change identity per render, making Lit
  // re-invoke them for every visible row and re-measure each row every render.
  // Lit tracks the last element per callback, so each row needs its own.
  private readonly scrollElementRef = (element?: Element) => {
    this.threadInnerElement = element instanceof HTMLDivElement ? element : null;
  };
  private readonly measureRowRefs = new Map<string, (element?: Element) => void>();
  private pruneDetachedRowsQueued = false;
  private pendingRowMeasureFrame: number | null = null;
  private measureConnectedRows(): void {
    // Only width invalidation owns forced DOM reads. Ordinary row refs stay on
    // TanStack's observer path so resizeItem cannot perturb scroll restoration.
    const instance = this.virtualizerController.getVirtualizer();
    for (const row of this.threadInnerElement?.querySelectorAll<HTMLElement>(".chat-virtual-row") ??
      []) {
      instance.resizeItem(
        instance.indexFromElement(row),
        row[instance.options.horizontal ? "offsetWidth" : "offsetHeight"],
      );
    }
  }
  private queueConnectedRowMeasure(): void {
    if (this.pendingRowMeasureFrame !== null) {
      return;
    }
    this.pendingRowMeasureFrame = requestAnimationFrame(() => {
      this.pendingRowMeasureFrame = null;
      this.measureConnectedRows();
    });
  }
  private measureRowRefFor(key: string): (element?: Element) => void {
    let callback = this.measureRowRefs.get(key);
    if (!callback) {
      callback = (element?: Element) => {
        if (element instanceof HTMLElement) {
          this.virtualizerController.getVirtualizer().measureElement(element);
          return;
        }
        // Re-stamps (e.g. the chat<->dashboard face switch) re-invoke each
        // stable row ref as an (undefined, element) pair while the new subtree
        // is still detached. measureElement(null) prunes every disconnected
        // row, so calling it synchronously unobserves just-registered sibling
        // rows and freezes their heights at the old pane width (overlapping
        // bubbles). Defer until the commit lands so only removed rows prune.
        if (this.pruneDetachedRowsQueued) {
          return;
        }
        this.pruneDetachedRowsQueued = true;
        queueMicrotask(() => {
          this.pruneDetachedRowsQueued = false;
          this.virtualizerController.getVirtualizer().measureElement(null);
        });
      };
      this.measureRowRefs.set(key, callback);
    }
    return callback;
  }
  private rowKeys: readonly string[] = [];
  private rowIndexesByKey = new Map<string, number>();
  private focusedRowKey: string | null = null;
  private announcementInitialized = false;
  private announcementKey: string | null = null;
  private currentAnnouncementText = "";
  private readonly mcpAppUnmountGate = new McpAppUnmountGate(this);

  constructor(
    private readonly host: ReactiveControllerHost,
    initialOffset: number | null = null,
    onInitialOffsetSettled?: (position: ChatSessionScrollPosition) => void,
  ) {
    this.virtualizerController = new VirtualizerController(this, {
      count: 0,
      getScrollElement: () => this.scrollElement,
      estimateSize: () => CHAT_TRANSCRIPT_ESTIMATED_ROW_PX,
      getItemKey: () => "",
      initialRect: initialTranscriptRect(host),
      initialOffset: initialOffset ?? Number.MAX_SAFE_INTEGER,
      scrollMargin: initialTranscriptScrollMargin(host),
      anchorTo: "end",
      followOnAppend: false,
      observeElementRect: (instance, callback) =>
        observeElementRect(instance, (rect) => {
          const widthChanged = this.observedWidth !== null && this.observedWidth !== rect.width;
          this.observedWidth = rect.width;
          this.syncScrollMargin(instance.scrollElement);
          callback(rect);
          if (widthChanged) {
            // Cached offscreen sizes belong to the old wrapping width. Reset
            // them, seed current rows, then repeat after any same-commit
            // re-stamp has attached and completed layout.
            instance.measure();
            this.measureConnectedRows();
            this.queueConnectedRowMeasure();
          }
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
    if (initialOffset !== null) {
      this.pendingScrollOffset = {
        offset: initialOffset,
        stableFrames: 0,
        zeroMaxFrames: 0,
        onSettled: onInitialOffsetSettled,
      };
    }
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
    if (this.connected) {
      return;
    }
    this.connected = true;
    for (const controller of this.controllers) {
      controller.hostConnected?.();
    }
    if (this.pendingScrollOffset) {
      this.host.requestUpdate();
    }
  }

  update(): void {
    for (const controller of this.controllers) {
      controller.hostUpdated?.();
    }
    this.applyPendingScrollOffset();
  }

  disconnect(): void {
    if (this.pendingRowMeasureFrame !== null) {
      cancelAnimationFrame(this.pendingRowMeasureFrame);
      this.pendingRowMeasureFrame = null;
    }
    if (this.pendingScrollFrame !== null) {
      cancelAnimationFrame(this.pendingScrollFrame);
      this.pendingScrollFrame = null;
    }
    if (!this.connected) {
      this.threadInnerElement = null;
      return;
    }
    this.connected = false;
    for (const controller of this.controllers) {
      controller.hostDisconnected?.();
    }
    this.threadInnerElement = null;
  }

  dispose(): void {
    this.disconnect();
    this.measureRowRefs.clear();
    this.rowKeys = [];
    this.rowIndexesByKey.clear();
    this.focusedRowKey = null;
    this.pendingScrollOffset = null;
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
    const nextRowKeys = new Set(
      virtualRows.flatMap((virtualRow) => {
        const row = rows[virtualRow.index];
        return row ? [row.key] : [];
      }),
    );
    const rendered = html`
      <div class="chat-thread-inner chat-thread-inner--virtual" ${ref(this.scrollElementRef)}>
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
                  ${ref(this.measureRowRefFor(row.key))}
                >
                  ${renderRow(row)}
                </div>
              `;
            },
          )}
        </div>
      </div>
    `;
    return this.mcpAppUnmountGate.render(JSON.stringify([...nextRowKeys]), rendered, () =>
      this.threadInnerElement
        ? [...this.threadInnerElement.querySelectorAll<HTMLElement>(".chat-virtual-row")].filter(
            (row) => !nextRowKeys.has(row.dataset.virtualRowKey ?? ""),
          )
        : [],
    ) as TemplateResult;
  }

  scrollToEnd(options: { behavior?: ScrollBehavior } = {}): void {
    this.virtualizerController.getVirtualizer().scrollToEnd(options);
  }

  scrollToOffset(offset: number): void {
    if (this.scrollElement) {
      this.scrollElement.scrollTop = offset;
    }
    this.virtualizerController.getVirtualizer().scrollToOffset(offset);
  }

  getScrollOffset(): number | null {
    return this.scrollElement?.scrollTop ?? null;
  }

  getMaxScrollOffset(): number | null {
    const scrollElement = this.scrollElement;
    return scrollElement
      ? Math.max(0, scrollElement.scrollHeight - scrollElement.clientHeight)
      : null;
  }

  setContentReady(ready: boolean): void {
    this.contentReady = ready;
  }

  restoreScrollOffset(
    offset: number,
    onSettled?: (position: ChatSessionScrollPosition) => void,
  ): void {
    this.pendingScrollOffset = { offset, stableFrames: 0, zeroMaxFrames: 0, onSettled };
    if (this.connected) {
      this.host.requestUpdate();
    }
  }

  getPendingScrollOffset(): number | null {
    return this.pendingScrollOffset?.offset ?? null;
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
    for (const key of this.measureRowRefs.keys()) {
      if (!this.rowIndexesByKey.has(key)) {
        this.measureRowRefs.delete(key);
      }
    }
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

  private applyPendingScrollOffset(): void {
    const pending = this.pendingScrollOffset;
    if (!pending || !this.connected) {
      return;
    }
    const maxOffset = this.getMaxScrollOffset();
    if (maxOffset === null) {
      if (this.contentReady && this.rowKeys.length === 0) {
        this.settlePendingScroll(0);
      }
      return;
    }
    if (maxOffset === 0 && pending.offset > 0) {
      if (this.contentReady && this.rowKeys.length === 0) {
        this.settlePendingScroll(0);
      } else if (this.contentReady) {
        if (pending.zeroMaxFrames >= CHAT_TRANSCRIPT_ZERO_MAX_SETTLE_FRAMES) {
          this.settlePendingScroll(0);
          return;
        }
        pending.zeroMaxFrames += 1;
        this.schedulePendingScrollRetry();
      }
      return;
    }
    pending.zeroMaxFrames = 0;
    const targetOffset = Math.min(pending.offset, maxOffset);
    this.scrollToOffset(targetOffset);
    const currentOffset = this.getScrollOffset();
    if (currentOffset != null && Math.abs(currentOffset - targetOffset) <= 1) {
      if (pending.stableFrames >= CHAT_TRANSCRIPT_SCROLL_RESTORE_STABLE_FRAMES) {
        this.settlePendingScroll(currentOffset);
      } else {
        pending.stableFrames += 1;
        this.schedulePendingScrollRetry();
      }
    } else {
      pending.stableFrames = 0;
      this.schedulePendingScrollRetry();
    }
  }

  private schedulePendingScrollRetry(): void {
    if (!this.connected || this.pendingScrollFrame !== null) {
      return;
    }
    this.pendingScrollFrame = requestAnimationFrame(() => {
      this.pendingScrollFrame = null;
      if (this.connected && this.pendingScrollOffset) {
        this.host.requestUpdate();
      }
    });
  }

  private settlePendingScroll(scrollTop: number): void {
    const pending = this.pendingScrollOffset;
    this.pendingScrollOffset = null;
    if (!pending) {
      return;
    }
    const maxScrollTop = this.getMaxScrollOffset();
    pending.onSettled?.({
      scrollTop,
      anchorToEnd:
        maxScrollTop === null
          ? this.contentReady && this.rowKeys.length === 0
          : maxScrollTop - scrollTop <= CHAT_TRANSCRIPT_END_THRESHOLD_PX,
    });
  }
}

export class ChatTranscriptController implements ReactiveController {
  private activeSessionKey: string | null = null;
  private sessionVirtualizer: ChatSessionVirtualizerHost | null = null;
  private readonly sessionVirtualizers = new Map<string, ChatSessionVirtualizerHost>();
  private connected = false;

  constructor(private readonly host: ReactiveControllerHost) {
    host.addController(this);
  }

  get renderedSessionKey(): string | null {
    return this.activeSessionKey;
  }

  render(props: ChatThreadProps): TemplateResult {
    if (
      !this.sessionVirtualizer ||
      this.activeSessionKey === null ||
      !areUiSessionKeysEquivalent(this.activeSessionKey, props.sessionKey)
    ) {
      this.sessionVirtualizer?.disconnect();
      let cachedKey: string | null = null;
      let nextVirtualizer: ChatSessionVirtualizerHost | null = null;
      for (const [sessionKey, virtualizer] of this.sessionVirtualizers) {
        if (areUiSessionKeysEquivalent(sessionKey, props.sessionKey)) {
          cachedKey = sessionKey;
          nextVirtualizer = virtualizer;
          break;
        }
      }
      if (cachedKey !== null && nextVirtualizer) {
        this.sessionVirtualizers.delete(cachedKey);
      } else {
        const savedPosition = getChatSessionScrollPosition(props.paneId, props.sessionKey);
        const initialOffset = savedPosition?.anchorToEnd
          ? null
          : (savedPosition?.scrollTop ?? null);
        nextVirtualizer = new ChatSessionVirtualizerHost(
          this.host,
          initialOffset,
          initialOffset === null
            ? undefined
            : (position) => {
                saveChatSessionScrollPosition(props.paneId, props.sessionKey, position);
              },
        );
      }
      this.activeSessionKey = props.sessionKey;
      this.sessionVirtualizer = nextVirtualizer;
      this.sessionVirtualizers.set(props.sessionKey, nextVirtualizer);
      this.evictInactiveVirtualizers();
      if (this.connected) {
        this.sessionVirtualizer.connect();
      }
    }
    return renderChatThreadContents(props, this.sessionVirtualizer);
  }

  scrollToEnd(options: { behavior?: ScrollBehavior } = {}): void {
    this.sessionVirtualizer?.scrollToEnd(options);
  }

  scrollToOffset(offset: number, onSettled?: (position: ChatSessionScrollPosition) => void): void {
    this.sessionVirtualizer?.restoreScrollOffset(offset, onSettled);
  }

  pendingScrollOffsetFor(sessionKey: string): number | null {
    return this.activeSessionKey !== null &&
      areUiSessionKeysEquivalent(this.activeSessionKey, sessionKey)
      ? (this.sessionVirtualizer?.getPendingScrollOffset() ?? null)
      : null;
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
    for (const virtualizer of this.sessionVirtualizers.values()) {
      virtualizer.disconnect();
    }
  }

  private evictInactiveVirtualizers(): void {
    while (this.sessionVirtualizers.size > CHAT_TRANSCRIPT_VIRTUALIZER_CACHE_LIMIT) {
      const oldest = this.sessionVirtualizers.entries().next().value as
        | [string, ChatSessionVirtualizerHost]
        | undefined;
      if (!oldest) {
        return;
      }
      const [sessionKey, virtualizer] = oldest;
      this.sessionVirtualizers.delete(sessionKey);
      virtualizer.dispose();
    }
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

function dismissChatThreadPortals(paneId?: string, owner?: ParentNode): void {
  removeReplyContextMenu(paneId);
  if (owner) {
    dismissConfirmedActionPopovers(owner);
  }
  // The selection popup is body-portaled; pane teardown/route changes must
  // drop it so it cannot outlive the render that owns its callbacks.
  removeChatSelectionPopup();
}

export function resetChatThreadSessionPresentationState(paneId: string, owner?: ParentNode): void {
  dismissChatThreadPortals(paneId, owner);
  const state = threadStates.get(paneId);
  if (state) {
    // Search input belongs to the outgoing transcript. Other fields are pane
    // preferences or dependency memos and invalidate themselves on new props.
    state.searchOpen = false;
    state.searchQuery = "";
  }
}

export function resetChatThreadPresentationState(paneId?: string, owner?: ParentNode) {
  dismissChatThreadPortals(paneId, owner);
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
        ${icons.bookmark} ${t("chat.thread.pinnedCount", { count: String(entries.length) })}
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
                      >${role === "user" ? userRoleLabel : t("common.assistant")}</span
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

function handleChatThreadSelectionPointerUp(event: PointerEvent, props: ChatThreadProps) {
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

function chatGroupRowKeys(group: HTMLElement): string[] {
  const serialized = group.dataset.chatRowKeys;
  if (serialized) {
    try {
      const keys = JSON.parse(serialized);
      if (Array.isArray(keys) && keys.every((key) => typeof key === "string")) {
        return keys;
      }
    } catch {
      // Fall through to the canonical single-row key.
    }
  }
  const key = group.dataset.chatRowKey?.trim();
  return key ? [key] : [];
}

function handleChatContextMenu(event: MouseEvent, props: ChatThreadProps) {
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
  const groupKeys = chatGroupRowKeys(group);
  const isUserMessage = group.classList.contains("user") && Boolean(entryId);
  // Grouped rows can contain several bubbles. Match the clicked bubble to its
  // own action owner so copy never targets a sibling message.
  const actionOwner = [...group.querySelectorAll<HTMLElement>("[data-message-actions-for]")].find(
    (element) => element.dataset.messageActionsFor === messageId,
  );
  const copyButton = actionOwner?.querySelector<HTMLButtonElement>(".chat-copy-btn");
  const canReply = Boolean(text && props.onSetReply);
  const canRewind = isUserMessage && typeof props.onRewindMessage === "function";
  const canHide = !props.readOnly && groupKeys.length > 0;
  const canCopy = Boolean(copyButton);
  const canFork = isUserMessage && typeof props.onForkMessage === "function";
  if (!canReply && !canRewind && !canHide && !canCopy && !canFork) {
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
    action.element.classList.add("chat-delete-wrap", "chat-rewind-wrap");
    menu.append(action.element);
    focusCandidates.push(action.button);
  }
  if (canHide) {
    const action = createMessageActionContextButton({
      label: t("chat.messages.hideMessage"),
      disabled: false,
      tooltip: t("chat.messages.hideTooltip"),
      onClick: () => {
        openChatHideConfirmation(action.button, () => {
          removeReplyContextMenu();
          const deleted = getDeletedMessages(props.sessionKey);
          for (const key of groupKeys) {
            deleted.delete(key);
          }
          props.onRequestUpdate?.();
        });
      },
    });
    action.element.classList.add("chat-delete-wrap");
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
  if (item.kind === "activity-run") {
    return [item.key, ...item.groups];
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

function guardChatRenderItems(
  state: ChatThreadState,
  // Live run status is not derivable from a row's own item identity: ownership
  // is decided by sibling rows, and the usage counter ticks on run patches that
  // touch nothing else. Rows showing status must re-render on both, or the
  // memoized copy stacks a second claw row or freezes the token count.
  liveStatus: (item: ChatRenderItem) => string,
  render: (item: ChatRenderItem) => unknown,
) {
  return (item: ChatRenderItem) =>
    guard(
      [...chatRenderItemGuardDependencies(item), state.transcriptRenderContext, liveStatus(item)],
      () => render(item),
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
  const searchFiltering = state.searchOpen && Boolean(state.searchQuery.trim());
  const chatItems = buildCachedChatItems({
    paneId: props.paneId,
    sessionKey: props.sessionKey,
    runId: props.runId === undefined ? (activeSession?.activeRunIds?.[0] ?? null) : props.runId,
    locale,
    messages: props.messages,
    toolMessages: props.toolMessages,
    streamSegments: props.streamSegments,
    stream: displayStream,
    streamStartedAt: props.streamStartedAt,
    queue: props.queue,
    showToolCalls: props.showToolCalls,
    persistCommentary: props.persistCommentary,
    runWorking: Boolean(props.runWorking),
    runActive: Boolean(props.runActive),
    planStatus: props.planStatus,
    questionPrompts: props.questionPrompts,
    loading: props.loading,
    searchOpen: state.searchOpen,
    searchQuery: state.searchQuery,
  });
  syncToolCardExpansionState(
    props.sessionKey,
    chatItems,
    Boolean(props.autoExpandToolCalls),
    searchFiltering || !props.showToolCalls,
  );
  const expandedToolCards = getExpandedToolCards(props.sessionKey);
  const expandedUserMessages = getExpandedUserMessages(props.sessionKey);
  const expandedAssistantMessages = getExpandedAssistantMessages(props.sessionKey);
  const questionPrompts = new Map(
    (props.questionPrompts ?? []).map((prompt) => [prompt.id, prompt]),
  );
  const toggleToolCardExpanded = (toolCardId: string) => {
    setExpansionState(expandedToolCards, toolCardId, !expandedToolCards.get(toolCardId));
    requestUpdate();
  };
  const toggleAssistantMessageExpanded = (messageId: string) => {
    const current = expandedAssistantMessages.get(messageId);
    if (current?.status === "loaded") {
      expandedAssistantMessages.set(messageId, {
        ...current,
        expanded: !current.expanded,
        revision: current.revision + 1,
      });
      requestUpdate();
      return;
    }
    const loader = props.loadFullAssistantMessage;
    if (!loader || current?.status === "loading") {
      return;
    }
    const revision = (current?.revision ?? 0) + 1;
    expandedAssistantMessages.set(messageId, { status: "loading", revision });
    requestUpdate();
    void loader({
      sessionKey: props.sessionKey,
      ...(props.fullMessageAgentId ? { agentId: props.fullMessageAgentId } : {}),
      messageId,
      kind: "assistant_message",
    }).then(
      (result) => {
        const pending = expandedAssistantMessages.get(messageId);
        if (pending?.status !== "loading" || pending.revision !== revision) {
          return;
        }
        const markdown =
          result?.ok && result.message && typeof result.message === "object"
            ? extractTextCached(result.message)
            : null;
        expandedAssistantMessages.set(
          messageId,
          markdown === null
            ? { status: "error", revision: revision + 1 }
            : { status: "loaded", expanded: true, markdown, revision: revision + 1 },
        );
        requestUpdate();
      },
      () => {
        const pending = expandedAssistantMessages.get(messageId);
        if (pending?.status !== "loading" || pending.revision !== revision) {
          return;
        }
        expandedAssistantMessages.set(messageId, { status: "error", revision: revision + 1 });
        requestUpdate();
      },
    );
  };
  const hasRealtimeTalkConversation = (props.realtimeTalkConversation?.length ?? 0) > 0;
  const isEmpty = chatItems.length === 0 && !props.loading && !hasRealtimeTalkConversation;
  transcript.setContentReady(!props.loading);
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
  // keeps avatars like "group" and "unknown" do. An identity-resolving gateway
  // (multi-user trusted proxy) also keeps them: several people share these
  // sessions, so the author marker is signal, not decoration.
  const isDirectThread =
    (sessionKind === "direct" || sessionKind === "cron" || sessionKind === "spawn-child") &&
    !props.userId;
  const showLoadingSkeleton = props.loading && chatItems.length === 0;
  const threadContextWindow =
    activeSession?.contextTokens ?? props.sessions?.defaults?.contextTokens ?? null;
  const activeContinuationByGroupKey = new Map<
    string,
    { parts: StreamGroupPart[]; options: StreamGroupOptions }
  >();
  const turnRecapByGroupKey = new Map<string, TurnRecap>();
  const sharedMessageRenderOptions = {
    onOpenSidebar: props.onOpenSidebar,
    sessionKey: props.sessionKey,
    boardProvider: props.boardProvider,
    agentId: props.fullMessageAgentId,
    runActive: props.runActive,
    onOpenWorkspaceFile: props.onOpenWorkspaceFile,
    onRequestUpdate: requestUpdate,
    basePath: props.basePath,
    localMediaPreviewRoots: props.localMediaPreviewRoots ?? [],
    assistantAttachmentAuthToken: props.assistantAttachmentAuthToken ?? null,
    resolveArtifactDownload: props.resolveArtifactDownload,
    onAssistantAttachmentLoaded: props.onAssistantAttachmentLoaded,
    onRequestOpenImage: props.onRequestOpenImage,
    onOpenImage: props.onOpenImage,
    canvasPluginSurfaceUrl: props.canvasPluginSurfaceUrl,
    embedSandboxMode: props.embedSandboxMode ?? "scripts",
    allowExternalEmbedUrls: props.allowExternalEmbedUrls ?? false,
  } satisfies StreamGroupOptions;
  const streamGroupOptions = {
    ...sharedMessageRenderOptions,
    assistant: assistantIdentity,
  } satisfies StreamGroupOptions;
  const renderGroupOptions = (item: MessageGroup, onDelete: () => void) => {
    const lastMessage = item.messages.at(-1)?.message;
    const rewindEntryId =
      item.role.toLowerCase() === "user" && lastMessage
        ? persistedMessageEntryId(lastMessage)
        : null;
    return {
      ...sharedMessageRenderOptions,
      showReasoning,
      showToolCalls: props.showToolCalls,
      autoExpandToolCalls: Boolean(props.autoExpandToolCalls),
      isToolMessageExpanded: (messageId: string) => expandedToolCards.get(messageId),
      onToggleToolMessageExpanded: (messageId: string, expanded?: boolean) => {
        setExpansionState(
          expandedToolCards,
          messageId,
          !(expanded ?? expandedToolCards.get(messageId) ?? false),
        );
        requestUpdate();
      },
      isUserMessageExpanded: (messageId: string) => expandedUserMessages.get(messageId) ?? false,
      onToggleUserMessageExpanded: (messageId: string) => {
        setExpansionState(expandedUserMessages, messageId, !expandedUserMessages.get(messageId));
        requestUpdate();
      },
      loadFullAssistantMessage: props.loadFullAssistantMessage ?? undefined,
      getAssistantMessageExpansion: (messageId: string) => expandedAssistantMessages.get(messageId),
      onToggleAssistantMessageExpanded: toggleAssistantMessageExpanded,
      isToolExpanded: (toolCardId: string) => expandedToolCards.get(toolCardId) ?? false,
      onToggleToolExpanded: toggleToolCardExpanded,
      assistantName: props.assistantName,
      assistantAvatar: assistantIdentity.avatar,
      userId: props.userId ?? null,
      userName: props.userName ?? null,
      userAvatar: props.userAvatar ?? null,
      showAvatarGutter: !isDirectThread,
      contextWindow: threadContextWindow,
      onReply: props.onSetReply,
      onDelete: props.readOnly ? undefined : onDelete,
      onRewind:
        rewindEntryId && props.onRewindMessage
          ? () => {
              void Promise.resolve(props.onRewindMessage?.(rewindEntryId)).then((rewound) => {
                if (rewound) {
                  props.onFocusComposer?.();
                }
              });
            }
          : undefined,
      rewindDisabled: Boolean(props.runActive || props.runWorking),
      activeContinuation: activeContinuationByGroupKey.get(item.key),
      turnRecap: turnRecapByGroupKey.get(item.key),
    } satisfies Parameters<typeof renderMessageGroup>[1];
  };
  const renderGroupItem = (item: MessageGroup) => {
    if (deleted.has(item.key)) {
      return nothing;
    }
    return renderMessageGroup(
      item,
      renderGroupOptions(item, () => {
        deleted.delete(item.key);
        requestUpdate();
      }),
    );
  };
  // Only the working indicator shows live usage, so rows without one keep
  // memoizing across usage patches.
  const workingUsageKey = `usage:${props.runOutputTokens ?? ""}`;
  const liveStatusSignature = (item: ChatRenderItem): string => {
    if (item.kind === "stream-run") {
      return item.parts.some((part) => part.kind === "reading-indicator") ? workingUsageKey : "";
    }
    if (item.kind !== "group") {
      return "";
    }
    const continuation = activeContinuationByGroupKey.get(item.key);
    const recap = turnRecapByGroupKey.get(item.key);
    // Part keys stand in for the rest of the continuation: its remaining
    // options mirror props that already invalidate every row through the
    // shared render context.
    const continuationKey = continuation
      ? `${continuation.parts.map((part) => part.key).join(" ")}${workingUsageKey}`
      : "";
    const recapKey = recap ? `${recap.runtimeMs}:${recap.outputTokens ?? ""}` : "";
    return `${continuationKey}|${recapKey}`;
  };
  const renderItem = guardChatRenderItems(state, liveStatusSignature, (item) => {
    if (item.kind === "divider") {
      return renderChatDivider(item, props.onOpenSessionCheckpoints);
    }
    if (item.kind === "notice") {
      return renderChatNotice(item);
    }
    if (item.kind === "stream-run") {
      return renderStreamGroup(item.parts, {
        ...streamGroupOptions,
        questionPrompts,
        planStatus: props.planStatus,
        planActive: Boolean(props.runActive),
        startupPhase: props.startupStatus?.phase,
        waitingApproval: props.waitingApproval,
        runOutputTokens: props.runOutputTokens,
      });
    }
    if (item.kind === "work-group") {
      const workExpanded = expandedToolCards.get(item.key) ?? item.hasError;
      return html`
        ${renderWorkGroupSummary(item, {
          expanded: workExpanded,
          onToggle: () => {
            setExpansionState(expandedToolCards, item.key, !workExpanded);
            requestUpdate();
          },
        })}
        ${workExpanded ? item.groups.map((group) => renderGroupItem(group)) : nothing}
      `;
    }
    if (item.kind === "activity-run") {
      const visibleGroups = item.groups.filter((group) => !deleted.has(group.key));
      const firstGroup = visibleGroups[0];
      if (!firstGroup) {
        return nothing;
      }
      if (visibleGroups.length === 1) {
        return renderGroupItem(firstGroup);
      }
      return renderActivityGroup(
        visibleGroups,
        renderGroupOptions(firstGroup, () => {
          for (const group of item.groups) {
            deleted.delete(group.key);
          }
          requestUpdate();
        }),
      );
    }
    if (item.kind === "group") {
      return renderGroupItem(item);
    }
    if (item.kind === "question") {
      return renderStreamGroup([item], {
        questionPrompts,
      });
    }
    return nothing;
  });
  const collapsedItems = coalesceActivityRuns(
    collapseCompletedTurnWork(coalesceStreamRuns(chatItems), {
      sessionKey: props.sessionKey,
      runWorking: Boolean(props.runWorking),
      searchActive: searchFiltering,
    }),
    { searchActive: searchFiltering },
  );
  // Watch/settle on actual indicator visibility (not runWorking): queued
  // sends show the claw before the run starts, and the recap must never
  // stack under a visible working row.
  const workingIndicatorVisible = chatItems.some((item) => item.kind === "reading-indicator");
  const turnRecap = resolveTurnRecap(props.sessionKey, workingIndicatorVisible, activeSession);
  const transcriptItems = collapsedItems.filter((item, index) => {
    if (item.kind !== "stream-run") {
      return true;
    }
    const previous = collapsedItems[index - 1];
    const isActiveStatusRun =
      item.parts.some((part) => part.kind === "reading-indicator") &&
      item.parts.every((part) => part.kind === "reading-indicator" || part.kind === "plan");
    if (
      previous?.kind !== "group" ||
      !isActiveStatusRun ||
      deleted.has(previous.key) ||
      !assistantGroupCanOwnActiveRunStatus(previous)
    ) {
      return true;
    }
    // A reply and its still-running state are one turn-level presentation.
    // Keeping the status in the reply avoids a second claw/assistant row.
    activeContinuationByGroupKey.set(previous.key, {
      parts: item.parts,
      options: {
        ...streamGroupOptions,
        planStatus: props.planStatus,
        planActive: Boolean(props.runActive),
        startupPhase: props.startupStatus?.phase,
        waitingApproval: props.waitingApproval,
        runOutputTokens: props.runOutputTokens,
      },
    });
    return false;
  });
  let turnRecapOwnerKey: string | null = null;
  if (turnRecap !== null) {
    const lastItem = transcriptItems.at(-1);
    if (
      lastItem?.kind === "group" &&
      !deleted.has(lastItem.key) &&
      assistantGroupCanOwnActiveRunStatus(lastItem)
    ) {
      turnRecapByGroupKey.set(lastItem.key, turnRecap);
      turnRecapOwnerKey = lastItem.key;
    }
  }
  const transcriptRows: ChatTranscriptRow[] = transcriptItems.map((item) => ({
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
  if (turnRecap !== null && turnRecapOwnerKey === null && !isEmpty && !showLoadingSkeleton) {
    transcriptRows.push({
      kind: "content",
      key: "turn-recap",
      content: renderTurnRecapRow(turnRecap),
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
    expandedToolCards,
    getExpansionStateVersion(expandedToolCards),
    expandedUserMessages,
    getExpansionStateVersion(expandedUserMessages),
    assistantMessageExpansionSignature(expandedAssistantMessages),
    getAssistantAttachmentAvailabilityRenderVersion(),
    // The host minute poll requests an update; this key crosses row guard() memoization.
    Math.floor(Date.now() / 60_000),
    getToolTitlesVersion(),
    props.sessionKey,
    props.gatewayUrl,
    props.boardProvider,
    props.boardProvider?.canPinWidgets,
    props.boardProvider?.canPinMcpApps,
    props.boardProvider?.snapshot$.value.revision,
    props.fullMessageAgentId,
    Boolean(props.loadFullAssistantMessage),
    showReasoning,
    props.showToolCalls,
    Boolean(props.runActive),
    Boolean(props.runWorking),
    props.startupStatus?.phase,
    Boolean(props.waitingApproval),
    props.planStatus,
    props.questionPrompts,
    Boolean(props.autoExpandToolCalls),
    Boolean(props.readOnly),
    props.assistantName,
    assistantIdentity.avatar,
    props.userId,
    props.userName,
    props.userAvatar,
    props.basePath,
    (props.localMediaPreviewRoots ?? []).join("\u0000"),
    props.assistantAttachmentAuthToken,
    props.canvasPluginSurfaceUrl,
    props.embedSandboxMode ?? "scripts",
    props.allowExternalEmbedUrls ?? false,
    threadContextWindow,
    props.onSetReply,
    turnRecap === null ? "" : `${turnRecap.runtimeMs}:${turnRecap.outputTokens ?? ""}`,
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
      @keydown=${(event: KeyboardEvent) => {
        const target = markdownFileLinkFromKeyboardEvent(event);
        if (target) {
          props.onOpenWorkspaceFile?.(target);
          return;
        }
        props.onHistoryIntent?.(event);
      }}
      @touchstart=${props.onHistoryIntent
        ? { handleEvent: props.onHistoryIntent, passive: true }
        : null}
      @touchmove=${props.onHistoryIntent
        ? { handleEvent: props.onHistoryIntent, passive: true }
        : null}
      @touchend=${props.onHistoryIntent}
      @touchcancel=${props.onHistoryIntent}
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
