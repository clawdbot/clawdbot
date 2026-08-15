// @vitest-environment node
import type { ReactiveController, ReactiveControllerHost } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PollController } from "./poll-controller.ts";

class TestHost implements ReactiveControllerHost {
  readonly controllers: ReactiveController[] = [];
  readonly requestUpdate = vi.fn();
  readonly updateComplete = Promise.resolve(true);

  addController(controller: ReactiveController): void {
    this.controllers.push(controller);
  }

  removeController(controller: ReactiveController): void {
    const index = this.controllers.indexOf(controller);
    if (index !== -1) {
      this.controllers.splice(index, 1);
    }
  }

  connect(): void {
    for (const controller of this.controllers) {
      controller.hostConnected?.();
    }
  }

  disconnect(): void {
    for (const controller of this.controllers) {
      controller.hostDisconnected?.();
    }
  }
}

afterEach(() => vi.useRealTimers());

describe("PollController", () => {
  it("starts explicitly, ticks idempotently, and stops", () => {
    vi.useFakeTimers();
    const host = new TestHost();
    const tick = vi.fn();
    const polling = new PollController(host, 1_000, tick, false);

    expect(polling.start()).toBe(true);
    expect(polling.start()).toBe(false);
    vi.advanceTimersByTime(2_000);
    expect(tick).toHaveBeenCalledTimes(2);

    polling.stop();
    vi.advanceTimersByTime(1_000);
    expect(tick).toHaveBeenCalledTimes(2);
  });

  it("auto-starts on connect and always stops on disconnect", () => {
    vi.useFakeTimers();
    const host = new TestHost();
    const tick = vi.fn();
    const polling = new PollController(host, 500, tick);
    expect(host.controllers).toContain(polling);

    host.connect();
    vi.advanceTimersByTime(500);
    expect(tick).toHaveBeenCalledOnce();

    host.disconnect();
    vi.advanceTimersByTime(500);
    expect(tick).toHaveBeenCalledOnce();
  });
});
