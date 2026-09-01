import { spawnSync } from "node:child_process";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const SCRIPT = resolve("scripts/verify-full-release-producer-job.mjs");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const expectedJob = {
  conclusion: "success",
  id: 123,
  name: "Prepare shared Docker E2E image",
  run_attempt: 2,
  run_id: 456,
  status: "completed",
};

function runVerification(job: Record<string, unknown>) {
  const binDir = tempDirs.make("verify-full-release-producer-job-");
  const callsPath = join(binDir, "gh-calls.argv");
  const ghPath = join(binDir, "gh");
  writeFileSync(
    ghPath,
    `#!/bin/sh
set -eu
printf '%s\\0' "$@" > "$MOCK_GH_CALLS"
printf '%s' "$MOCK_JOB_JSON"
`,
  );
  chmodSync(ghPath, 0o755);
  const result = spawnSync(
    process.execPath,
    [
      SCRIPT,
      "--repository",
      "openclaw/openclaw",
      "--job-id",
      "123",
      "--job-name",
      expectedJob.name,
      "--run-id",
      "456",
      "--run-attempt",
      "2",
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        MOCK_GH_CALLS: callsPath,
        MOCK_JOB_JSON: JSON.stringify(job),
        PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
      },
      timeout: 10_000,
    },
  );
  return { callsPath, result };
}

describe.skipIf(process.platform === "win32")("full release producer job verification", () => {
  it("accepts the exact completed successful producer job", () => {
    const { callsPath, result } = runVerification(expectedJob);
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(callsPath, "utf8").split("\0").slice(0, -1)).toEqual([
      "api",
      "repos/openclaw/openclaw/actions/jobs/123",
    ]);
  });

  it.each([
    ["job ID", { id: 124 }, "producer job ID mismatch"],
    ["job name", { name: "Different producer" }, "producer job name mismatch"],
    ["run ID", { run_id: 457 }, "producer run ID mismatch"],
    ["run attempt", { run_attempt: 3 }, "producer run attempt mismatch"],
    ["completed status", { status: "in_progress" }, "producer job status mismatch"],
    ["failure conclusion", { conclusion: "failure" }, "producer job conclusion mismatch"],
    ["cancelled conclusion", { conclusion: "cancelled" }, "producer job conclusion mismatch"],
    ["timed_out conclusion", { conclusion: "timed_out" }, "producer job conclusion mismatch"],
    ["skipped conclusion", { conclusion: "skipped" }, "producer job conclusion mismatch"],
  ])("rejects a mismatched %s", (_label, override, message) => {
    const { result } = runVerification({ ...expectedJob, ...override });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
  });
});
