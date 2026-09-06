import { describe, expect, it } from "vitest";
import type { EmbeddedAgentCompactResult } from "../embedded-agent-runner/types.js";
import {
  isNativeHarnessBindingRecoverySkip,
  isRecoverableNativeHarnessBindingFailure,
} from "./compaction-recovery.js";

function failure(overrides: Partial<EmbeddedAgentCompactResult>): EmbeddedAgentCompactResult {
  return { ok: false, compacted: false, ...overrides };
}

describe("isRecoverableNativeHarnessBindingFailure", () => {
  it.each([
    failure({ failure: { reason: "missing_thread_binding" } }),
    failure({ failure: { reason: "stale_thread_binding" } }),
    failure({ reason: "thread not found: <id>" }),
    failure({ reason: "no thread binding for session" }),
    failure({ reason: "STALE_THREAD_BINDING" }),
    // Structured failure reason is recognized even when the display reason is not.
    failure({ reason: "auth profile mismatch", failure: { reason: "stale_thread_binding" } }),
  ])("recognizes recoverable binding failure %#", (result) => {
    expect(isRecoverableNativeHarnessBindingFailure(result)).toBe(true);
  });

  it.each([
    failure({ reason: "native compaction unavailable", failure: { reason: "native_unavailable" } }),
    failure({ reason: "auth profile mismatch" }),
    failure({}),
    { ok: true, compacted: false, reason: "thread not found" } as EmbeddedAgentCompactResult,
    undefined,
  ])("does not recognize non-recoverable result %#", (result) => {
    expect(isRecoverableNativeHarnessBindingFailure(result)).toBe(false);
  });
});

describe("isNativeHarnessBindingRecoverySkip", () => {
  it("is true only when the authenticated marker is present", () => {
    expect(
      isNativeHarnessBindingRecoverySkip(failure({ nativeHarnessBindingRecovery: true })),
    ).toBe(true);
    expect(
      isNativeHarnessBindingRecoverySkip(failure({ failure: { reason: "stale_thread_binding" } })),
    ).toBe(false);
    expect(isNativeHarnessBindingRecoverySkip(undefined)).toBe(false);
  });
});
