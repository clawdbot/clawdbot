import { afterEach, describe, expect, it, vi } from "vitest";
import { sleepWithAbort } from "./retry-sleep.js";

describe("sleepWithAbort listener lifecycle", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("unregisters the abort listener after a successful wait", async () => {
    const controller = new AbortController();
    const addSpy = vi.spyOn(controller.signal, "addEventListener");
    const removeSpy = vi.spyOn(controller.signal, "removeEventListener");

    await sleepWithAbort(5, controller.signal);

    expect(addSpy).toHaveBeenCalledWith("abort", expect.any(Function), { once: true });
    const onAbort = addSpy.mock.calls.find((call) => call[0] === "abort")?.[1];
    expect(onAbort).toEqual(expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith("abort", onAbort);
  });

  it("does not accumulate listeners across multiple successful waits on one signal", async () => {
    const controller = new AbortController();
    const addSpy = vi.spyOn(controller.signal, "addEventListener");
    const removeSpy = vi.spyOn(controller.signal, "removeEventListener");

    await sleepWithAbort(1, controller.signal);
    await sleepWithAbort(1, controller.signal);
    await sleepWithAbort(1, controller.signal);

    const abortAdds = addSpy.mock.calls.filter((call) => call[0] === "abort");
    const abortRemoves = removeSpy.mock.calls.filter((call) => call[0] === "abort");
    expect(abortAdds).toHaveLength(3);
    expect(abortRemoves).toHaveLength(3);
    for (let i = 0; i < abortAdds.length; i += 1) {
      expect(abortRemoves[i]?.[1]).toBe(abortAdds[i]?.[1]);
    }
  });

  it("clears the timer and unregisters the listener when aborted", async () => {
    const controller = new AbortController();
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    const removeSpy = vi.spyOn(controller.signal, "removeEventListener");
    const pending = sleepWithAbort(60_000, controller.signal);

    controller.abort();

    await expect(pending).rejects.toThrow("Request was aborted");
    expect(clearTimeoutSpy).toHaveBeenCalledOnce();
    expect(removeSpy).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(sleepWithAbort(5, controller.signal)).rejects.toThrow("Request was aborted");
  });
});
