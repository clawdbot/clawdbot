import { describe, expect, it } from "vitest";
import {
  resolveToolExecutionErrorKind,
  resolveToolResultFailureKind,
} from "./tool-result-error.js";

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
});
