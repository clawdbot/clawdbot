// Cron run-time display tests cover readable ISO mirrors added for users.
import { describe, expect, it } from "vitest";
import { formatTimestamp } from "../../logging/timestamps.js";
import { defaultRuntime } from "../../runtime.js";
import { printCronJson } from "./shared.js";

function captureCronJson(value: unknown): unknown {
  let written: unknown;
  const original = defaultRuntime.writeJson;
  defaultRuntime.writeJson = (v: unknown) => {
    written = v;
  };
  try {
    printCronJson(value);
  } finally {
    defaultRuntime.writeJson = original;
  }
  return written;
}

describe("printCronJson readable run times", () => {
  it("adds local-offset ISO mirrors for finished run entries without changing raw fields", () => {
    const written = captureCronJson({
      entries: [
        {
          ts: 1_733_551_200_123,
          jobId: "job-1",
          action: "finished",
          status: "ok",
          runAtMs: 1_733_551_200_000,
          nextRunAtMs: 1_733_554_800_000,
        },
      ],
    });
    const entry = (written as { entries: Array<Record<string, unknown>> }).entries[0];
    expect(entry?.tsIso).toBe(formatTimestamp(new Date(1_733_551_200_123), { style: "long" }));
    expect(entry?.runAtIso).toBe(formatTimestamp(new Date(1_733_551_200_000), { style: "long" }));
    expect(entry?.nextRunAtIso).toBe(
      formatTimestamp(new Date(1_733_554_800_000), { style: "long" }),
    );
    // Matches the diagnostic-log `time` shape; raw numeric fields stay intact.
    expect(entry?.tsIso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/);
    expect(entry?.ts).toBe(1_733_551_200_123);
    expect(entry?.runAtMs).toBe(1_733_551_200_000);
    expect(entry?.nextRunAtMs).toBe(1_733_554_800_000);
  });

  it("omits ISO mirrors when numeric timestamps are absent", () => {
    const written = captureCronJson({
      entries: [{ ts: 1_733_551_200_123, jobId: "job-1", action: "finished", status: "ok" }],
    });
    const entry = (written as { entries: Array<Record<string, unknown>> }).entries[0];
    expect(entry?.tsIso).toBeDefined();
    expect(entry?.runAtIso).toBeUndefined();
    expect(entry?.nextRunAtIso).toBeUndefined();
  });

  it("leaves non-run-log entries untouched", () => {
    const written = captureCronJson({ entries: [{ status: "error" }] });
    const entry = (written as { entries: Array<Record<string, unknown>> }).entries[0];
    expect(entry?.tsIso).toBeUndefined();
    expect(entry?.runAtIso).toBeUndefined();
  });
});
