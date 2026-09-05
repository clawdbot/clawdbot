import { createUpdateRunFixture as createRun } from "../test-helpers/update-run.ts";

export function createUpdateRunFixture() {
  const now = Date.now();
  return createRun({
    createdAtMs: now,
    updatedAtMs: now,
    target: { channel: "stable", kind: "package", version: "2.0.0" },
    before: { version: "1.0.0" },
    steps: [
      { step: "requested", status: "completed", startedAtMs: now - 1000, endedAtMs: now },
      {
        step: "staging",
        status: "in_progress",
        startedAtMs: now,
        detail: "Downloading the update package.\nChecking package integrity.",
      },
    ],
  });
}
