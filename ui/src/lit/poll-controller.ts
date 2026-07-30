import type { ReactiveController, ReactiveControllerHost } from "lit";

export class PollController implements ReactiveController {
  private timer: ReturnType<typeof globalThis.setInterval> | null = null;

  constructor(
    host: ReactiveControllerHost,
    private readonly intervalMs: number,
    private readonly tick: () => void,
    private readonly autoStart = true,
  ) {
    host.addController(this);
  }

  hostConnected(): void {
    if (this.autoStart) {
      this.start();
    }
  }

  hostDisconnected(): void {
    this.stop();
  }

  start(): boolean {
    if (this.timer !== null) {
      return false;
    }
    this.timer = globalThis.setInterval(() => {
      this.tick();
    }, this.intervalMs);
    return true;
  }

  stop(): void {
    if (this.timer === null) {
      return;
    }
    globalThis.clearInterval(this.timer);
    this.timer = null;
  }
}
