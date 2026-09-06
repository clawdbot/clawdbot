import { describe, expect, it } from "vitest";
import { cronFailureDetailLines } from "./failure-notification-text.js";
import type { CronTriggerFailureCode } from "./types.js";

const GENERIC_DETAIL = "Check automation history for details.";

const SCRIPT_FAILURE_COPY = {
  aborted: "was aborted",
  invalid_input: "received invalid input",
  runtime_unavailable: "runtime is unavailable",
  timeout: "timed out",
  output_limit_exceeded: "exceeded its output limit",
  snapshot_limit_exceeded: "exceeded its state limit",
  internal_error: "failed internally",
  tool_budget_exceeded: "exceeded its tool budget",
} satisfies Record<CronTriggerFailureCode, string>;

describe("cronFailureDetailLines", () => {
  it.each(["timeout", "rate_limit"] as const)("keeps classified %s failures compact", (reason) => {
    expect(cronFailureDetailLines(reason, { kind: "command-exit", exitCode: 7 })).toEqual([
      `Cause: ${reason}`,
    ]);
  });

  it.each([
    [{ kind: "command-exit", exitCode: 7 } as const, "Cause: command exited with code 7"],
    [{ kind: "command-timeout", mode: "wall-clock" } as const, "Cause: command timed out"],
    [
      { kind: "command-timeout", mode: "no-output" } as const,
      "Cause: command stopped after producing no output",
    ],
  ])("renders closed command detail %#", (detail, expected) => {
    expect(cronFailureDetailLines(undefined, detail)).toEqual([expected]);
  });

  it.each(Object.entries(SCRIPT_FAILURE_COPY) as Array<[CronTriggerFailureCode, string]>)(
    "renders closed script failure %s",
    (code, copy) => {
      expect(
        cronFailureDetailLines(undefined, { kind: "script-failure", source: "payload", code }),
      ).toEqual([`Cause: automation script ${copy}`]);
      expect(
        cronFailureDetailLines(undefined, { kind: "script-failure", source: "trigger", code }),
      ).toEqual([`Cause: trigger script ${copy}`]);
    },
  );

  it("uses the generic fallback without a classified or producer-authored fact", () => {
    expect(cronFailureDetailLines(undefined)).toEqual([GENERIC_DETAIL]);
  });
});
