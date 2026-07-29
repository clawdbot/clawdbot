import { html, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { ref } from "lit/directives/ref.js";
import { styleMap } from "lit/directives/style-map.js";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import { OpenClawLightDomContentsElement } from "../../../lit/openclaw-element.ts";
import { safeAttachmentHref } from "./chat-attachment-href.ts";
import {
  canResumeChatAudioPlayback,
  claimChatAudioPlayback,
  releaseChatAudioPlayback,
} from "./chat-audio-coordinator.ts";
import { ChatMediaSourceController } from "./chat-media-source.ts";

const SEEK_STEP_SECONDS = 5;

function formatChatMediaTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return "0:00";
  }
  const wholeSeconds = Math.floor(seconds);
  const minutes = Math.floor(wholeSeconds / 60);
  const remainder = wholeSeconds % 60;
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}

class ChatAudioPlayer extends OpenClawLightDomContentsElement {
  @property() src = "";
  @property() sourceIdentity = "";
  @property() label = "";
  @property({ type: Boolean }) voiceNote = false;
  @property({ attribute: false }) onMediaLoaded: (() => void) | undefined;

  @state() private currentTime = 0;
  @state() private duration = 0;
  @state() private buffered = 0;
  @state() private playing = false;
  @state() private failed = false;

  private media: HTMLAudioElement | null = null;
  private readonly sourceController = new ChatMediaSourceController();
  private readonly cancelPendingResume = () => this.sourceController.cancelPendingResume();

  override disconnectedCallback(): void {
    if (this.media) {
      this.sourceController.cancelPendingResume();
      if (!this.media.paused) {
        this.media.pause();
      }
      releaseChatAudioPlayback(this.media);
    }
    super.disconnectedCallback();
  }

  override updated(changedProperties: PropertyValues<this>): void {
    if (changedProperties.has("src")) {
      this.failed = false;
    }
    if (this.media) {
      this.sourceController.updateSource(this.media, this.src, this.sourceIdentity);
    }
  }

  private setMedia = (element: Element | undefined) => {
    this.media = element instanceof HTMLAudioElement ? element : null;
  };

  private togglePlayback(): void {
    const media = this.media;
    if (!media) {
      return;
    }
    if (media.paused) {
      claimChatAudioPlayback(media, this.cancelPendingResume);
      void media.play().catch(() => {
        releaseChatAudioPlayback(media);
        this.playing = false;
      });
    } else {
      media.pause();
    }
  }

  private seekTo(nextTime: number): void {
    const media = this.media;
    if (!media) {
      return;
    }
    if (this.sourceController.seek(media, Math.min(nextTime, this.duration || nextTime))) {
      this.currentTime = media.currentTime;
    }
  }

  private handlePlayerKeydown(event: KeyboardEvent): void {
    if (event.target !== event.currentTarget) {
      return;
    }
    if (event.key === " ") {
      event.preventDefault();
      this.togglePlayback();
      return;
    }
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      const direction = event.key === "ArrowLeft" ? -1 : 1;
      this.seekTo(this.currentTime + direction * SEEK_STEP_SECONDS);
    }
  }

  private updateBuffered(): void {
    const media = this.media;
    if (!media || !this.duration || media.buffered.length === 0) {
      this.buffered = 0;
      return;
    }
    this.buffered = Math.min(1, media.buffered.end(media.buffered.length - 1) / this.duration);
  }

  override render() {
    const progress = this.duration > 0 ? Math.min(1, this.currentTime / this.duration) : 0;
    const downloadHref = safeAttachmentHref(this.src);
    return html`
      <div class="chat-assistant-attachment-card chat-assistant-attachment-card--audio">
        <div class="chat-assistant-attachment-card__header">
          <span class="chat-assistant-attachment-card__title">${this.label}</span>
          <span class="chat-assistant-attachment-card__actions">
            ${this.voiceNote
              ? html`<span class="chat-assistant-attachment-badge"
                  >${t("chat.messages.voiceNote")}</span
                >`
              : null}
            ${downloadHref && !this.failed
              ? html`<!-- The download attribute is ignored for cross-origin URLs (rare here — attachment
                  hrefs are same-origin gateway routes); those open in a new tab instead. -->
                  <a
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
          </span>
        </div>
        ${this.failed
          ? html`<div class="chat-assistant-attachment-card__reason">
              ${t("chat.mediaPlayer.videoUnavailable")}
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
            </div> `
          : html`<div
              class="chat-audio-player"
              tabindex="0"
              @keydown=${(event: KeyboardEvent) => this.handlePlayerKeydown(event)}
            >
              <button
                type="button"
                class="chat-audio-player__toggle"
                aria-label=${t(this.playing ? "chat.mediaPlayer.pause" : "chat.mediaPlayer.play")}
                @click=${() => this.togglePlayback()}
              >
                ${this.playing ? icons.pause : icons.play}
              </button>
              <div class="chat-audio-player__timeline">
                <input
                  class="chat-audio-player__seek"
                  type="range"
                  min="0"
                  max=${String(this.duration || 0)}
                  step=${String(SEEK_STEP_SECONDS)}
                  .value=${String(Math.min(this.currentTime, this.duration || this.currentTime))}
                  aria-label=${t("chat.mediaPlayer.seek")}
                  style=${styleMap({
                    "--chat-audio-progress": `${progress * 100}%`,
                    "--chat-audio-buffered": `${Math.max(progress, this.buffered) * 100}%`,
                  })}
                  @input=${(event: Event) =>
                    this.seekTo(Number((event.currentTarget as HTMLInputElement).value))}
                />
                <div class="chat-audio-player__time" aria-live="off">
                  <span>${formatChatMediaTime(this.currentTime)}</span>
                  <span>${formatChatMediaTime(this.duration)}</span>
                </div>
              </div>
            </div>`}
        <audio
          class="chat-audio-player__media"
          preload="metadata"
          ${ref(this.setMedia)}
          @loadedmetadata=${() => {
            if (!this.media) {
              return;
            }
            this.sourceController.handleLoadedMetadata(this.media, () =>
              canResumeChatAudioPlayback(this.media!),
            );
            this.duration = Number.isFinite(this.media.duration) ? this.media.duration : 0;
            this.currentTime = this.media.currentTime;
            this.failed = false;
            this.updateBuffered();
            this.onMediaLoaded?.();
          }}
          @durationchange=${() => {
            if (this.media) {
              this.duration = Number.isFinite(this.media.duration) ? this.media.duration : 0;
            }
          }}
          @timeupdate=${() => {
            if (this.media) {
              this.currentTime = this.media.currentTime;
              this.updateBuffered();
            }
          }}
          @progress=${() => this.updateBuffered()}
          @play=${() => {
            if (this.media) {
              claimChatAudioPlayback(this.media, this.cancelPendingResume);
            }
            this.playing = true;
          }}
          @pause=${() => {
            this.playing = false;
          }}
          @ended=${() => {
            if (this.media) {
              releaseChatAudioPlayback(this.media);
              this.sourceController.handleEnded(this.media);
            }
            this.playing = false;
          }}
          @error=${() => {
            if (this.media && !this.sourceController.handleError(this.media)) {
              releaseChatAudioPlayback(this.media);
              this.playing = false;
              this.failed = true;
            }
          }}
        ></audio>
      </div>
    `;
  }
}

if (!customElements.get("openclaw-chat-audio-player")) {
  customElements.define("openclaw-chat-audio-player", ChatAudioPlayer);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-chat-audio-player": ChatAudioPlayer;
  }
}
