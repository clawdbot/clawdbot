// Validate release publish approval tests cover the stdin/env CLI contract.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const SCRIPT_PATH = "scripts/validate-release-publish-approval.mjs";
const tempRoots = useAutoCleanupTempDirTracker(afterEach);

function runApprovalScript(
  run: Record<string, unknown>,
  env: {
    CHILD_WORKFLOW_SHA?: string;
    DIRECT_RELEASE_RECOVERY?: string;
    EXPECTED_WORKFLOW_BRANCH?: string;
    EXPECTED_RUN_ATTEMPT?: string;
    APPROVAL_PATH?: string;
    GITHUB_REPOSITORY?: string;
    RELEASE_APPROVAL_KIND?: string;
    RELEASE_PACKAGES?: string;
    RELEASE_TAG?: string;
    RELEASE_PUBLISH_RUN_ID?: string;
    RELEASE_TARGET_SHA?: string;
  } = {},
) {
  return spawnSync(process.execPath, [SCRIPT_PATH], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      CHILD_WORKFLOW_SHA: env.CHILD_WORKFLOW_SHA ?? "b".repeat(40),
      DIRECT_RELEASE_RECOVERY: env.DIRECT_RELEASE_RECOVERY ?? "false",
      EXPECTED_WORKFLOW_BRANCH: env.EXPECTED_WORKFLOW_BRANCH ?? "release/2026.6.21",
      EXPECTED_RUN_ATTEMPT: env.EXPECTED_RUN_ATTEMPT ?? "",
      APPROVAL_PATH: env.APPROVAL_PATH ?? "",
      GITHUB_REPOSITORY: env.GITHUB_REPOSITORY ?? "openclaw/openclaw",
      RELEASE_APPROVAL_KIND: env.RELEASE_APPROVAL_KIND ?? "android",
      RELEASE_PACKAGES: env.RELEASE_PACKAGES ?? "",
      RELEASE_TAG: env.RELEASE_TAG ?? "v2026.6.21",
      RELEASE_PUBLISH_RUN_ID: env.RELEASE_PUBLISH_RUN_ID ?? "123",
      RELEASE_TARGET_SHA: env.RELEASE_TARGET_SHA ?? "a".repeat(40),
    },
    input: JSON.stringify(run),
  });
}

function writeApproval(overrides: Record<string, unknown> = {}) {
  const tempRoot = tempRoots.make("openclaw-release-approval-");
  const approvalPath = path.join(tempRoot, "approval.json");
  fs.writeFileSync(
    approvalPath,
    `${JSON.stringify({
      version: 1,
      repository: "openclaw/openclaw",
      workflow: "OpenClaw Release Publish",
      parentRunId: "123",
      workflowBranch: "release/2026.6.21",
      releaseTag: "v2026.6.21",
      targetSha: "a".repeat(40),
      ...overrides,
    })}\n`,
  );
  return approvalPath;
}

function approvalRun(overrides: Record<string, unknown> = {}) {
  return {
    conclusion: null,
    event: "workflow_dispatch",
    headBranch: "release/2026.6.21",
    status: "in_progress",
    url: "https://github.com/openclaw/openclaw/actions/runs/123",
    workflowName: "OpenClaw Release Publish",
    ...overrides,
  };
}

function writeClawHubApproval(overrides: Record<string, unknown> = {}) {
  const tempRoot = tempRoots.make("openclaw-clawhub-bootstrap-approval-");
  const approvalPath = path.join(tempRoot, "approval.json");
  fs.writeFileSync(
    approvalPath,
    `${JSON.stringify({
      version: 2,
      kind: "clawhub-bootstrap",
      repository: "openclaw/openclaw",
      workflow: "OpenClaw Release Publish",
      parentRunId: "123",
      parentRunAttempt: 2,
      workflowBranch: "main",
      parentWorkflowSha: "d".repeat(40),
      bootstrapWorkflowSha: "b".repeat(40),
      releaseTag: "v2026.7.1-beta.3",
      targetSha: "a".repeat(40),
      packages: ["@openclaw/meta-provider", "@openclaw/voice-call"],
      ...overrides,
    })}\n`,
  );
  return approvalPath;
}

describe("scripts/validate-release-publish-approval.mjs", () => {
  it("accepts an in-progress release publish workflow run for approval", () => {
    const result = runApprovalScript(approvalRun());

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "Using release publish approval run 123: https://github.com/openclaw/openclaw/actions/runs/123",
    );
    expect(result.stderr).toBe("");
  });

  it("rejects approval runs from the wrong workflow branch", () => {
    const result = runApprovalScript(approvalRun({ headBranch: "main" }));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "Referenced release publish run 123 must have headBranch=release/2026.6.21, got main.",
    );
    expect(result.stdout).toBe("");
  });

  it("rejects completed runs for normal approval handoff", () => {
    const result = runApprovalScript(approvalRun({ conclusion: "success", status: "completed" }));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "Referenced release publish run 123 must still be in_progress, got completed.",
    );
    expect(result.stdout).toBe("");
  });

  it("accepts an exact attested Android release approval", () => {
    const approvalPath = writeApproval();

    const result = runApprovalScript(approvalRun(), { APPROVAL_PATH: approvalPath });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("accepts an exact attested ClawHub bootstrap parent tuple", () => {
    const approvalPath = writeClawHubApproval();
    const result = runApprovalScript(
      approvalRun({
        headBranch: "main",
        headSha: "d".repeat(40),
        runAttempt: 2,
      }),
      {
        APPROVAL_PATH: approvalPath,
        EXPECTED_WORKFLOW_BRANCH: "main",
        EXPECTED_RUN_ATTEMPT: "2",
        RELEASE_APPROVAL_KIND: "clawhub-bootstrap",
        RELEASE_PACKAGES: "@openclaw/voice-call,@openclaw/meta-provider",
        RELEASE_TAG: "v2026.7.1-beta.3",
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("accepts a child workflow SHA that differs from the approving parent tooling", () => {
    const approvalPath = writeClawHubApproval();
    const result = runApprovalScript(
      approvalRun({
        headBranch: "main",
        headSha: "d".repeat(40),
        runAttempt: 2,
      }),
      {
        APPROVAL_PATH: approvalPath,
        EXPECTED_WORKFLOW_BRANCH: "main",
        EXPECTED_RUN_ATTEMPT: "2",
        RELEASE_APPROVAL_KIND: "clawhub-bootstrap",
        RELEASE_PACKAGES: "@openclaw/meta-provider,@openclaw/voice-call",
        RELEASE_TAG: "v2026.7.1-beta.3",
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("rejects a child workflow SHA that differs from the attested bootstrap tooling", () => {
    const approvalPath = writeClawHubApproval();
    const result = runApprovalScript(
      approvalRun({
        headBranch: "main",
        headSha: "d".repeat(40),
        runAttempt: 2,
      }),
      {
        APPROVAL_PATH: approvalPath,
        CHILD_WORKFLOW_SHA: "c".repeat(40),
        EXPECTED_WORKFLOW_BRANCH: "main",
        EXPECTED_RUN_ATTEMPT: "2",
        RELEASE_APPROVAL_KIND: "clawhub-bootstrap",
        RELEASE_PACKAGES: "@openclaw/meta-provider,@openclaw/voice-call",
        RELEASE_TAG: "v2026.7.1-beta.3",
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "Attested ClawHub bootstrap approval does not match this release target and package set.",
    );
  });

  it("rejects a ClawHub bootstrap handoff without an attested approval artifact", () => {
    const result = runApprovalScript(
      approvalRun({
        headBranch: "main",
        headSha: "d".repeat(40),
        runAttempt: 2,
      }),
      {
        EXPECTED_WORKFLOW_BRANCH: "main",
        EXPECTED_RUN_ATTEMPT: "2",
        RELEASE_APPROVAL_KIND: "clawhub-bootstrap",
        RELEASE_PACKAGES: "@openclaw/meta-provider,@openclaw/voice-call",
        RELEASE_TAG: "v2026.7.1-beta.3",
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "ClawHub bootstrap approval requires an attested approval artifact.",
    );
  });

  it.each([
    ["release tag", { releaseTag: "v2026.7.1-beta.2" }, {}],
    ["target SHA", { targetSha: "c".repeat(40) }, {}],
    ["package set", { packages: ["@openclaw/meta-provider"] }, {}],
    ["parent attempt", { parentRunAttempt: 1 }, {}],
    ["parent workflow SHA", { parentWorkflowSha: "c".repeat(40) }, {}],
    ["bootstrap workflow SHA", { bootstrapWorkflowSha: "c".repeat(40) }, {}],
    ["extra field", { unexpected: true }, {}],
    ["requested attempt", {}, { EXPECTED_RUN_ATTEMPT: "3" }],
  ])("rejects a ClawHub bootstrap approval for another %s", (_name, overrides, envOverrides) => {
    const approvalPath = writeClawHubApproval(overrides);
    const result = runApprovalScript(
      approvalRun({
        headBranch: "main",
        headSha: "d".repeat(40),
        runAttempt: 2,
      }),
      {
        APPROVAL_PATH: approvalPath,
        EXPECTED_WORKFLOW_BRANCH: "main",
        EXPECTED_RUN_ATTEMPT: "2",
        RELEASE_APPROVAL_KIND: "clawhub-bootstrap",
        RELEASE_PACKAGES: "@openclaw/meta-provider,@openclaw/voice-call",
        RELEASE_TAG: "v2026.7.1-beta.3",
        ...envOverrides,
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(
      /Attested ClawHub bootstrap approval does not match|must use attempt/u,
    );
  });

  it.each([
    ["parent run", { parentRunId: "999" }],
    ["release tag", { releaseTag: "v2026.6.22" }],
    ["target SHA", { targetSha: "b".repeat(40) }],
    ["extra field", { unexpected: true }],
  ])("rejects an attested Android approval for another %s", (_name, overrides) => {
    const approvalPath = writeApproval(overrides);

    const result = runApprovalScript(approvalRun(), { APPROVAL_PATH: approvalPath });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "Attested Android release approval does not match this run request.",
    );
  });

  it("accepts completed success or failure runs for direct recovery", () => {
    for (const conclusion of ["success", "failure"]) {
      const result = runApprovalScript(approvalRun({ conclusion, status: "completed" }), {
        DIRECT_RELEASE_RECOVERY: "true",
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(
        `Using completed release publish run 123 (${conclusion}) for direct recovery: https://github.com/openclaw/openclaw/actions/runs/123`,
      );
      expect(result.stderr).toBe("");
    }
  });
});
