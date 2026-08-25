import { html } from "lit";
import { property, state } from "lit/decorators.js";
import { ref } from "lit/directives/ref.js";
import { OpenClawLightDomContentsElement } from "../../../lit/openclaw-element.ts";
import { observeChatAttachmentViewport } from "./chat-attachment-viewport.ts";
import {
  loadDocumentFramePreview,
  renderAttachmentDocumentPreview,
  resolveDocumentFramePreviewState,
  resolveDocumentPreviewText,
  type AttachmentDocumentPreviewKind,
} from "./chat-message-document-preview.ts";
import {
  observeChatMediaResourceSubscriber,
  releaseChatMediaResourceSubscriber,
  type AttachmentItem,
} from "./chat-message-media.ts";

class ChatDocumentPreview extends OpenClawLightDomContentsElement {
  @property({ attribute: false }) attachment!: AttachmentItem["attachment"];
  @property() attachmentUrl = "";
  @property() previewKind: Exclude<AttachmentDocumentPreviewKind, null> = "html";
  @property({ type: Number }) sizeBytes: number | undefined;
  @property({ attribute: false }) onRequestUpdate: (() => void) | undefined;

  @state() private active = false;

  private viewportElement: HTMLElement | null = null;
  private stopObservingViewport: (() => void) | undefined;

  override disconnectedCallback(): void {
    this.stopObservingViewport?.();
    this.stopObservingViewport = undefined;
    this.viewportElement = null;
    releaseChatMediaResourceSubscriber(this.requestPreviewUpdate);
    super.disconnectedCallback();
  }

  private requestPreviewUpdate = () => {
    this.requestUpdate();
    this.onRequestUpdate?.();
  };

  private activate(): void {
    if (this.active) {
      return;
    }
    this.active = true;
    if (this.previewKind === "table") {
      resolveDocumentPreviewText(
        this.attachmentUrl,
        this.attachment.url,
        this.sizeBytes,
        this.requestPreviewUpdate,
      );
      return;
    }
    loadDocumentFramePreview(
      this.attachmentUrl,
      this.attachment.url,
      this.requestPreviewUpdate,
      this.previewKind === "html",
      this.sizeBytes,
    );
  }

  private setViewportElement = (element: Element | undefined) => {
    const viewportElement = element instanceof HTMLElement ? element : null;
    if (this.viewportElement === viewportElement) {
      return;
    }
    this.stopObservingViewport?.();
    this.stopObservingViewport = undefined;
    this.viewportElement = viewportElement;
    if (!viewportElement) {
      return;
    }
    this.stopObservingViewport = observeChatAttachmentViewport(viewportElement, () =>
      this.activate(),
    );
  };

  override render() {
    if (this.onRequestUpdate) {
      observeChatMediaResourceSubscriber(this.onRequestUpdate, this.requestPreviewUpdate);
    }
    const previewText =
      this.active && this.previewKind === "table"
        ? resolveDocumentPreviewText(
            this.attachmentUrl,
            this.attachment.url,
            this.sizeBytes,
            this.requestPreviewUpdate,
          )
        : undefined;
    const frameState =
      this.active && this.previewKind !== "table"
        ? resolveDocumentFramePreviewState(
            this.attachmentUrl,
            this.attachment.url,
            this.requestPreviewUpdate,
            this.previewKind === "html",
            this.sizeBytes,
          )
        : undefined;
    return html`<div class="chat-document-preview" ${ref(this.setViewportElement)}>
      ${renderAttachmentDocumentPreview(this.previewKind, this.attachment, previewText, frameState)}
    </div>`;
  }
}

if (!customElements.get("openclaw-chat-document-preview")) {
  customElements.define("openclaw-chat-document-preview", ChatDocumentPreview);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-chat-document-preview": ChatDocumentPreview;
  }
}
