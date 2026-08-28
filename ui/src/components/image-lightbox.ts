import Panzoom, { type PanzoomObject } from "@panzoom/panzoom";
import { css, html, nothing, type PropertyValues } from "lit";
import { property, query, queryAll, state } from "lit/decorators.js";
import { t } from "../i18n/index.ts";
import { OpenClawLitElement } from "../lit/openclaw-element.ts";
import { icons } from "./icons.ts";
import "./modal-dialog.ts";

export type ImageLightboxItem = {
  kind?: "image" | "video";
  src: string;
  title: string;
  release?: () => void;
};

const SAFE_TOP_LEVEL_IMAGE_BLOB_TYPES = new Set([
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

const MAX_SCALE = 4;
const DOUBLE_TAP_SCALE = 2.5;

function mimeTypeEssence(value: string): string {
  return value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function dataUrlMimeType(source: string): string | undefined {
  const mediaType = /^data:([^,]*)/i.exec(source)?.[1];
  return mediaType === undefined ? undefined : mimeTypeEssence(mediaType);
}

class OpenClawImageLightbox extends OpenClawLitElement {
  @property() mediaKind: "image" | "video" = "image";
  @property() src = "";
  @property({ attribute: false }) imageTitle = "";
  @query(".stage") private stage?: HTMLDivElement;
  @query(".image") private image?: HTMLImageElement;
  @queryAll(".action") private actions!: NodeListOf<HTMLElement>;
  @state() private openOriginalUrl = "";
  @state() private scale = 1;
  @state() private imageReady = false;

  private originalBlobUrl = "";
  private originalUrlRequest = 0;
  private panzoom?: PanzoomObject;
  private panzoomImage?: HTMLImageElement;
  private panzoomStage?: HTMLDivElement;
  private backdropPointer: { pointerId: number; clientX: number; clientY: number } | undefined;
  private motionQuery?: MediaQueryList;

  static override styles = css`
    :host {
      --image-lightbox-control-background: rgba(12, 16, 24, 0.64);
      --image-lightbox-control-background-hover: rgba(12, 16, 24, 0.78);
      display: contents;
    }

    :host-context([data-theme-mode="dark"]) {
      --image-lightbox-control-background: rgba(255, 255, 255, 0.16);
      --image-lightbox-control-background-hover: rgba(255, 255, 255, 0.22);
    }

    openclaw-modal-dialog {
      --openclaw-modal-width: 100vw;
      --openclaw-modal-max-width: 100vw;
      --openclaw-modal-max-height: 100dvh;
      --openclaw-modal-backdrop-filter: none;
    }

    .lightbox {
      width: 100vw;
      height: 100dvh;
      display: grid;
      grid-template-rows: minmax(0, 1fr);
      overflow: hidden;
    }

    .header {
      display: contents;
    }

    .actions {
      position: fixed;
      z-index: 1;
      top: max(16px, calc(12px + var(--safe-area-top, 0px)));
      right: max(16px, calc(12px + var(--safe-area-right, 0px)));
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }

    .actions .action,
    .action.zoom-control {
      color: var(--media-foreground);
      background-color: var(--image-lightbox-control-background);
      -webkit-backdrop-filter: blur(16px) saturate(140%);
      backdrop-filter: blur(16px) saturate(140%);
      box-shadow: 0 6px 24px rgba(0, 0, 0, 0.18);
    }

    .actions .action {
      border-radius: 999px;
      transition: background-color 180ms ease;
    }

    .actions .action:hover,
    .zoom-control:hover:not(:disabled) {
      background-color: var(--image-lightbox-control-background-hover);
    }

    .title {
      display: none;
    }

    .action {
      min-height: 36px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0 12px;
      border: 0;
      border-radius: var(--radius-md);
      background: transparent;
      color: #fff;
      font: inherit;
      font-size: 12px;
      font-weight: 650;
      text-decoration: none;
      text-shadow: 0 1px 3px rgba(0, 0, 0, 0.85);
    }

    .action:hover {
      background: color-mix(in srgb, var(--text) 10%, transparent);
    }

    .action:focus-visible {
      outline: 2px solid #fff;
      outline-offset: 2px;
    }

    .action:focus:not(:focus-visible) {
      outline: none;
    }

    .open-original {
      min-height: 44px;
    }

    .open-original-icon {
      display: none;
    }

    .close {
      width: 44px;
      height: 44px;
      padding: 0;
      color: rgba(255, 255, 255, 0.82);
    }

    .close svg {
      width: 17px;
      height: 17px;
      /* Shadow DOM: global icon stroke rules don't reach in here; without a
         stroke the open-path x icon renders invisible. */
      fill: none;
      stroke: currentColor;
      stroke-width: 2;
      stroke-linecap: round;
      stroke-linejoin: round;
    }

    .stage {
      min-height: 0;
      width: 100%;
      height: 100%;
      display: grid;
      place-items: center;
      box-sizing: border-box;
      padding: 20px 20px 72px;
      overflow: hidden;
    }

    .image {
      display: block;
      min-width: 0;
      min-height: 0;
      max-width: 100%;
      max-height: 100%;
      width: auto;
      height: auto;
      object-fit: contain;
      cursor: zoom-in;
      -webkit-user-drag: none;
    }

    .video {
      display: block;
      min-width: 0;
      min-height: 0;
      max-width: 100%;
      max-height: 100%;
      width: min(1280px, 100%);
      height: auto;
      background: var(--media-bg);
      object-fit: contain;
    }

    .image.zoomed {
      cursor: grab;
    }

    .zoom-controls {
      position: fixed;
      z-index: 1;
      bottom: max(14px, calc(10px + var(--safe-area-bottom, 0px)));
      left: 50%;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      transform: translateX(-50%);
    }

    .zoom-control {
      min-width: 40px;
      min-height: 40px;
      padding: 0 10px;
      border: 0;
      font-size: 15px;
    }

    .zoom-control:disabled {
      color: rgba(255, 255, 255, 0.8);
    }

    .zoom-level {
      min-width: 58px;
      font-size: 11px;
    }

    @media (max-width: 768px),
      (max-width: 932px) and (max-height: 500px) and (orientation: landscape) {
      openclaw-modal-dialog {
        --openclaw-modal-width: 100vw;
        --openclaw-modal-max-width: 100vw;
        --openclaw-modal-max-height: 100dvh;
      }

      .lightbox {
        width: 100vw;
        height: 100dvh;
      }

      .stage {
        padding: calc(68px + var(--safe-area-top, 0px)) calc(12px + var(--safe-area-right, 0px))
          calc(64px + var(--safe-area-bottom, 0px)) calc(12px + var(--safe-area-left, 0px));
      }

      .open-original {
        width: 44px;
        padding: 0;
      }

      .open-original-label {
        display: none;
      }

      .open-original-icon {
        display: inline-flex;
      }

      .open-original-icon svg {
        width: 17px;
        height: 17px;
      }

      .zoom-control {
        min-width: 44px;
        min-height: 44px;
      }
    }

    @media (prefers-reduced-motion: reduce) {
      openclaw-modal-dialog {
        --show-duration: 0ms;
        --hide-duration: 0ms;
      }

      .actions .action {
        transition: none;
      }
    }
  `;

  override connectedCallback() {
    super.connectedCallback();
    this.motionQuery = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)");
    this.motionQuery?.addEventListener("change", this.handleMotionPreferenceChange);
    if (this.hasUpdated) {
      void this.resolveOriginalUrl();
      void this.updateComplete.then(() => {
        const image = this.image;
        if (image?.complete && image.naturalWidth > 0) {
          this.initializePanzoom(image);
        }
      });
    }
  }

  override disconnectedCallback() {
    this.originalUrlRequest += 1;
    this.motionQuery?.removeEventListener("change", this.handleMotionPreferenceChange);
    this.motionQuery = undefined;
    this.destroyPanzoom();
    this.revokeOriginalBlobUrl();
    super.disconnectedCallback();
  }

  protected override updated(changed: PropertyValues<this>) {
    if (changed.has("src") || changed.has("mediaKind")) {
      this.destroyPanzoom();
      this.scale = 1;
      this.imageReady = false;
      void this.resolveOriginalUrl();
    }
  }

  override render() {
    const title = this.imageTitle.trim() || t("chat.imageLightbox.untitled");
    const dialogLabel =
      this.mediaKind === "video"
        ? t("chat.mediaPlayer.videoPreview", { title })
        : t("chat.imageLightbox.label", { title });
    const closeLabel =
      this.mediaKind === "video"
        ? t("chat.mediaPlayer.closeVideoPreview")
        : t("chat.imageLightbox.close");
    const canZoom = this.imageReady && this.panzoom !== undefined;
    return html`
      <openclaw-modal-dialog
        class="mobile-edge-to-edge viewport-edge-to-edge"
        label=${dialogLabel}
        @modal-cancel=${this.emitClose}
        @keydown=${this.handleKeydown}
      >
        <section class="lightbox">
          <header class="header">
            <strong class="title">${title}</strong>
            <div class="actions">
              ${this.openOriginalUrl
                ? html`
                    <a
                      class="action open-original"
                      href=${this.openOriginalUrl}
                      target="_blank"
                      rel="noreferrer"
                      aria-label=${t("chat.imageLightbox.openOriginal")}
                    >
                      <span class="open-original-label">
                        ${t("chat.imageLightbox.openOriginal")}
                      </span>
                      <span class="open-original-icon" aria-hidden="true">
                        ${icons.externalLink}
                      </span>
                    </a>
                  `
                : nothing}
              <button
                class="action close"
                type="button"
                autofocus
                aria-label=${closeLabel}
                @click=${this.emitClose}
              >
                ${icons.x}
              </button>
            </div>
          </header>
          <div
            class="stage"
            @pointerdown=${this.handleStagePointerDown}
            @pointerup=${this.handleStagePointerUp}
            @pointercancel=${this.resetBackdropPointer}
            @dblclick=${this.handleDoubleClick}
          >
            ${this.mediaKind === "video"
              ? html`<video
                  class="video"
                  src=${this.src}
                  aria-label=${title}
                  controls
                  autoplay
                  playsinline
                ></video>`
              : html`<img
                  class=${this.scale > 1 ? "image zoomed" : "image"}
                  src=${this.src}
                  alt=${title}
                  @load=${this.handleImageLoad}
                  @error=${this.handleImageError}
                  @dragstart=${(event: DragEvent) => event.preventDefault()}
                />`}
          </div>
          ${this.mediaKind === "image"
            ? html`<div class="zoom-controls">
                <button
                  class="action zoom-control"
                  type="button"
                  aria-label=${t("chat.imageLightbox.zoomOut")}
                  ?disabled=${!canZoom || this.scale <= 1}
                  @click=${this.zoomOut}
                >
                  −
                </button>
                <button
                  class="action zoom-control zoom-level"
                  type="button"
                  aria-label=${t("chat.imageLightbox.resetZoom")}
                  ?disabled=${!canZoom || this.scale === 1}
                  @click=${this.resetZoom}
                >
                  ${Math.round(this.scale * 100)}%
                </button>
                <button
                  class="action zoom-control"
                  type="button"
                  aria-label=${t("chat.imageLightbox.zoomIn")}
                  ?disabled=${!canZoom || this.scale >= MAX_SCALE}
                  @click=${this.zoomIn}
                >
                  +
                </button>
              </div>`
            : nothing}
        </section>
      </openclaw-modal-dialog>
    `;
  }

  private handleImageLoad = (event: Event) => {
    const image = event.currentTarget;
    if (image instanceof HTMLImageElement && image === this.image) {
      this.initializePanzoom(image);
    }
  };

  private handleImageError = (event: Event) => {
    if (event.currentTarget !== this.image) {
      return;
    }
    this.destroyPanzoom();
    this.scale = 1;
    this.imageReady = false;
  };

  private initializePanzoom(image: HTMLImageElement) {
    const stage = this.stage;
    if (!stage || image !== this.image) {
      return;
    }
    this.destroyPanzoom();
    this.panzoomImage = image;
    this.panzoomStage = stage;
    this.panzoom = Panzoom(image, {
      duration: this.motionQuery?.matches ? 0 : 200,
      maxScale: MAX_SCALE,
      minScale: 1,
      panOnlyWhenZoomed: true,
    });
    image.addEventListener("panzoomchange", this.handlePanzoomChange);
    stage.addEventListener("wheel", this.handleWheel, { passive: false });
    this.imageReady = true;
  }

  private destroyPanzoom() {
    const image = this.panzoomImage;
    image?.removeEventListener("panzoomchange", this.handlePanzoomChange);
    this.panzoomStage?.removeEventListener("wheel", this.handleWheel);
    this.panzoom?.destroy();
    this.panzoom?.resetStyle();
    image?.style.removeProperty("transform");
    image?.style.removeProperty("transition");
    this.panzoom = undefined;
    this.panzoomImage = undefined;
    this.panzoomStage = undefined;
    this.imageReady = false;
  }

  private handlePanzoomChange = (event: Event) => {
    if (!(event instanceof CustomEvent)) {
      return;
    }
    const detail: unknown = event.detail;
    if (
      typeof detail !== "object" ||
      detail === null ||
      !("scale" in detail) ||
      typeof detail.scale !== "number"
    ) {
      return;
    }
    this.scale = detail.scale;
  };

  private handleWheel = (event: WheelEvent) => {
    if (!this.panzoom) {
      return;
    }
    event.preventDefault();
    this.panzoom.zoomWithWheel(event);
  };

  private handleDoubleClick = (event: MouseEvent) => {
    if (!this.panzoom) {
      return;
    }
    event.preventDefault();
    if (this.scale > 1) {
      this.resetZoom();
      return;
    }
    this.panzoom?.zoomToPoint(DOUBLE_TAP_SCALE, event);
  };

  private handleStagePointerDown = (event: PointerEvent) => {
    const stage = event.currentTarget;
    if (
      event.button !== 0 ||
      !event.isPrimary ||
      event.target !== stage ||
      !(stage instanceof HTMLElement)
    ) {
      this.backdropPointer = undefined;
      return;
    }
    this.backdropPointer = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
    };
    stage.setPointerCapture?.(event.pointerId);
  };

  private handleStagePointerUp = (event: PointerEvent) => {
    const pointer = this.backdropPointer;
    this.backdropPointer = undefined;
    const stage = event.currentTarget;
    const releaseTarget = this.shadowRoot?.elementFromPoint?.(event.clientX, event.clientY);
    const shouldClose =
      event.button === 0 &&
      event.isPrimary &&
      pointer?.pointerId === event.pointerId &&
      releaseTarget === stage &&
      Math.hypot(event.clientX - pointer.clientX, event.clientY - pointer.clientY) <= 4;
    if (shouldClose) {
      this.emitClose();
    }
  };

  private resetBackdropPointer = () => {
    this.backdropPointer = undefined;
  };

  private handleMotionPreferenceChange = (event: MediaQueryListEvent) => {
    this.panzoom?.setOptions({ duration: event.matches ? 0 : 200 });
  };

  private zoomIn = () => this.panzoom?.zoomIn();
  private zoomOut = () => this.panzoom?.zoomOut();
  private resetZoom = () => this.panzoom?.reset({ animate: false });

  private revokeOriginalBlobUrl() {
    if (!this.originalBlobUrl) {
      return;
    }
    URL.revokeObjectURL(this.originalBlobUrl);
    this.originalBlobUrl = "";
  }

  private async resolveOriginalUrl() {
    const request = ++this.originalUrlRequest;
    this.revokeOriginalBlobUrl();
    const source = this.src.trim();
    if (!source) {
      this.openOriginalUrl = "";
      return;
    }
    const sourcePrefix = source.slice(0, 5).toLowerCase();
    const isDataUrl = sourcePrefix === "data:";
    const isBlobUrl = sourcePrefix === "blob:";
    if (!isDataUrl && !isBlobUrl) {
      this.openOriginalUrl = source;
      return;
    }
    this.openOriginalUrl = "";
    const sourceType = isDataUrl ? dataUrlMimeType(source) : undefined;
    // Reject active data formats before fetching. Incoming blob URLs still need
    // their fetched MIME checked because top-level blobs inherit the app origin.
    if (isDataUrl && (!sourceType || !SAFE_TOP_LEVEL_IMAGE_BLOB_TYPES.has(sourceType))) {
      return;
    }
    try {
      const response = await fetch(source);
      const blob = await response.blob();
      if (
        !this.isConnected ||
        request !== this.originalUrlRequest ||
        !SAFE_TOP_LEVEL_IMAGE_BLOB_TYPES.has(mimeTypeEssence(blob.type))
      ) {
        return;
      }
      if (isBlobUrl) {
        this.openOriginalUrl = source;
        return;
      }
      this.originalBlobUrl = URL.createObjectURL(blob);
      this.openOriginalUrl = this.originalBlobUrl;
    } catch {
      // The image remains viewable inline; omit an unusable original-link action.
    }
  }

  private handleKeydown = (event: KeyboardEvent) => {
    if (this.panzoom && (event.key === "+" || event.key === "=")) {
      event.preventDefault();
      this.zoomIn();
      return;
    }
    if (this.panzoom && event.key === "-") {
      event.preventDefault();
      this.zoomOut();
      return;
    }
    if (this.panzoom && event.key === "0") {
      event.preventDefault();
      this.resetZoom();
      return;
    }
    if (event.key !== "Tab") {
      return;
    }
    const actions = [...this.actions].filter(
      (action) => !(action instanceof HTMLButtonElement && action.disabled),
    );
    const first = actions[0];
    const last = actions.at(-1);
    if (!first || !last) {
      return;
    }
    const source = event.composedPath()[0];
    if (event.shiftKey && source === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && source === last) {
      event.preventDefault();
      first.focus();
    }
  };

  private emitClose = () => {
    this.dispatchEvent(
      new CustomEvent("image-lightbox-close", {
        bubbles: true,
        composed: true,
      }),
    );
  };
}

if (!customElements.get("openclaw-image-lightbox")) {
  customElements.define("openclaw-image-lightbox", OpenClawImageLightbox);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-image-lightbox": OpenClawImageLightbox;
  }
}
