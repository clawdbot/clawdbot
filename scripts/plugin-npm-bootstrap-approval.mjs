import { parseReleaseVersion } from "./lib/release-version.mjs";

const SHA = /^[a-f0-9]{40}$/u;
const PACKAGE = /^@openclaw\/[a-z0-9][a-z0-9._-]*$/u;

export function createStablePluginNpmBootstrapApproval(input) {
  const version = typeof input.releaseTag === "string" ? input.releaseTag.slice(1) : "";
  const parsed = parseReleaseVersion(version);
  if (
    input.releaseTag !== `v${version}` ||
    parsed?.channel !== "stable" ||
    parsed.patch >= 33 ||
    input.publishTag !== "latest" ||
    !["stable", "full"].includes(input.releaseProfile)
  ) {
    throw new Error(
      "Stable npm bootstrap requires a regular stable tag, latest, and stable/full validation.",
    );
  }
  if (
    input.repository !== "openclaw/openclaw" ||
    !SHA.test(input.targetSha ?? "") ||
    !SHA.test(input.parentWorkflowSha ?? "") ||
    !new RegExp(`^release-publish/${input.parentWorkflowSha.slice(0, 12)}-[1-9][0-9]*$`, "u").test(
      input.workflowBranch,
    ) ||
    input.workflowFullRef !== `refs/tags/${input.workflowBranch}` ||
    !/^[1-9][0-9]*$/u.test(input.parentRunId ?? "") ||
    !Number.isSafeInteger(input.parentRunAttempt) ||
    input.parentRunAttempt < 1 ||
    !/^[1-9][0-9]*$/u.test(input.validationRunId ?? "") ||
    !Number.isSafeInteger(input.validationRunAttempt) ||
    input.validationRunAttempt < 1
  ) {
    throw new Error(
      "Stable npm bootstrap requires an exact protected parent and validation tuple.",
    );
  }
  if (
    !Array.isArray(input.packages) ||
    input.packages.length === 0 ||
    input.packages.some((name) => typeof name !== "string" || !PACKAGE.test(name)) ||
    new Set(input.packages).size !== input.packages.length
  ) {
    throw new Error("Stable npm bootstrap requires a unique publishable @openclaw package set.");
  }
  return {
    version: 1,
    kind: "npm-stable-bootstrap",
    repository: input.repository,
    parentRunId: input.parentRunId,
    parentRunAttempt: input.parentRunAttempt,
    workflowBranch: input.workflowBranch,
    workflowFullRef: input.workflowFullRef,
    parentWorkflowSha: input.parentWorkflowSha,
    releaseTag: input.releaseTag,
    targetSha: input.targetSha,
    publishTag: input.publishTag,
    releaseProfile: input.releaseProfile,
    validationRunId: input.validationRunId,
    validationRunAttempt: input.validationRunAttempt,
    packages: input.packages.toSorted(),
  };
}

export function validateStablePluginNpmBootstrapApproval(approval, expected) {
  const canonical = createStablePluginNpmBootstrapApproval(approval);
  if (JSON.stringify(approval) !== JSON.stringify(canonical)) {
    throw new Error("Stable npm bootstrap approval is not canonical.");
  }
  for (const key of [
    "repository",
    "parentRunId",
    "parentRunAttempt",
    "workflowBranch",
    "workflowFullRef",
    "parentWorkflowSha",
    "targetSha",
    "publishTag",
  ]) {
    if (approval[key] !== expected[key]) {
      throw new Error(`Stable npm bootstrap approval ${key} does not match this publication.`);
    }
  }
  if (
    approval.releaseTag !== `v${expected.packageVersion}` ||
    !approval.packages.includes(expected.packageName)
  ) {
    throw new Error("Stable npm bootstrap approval does not cover this package and version.");
  }
}
