import Panzoom, { type PanzoomObject } from "@panzoom/panzoom";
import { css, html, nothing, type PropertyValues } from "lit";
import { property, query, queryAll, state } from "lit/decorators.js";
import { t } from "../i18n/index.ts";
import { OpenClawLitElement } from "../lit/openclaw-element.ts";
import { icons } from "./icons.ts";
import "./modal-dialog.ts";

export type ImageLightboxItem = {
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
  @property() src = "";
  @property() override title = "";
  @query(".stage") private stage?: HTMLDivElement;
  @query(".image") private image?: HTMLImageElement;
  @queryAll(".action") private actions!: NodeListOf<HTMLElement>;
  @state() private openOriginalUrl = "";
  @state() private scale = 1;

  private originalBlobUrl = "";
  private originalUrlRequest = 0;
  private panzoom?: PanzoomObject;

  static override styles = css`
    :host {
      display: contents;
    }

    openclaw-modal-dialog {
      --openclaw-modal-width: min(1280px, calc(100vw - 40px));
      --openclaw-modal-max-width: calc(100vw - 40px);
      --openclaw-modal-max-height: calc(100dvh - 40px);
    }

    .lightbox {
      position: relative;
      width: min(1280px, calc(100vw - 40px));
      height: min(900px, calc(100dvh - 40px));
      overflow: hidden;
      border: 1px solid color-mix(in srgb, var(--border-strong) 80%, transparent);
      border-radius: var(--radius-lg);
      /* Deliberately darker than any theme surface: the lightbox is a
         photo-viewer chrome that stays near-black in light mode too, so the
         white text and white-alpha borders below assume this literal. */
      background: #07090f;
      box-shadow: 0 28px 90px rgba(0, 0, 0, 0.6);
    }

    .header {
      position: absolute;
      z-index: 2;
      top: 0;
      right: 0;
      left: 0;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      min-height: 54px;
      padding: 10px 12px 10px 18px;
      background: linear-gradient(rgba(7, 9, 15, 0.9), transparent);
      color: #fff;
    }

    .title {
      min-width: 0;
      overflow: hidden;
      font-size: 13px;
      font-weight: 650;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .actions,
    .zoom-controls {
      display: inline-flex;
      align-items: center;
    }

    .actions {
      gap: 8px;
      flex: 0 0 auto;
    }

    .action {
      min-height: 36px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0 12px;
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: var(--radius-md);
      background: rgba(255, 255, 255, 0.08);
      color: #fff;
      font: inherit;
      font-size: 12px;
      font-weight: 650;
      text-decoration: none;
    }

    .action:hover {
      border-color: rgba(255, 255, 255, 0.2);
      background: rgba(255, 255, 255, 0.14);
    }

    .action:focus-visible {
      outline: 2px solid #fff;
      outline-offset: 2px;
    }

    .close {
      width: 36px;
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
      width: 100%;
      height: 100%;
      display: grid;
      place-items: center;
      box-sizing: border-box;
      padding: 20px;
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
      border-radius: var(--radius-md);
      background: rgba(255, 255, 255, 0.04);
      object-fit: contain;
      cursor: zoom-in;
      -webkit-user-drag: none;
    }

    .image.zoomed {
      cursor: grab;
    }

    .zoom-controls {
      position: absolute;
      z-index: 2;
      right: 50%;
      bottom: 14px;
      gap: 4px;
      padding: 4px;
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: var(--radius-lg);
      background: rgba(7, 9, 15, 0.82);
      box-shadow: 0 8px 28px rgba(0, 0, 0, 0.35);
      transform: translateX(50%);
      backdrop-filter: blur(12px);
    }

    .zoom-control {
      min-width: 40px;
      min-height: 40px;
      padding: 0 10px;
      border: 0;
      background: transparent;
      font-size: 15px;
    }

    .zoom-control:disabled {
      color: rgba(255, 255, 255, 0.35);
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
        border: 0;
        border-radius: 0;
      }

      .header {
        padding-top: calc(10px + env(safe-area-inset-top));
        padding-right: calc(12px + env(safe-area-inset-right));
        padding-left: calc(16px + env(safe-area-inset-left));
      }

      .stage {
        padding: 0;
      }

      .close,
      .zoom-control {
        min-width: 44px;
        min-height: 44px;
      }

      .zoom-controls {
        bottom: calc(12px + env(safe-area-inset-bottom));
      }
    }
  `;

  override connectedCallback() {
    super.connectedCallback();
    if (this.hasUpdated) {
      void this.resolveOriginalUrl();
    }
  }

  override disconnectedCallback() {
    this.originalUrlRequest += 1;
    this.destroyPanzoom();
    this.revokeOriginalBlobUrl();
    super.disconnectedCallback();
  }

  protected override updated(changed: PropertyValues<this>) {
    if (changed.has("src")) {
      this.destroyPanzoom();
      this.scale = 1;
      void this.resolveOriginalUrl();
    }
  }

  override render() {
    const title = this.title.trim() || t("chat.imageLightbox.untitled");
    return html`
      <openclaw-modal-dialog
        class="mobile-edge-to-edge"
        label=${t("chat.imageLightbox.label", { title })}
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
                    >
                      ${t("chat.imageLightbox.openOriginal")}
                    </a>
                  `
                : nothing}
              <button
                class="action close"
                type="button"
                autofocus
                aria-label=${t("chat.imageLightbox.close")}
                @click=${this.emitClose}
              >
                ${icons.x}
              </button>
            </div>
          </header>
          <div class="stage" @dblclick=${this.handleDoubleClick}>
            <img
              class=${this.scale > 1 ? "image zoomed" : "image"}
              src=${this.src}
              alt=${title}
              @load=${this.initializePanzoom}
              @dragstart=${(event: DragEvent) => event.preventDefault()}
            />
          </div>
          <div class="zoom-controls">
            <button
              class="action zoom-control"
              type="button"
              aria-label=${t("chat.imageLightbox.zoomOut")}
              ?disabled=${this.scale <= 1}
              @click=${this.zoomOut}
            >
              −
            </button>
            <button
              class="action zoom-control zoom-level"
              type="button"
              aria-label=${t("chat.imageLightbox.resetZoom")}
              ?disabled=${this.scale === 1}
              @click=${this.resetZoom}
            >
              ${Math.round(this.scale * 100)}%
            </button>
            <button
              class="action zoom-control"
              type="button"
              aria-label=${t("chat.imageLightbox.zoomIn")}
              ?disabled=${this.scale >= MAX_SCALE}
              @click=${this.zoomIn}
            >
              +
            </button>
          </div>
        </section>
      </openclaw-modal-dialog>
    `;
  }

  private initializePanzoom = () => {
    const image = this.image;
    const stage = this.stage;
    if (!image || !stage) {
      return;
    }
    this.destroyPanzoom();
    this.panzoom = Panzoom(image, {
      maxScale: MAX_SCALE,
      minScale: 1,
      panOnlyWhenZoomed: true,
    });
    image.addEventListener("panzoomchange", this.handlePanzoomChange);
    stage.addEventListener("wheel", this.handleWheel, { passive: false });
  };

  private destroyPanzoom() {
    this.image?.removeEventListener("panzoomchange", this.handlePanzoomChange);
    this.stage?.removeEventListener("wheel", this.handleWheel);
    this.panzoom?.destroy();
    this.panzoom?.resetStyle();
    this.panzoom = undefined;
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
    event.preventDefault();
    this.panzoom?.zoomWithWheel(event);
  };

  private handleDoubleClick = (event: MouseEvent) => {
    event.preventDefault();
    if (this.scale > 1) {
      this.resetZoom();
      return;
    }
    this.panzoom?.zoomToPoint(DOUBLE_TAP_SCALE, event);
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
    if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      this.zoomIn();
      return;
    }
    if (event.key === "-") {
      event.preventDefault();
      this.zoomOut();
      return;
    }
    if (event.key === "0") {
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
