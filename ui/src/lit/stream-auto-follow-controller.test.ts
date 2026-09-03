/* @vitest-environment jsdom */
import type { ReactiveController, ReactiveControllerHost } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StreamAutoFollowController } from "./stream-auto-follow-controller.ts";

type ScrollState = {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
};

function createScrollContainer(): { container: HTMLElement; state: ScrollState } {
  const container = document.createElement("div");
  const state: ScrollState = { scrollHeight: 1000, scrollTop: 0, clientHeight: 200 };
  Object.defineProperty(container, "scrollHeight", {
    get: () => state.scrollHeight,
    configurable: true,
  });
  Object.defineProperty(container, "scrollTop", {
    get: () => state.scrollTop,
    // Browsers clamp scrollTop to [0, scrollHeight - clientHeight].
    set: (value: number) => {
      state.scrollTop = Math.min(value, Math.max(0, state.scrollHeight - state.clientHeight));
    },
    configurable: true,
  });
  Object.defineProperty(container, "clientHeight", {
    get: () => state.clientHeight,
    configurable: true,
  });
  return { container, state };
}

function createHost(container: HTMLElement) {
  const controllers: ReactiveController[] = [];
  const host = {
    isConnected: true,
    updateComplete: Promise.resolve(true),
    addController: (controller: ReactiveController) => {
      controllers.push(controller);
    },
    removeController: (controller: ReactiveController) => {
      const index = controllers.indexOf(controller);
      if (index !== -1) {
        controllers.splice(index, 1);
      }
    },
    querySelector: (selector: string) => (selector === ".scroll" ? container : null),
  };
  return host as unknown as ReactiveControllerHost & HTMLElement;
}

function createController(
  options: {
    isEnabled?: boolean | (() => boolean);
    captureCurrent?: () => () => boolean;
  } = {},
) {
  const { container, state } = createScrollContainer();
  const host = createHost(container);
  const isEnabledOption = options.isEnabled;
  const isEnabled =
    typeof isEnabledOption === "function" ? isEnabledOption : () => isEnabledOption ?? true;
  const controller = new StreamAutoFollowController(host, {
    selector: ".scroll",
    isEnabled,
    captureCurrent: options.captureCurrent,
  });
  return { controller, container, state };
}

let rafQueue: FrameRequestCallback[] = [];

function runFrame(): void {
  const queue = rafQueue;
  rafQueue = [];
  for (const callback of queue) {
    callback(0);
  }
}

async function flushUpdate(): Promise<void> {
  await Promise.resolve();
}

beforeEach(() => {
  rafQueue = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    rafQueue.push(callback);
    return rafQueue.length;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    rafQueue[id - 1] = () => undefined;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("StreamAutoFollowController", () => {
  it("re-asserts the bottom when content grows right after scrolling", async () => {
    const { controller, state } = createController();
    controller.schedule();
    await flushUpdate();
    runFrame();
    expect(state.scrollTop).toBe(800);

    // The virtualizer finishes measuring a tall row one frame later and the
    // content grows by 500px, leaving the viewport above the bottom.
    state.scrollHeight = 1500;
    runFrame();
    expect(state.scrollTop).toBe(1300);
    expect(controller.atBottom).toBe(true);

    // Once the layout is stable the settle loop disarms itself.
    runFrame();
    expect(rafQueue).toHaveLength(0);
  });

  it("stops chasing the bottom when the user scrolls up during settle", async () => {
    const { controller, container, state } = createController();
    controller.schedule();
    await flushUpdate();
    runFrame();
    expect(state.scrollTop).toBe(800);

    state.scrollHeight = 1500;
    // User drags upward before the next settle frame lands.
    state.scrollTop = 500;
    controller.handleScroll({ currentTarget: container } as unknown as Event);
    expect(controller.atBottom).toBe(false);

    runFrame();
    expect(state.scrollTop).toBe(500);
    expect(rafQueue).toHaveLength(0);
  });

  it("stops settling when auto-follow is turned off mid-settle", async () => {
    let enabled = true;
    const { controller, state } = createController({ isEnabled: () => enabled });
    controller.schedule();
    await flushUpdate();
    runFrame();
    expect(state.scrollTop).toBe(800);

    // Content grows, then the user disables auto-follow before the next
    // settle frame lands. The loop must not reset scrollTop again.
    state.scrollHeight = 1500;
    enabled = false;

    runFrame();
    expect(state.scrollTop).toBe(800);
    expect(rafQueue).toHaveLength(0);
  });

  it("stops settling when the captured stream epoch goes stale mid-settle", async () => {
    let current = true;
    const { controller, state } = createController({
      captureCurrent: () => () => current,
    });
    controller.schedule();
    await flushUpdate();
    runFrame();
    expect(state.scrollTop).toBe(800);

    // The stream reconnects after the first settle write; the predicate
    // captured at schedule time is now stale and must disarm the loop.
    state.scrollHeight = 1500;
    current = false;

    runFrame();
    expect(state.scrollTop).toBe(800);
    expect(rafQueue).toHaveLength(0);
  });

  it("keeps settling while the captured epoch and enablement stay valid", async () => {
    const current = true;
    const enabled = true;
    const { controller, state } = createController({
      isEnabled: () => enabled,
      captureCurrent: () => () => current,
    });
    controller.schedule();
    await flushUpdate();
    runFrame();
    expect(state.scrollTop).toBe(800);

    state.scrollHeight = 1500;
    runFrame();
    expect(state.scrollTop).toBe(1300);
    expect(current).toBe(true);
    expect(enabled).toBe(true);
  });

  it("does not scroll without force while far from the bottom", async () => {
    const { controller, container, state } = createController();
    controller.handleScroll({ currentTarget: container } as unknown as Event);
    expect(controller.atBottom).toBe(false);

    controller.schedule();
    await flushUpdate();
    runFrame();
    expect(state.scrollTop).toBe(0);

    controller.schedule(true);
    await flushUpdate();
    runFrame();
    expect(state.scrollTop).toBe(800);
  });

  it("respects isEnabled", async () => {
    const { controller, state } = createController({ isEnabled: false });
    controller.schedule();
    await flushUpdate();
    runFrame();
    expect(state.scrollTop).toBe(0);
    expect(rafQueue).toHaveLength(0);
  });

  it("gives up settling after a bounded number of frames", async () => {
    const { controller, state } = createController();
    controller.schedule();
    await flushUpdate();
    for (let frame = 0; frame < 20; frame += 1) {
      // Content keeps growing every frame (e.g. a streaming tool result).
      state.scrollHeight += 100;
      runFrame();
    }
    expect(rafQueue).toHaveLength(0);
    expect(state.scrollTop).toBeGreaterThan(0);
  });
});
