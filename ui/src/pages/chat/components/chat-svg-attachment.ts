import { html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { t } from "../../../i18n/index.ts";
import { OpenClawLightDomContentsElement } from "../../../lit/openclaw-element.ts";
import { openAttachmentCardFromClick, renderAttachmentCardHeader } from "./chat-attachment-card.ts";
import { observeChatAttachmentViewport } from "./chat-attachment-viewport.ts";
import { readResponseBytesWithinLimit } from "./chat-response-bytes.ts";

const SVG_PREVIEW_MAX_BYTES = 256 * 1024;
const SVG_PREVIEW_FETCH_TIMEOUT_MS = 10_000;

type SvgRenderSource = {
  url: string;
  retainCount: number;
  retired: boolean;
  revokeOnRetire: boolean;
};

function isCrossOriginHttpSource(source: string): boolean {
  try {
    const url = new URL(source, window.location.href);
    return (
      (url.protocol === "http:" || url.protocol === "https:") && url.origin !== location.origin
    );
  } catch {
    return false;
  }
}

class ChatSvgAttachment extends OpenClawLightDomContentsElement {
  @property() src = "";
  @property() sourceIdentity = "";
  @property() label = "";
  @property() mimeType = "image/svg+xml";
  @property({ type: Number }) sizeBytes: number | undefined;
  @property() downloadHref = "";
  @property({ attribute: false }) onOpen: ((src: string, release: () => void) => void) | undefined;
  @property({ attribute: false }) onExpand: (() => void) | undefined;
  @property({ attribute: false }) onMediaLoaded: (() => void) | undefined;

  @state() private renderSource: SvgRenderSource | undefined;
  @state() private failed = false;

  private loadVersion = 0;
  private abortController: AbortController | undefined;
  private stopObservingViewport: (() => void) | undefined;

  override connectedCallback(): void {
    super.connectedCallback();
    if (this.src.trim() && !this.renderSource && !this.failed) {
      this.observeViewport();
    }
  }

  override disconnectedCallback(): void {
    this.stopObservingViewport?.();
    this.stopObservingViewport = undefined;
    this.releaseSource();
    super.disconnectedCallback();
  }

  override updated(changedProperties: PropertyValues<this>): void {
    if (
      changedProperties.has("src") ||
      changedProperties.has("sourceIdentity") ||
      changedProperties.has("sizeBytes")
    ) {
      this.releaseSource();
      this.failed = false;
      this.observeViewport();
    }
  }

  private observeViewport(): void {
    this.stopObservingViewport?.();
    const target = this.parentElement ?? this;
    this.stopObservingViewport = observeChatAttachmentViewport(target, () => {
      this.stopObservingViewport = undefined;
      void this.loadSource();
    });
  }

  private retireSource(source: SvgRenderSource): void {
    source.retired = true;
    if (source.revokeOnRetire && source.retainCount === 0) {
      URL.revokeObjectURL(source.url);
    }
  }

  private releaseSource(): void {
    this.loadVersion += 1;
    this.abortController?.abort();
    this.abortController = undefined;
    if (this.renderSource) {
      this.retireSource(this.renderSource);
      this.renderSource = undefined;
    }
  }

  private retainSource(source: SvgRenderSource): () => void {
    source.retainCount += 1;
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      source.retainCount = Math.max(0, source.retainCount - 1);
      if (source.revokeOnRetire && source.retired && source.retainCount === 0) {
        URL.revokeObjectURL(source.url);
      }
    };
  }

  private showFallback(): void {
    if (this.failed) {
      return;
    }
    this.failed = true;
    this.onMediaLoaded?.();
  }

  private async loadSource(): Promise<void> {
    const version = this.loadVersion;
    if (this.sizeBytes !== undefined && this.sizeBytes > SVG_PREVIEW_MAX_BYTES) {
      this.showFallback();
      return;
    }
    // Remote SVGs render safely in img without CORS, while fetching their bytes would
    // reject common CDN sources before the browser gets a chance to display them.
    if (isCrossOriginHttpSource(this.src)) {
      this.renderSource = {
        url: this.src,
        retainCount: 0,
        retired: false,
        revokeOnRetire: false,
      };
      return;
    }
    const controller = new AbortController();
    this.abortController = controller;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const response = await Promise.race([
        fetch(this.src, {
          credentials: "same-origin",
          headers: { Accept: "image/svg+xml" },
          method: "GET",
          signal: controller.signal,
        }),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            controller.abort();
            reject(new DOMException("SVG attachment fetch timed out", "TimeoutError"));
          }, SVG_PREVIEW_FETCH_TIMEOUT_MS);
        }),
      ]);
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error("SVG attachment is unavailable");
      }
      const bytes = await readResponseBytesWithinLimit(response, SVG_PREVIEW_MAX_BYTES);
      if (!bytes) {
        throw new Error("SVG attachment exceeds the preview budget");
      }
      const blobUrl = URL.createObjectURL(new Blob([bytes], { type: "image/svg+xml" }));
      if (version !== this.loadVersion || !this.isConnected) {
        URL.revokeObjectURL(blobUrl);
        return;
      }
      this.renderSource = {
        url: blobUrl,
        retainCount: 0,
        retired: false,
        revokeOnRetire: true,
      };
    } catch {
      if (version === this.loadVersion) {
        this.showFallback();
      }
    } finally {
      clearTimeout(timeout);
      if (this.abortController === controller) {
        this.abortController = undefined;
      }
    }
  }

  private handleImageError = () => {
    if (this.renderSource) {
      this.retireSource(this.renderSource);
      this.renderSource = undefined;
    }
    this.showFallback();
  };

  private handleOpen = (): void => {
    const source = this.renderSource;
    if (!source || !this.onOpen) {
      return;
    }
    const release = this.retainSource(source);
    try {
      this.onOpen(source.url, release);
    } catch (error) {
      release();
      throw error;
    }
  };

  override render() {
    if (this.failed) {
      return html`<div
        class="chat-assistant-attachment-card chat-assistant-attachment-card--compact"
        ?data-openable=${Boolean(this.onExpand)}
        @click=${(event: MouseEvent) => openAttachmentCardFromClick(event, this.onExpand)}
      >
        ${renderAttachmentCardHeader({
          kind: "document",
          label: this.label,
          mimeType: this.mimeType,
          sizeBytes: this.sizeBytes,
          downloadHref: this.downloadHref,
          onExpand: this.onExpand,
          visualMode: "large-placeholder",
        })}
      </div>`;
    }
    const renderSource = this.renderSource;
    if (!renderSource) {
      return nothing;
    }
    return html`<button
      type="button"
      class="chat-message-image-button"
      aria-label=${t("chat.imageLightbox.open", { title: this.label })}
      @click=${this.handleOpen}
    >
      <img
        src=${renderSource.url}
        alt=${this.label}
        class="chat-message-image"
        @load=${this.onMediaLoaded}
        @error=${this.handleImageError}
      />
    </button>`;
  }
}

if (!customElements.get("openclaw-chat-svg-attachment")) {
  customElements.define("openclaw-chat-svg-attachment", ChatSvgAttachment);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-chat-svg-attachment": ChatSvgAttachment;
  }
}
