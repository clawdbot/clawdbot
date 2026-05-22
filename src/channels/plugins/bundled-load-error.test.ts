import { describe, it, expect } from "vitest";
import { describeBundledChannelLoadError } from "./bundled.js";

describe("describeBundledChannelLoadError", () => {
  it("appends the doctor --fix hint for a top-level MODULE_NOT_FOUND error", () => {
    const err = Object.assign(new Error("Cannot find module 'nostr-tools'"), {
      code: "MODULE_NOT_FOUND",
    });
    const detail = describeBundledChannelLoadError(err, "nostr");
    expect(detail).toContain("Cannot find module 'nostr-tools'");
    expect(detail).toContain("openclaw doctor --fix");
    expect(detail).toContain("channel nostr");
  });

  it("appends the doctor --fix hint for a top-level ERR_MODULE_NOT_FOUND error", () => {
    const err = Object.assign(new Error("Cannot find package '@larksuiteoapi/node-sdk'"), {
      code: "ERR_MODULE_NOT_FOUND",
    });
    expect(describeBundledChannelLoadError(err, "feishu")).toContain("openclaw doctor --fix");
  });

  it("appends the doctor --fix hint when the missing-module code is on a nested cause (native require wrap)", () => {
    // Mirrors src/channels/plugins/module-loader.ts which wraps require failures
    // in `new Error(..., { cause: error })`. The MODULE_NOT_FOUND code only
    // exists on the cause, not on the outer wrapper.
    const inner = Object.assign(new Error("Cannot find module 'discord.js'"), {
      code: "MODULE_NOT_FOUND",
    });
    const wrapped = new Error(
      "failed to load channel plugin module with native require: /plugins/discord/index.js",
      { cause: inner },
    );
    const detail = describeBundledChannelLoadError(wrapped, "discord");
    expect(detail).toContain("openclaw doctor --fix");
    expect(detail).toContain("channel discord");
    // The detail should still surface the underlying message via the existing
    // formatErrorMessage cause traversal.
    expect(detail).toContain("Cannot find module 'discord.js'");
  });

  it("returns the bare detail when the error is unrelated", () => {
    const detail = describeBundledChannelLoadError(new TypeError("boom"), "whatsapp");
    expect(detail).not.toContain("openclaw doctor --fix");
    expect(detail).toContain("boom");
  });

  it("does not loop on a self-referential cause chain", () => {
    const err = new Error("outer") as Error & { cause?: unknown };
    err.cause = err;
    expect(() => describeBundledChannelLoadError(err, "msteams")).not.toThrow();
  });
});
