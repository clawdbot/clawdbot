import { html, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { ref } from "lit/directives/ref.js";
import { styleMap } from "lit/directives/style-map.js";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import { OpenClawLightDomContentsElement } from "../../../lit/openclaw-element.ts";
import { safeAttachmentHref } from "./chat-attachment-href.ts";
import {
  appendChatMediaPlaybackParam,
  waitForChatMediaPlayback,
  type ChatMediaPlaybackMode,
} from "./chat-media-playback.ts";
import { ChatMediaSourceController } from "./chat-media-source.ts";

class ChatVideoPlayer extends OpenClawLightDomContentsElement {
  @property() src = "";
  @property() sourceIdentity = "";
  @property() label = "";
  @property() playback: ChatMediaPlaybackMode = "native";
  @property() authToken: string | null = null;
  @property({ type: Number }) mediaWidth: number | undefined;
  @property({ type: Number }) mediaHeight: number | undefined;
  @property({ attribute: false }) onMediaLoaded: (() => void) | undefined;

  @state() private metadataLoaded = false;
  @state() private failed = false;
  @state() private preparing = false;

  private media: HTMLVideoElement | null = null;
  private readonly sourceController = new ChatMediaSourceController();
  private currentSourceFailed = false;
  private readinessController: AbortController | null = null;
  private readinessKey = "";
  private readySource = "";

  override connectedCallback(): void {
    super.connectedCallback();
    queueMicrotask(() => this.syncSource());
  }

  override disconnectedCallback(): void {
    this.readinessController?.abort();
    this.readinessController = null;
    this.readinessKey = "";
    this.readySource = "";
    this.sourceController.cancelPendingResume();
    if (this.media) {
      if (!this.media.paused) {
        this.media.pause();
      }
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
        if (this.media && !this.media.paused) {
          this.media.pause();
        }
        if (this.media) {
          this.sourceController.reset(this.media);
          this.currentSourceFailed = false;
        }
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
    const source = this.src.trim();
    if (!media || !source || !this.sourceIdentity.trim() || !this.isConnected) {
      return;
    }
    const playbackSource =
      this.playback === "transcode" ? appendChatMediaPlaybackParam(source) : source;
    const hasCurrentAttachmentSource =
      this.sourceController.currentIdentity === this.sourceIdentity.trim();
    const hasUsableCurrentAttachmentSource =
      hasCurrentAttachmentSource && !this.currentSourceFailed;
    if (this.playback !== "transcode") {
      this.readinessController?.abort();
      this.readinessController = null;
      this.readinessKey = "";
      this.readySource = playbackSource;
      this.preparing = false;
      this.failed = false;
      this.currentSourceFailed = false;
      this.sourceController.updateSource(media, playbackSource, this.sourceIdentity);
      return;
    }

    const readinessKey = `${playbackSource}\0${this.authToken?.trim() ?? ""}`;
    if (!hasUsableCurrentAttachmentSource) {
      this.metadataLoaded = false;
      this.preparing = true;
    }
    if (readinessKey === this.readinessKey) {
      if (this.readySource === playbackSource) {
        this.sourceController.updateSource(media, playbackSource, this.sourceIdentity);
        return;
      }
      if (this.readinessController) {
        return;
      }
    }
    this.readinessController?.abort();
    const controller = new AbortController();
    this.readinessController = controller;
    this.readinessKey = readinessKey;
    this.readySource = "";
    this.preparing = !hasUsableCurrentAttachmentSource;
    this.failed = false;
    void waitForChatMediaPlayback({
      source: playbackSource,
      authToken: this.authToken,
      signal: controller.signal,
      onPreparing: () => {
        if (this.readinessController === controller && !hasUsableCurrentAttachmentSource) {
          this.preparing = true;
        }
      },
    }).then((result) => {
      if (this.readinessController !== controller || result === "aborted") {
        return;
      }
      this.preparing = false;
      if (result !== "ready") {
        if (hasUsableCurrentAttachmentSource) {
          this.readySource = this.sourceController.currentSource;
          return;
        }
        this.failed = true;
        return;
      }
      this.readySource = playbackSource;
      this.failed = false;
      this.currentSourceFailed = false;
      this.sourceController.updateSource(media, playbackSource, this.sourceIdentity);
    });
  }

  override render() {
    const downloadHref = safeAttachmentHref(this.src);
    const dimensions =
      this.mediaWidth && this.mediaHeight
        ? { "aspect-ratio": `${this.mediaWidth} / ${this.mediaHeight}` }
        : {};
    return html`
      <div
        class="chat-assistant-attachment-card chat-assistant-attachment-card--video"
        ?data-metadata-loaded=${this.metadataLoaded}
        ?data-unplayable=${this.failed}
      >
        <div class="chat-assistant-attachment-card__header">
          <span class="chat-assistant-attachment-card__title">${this.label}</span>
          ${downloadHref
            ? html`<a
                class="chat-assistant-attachment-card__download"
                href=${downloadHref}
                download=${this.label}
                target="_blank"
                rel="noreferrer"
                aria-label=${t("chat.mediaPlayer.download", { filename: this.label })}
                title=${t("chat.mediaPlayer.download", { filename: this.label })}
                >${icons.download}</a
              >`
            : null}
        </div>
        ${this.preparing
          ? html`<div class="chat-assistant-attachment-card__reason chat-media-preparing">
              ${t("chat.mediaPlayer.preparing")}
            </div>`
          : null}
        <div
          class="chat-assistant-video-frame"
          style=${styleMap(dimensions)}
          ?hidden=${this.preparing}
        >
          <span class="chat-assistant-video-frame__placeholder" aria-hidden="true"
            >${icons.monitor}</span
          >
          <video
            controls
            preload="metadata"
            ${ref(this.setMedia)}
            @loadedmetadata=${() => {
              if (!this.media) {
                return;
              }
              this.sourceController.handleLoadedMetadata(this.media);
              this.metadataLoaded = true;
              this.failed = false;
              this.currentSourceFailed = false;
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
                this.failed = false;
              }
            }}
            @error=${() => {
              if (this.media && !this.sourceController.handleError(this.media)) {
                this.failed = true;
                this.currentSourceFailed = true;
              }
            }}
          ></video>
        </div>
        <div class="chat-assistant-video-fallback">
          <div class="chat-assistant-attachment-card__reason">
            ${t("chat.mediaPlayer.videoUnavailable")}
          </div>
          ${downloadHref
            ? html`<a
                class="chat-assistant-attachment-card__link"
                href=${downloadHref}
                download=${this.label}
                target="_blank"
                rel="noreferrer"
                >${t("chat.mediaPlayer.download", { filename: this.label })}</a
              >`
            : null}
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
