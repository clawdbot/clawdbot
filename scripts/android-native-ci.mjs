#!/usr/bin/env node

import { readFileSync, realpathSync } from "node:fs";
import { validateReleaseChildRunProvenance } from "./full-release-validation-policy.mjs";
import { isDirectRunUrl } from "./lib/direct-run.mjs";
import { isRecord } from "./lib/record-shared.mjs";
import { runReleaseToolingGh } from "./release-tooling-identity.mjs";

export function verifyAndroidNativeCi(approval, { runGh = runReleaseToolingGh } = {}) {
  // Stable v2026.8.2's tag-owned publisher consumes v2 approvals from full FRV.
  // The npm-only policy requires v3 so its separate native proof survives dispatch.
  if (approval.version === 2 && approval.nativeCi === undefined) {
    return;
  }
  const nativeCi = approval.nativeCi;
  if (
    approval.version !== 3 ||
    !isRecord(nativeCi) ||
    Object.keys(nativeCi).length !== 3 ||
    typeof nativeCi.runId !== "string" ||
    !/^[1-9][0-9]*$/u.test(nativeCi.runId) ||
    nativeCi.runAttempt !== 1 ||
    typeof nativeCi.workflowRef !== "string" ||
    nativeCi.workflowRef.length === 0
  ) {
    throw new Error("Android approval requires an exact native CI qualification tuple.");
  }
  const run = JSON.parse(
    runGh([
      "api",
      `repos/${approval.repository}/actions/runs/${nativeCi.runId}`,
      "--method",
      "GET",
    ]),
  );
  const proof = validateReleaseChildRunProvenance(run, {
    key: "nativeAndroid",
    plannedRunAttempt: nativeCi.runAttempt,
    repository: approval.repository,
    runId: nativeCi.runId,
    workflow: "ci.yml",
    displayTitle: `CI release-native-android-${approval.parentRunId}-${approval.parentRunAttempt}-${approval.targetSha}`,
    workflowRef: nativeCi.workflowRef,
    workflowSha: approval.parentWorkflowSha,
  });
  if (
    proof.effectiveRunAttempt !== nativeCi.runAttempt ||
    run.status !== "completed" ||
    run.conclusion !== "success"
  ) {
    throw new Error("Android approval requires the exact completed successful native CI attempt.");
  }
}

// Isolated release harnesses can invoke the verifier through a scripts symlink.
if (process.argv[1] && isDirectRunUrl(realpathSync(process.argv[1]), import.meta.url)) {
  verifyAndroidNativeCi(JSON.parse(readFileSync(process.argv[2], "utf8")));
}
