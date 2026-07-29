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

  get currentSource(): string {
    return this.appliedSource;
  }

  get queuedSource(): string {
    return this.pendingSource;
  }

  updateSource(media: HTMLMediaElement, source: string, sourceIdentity = source): void {
    const nextSource = source.trim();
    const nextIdentity = sourceIdentity.trim();
    if (!nextSource || !nextIdentity) {
      return;
    }
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

  handleLoadedMetadata(media: HTMLMediaElement, canResume = () => true): void {
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
    media.src = source;
  }
}

const sourceControllers = new WeakMap<HTMLMediaElement, ChatMediaSourceController>();

export function getChatMediaSourceController(media: HTMLMediaElement): ChatMediaSourceController {
  let controller = sourceControllers.get(media);
  if (!controller) {
    controller = new ChatMediaSourceController();
    sourceControllers.set(media, controller);
  }
  return controller;
}
