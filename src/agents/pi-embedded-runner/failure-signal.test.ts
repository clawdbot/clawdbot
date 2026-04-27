import { describe, expect, it } from "vitest";
import { resolveEmbeddedRunFailureSignal } from "./failure-signal.js";

describe("resolveEmbeddedRunFailureSignal", () => {
  it("classifies cron exec denials from tool error metadata", () => {
    expect(
      resolveEmbeddedRunFailureSignal({
        trigger: "cron",
        lastToolError: {
          toolName: "exec",
          error: "SYSTEM_RUN_DENIED: approval required",
        },
      }),
    ).toEqual({
      kind: "execution_denied",
      source: "tool",
      toolName: "exec",
      code: "SYSTEM_RUN_DENIED",
      message: "SYSTEM_RUN_DENIED: approval required",
      fatalForCron: true,
    });
  });

  it("classifies invalid request denials from tool error metadata", () => {
    expect(
      resolveEmbeddedRunFailureSignal({
        trigger: "cron",
        lastToolError: {
          toolName: "bash",
          error: "INVALID_REQUEST: approval denied",
        },
      })?.code,
    ).toBe("INVALID_REQUEST");
  });

  it("does not mark non-cron runs", () => {
    expect(
      resolveEmbeddedRunFailureSignal({
        trigger: "user",
        lastToolError: {
          toolName: "exec",
          error: "SYSTEM_RUN_DENIED: approval required",
        },
      }),
    ).toBeUndefined();
  });

  it("does not mark ordinary tool failures as cron-denial failures", () => {
    expect(
      resolveEmbeddedRunFailureSignal({
        trigger: "cron",
        lastToolError: {
          toolName: "exec",
          error: "/bin/bash: line 1: python: command not found",
        },
      }),
    ).toBeUndefined();
  });

  it("does not mark non-exec validation errors as execution denials", () => {
    expect(
      resolveEmbeddedRunFailureSignal({
        trigger: "cron",
        lastToolError: {
          toolName: "browser",
          error: "INVALID_REQUEST: url required",
        },
      }),
    ).toBeUndefined();
  });

  it("does not mark non-exec tool output that merely mentions host denial tokens", () => {
    expect(
      resolveEmbeddedRunFailureSignal({
        trigger: "cron",
        lastToolError: {
          toolName: "web_fetch",
          error: "The fetched page says SYSTEM_RUN_DENIED in its troubleshooting section.",
        },
      }),
    ).toBeUndefined();
  });

  it("infers approval-binding denials even when the host code is omitted", () => {
    expect(
      resolveEmbeddedRunFailureSignal({
        trigger: "cron",
        lastToolError: {
          toolName: "exec",
          error: "Approval cannot safely bind this interpreter/runtime command",
        },
      })?.code,
    ).toBe("SYSTEM_RUN_DENIED");
  });
});
