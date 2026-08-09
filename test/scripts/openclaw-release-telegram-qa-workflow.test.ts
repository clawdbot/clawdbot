import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const RELEASE_CHECKS_PATH = ".github/workflows/openclaw-release-checks.yml";
const WORKFLOW_PATH = ".github/workflows/openclaw-release-telegram-qa.yml";
const HELPER = "scripts/release-telegram-qa.mjs";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

type WorkflowStep = {
  env?: Record<string, unknown>;
  id?: string;
  if?: string;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
};

type WorkflowJob = {
  "continue-on-error"?: boolean;
  environment?: string;
  if?: string;
  needs?: string[];
  outputs?: Record<string, unknown>;
  permissions?: Record<string, string>;
  "runs-on"?: unknown;
  "timeout-minutes"?: unknown;
  steps?: WorkflowStep[];
};

function workflow(path = WORKFLOW_PATH) {
  return parse(readFileSync(path, "utf8")) as { jobs?: Record<string, WorkflowJob> };
}

function job(name: string, path = WORKFLOW_PATH): WorkflowJob {
  const value = workflow(path).jobs?.[name];
  if (!value) {
    throw new Error(`Expected workflow job ${name}`);
  }
  return value;
}

function step(jobName: string, name: string, path = WORKFLOW_PATH): WorkflowStep {
  const value = job(jobName, path).steps?.find((candidate) => candidate.name === name);
  if (!value) {
    throw new Error(`Expected ${jobName} step ${name}`);
  }
  return value;
}

function requireRun(jobName: string, name: string): string {
  const value = step(jobName, name).run;
  if (!value) {
    throw new Error(`Expected ${jobName} step ${name} to run a script`);
  }
  return value;
}

function extractHereDocument(script: string, delimiter: string): string {
  const match = script.match(
    new RegExp(`<<'${delimiter}'\\n([\\s\\S]*?)\\n${delimiter}(?:\\n|$)`, "u"),
  );
  if (!match?.[1]) {
    throw new Error(`Expected ${delimiter} heredoc`);
  }
  return match[1];
}

function runIdentityVerification(params: {
  expectedTrustedWorkflowSha: string;
  invocation?: "dispatch" | "reusable";
  oidcJobWorkflowSha?: string;
  oidcWorkflowSha?: string;
  workflowSha?: string;
}) {
  const repository = "openclaw/openclaw";
  const trustedWorkflowRef = `${repository}/.github/workflows/openclaw-release-telegram-qa.yml@refs/heads/main`;
  const invocation = params.invocation ?? "dispatch";
  const workflowRef =
    invocation === "dispatch"
      ? trustedWorkflowRef
      : `${repository}/.github/workflows/openclaw-release-checks.yml@refs/heads/release-ci/test`;
  const workflowRefName =
    invocation === "dispatch" ? "refs/heads/main" : "refs/heads/release-ci/test";
  const workdir = tempDirs.make("openclaw-telegram-identity-");
  const fakeBin = join(workdir, "bin");
  const githubOutput = join(workdir, "github-output");
  mkdirSync(fakeBin);
  const workflowSha = params.workflowSha ?? params.expectedTrustedWorkflowSha;
  const payload = {
    aud: "openclaw-release-telegram-qa",
    event_name: "workflow_dispatch",
    iss: "https://token.actions.githubusercontent.com",
    ...(invocation === "reusable"
      ? {
          job_workflow_ref: trustedWorkflowRef,
          job_workflow_sha: params.oidcJobWorkflowSha ?? params.expectedTrustedWorkflowSha,
        }
      : {}),
    ref: workflowRefName,
    repository,
    runner_environment: "github-hosted",
    sha: workflowSha,
    workflow_ref: workflowRef,
    workflow_sha: params.oidcWorkflowSha ?? workflowSha,
  };
  const token = ["{}", JSON.stringify(payload), "signature"]
    .map((part) => Buffer.from(part).toString("base64url"))
    .join(".");
  writeFileSync(
    join(fakeBin, "curl"),
    "#!/usr/bin/env bash\nprintf '%s\\n' \"$FAKE_OIDC_JSON\"\n",
    {
      mode: 0o755,
    },
  );
  return spawnSync(
    "bash",
    ["-c", requireRun("trusted_identity", "Verify dispatched-main identity")],
    {
      cwd: workdir,
      encoding: "utf8",
      env: {
        ...process.env,
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "test-token",
        ACTIONS_ID_TOKEN_REQUEST_URL: "https://example.invalid/oidc?",
        CALLER_WORKFLOW_REF: workflowRef,
        CALLER_WORKFLOW_SHA: workflowSha,
        EXPECTED_TRUSTED_WORKFLOW_SHA: params.expectedTrustedWorkflowSha,
        FAKE_OIDC_JSON: JSON.stringify({ value: token }),
        GITHUB_EVENT_NAME: "workflow_dispatch",
        GITHUB_OUTPUT: githubOutput,
        GITHUB_REF: workflowRefName,
        GITHUB_REPOSITORY: repository,
        GITHUB_SHA: workflowSha,
        JOB_CONTEXT: JSON.stringify({
          workflow_ref: trustedWorkflowRef,
          workflow_repository: repository,
          workflow_sha: params.expectedTrustedWorkflowSha,
        }),
        PATH: `${fakeBin}:${process.env.PATH}`,
        TARGET_REF: "refs/heads/release/2026.7.1",
        TARGET_SHA: "a".repeat(40),
        WORKFLOW_REF: workflowRef,
        WORKFLOW_SHA: workflowSha,
      },
    },
  );
}

function runAdvisoryStatus(overrides: Record<string, string> = {}) {
  const runId = "123456";
  const runAttempt = "1";
  const targetSha = "a".repeat(40);
  const workdir = tempDirs.make("openclaw-telegram-advisory-status-");
  const githubOutput = join(workdir, "github-output");
  const result = spawnSync(process.execPath, [join(process.cwd(), HELPER), "advisory-status"], {
    cwd: workdir,
    encoding: "utf8",
    env: {
      ...process.env,
      ARCHIVE_NAME: `release-telegram-candidate-${runId}-${runAttempt}-${targetSha}.tar.zst`,
      ARCHIVE_SHA256: "c".repeat(64),
      ATTESTATION_RESULT: "success",
      ATTESTATION_STATUS: "success",
      BUILD_RESULT: "success",
      BUILD_STATUS: "success",
      CANDIDATE_ARTIFACT_DIGEST: "d".repeat(64),
      CANDIDATE_ARTIFACT_ID: "123",
      CANDIDATE_VERSION: "2026.7.1-beta.3",
      EVIDENCE_ARTIFACT_DIGEST: "e".repeat(64),
      EVIDENCE_ARTIFACT_ID: "456",
      EVIDENCE_ARTIFACT_NAME: `release-qa-live-telegram-${runId}-${runAttempt}-${targetSha}`,
      EXECUTION_STATUS: "success",
      GITHUB_OUTPUT: githubOutput,
      GITHUB_RUN_ATTEMPT: runAttempt,
      GITHUB_RUN_ID: runId,
      IDENTITY_RESULT: "success",
      IDENTITY_STATUS: "success",
      RUN_RESULT: "success",
      TARGET_SHA: targetSha,
      WORKFLOW_SHA: "b".repeat(40),
      ...overrides,
    },
  });
  const output = result.status === 0 ? readFileSync(githubOutput, "utf8") : "";
  const outputs = Object.fromEntries(
    output
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split("=", 2) as [string, string]),
  );
  const statusFile = join(
    workdir,
    ".artifacts",
    "release-check-status",
    `qa_live_telegram_release_checks-${runId}-${runAttempt}.env`,
  );
  const evidenceFile = statusFile.replace(/\.env$/u, ".json");
  return {
    evidence: result.status === 0 ? JSON.parse(readFileSync(evidenceFile, "utf8")) : null,
    outputs,
    result,
    statusFile: result.status === 0 ? readFileSync(statusFile, "utf8") : "",
  };
}

function runCandidateProvenance(params: { openPr?: boolean; unsignedWebFlow?: boolean } = {}) {
  const candidateSha = "a".repeat(40);
  const workdir = tempDirs.make("openclaw-telegram-provenance-");
  const fakeBin = join(workdir, "bin");
  mkdirSync(fakeBin);
  const metadata = {
    data: {
      repository: {
        object: {
          oid: candidateSha,
          signature: params.unsignedWebFlow
            ? null
            : { isValid: true, state: "VALID", signer: { login: "release-maintainer" } },
          associatedPullRequests: {
            nodes: [
              ...(params.openPr
                ? [
                    {
                      state: "OPEN",
                      headRefOid: candidateSha,
                      headRepository: { nameWithOwner: "openclaw/openclaw" },
                    },
                  ]
                : []),
              ...(params.unsignedWebFlow
                ? [
                    {
                      state: "MERGED",
                      baseRefName: "release/2026.7.1",
                      baseRepository: { nameWithOwner: "openclaw/openclaw" },
                      mergeCommit: { oid: candidateSha },
                      mergedBy: { login: "release-maintainer" },
                    },
                  ]
                : []),
            ],
          },
        },
      },
    },
  };
  writeFileSync(
    join(fakeBin, "gh"),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *"api graphql"* ]]; then printf '%s\\n' "$FAKE_METADATA"; exit 0; fi
if [[ "$*" == *"/compare/"* ]]; then printf '%s\\n' "behind"; exit 0; fi
if [[ "$*" == *"/collaborators/release-maintainer/permission"* ]]; then printf '%s\\n' '{"permission":"write","role_name":"maintain"}'; exit 0; fi
exit 64
`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(fakeBin, "git"),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *"rev-parse HEAD"* ]]; then printf '%s\\n' "$TARGET_SHA"; exit 0; fi
if [[ "$*" == *"ls-remote"* ]]; then printf '%s\\trefs/heads/release/2026.7.1\\n' "$TARGET_SHA"; exit 0; fi
exit 64
`,
    { mode: 0o755 },
  );
  return spawnSync(
    "bash",
    ["-c", requireRun("build_candidate", "Validate candidate release provenance")],
    {
      cwd: workdir,
      encoding: "utf8",
      env: {
        ...process.env,
        FAKE_METADATA: JSON.stringify(metadata),
        GH_TRANSIENT_SERVER_OR_NETWORK_PATTERN: "HTTP 5[0-9][0-9]",
        GITHUB_REPOSITORY: "openclaw/openclaw",
        PATH: `${fakeBin}:${process.env.PATH}`,
        TARGET_REF: "refs/heads/release/2026.7.1",
        TARGET_SHA: candidateSha,
      },
    },
  );
}

describe("release Telegram QA workflow", () => {
  it("keeps the workflow wiring explicit and secret-scoped", () => {
    const release = workflow(RELEASE_CHECKS_PATH);
    const caller = release.jobs?.qa_live_telegram_release_checks;
    expect(caller).toMatchObject({
      needs: ["resolve_target"],
      permissions: { actions: "write", contents: "read" },
      "runs-on": "ubuntu-24.04",
      "timeout-minutes": 210,
    });
    expect(caller?.environment).toBeUndefined();
    expect(caller?.["continue-on-error"]).toBeUndefined();

    const trusted = job("trusted_identity");
    expect(trusted).toMatchObject({
      permissions: { contents: "read", "id-token": "write" },
      "runs-on": "ubuntu-24.04",
      "timeout-minutes": 5,
    });
    expect(step("trusted_identity", "Verify dispatched-main identity").id).toBe("identity");

    const runJob = job("run_telegram");
    expect(runJob.environment).toBe("qa-live-shared");
    expect(runJob["timeout-minutes"]).toBe(60);
    expect(requireRun("advisory_status", "Record advisory status").trim()).toBe(
      "set -euo pipefail\nnode scripts/release-telegram-qa.mjs advisory-status",
    );
    for (const [jobName, value] of Object.entries(workflow().jobs ?? {})) {
      for (const checkout of value.steps?.filter((candidate) =>
        candidate.uses?.startsWith("actions/checkout@"),
      ) ?? []) {
        expect(checkout.with?.["persist-credentials"], `${jobName}:${checkout.name}`).toBe(false);
      }
    }
  });

  it("accepts only the resolved trusted workflow identity", () => {
    const trustedSha = "b".repeat(40);
    expect(runIdentityVerification({ expectedTrustedWorkflowSha: trustedSha }).status).toBe(0);
    expect(
      runIdentityVerification({
        expectedTrustedWorkflowSha: trustedSha,
        oidcWorkflowSha: "c".repeat(40),
      }).stderr,
    ).toContain("OIDC workflow_sha mismatch");
    expect(
      runIdentityVerification({
        expectedTrustedWorkflowSha: trustedSha,
        invocation: "reusable",
        oidcJobWorkflowSha: "c".repeat(40),
      }).stderr,
    ).toContain("OIDC job_workflow_sha mismatch");
  });

  it("accepts trusted release provenance and rejects same-repository PR heads", () => {
    const signed = runCandidateProvenance();
    expect(signed.status, signed.stderr).toBe(0);

    const unsignedWebFlow = runCandidateProvenance({ unsignedWebFlow: true });
    expect(unsignedWebFlow.status, unsignedWebFlow.stderr).toBe(0);

    const openPr = runCandidateProvenance({ openPr: true });
    expect(openPr.status).toBe(1);
    expect(openPr.stderr).toContain("open same-repository PR head");
  });

  it("writes terminal evidence only for complete successful producers", () => {
    const success = runAdvisoryStatus();
    expect(success.result.status, success.result.stderr).toBe(0);
    expect(success.outputs.status).toBe("success");
    expect(success.evidence).toMatchObject({
      kind: "release-check-status",
      status: "success",
      candidateArtifact: { id: "123", sourceSha: "a".repeat(40) },
    });

    const failure = runAdvisoryStatus({ BUILD_RESULT: "failure", BUILD_STATUS: "failure" });
    expect(failure.result.status, failure.result.stderr).toBe(0);
    expect(failure.outputs.status).toBe("failure");
    expect(failure.evidence.candidateArtifact).toMatchObject({ id: "123" });
    expect(failure.statusFile).toContain("build:failure");
  });

  it.runIf(process.platform === "linux")("retains only bounded, allowlisted diagnostics", () => {
    const source = extractHereDocument(
      requireRun("run_telegram", "Capture isolated Telegram runtime diagnostics"),
      "NODE",
    );
    const workdir = tempDirs.make("openclaw-telegram-diagnostics-");
    const scriptPath = join(workdir, "redact-gateway-tail.mts");
    const outputPath = join(workdir, "gateway.log");
    writeFileSync(scriptPath, source);
    const records = [
      { 0: '{"subsystem":"gateway"}', 1: "ordinary info", _meta: { logLevelName: "INFO" } },
      {
        0: '{"subsystem":"agents/embedded"}',
        1: "embedded run start: safe",
        _meta: { logLevelName: "DEBUG" },
      },
      {
        0: '{"subsystem":"agents/embedded"}',
        1: "private trace",
        _meta: { logLevelName: "TRACE" },
      },
    ];
    const result = spawnSync(process.execPath, ["--import", "tsx", scriptPath, outputPath], {
      cwd: process.cwd(),
      encoding: "utf8",
      input: `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    });
    expect(result.status, result.stderr).toBe(0);
    const output = readFileSync(outputPath, "utf8");
    expect(output).toContain("ordinary info");
    expect(output).toContain("embedded run start: safe");
    expect(output).not.toContain("private trace");
  });

  it.runIf(process.platform === "linux")("keeps the newest eight gateway logs", () => {
    const script = requireRun("run_telegram", "Capture isolated Telegram runtime diagnostics");
    const selector = script.match(/mapfile -d '' -t gateway_logs < <\([\s\S]*?^\)/mu)?.[0];
    expect(selector).toBeTruthy();
    const workdir = tempDirs.make("openclaw-telegram-log-selector-");
    const runtimeRoot = join(workdir, "runtime");
    const fakeBin = join(workdir, "bin");
    mkdirSync(join(runtimeRoot, "tmp"), { recursive: true });
    mkdirSync(fakeBin);
    writeFileSync(join(fakeBin, "sudo"), '#!/bin/sh\nexec "$@"\n', { mode: 0o755 });
    const paths = Array.from({ length: 12 }, (_, index) => {
      const path = join(runtimeRoot, "tmp", `openclaw-${index}.log`);
      writeFileSync(path, `${index}\n`);
      utimesSync(path, index + 1, index + 1);
      return path;
    });
    const result = spawnSync(
      "bash",
      ["-c", `set -euo pipefail\n${selector}\nprintf '%s\\0' "\${gateway_logs[@]}"`],
      {
        encoding: "utf8",
        env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, RUNTIME_ROOT: runtimeRoot },
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.split("\0").filter(Boolean)).toEqual(paths.slice(4).toReversed());
  });

  it("keeps generated SUT programs syntactically valid", () => {
    const createSut = requireRun(
      "run_telegram",
      "Create isolated Telegram SUT identity and launcher",
    );
    const launcher = extractHereDocument(createSut, "LAUNCHER");
    expect(spawnSync("bash", ["-n"], { encoding: "utf8", input: launcher }).status).toBe(0);
    const preload = extractHereDocument(createSut, "PRELOAD");
    const workdir = tempDirs.make("openclaw-telegram-preload-");
    const preloadPath = join(workdir, "preload.mjs");
    writeFileSync(preloadPath, preload);
    const env = { ...process.env };
    delete env.OPENCLAW_QA_SUT_PREENTRY_STOP;
    expect(
      spawnSync(process.execPath, ["--import", preloadPath, "-e", ""], { encoding: "utf8", env })
        .status,
    ).not.toBe(0);
  });

  it("shares only the isolated workspace with the trusted scenario host", () => {
    const createSut = requireRun(
      "run_telegram",
      "Create isolated Telegram SUT identity and launcher",
    );

    expect(createSut).toContain('workspace="${temp_root}/workspace"');
    expect(createSut).toContain('chown -R "$RUNNER_UID:$SUT_GID" "$workspace"');
    expect(createSut).toContain('chmod -R u=rwX,g=rwX,o= "$workspace"');
    expect(createSut).toContain('find "$workspace" -type d -exec chmod g+s {} +');
    expect(createSut).not.toContain(
      'for path in \\\n            "$temp_root/workspace" \\\n            "${OPENCLAW_HOME:?}"',
    );
  });
});
