import { describe, expect, it } from "vitest";
import { isRecoverableNativeHarnessBindingFailure } from "./compaction-recovery.js";

describe("native harness compaction recovery", () => {
  it.each(["missing_thread_binding", "stale_thread_binding"] as const)(
    "accepts typed %s owner fallback",
    (reason) => {
      expect(
        isRecoverableNativeHarnessBindingFailure({
          ok: false,
          compacted: false,
          failure: { disposition: "fallback", reason },
        }),
      ).toBe(true);
    },
  );

  it("does not reinterpret typed terminal or retryable failures as owner fallback", () => {
    expect(
      isRecoverableNativeHarnessBindingFailure({
        ok: false,
        compacted: false,
        reason: "thread not found",
        failure: { disposition: "terminal", reason: "unknown" },
      }),
    ).toBe(false);
    expect(
      isRecoverableNativeHarnessBindingFailure({
        ok: false,
        compacted: false,
        reason: "thread not found",
        failure: { disposition: "retryable", reason: "timeout" },
      }),
    ).toBe(false);
  });

  it.each([
    { failure: { reason: "missing_thread_binding" } },
    { reason: "thread not found: legacy-thread" },
  ])("keeps the released untyped binding fallback: %j", (legacy) => {
    expect(
      isRecoverableNativeHarnessBindingFailure({
        ok: false,
        compacted: false,
        ...legacy,
      }),
    ).toBe(true);
  });
});
