import { html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { t } from "../../../i18n/index.ts";
import { OpenClawLightDomContentsElement } from "../../../lit/openclaw-element.ts";
import { openAttachmentCardFromClick, renderAttachmentCardHeader } from "./chat-attachment-card.ts";
import { observeChatAttachmentViewport } from "./chat-attachment-viewport.ts";
import { readResponseBytesWithinLimit } from "./chat-response-bytes.ts";

const SVG_PREVIEW_MAX_BYTES = 256 * 1024;

type SvgBlobSource = {
  url: string;
  retainCount: number;
  retired: boolean;
};

class ChatSvgAttachment extends OpenClawLightDomContentsElement {
  @property() src = "";
  @property() sourceIdentity = "";
  @property() label = "";
  @property() mimeType = "image/svg+xml";
  @property({ type: Number }) sizeBytes: number | undefined;
  @property() downloadHref = "";
  @property({ attribute: false }) onOpen: ((src: string, release: () => void) => void) | undefined;
  @property({ attribute: false }) onExpand: (() => void) | undefined;

  @state() private blobSource: SvgBlobSource | undefined;
  @state() private failed = false;

  private loadVersion = 0;
  private abortController: AbortController | undefined;
  private stopObservingViewport: (() => void) | undefined;

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

  private retireBlobSource(source: SvgBlobSource): void {
    source.retired = true;
    if (source.retainCount === 0) {
      URL.revokeObjectURL(source.url);
    }
  }

  private releaseSource(): void {
    this.loadVersion += 1;
    this.abortController?.abort();
    this.abortController = undefined;
    if (this.blobSource) {
      this.retireBlobSource(this.blobSource);
      this.blobSource = undefined;
    }
  }

  private retainBlobSource(source: SvgBlobSource): () => void {
    source.retainCount += 1;
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      source.retainCount = Math.max(0, source.retainCount - 1);
      if (source.retired && source.retainCount === 0) {
        URL.revokeObjectURL(source.url);
      }
    };
  }

  private async loadSource(): Promise<void> {
    const version = this.loadVersion;
    if (this.sizeBytes !== undefined && this.sizeBytes > SVG_PREVIEW_MAX_BYTES) {
      this.failed = true;
      return;
    }
    const controller = new AbortController();
    this.abortController = controller;
    try {
      const response = await fetch(this.src, {
        credentials: "same-origin",
        headers: { Accept: "image/svg+xml" },
        method: "GET",
        signal: controller.signal,
      });
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
      this.blobSource = { url: blobUrl, retainCount: 0, retired: false };
    } catch {
      if (version === this.loadVersion && !controller.signal.aborted) {
        this.failed = true;
      }
    } finally {
      if (this.abortController === controller) {
        this.abortController = undefined;
      }
    }
  }

  private handleImageError = () => {
    if (this.blobSource) {
      this.retireBlobSource(this.blobSource);
      this.blobSource = undefined;
    }
    this.failed = true;
  };

  private handleOpen = (): void => {
    const source = this.blobSource;
    if (!source || !this.onOpen) {
      return;
    }
    const release = this.retainBlobSource(source);
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
        class="chat-assistant-attachment-card chat-assistant-attachment-card--document chat-assistant-attachment-card--compact"
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
    const blobSource = this.blobSource;
    if (!blobSource) {
      return nothing;
    }
    return html`<button
      type="button"
      class="chat-message-image-button"
      aria-label=${t("chat.imageLightbox.open", { title: this.label })}
      @click=${this.handleOpen}
    >
      <img
        src=${blobSource.url}
        alt=${this.label}
        class="chat-message-image"
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
