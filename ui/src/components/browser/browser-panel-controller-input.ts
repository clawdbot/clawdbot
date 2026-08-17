import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { t } from "../../i18n/index.ts";
import type { AnnotationStroke } from "./browser-annotation.ts";
import type { BrowserInspectedNode, BrowserPanelTab } from "./browser-client.ts";
import {
  clickBrowserCoords,
  inspectBrowserElementAt,
  isBrowserEvaluateDisabledError,
  pressBrowserKey,
  scrollBrowserBy,
} from "./browser-client.ts";
import type { BrowserPanelOperationOwnership } from "./browser-panel-operation-ownership.ts";
import type { BrowserPanelPendingInput } from "./browser-panel-pending-input.ts";
import {
  browserPanelInspectHighlightRegion,
  browserPanelNormalizedPoint,
  browserPanelRemotePoint,
  browserPanelShouldForwardKey,
  dispatchCompositedBrowserAnnotation,
  paintBrowserPanelOverlay,
  type BrowserPanelView,
} from "./browser-panel-surface.ts";

const INSPECT_THROTTLE_MS = 120;

type BrowserPanelInputState = {
  mode: "interact" | "annotate" | "inspect";
  strokes: AnnotationStroke[];
  view: BrowserPanelView | null;
  tabs: BrowserPanelTab[];
  activeTargetId: string | null;
  inspected: BrowserInspectedNode | null;
  inspectPointer: { x: number; y: number } | null;
  evaluateUnavailable: boolean;
  errorText: string | null;
  noticeText: string | null;
};

interface BrowserPanelInputHost extends BrowserPanelInputState {
  readonly host: {
    readonly renderRoot: HTMLElement | DocumentFragment;
    readonly updateComplete: Promise<boolean>;
  };
  readonly operations: Pick<
    BrowserPanelOperationOwnership,
    "beginInspection" | "captureClient" | "epoch" | "isLive"
  >;
  readonly pendingInput: Pick<
    BrowserPanelPendingInput,
    "clearInput" | "queueInspection" | "queueWheel"
  >;
  setState<Key extends keyof BrowserPanelInputState>(
    key: Key,
    value: BrowserPanelInputState[Key],
  ): void;
  runAction(
    action: (client: GatewayBrowserClient) => Promise<void>,
    refreshView?: boolean,
  ): Promise<boolean>;
  reportError(error: unknown): void;
  exitCaptureModes(): void;
}

/** Owns pointer, keyboard, annotation, and inspection input for the browser surface. */
export class BrowserPanelInputController {
  private drawingStroke: AnnotationStroke | null = null;
  private suppressStageClick = false;

  constructor(private readonly host: BrowserPanelInputHost) {}

  resetCaptureState(): void {
    this.host.pendingInput.clearInput();
    this.drawingStroke = null;
  }

  private stageElement(): HTMLElement | null {
    return this.host.host.renderRoot.querySelector<HTMLElement>(".bp-stage");
  }

  private remotePoint(event: MouseEvent): { x: number; y: number } | null {
    return browserPanelRemotePoint(this.stageElement(), event, this.host.view);
  }

  inspectHighlightRegion() {
    return browserPanelInspectHighlightRegion(this.host.view, this.host.inspected);
  }

  handleStageClick(event: MouseEvent): void {
    if (this.suppressStageClick) {
      // The click that follows an inspect-capture pointerdown lands after the
      // mode already returned to interact; it must not reach the remote page.
      this.suppressStageClick = false;
      return;
    }
    if (this.host.mode !== "interact") {
      return;
    }
    // Keep keyboard forwarding live after a click; the canvas itself is not
    // focusable, so focus the surrounding viewport explicitly.
    this.host.host.renderRoot
      .querySelector<HTMLElement>(".bp-viewport")
      ?.focus({ preventScroll: true });
    const point = this.remotePoint(event);
    const targetId = this.host.activeTargetId;
    if (!point || !targetId) {
      return;
    }
    void this.host.runAction((client) =>
      clickBrowserCoords(client, { targetId, x: point.x, y: point.y }),
    );
  }

  handleWheel(event: WheelEvent): void {
    if (this.host.mode !== "interact" || !this.host.view) {
      return;
    }
    const client = this.host.operations.captureClient();
    const targetId = this.host.activeTargetId;
    if (!client || !targetId) {
      return;
    }
    event.preventDefault();
    const epoch = this.host.operations.epoch;
    this.host.pendingInput.queueWheel(event.deltaX, event.deltaY, 150, (deltaX, deltaY) => {
      if (
        !this.host.operations.isLive(epoch, client) ||
        this.host.activeTargetId !== targetId ||
        this.host.mode !== "interact"
      ) {
        return;
      }
      void this.host.runAction(async (actionClient) => {
        if (this.host.evaluateUnavailable) {
          // No page JS allowed: fall back to a coarse keyboard scroll.
          await pressBrowserKey(actionClient, {
            targetId,
            key: deltaY >= 0 ? "PageDown" : "PageUp",
          });
          return;
        }
        await scrollBrowserBy(actionClient, { targetId, deltaX, deltaY });
      });
    });
  }

  handleViewportKeydown(event: KeyboardEvent): void {
    if (this.host.mode !== "interact" || !this.host.view) {
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) {
      return;
    }
    const key = event.key;
    const targetId = this.host.activeTargetId;
    if (!browserPanelShouldForwardKey(key) || !targetId) {
      return;
    }
    event.preventDefault();
    void this.host.runAction((client) => pressBrowserKey(client, { targetId, key }));
  }

  handleOverlayPointerDown(event: PointerEvent): void {
    if (this.host.mode === "inspect") {
      this.suppressStageClick = true;
      void this.sendAnnotation({ element: this.host.inspected });
      return;
    }
    if (this.host.mode !== "annotate") {
      return;
    }
    const point = browserPanelNormalizedPoint(this.stageElement(), event);
    if (!point) {
      return;
    }
    (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
    this.drawingStroke = { points: [point] };
    this.host.setState("strokes", [...this.host.strokes, this.drawingStroke]);
    this.paintOverlay();
  }

  handleOverlayPointerMove(event: PointerEvent): void {
    if (this.host.mode === "annotate") {
      if (!this.drawingStroke) {
        return;
      }
      const point = browserPanelNormalizedPoint(this.stageElement(), event);
      if (point) {
        this.drawingStroke.points.push(point);
        this.paintOverlay();
      }
      return;
    }
    if (this.host.mode === "inspect") {
      this.queueInspect(event);
    }
  }

  handleOverlayPointerUp(): void {
    this.drawingStroke = null;
  }

  private queueInspect(event: PointerEvent): void {
    const client = this.host.operations.captureClient();
    const point = this.remotePoint(event);
    const stagePoint = browserPanelNormalizedPoint(this.stageElement(), event);
    const targetId = this.host.activeTargetId;
    if (!client || !point || !stagePoint || !targetId || this.host.evaluateUnavailable) {
      return;
    }
    const current = this.host.operations.beginInspection(
      client,
      () =>
        this.host.activeTargetId === targetId &&
        this.host.view?.targetId === targetId &&
        this.host.mode === "inspect",
    );
    this.host.setState("inspectPointer", stagePoint);
    this.host.pendingInput.queueInspection(INSPECT_THROTTLE_MS, current, () => {
      void inspectBrowserElementAt(client, { targetId, x: point.x, y: point.y })
        .then((node) => {
          if (current()) {
            this.host.setState("inspected", node);
            this.paintOverlay();
          }
        })
        .catch((error: unknown) => {
          if (current() && isBrowserEvaluateDisabledError(error)) {
            this.host.setState("evaluateUnavailable", true);
            this.host.setState("errorText", t("browser.inspectUnavailable"));
            this.host.setState("mode", "interact");
          }
        });
    });
  }

  undoStroke(): void {
    this.host.setState("strokes", this.host.strokes.slice(0, -1));
    this.drawingStroke = null;
    this.paintOverlay();
  }

  clearStrokes(): void {
    this.host.setState("strokes", []);
    this.drawingStroke = null;
    this.paintOverlay();
  }

  async sendAnnotation(params: { element?: BrowserInspectedNode | null }): Promise<void> {
    const view = this.host.view;
    const tab = this.host.tabs.find((entry) => entry.id === this.host.activeTargetId);
    const element = params.element ?? null;
    if (!view || (this.host.strokes.length === 0 && !element)) {
      return;
    }
    const highlight = element ? this.inspectHighlightRegion() : null;
    let result: ReturnType<typeof dispatchCompositedBrowserAnnotation>;
    try {
      result = dispatchCompositedBrowserAnnotation(
        view,
        tab,
        this.host.strokes,
        element,
        highlight,
      );
    } catch (error) {
      this.host.reportError(error);
      return;
    }
    if (result === "unhandled") {
      this.host.setState("noticeText", null);
      this.host.setState("errorText", t("browser.noChatTarget"));
      return;
    }
    if (result === "rejected") {
      this.host.setState("noticeText", null);
      this.host.setState("errorText", t("browser.annotationLimitReached"));
      return;
    }
    this.host.setState("errorText", null);
    this.host.setState("noticeText", t("browser.annotationSent"));
    this.host.exitCaptureModes();
  }

  /** Repaints the live stroke/highlight overlay; cheap, runs after render. */
  paintOverlay(): void {
    paintBrowserPanelOverlay(
      this.host.host.renderRoot.querySelector<HTMLCanvasElement>(".bp-overlay"),
      this.stageElement(),
      this.host.strokes,
      this.host.mode === "inspect" ? this.inspectHighlightRegion() : null,
    );
  }
}
