import { html, svg, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { ref } from "lit/directives/ref.js";
import { styleMap } from "lit/directives/style-map.js";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import { OpenClawLightDomContentsElement } from "../../../lit/openclaw-element.ts";
import { safeAttachmentHref } from "./chat-attachment-href.ts";
import { renderAttachmentCardHeader } from "./chat-attachment-card.ts";
import {
  canResumeChatAudioPlayback,
  claimChatAudioPlayback,
  releaseChatAudioPlayback,
} from "./chat-audio-coordinator.ts";
import {
  cacheAndRetainChatAudioBlob,
  canDecodeChatAudioWaveform,
  CHAT_AUDIO_WAVEFORM_MAX_BYTES,
  CHAT_AUDIO_WAVEFORM_SAMPLE_RATE,
  computeChatAudioWaveformPeaks,
  retainCachedChatAudioBlob,
  shouldFetchChatAudioWaveform,
  type CachedChatAudioBlob,
} from "./chat-audio-waveform.ts";
import { buildChatMediaFetchHeaders, type ChatMediaPlaybackMode } from "./chat-media-playback.ts";
import { ChatMediaSourceController } from "./chat-media-source.ts";

const SEEK_STEP_SECONDS = 5;
const WAVEFORM_FETCH_TIMEOUT_MS = 30_000;
const WAVEFORM_DECODE_DURATION_TOLERANCE = 1.2;

async function readResponseBytesWithinLimit(
  response: Response,
  maxBytes: number,
): Promise<ArrayBuffer | null> {
  const contentLengthHeader = response.headers.get("Content-Length");
  const contentLength = contentLengthHeader === null ? undefined : Number(contentLengthHeader);
  if (contentLength !== undefined && Number.isFinite(contentLength) && contentLength > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!response.body) {
    const bytes = await response.arrayBuffer();
    return bytes.byteLength <= maxBytes ? bytes : null;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined.buffer;
}

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
  @property() mimeType = "";
  @property() playback: ChatMediaPlaybackMode = "native";
  @property() authToken: string | null = null;
  @property({ type: Number }) sizeBytes: number | undefined;
  @property({ type: Number }) serverDurationMs: number | undefined;
  @property({ type: Boolean }) voiceNote = false;
  @property({ attribute: false }) onMediaLoaded: (() => void) | undefined;

  @state() private currentTime = 0;
  @state() private duration = 0;
  @state() private buffered = 0;
  @state() private playing = false;
  @state() private volume = 1;
  @state() private waveformPeaks: readonly number[] | null = null;

  private media: HTMLAudioElement | null = null;
  private readonly sourceController = new ChatMediaSourceController();
  private readonly cancelPendingResume = () => this.sourceController.cancelPendingResume();
  private playRequest: Promise<void> | null = null;
  private releaseWaveformBlob: (() => void) | undefined;
  private waveformController: AbortController | null = null;
  private waveformAttempted = false;

  override connectedCallback(): void {
    super.connectedCallback();
    queueMicrotask(() => this.syncSource());
  }

  override disconnectedCallback(): void {
    this.sourceController.cancel();
    this.releaseWaveformBlob?.();
    this.releaseWaveformBlob = undefined;
    this.waveformController?.abort();
    this.waveformController = null;
    this.waveformAttempted = false;
    if (this.media) {
      if (!this.media.paused) {
        this.media.pause();
      }
      releaseChatAudioPlayback(this.media);
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
      const sourceIdentityChanged =
        changedProperties.has("sourceIdentity") &&
        Boolean(this.sourceController.currentIdentity) &&
        this.sourceController.currentIdentity !== this.sourceIdentity.trim();
      if (
        sourceIdentityChanged ||
        changedProperties.has("playback") ||
        changedProperties.has("authToken")
      ) {
        this.waveformController?.abort();
        this.waveformController = null;
        this.releaseWaveformBlob?.();
        this.releaseWaveformBlob = undefined;
        this.waveformPeaks = null;
        this.waveformAttempted = false;
        this.currentTime = 0;
        this.duration = 0;
        this.buffered = 0;
        if (this.media && !this.media.paused) {
          this.media.pause();
          releaseChatAudioPlayback(this.media);
        }
      }
      this.syncSource();
    }
  }

  private setMedia = (element: Element | undefined) => {
    this.media = element instanceof HTMLAudioElement ? element : null;
    if (this.media) {
      this.media.volume = this.volume;
    }
    this.syncSource();
  };

  private syncSource(): void {
    const media = this.media;
    if (!media || !this.isConnected) {
      return;
    }
    if (this.releaseWaveformBlob) {
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

  private resolveWaveformCacheKey(): string {
    return [
      this.sourceIdentity.trim(),
      this.playback,
      this.src.trim(),
      this.authToken?.trim() ?? "",
    ].join("\0");
  }

  private applyPreparedAudio(
    cacheKey: string,
    prepared: { value: CachedChatAudioBlob; release: () => void },
  ): void {
    const media = this.media;
    if (!media || cacheKey !== this.resolveWaveformCacheKey()) {
      prepared.release();
      return;
    }
    this.releaseWaveformBlob?.();
    this.releaseWaveformBlob = prepared.release;
    this.waveformPeaks = prepared.value.peaks ?? null;
    if (prepared.value.durationSeconds !== undefined) {
      this.duration = prepared.value.durationSeconds;
    }
    this.sourceController.updateSource(media, prepared.value.blobUrl, this.sourceIdentity);
  }

  private adoptPreparedAudioForPlayback(): void {
    const media = this.media;
    if (!media) {
      return;
    }
    if (!this.releaseWaveformBlob) {
      const cached = retainCachedChatAudioBlob(this.resolveWaveformCacheKey());
      if (cached) {
        this.applyPreparedAudio(this.resolveWaveformCacheKey(), cached);
      }
    }
    this.sourceController.applyPendingSource(media);
  }

  private async prepareWaveformAudio(): Promise<void> {
    const media = this.media;
    const source = this.sourceController.readySource;
    if (!media || !source || this.releaseWaveformBlob || this.waveformAttempted) {
      return;
    }
    const cacheKey = this.resolveWaveformCacheKey();
    const cached = retainCachedChatAudioBlob(cacheKey);
    if (cached) {
      this.applyPreparedAudio(cacheKey, cached);
      return;
    }
    const durationSeconds =
      this.serverDurationMs !== undefined ? this.serverDurationMs / 1_000 : undefined;
    if (
      durationSeconds === undefined ||
      !shouldFetchChatAudioWaveform({ sizeBytes: this.sizeBytes, durationSeconds })
    ) {
      return;
    }
    const AudioContextConstructor = globalThis.AudioContext;
    if (!AudioContextConstructor) {
      return;
    }
    this.waveformAttempted = true;

    const headers = buildChatMediaFetchHeaders(this.authToken);
    headers.set("Accept", "audio/*");
    const controller = new AbortController();
    this.waveformController = controller;
    const timeout = setTimeout(
      () => controller.abort(new DOMException("waveform fetch timed out", "TimeoutError")),
      WAVEFORM_FETCH_TIMEOUT_MS,
    );
    let response: Response;
    let bytes: ArrayBuffer;
    try {
      response = await fetch(source, {
        method: "GET",
        headers,
        credentials: "same-origin",
        signal: controller.signal,
      });
      if (!response.ok) {
        return;
      }
      const boundedBytes = await readResponseBytesWithinLimit(
        response,
        CHAT_AUDIO_WAVEFORM_MAX_BYTES,
      );
      if (!boundedBytes) {
        return;
      }
      bytes = boundedBytes;
    } finally {
      clearTimeout(timeout);
      if (this.waveformController === controller) {
        this.waveformController = null;
      }
    }
    const blob = new Blob([bytes], {
      type: response.headers.get("Content-Type")?.split(";", 1)[0]?.trim() || "audio/mpeg",
    });
    const blobUrl = URL.createObjectURL(blob);
    let peaks: readonly number[] | undefined;
    let acceptedDecodedDuration: number | undefined;
    if (canDecodeChatAudioWaveform({ sizeBytes: bytes.byteLength, durationSeconds })) {
      let context: AudioContext | null = null;
      try {
        // Duration is trusted only from the server-side ffprobe metadata.
        // A 16 kHz decode bounds PCM; >20% duration mismatches are discarded.
        context = new AudioContextConstructor({ sampleRate: CHAT_AUDIO_WAVEFORM_SAMPLE_RATE });
        const decoded = await context.decodeAudioData(bytes.slice(0));
        const decodedDuration = Number.isFinite(decoded.duration) ? decoded.duration : undefined;
        if (
          decodedDuration !== undefined &&
          decodedDuration <= durationSeconds * WAVEFORM_DECODE_DURATION_TOLERANCE
        ) {
          peaks = computeChatAudioWaveformPeaks(decoded);
          acceptedDecodedDuration = decodedDuration;
        }
      } catch {
        // A playable browser source can still use the fetched Blob when Web Audio cannot decode it.
      } finally {
        await context?.close().catch(() => undefined);
      }
    }
    if (!this.isConnected || cacheKey !== this.resolveWaveformCacheKey()) {
      URL.revokeObjectURL(blobUrl);
      return;
    }
    const retained = cacheAndRetainChatAudioBlob(cacheKey, {
      blobUrl,
      sizeBytes: bytes.byteLength,
      ...(peaks ? { peaks } : {}),
      ...(acceptedDecodedDuration !== undefined
        ? { durationSeconds: acceptedDecodedDuration }
        : {}),
    });
    if (retained) {
      this.applyPreparedAudio(cacheKey, retained);
    }
  }

  private togglePlayback(): void {
    const media = this.media;
    if (!media || this.sourceController.readiness !== "ready") {
      return;
    }
    if (media.paused) {
      this.adoptPreparedAudioForPlayback();
      claimChatAudioPlayback(media, this.cancelPendingResume);
      const playback = media.play();
      if (!this.playRequest) {
        // Invoke play in the click task so strict browser media policies retain user activation.
        this.playRequest = playback
          .then(() => this.prepareWaveformAudio().catch(() => undefined))
          .catch(() => {
            releaseChatAudioPlayback(media);
            this.playing = false;
          })
          .finally(() => {
            this.playRequest = null;
          });
      } else {
        void playback.catch(() => {
          releaseChatAudioPlayback(media);
          this.playing = false;
        });
      }
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

  private setVolume(nextVolume: number): void {
    this.volume = Math.max(0, Math.min(1, nextVolume));
    if (this.media) {
      this.media.volume = this.volume;
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

  private renderSeek(progress: number) {
    const seek = html`<input
      class=${this.waveformPeaks
        ? "chat-audio-player__seek chat-audio-player__seek--waveform"
        : "chat-audio-player__seek"}
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
    />`;
    if (!this.waveformPeaks) {
      return seek;
    }
    const count = this.waveformPeaks.length;
    return html`<div class="chat-audio-player__waveform">
      <svg viewBox="0 0 ${count} 24" preserveAspectRatio="none" aria-hidden="true">
        ${this.waveformPeaks.map((peak, index) => {
          const height = Math.max(2, peak * 22);
          return svg`<rect
            class=${index / count < progress ? "is-played" : ""}
            x=${String(index + 0.18)}
            y=${String((24 - height) / 2)}
            width="0.64"
            height=${String(height)}
            rx="0.3"
          ></rect>`;
        })}
      </svg>
      ${seek}
    </div>`;
  }

  override render() {
    const progress = this.duration > 0 ? Math.min(1, this.currentTime / this.duration) : 0;
    const downloadHref = safeAttachmentHref(this.src);
    const failed = this.sourceController.readiness === "unavailable";
    return html`
      <div class="chat-assistant-attachment-card chat-assistant-attachment-card--audio">
        ${renderAttachmentCardHeader({
          kind: "audio",
          label: this.label,
          mimeType: this.mimeType,
          sizeBytes: this.sizeBytes,
          downloadHref,
          showExpandAction: true,
          voiceNote: this.voiceNote,
        })}
        ${failed
          ? html`<div class="chat-assistant-attachment-card__reason">
              ${t("chat.mediaPlayer.videoUnavailable")}
            </div> `
          : this.sourceController.readiness === "preparing"
            ? html`<div class="chat-assistant-attachment-card__reason chat-media-preparing">
                ${t("chat.mediaPlayer.preparing")}
              </div>`
            : html`<div
                class="chat-audio-player"
                tabindex="0"
                @keydown=${(event: KeyboardEvent) => this.handlePlayerKeydown(event)}
              >
                <button
                  type="button"
                  class="chat-audio-player__toggle"
                  ?disabled=${this.playback === "transcode" &&
                  this.sourceController.readiness !== "ready"}
                  aria-label=${t(this.playing ? "chat.mediaPlayer.pause" : "chat.mediaPlayer.play")}
                  @click=${() => this.togglePlayback()}
                >
                  ${this.playing ? icons.pause : icons.play}
                </button>
                <div class="chat-audio-player__timeline">
                  ${this.renderSeek(progress)}
                  <div class="chat-audio-player__time" aria-live="off">
                    <span>${formatChatMediaTime(this.currentTime)}</span>
                    <span>${formatChatMediaTime(this.duration)}</span>
                  </div>
                </div>
                <label class="chat-audio-player__volume">
                  <span class="chat-audio-player__volume-icon" aria-hidden="true">${icons.volume2}</span>
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.05"
                    .value=${String(this.volume)}
                    aria-label=${t("chat.mediaPlayer.volume")}
                    @input=${(event: Event) =>
                      this.setVolume(Number((event.currentTarget as HTMLInputElement).value))}
                  />
                </label>
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
            }
            this.requestUpdate();
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
