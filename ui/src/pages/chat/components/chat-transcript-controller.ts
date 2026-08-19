// Session-owned virtualizer lifecycle for chat transcripts.
import { VirtualizerController } from "@tanstack/lit-virtual";
import {
  measureElement as measureVirtualElement,
  observeElementRect,
} from "@tanstack/virtual-core";
import {
  html,
  nothing,
  type ReactiveController,
  type ReactiveControllerHost,
  type TemplateResult,
} from "lit";
import { ref } from "lit/directives/ref.js";
import { repeat } from "lit/directives/repeat.js";
import { styleMap } from "lit/directives/style-map.js";
import { McpAppUnmountGate } from "../../../components/mcp-app-unmount.ts";
import { areUiSessionKeysEquivalent } from "../../../lib/sessions/session-key.ts";
import {
  CHAT_TRANSCRIPT_END_THRESHOLD_PX,
  getChatSessionScrollPosition,
  saveChatSessionScrollPosition,
  type ChatSessionScrollPosition,
} from "../scroll.ts";
import { extractTranscriptRange, previewTranscriptRowKeys } from "./chat-transcript-range.ts";

export type TranscriptRow<T = unknown> =
  | { kind: "item"; key: string; item: T }
  | { kind: "content"; key: string; content: unknown };

export type TranscriptAnnouncement = {
  key: string;
  text: string;
};

export type ChatTranscriptSession = {
  readonly liveAnnouncementText: string;
  render<T>(
    rows: readonly TranscriptRow<T>[],
    renderRow: (row: TranscriptRow<T>) => unknown,
    announcement: TranscriptAnnouncement | null,
    announce: boolean,
    overlay?: unknown,
  ): TemplateResult;
  syncMessageRows(messageRowKeysById: ReadonlyMap<string, string>): void;
  revealMessage(messageId: string): boolean;
  setContentReady(ready: boolean): void;
  handleFocusIn(event: FocusEvent): void;
  handleFocusOut(event: FocusEvent): void;
};

const CHAT_TRANSCRIPT_ESTIMATED_ROW_PX = 120;
const CHAT_TRANSCRIPT_OVERSCAN = 6;
// Initial virtual rows can correct their estimates for several frames. Hold a
// restored offset for ~200ms so those corrections cannot reapply the end anchor.
const CHAT_TRANSCRIPT_SCROLL_RESTORE_STABLE_FRAMES = 12;
// A committed short transcript can legitimately remain at maxOffset=0. Give
// initial measurement one second before treating that zero range as final.
const CHAT_TRANSCRIPT_ZERO_MAX_SETTLE_FRAMES = 60;
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

class ChatSessionVirtualizerHost implements ReactiveControllerHost, ChatTranscriptSession {
  private readonly controllers = new Set<ReactiveController>();
  private readonly virtualizerController: VirtualizerController<HTMLDivElement, HTMLElement>;
  private threadInnerElement: HTMLDivElement | null = null;
  private connected = false;
  private observedWidth: number | null = null;
  private observedHeight: number | null = null;
  private contentReady = false;
  private implicitEndAnchorPending: boolean;
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
    const next = element instanceof HTMLDivElement ? element : null;
    if (next === this.threadInnerElement) {
      return;
    }
    this.threadInnerElement = next;
    this.queueScrollElementAttach();
  };
  // The transcript template can be stamped by a host other than the pane that
  // drives this controller: sidebar panels receive it as a property and render
  // it in their own, later update cycle. The virtualizer re-resolves its
  // scroll element only inside _willUpdate, which runs on the pane's update —
  // after a foreign-host re-stamp (chat<->dashboard face switch docking chat
  // into the sidebar) no pane update follows, so the virtualizer stays
  // detached and paints zero rows until an unrelated re-render. Attachment
  // must follow the DOM identity this ref records, not the pane render cycle.
  private scrollElementAttachQueued = false;
  private queueScrollElementAttach(): void {
    if (this.scrollElementAttachQueued) {
      return;
    }
    this.scrollElementAttachQueued = true;
    queueMicrotask(() => {
      this.scrollElementAttachQueued = false;
      const instance = this.virtualizerController.getVirtualizer();
      if (this.connected && instance.scrollElement !== this.scrollElement) {
        this.virtualizerController.hostUpdated();
        this.host.requestUpdate();
      }
    });
  }
  private readonly measureRowRefs = new Map<string, (element?: Element) => void>();
  private pruneDetachedRowsQueued = false;
  private pendingRowMeasureFrame: number | null = null;
  private measureConnectedRows(): void {
    // Only width invalidation owns forced DOM reads. Ordinary row refs stay on
    // TanStack's observer path so resizeItem cannot perturb scroll restoration.
    const instance = this.virtualizerController.getVirtualizer();
    for (const row of this.threadInnerElement?.querySelectorAll<HTMLElement>(".chat-virtual-row") ??
      []) {
      const index = instance.indexFromElement(row);
      const size = row[instance.options.horizontal ? "offsetWidth" : "offsetHeight"];
      instance.resizeItem(index, size);
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
          if (element.isConnected) {
            this.virtualizerController.getVirtualizer().measureElement(element);
          } else {
            // Lit invokes refs before the row is connected. Measuring a new
            // key there records offsetHeight=0, so a following row can share
            // its transform and paint over it until ResizeObserver catches up.
            queueMicrotask(() => {
              if (
                element.isConnected &&
                element.dataset.virtualRowKey === key &&
                this.rowIndexesByKey.has(key)
              ) {
                this.virtualizerController.getVirtualizer().measureElement(element);
              }
            });
          }
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
  private messageRowKeysById = new Map<string, string>();
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
    this.implicitEndAnchorPending = initialOffset === null;
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
          // A zero rect is a hide/teardown transition (pane cache display:none
          // or a face switch unmounting the transcript), not a real resize.
          // Reacting to it wipes every measured row height via measure() and
          // records garbage as the last width/height; keep the last real rect
          // so a remount with unchanged geometry restores rows instantly.
          if (rect.width === 0 || rect.height === 0) {
            return;
          }
          const previousHeight = this.observedHeight;
          const widthChanged = this.observedWidth !== null && this.observedWidth !== rect.width;
          const heightChanged = previousHeight !== null && previousHeight !== rect.height;
          const scrollOffset = instance.scrollOffset;
          const wasAtEndBeforeResize =
            heightChanged &&
            this.pendingScrollOffset === null &&
            scrollOffset !== null &&
            instance.getTotalSize() - previousHeight - scrollOffset <=
              CHAT_TRANSCRIPT_END_THRESHOLD_PX;
          this.observedWidth = rect.width;
          this.observedHeight = rect.height;
          this.syncScrollMargin(instance.scrollElement);
          callback(rect);
          if (wasAtEndBeforeResize) {
            instance.scrollToEnd({ behavior: "auto" });
          }
          if (widthChanged) {
            // Keep stale offscreen sizes as estimates — a full measure() wipe
            // has no scroll compensation and teleports the reader. resizeItem
            // re-seeds connected rows with fold-based compensation, so the
            // anchor row holds still; offscreen rows correct as they connect.
            this.measureConnectedRows();
            this.queueConnectedRowMeasure();
          }
        }),
      measureElement: measureVirtualElement,
      rangeExtractor: (range) =>
        extractTranscriptRange(range, this.rowIndexesByKey, this.focusedRowKey),
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
    this.reconcileImplicitEndAnchor();
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
    this.messageRowKeysById.clear();
    this.focusedRowKey = null;
    this.pendingScrollOffset = null;
  }

  render<T>(
    rows: readonly TranscriptRow<T>[],
    renderRow: (row: TranscriptRow<T>) => unknown,
    announcement: TranscriptAnnouncement | null,
    announce: boolean,
    overlay: unknown = nothing,
  ): TemplateResult {
    const nextKeys = rows.map((row) => row.key);
    const rowModelChanged =
      nextKeys.length !== this.rowKeys.length ||
      nextKeys.some((key, index) => key !== this.rowKeys[index]);
    const virtualizer = this.virtualizerController.getVirtualizer();
    const nextRowKeys = rowModelChanged
      ? nextKeys
      : virtualizer.getVirtualItems().flatMap(({ index }) => rows[index]?.key ?? []);
    return this.mcpAppUnmountGate.render(
      rowModelChanged ? nextKeys : JSON.stringify(nextRowKeys),
      () => {
        if (rowModelChanged) {
          this.syncRows(nextKeys);
        }
        this.syncAnnouncement(announcement, announce);
        const virtualRows = virtualizer.getVirtualItems();
        return html`
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
                        // Keep skipped overscan rows at the virtualizer's known size.
                        containIntrinsicBlockSize: `auto ${virtualRow.size}px`,
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
      },
      () => {
        const appRows = new Set(
          [
            ...(this.threadInnerElement?.querySelectorAll<HTMLElement>("mcp-app-view") ?? []),
          ].flatMap((app) => app.closest<HTMLElement>(".chat-virtual-row") ?? []),
        );
        if (appRows.size === 0) {
          return [];
        }
        const nextRenderedKeys = rowModelChanged
          ? previewTranscriptRowKeys(virtualizer, nextKeys, this.focusedRowKey)
          : new Set(nextRowKeys);
        return [...appRows].filter((row) => !nextRenderedKeys.has(row.dataset.virtualRowKey ?? ""));
      },
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

  syncMessageRows(messageRowKeysById: ReadonlyMap<string, string>): void {
    this.messageRowKeysById = new Map(messageRowKeysById);
  }

  revealMessage(messageId: string): boolean {
    const rowKey = this.messageRowKeysById.get(messageId);
    if (!rowKey) {
      return false;
    }
    const rowIndex = this.rowIndexesByKey.get(rowKey);
    if (rowIndex === undefined) {
      return false;
    }
    this.virtualizerController.getVirtualizer().scrollToIndex(rowIndex, { align: "center" });
    this.host.requestUpdate();
    void this.host.updateComplete.then(() => {
      const bubble = [
        ...(this.threadInnerElement?.querySelectorAll<HTMLElement>(".chat-bubble") ?? []),
      ].find((candidate) => candidate.dataset.entryId === messageId);
      if (!bubble) {
        return;
      }
      this.threadInnerElement
        ?.querySelector(".chat-bubble--reply-target")
        ?.classList.remove("chat-bubble--reply-target");
      bubble.scrollIntoView?.({ behavior: "smooth", block: "center" });
      bubble.classList.add("chat-bubble--reply-target");
      bubble.addEventListener(
        "animationend",
        () => bubble.classList.remove("chat-bubble--reply-target"),
        { once: true },
      );
    });
    return true;
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
    this.implicitEndAnchorPending = false;
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

  private syncAnnouncement(announcement: TranscriptAnnouncement | null, announce: boolean): void {
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

  private syncRows(nextKeys: string[]): void {
    const virtualizer = this.virtualizerController.getVirtualizer();
    const typingAdded =
      !this.rowIndexesByKey.has("presence:typing") && nextKeys.includes("presence:typing");
    const followTyping = typingAdded && virtualizer.isAtEnd();
    this.rowKeys = Object.freeze(nextKeys);
    const rowIndexesByKey = new Map(this.rowKeys.map((key, index) => [key, index]));
    this.rowIndexesByKey = rowIndexesByKey;
    for (const key of this.measureRowRefs.keys()) {
      if (!this.rowIndexesByKey.has(key)) {
        this.measureRowRefs.delete(key);
      }
    }
    const keys = this.rowKeys;
    virtualizer.setOptions({
      ...virtualizer.options,
      count: keys.length,
      getItemKey: (index) => keys[index] ?? `missing:${index}`,
      followOnAppend: false,
      rangeExtractor: (range) => extractTranscriptRange(range, rowIndexesByKey, this.focusedRowKey),
    });
    if (followTyping) {
      virtualizer.scrollToIndex(this.rowIndexesByKey.get("presence:typing") ?? keys.length - 1, {
        align: "end",
      });
    }
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

  private reconcileImplicitEndAnchor(): void {
    if (!this.implicitEndAnchorPending || !this.connected || !this.contentReady) {
      return;
    }
    const maxOffset = this.getMaxScrollOffset();
    const virtualizer = this.virtualizerController.getVirtualizer();
    const scrollOffset = virtualizer.scrollOffset;
    if (maxOffset === null || scrollOffset === null) {
      return;
    }
    if (scrollOffset >= 0 && scrollOffset <= maxOffset) {
      this.implicitEndAnchorPending = false;
      return;
    }
    if (maxOffset !== 0) {
      return;
    }
    this.implicitEndAnchorPending = false;
    // The DOM clamps an underfilled end anchor to zero without a scroll event,
    // so TanStack cannot reconcile its maximum-integer initial offset itself.
    virtualizer.scrollOffset = 0;
    virtualizer.scrollToOffset(0);
    this.host.requestUpdate();
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
  private connected = false;

  constructor(private readonly host: ReactiveControllerHost) {
    host.addController(this);
  }

  get renderedSessionKey(): string | null {
    return this.activeSessionKey;
  }

  renderSession(
    paneId: string,
    sessionKey: string,
    render: (transcript: ChatTranscriptSession) => TemplateResult,
  ): TemplateResult {
    if (
      !this.sessionVirtualizer ||
      this.activeSessionKey === null ||
      !areUiSessionKeysEquivalent(this.activeSessionKey, sessionKey)
    ) {
      this.sessionVirtualizer?.dispose();
      const savedPosition = getChatSessionScrollPosition(paneId, sessionKey);
      const initialOffset = savedPosition?.anchorToEnd ? null : (savedPosition?.scrollTop ?? null);
      this.activeSessionKey = sessionKey;
      this.sessionVirtualizer = new ChatSessionVirtualizerHost(
        this.host,
        initialOffset,
        initialOffset === null
          ? undefined
          : (position) => {
              saveChatSessionScrollPosition(paneId, sessionKey, position);
            },
      );
      if (this.connected) {
        this.sessionVirtualizer.connect();
      }
    }
    return render(this.sessionVirtualizer);
  }

  scrollToEnd(options: { behavior?: ScrollBehavior } = {}): void {
    this.sessionVirtualizer?.scrollToEnd(options);
  }

  scrollToOffset(offset: number, onSettled?: (position: ChatSessionScrollPosition) => void): void {
    this.sessionVirtualizer?.restoreScrollOffset(offset, onSettled);
  }

  revealMessage(messageId: string): boolean {
    return this.sessionVirtualizer?.revealMessage(messageId) ?? false;
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
    this.sessionVirtualizer?.disconnect();
  }
}
