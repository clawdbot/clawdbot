/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIdleImport } from "./idle-import.ts";

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal(
    "requestIdleCallback",
    vi.fn((callback: IdleRequestCallback) =>
      window.setTimeout(() => callback({ didTimeout: false, timeRemaining: () => 50 }), 0),
    ),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("createIdleImport", () => {
  it("waits for the idle schedule before importing", async () => {
    const importModule = vi.fn(async () => "loaded");
    const onLoaded = vi.fn();
    const idleImport = createIdleImport(importModule, onLoaded);

    idleImport.schedule();

    expect(importModule).not.toHaveBeenCalled();
    expect(requestIdleCallback).toHaveBeenCalledWith(expect.any(Function), { timeout: 3000 });

    await vi.runAllTimersAsync();

    expect(importModule).toHaveBeenCalledTimes(1);
    expect(onLoaded).toHaveBeenCalledWith("loaded");
  });

  it("clears a failed import and re-arms it when the browser comes online", async () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    const importModule = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue("loaded");
    const onLoaded = vi.fn();
    const idleImport = createIdleImport(importModule, onLoaded);

    idleImport.schedule();
    await vi.runAllTimersAsync();

    expect(importModule).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new Event("online"));
    await vi.waitFor(() => expect(onLoaded).toHaveBeenCalledWith("loaded"));

    expect(importModule).toHaveBeenCalledTimes(2);
  });

  it("retries one failed import while the browser remains online", async () => {
    const importModule = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValue("loaded");
    const onLoaded = vi.fn();
    const idleImport = createIdleImport(importModule, onLoaded);

    idleImport.schedule();
    await vi.runAllTimersAsync();

    expect(importModule).toHaveBeenCalledTimes(2);
    expect(onLoaded).toHaveBeenCalledWith("loaded");
  });

  it("removes its online retry listener when disposed", async () => {
    const importModule = vi.fn<() => Promise<string>>().mockRejectedValue(new Error("offline"));
    const removeEventListener = vi.spyOn(window, "removeEventListener");
    const idleImport = createIdleImport(importModule);

    await expect(idleImport.load()).rejects.toThrow("offline");
    idleImport.dispose();
    window.dispatchEvent(new Event("online"));
    await Promise.resolve();

    expect(removeEventListener).toHaveBeenCalledWith("online", expect.any(Function));
    expect(importModule).toHaveBeenCalledTimes(1);
  });

  it("shares and retains a successful module promise", async () => {
    const module = { ready: true };
    const importModule = vi.fn(async () => module);
    const onLoaded = vi.fn();
    const idleImport = createIdleImport(importModule, onLoaded);

    const first = idleImport.load();
    const second = idleImport.load();

    await expect(first).resolves.toBe(module);
    await expect(second).resolves.toBe(module);
    await expect(idleImport.load()).resolves.toBe(module);
    expect(importModule).toHaveBeenCalledTimes(1);
    expect(onLoaded).toHaveBeenCalledTimes(1);
  });
});
