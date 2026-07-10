import { describe, expect, it } from "vitest";
import {
  validateGatewaySuspendPrepareParams,
  validateGatewaySuspendPrepareResult,
  validateGatewaySuspendResumeResult,
  validateGatewaySuspendStatusResult,
} from "./index.js";

describe("gateway suspension protocol", () => {
  it("keeps prepare params closed and bounded", () => {
    expect(validateGatewaySuspendPrepareParams({ requestId: "host-request" })).toBe(true);
    expect(validateGatewaySuspendPrepareParams({ requestId: "   " })).toBe(false);
    expect(validateGatewaySuspendPrepareParams({ requestId: "host-request", extra: true })).toBe(
      false,
    );
  });

  it("validates busy and ready prepare results", () => {
    expect(
      validateGatewaySuspendPrepareResult({
        status: "busy",
        reason: "active-work",
        retryAfterMs: 20_000,
        activeCount: 2,
        blockers: [
          { kind: "queue", count: 1, message: "one queued operation" },
          {
            kind: "task",
            count: 1,
            message: "one active task",
            task: { taskId: "task-1", status: "running", runtime: "subagent" },
          },
        ],
      }),
    ).toBe(true);
    expect(
      validateGatewaySuspendPrepareResult({
        status: "ready",
        suspensionId: "suspension-id",
        expiresAtMs: 123,
        activeCount: 0,
        blockers: [],
      }),
    ).toBe(true);
  });

  it("validates status and resume results", () => {
    expect(validateGatewaySuspendStatusResult({ status: "running" })).toBe(true);
    expect(validateGatewaySuspendStatusResult({ status: "ready", expiresAtMs: 123 })).toBe(true);
    expect(
      validateGatewaySuspendResumeResult({ ok: true, status: "running", resumed: false }),
    ).toBe(true);
    expect(
      validateGatewaySuspendResumeResult({
        ok: true,
        status: "running",
        resumed: false,
        warnings: [],
      }),
    ).toBe(false);
  });

  it("keeps scheduler recovery on the error frame instead of success results", () => {
    const recovering = {
      status: "recovering",
      reason: "scheduler-resume-failed",
      retryAfterMs: 1_000,
    };

    expect(validateGatewaySuspendPrepareResult(recovering)).toBe(false);
    expect(validateGatewaySuspendStatusResult(recovering)).toBe(false);
  });
});
