import type { NativeBrowserTab } from "../../app/native-browser-bridge.ts";
import {
  resizeBrowserViewport,
  type BrowserPageMetrics,
  type BrowserRequestClient,
} from "./browser-client.ts";
import type { BrowserPanelOperationOwnership } from "./browser-panel-operation-ownership.ts";
import type { BrowserPanelPendingInput } from "./browser-panel-pending-input.ts";
import type { BrowserPanelStream } from "./browser-panel-stream.ts";
import type { BrowserPanelView } from "./browser-panel-surface.ts";

interface BrowserPanelViewportHost {
  readonly host: { browserPanelIsOpen(): boolean };
  readonly native: { readonly activeTab: NativeBrowserTab | undefined };
  readonly activeTargetId: string | null;
  readonly view: BrowserPanelView | null;
  readonly operations: Pick<BrowserPanelOperationOwnership, "captureClient">;
  readonly stream: Pick<BrowserPanelStream, "resize">;
  readonly pendingInput: Pick<BrowserPanelPendingInput, "scheduleViewportResize">;
  runAction(action: (client: BrowserRequestClient) => Promise<void>): Promise<boolean>;
}

const VIEWPORT_RESIZE_DELAY_MS = 300;
const MIN_VIEWPORT_DIMENSION = 100;
const MAX_VIEWPORT_DIMENSION = 8192;

/** Reconciles the visible screenshot stage with its remote page's CSS viewport. */
export class BrowserPanelViewportController {
  observedViewportSize: { width: number; height: number } | null = null;
  private lastRequestedViewport: { targetId: string; width: number; height: number } | null = null;

  constructor(private readonly controller: BrowserPanelViewportHost) {}

  invalidate(): void {
    // The agent may resize the same document between panel presentations.
    this.lastRequestedViewport = null;
  }

  captured(metrics: BrowserPageMetrics | null): void {
    if (
      metrics &&
      this.observedViewportSize &&
      (Math.abs(metrics.cssWidth - this.observedViewportSize.width) > 1 ||
        Math.abs(metrics.cssHeight - this.observedViewportSize.height) > 1)
    ) {
      this.schedule();
    }
  }

  resize(width: number, height: number): void {
    this.observedViewportSize = { width, height };
    this.schedule();
  }

  schedule(): void {
    if (this.controller.native.activeTab) {
      return;
    }
    this.controller.pendingInput.scheduleViewportResize(VIEWPORT_RESIZE_DELAY_MS, () =>
      this.syncViewport(),
    );
  }

  private syncViewport(): void {
    const targetId = this.controller.activeTargetId;
    const observed = this.observedViewportSize;
    // A debounced sync can outlive an ordinary dock close; a hidden panel must
    // never resize the agent-controlled browser.
    if (
      this.controller.native.activeTab ||
      !this.controller.host.browserPanelIsOpen() ||
      !this.controller.operations.captureClient()
    ) {
      return;
    }
    if (!targetId || !observed) {
      return;
    }
    this.controller.stream.resize();
    const width = Math.min(
      MAX_VIEWPORT_DIMENSION,
      Math.max(MIN_VIEWPORT_DIMENSION, Math.round(observed.width)),
    );
    const height = Math.min(
      MAX_VIEWPORT_DIMENSION,
      Math.max(MIN_VIEWPORT_DIMENSION, Math.round(observed.height)),
    );
    const currentView = this.controller.view?.targetId === targetId ? this.controller.view : null;
    // A failed or still-pending capture has not established the surface that
    // owns pointer coordinates. Wait for a successful view before syncing its
    // viewport, otherwise error-state layout changes can create a resize and
    // recapture loop.
    if (!currentView) {
      return;
    }
    const metrics = currentView.metrics;
    if (
      metrics &&
      Math.abs(metrics.cssWidth - width) <= 1 &&
      Math.abs(metrics.cssHeight - height) <= 1
    ) {
      return;
    }
    // A remote that cannot honor the exact size is not re-asked until the panel size or tab changes.
    if (
      this.lastRequestedViewport?.targetId === targetId &&
      this.lastRequestedViewport.width === width &&
      this.lastRequestedViewport.height === height
    ) {
      return;
    }
    this.lastRequestedViewport = { targetId, width, height };
    void this.controller.runAction((client) =>
      resizeBrowserViewport(client, { targetId, width, height }),
    );
  }
}
