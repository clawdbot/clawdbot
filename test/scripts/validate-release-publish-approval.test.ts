// Validate release publish approval tests cover the stdin/env CLI contract.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const SCRIPT_PATH = "scripts/validate-release-publish-approval.mjs";
const tempRoots = useAutoCleanupTempDirTracker(afterEach);
// Android publication runs on Ubuntu and executes Bash workflow steps.
const androidIt = it.skipIf(process.platform === "win32");

function runApprovalScript(
  run: Record<string, unknown>,
  env: {
    ALLOW_COMPLETED_SUCCESSFUL_PARENT?: string;
    CHILD_WORKFLOW_SHA?: string;
    DIRECT_RELEASE_RECOVERY?: string;
    EXPECTED_WORKFLOW_BRANCH?: string;
    EXPECTED_WORKFLOW_FULL_REF?: string;
    EXPECTED_WORKFLOW_SHA?: string;
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
      ALLOW_COMPLETED_SUCCESSFUL_PARENT: env.ALLOW_COMPLETED_SUCCESSFUL_PARENT ?? "false",
      CHILD_WORKFLOW_SHA: env.CHILD_WORKFLOW_SHA ?? "b".repeat(40),
      DIRECT_RELEASE_RECOVERY: env.DIRECT_RELEASE_RECOVERY ?? "false",
      EXPECTED_WORKFLOW_BRANCH: env.EXPECTED_WORKFLOW_BRANCH ?? "release/2026.6.21",
      EXPECTED_WORKFLOW_FULL_REF: env.EXPECTED_WORKFLOW_FULL_REF ?? "",
      EXPECTED_WORKFLOW_SHA: env.EXPECTED_WORKFLOW_SHA ?? "",
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

const ANDROID_TOOLING_SHA = "d".repeat(40);
const ANDROID_PROTECTED_REF = `release-publish/${ANDROID_TOOLING_SHA.slice(0, 12)}-123`;

function workflowStep(file: string, name: string): string {
  const workflow = parse(fs.readFileSync(file, "utf8"));
  const steps = Object.values(workflow.jobs).flatMap(
    (job) => (job as { steps?: { name?: string; run?: string }[] }).steps ?? [],
  );
  const step = steps.find((entry) => entry.name === name);
  if (!step?.run) {
    throw new Error(`Missing workflow step ${name}`);
  }
  return step.run;
}

function runAndroidApproval({
  ref = ANDROID_PROTECTED_REF,
  approval = {},
  run = {},
  identity,
  recovery = false,
  attestationExitCode = 0,
  release = {},
  targetSha = "a".repeat(40),
  publication,
}: {
  ref?: string;
  approval?: Record<string, unknown>;
  run?: Record<string, unknown>;
  identity?: Record<string, unknown>;
  recovery?: boolean;
  attestationExitCode?: number;
  release?: Record<string, unknown>;
  targetSha?: string;
  publication?: {
    afterAdmission?: Record<string, unknown>;
    afterFirstUpload?: Record<string, unknown>;
    afterToolingRead?: Record<string, unknown>;
    beforeProvenance?: boolean;
    targetSha?: string;
    release?: Record<string, unknown>;
  };
} = {}) {
  const tempRoot = tempRoots.make("openclaw-android-approval-");
  const fullRef = `${ref.startsWith("release-publish/") ? "refs/tags" : "refs/heads"}/${ref}`;
  const approvalPath = path.join(tempRoot, "android-release-approval/approval.json");
  const env = {
    ...process.env,
    PATH: `${tempRoot}${path.delimiter}${process.env.PATH}`,
    APPROVAL_PATH: approvalPath,
    DIRECT_RELEASE_RECOVERY: String(recovery),
    EXPECTED_WORKFLOW_BRANCH: ref,
    EXPECTED_WORKFLOW_FULL_REF: fullRef,
    EXPECTED_WORKFLOW_SHA: ANDROID_TOOLING_SHA,
    EXPECTED_RUN_ATTEMPT: "2",
    RELEASE_PUBLISH_BRANCH: ref,
    RELEASE_PUBLISH_FULL_REF: fullRef,
    RELEASE_PUBLISH_WORKFLOW_SHA: ANDROID_TOOLING_SHA,
    RELEASE_PUBLISH_RUN_ATTEMPT: "2",
    RELEASE_PUBLISH_RUN_ID: "123",
    RELEASE_APPROVAL_KIND: "android",
    RELEASE_TAG: "v2026.8.1",
    RELEASE_TARGET_SHA: "a".repeat(40),
    TARGET_SHA: "a".repeat(40),
    GITHUB_REF: "refs/tags/v2026.8.1",
    GITHUB_REPOSITORY: "openclaw/openclaw",
    RUNNER_TEMP: tempRoot,
    GITHUB_OUTPUT: path.join(tempRoot, "output"),
  };
  const producer = spawnSync(
    "bash",
    [
      "-c",
      workflowStep(
        ".github/workflows/openclaw-release-publish.yml",
        "Write Android release approval",
      ),
    ],
    { encoding: "utf8", env },
  );
  expect(producer.status, producer.stderr).toBe(0);
  const dispatch = spawnSync(
    "bash",
    [
      "-c",
      `
set -euo pipefail
source scripts/lib/release-publish-children.sh
is_android_release() { return 0; }
verify_android_release_asset_contract() { return 1; }
dispatch_workflow_at_ref() { printf '%s\n' "$@" > "$RUNNER_TEMP/dispatch-args"; echo 456; }
wait_for_run() { touch "$RUNNER_TEMP/android-waited"; return 0; }
promote_android_release_asset
`,
    ],
    {
      encoding: "utf8",
      env: {
        ...env,
        GITHUB_RUN_ID: "123",
        GITHUB_RUN_ATTEMPT: "2",
        GITHUB_STEP_SUMMARY: path.join(tempRoot, "summary"),
        PARENT_WORKFLOW_BRANCH: ref,
        PARENT_WORKFLOW_FULL_REF: fullRef,
        PARENT_WORKFLOW_SHA: ANDROID_TOOLING_SHA,
      },
    },
  );
  expect(dispatch.status, dispatch.stderr).toBe(0);
  expect(fs.readFileSync(path.join(tempRoot, "dispatch-args"), "utf8").trim().split("\n")).toEqual([
    "v2026.8.1",
    "a".repeat(40),
    "android-release.yml",
    "-f",
    "tag=v2026.8.1",
    "-f",
    "release_publish_run_id=123",
    "-f",
    "release_publish_run_attempt=2",
    "-f",
    `release_publish_branch=${ref}`,
    "-f",
    `release_publish_full_ref=${fullRef}`,
    "-f",
    `release_publish_workflow_sha=${ANDROID_TOOLING_SHA}`,
    "-f",
    `release_target_sha=${"a".repeat(40)}`,
    "-f",
    "direct_release_recovery=false",
  ]);
  fs.writeFileSync(
    approvalPath,
    JSON.stringify({
      ...JSON.parse(fs.readFileSync(approvalPath, "utf8")),
      ...approval,
    }),
  );
  const parent = {
    id: 123,
    repository: { full_name: "openclaw/openclaw" },
    event: "workflow_dispatch",
    head_branch: ref,
    head_sha: ANDROID_TOOLING_SHA,
    run_attempt: 2,
    path: `.github/workflows/openclaw-release-publish.yml@${fullRef}`,
    status: "in_progress",
    conclusion: null,
    html_url: "https://github.com/openclaw/openclaw/actions/runs/123",
    ...run,
  };
  const tooling =
    identity ??
    (ref === "main"
      ? { status: "ahead" }
      : {
          ref: fullRef,
          object: { type: "commit", sha: ANDROID_TOOLING_SHA },
        });
  const identityEndpoint =
    ref === "main"
      ? `compare/${ANDROID_TOOLING_SHA}...main`
      : `git/ref/${ref.startsWith("release-publish/") ? "tags" : "heads"}/${ref}`;
  const parentPath = path.join(tempRoot, "parent.json");
  const targetPath = path.join(tempRoot, "target.json");
  const effectsPath = path.join(tempRoot, "uploads.json");
  fs.writeFileSync(parentPath, JSON.stringify(parent));
  fs.writeFileSync(
    targetPath,
    JSON.stringify({
      sha: targetSha,
      release: {
        tagName: "v2026.8.1",
        isDraft: true,
        isPrerelease: false,
        createdAt: "2026-08-30T12:00:00Z",
        assets: [],
        ...release,
      },
    }),
  );
  fs.writeFileSync(effectsPath, "[]");
  const attestationArgsPath = path.join(tempRoot, "attestation-args.json");
  fs.writeFileSync(
    path.join(tempRoot, "gh"),
    `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "attestation" && args[1] === "verify") {
  fs.writeFileSync(${JSON.stringify(attestationArgsPath)}, JSON.stringify(args));
  process.exit(${attestationExitCode});
}
if (args[0] === "release" && args[1] === "view") {
  process.stdout.write(JSON.stringify(JSON.parse(fs.readFileSync(${JSON.stringify(targetPath)}, "utf8")).release));
  process.exit(0);
}
if (args[0] === "release" && args[1] === "upload") {
  const effects = JSON.parse(fs.readFileSync(${JSON.stringify(effectsPath)}, "utf8"));
  effects.push(args[3]);
  fs.writeFileSync(${JSON.stringify(effectsPath)}, JSON.stringify(effects));
  if (effects.length === 1 && ${JSON.stringify(Boolean(publication?.afterFirstUpload))}) {
    fs.writeFileSync(${JSON.stringify(parentPath)}, ${JSON.stringify(JSON.stringify({ ...parent, ...publication?.afterFirstUpload }))});
  }
  process.exit(0);
}
if (args[0] === "api" && args[1] === "repos/openclaw/openclaw/actions/runs/123") {
  process.stdout.write(fs.readFileSync(${JSON.stringify(parentPath)}, "utf8"));
  process.exit(0);
}
const responses = ${JSON.stringify({
      [`repos/openclaw/openclaw/${identityEndpoint}`]: tooling,
    })};
if (args[0] !== "api" || !responses[args[1]]) process.exit(91);
if (${JSON.stringify(Boolean(publication?.afterToolingRead))} && fs.existsSync(${JSON.stringify(path.join(tempRoot, "publishing"))})) {
  fs.writeFileSync(${JSON.stringify(parentPath)}, ${JSON.stringify(JSON.stringify({ ...parent, ...publication?.afterToolingRead }))});
}
process.stdout.write(JSON.stringify(responses[args[1]]));
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(tempRoot, "git"),
    `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const target = JSON.parse(fs.readFileSync(${JSON.stringify(targetPath)}, "utf8"));
if (JSON.stringify(args) === JSON.stringify(["rev-parse", "v2026.8.1^{commit}"])) {
  process.stdout.write(target.sha);
} else if (JSON.stringify(args) === JSON.stringify(["ls-remote", "--tags", "origin", "refs/tags/v2026.8.1", "refs/tags/v2026.8.1^{}"])) {
  process.stdout.write(${JSON.stringify("e".repeat(40) + "\trefs/tags/v2026.8.1\n")} + target.sha + ${JSON.stringify("\trefs/tags/v2026.8.1^{}\n")});
} else process.exit(91);
`,
    { mode: 0o755 },
  );
  // Execute the real producer and consumer handoff, stopping before release
  // mutation/build checks. Only GitHub's external boundary is substituted.
  const admission = workflowStep(
    ".github/workflows/android-release.yml",
    "Validate release approval and target",
  );
  let result = spawnSync("bash", ["-c", admission], { encoding: "utf8", env });
  if (publication) {
    expect(result.status, result.stderr).toBe(0);
    fs.writeFileSync(parentPath, JSON.stringify({ ...parent, ...publication.afterAdmission }));
    const target = JSON.parse(fs.readFileSync(targetPath, "utf8"));
    fs.writeFileSync(
      targetPath,
      JSON.stringify({
        sha: publication.targetSha ?? target.sha,
        release: { ...target.release, ...publication.release },
      }),
    );
    fs.writeFileSync(path.join(tempRoot, "publishing"), "");
    fs.symlinkSync(path.join(process.cwd(), "scripts"), path.join(tempRoot, "scripts"), "dir");
    fs.mkdirSync(path.join(tempRoot, "dist"));
    for (const name of ["OpenClaw-Android.apk", "OpenClaw-Android-SHA256SUMS.txt"]) {
      fs.writeFileSync(path.join(tempRoot, "dist", name), "fixture");
    }
    result = spawnSync(
      "bash",
      [
        "-c",
        workflowStep(
          ".github/workflows/android-release.yml",
          publication.beforeProvenance
            ? "Revalidate release approval before Android provenance"
            : "Upload immutable Android release assets",
        ),
      ],
      { cwd: tempRoot, encoding: "utf8", env },
    );
  }
  return {
    ...result,
    buildOutput: fs.existsSync(env.GITHUB_OUTPUT) ? fs.readFileSync(env.GITHUB_OUTPUT, "utf8") : "",
    uploads: JSON.parse(fs.readFileSync(effectsPath, "utf8")),
    waitedForAndroid: fs.existsSync(path.join(tempRoot, "android-waited")),
    attestationArgs: JSON.parse(fs.readFileSync(attestationArgsPath, "utf8")),
  };
}

function approvalRun(overrides: Record<string, unknown> = {}) {
  return {
    conclusion: null,
    event: "workflow_dispatch",
    headBranch: "release/2026.6.21",
    repository: "openclaw/openclaw",
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

  it("binds the parent repository, workflow path, full ref, SHA, and attempt", () => {
    const workflowSha = "d".repeat(40);
    const fullRef = "refs/tags/release-publish/aaaaaaaaaaaa-111";
    const result = runApprovalScript(
      approvalRun({
        headBranch: "release-publish/aaaaaaaaaaaa-111",
        headSha: workflowSha,
        path: `.github/workflows/openclaw-release-publish.yml@${fullRef}`,
        runAttempt: 7,
      }),
      {
        EXPECTED_RUN_ATTEMPT: "7",
        EXPECTED_WORKFLOW_BRANCH: "release-publish/aaaaaaaaaaaa-111",
        EXPECTED_WORKFLOW_FULL_REF: fullRef,
        EXPECTED_WORKFLOW_SHA: workflowSha,
      },
    );

    expect(result.status, result.stderr).toBe(0);
  });

  it("rejects completed runs for normal approval handoff", () => {
    const result = runApprovalScript(approvalRun({ conclusion: "success", status: "completed" }));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "Referenced release publish run 123 must still be in_progress, got completed.",
    );
    expect(result.stdout).toBe("");
  });

  it("accepts a successful completed parent for detached publication", () => {
    const result = runApprovalScript(approvalRun({ conclusion: "success", status: "completed" }), {
      ALLOW_COMPLETED_SUCCESSFUL_PARENT: "true",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "Using successful completed release publish run 123: https://github.com/openclaw/openclaw/actions/runs/123",
    );
    expect(result.stderr).toBe("");
  });

  it("rejects a failed completed parent for detached publication", () => {
    const result = runApprovalScript(approvalRun({ conclusion: "failure", status: "completed" }), {
      ALLOW_COMPLETED_SUCCESSFUL_PARENT: "true",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "Referenced release publish run 123 must still be in_progress, got completed.",
    );
  });

  androidIt.each(["main", ANDROID_PROTECTED_REF, "release/2026.8.1"])(
    "accepts the attested Android workflow handoff from %s",
    (ref) => {
      const result = runAndroidApproval({ ref });
      expect(result.status, result.stderr).toBe(0);
      expect(result.buildOutput).toBe("build_timestamp=2026-08-30T12:00:00Z\n");
      expect(result.waitedForAndroid).toBe(false);
      expect(result.attestationArgs).toEqual([
        "attestation",
        "verify",
        expect.any(String),
        "--repo",
        "openclaw/openclaw",
        "--signer-workflow",
        "openclaw/openclaw/.github/workflows/openclaw-release-publish.yml",
        "--source-ref",
        `${ref === ANDROID_PROTECTED_REF ? "refs/tags" : "refs/heads"}/${ref}`,
        "--source-digest",
        ANDROID_TOOLING_SHA,
        "--deny-self-hosted-runners",
      ]);
    },
  );

  androidIt("accepts a completed successful parent and an already public stable release", () => {
    const result = runAndroidApproval({
      run: { status: "completed", conclusion: "success" },
      release: { isDraft: false },
    });
    expect(result.status, result.stderr).toBe(0);
  });

  androidIt("accepts a public stable release while its parent is still active", () => {
    const result = runAndroidApproval({ release: { isDraft: false } });
    expect(result.status, result.stderr).toBe(0);
  });

  androidIt.each([
    [
      "another tag",
      { tagName: "v2026.8.2" },
      "a".repeat(40),
      "exact approved stable GitHub release",
    ],
    [
      "a prerelease",
      { isPrerelease: true },
      "a".repeat(40),
      "exact approved stable GitHub release",
    ],
    ["a moved release tag", {}, "b".repeat(40), "no longer resolves to approved target"],
  ])("rejects publication to %s", (_name, release, targetSha, message) => {
    const result = runAndroidApproval({ release, targetSha });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
  });

  androidIt.each([
    ["failed", { status: "completed", conclusion: "failure" }],
    ["cancelled", { status: "completed", conclusion: "cancelled" }],
    ["rerun", { run_attempt: 3 }],
  ])("fences asset publication after the parent becomes %s", (_name, parent) => {
    for (const phase of ["afterAdmission", "afterFirstUpload"] as const) {
      const result = runAndroidApproval({ publication: { [phase]: parent } });
      expect(result.status).toBe(1);
      expect(result.uploads).toHaveLength(phase === "afterAdmission" ? 0 : 1);
    }
  });

  androidIt("rechecks the parent after live tooling reads at the upload boundary", () => {
    const result = runAndroidApproval({
      publication: { afterToolingRead: { status: "completed", conclusion: "failure" } },
    });
    expect(result.status).toBe(1);
    expect(result.uploads).toEqual([]);
  });

  androidIt.each([
    ["success", 0],
    ["failure", 1],
  ])("rechecks %s parent authority immediately before provenance", (conclusion, expectedStatus) => {
    const workflow = parse(fs.readFileSync(".github/workflows/android-release.yml", "utf8"));
    const steps = workflow.jobs.publish_signed_android_apk.steps;
    const provenanceIndex = steps.findIndex(
      (step: { name: string }) => step.name === "Attest Android APK provenance",
    );
    expect(steps[provenanceIndex - 1].name).toBe(
      "Revalidate release approval before Android provenance",
    );
    const result = runAndroidApproval({
      publication: { beforeProvenance: true, afterAdmission: { status: "completed", conclusion } },
    });
    expect(result.status, result.stderr).toBe(expectedStatus);
    expect(result.uploads).toEqual([]);
  });

  androidIt.each([
    ["successful completion", false, { status: "completed", conclusion: "success" }],
    ["explicit failed-parent recovery", true, { status: "completed", conclusion: "failure" }],
  ])("publishes both assets for %s", (_name, recovery, parent) => {
    const result = runAndroidApproval({ recovery, publication: { afterAdmission: parent } });
    expect(result.status, result.stderr).toBe(0);
    expect(result.uploads).toEqual([
      "dist/OpenClaw-Android.apk#OpenClaw-Android.apk",
      "dist/OpenClaw-Android-SHA256SUMS.txt#OpenClaw-Android-SHA256SUMS.txt",
    ]);
  });

  androidIt.each([
    ["moved target", { targetSha: "b".repeat(40) }],
    ["prerelease target", { release: { isPrerelease: true } }],
  ])("fences asset publication after the release becomes a %s", (_name, publication) => {
    const result = runAndroidApproval({ publication });
    expect(result.status).toBe(1);
    expect(result.uploads).toEqual([]);
  });

  androidIt("rejects an Android handoff whose attestation fails", () => {
    const result = runAndroidApproval({ attestationExitCode: 1 });
    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain("Using attested Android");
  });

  androidIt.each([
    ["repository", { repository: { full_name: "other/repository" } }],
    ["run ID", { id: 456 }],
    ["attempt", { run_attempt: 3 }],
    ["SHA", { head_sha: "e".repeat(40) }],
    ["ref", { head_branch: "main" }],
    ["workflow path", { path: ".github/workflows/android-release.yml" }],
    ["full ref", { path: ".github/workflows/openclaw-release-publish.yml@refs/heads/main" }],
    ["event", { event: "push" }],
    ["failed parent", { status: "completed", conclusion: "failure" }],
    ["cancelled parent", { status: "completed", conclusion: "cancelled" }],
  ])("rejects an Android handoff with a different live parent %s", (_name, run) => {
    const result = runAndroidApproval({ run });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("release publish parent run");
  });

  androidIt.each([
    [
      "moved tag",
      {
        ref: `refs/tags/${ANDROID_PROTECTED_REF}`,
        object: { type: "commit", sha: "e".repeat(40) },
      },
    ],
    [
      "annotated tag",
      {
        ref: `refs/tags/${ANDROID_PROTECTED_REF}`,
        object: { type: "tag", sha: ANDROID_TOOLING_SHA },
      },
    ],
    ["missing tag", {}],
  ])("rejects an Android handoff from a %s", (_name, identity) => {
    const result = runAndroidApproval({ identity });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("protected release tooling tag");
  });

  androidIt("rejects an Android parent SHA no longer reachable from main", () => {
    const result = runAndroidApproval({ ref: "main", identity: { status: "diverged" } });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("not reachable from current main");
  });

  androidIt.each(["success", "failure", "cancelled"])(
    "allows only completed success or failure for explicit Android recovery: %s",
    (conclusion) => {
      const result = runAndroidApproval({
        recovery: true,
        run: { status: "completed", conclusion },
      });
      expect(result.status, result.stderr).toBe(conclusion === "cancelled" ? 1 : 0);
    },
  );

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

  androidIt.each([
    ["parent run", { parentRunId: "999" }],
    ["version", { version: 1 }],
    ["parent attempt", { parentRunAttempt: 1 }],
    ["parent full ref", { workflowFullRef: "refs/heads/main" }],
    ["parent SHA", { parentWorkflowSha: "e".repeat(40) }],
    ["release tag", { releaseTag: "v2026.6.22" }],
    ["target SHA", { targetSha: "b".repeat(40) }],
    ["extra field", { unexpected: true }],
  ])("rejects an attested Android approval for another %s", (_name, overrides) => {
    const result = runAndroidApproval({ approval: overrides });

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
