// @vitest-environment node
import type { ReactiveController, ReactiveControllerHost } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SubscriptionsController } from "./subscriptions-controller.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

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

  update(): void {
    for (const controller of this.controllers) {
      controller.hostUpdate?.();
    }
  }

  disconnect(): void {
    for (const controller of this.controllers) {
      controller.hostDisconnected?.();
    }
  }
}

class TestSource {
  private listeners = new Set<() => void>();
  readonly cleanups = vi.fn();

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
      this.cleanups();
    };
  }

  notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

describe("SubscriptionsController", () => {
  it("waits for a source, synchronizes once, and does not subscribe twice", () => {
    const host = new TestHost();
    const controller = new SubscriptionsController(host);
    const synchronize = vi.fn<(source: TestSource) => void>();
    const source: { current?: TestSource } = {};
    controller.watch(
      () => source.current,
      (next, notify) => next.subscribe(notify),
      synchronize,
    );

    host.connect();
    host.update();
    expect(synchronize).not.toHaveBeenCalled();

    source.current = new TestSource();
    host.update();
    host.update();
    expect(synchronize).toHaveBeenCalledTimes(1);

    host.requestUpdate.mockClear();
    source.current.notify();
    expect(synchronize).toHaveBeenCalledTimes(2);
    expect(host.requestUpdate).toHaveBeenCalledOnce();
  });

  it("replaces sources and ignores notifications from a stale subscription", () => {
    const host = new TestHost();
    const controller = new SubscriptionsController(host);
    const first = new TestSource();
    const second = new TestSource();
    let source = first;
    let staleNotify: (() => void) | undefined;
    const synchronize = vi.fn<(source: TestSource) => void>();
    controller.watch(
      () => source,
      (next, notify) => {
        if (next === first) {
          staleNotify = notify;
        }
        return next.subscribe(notify);
      },
      synchronize,
    );

    host.connect();
    source = second;
    host.update();

    expect(first.cleanups).toHaveBeenCalledOnce();
    expect(synchronize).toHaveBeenLastCalledWith(second);
    host.requestUpdate.mockClear();
    staleNotify?.();
    expect(host.requestUpdate).not.toHaveBeenCalled();
  });

  it("cleans up on disconnect and resubscribes once after reconnect", () => {
    const host = new TestHost();
    const controller = new SubscriptionsController(host);
    const source = new TestSource();
    const subscribe = vi.fn((next: TestSource, notify: () => void) => next.subscribe(notify));
    controller.watch(() => source, subscribe);

    host.connect();
    host.disconnect();
    host.update();
    host.disconnect();
    expect(source.cleanups).toHaveBeenCalledOnce();
    expect(subscribe).toHaveBeenCalledOnce();

    host.connect();
    host.update();
    expect(subscribe).toHaveBeenCalledTimes(2);
  });

  it("clears idempotently and reconnects on the next update", () => {
    const host = new TestHost();
    const controller = new SubscriptionsController(host);
    const source = new TestSource();
    const subscribe = vi.fn((next: TestSource, notify: () => void) => next.subscribe(notify));
    controller.watch(() => source, subscribe);

    host.connect();
    controller.clear();
    controller.clear();
    expect(source.cleanups).toHaveBeenCalledOnce();

    host.update();
    expect(subscribe).toHaveBeenCalledTimes(2);
  });

  it("leaves effect invalidation under caller control", () => {
    const host = new TestHost();
    const controller = new SubscriptionsController(host);
    const source = new TestSource();
    const listener = vi.fn();
    controller.effect(
      () => source,
      (next) => next.subscribe(listener),
    );

    host.connect();
    expect(host.requestUpdate).not.toHaveBeenCalled();
    source.notify();

    expect(listener).toHaveBeenCalledOnce();
    expect(host.requestUpdate).not.toHaveBeenCalled();
  });

  it("cleans up a listener when initial synchronization throws", () => {
    const host = new TestHost();
    const controller = new SubscriptionsController(host);
    const source = new TestSource();
    controller.watch(
      () => source,
      (next, notify) => next.subscribe(notify),
      () => {
        throw new Error("synchronize failed");
      },
    );

    expect(() => host.connect()).toThrow("synchronize failed");
    expect(source.cleanups).toHaveBeenCalledOnce();
  });

  it("runs later cleanups when an earlier cleanup throws", () => {
    const host = new TestHost();
    const controller = new SubscriptionsController(host);
    const firstCleanup = vi.fn(() => {
      throw new Error("cleanup failed");
    });
    const secondCleanup = vi.fn();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    controller.effect(
      () => "first",
      () => firstCleanup,
    );
    controller.effect(
      () => "second",
      () => secondCleanup,
    );

    host.connect();
    controller.clear();

    expect(firstCleanup).toHaveBeenCalledOnce();
    expect(secondCleanup).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledOnce();
  });
});
