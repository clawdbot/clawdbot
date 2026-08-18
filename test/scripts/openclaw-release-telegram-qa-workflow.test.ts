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

const PROVENANCE_BLOCKS = [
  { jobName: "build_candidate", stepName: "Validate candidate release provenance" },
  { jobName: "run_telegram", stepName: "Revalidate candidate release provenance" },
] as const;

type ProvenanceBlock = (typeof PROVENANCE_BLOCKS)[number];

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
  targetContextRef?: string;
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
        TARGET_CONTEXT_REF: params.targetContextRef ?? "",
        TARGET_REF: params.targetContextRef ? "a".repeat(40) : "refs/heads/release/2026.7.1",
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

function runCandidateProvenance(
  provenanceBlock: ProvenanceBlock,
  params: {
    branchHeads?: string[];
    candidateVersion?: string;
    mergedPullRequests?: Array<{
      baseRefName?: string;
      baseRepository?: string;
      mergeCommitOid?: string;
      mergedBy?: string;
    }>;
    openPr?: boolean;
    permission?: "admin" | "maintain" | "write";
    remoteSha?: string;
    signature?: "invalid" | "maintainer" | "missing" | "web-flow";
    targetContextRef?: string;
    targetRef?: string;
  } = {},
) {
  const candidateSha = "a".repeat(40);
  const signature = params.signature ?? "maintainer";
  const targetContextRef = params.targetContextRef ?? "";
  const normalizedContextRef = targetContextRef
    .replace(/^refs\/heads\//u, "")
    .replace(/^refs\/tags\//u, "");
  const remoteRef = normalizedContextRef.startsWith("v")
    ? `refs/tags/${normalizedContextRef}`
    : `refs/heads/${normalizedContextRef || "release/2026.7.1"}`;
  const workdir = tempDirs.make("openclaw-telegram-provenance-");
  const fakeBin = join(workdir, "bin");
  mkdirSync(fakeBin);
  mkdirSync(join(workdir, ".candidate"));
  writeFileSync(
    join(workdir, ".candidate", "package.json"),
    JSON.stringify({ version: params.candidateVersion ?? "2026.7.1-beta.3" }),
  );
  const metadata = {
    data: {
      repository: {
        object: {
          oid: candidateSha,
          signature:
            signature === "missing"
              ? null
              : signature === "invalid"
                ? { isValid: false, state: "INVALID", signer: { login: "release-maintainer" } }
                : {
                    isValid: true,
                    state: "VALID",
                    signer: {
                      login: signature === "web-flow" ? "web-flow" : "release-maintainer",
                    },
                  },
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
              ...(params.mergedPullRequests ?? []).map((pullRequest) => ({
                state: "MERGED",
                baseRefName: pullRequest.baseRefName ?? "release/2026.7.1",
                baseRepository: {
                  nameWithOwner: pullRequest.baseRepository ?? "openclaw/openclaw",
                },
                mergeCommit: { oid: pullRequest.mergeCommitOid ?? candidateSha },
                mergedBy: { login: pullRequest.mergedBy ?? "release-maintainer" },
              })),
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
if [[ "$*" == *"/branches-where-head"* ]]; then printf '%s\\n' "$FAKE_BRANCH_HEADS"; exit 0; fi
if [[ "$*" == *"/compare/"* ]]; then printf '%s\\n' "behind"; exit 0; fi
if [[ "$*" == *"/collaborators/"*"/permission"* ]]; then printf '%s\\n' "$FAKE_PERMISSION"; exit 0; fi
exit 64
`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(fakeBin, "git"),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *"rev-parse HEAD"* ]]; then printf '%s\\n' "$TARGET_SHA"; exit 0; fi
if [[ "$*" == *"ls-remote"* ]]; then
  if [[ "$*" == *"refs/tags/"* && "$FAKE_REMOTE_REF" != refs/tags/* ]]; then exit 0; fi
  printf '%s\\t%s\\n' "$FAKE_REMOTE_SHA" "$FAKE_REMOTE_REF"
  exit 0
fi
exit 64
`,
    { mode: 0o755 },
  );
  return spawnSync("bash", ["-c", requireRun(provenanceBlock.jobName, provenanceBlock.stepName)], {
    cwd: workdir,
    encoding: "utf8",
    env: {
      ...process.env,
      FAKE_BRANCH_HEADS: (params.branchHeads ?? ["release/2026.7.1"]).join("\n"),
      FAKE_METADATA: JSON.stringify(metadata),
      FAKE_PERMISSION: JSON.stringify({
        permission: params.permission === "admin" ? "admin" : "write",
        role_name: params.permission ?? "maintain",
      }),
      FAKE_REMOTE_REF: remoteRef,
      FAKE_REMOTE_SHA: params.remoteSha ?? candidateSha,
      CANDIDATE_GIT_DIR:
        provenanceBlock.jobName === "build_candidate" ? join(workdir, ".candidate") : "",
      CANDIDATE_ROOT: join(workdir, ".candidate"),
      GH_TRANSIENT_SERVER_OR_NETWORK_PATTERN: "HTTP 5[0-9][0-9]",
      GITHUB_WORKSPACE: process.cwd(),
      GITHUB_REPOSITORY: "openclaw/openclaw",
      PATH: `${fakeBin}:${process.env.PATH}`,
      TARGET_CONTEXT_REF: targetContextRef,
      TARGET_REF:
        params.targetRef ?? (targetContextRef ? candidateSha : "refs/heads/release/2026.7.1"),
      TARGET_SHA: candidateSha,
    },
  });
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

    const candidateBuild = requireRun(
      "build_candidate",
      "Build candidate runtime without runner credentials",
    );
    expect(candidateBuild).toContain("pnpm build qaRuntime");
    expect(candidateBuild).not.toContain("scripts/build-all.mts");
    expect(requireRun("build_candidate", "Archive bounded candidate tree")).toContain(
      '--arg buildCommand "pnpm build qaRuntime"',
    );
    expect(requireRun("attest_candidate", "Bounded extract and validate candidate")).toContain(
      '.buildCommand == "pnpm build qaRuntime"',
    );
    expect(requireRun("run_telegram", "Build trusted QA harness").trim()).toBe(
      "pnpm build qaRuntime",
    );

    const runJob = job("run_telegram");
    expect(runJob.environment).toBe("qa-live-shared");
    expect(runJob["timeout-minutes"]).toBe(60);
    expect(requireRun("advisory_status", "Record advisory status").trim()).toBe(
      "set -euo pipefail\nnode scripts/release-telegram-qa.mjs advisory-status",
    );
    expect(
      PROVENANCE_BLOCKS.map(({ jobName, stepName }) => requireRun(jobName, stepName).trim()),
    ).toEqual([
      'bash "${GITHUB_WORKSPACE}/scripts/release-telegram-provenance.sh"',
      'bash "${GITHUB_WORKSPACE}/scripts/release-telegram-provenance.sh"',
    ]);
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
    for (const targetContextRef of [
      "release/2026.7.1",
      "extended-stable/2026.7.33",
      "v2026.7.1",
      "v2026.7.1-beta.3",
    ]) {
      const accepted = runIdentityVerification({
        expectedTrustedWorkflowSha: trustedSha,
        targetContextRef,
      });
      expect(accepted.status, `${targetContextRef}: ${accepted.stderr}`).toBe(0);
    }
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
    for (const provenanceBlock of PROVENANCE_BLOCKS) {
      const signed = runCandidateProvenance(provenanceBlock);
      expect(signed.status, `${provenanceBlock.stepName}: ${signed.stderr}`).toBe(0);

      const openPr = runCandidateProvenance(provenanceBlock, { openPr: true });
      expect(openPr.status, provenanceBlock.stepName).not.toBe(0);
      if (provenanceBlock.jobName === "build_candidate") {
        expect(openPr.stderr).toContain("open same-repository PR head");
      }
    }
  });

  it("accepts canonical beta release branch heads in both provenance blocks", () => {
    const results = PROVENANCE_BLOCKS.map((provenanceBlock) => ({
      provenanceBlock,
      result: runCandidateProvenance(provenanceBlock, {
        candidateVersion: "2026.7.1-beta.3",
        targetContextRef: "release/2026.7.1",
      }),
    }));
    expect(
      results.map(({ provenanceBlock, result }) => ({
        block: provenanceBlock.stepName,
        status: result.status,
        stderr: result.stderr,
      })),
    ).toEqual([
      { block: "Validate candidate release provenance", status: 0, stderr: "" },
      { block: "Revalidate candidate release provenance", status: 0, stderr: "" },
    ]);
  });

  it("accepts only strict signed frozen beta branch heads in both provenance blocks", () => {
    for (const provenanceBlock of PROVENANCE_BLOCKS) {
      const frozen = runCandidateProvenance(provenanceBlock, {
        branchHeads: ["release/2026.7.1-beta.3-code-frozen-r13"],
        candidateVersion: "2026.7.1-beta.3",
        remoteSha: "b".repeat(40),
        targetContextRef: "release/2026.7.1",
      });
      expect(frozen.status, `${provenanceBlock.stepName}: ${frozen.stderr}`).toBe(0);
      expect(frozen.stdout).toContain(
        "Telegram candidate trust reason: frozen-release-branch-head",
      );

      const rejectedCases = [
        {
          label: "stale frozen branch",
          params: {
            branchHeads: [] as string[],
          },
        },
        {
          label: "duplicate frozen branches",
          params: {
            branchHeads: [
              "release/2026.7.1-beta.3-code-frozen",
              "release/2026.7.1-beta.3-code-frozen-r13",
            ],
          },
        },
        {
          label: "wrong-version frozen branch",
          params: {
            branchHeads: ["release/2026.7.1-beta.2-code-frozen-r13"],
          },
        },
        {
          label: "non-exact target ref",
          params: {
            branchHeads: ["release/2026.7.1-beta.3-code-frozen-r13"],
            targetRef: "refs/heads/release/2026.7.1-beta.3-code-frozen-r13",
          },
        },
        {
          label: "missing signature",
          params: {
            branchHeads: ["release/2026.7.1-beta.3-code-frozen-r13"],
            signature: "missing" as const,
          },
        },
        {
          label: "invalid signature",
          params: {
            branchHeads: ["release/2026.7.1-beta.3-code-frozen-r13"],
            signature: "invalid" as const,
          },
        },
        {
          label: "web-flow signature",
          params: {
            branchHeads: ["release/2026.7.1-beta.3-code-frozen-r13"],
            signature: "web-flow" as const,
          },
        },
        {
          label: "low-permission signer",
          params: {
            branchHeads: ["release/2026.7.1-beta.3-code-frozen-r13"],
            permission: "write" as const,
          },
        },
        {
          label: "same-repository PR head",
          params: {
            branchHeads: ["release/2026.7.1-beta.3-code-frozen-r13"],
            openPr: true,
          },
        },
      ];
      for (const testCase of rejectedCases) {
        const rejected = runCandidateProvenance(provenanceBlock, {
          candidateVersion: "2026.7.1-beta.3",
          remoteSha: "b".repeat(40),
          targetContextRef: "release/2026.7.1",
          ...testCase.params,
        });
        expect(
          rejected.status,
          `${provenanceBlock.stepName}: ${testCase.label}: ${rejected.stderr}`,
        ).not.toBe(0);
      }
    }
  });

  it("attributes web-flow release heads through a unique integration-base merge", () => {
    const results = PROVENANCE_BLOCKS.flatMap((provenanceBlock) =>
      ["2026.7.1", "2026.7.1-beta.3"].map((candidateVersion) => ({
        candidateVersion,
        provenanceBlock,
        result: runCandidateProvenance(provenanceBlock, {
          candidateVersion,
          mergedPullRequests: [{ baseRefName: "release-integration/2026.7.1-repair-2" }],
          signature: "web-flow",
          targetContextRef: "release/2026.7.1",
        }),
      })),
    );
    expect(
      results.map(({ candidateVersion, provenanceBlock, result }) => ({
        block: provenanceBlock.stepName,
        candidateVersion,
        status: result.status,
        stderr: result.stderr,
      })),
    ).toEqual([
      {
        block: "Validate candidate release provenance",
        candidateVersion: "2026.7.1",
        status: 0,
        stderr: "",
      },
      {
        block: "Validate candidate release provenance",
        candidateVersion: "2026.7.1-beta.3",
        status: 0,
        stderr: "",
      },
      {
        block: "Revalidate candidate release provenance",
        candidateVersion: "2026.7.1",
        status: 0,
        stderr: "",
      },
      {
        block: "Revalidate candidate release provenance",
        candidateVersion: "2026.7.1-beta.3",
        status: 0,
        stderr: "",
      },
    ]);
  });

  it("keeps release provenance attribution fail-closed in both blocks", () => {
    for (const provenanceBlock of PROVENANCE_BLOCKS) {
      const cases = [
        {
          label: "stale canonical branch",
          params: {
            candidateVersion: "2026.7.1-beta.3",
            remoteSha: "b".repeat(40),
            targetContextRef: "release/2026.7.1",
          },
        },
        {
          label: "missing merge attribution",
          params: {
            candidateVersion: "2026.7.1",
            signature: "missing" as const,
            targetContextRef: "release/2026.7.1",
          },
        },
        {
          label: "ambiguous merge attribution",
          params: {
            candidateVersion: "2026.7.1",
            mergedPullRequests: [
              { baseRefName: "release-integration/2026.7.1-a" },
              { baseRefName: "release-integration/2026.7.1-b" },
            ],
            signature: "web-flow" as const,
            targetContextRef: "release/2026.7.1",
          },
        },
        {
          label: "foreign repository attribution",
          params: {
            candidateVersion: "2026.7.1",
            mergedPullRequests: [{ baseRepository: "fork/openclaw" }],
            signature: "web-flow" as const,
            targetContextRef: "release/2026.7.1",
          },
        },
        {
          label: "different merge commit attribution",
          params: {
            candidateVersion: "2026.7.1",
            mergedPullRequests: [{ mergeCommitOid: "b".repeat(40) }],
            signature: "web-flow" as const,
            targetContextRef: "release/2026.7.1",
          },
        },
        {
          label: "insufficient actor permission",
          params: {
            candidateVersion: "2026.7.1",
            mergedPullRequests: [{ baseRefName: "release-integration/2026.7.1-repair" }],
            permission: "write" as const,
            signature: "web-flow" as const,
            targetContextRef: "release/2026.7.1",
          },
        },
        {
          label: "invalid signature",
          params: {
            candidateVersion: "2026.7.1",
            signature: "invalid" as const,
            targetContextRef: "release/2026.7.1",
          },
        },
      ];
      for (const testCase of cases) {
        const rejected = runCandidateProvenance(provenanceBlock, testCase.params);
        expect(rejected.status, `${provenanceBlock.stepName}: ${testCase.label}`).not.toBe(0);
      }

      const missingSignature = runCandidateProvenance(provenanceBlock, {
        candidateVersion: "2026.7.1",
        mergedPullRequests: [{ baseRefName: "release-integration/2026.7.1-repair" }],
        permission: "admin",
        signature: "missing",
        targetContextRef: "release/2026.7.1",
      });
      expect(
        missingSignature.status,
        `${provenanceBlock.stepName}: ${missingSignature.stderr}`,
      ).toBe(0);

      const alpha = runCandidateProvenance(provenanceBlock, {
        candidateVersion: "2026.7.1-alpha.1",
        targetContextRef: "release/2026.7.1",
      });
      expect(alpha.status).toBe(1);
      expect(alpha.stderr).toContain(
        "Telegram candidate version 2026.7.1-alpha.1 does not belong to release 2026.7.1.",
      );
    }
  });

  it("binds every release context to candidate version and SHA", () => {
    for (const [targetContextRef, candidateVersion] of [
      ["release/2026.7.1", "2026.7.1"],
      ["extended-stable/2026.7.33", "2026.7.33"],
      ["v2026.7.1", "2026.7.1"],
      ["v2026.7.1-alpha.2", "2026.7.1-alpha.2"],
      ["v2026.7.1-beta.3", "2026.7.1-beta.3"],
    ] as const) {
      for (const provenanceBlock of PROVENANCE_BLOCKS) {
        const accepted = runCandidateProvenance(provenanceBlock, {
          candidateVersion,
          targetContextRef,
        });
        expect(accepted.status, `${provenanceBlock.stepName}:${targetContextRef}`).toBe(0);

        const versionMismatch = runCandidateProvenance(provenanceBlock, {
          candidateVersion: "2026.8.1",
          targetContextRef,
        });
        expect(versionMismatch.status, `${provenanceBlock.stepName}:${targetContextRef}`).toBe(1);

        const shaMismatch = runCandidateProvenance(provenanceBlock, {
          candidateVersion,
          remoteSha: "b".repeat(40),
          targetContextRef,
        });
        expect(shaMismatch.status, `${provenanceBlock.stepName}:${targetContextRef}`).toBe(1);
      }
    }
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

  it("lets the SUT create suite locks without exposing the runner-owned config", () => {
    const createSut = requireRun(
      "run_telegram",
      "Create isolated Telegram SUT identity and launcher",
    );

    expect(createSut).toContain('chown "$RUNNER_UID:$SUT_GID" "$temp_root"');
    expect(createSut).toContain('chmod 1770 "$temp_root"');
    expect(createSut).toContain(
      '"$(stat -c \'%F:%a:%u:%g\' "$temp_root")" == "directory:1770:${RUNNER_UID}:${SUT_GID}"',
    );
    expect(createSut).toContain('chown "$RUNNER_UID:$SUT_GID" "$config_path"');
    expect(createSut).toContain('chmod 0640 "$config_path"');
    expect(createSut).toContain(
      '"$(stat -c \'%F:%a:%u:%g\' "$config_path")" == "regular file:640:${RUNNER_UID}:${SUT_GID}"',
    );
    expect(createSut).not.toContain('chmod 0711 "$temp_root"');
    expect(createSut).not.toContain('chmod 1777 "$temp_root"');
  });

  it("adds an empty PS1 only after attested runtime environment verification", () => {
    const createSut = requireRun(
      "run_telegram",
      "Create isolated Telegram SUT identity and launcher",
    );
    const launcher = extractHereDocument(createSut, "LAUNCHER");
    const verification = '[[ "$actual_env_keys_b64" == "$runtime_expected_env_keys_b64" ]]';
    const ps1Export = "export PS1=";
    const candidateExec = 'exec "$runtime_node_bin" "${runtime_node_args[@]}"';

    expect(launcher.match(/export PS1=/gu)).toHaveLength(1);
    expect(launcher.indexOf(verification)).toBeGreaterThan(-1);
    expect(launcher.indexOf(ps1Export)).toBeGreaterThan(launcher.indexOf(verification));
    expect(launcher.indexOf(candidateExec)).toBeGreaterThan(launcher.indexOf(ps1Export));
    expect(launcher.match(/exec "\$runtime_node_bin"/gu)).toHaveLength(1);
    expect(launcher).toContain('grep -Ev "^(PWD|SHLVL|_)$"');
  });

  it("mounts an isolated SUT-owned tmp without exposing the host tmp tree", () => {
    const createSut = requireRun(
      "run_telegram",
      "Create isolated Telegram SUT identity and launcher",
    );
    const launcher = extractHereDocument(createSut, "LAUNCHER");

    expect(launcher).toContain('for masked_path in "$RUNNER_HOME" /var/tmp /dev/shm; do');
    expect(launcher).toContain("set_launcher_stage mount-private-tmp");
    expect(launcher).toContain(
      '-o "mode=0700,uid=${SUT_UID},gid=${SUT_GID},nosuid,nodev,noexec"',
    );
    expect(launcher).toContain("openclaw-telegram-sut-tmp");
    expect(launcher).toContain(
      '"$(stat -c \'%F:%a:%u:%g\' /tmp)" == "directory:700:${SUT_UID}:${SUT_GID}"',
    );
    expect(launcher).not.toContain('for masked_path in "$RUNNER_HOME" /tmp');
  });
});
