import { describe, expect, it } from "vitest";
import { throwIfAborted } from "./abort.js";

describe("throwIfAborted", () => {
  it("does nothing when the signal is missing or not aborted", () => {
    expect(throwIfAborted()).toBeUndefined();
    expect(throwIfAborted(new AbortController().signal)).toBeUndefined();
  });

  it("throws a standard AbortError when the signal is aborted", () => {
    const controller = new AbortController();
    controller.abort();

    let thrown: unknown;
    try {
      throwIfAborted(controller.signal);
    } catch (error) {
      thrown = error;
    }
    expect((thrown as { name?: unknown }).name).toBe("AbortError");
    expect((thrown as { message?: unknown }).message).toBe("Operation aborted");
  });
});
