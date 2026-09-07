// @vitest-environment node
import type { ReactiveController, ReactiveControllerHost } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nController } from "./lit-controller.ts";
import { i18n } from "./translate.ts";

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

describe("I18nController", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("replaces stale subscriptions and cleans up idempotently", () => {
    const firstCleanup = vi.fn();
    const secondCleanup = vi.fn();
    const subscribe = vi
      .spyOn(i18n, "subscribe")
      .mockReturnValueOnce(firstCleanup)
      .mockReturnValueOnce(secondCleanup);
    const host = new TestHost();
    const controller = new I18nController(host);
    expect(host.controllers).toContain(controller);

    host.connect();
    host.connect();
    expect(subscribe).toHaveBeenCalledTimes(2);
    expect(firstCleanup).toHaveBeenCalledOnce();

    host.disconnect();
    host.disconnect();
    expect(secondCleanup).toHaveBeenCalledOnce();
  });

  it("requests updates on connect and locale notifications", () => {
    const cleanup = vi.fn();
    let notify: (() => void) | undefined;
    vi.spyOn(i18n, "subscribe").mockImplementation((subscriber) => {
      notify = () => subscriber("en");
      return cleanup;
    });
    const host = new TestHost();
    const controller = new I18nController(host);
    expect(host.controllers).toContain(controller);

    host.connect();
    expect(host.requestUpdate).toHaveBeenCalledOnce();

    notify?.();
    expect(host.requestUpdate).toHaveBeenCalledTimes(2);

    host.disconnect();
    expect(cleanup).toHaveBeenCalledOnce();
  });
});
