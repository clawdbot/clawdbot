// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScreenWakeLock } from "./screen-wake-lock.ts";

beforeEach(() => {
  const documentTarget = new EventTarget();
  Object.defineProperty(documentTarget, "visibilityState", { value: "visible" });
  vi.stubGlobal("document", documentTarget as Document);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ScreenWakeLock", () => {
  it("holds a screen wake lock until the microphone activity stops", async () => {
    const { release, request } = installWakeLock();
    const screenWakeLock = new ScreenWakeLock();

    screenWakeLock.start();
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("screen"));
    screenWakeLock.stop();

    expect(release).toHaveBeenCalledOnce();
  });

  it("reacquires a released lock when the page becomes visible again", async () => {
    const first = createWakeLock();
    const second = createWakeLock();
    const request = vi.fn().mockResolvedValueOnce(first.lock).mockResolvedValueOnce(second.lock);
    const addEventListener = vi.spyOn(first.lock, "addEventListener");
    stubWakeLock(request);
    const screenWakeLock = new ScreenWakeLock();

    screenWakeLock.start();
    await vi.waitFor(() =>
      expect(addEventListener).toHaveBeenCalledWith("release", expect.anything(), {
        once: true,
      }),
    );
    await Promise.resolve();
    first.lock.dispatchEvent(new Event("release"));
    document.dispatchEvent(new Event("visibilitychange"));

    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    screenWakeLock.stop();
  });

  it("does not fail when wake locks are unavailable", () => {
    const screenWakeLock = new ScreenWakeLock();

    expect(() => {
      screenWakeLock.start();
      screenWakeLock.stop();
    }).not.toThrow();
  });
});

function installWakeLock() {
  const wakeLock = createWakeLock();
  const request = vi.fn(async () => wakeLock.lock);
  stubWakeLock(request);
  return { ...wakeLock, request };
}

function createWakeLock() {
  const lock = new EventTarget() as WakeLockSentinel;
  const release = vi.fn(async () => undefined);
  Object.defineProperties(lock, {
    release: { value: release },
    released: { value: false },
    type: { value: "screen" },
  });
  return { lock, release };
}

function stubWakeLock(request: ReturnType<typeof vi.fn>): void {
  vi.stubGlobal("navigator", { wakeLock: { request } });
}
