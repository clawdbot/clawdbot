import { html, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { ref } from "lit/directives/ref.js";
import { styleMap } from "lit/directives/style-map.js";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import { OpenClawLightDomContentsElement } from "../../../lit/openclaw-element.ts";
import { safeAttachmentHref } from "./chat-attachment-href.ts";
import { renderAttachmentCardHeader } from "./chat-attachment-card.ts";
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

  @state() private metadataLoaded = false;

  private media: HTMLVideoElement | null = null;
  private readonly sourceController = new ChatMediaSourceController();

  override connectedCallback(): void {
    super.connectedCallback();
    queueMicrotask(() => this.syncSource());
  }

  override disconnectedCallback(): void {
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
      const authenticationChanged = changedProperties.has("authToken");
      if (
        authenticationChanged ||
        (changedProperties.has("sourceIdentity") &&
          this.sourceController.currentIdentity &&
          this.sourceController.currentIdentity !== this.sourceIdentity.trim())
      ) {
        this.metadataLoaded = false;
      }
      this.syncSource();
    }
  }

  private setMedia = (element: Element | undefined) => {
    this.media = element instanceof HTMLVideoElement ? element : null;
    this.syncSource();
  };

  private syncSource(): void {
    const media = this.media;
    if (!media || !this.isConnected) {
      return;
    }
    const pending = this.sourceController.sync(
      media,
      this.src,
      this.sourceIdentity,
      this.playback,
      this.authToken,
    );
    if (this.sourceController.readiness === "preparing") {
      this.metadataLoaded = false;
    }
    this.requestUpdate();
    void pending?.then(() => {
      if (this.isConnected) {
        this.requestUpdate();
      }
    });
  }

  override render() {
    const downloadHref = safeAttachmentHref(this.src);
    const preparing = this.sourceController.readiness === "preparing";
    const dimensions =
      this.mediaWidth && this.mediaHeight
        ? { "aspect-ratio": `${this.mediaWidth} / ${this.mediaHeight}` }
        : {};
    return html`
      <div
        class="chat-assistant-attachment-card chat-assistant-attachment-card--video"
        ?data-metadata-loaded=${this.metadataLoaded}
        ?data-unplayable=${this.sourceController.readiness === "unavailable"}
      >
        ${renderAttachmentCardHeader({
          kind: "video",
          label: this.label,
          mimeType: this.mimeType,
          sizeBytes: this.sizeBytes,
          downloadHref,
          showDownloadLabel: true,
          showExpandAction: true,
          onExpand: this.onExpand,
        })}
        ${preparing
          ? html`<div class="chat-assistant-attachment-card__reason chat-media-preparing">
              ${t("chat.mediaPlayer.preparing")}
            </div>`
          : null}
        <div class="chat-assistant-video-frame" style=${styleMap(dimensions)} ?hidden=${preparing}>
          <span class="chat-assistant-video-frame__placeholder" aria-hidden="true"
            >${icons.monitor}</span
          >
          <video
            controls
            preload="auto"
            ${ref(this.setMedia)}
            @loadedmetadata=${() => {
              if (!this.media) {
                return;
              }
              this.sourceController.handleLoadedMetadata(this.media);
              this.metadataLoaded = true;
              this.onMediaLoaded?.();
            }}
            @ended=${() => {
              if (this.media && this.sourceController.handleEnded(this.media)) {
                this.metadataLoaded = false;
              }
            }}
            @seeking=${() => {
              if (this.media?.error && this.sourceController.handleError(this.media)) {
                this.metadataLoaded = false;
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
