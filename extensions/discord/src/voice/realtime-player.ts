import type { AudioPlayer, AudioResource } from "@discordjs/voice";
import { loadDiscordVoiceSdk } from "./sdk-runtime.js";

export type DiscordRealtimePlayerRequest = {
  createResource: () => AudioResource;
  onStart: () => void;
  onIdle: () => void;
  onBargeIn: (reason: string) => void;
  onError: (error: unknown) => void;
};

type DiscordRealtimePlayerLane = {
  hasOutput: () => boolean;
  onBargeIn: (reason: string) => void;
  cancelForControl: () => void;
};

/** One physical player serves every speaker lane in the room. */
export class DiscordRealtimePlayer {
  private current: DiscordRealtimePlayerRequest | undefined;
  private queue: DiscordRealtimePlayerRequest[] = [];
  private readonly lanes = new Set<DiscordRealtimePlayerLane>();
  private changing = false;
  private closed = false;
  private readonly onIdle = () => {
    const request = this.current;
    this.current = undefined;
    if (request) {
      this.transition(() => request.onIdle());
    }
  };

  constructor(private readonly player: AudioPlayer) {
    player.on(loadDiscordVoiceSdk().AudioPlayerStatus.Idle, this.onIdle);
  }

  registerLane(lane: DiscordRealtimePlayerLane): () => void {
    this.lanes.add(lane);
    return () => this.lanes.delete(lane);
  }

  enqueue(request: DiscordRealtimePlayerRequest): void {
    if (this.closed || this.current === request || this.queue.includes(request)) {
      return;
    }
    this.queue.push(request);
    this.drain();
  }

  cancel(request: DiscordRealtimePlayerRequest): void {
    this.queue = this.queue.filter((queued) => queued !== request);
    if (this.current !== request) {
      return;
    }
    // stop(true) emits Idle synchronously. Retire ownership before stopping so
    // that event cannot complete a replacement or another lane's queued answer.
    this.current = undefined;
    this.transition(() => this.player.stop(true));
  }

  handleBargeIn(reason = "barge-in"): void {
    if (this.current) {
      this.current.onBargeIn(reason);
      return;
    }
    for (const lane of this.lanes) {
      if (lane.hasOutput()) {
        lane.onBargeIn(reason);
      }
    }
  }

  isActive(): boolean {
    return this.current !== undefined || Array.from(this.lanes).some((lane) => lane.hasOutput());
  }

  cancelForControl(): void {
    // A room control applies to every pending answer, including speech not yet
    // synthesized. Block grants until every lane has released its old output.
    this.transition(() => {
      this.queue = [];
      for (const lane of this.lanes) {
        lane.cancelForControl();
      }
    });
  }

  close(): void {
    this.closed = true;
    this.queue = [];
    this.lanes.clear();
    this.current = undefined;
    this.player.off(loadDiscordVoiceSdk().AudioPlayerStatus.Idle, this.onIdle);
    this.player.stop(true);
  }

  private transition(action: () => void): void {
    const wasChanging = this.changing;
    this.changing = true;
    try {
      action();
    } finally {
      this.changing = wasChanging;
      this.drain();
    }
  }

  private drain(): void {
    if (this.closed || this.changing || this.current) {
      return;
    }
    const next = this.queue.shift();
    if (!next) {
      return;
    }
    this.current = next;
    this.transition(() => {
      try {
        this.player.play(next.createResource());
        next.onStart();
      } catch (error) {
        this.current = undefined;
        this.player.stop(true);
        next.onError(error);
      }
    });
  }
}
