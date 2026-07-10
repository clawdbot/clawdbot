import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const RELEASE_CHECKS_PATH = ".github/workflows/openclaw-release-checks.yml";
const WORKFLOW_PATH = ".github/workflows/openclaw-release-telegram-qa.yml";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

type WorkflowJob = {
  "continue-on-error"?: boolean;
  environment?: string;
  if?: string;
  needs?: string[];
  outputs?: Record<string, unknown>;
  permissions?: Record<string, string>;
  "runs-on"?: unknown;
  "timeout-minutes"?: unknown;
  steps?: Array<{
    env?: Record<string, unknown>;
    if?: string;
    name?: string;
    run?: string;
    uses?: string;
    with?: Record<string, unknown>;
  }>;
  uses?: string;
  with?: Record<string, unknown>;
};

function workflowJob(name: string): WorkflowJob {
  const workflow = parse(readFileSync(WORKFLOW_PATH, "utf8")) as {
    jobs?: Record<string, WorkflowJob>;
  };
  const job = workflow.jobs?.[name];
  if (!job) {
    throw new Error(`Expected workflow job ${name}`);
  }
  return job;
}

function workflowStep(job: WorkflowJob, name: string) {
  const step = job.steps?.find((candidate) => candidate.name === name);
  if (!step) {
    throw new Error(`Expected workflow step ${name}`);
  }
  return step;
}

function runIdentityVerification(params: {
  callerWorkflowSha?: string;
  expectedTrustedWorkflowSha: string;
  jobWorkflowSha: string;
  oidcWorkflowSha?: string;
}) {
  const repository = "openclaw/openclaw";
  const workflowRef = `${repository}/.github/workflows/openclaw-release-checks.yml@refs/heads/release-ci/test`;
  const jobWorkflowRef = `${repository}/.github/workflows/openclaw-release-telegram-qa.yml@refs/heads/main`;
  const targetSha = "a".repeat(40);
  const workdir = tempDirs.make("openclaw-telegram-identity-");
  const fakeBin = join(workdir, "bin");
  const curlPath = join(fakeBin, "curl");
  const githubOutput = join(workdir, "github-output");
  mkdirSync(fakeBin);
  const callerWorkflowSha = params.callerWorkflowSha ?? params.expectedTrustedWorkflowSha;
  const oidcWorkflowSha = params.oidcWorkflowSha ?? params.jobWorkflowSha;
  const payload = {
    aud: "openclaw-release-telegram-qa",
    iss: "https://token.actions.githubusercontent.com",
    job_workflow_ref: jobWorkflowRef,
    job_workflow_sha: oidcWorkflowSha,
    ref: "refs/heads/release-ci/test",
    repository,
    runner_environment: "github-hosted",
    sha: callerWorkflowSha,
    workflow_ref: workflowRef,
    workflow_sha: callerWorkflowSha,
  };
  const token = [
    Buffer.from("{}").toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "signature",
  ].join(".");
  writeFileSync(curlPath, "#!/usr/bin/env bash\nprintf '%s\\n' \"$FAKE_OIDC_JSON\"\n", {
    mode: 0o755,
  });
  const script = workflowStep(workflowJob("trusted_identity"), "Verify called-main identity").run;
  if (!script) {
    throw new Error("Expected trusted identity script");
  }
  return spawnSync("bash", ["-c", script], {
    cwd: workdir,
    encoding: "utf8",
    env: {
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "test-token",
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://example.invalid/oidc?",
      CALLER_WORKFLOW_REF: workflowRef,
      CALLER_WORKFLOW_SHA: callerWorkflowSha,
      EXPECTED_TRUSTED_WORKFLOW_SHA: params.expectedTrustedWorkflowSha,
      FAKE_OIDC_JSON: JSON.stringify({ value: token }),
      GITHUB_OUTPUT: githubOutput,
      GITHUB_REF: "refs/heads/release-ci/test",
      GITHUB_REPOSITORY: repository,
      GITHUB_SHA: callerWorkflowSha,
      JOB_CONTEXT: JSON.stringify({
        workflow_ref: jobWorkflowRef,
        workflow_repository: repository,
        workflow_sha: params.jobWorkflowSha,
      }),
      PATH: `${fakeBin}:${process.env.PATH}`,
      TARGET_REF: "refs/heads/release/2026.7.1",
      TARGET_SHA: targetSha,
    },
  });
}

function runAdvisoryStatus(overrides: Record<string, string> = {}) {
  const runId = "123456";
  const runAttempt = "1";
  const targetSha = "a".repeat(40);
  const workflowSha = "b".repeat(40);
  const workdir = tempDirs.make("openclaw-telegram-advisory-status-");
  const githubOutput = join(workdir, "github-output");
  const script = workflowStep(workflowJob("advisory_status"), "Record advisory status").run;
  if (!script) {
    throw new Error("Expected advisory status script");
  }
  const result = spawnSync("bash", ["-c", script], {
    cwd: workdir,
    encoding: "utf8",
    env: {
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
      PATH: process.env.PATH,
      RUN_RESULT: "success",
      TARGET_SHA: targetSha,
      WORKFLOW_SHA: workflowSha,
      ...overrides,
    },
  });
  const output = result.status === 0 ? readFileSync(githubOutput, "utf8") : "";
  const status = output.match(/^status=(.*)$/mu)?.[1] ?? "";
  const requireScript = workflowStep(
    workflowJob("advisory_status"),
    "Require successful Telegram release check",
  ).run;
  if (!requireScript) {
    throw new Error("Expected terminal Telegram status script");
  }
  const requireResult = spawnSync("bash", ["-c", requireScript], {
    cwd: workdir,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      STATUS: status,
    },
  });
  const statusFile = join(
    workdir,
    ".artifacts",
    "release-check-status",
    `qa_live_telegram_release_checks-${runId}-${runAttempt}.env`,
  );
  return {
    output,
    recordResult: result,
    requireResult,
    status,
    statusFile: result.status === 0 ? readFileSync(statusFile, "utf8") : "",
  };
}

describe("release Telegram QA workflow", () => {
  it("has exactly one trusted-main caller from release checks", () => {
    const releaseSource = readFileSync(RELEASE_CHECKS_PATH, "utf8");
    const reusableSource = readFileSync(WORKFLOW_PATH, "utf8");
    const releaseWorkflow = parse(releaseSource) as {
      jobs?: Record<string, WorkflowJob>;
    };
    const caller = releaseWorkflow.jobs?.qa_live_telegram_release_checks;

    expect(caller?.uses).toBe(
      "openclaw/openclaw/.github/workflows/openclaw-release-telegram-qa.yml@main",
    );
    expect(caller?.needs).toEqual(["resolve_target"]);
    expect(caller?.if).toContain("needs.resolve_target.outputs.qa_live_telegram_enabled == 'true'");
    expect(caller?.with).toEqual({
      expected_trusted_workflow_sha: "${{ needs.resolve_target.outputs.trusted_workflow_sha }}",
      target_ref: "${{ needs.resolve_target.outputs.ref }}",
      target_sha: "${{ needs.resolve_target.outputs.revision }}",
    });
    expect(caller?.permissions).toEqual({
      actions: "read",
      attestations: "write",
      contents: "read",
      "id-token": "write",
      "pull-requests": "read",
    });
    expect(caller?.["continue-on-error"]).toBeUndefined();
    expect(caller?.["runs-on"]).toBeUndefined();
    expect(caller?.environment).toBeUndefined();
    expect(caller?.steps).toBeUndefined();
    expect(releaseSource).not.toContain("persist-credentials: true");

    const callerPattern =
      /uses:\s*openclaw\/openclaw\/\.github\/workflows\/openclaw-release-telegram-qa\.yml@main/gu;
    const callers = readdirSync(".github/workflows")
      .filter((name) => name.endsWith(".yml"))
      .flatMap((name) => {
        const path = `.github/workflows/${name}`;
        return Array.from(readFileSync(path, "utf8").matchAll(callerPattern), () => path);
      });
    expect(callers).toEqual([RELEASE_CHECKS_PATH]);
    expect(
      readdirSync(".github/workflows")
        .filter((name) => name.endsWith(".yml"))
        .map((name) => readFileSync(`.github/workflows/${name}`, "utf8"))
        .join("\n"),
    ).not.toContain("uses: ./.github/workflows/openclaw-release-telegram-qa.yml");
    expect(reusableSource).toContain(
      "openclaw/openclaw/.github/workflows/openclaw-release-telegram-qa.yml@refs/heads/main",
    );
    expect(reusableSource).toContain(
      '--cert-identity "https://github.com/openclaw/openclaw/.github/workflows/openclaw-release-telegram-qa.yml@refs/heads/main"',
    );
    expect(reusableSource).toContain('--signer-digest "$CALLED_WORKFLOW_SHA"');
    const resolveJob = releaseWorkflow.jobs?.resolve_target;
    expect(resolveJob?.outputs?.trusted_workflow_sha).toBe(
      "${{ steps.trusted_workflow.outputs.sha }}",
    );
    const resolveTrustedWorkflow = resolveJob?.steps?.find(
      (step) => step.name === "Resolve trusted main Telegram workflow SHA",
    );
    expect(resolveTrustedWorkflow?.run).toContain("--ref refs/heads/main");
    expect(resolveTrustedWorkflow?.run).not.toContain("--fallback-ok");
    const reusableWorkflow = parse(reusableSource) as {
      on?: {
        workflow_call?: {
          inputs?: Record<string, { required?: boolean; type?: string }>;
        };
      };
    };
    expect(reusableWorkflow.on?.workflow_call?.inputs?.expected_trusted_workflow_sha).toEqual({
      description: "Resolved main SHA authorized for this trusted reusable workflow",
      required: true,
      type: "string",
    });
  });

  it("binds called-main OIDC and job identity to the resolved main SHA", () => {
    const trustedSha = "b".repeat(40);
    const success = runIdentityVerification({
      callerWorkflowSha: "d".repeat(40),
      expectedTrustedWorkflowSha: trustedSha,
      jobWorkflowSha: trustedSha,
    });
    expect(success.status).toBe(0);

    const oidcDrifted = runIdentityVerification({
      expectedTrustedWorkflowSha: trustedSha,
      jobWorkflowSha: trustedSha,
      oidcWorkflowSha: "c".repeat(40),
    });
    expect(oidcDrifted.status).toBe(1);
    expect(oidcDrifted.stderr).toContain(
      "OIDC job_workflow_sha does not match the frozen trusted workflow SHA",
    );

    const jobDrifted = runIdentityVerification({
      expectedTrustedWorkflowSha: trustedSha,
      jobWorkflowSha: "c".repeat(40),
      oidcWorkflowSha: trustedSha,
    });
    expect(jobDrifted.status).toBe(1);
    expect(jobDrifted.stderr).toContain("job context workflow_sha mismatch");

    const mainMoved = runIdentityVerification({
      callerWorkflowSha: "d".repeat(40),
      expectedTrustedWorkflowSha: trustedSha,
      jobWorkflowSha: "c".repeat(40),
      oidcWorkflowSha: "c".repeat(40),
    });
    expect(mainMoved.status).toBe(1);
    expect(mainMoved.stderr).toContain("job context workflow_sha mismatch");
  });

  it("keeps candidate construction secretless and credentials inside the isolated runner", () => {
    const source = readFileSync(WORKFLOW_PATH, "utf8");
    const workflow = parse(source) as {
      jobs?: Record<string, WorkflowJob>;
    };
    const buildJob = workflow.jobs?.build_candidate;
    const runJob = workflow.jobs?.run_telegram;

    expect(JSON.stringify(buildJob)).not.toContain("secrets.");
    expect(runJob?.environment).toBe("qa-live-shared");
    const secretSteps = runJob?.steps
      ?.filter((step) => JSON.stringify(step).includes("secrets."))
      .map((step) => step.name);
    expect(secretSteps).toEqual(["Validate required QA credential env", "Run Telegram live lane"]);
    expect(source).not.toContain("secrets: inherit");
    expect(source).not.toContain("persist-credentials: true");

    for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
      for (const step of job.steps ?? []) {
        if (step.uses?.startsWith("actions/checkout@")) {
          expect(step.with?.["persist-credentials"], `${jobName}:${step.name}`).toBe(false);
        }
      }
    }
  });

  it("emits the release-check terminal status contract and fails closed", () => {
    const workflow = parse(readFileSync(WORKFLOW_PATH, "utf8")) as {
      jobs?: Record<string, WorkflowJob>;
    };
    const statusJob = workflow.jobs?.advisory_status;
    const recordStep = statusJob?.steps?.find((step) => step.name === "Record advisory status");
    const uploadStep = statusJob?.steps?.find((step) => step.name === "Upload advisory status");
    const requireStep = statusJob?.steps?.find(
      (step) => step.name === "Require successful Telegram release check",
    );

    for (const jobName of [
      "trusted_identity",
      "build_candidate",
      "attest_candidate",
      "run_telegram",
    ]) {
      expect(workflow.jobs?.[jobName]?.["continue-on-error"], jobName).toBeUndefined();
    }
    for (const jobName of ["build_candidate", "attest_candidate", "run_telegram"]) {
      expect(workflow.jobs?.[jobName]?.if, jobName).toBe("always()");
    }
    expect(statusJob?.if).toBe("always()");
    expect(recordStep?.run).toContain(
      "qa_live_telegram_release_checks-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}.env",
    );
    for (const field of [
      "run_id",
      "run_attempt",
      "target_sha",
      "workflow_sha",
      "job",
      "variant",
      "status",
      "job_status",
      "step_outcomes",
    ]) {
      expect(recordStep?.run).toContain(`printf '${field}=`);
    }
    expect(uploadStep?.if).toBe("always()");
    expect(uploadStep?.with?.name).toBe(
      "release-check-status-qa-live-telegram-${{ inputs.target_sha }}-${{ github.run_id }}-${{ github.run_attempt }}",
    );
    expect(uploadStep?.with?.path).toContain("${{ steps.record_status.outputs.status_file }}");
    expect(uploadStep?.with?.path).toContain("${{ steps.record_status.outputs.evidence_file }}");
    expect(requireStep?.if).toBe("always()");
    expect(requireStep?.run).toContain('[[ "$STATUS" == "success" ]]');
  });

  it("records producer failure and rejects the terminal status", () => {
    const result = runAdvisoryStatus({
      BUILD_RESULT: "failure",
      BUILD_STATUS: "failure",
    });

    expect(result.recordResult.status).toBe(0);
    expect(result.status).toBe("failure");
    expect(result.statusFile).toContain("status=failure\n");
    expect(result.statusFile).toContain("build:failure");
    expect(result.requireResult.status).toBe(1);
  });

  it("records empty producer output and rejects the terminal status", () => {
    const result = runAdvisoryStatus({
      IDENTITY_STATUS: "",
    });

    expect(result.recordResult.status).toBe(0);
    expect(result.status).toBe("failure");
    expect(result.statusFile).toContain("status=failure\n");
    expect(result.statusFile).toContain("identity: ");
    expect(result.requireResult.status).toBe(1);
  });

  it("accepts only complete successful producer evidence", () => {
    const result = runAdvisoryStatus();

    expect(result.recordResult.status).toBe(0);
    expect(result.status).toBe("success");
    expect(result.statusFile).toContain("status=success\n");
    expect(result.requireResult.status).toBe(0);
  });

  it("keeps the isolated SUT lifetime below the credential lease TTL", () => {
    const workflow = parse(readFileSync(WORKFLOW_PATH, "utf8")) as {
      jobs?: Record<string, WorkflowJob>;
    };
    const job = workflow.jobs?.run_telegram;
    expect(job?.["runs-on"]).toBe("ubuntu-24.04");
    expect(job?.["timeout-minutes"]).toBe(60);

    const validateStep = job?.steps?.find(
      (step) => step.name === "Validate required QA credential env",
    );
    expect(validateStep?.env?.RUNNER_ENVIRONMENT).toBe("${{ runner.environment }}");
    expect(validateStep?.env?.JOB_TIMEOUT_MINUTES).toBe("60");
    expect(validateStep?.env?.LEASE_TTL_MS).toBe("7200000");
    expect(validateStep?.run).toContain('[[ "$RUNNER_ENVIRONMENT" == "github-hosted" ]]');
    expect(validateStep?.run).toContain("JOB_TIMEOUT_MINUTES * 60 * 1000 < LEASE_TTL_MS");

    const runStep = job?.steps?.find((step) => step.name === "Run Telegram live lane");
    expect(runStep?.env?.OPENCLAW_QA_CREDENTIAL_LEASE_TTL_MS).toBe("7200000");
    expect(runStep?.env?.OPENCLAW_QA_TELEGRAM_SUT_CLEANUP_TIMEOUT_MS).toBe("60000");
    expect(runStep?.run).toContain("trap terminate_sut_uid_on_exit EXIT");
    expect(runStep?.run).toContain('"$OPENCLAW_QA_TELEGRAM_SUT_OPENCLAW_COMMAND" --terminate-uid');
  });

  it("serializes stderr behind the workflow-command pause", () => {
    const workflow = parse(readFileSync(WORKFLOW_PATH, "utf8")) as {
      jobs?: Record<string, WorkflowJob>;
    };
    const runStep = workflow.jobs?.run_telegram?.steps?.find(
      (step) => step.name === "Run Telegram live lane",
    );
    expect(runStep?.run).toMatch(
      /run_qa_attempt\(\) \(\n\s+set -euo pipefail\n\s+exec 2>&1\n\s+attempt=/u,
    );
    expect(runStep?.run).toContain("::stop-commands::%s");
  });

  it("derives SUT-writable paths from the verified runtime root after sudo", () => {
    const source = readFileSync(WORKFLOW_PATH, "utf8");
    expect(source).toContain('temp_root="$(realpath -e "${OPENCLAW_QA_TEMP_ROOT:?}")"');
    expect(source).toContain('proc_stat="$(cat "/proc/${pid}/stat")"');
    expect(source).not.toContain('proc_stat="$(cat /proc/self/stat)"');
    expect(source).toContain('if [[ "${1:-}" == "--root-verify" ]]');
    expect(source).toContain("signal.pidfd_send_signal(pidfd, signal_value)");
    expect(source).toContain('actual_executable="$(realpath -e "/proc/${pid}/exe")"');
    expect(source).toContain("cmdlineSha256: $cmdlineSha256");
    expect(source).toContain('export HOME="${temp_root}/home"');
    expect(source).toContain('export XDG_CONFIG_HOME="${temp_root}/xdg-config"');
    expect(source).toContain('if [[ "${1:-}" == "--root-terminate-uid" ]]');
  });
});
