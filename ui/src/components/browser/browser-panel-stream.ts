import type { BrowserPanelTab, BrowserRequestClient } from "./browser-client.ts";
import { isBrowserScreencastUnsupportedError, requestBrowserScreencast } from "./browser-client.ts";
import type {
  BrowserPanelControllerHost,
  BrowserPanelOperationOwnership,
} from "./browser-panel-operation-ownership.ts";
import { loadBrowserPanelImage, type BrowserPanelView } from "./browser-panel-surface.ts";
import {
  BrowserScreencastClient,
  type BrowserScreencastFrame,
  type BrowserScreencastMeta,
} from "./browser-screencast-client.ts";
import { browserRouteKey } from "./browser-target.ts";

const FIRST_FRAME_TIMEOUT_MS = 1500;
const RETRY_DELAY_MS = 10_000;
const RESIZE_RESTART_DEBOUNCE_MS = 500;

type StreamState = {
  activeTargetId: string | null;
  view: BrowserPanelView | null;
  tabs: BrowserPanelTab[];
  urlDraft: string;
  loading: boolean;
};

interface BrowserPanelStreamHost extends StreamState {
  readonly host: BrowserPanelControllerHost;
  readonly mode: "interact" | "annotate" | "inspect";
  readonly operations: Pick<
    BrowserPanelOperationOwnership,
    "epoch" | "route" | "isLive" | "hasPendingCapture" | "capturedTabs" | "markNavigationReconciled"
  >;
  readonly urlDraftEditing: boolean;
  readonly observedViewportSize: { width: number; height: number } | null;
  setState<Key extends keyof StreamState>(key: Key, value: StreamState[Key]): void;
  clearUnavailableView(): boolean;
  scheduleViewportSync(): void;
  refreshView(targetId: string): Promise<void>;
  refreshAll(): Promise<void>;
}

type Recovery = Pick<Attempt, "targetId" | "epoch" | "client">;

type Attempt = {
  targetId: string;
  epoch: number;
  client: BrowserRequestClient;
  width: number;
  live: boolean;
  connection?: BrowserScreencastClient;
  firstFrame: Promise<boolean>;
  settle: (received: boolean) => void;
  metadata?: BrowserScreencastMeta;
  pendingFrame?: BrowserScreencastFrame;
  decoding: boolean;
  presented: boolean;
};

/** Owns stream attachment and the object URLs of the active browser surface. */
export class BrowserPanelStream {
  private attempt?: Attempt;
  frameRevision = 0;
  private scope?: { client: BrowserPanelControllerHost["client"]; route: string };
  private unsupported = false;
  private readonly lastFailures = new Map<string, number>();
  private objectUrl?: string;
  private decodingUrl?: string;
  private resizeTimer?: ReturnType<typeof setTimeout>;
  private recoveryTimer?: ReturnType<typeof setTimeout>;
  private recovery?: Recovery;
  private viewportSyncPending = false;
  private readonly retiringUrls = new Set<string>();

  constructor(private readonly host: BrowserPanelStreamHost) {}

  ownsView(targetId: string | null): boolean {
    return Boolean(
      this.attempt?.live && this.attempt.targetId === targetId && this.current(this.attempt),
    );
  }

  private current(attempt: Attempt): boolean {
    return (
      this.attempt === attempt &&
      this.host.activeTargetId === attempt.targetId &&
      this.host.operations.isLive(attempt.epoch, attempt.client)
    );
  }

  private dimensions() {
    const stage = this.host.host.renderRoot.querySelector<HTMLElement>(".bp-stage");
    const viewport = this.host.host.renderRoot.querySelector<HTMLElement>(".bp-viewport");
    const width =
      stage?.clientWidth || viewport?.clientWidth || this.host.observedViewportSize?.width || 1280;
    const height = viewport?.clientHeight || this.host.observedViewportSize?.height || width;
    const ratio = globalThis.devicePixelRatio || 1;
    return {
      width,
      maxWidth: Math.min(2000, Math.ceil(width * ratio)),
      maxHeight: Math.min(2000, Math.ceil(Math.max(width, height) * ratio)),
    };
  }

  async ensure(targetId: string, client: BrowserRequestClient, epoch: number): Promise<boolean> {
    const route = browserRouteKey(this.host.operations.route);
    if (!this.scope || this.scope.client !== this.host.host.client || this.scope.route !== route) {
      this.close();
      this.scope = { client: this.host.host.client, route };
      this.unsupported = false;
    }
    if (this.attempt && this.current(this.attempt) && this.attempt.targetId === targetId) {
      return this.attempt.live || (await this.attempt.firstFrame);
    }
    // Only failed attempts back off; navigation and resize close streams on purpose and restart at once.
    if (
      this.unsupported ||
      Date.now() - (this.lastFailures.get(targetId) ?? -Infinity) < RETRY_DELAY_MS
    ) {
      return false;
    }
    this.close(false);
    const dimensions = this.dimensions();
    let settle!: Attempt["settle"];
    const firstFrame = new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => resolve(false), FIRST_FRAME_TIMEOUT_MS);
      settle = (received) => {
        clearTimeout(timeout);
        resolve(received);
      };
    });
    const attempt: Attempt = {
      targetId,
      client,
      epoch,
      width: dimensions.width,
      live: false,
      firstFrame,
      settle,
      decoding: false,
      presented: false,
    };
    this.attempt = attempt;
    void this.connect(attempt, { maxWidth: dimensions.maxWidth, maxHeight: dimensions.maxHeight });
    return await firstFrame;
  }

  private async connect(
    attempt: Attempt,
    dimensions: { maxWidth: number; maxHeight: number },
  ): Promise<void> {
    try {
      const response = await requestBrowserScreencast(attempt.client, {
        targetId: attempt.targetId,
        ...dimensions,
      });
      if (!this.current(attempt)) {
        return;
      }
      attempt.connection = new BrowserScreencastClient({
        gatewayUrl: this.host.host.client!.gatewayUrl,
        wsPath: response.wsPath,
        onReady: ({ url, title }) => this.updateMetadata(attempt, { url, title }),
        onMeta: (meta) => this.updateMetadata(attempt, meta),
        onFrame: (frame) => {
          if (!this.current(attempt)) {
            return;
          }
          // A received frame owns the view even while its image is decoding.
          this.frameRevision += 1;
          attempt.live = true;
          attempt.pendingFrame = frame;
          if (!attempt.decoding) {
            void this.decodeFrames(attempt);
          }
        },
        onClose: ({ code }) => {
          if (!this.current(attempt)) {
            return;
          }
          if (code !== 4003 && code !== 4004) {
            this.recover(attempt);
            return;
          }
          this.close();
          if (code === 4003) {
            this.host.setState(
              "tabs",
              this.host.tabs.map((tab) =>
                tab.id === attempt.targetId
                  ? { ...tab, url: "", urlUnavailableReason: "navigation_blocked" }
                  : tab,
              ),
            );
            this.host.clearUnavailableView();
          } else if (code === 4004) {
            void this.host.refreshAll();
          }
        },
      });
    } catch (error) {
      if (this.current(attempt)) {
        this.unsupported = isBrowserScreencastUnsupportedError(error);
        if (this.unsupported) {
          this.close(false);
        } else {
          this.recover(attempt);
        }
      }
    }
  }

  private recover(attempt: Attempt): void {
    this.lastFailures.set(attempt.targetId, Date.now());
    this.close(false);
    this.recovery = { targetId: attempt.targetId, epoch: attempt.epoch, client: attempt.client };
    // A received frame invalidates older screenshots even if decoding has not finished.
    this.scheduleRecovery(attempt.live ? 0 : RETRY_DELAY_MS);
  }

  private scheduleRecovery(delay: number): void {
    const recovery = this.recovery;
    if (!recovery) {
      return;
    }
    clearTimeout(this.recoveryTimer);
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = undefined;
      if (
        this.host.activeTargetId !== recovery.targetId ||
        !this.host.operations.isLive(recovery.epoch, recovery.client)
      ) {
        this.recovery = undefined;
        return;
      }
      // Capture modes pin their image; flushPendingFrame resumes recovery on exit.
      if (this.host.mode !== "interact") {
        return;
      }
      // A stalled screenshot must not hold the reconnect deadline.
      this.scheduleRecovery(RETRY_DELAY_MS);
      void this.resume(recovery);
    }, delay);
  }

  private async resume(recovery: Recovery): Promise<void> {
    if (await this.ensure(recovery.targetId, recovery.client, recovery.epoch)) {
      return;
    }
    // A failed reconnect must not discard a fallback screenshot that is still in flight.
    if (
      this.host.activeTargetId === recovery.targetId &&
      this.host.operations.isLive(recovery.epoch, recovery.client) &&
      !this.host.operations.hasPendingCapture
    ) {
      void this.host.refreshView(recovery.targetId);
    }
  }

  private updateMetadata(attempt: Attempt, metadata: BrowserScreencastMeta): void {
    if (!this.current(attempt)) {
      return;
    }
    attempt.metadata = metadata;
    this.host.setState(
      "tabs",
      this.host.tabs.map((tab) =>
        tab.id === attempt.targetId
          ? { ...tab, ...metadata, urlUnavailableReason: undefined }
          : tab,
      ),
    );
    if (!this.host.urlDraftEditing) {
      this.host.setState("urlDraft", metadata.url);
    }
  }

  flushPendingFrame(): void {
    this.scheduleRecovery(0);
    const attempt = this.attempt;
    if (attempt && this.current(attempt) && !attempt.decoding) {
      void this.decodeFrames(attempt);
    }
    this.restartAfterResize();
  }

  private async decodeFrames(attempt: Attempt): Promise<void> {
    attempt.decoding = true;
    try {
      while (this.current(attempt) && attempt.pendingFrame) {
        const mode = this.host.mode;
        if (mode !== "interact") {
          return;
        }
        const frame = attempt.pendingFrame;
        const metadata = attempt.metadata;
        attempt.pendingFrame = undefined;
        const objectUrl = URL.createObjectURL(frame.blob);
        this.decodingUrl = objectUrl;
        const image = await loadBrowserPanelImage(objectUrl);
        if (!this.current(attempt)) {
          return;
        }
        // Capture mode can begin while an image is decoding; keep the newest frame for exit.
        if (this.host.mode !== "interact") {
          attempt.pendingFrame ??= frame;
          URL.revokeObjectURL(objectUrl);
          this.decodingUrl = undefined;
          return;
        }
        if (metadata !== attempt.metadata && attempt.metadata?.url !== frame.url) {
          URL.revokeObjectURL(objectUrl);
          this.decodingUrl = undefined;
          continue;
        }
        const previousUrl = this.objectUrl;
        this.decodingUrl = undefined;
        this.objectUrl = objectUrl;
        const title =
          attempt.metadata?.url === frame.url
            ? attempt.metadata.title
            : (this.host.tabs.find((tab) => tab.id === attempt.targetId)?.title ?? "");
        const metrics = {
          cssWidth: frame.cssWidth,
          cssHeight: frame.cssHeight,
          title,
          url: frame.url,
        };
        this.host.setState(
          "tabs",
          this.host.operations.capturedTabs(this.host.tabs, attempt.targetId, metrics, frame.url),
        );
        this.host.setState("view", {
          targetId: attempt.targetId,
          dataUrl: objectUrl,
          image,
          url: frame.url,
          metrics,
          ...(this.host.operations.route
            ? { browserTab: { ...this.host.operations.route, targetId: attempt.targetId } }
            : {}),
        });
        this.host.operations.markNavigationReconciled(attempt.client, attempt.targetId);
        if (!this.host.urlDraftEditing) {
          this.host.setState("urlDraft", frame.url);
        }
        if (
          this.host.observedViewportSize &&
          (Math.abs(frame.cssWidth - this.host.observedViewportSize.width) > 1 ||
            Math.abs(frame.cssHeight - this.host.observedViewportSize.height) > 1) &&
          !this.viewportSyncPending
        ) {
          // The sync is debounced; a repainting page must not keep postponing it.
          this.viewportSyncPending = true;
          this.host.scheduleViewportSync();
        }
        if (!attempt.presented) {
          attempt.presented = true;
          this.host.setState("loading", false);
        }
        attempt.settle(true);
        await this.retireAfterUpdate(previousUrl);
      }
    } catch {
      if (this.current(attempt)) {
        this.recover(attempt);
      }
    } finally {
      attempt.decoding = false;
    }
  }

  resize(): void {
    // The debounced viewport sync just ran; later mismatched frames may schedule again.
    this.viewportSyncPending = false;
    this.restartAfterResize();
  }

  private resized(attempt: Attempt): boolean {
    return Math.abs(this.dimensions().width - attempt.width) / attempt.width > 0.3;
  }

  private restartAfterResize(): void {
    const attempt = this.attempt;
    if (!attempt || !this.current(attempt) || !this.resized(attempt)) {
      return;
    }
    // Coalesce a burst of layout changes into one restart.
    this.resizeTimer ??= setTimeout(() => {
      this.resizeTimer = undefined;
      if (this.attempt !== attempt || !this.current(attempt) || !this.resized(attempt)) {
        return;
      }
      // Capture modes pin their image; flushPendingFrame restarts the stream on exit.
      if (this.host.mode !== "interact") {
        return;
      }
      this.close(false);
      void this.host.refreshView(attempt.targetId);
    }, RESIZE_RESTART_DEBOUNCE_MS);
  }

  releaseReplacedView(): void {
    const previousUrl = this.objectUrl;
    this.objectUrl = undefined;
    void this.retireAfterUpdate(previousUrl);
  }

  private async retireAfterUpdate(url?: string): Promise<void> {
    if (url) {
      this.retiringUrls.add(url);
    }
    // The previous image must survive until Lit has committed its replacement.
    await this.host.host.updateComplete;
    if (url && this.retiringUrls.delete(url)) {
      URL.revokeObjectURL(url);
    }
  }

  close(releaseView = true): void {
    if (releaseView) {
      // Intentional teardown starts a new owner; it must not inherit an orphaned backoff.
      this.lastFailures.clear();
    }
    clearTimeout(this.recoveryTimer);
    this.recoveryTimer = undefined;
    this.recovery = undefined;
    clearTimeout(this.resizeTimer);
    this.resizeTimer = undefined;
    // Invalidation cancels the pending sync timer; the next stream must be able to schedule one.
    this.viewportSyncPending = false;
    const attempt = this.attempt;
    this.attempt = undefined;
    attempt?.settle(false);
    attempt?.connection?.close();
    for (const url of [
      releaseView ? this.objectUrl : undefined,
      this.decodingUrl,
      ...(releaseView ? this.retiringUrls : []),
    ]) {
      if (url) {
        URL.revokeObjectURL(url);
      }
    }
    if (releaseView) {
      this.objectUrl = undefined;
      this.retiringUrls.clear();
    }
    this.decodingUrl = undefined;
  }
}
