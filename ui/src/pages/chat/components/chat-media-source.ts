import {
  appendChatMediaPlaybackParam,
  waitForChatMediaPlayback,
  type ChatMediaPlaybackMode,
} from "./chat-media-playback.ts";

type PlaybackRestore = {
  currentTime: number;
  paused: boolean;
};

function finiteMediaTime(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** Keeps a refreshed ticket ready without interrupting active media playback. */
export class ChatMediaSourceController {
  private appliedSource = "";
  private appliedIdentity = "";
  private pendingSource = "";
  private pendingIdentity = "";
  private restore: PlaybackRestore | null = null;
  private sourceFailed = false;
  private authorizationKey = "";
  private readinessRequest: {
    key: string;
    controller: AbortController;
    promise: Promise<void>;
  } | null = null;
  private playbackSource = "";
  private playbackReadiness: "idle" | "preparing" | "ready" | "unavailable" = "idle";

  get currentIdentity(): string {
    return this.appliedIdentity;
  }

  get readySource(): string {
    return this.playbackSource;
  }

  get readiness() {
    return this.playbackReadiness;
  }

  sync(
    media: HTMLMediaElement,
    source: string,
    sourceIdentity: string,
    playback: ChatMediaPlaybackMode,
    authToken?: string | null,
  ): Promise<void> | null {
    const nextSource = source.trim();
    const nextIdentity = sourceIdentity.trim();
    const nextAuthToken = authToken?.trim() ?? "";
    if (!nextSource || !nextIdentity) {
      return null;
    }

    const authorizationKey = `${nextIdentity}\0${nextAuthToken}`;
    if (this.authorizationKey && authorizationKey !== this.authorizationKey) {
      this.reset(media);
    }
    this.authorizationKey = authorizationKey;

    const nextPlaybackSource =
      playback === "transcode" ? appendChatMediaPlaybackParam(nextSource) : nextSource;
    if (playback !== "transcode") {
      this.abortReadiness();
      this.sourceFailed = false;
      this.playbackReadiness = "ready";
      this.playbackSource = nextPlaybackSource;
      this.updateSource(media, nextPlaybackSource, nextIdentity);
      return null;
    }

    const readinessKey = [nextPlaybackSource, nextIdentity, nextAuthToken].join("\0");
    if (readinessKey === this.readinessRequest?.key) {
      if (this.playbackSource === nextPlaybackSource) {
        this.updateSource(media, nextPlaybackSource, nextIdentity);
      }
      return this.readinessRequest.promise;
    }

    this.abortReadiness();
    const controller = new AbortController();
    const hasUsableSource = () => this.appliedIdentity === nextIdentity && !this.sourceFailed;
    this.playbackSource = "";
    this.playbackReadiness = hasUsableSource() ? "ready" : "preparing";
    const pending = waitForChatMediaPlayback({
      source: nextPlaybackSource,
      authToken: nextAuthToken || null,
      signal: controller.signal,
    }).then((result) => {
      if (this.readinessRequest?.controller !== controller || result === "aborted") {
        return;
      }
      if (result !== "ready") {
        if (hasUsableSource()) {
          this.playbackSource = this.appliedSource;
          this.playbackReadiness = "ready";
        } else {
          this.playbackReadiness = "unavailable";
        }
        return;
      }
      this.playbackSource = nextPlaybackSource;
      this.playbackReadiness = "ready";
      this.updateSource(media, nextPlaybackSource, nextIdentity);
    });
    this.readinessRequest = { key: readinessKey, controller, promise: pending };
    return pending;
  }

  cancel(): void {
    this.abortReadiness();
    this.cancelPendingResume();
    this.playbackSource = "";
    this.playbackReadiness = "idle";
  }

  updateSource(media: HTMLMediaElement, source: string, sourceIdentity = source): void {
    const nextSource = source.trim();
    const nextIdentity = sourceIdentity.trim();
    if (!nextSource || !nextIdentity) {
      return;
    }
    this.playbackReadiness = "ready";
    if (this.appliedIdentity && nextIdentity !== this.appliedIdentity) {
      if (!media.paused) {
        media.pause();
      }
      this.applySource(media, nextSource, nextIdentity, null);
      return;
    }
    if (
      (nextSource === this.pendingSource && nextIdentity === this.pendingIdentity) ||
      (nextSource === this.appliedSource && nextIdentity === this.appliedIdentity)
    ) {
      return;
    }
    if (media.error) {
      this.applySource(media, nextSource, nextIdentity, {
        currentTime: finiteMediaTime(media.currentTime),
        paused: media.paused,
      });
      return;
    }
    if (
      !this.appliedSource ||
      media.ended ||
      (media.paused && finiteMediaTime(media.currentTime) === 0)
    ) {
      this.applySource(media, nextSource, nextIdentity, null);
      return;
    }
    // A fresh ticket must not replace the active resource: assigning src resets
    // playback even when the browser still has enough buffered data to continue.
    this.pendingSource = nextSource;
    this.pendingIdentity = nextIdentity;
  }

  handleEnded(media: HTMLMediaElement): boolean {
    if (!this.pendingSource) {
      return false;
    }
    this.applySource(media, this.pendingSource, this.pendingIdentity, null);
    return true;
  }

  handleError(media: HTMLMediaElement): boolean {
    if (!this.pendingSource) {
      this.sourceFailed = true;
      this.playbackSource = "";
      this.playbackReadiness = "unavailable";
      return false;
    }
    this.applySource(media, this.pendingSource, this.pendingIdentity, {
      currentTime: finiteMediaTime(media.currentTime),
      paused: media.paused,
    });
    return true;
  }

  applyPendingSource(media: HTMLMediaElement): boolean {
    if (!this.pendingSource) {
      return false;
    }
    this.applySource(media, this.pendingSource, this.pendingIdentity, {
      currentTime: finiteMediaTime(media.currentTime),
      paused: media.paused,
    });
    return true;
  }

  seek(media: HTMLMediaElement, nextTime: number): boolean {
    const targetTime = Math.max(0, finiteMediaTime(nextTime));
    try {
      media.currentTime = targetTime;
      return true;
    } catch {
      if (!this.pendingSource) {
        return false;
      }
      this.applySource(media, this.pendingSource, this.pendingIdentity, {
        currentTime: targetTime,
        paused: media.paused,
      });
      return true;
    }
  }

  cancelPendingResume(): void {
    if (this.restore && !this.restore.paused) {
      this.restore = { ...this.restore, paused: true };
    }
  }

  reset(media: HTMLMediaElement): void {
    if (!media.paused) {
      media.pause();
    }
    this.appliedSource = "";
    this.appliedIdentity = "";
    this.pendingSource = "";
    this.pendingIdentity = "";
    this.restore = null;
    this.sourceFailed = false;
    this.playbackSource = "";
    media.removeAttribute("src");
    media.load();
  }

  handleLoadedMetadata(media: HTMLMediaElement, canResume = () => true): void {
    this.sourceFailed = false;
    const restore = this.restore;
    if (!restore) {
      return;
    }
    this.restore = null;
    const duration = Number.isFinite(media.duration) ? media.duration : restore.currentTime;
    media.currentTime = Math.min(restore.currentTime, Math.max(0, duration));
    if (!restore.paused && media.isConnected && canResume()) {
      void media.play().catch(() => undefined);
    }
  }

  private applySource(
    media: HTMLMediaElement,
    source: string,
    sourceIdentity: string,
    restore: PlaybackRestore | null,
  ): void {
    this.appliedSource = source;
    this.appliedIdentity = sourceIdentity;
    this.pendingSource = "";
    this.pendingIdentity = "";
    this.restore = restore;
    this.sourceFailed = false;
    media.src = source;
  }

  private abortReadiness(): void {
    this.readinessRequest?.controller.abort();
    this.readinessRequest = null;
  }
}
