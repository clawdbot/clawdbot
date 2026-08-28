import { html, type PropertyValues } from "lit";
import { property } from "lit/decorators.js";
import { ref } from "lit/directives/ref.js";
import { styleMap } from "lit/directives/style-map.js";
import { t } from "../../../i18n/index.ts";
import { OpenClawLightDomContentsElement } from "../../../lit/openclaw-element.ts";
import { openAttachmentCardFromClick, renderAttachmentCardHeader } from "./chat-attachment-card.ts";
import { safeAttachmentHref } from "./chat-attachment-href.ts";
import { observeChatAttachmentViewport } from "./chat-attachment-viewport.ts";
import type { ChatMediaPlaybackMode } from "./chat-media-playback.ts";
import { ChatMediaSourceController } from "./chat-media-source.ts";

class ChatVideoPlayer extends OpenClawLightDomContentsElement {
  @property() src = "";
  @property() sourceIdentity = "";
  @property() label = "";
  @property() mimeType = "";
  @property() playback: ChatMediaPlaybackMode = "native";
  @property() authToken: string | null = null;
  @property({ type: Number }) sizeBytes: number | undefined;
  @property({ type: Number }) mediaWidth: number | undefined;
  @property({ type: Number }) mediaHeight: number | undefined;
  @property({ attribute: false }) onExpand: (() => void) | undefined;
  @property({ attribute: false }) onMediaLoaded: (() => void) | undefined;

  private media: HTMLVideoElement | null = null;
  private mediaVisible = false;
  private viewportElement: HTMLElement | null = null;
  private stopObservingViewport: (() => void) | undefined;
  private readonly sourceController = new ChatMediaSourceController();

  override connectedCallback(): void {
    super.connectedCallback();
    queueMicrotask(() => this.syncSource());
  }

  override disconnectedCallback(): void {
    this.stopObservingViewport?.();
    this.stopObservingViewport = undefined;
    this.viewportElement = null;
    this.sourceController.cancel();
    if (this.media) {
      this.sourceController.reset(this.media);
    }
    super.disconnectedCallback();
  }

  override updated(changedProperties: PropertyValues<this>): void {
    if (
      changedProperties.has("src") ||
      changedProperties.has("sourceIdentity") ||
      changedProperties.has("playback") ||
      changedProperties.has("authToken")
    ) {
      this.syncSource();
    }
  }

  private setMedia = (element: Element | undefined) => {
    this.media = element instanceof HTMLVideoElement ? element : null;
    this.syncSource();
  };

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
    this.stopObservingViewport = observeChatAttachmentViewport(viewportElement, () => {
      this.mediaVisible = true;
      this.syncSource();
    });
  };

  private syncSource(): void {
    const media = this.media;
    if (!media || !this.isConnected || !this.mediaVisible) {
      return;
    }
    const pending = this.sourceController.sync(
      media,
      this.src,
      this.sourceIdentity,
      this.playback,
      this.authToken,
    );
    this.requestUpdate();
    void pending?.then(() => {
      if (this.isConnected) {
        this.requestUpdate();
      }
    });
  }

  private adoptPendingSource(): boolean {
    if (!this.media || !this.sourceController.applyPendingSource(this.media)) {
      return false;
    }
    this.requestUpdate();
    return true;
  }

  override render() {
    const downloadHref = safeAttachmentHref(this.src);
    const preparing = this.sourceController.readiness === "preparing";
    const unavailable = this.sourceController.readiness === "unavailable";
    const dimensions =
      this.mediaWidth && this.mediaHeight
        ? { "aspect-ratio": `${this.mediaWidth} / ${this.mediaHeight}` }
        : {};
    return html`
      <div
        class="chat-assistant-attachment-card chat-assistant-attachment-card--video"
        ${ref(this.setViewportElement)}
        ?data-unplayable=${this.sourceController.readiness === "unavailable"}
        ?data-openable=${Boolean(this.onExpand)}
        @click=${(event: MouseEvent) => openAttachmentCardFromClick(event, this.onExpand)}
      >
        ${renderAttachmentCardHeader({
          kind: "video",
          label: this.label,
          mimeType: this.mimeType,
          sizeBytes: this.sizeBytes,
          downloadHref,
          onExpand: this.onExpand,
          visualMode: unavailable ? "large-placeholder" : "preview-with-favicon",
        })}
        ${preparing
          ? html`<div class="chat-assistant-attachment-card__reason chat-media-preparing">
              ${t("chat.mediaPlayer.preparing")}
            </div>`
          : null}
        <div class="chat-assistant-video-frame" ?hidden=${preparing}>
          <video
            controls
            preload="metadata"
            style=${styleMap(dimensions)}
            ${ref(this.setMedia)}
            @loadedmetadata=${() => {
              if (!this.media) {
                return;
              }
              this.sourceController.handleLoadedMetadata(this.media);
              this.onMediaLoaded?.();
            }}
            @ended=${() => {
              if (this.media && this.sourceController.handleEnded(this.media)) {
                this.requestUpdate();
              }
            }}
            @play=${() => this.adoptPendingSource()}
            @seeking=${() => {
              if (
                !this.adoptPendingSource() &&
                this.media?.error &&
                this.sourceController.handleError(this.media)
              ) {
                this.requestUpdate();
              }
            }}
            @error=${() => {
              if (this.media) {
                this.sourceController.handleError(this.media);
                this.requestUpdate();
              }
            }}
          ></video>
        </div>
        <div class="chat-assistant-video-fallback">
          <div class="chat-assistant-attachment-card__reason">
            ${t("chat.mediaPlayer.videoUnavailable")}
          </div>
        </div>
      </div>
    `;
  }
}

if (!customElements.get("openclaw-chat-video-player")) {
  customElements.define("openclaw-chat-video-player", ChatVideoPlayer);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-chat-video-player": ChatVideoPlayer;
  }
}
