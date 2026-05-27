import { describe, expect, it } from "vitest";
import { defaultRuntime } from "../../runtime.js";
import { printCronJson } from "./shared.js";

describe("printCronJson cause display", () => {
  it("adds an additive cause without changing raw cron run errors", () => {
    let written: unknown;
    const original = defaultRuntime.writeJson;
    defaultRuntime.writeJson = (value: unknown) => {
      written = value;
    };
    try {
      printCronJson({
        entries: [
          {
            ts: 1,
            jobId: "job-1",
            action: "finished",
            status: "error",
            errorReason: "timeout",
            error: "cron: job execution timed out",
          },
        ],
      });
    } finally {
      defaultRuntime.writeJson = original;
    }

    const result = written as { entries: Array<Record<string, unknown>> };
    expect(result.entries[0]?.cause).toBe("timeout");
    expect(result.entries[0]?.error).toBe("cron: job execution timed out");
    expect(result.entries[0]?.errorReason).toBe("timeout");
  });

  it("does not add cause fields to non-run-log entries", () => {
    let written: unknown;
    const original = defaultRuntime.writeJson;
    defaultRuntime.writeJson = (value: unknown) => {
      written = value;
    };
    try {
      printCronJson({
        entries: [{ errorReason: "timeout", status: "error" }],
      });
    } finally {
      defaultRuntime.writeJson = original;
    }

    const result = written as { entries: Array<Record<string, unknown>> };
    expect(result.entries[0]?.cause).toBeUndefined();
  });
});
