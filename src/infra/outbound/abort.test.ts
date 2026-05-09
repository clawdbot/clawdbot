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

    expect(() => throwIfAborted(controller.signal)).toThrowError(
      expect.objectContaining({
        name: "AbortError",
        message: "Operation aborted",
      }),
    );
  });
});
