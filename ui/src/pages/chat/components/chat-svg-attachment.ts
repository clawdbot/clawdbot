import { html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { t } from "../../../i18n/index.ts";
import { OpenClawLightDomContentsElement } from "../../../lit/openclaw-element.ts";
import { openAttachmentCardFromClick, renderAttachmentCardHeader } from "./chat-attachment-card.ts";

class ChatSvgAttachment extends OpenClawLightDomContentsElement {
  @property() src = "";
  @property() sourceIdentity = "";
  @property() label = "";
  @property() mimeType = "image/svg+xml";
  @property({ type: Number }) sizeBytes: number | undefined;
  @property() downloadHref = "";
  @property({ attribute: false }) onOpen: ((src: string) => void) | undefined;
  @property({ attribute: false }) onExpand: (() => void) | undefined;

  @state() private blobUrl: string | undefined;
  @state() private failed = false;

  private loadVersion = 0;
  private abortController: AbortController | undefined;

  override disconnectedCallback(): void {
    this.releaseSource();
    super.disconnectedCallback();
  }

  override updated(changedProperties: PropertyValues<this>): void {
    if (changedProperties.has("src") || changedProperties.has("sourceIdentity")) {
      void this.loadSource();
    }
  }

  private releaseSource(): void {
    this.loadVersion += 1;
    this.abortController?.abort();
    this.abortController = undefined;
    if (this.blobUrl) {
      URL.revokeObjectURL(this.blobUrl);
      this.blobUrl = undefined;
    }
  }

  private async loadSource(): Promise<void> {
    this.releaseSource();
    const version = this.loadVersion;
    this.failed = false;
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
      const sourceBlob = await response.blob();
      const svgBlob =
        sourceBlob.type === "image/svg+xml"
          ? sourceBlob
          : new Blob([sourceBlob], { type: "image/svg+xml" });
      const blobUrl = URL.createObjectURL(svgBlob);
      if (version !== this.loadVersion || !this.isConnected) {
        URL.revokeObjectURL(blobUrl);
        return;
      }
      this.blobUrl = blobUrl;
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
    if (this.blobUrl) {
      URL.revokeObjectURL(this.blobUrl);
      this.blobUrl = undefined;
    }
    this.failed = true;
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
          showExpandAction: true,
          onExpand: this.onExpand,
          visualMode: "large-placeholder",
        })}
      </div>`;
    }
    if (!this.blobUrl) {
      return nothing;
    }
    return html`<button
      type="button"
      class="chat-message-image-button"
      aria-label=${t("chat.imageLightbox.open", { title: this.label })}
      @click=${() => this.onOpen?.(this.blobUrl!)}
    >
      <img
        src=${this.blobUrl}
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
