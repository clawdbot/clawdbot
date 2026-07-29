import { describe, expect, it } from "vitest";
import {
  isToolResultError,
  resolveToolExecutionErrorKind,
  resolveToolResultFailureKind,
} from "./tool-result-error.js";

describe("isToolResultError", () => {
  it("keeps completed results with nonzero exit codes nonfatal", () => {
    expect(isToolResultError({ details: { status: "completed", exitCode: 1 } })).toBe(false);
    expect(isToolResultError({ details: { status: "completed", exitCode: 2 } })).toBe(false);
    expect(isToolResultError({ details: { status: "completed", exitCode: 0 } })).toBe(false);
  });

  it("keeps real failures fatal even with a completed status", () => {
    expect(isToolResultError({ details: { status: "completed", timedOut: true } })).toBe(true);
    expect(isToolResultError({ details: { status: "completed", error: "spawn failed" } })).toBe(
      true,
    );
    expect(isToolResultError({ details: { ok: false, status: "completed" } })).toBe(true);
  });

  it("keeps failure statuses and statusless nonzero exits fatal", () => {
    expect(isToolResultError({ details: { status: "failed", exitCode: 1 } })).toBe(true);
    expect(isToolResultError({ details: { status: "failed", exitCode: 127 } })).toBe(true);
    expect(isToolResultError({ details: { status: "killed", exitCode: 137 } })).toBe(true);
    expect(isToolResultError({ details: { exitCode: 1 } })).toBe(true);
  });
});

describe("resolveToolExecutionErrorKind", () => {
  it("recognizes structured timeout identities", () => {
    expect(
      resolveToolExecutionErrorKind(
        Object.assign(new Error("deadline elapsed"), { name: "TimeoutError" }),
      ),
    ).toBe("timed_out");
    expect(resolveToolExecutionErrorKind({ code: "ETIMEDOUT" })).toBe("timed_out");
    expect(resolveToolExecutionErrorKind({ reason: "timeout" })).toBe("timed_out");
  });

  it("does not infer timeout from validation text", () => {
    expect(resolveToolExecutionErrorKind(new Error("timeoutMs must be a positive number"))).toBe(
      "failed",
    );
  });

  it("contains hostile error fields", () => {
    const hostile = Object.defineProperty({}, "name", {
      get() {
        throw new Error("name getter escaped");
      },
    });
    expect(resolveToolExecutionErrorKind(hostile)).toBe("failed");
  });
});

describe("resolveToolResultFailureKind", () => {
  it("contains hostile structured result fields", () => {
    const hostileDetails = new Proxy(
      {},
      {
        has() {
          throw new Error("details field check escaped");
        },
        get() {
          throw new Error("details field getter escaped");
        },
      },
    );
    const hostileResult = Object.defineProperty({}, "details", {
      get() {
        throw new Error("details getter escaped");
      },
    });

    expect(resolveToolResultFailureKind({ details: hostileDetails })).toBeUndefined();
    expect(resolveToolResultFailureKind(hostileResult)).toBeUndefined();
  });

  it("does not classify completed nonzero exits as failures", () => {
    expect(
      resolveToolResultFailureKind({ details: { status: "completed", exitCode: 1 } }),
    ).toBeUndefined();
    expect(resolveToolResultFailureKind({ details: { status: "failed", exitCode: 1 } })).toBe(
      "failed",
    );
  });
});
