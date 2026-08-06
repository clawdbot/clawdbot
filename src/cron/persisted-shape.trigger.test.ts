import { describe, expect, it } from "vitest";
import { getInvalidPersistedCronJobReason } from "./persisted-shape.js";

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    id: "job-1",
    schedule: { kind: "every", everyMs: 30_000 },
    trigger: { script: "json({ fire: true })" },
    payload: { kind: "systemEvent", text: "changed" },
    sessionTarget: "main",
    ...overrides,
  };
}

describe("persisted cron trigger shape", () => {
  it("accepts a non-empty trigger on recurring schedules", () => {
    expect(getInvalidPersistedCronJobReason(candidate())).toBeNull();
    expect(
      getInvalidPersistedCronJobReason(
        candidate({ schedule: { kind: "cron", expr: "* * * * *" } }),
      ),
    ).toBeNull();
  });

  it("rejects empty scripts and non-object triggers", () => {
    expect(getInvalidPersistedCronJobReason(candidate({ trigger: { script: "  " } }))).toBe(
      "invalid-trigger",
    );
    expect(getInvalidPersistedCronJobReason(candidate({ trigger: "script" }))).toBe(
      "invalid-trigger",
    );
  });

  it("rejects triggers on at and on-exit schedules", () => {
    expect(
      getInvalidPersistedCronJobReason(
        candidate({ schedule: { kind: "at", at: "2026-08-01T00:00:00.000Z" } }),
      ),
    ).toBe("invalid-trigger");
    expect(
      getInvalidPersistedCronJobReason(
        candidate({ schedule: { kind: "on-exit", command: "make build" } }),
      ),
    ).toBe("invalid-trigger");
  });
});
