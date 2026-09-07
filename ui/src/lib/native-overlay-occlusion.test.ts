/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acquireNativeOverlayOcclusion,
  subscribeNativeOverlayOcclusion,
} from "./native-overlay-occlusion.ts";

const bridge = vi.hoisted(() => ({ available: true }));
vi.mock("../app/native-browser-host.ts", () => ({
  hasNativeBrowserBridge: () => bridge.available,
}));

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    cleanup();
  }
  bridge.available = true;
});

describe("native overlay occlusion", () => {
  it("stays occluded until every overlay releases and tolerates repeated releases", () => {
    const changes = vi.fn();
    cleanups.push(subscribeNativeOverlayOcclusion(changes));
    const first = acquireNativeOverlayOcclusion();
    const second = acquireNativeOverlayOcclusion();
    cleanups.push(first, second);
    const lateSubscriber = vi.fn();
    const unsubscribe = subscribeNativeOverlayOcclusion(lateSubscriber);
    cleanups.push(unsubscribe);

    expect(changes.mock.calls).toEqual([[false], [true]]);
    expect(lateSubscriber).toHaveBeenCalledWith(true);
    first();
    first();
    expect(changes.mock.calls).toEqual([[false], [true]]);
    unsubscribe();
    second();
    expect(changes.mock.calls).toEqual([[false], [true], [false]]);
    expect(lateSubscriber).toHaveBeenCalledTimes(1);
  });

  it("does not acquire or subscribe without the native browser bridge", () => {
    bridge.available = false;
    const changes = vi.fn();
    cleanups.push(subscribeNativeOverlayOcclusion(changes));
    const release = acquireNativeOverlayOcclusion();
    release();
    release();
    bridge.available = true;
    const nativeRelease = acquireNativeOverlayOcclusion();
    nativeRelease();
    expect(changes.mock.calls).toEqual([[false]]);
  });
});
