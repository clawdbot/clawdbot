import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
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
  const targetSha = "a".repeat(40);
  const workdir = tempDirs.make("openclaw-telegram-identity-");
  const fakeBin = join(workdir, "bin");
  const curlPath = join(fakeBin, "curl");
  const githubOutput = join(workdir, "github-output");
  mkdirSync(fakeBin);
  const workflowSha = params.workflowSha ?? params.expectedTrustedWorkflowSha;
  const oidcWorkflowSha = params.oidcWorkflowSha ?? workflowSha;
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
    workflow_sha: oidcWorkflowSha,
  };
  const token = [
    Buffer.from("{}").toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "signature",
  ].join(".");
  writeFileSync(curlPath, "#!/usr/bin/env bash\nprintf '%s\\n' \"$FAKE_OIDC_JSON\"\n", {
    mode: 0o755,
  });
  const script = workflowStep(
    workflowJob("trusted_identity"),
    "Verify dispatched-main identity",
  ).run;
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
      TARGET_SHA: targetSha,
      WORKFLOW_REF: workflowRef,
      WORKFLOW_SHA: workflowSha,
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
  it("retries transient GitHub API responses during both provenance checks", () => {
    const workflow = parse(readFileSync(WORKFLOW_PATH, "utf8")) as {
      env?: Record<string, unknown>;
    };
    expect(workflow.env?.GH_TRANSIENT_SERVER_OR_NETWORK_PATTERN).toContain(
      "invalid character .* looking for beginning of value",
    );

    for (const [jobName, stepName] of [
      ["build_candidate", "Validate candidate release provenance"],
      ["run_telegram", "Revalidate candidate release provenance"],
    ] as const) {
      const script = workflowStep(workflowJob(jobName), stepName).run;
      expect(script).toContain("gh_with_retry()");
      expect(script).toContain("for attempt in 1 2 3 4 5");
      expect(script).toContain('stdout="$(gh "$@" 2>"$stderr_file")"');
      expect(script).toContain('cat "$stderr_file" >&2');
      expect(script).not.toContain('output="$(gh "$@" 2>&1)"');
      expect(script).toContain("gh_with_retry api \\\n");
      expect(script).toContain("gh_with_retry api graphql");
    }
  });

  it("attributes GitHub web-flow and unsigned release merges to their exact maintainer merger", () => {
    const source = readFileSync(WORKFLOW_PATH, "utf8");

    expect(source.match(/associatedPullRequests\(first:100\)/gu)).toHaveLength(2);
    expect(source.match(/headRefOid == \$sha/gu)).toHaveLength(2);
    expect(source.match(/\.headRepository\.nameWithOwner == \$repo/gu)).toHaveLength(2);
    expect(source).not.toContain("commits/${candidate_sha}/pulls");
    expect(source.match(/if \.signature == null then "missing"/gu)).toHaveLength(2);
    expect(source.match(/\$signature_status" == "invalid"/gu)).toHaveLength(2);
    expect(
      source.match(/\$signature_status" == "missing" \|\| "\$signer" == "web-flow"/gu),
    ).toHaveLength(2);
    expect(source.match(/\.mergeCommit\.oid == \$sha/gu)).toHaveLength(2);
    expect(source.match(/\.baseRefName == \$base/gu)).toHaveLength(2);
    expect(source.match(/\.baseRepository\.nameWithOwner == \$repo/gu)).toHaveLength(2);
    expect(source.match(/\.mergedBy\.login\] \| unique \| select\(length == 1\)/gu)).toHaveLength(
      2,
    );
    expect(source.match(/collaborators\/\$\{permission_actor\}\/permission/gu)).toHaveLength(2);
    expect((source.match(/extended-stable\/\[0-9\]/gu) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(source).not.toContain("collaborators/${signer}/permission");
  });

  it("resolves only candidate-specific provenance refs without fetching histories", () => {
    const source = readFileSync(WORKFLOW_PATH, "utf8");

    expect(source.match(/branches-where-head/gu)).toHaveLength(2);
    expect(source.match(/gh_with_retry api --paginate/gu)).toHaveLength(2);
    expect(
      source.match(/git(?: -C \.candidate)? ls-remote --exit-code --refs origin/gu),
    ).toHaveLength(2);
    expect(
      source.match(/git(?: -C \.candidate)? ls-remote origin 'refs\/tags\/v\*'/gu),
    ).toHaveLength(2);
    expect(source).not.toContain("'+refs/heads/release/*:refs/remotes/origin/release/*'");
    expect(source).not.toContain(
      "'+refs/heads/extended-stable/*:refs/remotes/origin/extended-stable/*'",
    );
    expect(source).not.toContain("'+refs/tags/v*:refs/tags/v*'");
  });

  it("dispatches one accepted trusted-main child from release checks", () => {
    const releaseSource = readFileSync(RELEASE_CHECKS_PATH, "utf8");
    const reusableSource = readFileSync(WORKFLOW_PATH, "utf8");
    const releaseWorkflow = parse(releaseSource) as {
      jobs?: Record<string, WorkflowJob>;
    };
    const caller = releaseWorkflow.jobs?.qa_live_telegram_release_checks;

    expect(caller?.needs).toEqual(["resolve_target"]);
    expect(caller?.if).toContain("needs.resolve_target.outputs.qa_live_telegram_enabled == 'true'");
    expect(caller?.permissions).toEqual({
      actions: "write",
      contents: "read",
    });
    expect(caller?.["timeout-minutes"]).toBe(210);
    expect(caller?.["continue-on-error"]).toBeUndefined();
    expect(caller?.["runs-on"]).toBe("ubuntu-24.04");
    expect(caller?.environment).toBeUndefined();
    const dispatch = caller?.steps?.find(
      (step) => step.name === "Dispatch and await trusted Telegram QA",
    );
    expect(dispatch?.run).toContain('gh workflow run "$workflow"');
    expect(dispatch?.run).toContain('--repo "$GITHUB_REPOSITORY"');
    expect(dispatch?.run).toContain("-F event=workflow_dispatch");
    expect(dispatch?.run).toContain(".display_title == env.RUN_NAME");
    expect(dispatch?.run).toContain("$(openssl rand -hex 16)");
    expect(dispatch?.run).toContain("trap cancel_child_on_failure EXIT");
    expect(dispatch?.run).toContain("for _ in $(seq 1 6)");
    expect(dispatch?.run).toContain("/actions/runs/${run_id}/cancel");
    expect(dispatch?.run).toContain("for dispatch_attempt in 1 2 3 4 5");
    expect(dispatch?.run).toContain('gh api "repos/${GITHUB_REPOSITORY}/commits/main"');
    expect(dispatch?.run).toContain(
      'if [[ "$child_head_sha" == "$expected_trusted_workflow_sha" ]]; then',
    );
    expect(dispatch?.run).toContain("Trusted main moved from");
    expect(dispatch?.run).toContain("Trusted main kept moving");
    expect(dispatch?.run).toContain("for _ in $(seq 1 1080)");
    expect(dispatch?.run).toContain("Trusted Telegram QA concluded ${conclusion}");
    expect(
      releaseSource.match(
        /"qa_live_telegram_release_checks=\$\{QA_LIVE_TELEGRAM_RELEASE_CHECKS_RESULT\}"/gu,
      ),
    ).toHaveLength(1);
    expect(releaseSource).not.toContain(
      "qa_live_matrix_release_checks|qa_live_telegram_release_checks|qa_live_discord_release_checks",
    );
    expect(releaseSource).not.toContain("persist-credentials: true");

    const dispatchers = readdirSync(".github/workflows")
      .filter((name) => name.endsWith(".yml"))
      .flatMap((name) => {
        const path = `.github/workflows/${name}`;
        return readFileSync(path, "utf8").includes('workflow="openclaw-release-telegram-qa.yml"')
          ? [path]
          : [];
      });
    expect(dispatchers).toEqual([RELEASE_CHECKS_PATH]);
    expect(reusableSource).toContain(
      "openclaw/openclaw/.github/workflows/openclaw-release-telegram-qa.yml@refs/heads/main",
    );
    expect(reusableSource).toContain(
      '--cert-identity "https://github.com/openclaw/openclaw/.github/workflows/openclaw-release-telegram-qa.yml@refs/heads/main"',
    );
    expect(reusableSource).toContain('--signer-digest "$CALLED_WORKFLOW_SHA"');
    const resolveJob = releaseWorkflow.jobs?.resolve_target;
    expect(resolveJob?.outputs?.trusted_workflow_sha).toBeUndefined();
    expect(
      resolveJob?.steps?.find((step) => step.name === "Resolve trusted main Telegram workflow SHA"),
    ).toBeUndefined();
    const dispatchedWorkflow = parse(reusableSource) as {
      on?: {
        workflow_call?: {
          inputs?: Record<string, { required?: boolean; type?: string }>;
          secrets?: Record<string, { required?: boolean }>;
        };
        workflow_dispatch?: {
          inputs?: Record<string, { required?: boolean; type?: string }>;
        };
      };
    };
    expect(dispatchedWorkflow.on?.workflow_dispatch?.inputs?.expected_trusted_workflow_sha).toEqual(
      {
        description: "Resolved main SHA authorized for this trusted workflow",
        required: true,
        type: "string",
      },
    );
    expect(dispatchedWorkflow.on?.workflow_dispatch?.inputs?.dispatch_id).toEqual({
      description: "Unique parent release-check dispatch identifier",
      required: true,
      type: "string",
    });
    expect(dispatchedWorkflow.on?.workflow_call?.inputs?.expected_trusted_workflow_sha).toEqual({
      description: "Resolved main SHA authorized for this trusted workflow",
      required: true,
      type: "string",
    });
    expect(dispatchedWorkflow.on?.workflow_call?.secrets).toHaveProperty(
      "OPENCLAW_QA_CONVEX_SECRET_CI",
    );
  });

  it("bounds the OIDC identity request below the job timeout", () => {
    const identityJob = workflowJob("trusted_identity");
    const identityStep = workflowStep(identityJob, "Verify dispatched-main identity");
    const oidcRequest = identityStep.run?.match(
      /curl --fail --silent --show-error[\s\S]*?audience=openclaw-release-telegram-qa/u,
    )?.[0];

    expect(identityJob["timeout-minutes"]).toBe(5);
    expect(oidcRequest).toContain("--connect-timeout 10");
    expect(oidcRequest).toContain("--max-time 30");
  });

  it("binds dispatched and legacy reusable OIDC identity to the resolved main SHA", () => {
    expect(
      workflowStep(workflowJob("trusted_identity"), "Verify dispatched-main identity").env
        ?.TARGET_REF,
    ).toBe("${{ inputs.target_ref }}");

    const trustedSha = "b".repeat(40);
    const success = runIdentityVerification({
      expectedTrustedWorkflowSha: trustedSha,
    });
    expect(success.status).toBe(0);

    const oidcDrifted = runIdentityVerification({
      expectedTrustedWorkflowSha: trustedSha,
      oidcWorkflowSha: "c".repeat(40),
    });
    expect(oidcDrifted.status).toBe(1);
    expect(oidcDrifted.stderr).toContain("OIDC workflow_sha mismatch");

    const mainMoved = runIdentityVerification({
      expectedTrustedWorkflowSha: trustedSha,
      workflowSha: "c".repeat(40),
    });
    expect(mainMoved.status).toBe(1);
    expect(mainMoved.stderr).toBe("");

    const reusableSuccess = runIdentityVerification({
      expectedTrustedWorkflowSha: trustedSha,
      invocation: "reusable",
      workflowSha: "d".repeat(40),
    });
    expect(reusableSuccess.status).toBe(0);

    const reusableDrifted = runIdentityVerification({
      expectedTrustedWorkflowSha: trustedSha,
      invocation: "reusable",
      oidcJobWorkflowSha: "c".repeat(40),
      workflowSha: "d".repeat(40),
    });
    expect(reusableDrifted.status).toBe(1);
    expect(reusableDrifted.stderr).toContain("OIDC job_workflow_sha mismatch");
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
    expect(source).toContain("trusted_scenario_source=verified_trusted_workflow_sha");

    for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
      for (const step of job.steps ?? []) {
        if (step.uses?.startsWith("actions/checkout@")) {
          expect(step.with?.["persist-credentials"], `${jobName}:${step.name}`).toBe(false);
        }
      }
    }
  });

  it("allows the tracked-file index to exceed Node's default child-process buffer", () => {
    const compareStep = workflowStep(
      workflowJob("attest_candidate"),
      "Compare candidate tracked source and tree",
    );

    expect(compareStep.run).toContain("maxBuffer: 16 * 1024 * 1024");
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
    expect(validateStep?.env?.CREDENTIAL_ACQUIRE_TIMEOUT_MS).toBe("600000");
    expect(validateStep?.env?.JOB_TIMEOUT_MINUTES).toBe("60");
    expect(validateStep?.env?.LEASE_TTL_MS).toBe("7200000");
    expect(validateStep?.run).toContain('[[ "$RUNNER_ENVIRONMENT" == "github-hosted" ]]');
    expect(validateStep?.run).toContain("JOB_TIMEOUT_MINUTES * 60 * 1000 < LEASE_TTL_MS");

    const runStep = job?.steps?.find((step) => step.name === "Run Telegram live lane");
    expect(runStep?.env?.OPENCLAW_QA_CREDENTIAL_ACQUIRE_TIMEOUT_MS).toBe("600000");
    expect(runStep?.env?.OPENCLAW_QA_CREDENTIAL_LEASE_TTL_MS).toBe("7200000");
    expect(runStep?.env?.OPENCLAW_LOG_LEVEL).toBe("trace");
    expect(runStep?.env?.OPENCLAW_QA_TELEGRAM_SUT_CLEANUP_TIMEOUT_MS).toBe("60000");
    expect(runStep?.run).toContain("trap terminate_sut_uid_on_exit EXIT");
    expect(runStep?.run).toContain('"$OPENCLAW_QA_TELEGRAM_SUT_OPENCLAW_COMMAND" --terminate-uid');
    expect(runStep?.run).toContain("run_qa_attempt preflight --scenario channel-canary");
    expect(runStep?.run).toContain('candidate_telegram_qa="$CANDIDATE_ROOT/extensions/qa-lab');
    expect(runStep?.run).toContain("grep -Fq '\"openai/gpt-5.5\": {'");
    expect(runStep?.run).toContain("! grep -Fq '\"openai/gpt-5.6-luna\": {'");
    expect(runStep?.run).toContain('qa_model="mock-openai/gpt-5.5"');
    expect(runStep?.run).toContain('--model "$qa_model"');
    expect(runStep?.run).toContain(
      "Telegram channel canary failed; skipping the remaining scenarios.",
    );
    expect(runStep?.run).toContain("--list-scenarios");
    expect(runStep?.run).toContain('"$scenario_id" != "channel-canary"');
    expect(runStep?.run).toContain(
      'run_qa_attempt "attempt-${attempt}" "${remaining_scenarios[@]}"',
    );
    expect(
      runStep?.run?.indexOf("run_qa_attempt preflight --scenario channel-canary"),
    ).toBeLessThan(runStep?.run?.indexOf("for attempt in 1 2") ?? -1);

    const finalizeStep = job?.steps?.find(
      (step) => step.name === "Finalize trusted Telegram process-boundary evidence",
    );
    expect(finalizeStep?.env?.RUN_LANE_OUTCOME).toBe("${{ steps.run_lane.outcome }}");
    expect(finalizeStep?.run).toContain('--arg runLaneOutcome "$RUN_LANE_OUTCOME"');
    expect(finalizeStep?.run).toContain('if $runLaneOutcome == "success" then 2 else 1 end');

    const captureStep = job?.steps?.find(
      (step) => step.name === "Capture isolated Telegram runtime diagnostics",
    );
    expect(captureStep?.if).toContain("steps.terminate_sut.outputs.quiescent == 'true'");
    expect(captureStep?.env?.OUTPUT_DIR).toBe("${{ steps.run_lane.outputs.output_dir }}");
    expect(captureStep?.env?.RUNTIME_ROOT).toBe("${{ steps.create_sut.outputs.runtime_root }}");
    expect(captureStep?.env?.RUN_LANE_OUTCOME).toBe("${{ steps.run_lane.outcome }}");
    expect(captureStep?.run).toContain('[[ "$RUN_LANE_OUTCOME" != "success" ]]');
    expect(captureStep?.run).toContain("((${#gateway_logs[@]} > 0))");
    expect(captureStep?.run).toContain("mapfile -d '' -t gateway_logs");
    expect(captureStep?.run).toContain("-printf '%T@\\t%p\\0'");
    expect(captureStep?.run).toContain("sort -z -nr");
    expect(captureStep?.run).toContain("sed -z -n '1,8p'");
    expect(captureStep?.run).toContain("cut -z -f2-");
    expect(captureStep?.run).toContain("((${#gateway_logs[@]} <= 8))");
    expect(captureStep?.run).toContain("((${#model_config_proofs[@]} > 0))");
    expect(captureStep?.run).toContain("-name 'openclaw-*.log'");
    expect(captureStep?.run).toContain(
      'trusted_temp_root="$(mktemp -d "${RUNNER_TEMP}/openclaw-telegram-diagnostics.XXXXXX")"',
    );
    expect(captureStep?.run).not.toContain(".raw");
    expect(captureStep?.run).toContain(
      'sudo cat "$log_path" | node --import tsx "$redactor_script" "$output_path"',
    );
    expect(captureStep?.run).toContain("const redactedLine =");
    expect(captureStep?.run).toContain("const limitBytes = 131_072");
    expect(captureStep?.run).toContain("const maxInputRecordBytes = 1_048_576");
    expect(captureStep?.run).toContain("safeVerboseMessagePrefixes");
    expect(captureStep?.run).toContain("shouldRetainRecord");
    expect(captureStep?.run).toContain('"[trace:embedded-run] prep stages:"');
    expect(captureStep?.run).toContain('"[context-diag] pre-prompt:"');
    expect(captureStep?.run).toContain('"model.call.started"');
    expect(captureStep?.run).toContain("[truncated oversized gateway log record]");
    expect(captureStep?.run).toContain("[omitted oversized gateway log record]");
    expect(captureStep?.run).toContain("chunk.indexOf(0x0a, offset)");
    expect(captureStep?.run).not.toContain("readline.createInterface");
    expect(captureStep?.run).toContain("while (retained.length > 0");
    expect(captureStep?.run).toContain("redactQaGatewayDebugText");
    expect(captureStep?.run).toContain("model_config_proofs");
    expect(captureStep?.run).toContain("proof_bytes > 0 && proof_bytes <= 65536");
    expect(captureStep?.run).not.toContain("-name openclaw.json");
    expect(
      job?.steps?.findIndex(
        (step) => step.name === "Capture isolated Telegram runtime diagnostics",
      ),
    ).toBeLessThan(
      job?.steps?.findIndex(
        (step) => step.name === "Finalize trusted Telegram process-boundary evidence",
      ) ?? -1,
    );

    const recordStep = job?.steps?.find((step) => step.name === "Record Telegram execution status");
    expect(recordStep?.env?.OUTCOMES).toContain("${{ steps.capture_diagnostics.outcome }}");
  });

  it("serializes stderr behind the workflow-command pause", () => {
    const workflow = parse(readFileSync(WORKFLOW_PATH, "utf8")) as {
      jobs?: Record<string, WorkflowJob>;
    };
    const runStep = workflow.jobs?.run_telegram?.steps?.find(
      (step) => step.name === "Run Telegram live lane",
    );
    expect(runStep?.run).toMatch(
      /run_qa_attempt\(\) \(\n\s+set -euo pipefail\n\s+exec 2>&1\n\s+output_name=/u,
    );
    expect(runStep?.run).toContain("::stop-commands::%s");
  });

  it.runIf(process.platform === "linux")("keeps only the newest eight gateway logs", () => {
    const captureStep = workflowStep(
      workflowJob("run_telegram"),
      "Capture isolated Telegram runtime diagnostics",
    );
    const selectorSource = captureStep.run?.match(
      /mapfile -d '' -t gateway_logs < <\([\s\S]*?^\)$/mu,
    )?.[0];
    expect(selectorSource).toBeTruthy();

    const workdir = tempDirs.make("openclaw-telegram-log-selector-");
    const runtimeRoot = join(workdir, "runtime");
    const fakeBin = join(workdir, "bin");
    mkdirSync(join(runtimeRoot, "tmp"), { recursive: true });
    mkdirSync(fakeBin);
    writeFileSync(join(fakeBin, "sudo"), '#!/bin/sh\nexec "$@"\n', { mode: 0o755 });

    const logPaths = Array.from({ length: 12 }, (_, index) => {
      const logDir = join(runtimeRoot, "tmp", `gateway-${index}`);
      const logPath = join(logDir, `openclaw-${index}.log`);
      mkdirSync(logDir);
      writeFileSync(logPath, `${index}\n`);
      utimesSync(logPath, index + 1, index + 1);
      return logPath;
    });
    const result = spawnSync(
      "bash",
      ["-c", `set -euo pipefail\n${selectorSource}\nprintf '%s\\0' "\${gateway_logs[@]}"`],
      {
        env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, RUNTIME_ROOT: runtimeRoot },
      },
    );
    expect(result.status, result.stderr.toString()).toBe(0);
    const selected = result.stdout.toString().split("\0").filter(Boolean);
    expect(selected).toEqual(logPaths.slice(4).reverse());
  });

  it("retains only allowlisted verbose runtime diagnostics", () => {
    const captureStep = workflowStep(
      workflowJob("run_telegram"),
      "Capture isolated Telegram runtime diagnostics",
    );
    const redactorSource = captureStep.run?.match(
      /cat >"\$redactor_script" <<'NODE'\n([\s\S]*?)\nNODE/u,
    )?.[1];
    expect(redactorSource).toBeTruthy();

    const workdir = tempDirs.make("openclaw-telegram-log-filter-");
    const scriptPath = join(workdir, "redact-gateway-tail.mts");
    const outputPath = join(workdir, "gateway.log");
    writeFileSync(scriptPath, redactorSource ?? "");
    const inputRecords = [
      { 0: '{"subsystem":"gateway"}', 1: "ordinary info", _meta: { logLevelName: "INFO" } },
      {
        0: '{"subsystem":"agents/embedded"}',
        1: "embedded run start: safe milestone",
        _meta: { logLevelName: "DEBUG" },
      },
      {
        0: '{"subsystem":"agents/embedded","details":"embedded run start: marker outside message"}',
        1: { details: "[context-diag] pre-prompt: structured marker outside message" },
        2: "verbose payload must drop",
        _meta: { logLevelName: "DEBUG" },
      },
      {
        0: '{"subsystem":"agents/embedded"}',
        1: "[context-diag] pre-prompt: safe counts",
        _meta: { logLevelName: "TRACE" },
      },
      {
        0: '{"subsystem":"agents/embedded"}',
        1: "trace payload must drop",
        message: "embedded run prompt end: convenience field must not authorize",
        _meta: { logLevelName: "TRACE" },
      },
    ]
      .map((record) => JSON.stringify(record))
      .join("\n");
    const input = `${inputRecords}\n{"0":"truncated verbose payload must drop"`;
    const result = spawnSync(process.execPath, ["--import", "tsx", scriptPath, outputPath], {
      cwd: process.cwd(),
      encoding: "utf8",
      input,
    });
    expect(result.status, result.stderr).toBe(0);
    const output = readFileSync(outputPath, "utf8");
    expect(output).toContain("ordinary info");
    expect(output).toContain("embedded run start: safe milestone");
    expect(output).toContain("[context-diag] pre-prompt: safe counts");
    expect(output).not.toContain("verbose payload must drop");
    expect(output).not.toContain("marker outside message");
    expect(output).not.toContain("convenience field must not authorize");
    expect(output).not.toContain("truncated verbose payload must drop");
    expect(output).not.toContain("trace payload must drop");
  });

  it("derives SUT-writable paths from the verified runtime root after sudo", () => {
    const source = readFileSync(WORKFLOW_PATH, "utf8");
    expect(source).toContain("Telegram SUT launcher failed: stage=%s line=%s status=%s");
    expect(source).toContain("launcher_stage=root-run-setup");
    expect(source).toContain("launcher_stage=enter-mount-namespace");
    expect(source).toContain("set_launcher_stage mask-host-paths");
    expect(source).toContain('launcher_stage_file="${RUNTIME_ROOT}/launcher-stage-${BASHPID}"');
    expect(source).toContain('set_launcher_stage "mask-host-path:${masked_path}"');
    expect(source).toContain("set_launcher_stage mount-proc");
    expect(source).toContain("set_launcher_stage write-identity");
    expect(source).toContain("set_launcher_stage launch-runtime");
    expect(source).toMatch(/set_launcher_stage launch-runtime\n\s+unset launcher_stage_file/u);
    expect(source).toContain("Telegram SUT runtime preflight failed: stage=%s line=%s status=%s");
    expect(source).toContain("runtime_stage=verify-runtime-identity");
    expect(source).toContain("runtime_stage=verify-runtime-privileges");
    expect(source).toContain("runtime_stage=verify-parent-proc-hidden");
    expect(source).toContain("runtime_stage=verify-proc-visibility");
    expect(source).toContain("for _ in {1..100}; do");
    expect(source).toMatch(
      /if tr "\\0" "\\n" <"\/proc\/\$\{control_pid\}\/environ" 2>\/dev\/null \|\n\s+grep -Fxq "OPENCLAW_QA_PROC_CONTROL=visible"; then/u,
    );
    expect(source).toContain("proc_marker_visible=true\n                        break");
    expect(source).toContain("sleep 0.05");
    expect(source).toContain('[[ "$proc_marker_visible" == "true" ]]');
    expect(source).toMatch(
      /kill "\$control_pid" >\/dev\/null 2>&1 \|\| true\n\s+wait "\$control_pid" \|\| true/u,
    );
    expect(source).toContain("runtime_stage=verify-secret-env-hidden");
    expect(source).toContain("runtime_stage=verify-runner-fds-hidden");
    expect(source).toContain("runtime_stage=verify-runtime-files");
    expect(source).toContain("runtime_stage=verify-host-paths-hidden");
    expect(source).toContain("runtime_stage=sanitize-runtime-env");
    expect(source).toContain("runtime_stage=verify-runtime-env");
    expect(source).toContain("runtime_stage=write-sandbox-proof");
    expect(source).toContain("runtime_stage=exec-runtime");
    expect(source).toContain('TMPDIR="${SUT_RUNTIME_ROOT}/tmp"');
    expect(source).toContain('"$RUNTIME_ROOT"/tmp/openclaw-qa-suite-*');
    expect(source.indexOf("launcher_stage=enter-mount-namespace")).toBeLessThan(
      source.indexOf("/usr/bin/unshare"),
    );
    expect(source).not.toContain("exec /usr/bin/unshare");
    expect(source).not.toContain("set -x");
    expect(source).toContain('source_node_bin="$(realpath -e "$(command -v node)")"');
    expect(source).toContain('node_bin="${runtime_root}/node"');
    expect(source).toContain('sudo install -o root -g root -m 0555 "$source_node_bin" "$node_bin"');
    expect(source).toContain(
      '[[ "$(stat -c \'%F:%a:%u:%g\' "$node_bin")" == "regular file:555:0:0" ]]',
    );
    expect(source).toContain('"$node_bin" --version >/dev/null');
    expect(source).toContain('for masked_path in "$RUNNER_HOME" /tmp /var/tmp /dev/shm');
    expect(source).not.toMatch(/^\s+node_bin="\$\(realpath -e "\$\(command -v node\)"\)"$/mu);
    expect(source).toContain('temp_root="$(realpath -e "${OPENCLAW_QA_TEMP_ROOT:?}")"');
    expect(source).toContain("sudo install -d -o root -g root -m 0700 /tmp/openclaw");
    expect(source).toContain(
      '-m 0711 \\\n            "${runtime_root}/tmp/openclaw-${runner_uid}"',
    );
    expect(source).toContain('"$RUNTIME_ROOT"/tmp/openclaw-"$RUNNER_UID"/openclaw-qa-suite-*');
    expect(source).toContain('proc_stat="$(cat "/proc/${pid}/stat")"');
    expect(source).not.toContain('proc_stat="$(cat /proc/self/stat)"');
    expect(source).toContain('if [[ "${1:-}" == "--root-verify" ]]');
    expect(source).toContain("signal.pidfd_send_signal(pidfd, signal_value)");
    expect(source).toContain('actual_executable="$(realpath -e "/proc/${pid}/exe")"');
    expect(source).toContain("cmdlineSha256: $cmdlineSha256");
    expect(source).toContain('export HOME="${temp_root}/home"');
    expect(source).toContain('export XDG_CONFIG_HOME="${temp_root}/xdg-config"');
    expect(source).toContain('if [[ "${1:-}" == "--root-terminate-uid" ]]');
    expect(source).toContain("OPENCLAW_LOG_LEVEL");
    expect(source).toContain("capture_live_model_config() {");
    expect(source).toContain('capture_live_model_config "$config_path"');
    expect(source).toContain('proof_tmp="${RUNTIME_ROOT}/gateway-model-config-${BASHPID}.json"');
    expect(source).toContain("proof_bytes > 0 && proof_bytes <= 65536");
    expect(source).toContain("before the QA suite removes its temp config");
    expect(source).toContain("agentDefaultModel:");
    expect(source).toContain("modelIds: ([.value.models[]?.id][:128]");
  });

  it("keeps the generated SUT launcher valid bash", () => {
    const createSutStep = workflowStep(
      workflowJob("run_telegram"),
      "Create isolated Telegram SUT identity and launcher",
    );
    const launcherSource = createSutStep.run?.match(
      /<<'LAUNCHER'\n([\s\S]*?)\nLAUNCHER(?:\n|$)/u,
    )?.[1];
    expect(launcherSource).toBeTruthy();

    const result = spawnSync("bash", ["-n"], {
      encoding: "utf8",
      input: launcherSource,
    });
    expect(result.status, result.stderr).toBe(0);
  });

  it.runIf(process.platform === "linux")(
    "captures only bounded model routing facts before candidate launch",
    () => {
      const createSutStep = workflowStep(
        workflowJob("run_telegram"),
        "Create isolated Telegram SUT identity and launcher",
      );
      const launcherSource = createSutStep.run?.match(
        /<<'LAUNCHER'\n([\s\S]*?)\nLAUNCHER(?:\n|$)/u,
      )?.[1];
      const captureSource = launcherSource?.match(
        /^capture_live_model_config\(\) \{[\s\S]*?^\}/mu,
      )?.[0];
      expect(captureSource).toBeTruthy();

      const workdir = tempDirs.make("openclaw-telegram-model-proof-");
      const runtimeRoot = join(workdir, "runtime");
      const evidenceRoot = join(workdir, "evidence");
      const configPath = join(workdir, "openclaw.json");
      const duplicateConfigPath = join(workdir, "openclaw-duplicate.json");
      mkdirSync(runtimeRoot);
      mkdirSync(evidenceRoot);
      writeFileSync(
        configPath,
        JSON.stringify({
          agents: {
            defaults: {
              model: { primary: "mock-openai/gpt-5.5", fallbacks: ["mock-openai/fallback"] },
              models: { "mock-openai/gpt-5.5": {}, "mock-openai/fallback": {} },
            },
          },
          models: {
            providers: {
              "mock-openai": {
                api: "openai-responses",
                endpoint: "https://example.invalid",
                ignoredField: "not-exported",
                models: [{ id: "gpt-5.5", ignoredField: "not-exported" }],
              },
            },
          },
        }),
      );
      writeFileSync(
        duplicateConfigPath,
        readFileSync(configPath, "utf8").replace("not-exported", "different-ignored-value"),
      );
      const result = spawnSync(
        "bash",
        [
          "-c",
          `set -euo pipefail\n${captureSource}\ncapture_live_model_config "$CONFIG_PATH"\ncapture_live_model_config "$DUPLICATE_CONFIG_PATH"\nfind "$EVIDENCE_ROOT/trusted-runtime-diagnostics" -type f -name 'gateway-model-config-*.json' -print`,
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            CONFIG_PATH: configPath,
            DUPLICATE_CONFIG_PATH: duplicateConfigPath,
            EVIDENCE_ROOT: evidenceRoot,
            RUNTIME_ROOT: runtimeRoot,
            RUNNER_GID: String(process.getgid?.() ?? 0),
            RUNNER_UID: String(process.getuid?.() ?? 0),
          },
        },
      );
      expect(result.status, result.stderr).toBe(0);
      const proofPaths = result.stdout.trim().split("\n");
      expect(proofPaths).toHaveLength(1);
      const proofPath = proofPaths[0]!;
      const proofText = readFileSync(proofPath, "utf8");
      expect(JSON.parse(proofText)).toEqual({
        agentDefaultModel: {
          primary: "mock-openai/gpt-5.5",
          fallbacks: ["mock-openai/fallback"],
        },
        agentModelRefs: ["mock-openai/fallback", "mock-openai/gpt-5.5"],
        providers: [{ id: "mock-openai", api: "openai-responses", modelIds: ["gpt-5.5"] }],
      });
      expect(proofText).not.toContain("not-exported");
      expect(proofText).not.toContain("example.invalid");
    },
  );

  it("arms the boundary preload only in the gateway main thread", () => {
    const createSutStep = workflowStep(
      workflowJob("run_telegram"),
      "Create isolated Telegram SUT identity and launcher",
    );
    const preloadSource = createSutStep.run?.match(/<<'PRELOAD'\n([\s\S]*?)\nPRELOAD/u)?.[1];
    expect(preloadSource).toBeTruthy();

    const workdir = tempDirs.make("openclaw-telegram-preload-");
    const preloadPath = join(workdir, "preload.mjs");
    writeFileSync(preloadPath, preloadSource ?? "");
    const env = { ...process.env };
    delete env.OPENCLAW_QA_SUT_PREENTRY_STOP;

    const mainResult = spawnSync(process.execPath, ["--import", preloadPath, "-e", ""], {
      encoding: "utf8",
      env,
    });
    expect(mainResult.status).not.toBe(0);
    expect(mainResult.stderr).toContain("trusted Telegram SUT preload was not armed");

    const workerResult = spawnSync(
      process.execPath,
      [
        "-e",
        `const { Worker } = require("node:worker_threads");\n` +
          `const worker = new Worker('require("node:worker_threads").parentPort.postMessage("ready")', { eval: true, execArgv: ["--import", ${JSON.stringify(preloadPath)}] });\n` +
          `worker.once("message", () => process.exit(0));\n` +
          `worker.once("error", (error) => { console.error(error); process.exit(1); });`,
      ],
      { encoding: "utf8", env, killSignal: "SIGKILL", timeout: 5_000 },
    );
    expect(workerResult.status, workerResult.stderr).toBe(0);
  });

  it("reports the namespace-entry stage when its supervised child fails", () => {
    const source = readFileSync(WORKFLOW_PATH, "utf8");
    const trapLine = source.match(/^\s+(trap 'exit_status=.*' ERR)$/mu)?.[1];
    expect(trapLine).toBeTruthy();

    const result = spawnSync(
      "bash",
      [
        "-c",
        `set -Eeuo pipefail\nlauncher_stage=enter-mount-namespace\n${trapLine}\nbash -c 'exit 23'`,
      ],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(23);
    expect(result.stderr).toMatch(
      /Telegram SUT launcher failed: stage=enter-mount-namespace line=[0-9]+ status=23/u,
    );
  });

  it("reports the persisted inner launcher stage when namespace supervision fails", () => {
    const source = readFileSync(WORKFLOW_PATH, "utf8");
    const trapLine = source.match(/^\s+(trap 'exit_status=.*' ERR)$/mu)?.[1];
    expect(trapLine).toBeTruthy();

    const workdir = tempDirs.make("openclaw-telegram-launcher-stage-");
    const stagePath = join(workdir, "stage");
    writeFileSync(stagePath, "mount-proc\n");
    const result = spawnSync(
      "bash",
      [
        "-c",
        `set -Eeuo pipefail\nlauncher_stage=enter-mount-namespace\nlauncher_stage_file=${JSON.stringify(stagePath)}\n${trapLine}\nbash -c 'exit 23'`,
      ],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(23);
    expect(result.stderr).toMatch(
      /Telegram SUT launcher failed: stage=mount-proc line=[0-9]+ status=23/u,
    );
  });

  it("reports the exact failing runtime preflight line", () => {
    const source = readFileSync(WORKFLOW_PATH, "utf8");
    const diagnosticSource = source.match(
      /^\s+(fail_runtime_stage\(\) \{[\s\S]*?^\s+\}\n\s+trap "fail_runtime_stage \\?\$\? \\?\$LINENO" ERR)$/mu,
    )?.[1];
    expect(diagnosticSource).toBeTruthy();

    const script = `set -Eeuo pipefail\nruntime_stage=runtime-test\n${diagnosticSource}\nfalse`;
    const failureLine = script.split("\n").findIndex((line) => line === "false") + 1;
    const result = spawnSync("bash", ["-c", script], { encoding: "utf8" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `Telegram SUT runtime preflight failed: stage=runtime-test line=${failureLine} status=1`,
    );
  });
});
