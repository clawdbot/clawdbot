// Per-session virtualizer host: scroll anchoring, measurement, and row sync
// for one transcript. Owned and swapped by ChatTranscriptController.
import { VirtualizerController } from "@tanstack/lit-virtual";
import {
  measureElement as measureVirtualElement,
  observeElementOffset,
  observeElementRect,
} from "@tanstack/virtual-core";
import {
  nothing,
  type ReactiveController,
  type ReactiveControllerHost,
  type TemplateResult,
} from "lit";
import { McpAppUnmountGate } from "../../../components/mcp-app-unmount.ts";
import { resolveScrollBehavior } from "../../../lib/scroll-behavior.ts";
import {
  CHAT_TRANSCRIPT_END_THRESHOLD_PX,
  type ChatSessionScrollPosition,
  type ChatScrollToEndOptions,
} from "../scroll.ts";
import { SIDEBAR_GEOMETRY_COMMIT_EVENT } from "../sidebar-layout.ts";
import {
  TranscriptAnnouncementState,
  type TranscriptAnnouncement,
} from "./chat-transcript-announcement.ts";
import {
  initialTranscriptRect,
  maxTranscriptScrollOffset,
  measureConnectedTranscriptRows,
  resolveTranscriptScrollMargin,
  syncScrollMargin,
} from "./chat-transcript-geometry.ts";
import {
  type ChatTranscriptInteractionAnchor,
  reconcileChatTranscriptInteractionResize,
  resolveChatTranscriptInteractionAnchor,
} from "./chat-transcript-interaction-anchor.ts";
import { renderChatTranscriptLayout, type TranscriptRow } from "./chat-transcript-layout.ts";
import {
  extractTranscriptRange,
  previewTranscriptRowKeys,
  focusedTranscriptRowKey,
} from "./chat-transcript-range.ts";
import {
  CHAT_TRANSCRIPT_ESTIMATED_ROW_PX,
  CHAT_TRANSCRIPT_OVERSCAN,
  CHAT_TRANSCRIPT_SCROLL_RESTORE_STABLE_FRAMES,
  CHAT_TRANSCRIPT_ZERO_MAX_SETTLE_FRAMES,
  type ChatTranscriptSession,
  type TranscriptCallbacks,
  type TranscriptHeader,
} from "./chat-transcript-session.ts";

export class ChatSessionVirtualizerHost implements ReactiveControllerHost, ChatTranscriptSession {
  private readonly controllers = new Set<ReactiveController>();
  private readonly virtualizerController: VirtualizerController<HTMLDivElement, HTMLElement>;
  private threadInnerElement: HTMLDivElement | null = null;
  private connected = false;
  private observedWidth: number | null = null;
  private observedHeight: number | null = null;
  private contentReady = false;
  // The in-flow history header's fixed height, folded into scrollMargin.
  // appliedHeaderHeight is what the current virtualizer margin already carries.
  private headerHeight = 0;
  private appliedHeaderHeight = 0;
  private implicitEndAnchorPending: boolean;
  private pendingScrollOffset: {
    offset: number;
    stableFrames: number;
    zeroMaxFrames: number;
    onSettled?: (position: ChatSessionScrollPosition) => void;
  } | null = null;
  private pendingScrollFrame: number | null = null;
  private scrollCommand: { behavior: ScrollBehavior; target: "end" | "index" } | null = null;
  // Lit calls refs before newly rendered nodes are connected. Resolve the
  // scroll parent lazily or a stable ref can permanently capture null.
  get scrollElement(): HTMLDivElement | null {
    const parent = this.threadInnerElement?.parentElement;
    return this.connected && parent instanceof HTMLDivElement && parent.isConnected ? parent : null;
  }
  // Stable Lit refs: inline arrows change identity per render, making Lit
  // re-invoke them for every visible row and re-measure each row every render.
  // Lit tracks the last element per callback, so each row needs its own.
  readonly scrollElementRef = (element?: Element) => {
    const next = element instanceof HTMLDivElement ? element : null;
    if (next === this.threadInnerElement) {
      return;
    }
    this.threadInnerElement = next;
    this.queueScrollElementAttach();
  };
  // Sidebar hosts commit after the pane's update. Attach from the stable DOM
  // ref so a foreign-host re-stamp cannot leave the virtualizer detached.
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
  private pendingInteractionAnchor: ChatTranscriptInteractionAnchor | null = null;
  private readonly captureInteractionResize = (event: Event) => {
    const anchor = resolveChatTranscriptInteractionAnchor(event);
    if (!anchor) {
      return;
    }
    this.pendingInteractionAnchor = anchor;
    queueMicrotask(() => this.pendingInteractionAnchor === anchor && this.host.requestUpdate());
  };
  private measureConnectedRows(): void {
    measureConnectedTranscriptRows(this.scrollElement, this.virtualizerController.getVirtualizer());
  }
  private readonly handleGeometryCommit = (event: Event) => {
    this.reconcileInteractionResize(event.target);
    if (event instanceof CustomEvent && event.detail?.widthChanged === false) {
      return;
    }
    const rect = this.scrollElement?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) {
      return;
    }
    // The viewport observer must not repeat this committed width's row scan.
    this.observedWidth = Math.round(rect.width);
    this.measureConnectedRows();
  };
  private queueConnectedRowMeasure(): void {
    if (this.pendingRowMeasureFrame !== null) {
      return;
    }
    const element = this.scrollElement;
    this.pendingRowMeasureFrame = requestAnimationFrame(() => {
      this.pendingRowMeasureFrame = null;
      if (element === this.scrollElement) {
        this.measureConnectedRows();
      }
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
            // key there records offsetHeight=0 and corrupts the virtual range
            // until ResizeObserver catches up.
            queueMicrotask(() => {
              if (
                element.isConnected &&
                this.threadInnerElement?.contains(element) &&
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
  private readonly announcement = new TranscriptAnnouncementState();
  private readonly mcpAppUnmountGate = new McpAppUnmountGate(this);

  constructor(
    private readonly host: ReactiveControllerHost,
    initialOffset: number | null = null,
    onInitialOffsetSettled?: (position: ChatSessionScrollPosition) => void,
    private readonly callbacks: TranscriptCallbacks = {},
  ) {
    this.implicitEndAnchorPending = initialOffset === null;
    this.virtualizerController = new VirtualizerController(this, {
      count: 0,
      getScrollElement: () => this.scrollElement,
      estimateSize: () => CHAT_TRANSCRIPT_ESTIMATED_ROW_PX,
      getItemKey: () => "",
      initialRect: initialTranscriptRect(host),
      initialOffset: initialOffset ?? Number.MAX_SAFE_INTEGER,
      anchorTo: "end",
      followOnAppend: false,
      observeElementRect: (instance, callback) =>
        observeElementRect(instance, (rect) => {
          // Hidden tabs and detached faces are not viewport resizes. Keep the
          // last measurable geometry until this session's scroller returns.
          if (instance.scrollElement !== this.scrollElement || !rect.width || !rect.height) {
            return;
          }
          const previousHeight = this.observedHeight;
          const widthChanged = this.observedWidth !== null && this.observedWidth !== rect.width;
          const heightChanged = previousHeight !== null && previousHeight !== rect.height;
          this.observedWidth = rect.width;
          this.observedHeight = rect.height;
          // appliedHeaderHeight, not headerHeight: only the render paths fold a
          // header toggle into the margin, because they own its compensation.
          syncScrollMargin(instance.scrollElement, instance, this.appliedHeaderHeight);
          callback(rect);
          if (widthChanged) {
            // Keep stale offscreen sizes as estimates — a full measure() wipe
            // has no scroll compensation and teleports the reader. resizeItem
            // re-seeds connected rows with fold-based compensation, so the
            // anchor row holds still; offscreen rows correct as they connect.
            this.measureConnectedRows();
            this.queueConnectedRowMeasure();
          }
          if (widthChanged || heightChanged) {
            this.callbacks.onViewportResize?.();
          }
        }),
      observeElementOffset: (instance, callback) => {
        const element = this.scrollElement;
        const interrupt = (event: Event) => {
          if (element !== this.scrollElement || instance.scrollElement !== element) {
            return;
          }
          if (
            event instanceof KeyboardEvent &&
            !["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)
          ) {
            return;
          }
          if (event instanceof PointerEvent && event.target !== element) {
            return;
          }
          this.pendingInteractionAnchor = null;
          this.cancelScroll();
          this.callbacks.onReaderScroll?.();
        };
        for (const type of ["wheel", "touchstart", "keydown", "pointerdown"]) {
          element?.addEventListener(type, interrupt, { passive: true });
        }
        const cleanup = observeElementOffset(instance, (offset, scrolling) => {
          if (element !== this.scrollElement) {
            return;
          }
          callback(offset, scrolling);
          // Idle can arrive between smooth retargets. Completion needs the
          // restore path's 1px precision, not the 8px UI-follow boundary.
          // The input listeners above own reader takeover.
          const settledAtEnd =
            !scrolling &&
            Math.abs((maxTranscriptScrollOffset(element) ?? 0) - (element?.scrollTop ?? 0)) <= 1;
          // End-idle cannot retire a message reveal still waiting for its DOM commit.
          if (settledAtEnd && this.scrollCommand?.target === "end") {
            if (this.scrollCommand.behavior === "smooth") {
              this.cancelScroll();
            } else {
              this.scrollCommand = null;
            }
          }
        });
        return () => {
          cleanup?.();
          for (const type of ["wheel", "touchstart", "keydown", "pointerdown"]) {
            element?.removeEventListener(type, interrupt);
          }
        };
      },
      measureElement: measureVirtualElement,
      rangeExtractor: (range) =>
        extractTranscriptRange(range, this.rowIndexesByKey, this.focusedRowKey),
      // Virtual distance omits real padding, pinning readers ~80px up past scroll.ts's follow-lock.
      // scheduleCommittedChatScroll owns end-follow on content changes and source: "resize".
      // Disable isAtEnd()'s default too; callers must supply an explicit threshold.
      scrollEndThreshold: -1,
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
    return this.announcement.text;
  }

  requestUpdate = () => this.host.requestUpdate();

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
    if (this.host instanceof HTMLElement) {
      this.host.addEventListener(SIDEBAR_GEOMETRY_COMMIT_EVENT, this.handleGeometryCommit);
    }
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
    this.reconcileInteractionResize();
    this.reconcileImplicitEndAnchor();
    this.applyPendingScrollOffset();
  }

  disconnect(): void {
    this.scrollCommand = null;
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
    if (this.host instanceof HTMLElement) {
      this.host.removeEventListener(SIDEBAR_GEOMETRY_COMMIT_EVENT, this.handleGeometryCommit);
    }
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
    header: TranscriptHeader | null = null,
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
        this.headerHeight = header?.height ?? 0;
        if (rowModelChanged) {
          this.syncRows(nextKeys);
        } else {
          this.syncHeaderMargin();
        }
        this.announcement.sync(announcement, announce);
        return renderChatTranscriptLayout({
          rows,
          renderRow,
          virtualizer,
          overlay,
          header: header?.template ?? nothing,
          scrollElementRef: this.scrollElementRef,
          captureInteractionResize: this.captureInteractionResize,
          measureRowRefFor: (key) => this.measureRowRefFor(key),
        });
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
      // SAFETY: the gate returns renderValue's output, always the renderChatTranscriptLayout TemplateResult here.
    ) as TemplateResult;
  }

  get isProgrammaticScroll(): boolean {
    const element = this.scrollElement;
    // Lit's scroll listener can precede TanStack's offset observer. Read the
    // committed viewport so the final event publishes the settled end policy.
    const distanceFromEnd = (maxTranscriptScrollOffset(element) ?? 0) - (element?.scrollTop ?? 0);
    return (
      this.pendingScrollOffset !== null ||
      (this.scrollCommand !== null && distanceFromEnd > CHAT_TRANSCRIPT_END_THRESHOLD_PX)
    );
  }

  scrollToEnd({ source = "manual", behavior = "auto" }: ChatScrollToEndOptions = {}): boolean {
    // Hydration/resize follow cannot replace a saved reader. A new latest
    // command intentionally supersedes restoration.
    if (source === "auto" && this.pendingScrollOffset) {
      return false;
    }
    this.cancelScroll();
    this.scrollCommand = { behavior, target: "end" };
    this.virtualizerController.getVirtualizer().scrollToEnd({ behavior });
    return true;
  }

  private cancelScroll(): void {
    if (this.scrollCommand === null && !this.pendingScrollOffset) {
      return;
    }
    // Only smooth commands skip row measurements. Replaying ordinary auto
    // scrolling's overscan sizes can move an already settled end anchor.
    if (this.scrollCommand?.behavior === "smooth") {
      this.queueConnectedRowMeasure();
    }
    this.scrollCommand = null;
    this.pendingScrollOffset = null;
    if (this.pendingScrollFrame !== null) {
      cancelAnimationFrame(this.pendingScrollFrame);
      this.pendingScrollFrame = null;
    }
    const element = this.scrollElement;
    if (element) {
      // Cancellation is one instant target replacement, never the multi-frame
      // restoration API. Reconcile committed rows after core's offset listener.
      this.virtualizerController
        .getVirtualizer()
        .scrollToOffset(element.scrollTop, { behavior: "instant" });
    }
  }

  syncMessageRows(messageRowKeysById: ReadonlyMap<string, string>): void {
    this.messageRowKeysById = new Map(messageRowKeysById);
  }

  revealMessage(messageId: string): boolean {
    const rowKey = this.messageRowKeysById.get(messageId);
    const rowIndex = rowKey ? this.rowIndexesByKey.get(rowKey) : undefined;
    if (rowIndex === undefined) {
      return false;
    }
    this.cancelScroll();
    const command = (this.scrollCommand = { behavior: resolveScrollBehavior(), target: "index" });
    this.virtualizerController.getVirtualizer().scrollToIndex(rowIndex, { align: "center" });
    this.host.requestUpdate();
    void this.host.updateComplete.then(() => {
      if (this.scrollCommand !== command) {
        return;
      }
      const bubble = [
        ...(this.threadInnerElement?.querySelectorAll<HTMLElement>(".chat-bubble") ?? []),
      ].find((candidate) => candidate.dataset.entryId === messageId);
      if (!bubble) {
        return;
      }
      this.threadInnerElement
        ?.querySelector(".chat-bubble--reply-target")
        ?.classList.remove("chat-bubble--reply-target");
      bubble.scrollIntoView?.({ behavior: command.behavior, block: "center" });
      bubble.classList.add("chat-bubble--reply-target");
      bubble.addEventListener(
        "animationend",
        () => bubble.classList.remove("chat-bubble--reply-target"),
        { once: true },
      );
    });
    return true;
  }

  setContentReady(ready: boolean): void {
    this.contentReady = ready;
  }

  restoreScrollOffset(
    offset: number,
    onSettled?: (position: ChatSessionScrollPosition) => void,
  ): void {
    this.cancelScroll();
    this.implicitEndAnchorPending = false;
    this.pendingScrollOffset = { offset, stableFrames: 0, zeroMaxFrames: 0, onSettled };
    if (this.connected) {
      this.host.requestUpdate();
    }
  }

  handleFocusIn(event: FocusEvent): void {
    this.focusedRowKey = focusedTranscriptRowKey(this.scrollElement, event.target);
  }

  handleFocusOut(event: FocusEvent): void {
    this.focusedRowKey = focusedTranscriptRowKey(this.scrollElement, event.relatedTarget);
  }

  private reconcileInteractionResize(sidebarCommitTarget?: EventTarget | null): void {
    const virtualizer = this.virtualizerController.getVirtualizer();
    if (
      reconcileChatTranscriptInteractionResize(
        this.pendingInteractionAnchor,
        sidebarCommitTarget,
        this.scrollElement,
        virtualizer,
      )
    ) {
      this.pendingInteractionAnchor = null;
    }
  }

  private syncRows(nextKeys: string[]): void {
    const virtualizer = this.virtualizerController.getVirtualizer();
    const typingAdded =
      !this.rowIndexesByKey.has("presence:typing") && nextKeys.includes("presence:typing");
    const followTyping =
      typingAdded &&
      !this.pendingScrollOffset &&
      virtualizer.isAtEnd(CHAT_TRANSCRIPT_END_THRESHOLD_PX);
    this.rowKeys = Object.freeze(nextKeys);
    const rowIndexesByKey = new Map(this.rowKeys.map((key, index) => [key, index]));
    this.rowIndexesByKey = rowIndexesByKey;
    for (const key of this.measureRowRefs.keys()) {
      if (!this.rowIndexesByKey.has(key)) {
        this.measureRowRefs.delete(key);
      }
    }
    // The header margin must land in the same setOptions as the key change:
    // the edge-key re-anchor uses absolute offsets, so a prepend that also
    // removes the header (exhausted history) compensates in one adjustment.
    this.appliedHeaderHeight = this.headerHeight;
    virtualizer.setOptions({
      ...virtualizer.options,
      count: nextKeys.length,
      getItemKey: (index) => nextKeys[index] ?? `missing:${index}`,
      followOnAppend: false,
      rangeExtractor: (range) => extractTranscriptRange(range, rowIndexesByKey, this.focusedRowKey),
      scrollMargin: resolveTranscriptScrollMargin(this.scrollElement, this.headerHeight),
    });
    if (followTyping) {
      this.cancelScroll();
      this.scrollCommand = { behavior: "auto", target: "index" };
      virtualizer.scrollToIndex(nextKeys.indexOf("presence:typing"), { align: "end" });
    }
  }

  // Header toggled around an unchanged row model (exhaustion usually commits
  // one render after its final prepend). No edge keys change, so no re-anchor
  // runs; shift the offset by the header delta or every visible row jumps by
  // the boundary height.
  private syncHeaderMargin(): void {
    if (this.headerHeight === this.appliedHeaderHeight) {
      return;
    }
    const delta = this.headerHeight - this.appliedHeaderHeight;
    this.appliedHeaderHeight = this.headerHeight;
    const virtualizer = this.virtualizerController.getVirtualizer();
    virtualizer.setOptions({
      ...virtualizer.options,
      scrollMargin: resolveTranscriptScrollMargin(this.scrollElement, this.headerHeight),
    });
    const offset = virtualizer.scrollOffset;
    const next = offset === null ? null : Math.max(0, offset + delta);
    if (next !== null && next !== offset) {
      virtualizer.scrollOffset = next;
      virtualizer.scrollToOffset(next);
    }
  }

  private reconcileImplicitEndAnchor(): void {
    if (!this.implicitEndAnchorPending || !this.connected || !this.contentReady) {
      return;
    }
    const maxOffset = maxTranscriptScrollOffset(this.scrollElement);
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
    if (this.contentReady && this.rowKeys.length === 0) {
      this.settlePendingScroll(0);
      return;
    }
    const maxOffset = maxTranscriptScrollOffset(this.scrollElement);
    if (maxOffset === null) {
      return;
    }
    if (maxOffset === 0 && pending.offset > 0) {
      if (this.contentReady) {
        if (++pending.zeroMaxFrames > CHAT_TRANSCRIPT_ZERO_MAX_SETTLE_FRAMES) {
          this.settlePendingScroll(0);
        } else {
          this.schedulePendingScrollRetry();
        }
      }
      return;
    }
    pending.zeroMaxFrames = 0;
    const targetOffset = Math.min(pending.offset, maxOffset);
    if (this.scrollElement) {
      this.scrollElement.scrollTop = targetOffset;
    }
    this.virtualizerController.getVirtualizer().scrollToOffset(targetOffset);
    const currentOffset = this.scrollElement?.scrollTop;
    const atTarget = currentOffset != null && Math.abs(currentOffset - targetOffset) <= 1;
    pending.stableFrames = atTarget ? pending.stableFrames + 1 : 0;
    if (
      currentOffset != null &&
      pending.stableFrames > CHAT_TRANSCRIPT_SCROLL_RESTORE_STABLE_FRAMES
    ) {
      this.settlePendingScroll(currentOffset);
    } else {
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
    const maxScrollTop = maxTranscriptScrollOffset(this.scrollElement);
    pending.onSettled?.({
      scrollTop,
      anchorToEnd:
        maxScrollTop === null
          ? this.contentReady && this.rowKeys.length === 0
          : maxScrollTop - scrollTop <= CHAT_TRANSCRIPT_END_THRESHOLD_PX,
    });
    // Publish the restored reader before queued hydration/resize follow runs.
    this.callbacks.onReaderScroll?.();
  }
}
