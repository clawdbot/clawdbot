import { describe, expect, it } from "vitest";
import { cronRunLogEntryFromEvent } from "./task-run-event-codec.js";

describe("cronRunLogEntryFromEvent", () => {
  it("keeps permanent script failures out of run-history timeout classification", () => {
    const entry = cronRunLogEntryFromEvent(
      {
        jobId: "script-job",
        action: "finished",
        status: "error",
        error: "cron script failed after a tool side effect: request timed out",
      },
      1,
      { kind: "permanent" },
    );

    expect(entry.errorReason).toBeUndefined();
  });

  it("preserves explicit script timeout classification in run history", () => {
    const entry = cronRunLogEntryFromEvent(
      {
        jobId: "script-job",
        action: "finished",
        status: "error",
        completionStatus: "failed",
        error: "cron script failed",
      },
      1,
      { kind: "reason", reason: "timeout" },
    );

    expect(entry).toMatchObject({ errorReason: "timeout", completionStatus: "failed" });
  });

  it("leaves trigger undefined for legacy events without the field", () => {
    const entry = cronRunLogEntryFromEvent(
      {
        jobId: "legacy-job",
        action: "finished",
        status: "ok",
      },
      1,
    );

    expect(entry.trigger).toBeUndefined();
  });

  it("preserves explicit trigger field when present", () => {
    const entry = cronRunLogEntryFromEvent(
      {
        jobId: "manual-job",
        action: "finished",
        status: "ok",
        trigger: "manual",
      },
      1,
    );

    expect(entry.trigger).toBe("manual");
  });

  it.each(["stream", "on-exit", "trigger-script"] as const)(
    "preserves trigger=%s from the finished event",
    (trigger) => {
      const entry = cronRunLogEntryFromEvent(
        {
          jobId: `${trigger}-job`,
          action: "finished",
          status: "ok",
          trigger,
        },
        1,
      );

      expect(entry.trigger).toBe(trigger);
    },
  );

  it("leaves completionCause undefined for legacy events without the field", () => {
    const entry = cronRunLogEntryFromEvent(
      {
        jobId: "legacy-job",
        action: "finished",
        status: "ok",
      },
      1,
    );

    expect(entry.completionCause).toBeUndefined();
  });

  it("preserves explicit completionCause field when present", () => {
    const entry = cronRunLogEntryFromEvent(
      {
        jobId: "restart-job",
        action: "finished",
        status: "ok",
        completionCause: "gateway-restart",
      },
      1,
    );

    expect(entry.completionCause).toBe("gateway-restart");
  });
});
