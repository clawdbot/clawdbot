import { describe, expect, it } from "vitest";
import { isAddressInUseError } from "./gmail-watcher.js";

describe("gmail watcher", () => {
  it("detects address already in use errors", () => {
    expect(
      isAddressInUseError(
        "listen tcp 127.0.0.1:8788: bind: address already in use",
      ),
    ).toBe(true);
    expect(isAddressInUseError("EADDRINUSE: address already in use")).toBe(
      true,
    );
    expect(isAddressInUseError("some other error")).toBe(false);
  });
});
