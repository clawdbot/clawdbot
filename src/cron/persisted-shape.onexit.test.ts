// Regression: on-exit jobs must pass the persisted-shape validator (else they
// cannot be saved to the cron store or survive a gateway restart).
import { describe, expect, it } from "vitest";
import { getInvalidPersistedCronJobReason } from "./persisted-shape.js";

function onExitCandidate(overrides: Record<string, unknown> = {}) {
  return {
    id: "job-1",
    schedule: { kind: "on-exit", command: "make build" },
    payload: { kind: "systemEvent", text: "done" },
    sessionTarget: "main",
    ...overrides,
  };
}

describe("getInvalidPersistedCronJobReason on-exit", () => {
  it("accepts a well-formed on-exit job", () => {
    expect(getInvalidPersistedCronJobReason(onExitCandidate())).toBeNull();
  });

  it("rejects an on-exit job with an empty/missing command", () => {
    expect(
      getInvalidPersistedCronJobReason(
        onExitCandidate({ schedule: { kind: "on-exit", command: "" } }),
      ),
    ).toBe("invalid-schedule");
    expect(
      getInvalidPersistedCronJobReason(onExitCandidate({ schedule: { kind: "on-exit" } })),
    ).toBe("invalid-schedule");
  });

  it("still rejects genuinely unknown schedule kinds", () => {
    expect(
      getInvalidPersistedCronJobReason(onExitCandidate({ schedule: { kind: "whenever" } })),
    ).toBe("invalid-schedule");
  });
});
