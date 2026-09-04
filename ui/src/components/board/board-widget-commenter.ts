import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { t } from "../../i18n/index.ts";
import { requestWidgetSnapshot } from "../../lib/board/widget-snapshot.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { showToast } from "../../lib/toast.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import {
  buildBrowserAnnotationContent,
  composeAnnotatedImage,
  type AnnotationRegion,
  type BrowserAnnotationDraft,
} from "../browser/browser-annotation.ts";
import type { BrowserInspectedNode } from "../browser/browser-client.ts";
import { icons } from "../icons.ts";
import "../tooltip.ts";

const INSPECT_REQUEST_TYPE = "openclaw:widget-inspect-request";
const INSPECT_RESULT_TYPE = "openclaw:widget-inspect-result";
const INSPECT_TIMEOUT_MS = 1_500;

type Rect = { x: number; y: number; width: number; height: number };

type CanvasInspectedNode = BrowserInspectedNode & {
  viewportRect: Rect;
  documentSize: { width: number; height: number };
};

export type CanvasElementAnnotation = {
  id: string;
  widgetName: string;
  node: CanvasInspectedNode;
  draft: BrowserAnnotationDraft;
};

export type CanvasElementAnnotationEvent = CustomEvent<
  CanvasElementAnnotation & { captureEpoch: number }
>;

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function rect(value: unknown): Rect | null {
  const record = asNullableRecord(value);
  if (!record) {
    return null;
  }
  const x = finite(record.x);
  const y = finite(record.y);
  const width = finite(record.width);
  const height = finite(record.height);
  return x === null || y === null || width === null || height === null || width < 0 || height < 0
    ? null
    : { x, y, width, height };
}

function boundedString(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.slice(0, maxLength) : "";
}

function normalizeNode(value: unknown): CanvasInspectedNode | null {
  const record = asNullableRecord(value);
  if (!record) {
    return null;
  }
  const nodeRect = rect(record.rect);
  const viewportRect = rect(record.viewportRect);
  const documentSize = rect({
    x: 0,
    y: 0,
    ...asNullableRecord(record.documentSize),
  });
  if (
    !nodeRect ||
    !viewportRect ||
    !documentSize ||
    documentSize.width <= 0 ||
    documentSize.height <= 0 ||
    documentSize.width > 16_384 ||
    documentSize.height > 16_384
  ) {
    return null;
  }
  return {
    tag: boundedString(record.tag, 40),
    id: boundedString(record.id, 120),
    classes: Array.isArray(record.classes)
      ? record.classes
          .filter((entry): entry is string => typeof entry === "string")
          .slice(0, 6)
          .map((entry) => entry.slice(0, 80))
      : [],
    selector: boundedString(record.selector, 500),
    role: boundedString(record.role, 80),
    name: boundedString(record.name, 120),
    rect: nodeRect,
    viewportRect,
    documentSize: { width: documentSize.width, height: documentSize.height },
    focusable: record.focusable === true,
  };
}

function requestWidgetInspection(
  frame: HTMLIFrameElement,
  point: { x: number; y: number },
): Promise<CanvasInspectedNode | null> {
  const target = frame.contentWindow;
  if (!target) {
    return Promise.reject(new Error("widget frame is unavailable"));
  }
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      window.removeEventListener("message", handleMessage);
      globalThis.clearTimeout(timeout);
    };
    const handleMessage = (event: MessageEvent) => {
      if (
        event.source !== target ||
        event.data?.type !== INSPECT_RESULT_TYPE ||
        event.data.id !== id
      ) {
        return;
      }
      cleanup();
      resolve(normalizeNode(event.data.node));
    };
    window.addEventListener("message", handleMessage);
    const timeout = globalThis.setTimeout(() => {
      cleanup();
      reject(new Error("widget element inspection timed out"));
    }, INSPECT_TIMEOUT_MS);
    try {
      target.postMessage({ type: INSPECT_REQUEST_TYPE, id, x: point.x, y: point.y }, "*");
    } catch (error) {
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.addEventListener("load", () => resolve(image), { once: true });
    image.addEventListener("error", () => reject(new Error("widget snapshot failed to decode")), {
      once: true,
    });
    image.src = dataUrl;
  });
}

async function buildCanvasElementAnnotation(params: {
  frame: HTMLIFrameElement;
  node: CanvasInspectedNode;
  title: string;
  widgetName: string;
  comment: string;
}): Promise<BrowserAnnotationDraft> {
  const dataUrl = await requestWidgetSnapshot(params.frame);
  const image = await loadImage(dataUrl);
  const highlight: AnnotationRegion = {
    x: params.node.rect.x / params.node.documentSize.width,
    y: params.node.rect.y / params.node.documentSize.height,
    width: params.node.rect.width / params.node.documentSize.width,
    height: params.node.rect.height / params.node.documentSize.height,
  };
  const content = buildBrowserAnnotationContent({
    url: `canvas://shared/${encodeURIComponent(params.widgetName)}`,
    title: params.title,
    strokes: [],
    element: params.node,
  });
  const comment = truncateUtf16Safe(params.comment.trim(), 2_000);
  return {
    modelContext: `${content.modelContext}\n${t("browser.annotatePrompt.elementComment", {
      comment: JSON.stringify(comment),
    })}`,
    card: {
      ...content.card,
      markedRegionCount: 1,
      comment,
      selector: params.node.selector,
      elementTag: params.node.tag,
    },
    dataUrl: composeAnnotatedImage({
      image,
      width: image.naturalWidth,
      height: image.naturalHeight,
      strokes: [],
      highlight,
    }),
    fileName: `canvas-${params.widgetName.replace(/[^\w.-]+/g, "-").slice(0, 80) || "element"}.png`,
  };
}

const COMMENT_HOVER_DELAY_MS = 40;
const COMMENT_EDITOR_WIDTH_PX = 320;
const COMMENT_EDITOR_HEIGHT_PX = 58;
const COMMENT_EDITOR_GAP_PX = 8;

class OpenClawBoardWidgetCommenter extends OpenClawLightDomElement {
  @property({ type: Boolean }) active = false;
  @property({ attribute: false }) annotations: readonly CanvasElementAnnotation[] = [];
  @property({ type: Number }) captureEpoch = 0;
  @property() sessionKey = "";
  @property() override title = "";
  @property() widgetName = "";
  @property({ type: Number }) widgetRevision = 0;

  @state() private hoveredNode: CanvasInspectedNode | null = null;
  @state() private selectedNode: CanvasInspectedNode | null = null;
  @state() private comment = "";
  @state() private capturing = false;
  private requestGeneration = 0;
  private hoverTimer: number | null = null;
  private hoverPoint: { x: number; y: number } | null = null;

  override willUpdate(changed: PropertyValues<this>): void {
    if (
      (changed.has("active") && !this.active) ||
      changed.has("sessionKey") ||
      changed.has("widgetName") ||
      changed.has("widgetRevision") ||
      changed.has("captureEpoch")
    ) {
      this.resetInteraction();
    }
  }

  override disconnectedCallback(): void {
    this.resetInteraction();
    super.disconnectedCallback();
  }

  private frame(): HTMLIFrameElement | null {
    return this.parentElement?.querySelector<HTMLIFrameElement>(".board-widget__frame") ?? null;
  }

  private point(frame: HTMLIFrameElement, event: PointerEvent): { x: number; y: number } {
    // The overlay covers the padded widget body, while elementFromPoint runs in
    // the iframe viewport. Measure from that viewport or every hit drifts by the inset.
    const bounds = frame.getBoundingClientRect();
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  }

  private readonly inspectHover = async (): Promise<void> => {
    this.hoverTimer = null;
    const point = this.hoverPoint;
    const frame = this.frame();
    if (!point || !frame || !this.active || this.selectedNode) {
      return;
    }
    const generation = ++this.requestGeneration;
    try {
      const node = await requestWidgetInspection(frame, point);
      if (generation === this.requestGeneration && this.active && frame === this.frame()) {
        this.hoveredNode = node;
      }
    } catch {
      if (generation === this.requestGeneration) {
        this.hoveredNode = null;
      }
    }
  };

  private readonly handlePointerMove = (event: PointerEvent): void => {
    if (this.selectedNode) {
      return;
    }
    const frame = this.frame();
    if (!frame) {
      return;
    }
    this.hoverPoint = this.point(frame, event);
    if (this.hoverTimer === null) {
      this.hoverTimer = window.setTimeout(() => void this.inspectHover(), COMMENT_HOVER_DELAY_MS);
    }
  };

  private clearHover(): void {
    this.requestGeneration += 1;
    this.hoverPoint = null;
    this.hoveredNode = null;
    if (this.hoverTimer !== null) {
      window.clearTimeout(this.hoverTimer);
      this.hoverTimer = null;
    }
  }

  private resetInteraction(): void {
    this.clearHover();
    this.selectedNode = null;
    this.comment = "";
    this.capturing = false;
  }

  private sourceIsCurrent(source: {
    frame: HTMLIFrameElement;
    generation: number;
    sessionKey: string;
    widgetName: string;
    widgetRevision: number;
    captureEpoch: number;
  }): boolean {
    return (
      this.isConnected &&
      this.active &&
      source.frame === this.frame() &&
      source.generation === this.requestGeneration &&
      source.sessionKey === this.sessionKey &&
      source.widgetName === this.widgetName &&
      source.widgetRevision === this.widgetRevision &&
      source.captureEpoch === this.captureEpoch
    );
  }

  private captureSource(frame: HTMLIFrameElement) {
    return {
      frame,
      generation: ++this.requestGeneration,
      sessionKey: this.sessionKey,
      widgetName: this.widgetName,
      widgetRevision: this.widgetRevision,
      captureEpoch: this.captureEpoch,
    };
  }

  private async handleSelect(event: PointerEvent): Promise<void> {
    event.preventDefault();
    event.stopPropagation();
    if (this.selectedNode || this.capturing) {
      return;
    }
    const frame = this.frame();
    if (!frame) {
      return;
    }
    const source = this.captureSource(frame);
    try {
      const node = await requestWidgetInspection(frame, this.point(frame, event));
      if (!this.sourceIsCurrent(source)) {
        return;
      }
      if (!node) {
        showToast({ message: t("chat.board.commentElementUnavailable") });
        return;
      }
      this.selectedNode = node;
      this.hoveredNode = node;
      this.comment = "";
      await this.updateComplete;
      this.querySelector<HTMLInputElement>("[data-canvas-comment-input]")?.focus({
        preventScroll: true,
      });
    } catch (error) {
      if (this.sourceIsCurrent(source)) {
        showToast({ message: t("chat.board.commentFailed", { error: formatUiError(error) }) });
      }
    }
  }

  private async submitComment(): Promise<void> {
    const node = this.selectedNode;
    const comment = this.comment.trim();
    const frame = this.frame();
    if (!node || !comment || !frame || this.capturing) {
      return;
    }
    const source = this.captureSource(frame);
    this.capturing = true;
    try {
      const draft = await buildCanvasElementAnnotation({
        frame,
        node,
        title: this.title || this.widgetName,
        widgetName: this.widgetName,
        comment,
      });
      if (!this.sourceIsCurrent(source)) {
        return;
      }
      const event = new CustomEvent<CanvasElementAnnotation & { captureEpoch: number }>(
        "canvas-annotation-added",
        {
          bubbles: true,
          cancelable: true,
          detail: {
            id: crypto.randomUUID(),
            widgetName: this.widgetName,
            node,
            draft,
            captureEpoch: source.captureEpoch,
          },
        },
      );
      this.dispatchEvent(event);
      if (!event.defaultPrevented) {
        showToast({ message: t("browser.annotationLimitReached") });
        return;
      }
      this.selectedNode = null;
      this.comment = "";
      this.capturing = false;
      this.clearHover();
    } catch (error) {
      if (this.sourceIsCurrent(source)) {
        showToast({ message: t("chat.board.commentFailed", { error: formatUiError(error) }) });
      }
    } finally {
      if (this.sourceIsCurrent(source)) {
        this.capturing = false;
      }
    }
  }

  private editorPosition(node: CanvasInspectedNode): string {
    const left = Math.max(
      COMMENT_EDITOR_GAP_PX,
      Math.min(
        node.viewportRect.x,
        this.clientWidth - COMMENT_EDITOR_WIDTH_PX - COMMENT_EDITOR_GAP_PX,
      ),
    );
    const below = node.viewportRect.y + node.viewportRect.height + COMMENT_EDITOR_GAP_PX;
    const top =
      below + COMMENT_EDITOR_HEIGHT_PX <= this.clientHeight
        ? below
        : Math.max(COMMENT_EDITOR_GAP_PX, node.viewportRect.y - COMMENT_EDITOR_HEIGHT_PX);
    return `left:${left}px;top:${top}px`;
  }

  private renderNodeHighlight(node: CanvasInspectedNode) {
    return html`<span
      class="board-widget__comment-highlight"
      style=${`left:${node.viewportRect.x}px;top:${node.viewportRect.y}px;width:${node.viewportRect.width}px;height:${node.viewportRect.height}px`}
    ></span>`;
  }

  override render() {
    if (!this.active) {
      return nothing;
    }
    const highlighted = this.selectedNode ?? this.hoveredNode;
    return html`<div
      class="board-widget__comment-overlay"
      data-canvas-comment-overlay
      aria-label=${t("browser.inspect")}
      @pointermove=${this.handlePointerMove}
      @pointerleave=${() => {
        if (!this.selectedNode) {
          this.clearHover();
        }
      }}
      @pointerdown=${(event: PointerEvent) => event.preventDefault()}
      @click=${(event: PointerEvent) => void this.handleSelect(event)}
    >
      ${this.annotations.map(
        (annotation, index) => html`${this.renderNodeHighlight(annotation.node)}<span
            class="board-widget__comment-marker"
            style=${`left:${annotation.node.viewportRect.x}px;top:${annotation.node.viewportRect.y}px`}
            aria-label=${`${t("chat.composer.browserAnnotation")} ${index + 1}`}
            >${index + 1}</span
          >`,
      )}
      ${highlighted ? this.renderNodeHighlight(highlighted) : nothing}
      ${
        this.selectedNode
          ? html`<form
              class="board-widget__comment-editor"
              style=${this.editorPosition(this.selectedNode)}
              @pointerdown=${(event: PointerEvent) => event.stopPropagation()}
              @click=${(event: MouseEvent) => event.stopPropagation()}
              @submit=${(event: SubmitEvent) => {
                event.preventDefault();
                void this.submitComment();
              }}
            >
              <span class="board-widget__comment-editor-icon" aria-hidden="true"
                >${icons.messageSquare}</span
              >
              <input
                data-canvas-comment-input
                .value=${this.comment}
                maxlength="2000"
                aria-label=${t("chat.board.commentInput")}
                placeholder=${t("chat.board.commentInput")}
                ?disabled=${this.capturing}
                @input=${(event: InputEvent) => {
                  if (event.currentTarget instanceof HTMLInputElement) {
                    this.comment = event.currentTarget.value;
                  }
                }}
              />
              <button
                type="submit"
                class="board-widget__comment-submit"
                aria-label=${t("chat.board.commentInput")}
                ?disabled=${!this.comment.trim() || this.capturing}
              >
                ${
                  this.capturing
                    ? html`<span class="btn__spinner" aria-hidden="true"></span>`
                    : icons.check
                }
              </button>
            </form>`
          : html`<span class="board-widget__comment-label"
              >${highlighted?.selector || highlighted?.tag || t("browser.inspect")}</span
            >`
      }
    </div>`;
  }
}

if (!customElements.get("openclaw-board-widget-commenter")) {
  customElements.define("openclaw-board-widget-commenter", OpenClawBoardWidgetCommenter);
}
