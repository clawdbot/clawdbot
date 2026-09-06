import type { UpdateRunRecord } from "../../../src/infra/update-run-record.ts";

export function createUpdateRunFixture(patch: Partial<UpdateRunRecord> = {}): UpdateRunRecord {
  return {
    runId: "6631ecee-adbf-41e8-a0e3-1b88b28b0a59",
    createdAtMs: 1,
    updatedAtMs: 2,
    trigger: "control-ui",
    phase: "staging",
    status: "running",
    reason: null,
    origin: {},
    target: { kind: "package", version: "2026.9.2" },
    before: { version: "2026.9.1" },
    after: {},
    steps: [
      { step: "requested", status: "completed" },
      { step: "staging", status: "in_progress" },
    ],
    verification: {},
    repair: [],
    confirmedAtMs: null,
    finishedAtMs: null,
    downtimeMs: null,
    ...patch,
  };
}
