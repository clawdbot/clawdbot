#!/usr/bin/env node
// Validates that a referenced release-publish workflow run is usable for approval.
import fs from "node:fs";

const run = JSON.parse(fs.readFileSync(0, "utf8"));

const releasePublishRunId = process.env.RELEASE_PUBLISH_RUN_ID ?? "";
const expectedBranch = process.env.EXPECTED_WORKFLOW_BRANCH ?? "";
const directRecovery = process.env.DIRECT_RELEASE_RECOVERY === "true";

const checks = [
  ["workflowName", "OpenClaw Release Publish"],
  ["headBranch", expectedBranch],
  ["event", "workflow_dispatch"],
];

for (const [key, expected] of checks) {
  if (run[key] !== expected) {
    console.error(
      `Referenced release publish run ${releasePublishRunId} must have ${key}=${expected}, got ${run[key] ?? "<missing>"}.`,
    );
    process.exit(1);
  }
}

if (!directRecovery) {
  if (run.status !== "in_progress") {
    console.error(
      `Referenced release publish run ${releasePublishRunId} must still be in_progress, got ${run.status ?? "<missing>"}.`,
    );
    process.exit(1);
  }
  if (run.conclusion) {
    console.error(
      `Referenced release publish run ${releasePublishRunId} already concluded ${run.conclusion}.`,
    );
    process.exit(1);
  }
  console.log(`Using release publish approval run ${releasePublishRunId}: ${run.url}`);
  process.exit(0);
}

if (run.status === "in_progress" && !run.conclusion) {
  console.log(`Using active release publish run ${releasePublishRunId}: ${run.url}`);
  process.exit(0);
}

if (run.status === "completed" && ["success", "failure"].includes(run.conclusion)) {
  console.log(
    `Using completed release publish run ${releasePublishRunId} (${run.conclusion}) for direct recovery: ${run.url}`,
  );
  process.exit(0);
}

console.error(
  `Direct release recovery run ${releasePublishRunId} must be in_progress or completed with success/failure, got status=${run.status ?? "<missing>"} conclusion=${run.conclusion ?? "<missing>"}.`,
);
process.exit(1);
