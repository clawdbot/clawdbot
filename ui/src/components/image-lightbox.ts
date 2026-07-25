import { css, html, nothing, type PropertyValues } from "lit";
import { property, query, state } from "lit/decorators.js";
import { t } from "../i18n/index.ts";
import { OpenClawLitElement } from "../lit/openclaw-element.ts";
import { icons } from "./icons.ts";
import "./modal-dialog.ts";

export type ImageLightboxItem = {
  src: string;
  title: string;
  release?: () => void;
};

const SAFE_DATA_IMAGE_BLOB_TYPES = new Set([
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

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
  @query(".open-original") private openOriginal?: HTMLAnchorElement;
  @query(".close") private closeButton?: HTMLButtonElement;
  @state() private openOriginalUrl = "";

  private originalBlobUrl = "";
  private originalUrlRequest = 0;

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
      width: min(1280px, calc(100vw - 40px));
      height: min(900px, calc(100dvh - 40px));
      display: grid;
      grid-template-rows: auto minmax(0, 1fr);
      overflow: hidden;
      border: 1px solid color-mix(in srgb, var(--border-strong) 80%, transparent);
      border-radius: var(--radius-lg);
      background: #07090f;
      box-shadow: 0 28px 90px rgba(0, 0, 0, 0.6);
    }

    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      min-height: 54px;
      padding: 10px 12px 10px 18px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.1);
      background: rgba(255, 255, 255, 0.04);
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

    .actions {
      display: inline-flex;
      align-items: center;
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
    }

    .stage {
      min-height: 0;
      display: grid;
      place-items: center;
      padding: 20px;
      overflow: hidden;
    }

    .image {
      display: block;
      max-width: 100%;
      max-height: 100%;
      width: auto;
      height: auto;
      border-radius: var(--radius-md);
      background: rgba(255, 255, 255, 0.04);
      object-fit: contain;
    }

    @media (max-width: 720px), (max-height: 520px) and (orientation: landscape) {
      openclaw-modal-dialog {
        --openclaw-modal-width: calc(100vw - 24px);
        --openclaw-modal-max-width: calc(100vw - 24px);
        --openclaw-modal-max-height: 100dvh;
      }

      .lightbox {
        width: calc(100vw - 24px);
        height: 90dvh;
        border: 0;
        border-radius: 0;
      }

      .header {
        padding-top: calc(10px + env(safe-area-inset-top));
        padding-right: calc(12px + env(safe-area-inset-right));
        padding-left: calc(16px + env(safe-area-inset-left));
      }

      .stage {
        padding-right: calc(12px + env(safe-area-inset-right));
        padding-bottom: calc(12px + env(safe-area-inset-bottom));
        padding-left: calc(12px + env(safe-area-inset-left));
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
    this.revokeOriginalBlobUrl();
    super.disconnectedCallback();
  }

  protected override updated(changed: PropertyValues<this>) {
    if (changed.has("src")) {
      void this.resolveOriginalUrl();
    }
  }

  override render() {
    const title = this.title.trim() || t("chat.imageLightbox.untitled");
    return html`
      <openclaw-modal-dialog
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
          <div class="stage">
            <img class="image" src=${this.src} alt=${title} />
          </div>
        </section>
      </openclaw-modal-dialog>
    `;
  }

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
    if (source.slice(0, 5).toLowerCase() !== "data:") {
      this.openOriginalUrl = source;
      return;
    }
    this.openOriginalUrl = "";
    const sourceType = dataUrlMimeType(source);
    // Top-level blob documents inherit the app origin. Only inert raster formats
    // may be promoted from opaque-origin data URLs into an original-image link.
    if (!sourceType || !SAFE_DATA_IMAGE_BLOB_TYPES.has(sourceType)) {
      return;
    }
    try {
      const response = await fetch(source);
      const blob = await response.blob();
      if (
        !this.isConnected ||
        request !== this.originalUrlRequest ||
        !SAFE_DATA_IMAGE_BLOB_TYPES.has(mimeTypeEssence(blob.type))
      ) {
        return;
      }
      this.originalBlobUrl = URL.createObjectURL(blob);
      this.openOriginalUrl = this.originalBlobUrl;
    } catch {
      // The image remains viewable inline; omit an unusable original-link action.
    }
  }

  private handleKeydown = (event: KeyboardEvent) => {
    const closeButton = this.closeButton;
    if (event.key !== "Tab" || !closeButton) {
      return;
    }
    const openOriginal = this.openOriginal;
    const source = event.composedPath()[0];
    if (!openOriginal) {
      if (source === closeButton) {
        event.preventDefault();
        closeButton.focus();
      }
      return;
    }
    if (event.shiftKey && source === openOriginal) {
      event.preventDefault();
      closeButton.focus();
    } else if (!event.shiftKey && source === closeButton) {
      event.preventDefault();
      openOriginal.focus();
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
