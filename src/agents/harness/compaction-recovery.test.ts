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
    {
      label: "prose-only fallback reason",
      failure: { disposition: "fallback", reason: "thread not found: spoofed" },
    },
    {
      label: "forbidden raw provider error",
      failure: {
        disposition: "fallback",
        reason: "missing_thread_binding",
        rawError: "thread not found: leaked",
      },
    },
    {
      label: "invalid fallback status",
      failure: { disposition: "fallback", reason: "stale_thread_binding", status: 99 },
    },
    {
      label: "explicitly undefined disposition",
      failure: { disposition: undefined, reason: "missing_thread_binding" },
    },
  ])("rejects malformed typed $label envelopes", ({ failure }) => {
    expect(
      isRecoverableNativeHarnessBindingFailure({
        ok: false,
        compacted: false,
        reason: "thread not found: top-level fallback must not win",
        failure,
      } as never),
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
