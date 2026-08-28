import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  assertAuthorizedEligibilityPlanDigest,
  assertAuthorizedBetaFocusedCandidate,
  digestAuthorizedBetaFocusedPolicy,
  digestAuthorizedPackageNames,
  readAuthorizedBetaFocusedPolicy,
  validateAuthorizedBetaFocusedArtifactShape,
  type AuthorizedBetaFocusedEvidence,
  type AuthorizedBetaFocusedPolicy,
  type AuthorizedBetaFocusedProducerIdentity,
} from "../../scripts/validate-authorized-beta-focused-evidence.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

type ParsedWorkflow = {
  jobs?: Record<
    string,
    {
      needs?: string | string[];
      outputs?: Record<string, string>;
      permissions?: Record<string, string>;
      steps?: Array<{
        env?: Record<string, string>;
        if?: string;
        name?: string;
        run?: string;
        uses?: string;
        with?: Record<string, unknown>;
      }>;
    }
  >;
  on: {
    workflow_dispatch: null | {
      inputs: Record<string, { options?: string[] }>;
    };
  };
  permissions?: Record<string, string>;
};

const REPO_ROOT = resolve(".");
const VALIDATOR_CLOSURE = [
  "scripts/authorized-beta-focused-policy.json",
  "scripts/lib/record-shared.mjs",
  "scripts/validate-authorized-beta-focused-evidence.mts",
  "scripts/verify-authorized-beta-focused-candidate.mjs",
] as const;

function stageValidatorClosure(root: string, scriptsDirectory: boolean): string {
  const targetRoot = scriptsDirectory ? join(root, "scripts") : root;
  for (const sourcePath of VALIDATOR_CLOSURE) {
    const relativePath = sourcePath.replace(/^scripts\//u, "");
    const targetPath = join(targetRoot, relativePath);
    mkdirSync(dirname(targetPath), { recursive: true });
    copyFileSync(join(REPO_ROOT, sourcePath), targetPath);
  }
  return join(targetRoot, "validate-authorized-beta-focused-evidence.mts");
}

function namedStep(workflow: ParsedWorkflow, jobName: string, stepName: string) {
  const step = workflow.jobs?.[jobName]?.steps?.find((entry) => entry.name === stepName);
  if (!step) {
    throw new Error(`workflow step missing: ${jobName}/${stepName}`);
  }
  return step;
}

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function commit(root: string, message: string): string {
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-qm", message], { cwd: root });
  return git(root, ["rev-parse", "HEAD"]);
}

function fixturePolicy(): { policy: AuthorizedBetaFocusedPolicy; root: string } {
  const root = tempDirs.make("authorized-beta-focused-");
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  writeFileSync(join(root, "published.txt"), "published\n");
  const historicalToolingSha = commit(root, "historical tooling");
  mkdirSync(join(root, ".github", "workflows"), { recursive: true });
  mkdirSync(join(root, "scripts"));
  writeFileSync(
    join(root, ".github", "workflows", "authorized-beta-focused-validation.yml"),
    "name: Authorized Beta Focused Validation\n",
  );
  writeFileSync(
    join(root, "scripts", "authorized-beta-focused-policy.json"),
    JSON.stringify({ historicalToolingSha }),
  );
  mkdirSync(join(root, "tests"));
  writeFileSync(join(root, "tests", "proof.test.ts"), "one\n");
  const baseCandidateSha = commit(root, "base");
  writeFileSync(join(root, "tests", "proof.test.ts"), "one\ntwo\n");
  const candidateSha = commit(root, "proof");
  const candidateTreeSha = git(root, ["rev-parse", `${candidateSha}^{tree}`]);
  const baseTreeSha = git(root, ["rev-parse", `${baseCandidateSha}^{tree}`]);
  const projection = git(root, ["ls-tree", "-r", candidateSha])
    .split("\n")
    .filter((line) => !line.endsWith("\ttests/proof.test.ts"))
    .join("\n");
  const packageProjectionSha256 = createHash("sha256").update(`${projection}\n`).digest("hex");
  return {
    root,
    policy: {
      ...readAuthorizedBetaFocusedPolicy(),
      baseCandidateSha,
      candidateSha,
      historicalToolingSha,
      reviewedHeadSha: candidateSha,
      candidateTreeSha,
      baseTreeSha,
      packageProjectionSha256,
      changedPaths: [
        {
          path: "tests/proof.test.ts",
          status: "M",
          added: 1,
          deleted: 0,
        },
      ],
    },
  };
}

function runFocusedValidatorLogProbe(outcome: "flagged" | "legacy" | "unrelated") {
  const { policy, root } = fixturePolicy();
  const trustedRoot = tempDirs.make("authorized-beta-focused-job-log-");
  const validatorPath = stageValidatorClosure(trustedRoot, false);
  const artifactPath = join(trustedRoot, "evidence.json");
  const callsPath = join(trustedRoot, "gh-log-calls.jsonl");
  const historical = policy.historicalFrv;
  const focused = policy.focusedProof;
  const producerSha = "a".repeat(40);
  const producerRef = "release-publish/aaaaaaaaaaaa-1";
  const producer: AuthorizedBetaFocusedProducerIdentity = {
    repository: "openclaw/openclaw",
    runId: "123",
    runAttempt: 1,
    workflowPath: ".github/workflows/authorized-beta-focused-validation.yml",
    workflowFullRef: `refs/tags/${producerRef}`,
    workflowRef: producerRef,
    workflowSha: producerSha,
  };
  const createRun = (
    id: string,
    name: string,
    path: string,
    headBranch: string,
    headSha: string,
    conclusion = "success",
  ) => ({
    id,
    run_attempt: 1,
    name,
    path,
    event: "workflow_dispatch",
    status: "completed",
    conclusion,
    head_branch: headBranch,
    head_sha: headSha,
  });
  const createJob = (id: string, runId: string, name: string, conclusion: string) => ({
    id,
    run_id: runId,
    name,
    status: "completed",
    conclusion,
    head_sha: policy.historicalToolingSha,
  });
  const historicalTitle = `full-release-validation-${historical.runId}-${historical.runAttempt}`;
  const historicalRun = (id: string, name: string, path: string, conclusion = "success") =>
    createRun(id, name, path, historical.workflowRef, policy.historicalToolingSha, conclusion);
  const focusedRun = (id: string, name: string, path: string, conclusion = "success") =>
    createRun(
      id,
      name,
      path,
      policy.historicalToolingRef.replace("refs/tags/", ""),
      policy.historicalToolingSha,
      conclusion,
    );
  const runs = [
    createRun(
      producer.runId,
      "Authorized Beta Focused Validation",
      producer.workflowPath,
      producerRef,
      producerSha,
    ),
    historicalRun(historical.runId, "Full Release Validation", historical.workflowPath, "failure"),
    historicalRun(
      historical.ciRunId,
      `CI ${historicalTitle}-ci`,
      ".github/workflows/ci.yml",
      "failure",
    ),
    historicalRun(
      historical.pluginRunId,
      `Plugin Prerelease ${historicalTitle}-plugin-prerelease`,
      ".github/workflows/plugin-prerelease.yml",
      "failure",
    ),
    historicalRun(
      historical.releaseChecksRunId,
      `OpenClaw Release Checks ${historicalTitle}-release-checks`,
      ".github/workflows/openclaw-release-checks.yml",
    ),
    historicalRun(
      historical.performanceRunId,
      `OpenClaw Performance ${historicalTitle}`,
      ".github/workflows/openclaw-performance.yml",
      "failure",
    ),
    focusedRun(focused.ciRunId, "CI beta3-slack-proof-e347223a", ".github/workflows/ci.yml"),
    focusedRun(
      focused.pluginRunId,
      "Plugin Prerelease beta3-slack-proof-e347223a",
      ".github/workflows/plugin-prerelease.yml",
      "failure",
    ),
  ];
  const jobs = [
    createJob(historical.ciFailedJobId, historical.ciRunId, "check-lint", "failure"),
    createJob(historical.ciAggregateJobId, historical.ciRunId, "openclaw/ci-gate", "failure"),
    createJob(
      historical.pluginFailedJobId,
      historical.pluginRunId,
      "checks-node-extensions-shard-7",
      "failure",
    ),
    createJob(
      historical.pluginAggregateJobId,
      historical.pluginRunId,
      "plugin-prerelease-suite",
      "failure",
    ),
    createJob(
      historical.releaseChecksVerifierJobId,
      historical.releaseChecksRunId,
      "Verify release checks",
      "success",
    ),
    createJob(
      historical.performanceFailedJobId,
      historical.performanceRunId,
      "OpenClaw source performance probes",
      "failure",
    ),
    createJob(focused.ciSuccessJobId, focused.ciRunId, "check-lint", "success"),
    createJob(focused.ciTargetLogJobId, focused.ciRunId, "preflight", "success"),
    createJob(
      focused.pluginSuccessJobId,
      focused.pluginRunId,
      "checks-node-extensions-shard-7",
      "success",
    ),
    createJob(
      focused.pluginTargetLogJobId,
      focused.pluginRunId,
      "Build plugin prerelease plan",
      "success",
    ),
  ];
  const plan = {
    parentRunId: historical.runId,
    parentRunAttempt: historical.runAttempt,
    workflowRef: historical.workflowRef,
    workflowSha: policy.historicalToolingSha,
    targetSha: historical.targetSha,
    releaseProfile: "beta",
    rerunGroup: "all",
    children: [
      { key: "normalCi", selected: true, runId: historical.ciRunId },
      { key: "pluginPrerelease", selected: true, runId: historical.pluginRunId },
      { key: "releaseChecks", selected: true, runId: historical.releaseChecksRunId },
      { key: "productPerformance", selected: true, runId: historical.performanceRunId },
    ],
  };
  const evidence: AuthorizedBetaFocusedEvidence = {
    schema: "openclaw.authorized-beta-focused-evidence.v1",
    mode: "authorized-beta-focused-v1",
    policySha256: digestAuthorizedBetaFocusedPolicy(policy),
    releaseTag: policy.releaseTag,
    candidate: {
      sha: policy.candidateSha,
      parentSha: policy.baseCandidateSha,
      treeSha: policy.candidateTreeSha,
      packageProjectionSha256: policy.packageProjectionSha256,
      changedPaths: policy.changedPaths,
    },
    producer,
    historical: {
      frvRunId: historical.runId,
      frvRunAttempt: historical.runAttempt,
      releaseChecksRunId: historical.releaseChecksRunId,
      performanceRunId: historical.performanceRunId,
    },
    focused: {
      ciRunId: focused.ciRunId,
      ciJobId: focused.ciSuccessJobId,
      pluginRunId: focused.pluginRunId,
      pluginJobId: focused.pluginSuccessJobId,
      reviewedHeadSha: policy.reviewedHeadSha,
    },
    inventory: { eligibilityPlanDigest: policy.eligibilityPlanDigest, ...policy.inventory },
  };
  writeFileSync(join(trustedRoot, "authorized-beta-focused-policy.json"), JSON.stringify(policy));
  writeFileSync(artifactPath, JSON.stringify(evidence));
  const apiResponses = [
    ...runs.map((run) => [`repos/openclaw/openclaw/actions/runs/${run.id}`, run] as const),
    ...jobs.map((job) => [`repos/openclaw/openclaw/actions/jobs/${job.id}`, job] as const),
    [
      `repos/openclaw/openclaw/git/ref/tags/${producerRef}`,
      { object: { type: "commit", sha: producerSha } },
    ] as const,
  ];
  writeFileSync(
    join(trustedRoot, "gh"),
    [
      "#!/bin/sh",
      'command="$1"; route="$2"; shift 2',
      'if [ "$command" = run ] && [ "$route" = download ]; then',
      '  while [ "$1" != --dir ]; do shift; done',
      `  printf '%s' '${JSON.stringify(plan)}' > "$2/full-release-execution-plan.json"`,
      "  exit 0",
      "fi",
      'if [ "$command" = api ] && [ "${route%/logs}" != "$route" ]; then',
      '  if [ "$1" = --allow-escape-sequences ]; then',
      `    printf '["api","%s","--allow-escape-sequences"]\\n' "$route" >> '${callsPath}'`,
      `    if [ "$route" = 'repos/openclaw/openclaw/actions/jobs/${focused.ciTargetLogJobId}/logs' ] && [ '${outcome}' != flagged ]; then`,
      `      if [ '${outcome}' = legacy ]; then`,
      "        printf 'unknown flag: --allow-escape-sequences\\r\\n\\r\\nUsage: gh api <endpoint> [flags]\\r\\n' >&2",
      "      else",
      "        printf 'error: unknown flag: --allow-escape-sequences\\n' >&2",
      "      fi",
      "      exit 1",
      "    fi",
      "  else",
      `    printf '["api","%s"]\\n' "$route" >> '${callsPath}'`,
      "  fi",
      `  printf '\\033[32m${policy.reviewedHeadSha}\\033[0m'`,
      "  exit 0",
      "fi",
      'if [ "$command" = api ]; then',
      '  case "$route" in',
      ...apiResponses.map(
        ([route, response]) => `    '${route}') printf '%s' '${JSON.stringify(response)}' ;;`,
      ),
      "    *) printf 'unexpected GitHub API route: %s\\n' \"$route\" >&2; exit 1 ;;",
      "  esac",
      "  exit 0",
      "fi",
      'printf \'unexpected gh invocation: %s %s\\n\' "$command" "$route" >&2',
      "exit 1",
    ].join("\n"),
    { mode: 0o755 },
  );

  const result = spawnSync(
    process.execPath,
    [
      validatorPath,
      "verify",
      "--candidate-root",
      root,
      "--artifact",
      artifactPath,
      "--producer-run-id",
      producer.runId,
      "--producer-run-attempt",
      String(producer.runAttempt),
      "--producer-workflow-full-ref",
      producer.workflowFullRef,
      "--producer-workflow-sha",
      producer.workflowSha,
    ],
    {
      encoding: "utf8",
      env: { ...process.env, PATH: `${trustedRoot}:${process.env.PATH ?? ""}` },
    },
  );
  const calls = readFileSync(callsPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[]);
  return { calls, policy, result };
}

function stageCandidateVerifier(policy: AuthorizedBetaFocusedPolicy, shouldFail = false) {
  const trustedRoot = tempDirs.make("authorized-beta-focused-trusted-");
  const validatorPath = stageValidatorClosure(trustedRoot, false);
  const policyPath = join(trustedRoot, "authorized-beta-focused-policy.json");
  const markerPath = join(trustedRoot, "candidate-verifier.json");
  writeFileSync(policyPath, JSON.stringify(policy));
  const fixtureValidatorPath = join(trustedRoot, "candidate-verifier.mjs");
  writeFileSync(
    fixtureValidatorPath,
    [
      `import { readdirSync, writeFileSync } from "node:fs";`,
      `import { assertAuthorizedBetaFocusedCandidate, readAuthorizedBetaFocusedPolicy } from ${JSON.stringify(pathToFileURL(validatorPath).href)};`,
      `const args = process.argv.slice(2);`,
      `const candidateRoot = args[args.indexOf("--candidate-root") + 1];`,
      `assertAuthorizedBetaFocusedCandidate(readAuthorizedBetaFocusedPolicy(), candidateRoot);`,
      `writeFileSync(${JSON.stringify(markerPath)}, JSON.stringify({ args, candidateRoot, entries: readdirSync(candidateRoot) }));`,
      shouldFail ? `throw new Error("trusted fixture verifier rejected evidence");` : "",
    ].join("\n"),
  );
  return {
    fixtureValidatorPath,
    helperPath: join(trustedRoot, "verify-authorized-beta-focused-candidate.mjs"),
    markerPath,
    policyPath,
    validatorPath,
  };
}

function runCandidateVerifier(params: {
  helperPath?: string;
  policyPath: string;
  repositoryRoot: string;
  validatorPath: string;
  verifierArgs?: string[];
}) {
  return spawnSync(
    process.execPath,
    [
      params.helperPath ?? join(REPO_ROOT, "scripts/verify-authorized-beta-focused-candidate.mjs"),
      "--repository-root",
      params.repositoryRoot,
      "--validator",
      params.validatorPath,
      "--policy",
      params.policyPath,
      ...(params.verifierArgs ?? []),
    ],
    { encoding: "utf8" },
  );
}

function resolveFocusedProducer(
  options: {
    annotatedTag?: boolean;
    boundary?: "docker" | "resolve";
    consumer?: "ancestor" | "current" | "diverged";
    missingTag?: boolean;
    producer?: "policy-drift" | "unanchored" | "workflow-drift";
    run?: Record<string, unknown>;
    tag?: Record<string, unknown>;
  } = {},
) {
  const { policy, root } = fixturePolicy();
  let producerSha = options.consumer === "current" ? policy.candidateSha : policy.baseCandidateSha;
  const consumerSha = policy.candidateSha;
  if (options.consumer === "diverged" || options.producer) {
    if (options.producer === "unanchored") {
      git(root, ["checkout", "--quiet", "--orphan", "unanchored-producer"]);
    } else {
      git(root, ["checkout", "--quiet", "--detach", policy.baseCandidateSha]);
    }
    if (options.producer === "policy-drift") {
      writeFileSync(
        join(root, "scripts", "authorized-beta-focused-policy.json"),
        JSON.stringify({ historicalToolingSha: "f".repeat(40) }),
      );
    } else if (options.producer === "workflow-drift") {
      writeFileSync(
        join(root, ".github", "workflows", "authorized-beta-focused-validation.yml"),
        "name: Untrusted Validation\n",
      );
    } else {
      writeFileSync(join(root, "published.txt"), "protected producer branch\n");
    }
    producerSha = commit(root, "protected producer");
    git(root, ["checkout", "--quiet", "--detach", consumerSha]);
  }
  const producerRef = `release-publish/${producerSha.slice(0, 12)}-123`;
  const outputPath = join(root, "github-output");
  const isDockerBoundary = options.boundary === "docker";
  const workflow = parse(
    readFileSync(
      isDockerBoundary
        ? ".github/workflows/docker-release.yml"
        : ".github/workflows/openclaw-release-publish.yml",
      "utf8",
    ),
  ) as ParsedWorkflow;
  const run = {
    id: 123,
    run_attempt: 2,
    name: "Authorized Beta Focused Validation",
    path: ".github/workflows/authorized-beta-focused-validation.yml",
    event: "workflow_dispatch",
    status: "completed",
    conclusion: "success",
    head_branch: producerRef,
    head_sha: producerSha,
    ...options.run,
  };
  const tag = {
    ref: `refs/tags/${producerRef}`,
    object: { sha: producerSha, type: options.annotatedTag ? "tag" : "commit" },
    ...options.tag,
  };
  const result = spawnSync(
    "bash",
    [
      "-c",
      [
        "gh() {",
        '  if [[ "$2" == */actions/runs/* ]]; then',
        '    if [[ "${3:-}" == --jq ]]; then',
        '      printf "%s\\n" "$MOCK_RUN_JSON" | jq -r "$4"',
        "    else",
        '      printf "%s\\n" "$MOCK_RUN_JSON"',
        "    fi",
        '  elif [[ "$2" == */git/ref/tags/* && "$MOCK_TAG_MISSING" != true ]]; then',
        '    printf "%s\\n" "$MOCK_TAG_JSON" | jq -r "$4"',
        "  else",
        "    return 1",
        "  fi",
        "}",
        namedStep(
          workflow,
          isDockerBoundary ? "resolve_build_provenance" : "resolve_release_target",
          isDockerBoundary
            ? "Revalidate focused evidence producer after Docker approval"
            : "Resolve focused release evidence run",
        ).run,
      ].join("\n"),
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        FOCUSED_RELEASE_EVIDENCE_RUN_ATTEMPT: "2",
        FOCUSED_RELEASE_EVIDENCE_RUN_ID: "123",
        GITHUB_OUTPUT: outputPath,
        GITHUB_REPOSITORY: "openclaw/openclaw",
        MOCK_RUN_JSON: JSON.stringify(run),
        MOCK_TAG_JSON: JSON.stringify(tag),
        MOCK_TAG_MISSING: String(options.missingTag ?? false),
        PRODUCER_WORKFLOW_FULL_REF: `refs/tags/${producerRef}`,
        PRODUCER_WORKFLOW_SHA: producerSha,
        WORKFLOW_SHA: consumerSha,
      },
    },
  );
  return { consumerSha, outputPath, producerRef, producerSha, result };
}

describe("authorized beta focused evidence", () => {
  it.each(["ancestor", "current", "diverged"] as const)(
    "accepts an exact protected focused producer from %s trusted tooling",
    (consumer) => {
      const { outputPath, producerRef, producerSha, result } = resolveFocusedProducer({ consumer });

      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(readFileSync(outputPath, "utf8")).toBe(
        `attempt=2\nworkflow_full_ref=refs/tags/${producerRef}\nworkflow_sha=${producerSha}\n`,
      );
    },
  );

  it.each([
    { name: "unanchored producer", options: { producer: "unanchored" as const } },
    { name: "producer policy drift", options: { producer: "policy-drift" as const } },
    { name: "producer workflow drift", options: { producer: "workflow-drift" as const } },
    {
      name: "moved producer tag",
      options: { tag: { object: { sha: "f".repeat(40), type: "commit" } } },
    },
    { name: "missing producer tag", options: { missingTag: true } },
    { name: "annotated producer tag", options: { annotatedTag: true } },
    {
      name: "producer SHA prefix mismatch",
      options: { run: { head_branch: "release-publish/ffffffffffff-123" } },
    },
    {
      name: "malformed producer tag",
      options: { run: { head_branch: "release-publish/ffffffffffff-0" } },
    },
    {
      name: "wrong producer workflow path",
      options: { run: { path: ".github/workflows/openclaw-release-publish.yml" } },
    },
    { name: "wrong producer workflow name", options: { run: { name: "Other Validation" } } },
    { name: "wrong producer event", options: { run: { event: "push" } } },
    { name: "unfinished producer", options: { run: { status: "in_progress" } } },
    { name: "failed producer", options: { run: { conclusion: "failure" } } },
    { name: "wrong producer attempt", options: { run: { run_attempt: 3 } } },
  ])("rejects $name before focused artifact download", ({ options }) => {
    expect(resolveFocusedProducer(options).result.status).not.toBe(0);
  });

  it("accepts the exact focused producer again after Docker approval", () => {
    const { result } = resolveFocusedProducer({ boundary: "docker", consumer: "diverged" });

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it.each([
    {
      name: "moved producer tag",
      options: { tag: { object: { sha: "f".repeat(40), type: "commit" } } },
    },
    { name: "missing producer tag", options: { missingTag: true } },
    { name: "rerun producer", options: { run: { run_attempt: 3 } } },
    { name: "substituted producer", options: { run: { head_sha: "f".repeat(40) } } },
    { name: "failed producer", options: { run: { conclusion: "failure" } } },
  ])("rejects $name after Docker approval before registry access", ({ options }) => {
    expect(resolveFocusedProducer({ ...options, boundary: "docker" }).result.status).not.toBe(0);
  });

  it("gates every Docker build on post-approval focused evidence revalidation", () => {
    const docker = parse(
      readFileSync(".github/workflows/docker-release.yml", "utf8"),
    ) as ParsedWorkflow;
    const gate = docker.jobs?.resolve_build_provenance;
    if (!gate) {
      throw new Error("Docker build provenance gate is missing");
    }

    expect(gate.needs).toContain("approve_docker_publish");
    expect(gate.permissions).toMatchObject({
      actions: "read",
      attestations: "read",
      contents: "read",
    });
    const names = (gate.steps ?? []).map((step) => step.name);
    const revalidation = names.indexOf(
      "Revalidate focused evidence producer after Docker approval",
    );
    const download = names.indexOf("Download focused release evidence after Docker approval");
    const verification = names.indexOf("Verify focused release evidence after Docker approval");
    const provenance = names.indexOf("Resolve shared build provenance");
    expect(revalidation).toBeGreaterThan(-1);
    expect(revalidation).toBeLessThan(download);
    expect(download).toBeLessThan(verification);
    expect(verification).toBeLessThan(provenance);
    const verifyStep = namedStep(
      docker,
      "resolve_build_provenance",
      "Verify focused release evidence after Docker approval",
    );
    expect(verifyStep.run).toContain("verify-authorized-beta-focused-candidate.mjs");
    expect(verifyStep.run).not.toContain("--candidate-root .");
    expect(verifyStep.run?.indexOf("gh attestation verify")).toBeLessThan(
      verifyStep.run?.indexOf("verify-authorized-beta-focused-candidate.mjs") ?? -1,
    );

    for (const jobName of ["build-amd64", "build-arm64"]) {
      expect(docker.jobs?.[jobName]?.needs).toContain("resolve_build_provenance");
    }
  });

  it("pins the exact beta.3 candidate, inventories, trust split, and repaired leaves", () => {
    const policy = readAuthorizedBetaFocusedPolicy();
    expect(policy.releaseTag).toBe("v2026.8.1-beta.3");
    expect(policy.candidateSha).toBe("3fbe94065c2b94f4c08acb6742a69938bf408d94");
    expect(policy.baseCandidateSha).toBe("3203a6f7f8d79644fde2b4f091a694f4c1698538");
    expect(policy.eligibilityPlanDigest).toBe(
      "sha256:e05226cfd77716b262882b3e2525037a506cd8b6af2affa0a876499074b1671b",
    );
    expect(policy.changedPaths).toHaveLength(4);
    expect(policy.inventory).toMatchObject({
      npmCount: 93,
      clawHubCount: 89,
      trustedPublisherCount: 75,
      bootstrapCount: 14,
      missingTrustedPublisherCount: 0,
    });
    expect(policy.historicalFrv).toMatchObject({
      runId: "32644377679",
      ciFailedJobId: "97206458686",
      pluginFailedJobId: "97208293666",
      releaseChecksRunId: "32645133620",
    });
    expect(policy.focusedProof).toMatchObject({
      ciRunId: "32664685168",
      ciSuccessJobId: "97256296219",
      pluginRunId: "32664686635",
      pluginSuccessJobId: "97256329353",
    });
  });

  it("accepts skipped historical release-plan children without run identities", () => {
    const { policy, root } = fixturePolicy();
    const trustedRoot = tempDirs.make("authorized-beta-focused-historical-plan-");
    const validatorPath = stageValidatorClosure(trustedRoot, false);
    writeFileSync(join(trustedRoot, "authorized-beta-focused-policy.json"), JSON.stringify(policy));

    const producerSha = "a".repeat(40);
    const producerRef = "release-publish/aaaaaaaaaaaa-1";
    const historical = policy.historicalFrv;
    const plan = {
      parentRunId: historical.runId,
      parentRunAttempt: historical.runAttempt,
      workflowRef: historical.workflowRef,
      workflowSha: policy.historicalToolingSha,
      targetSha: historical.targetSha,
      releaseProfile: "beta",
      rerunGroup: "all",
      children: [
        { key: "normalCi", selected: true, runId: historical.ciRunId },
        { key: "pluginPrerelease", selected: true, runId: historical.pluginRunId },
        { key: "releaseChecks", selected: true, runId: historical.releaseChecksRunId },
        { key: "npmTelegram", selected: false, runId: "" },
        { key: "productPerformance", selected: true, runId: historical.performanceRunId },
      ],
    };
    const producerRun = {
      id: 123,
      run_attempt: 1,
      name: "Authorized Beta Focused Validation",
      path: ".github/workflows/authorized-beta-focused-validation.yml",
      event: "workflow_dispatch",
      status: "completed",
      conclusion: "success",
      head_branch: producerRef,
      head_sha: producerSha,
    };
    writeFileSync(
      join(trustedRoot, "gh"),
      [
        "#!/usr/bin/env node",
        'import { writeFileSync } from "node:fs";',
        'import { join } from "node:path";',
        "const [command, route, ...args] = process.argv.slice(2);",
        'if (command === "api" && route.endsWith("/actions/runs/123")) {',
        `  process.stdout.write(JSON.stringify(${JSON.stringify(producerRun)}));`,
        '} else if (command === "api" && route.includes("/git/ref/tags/")) {',
        `  process.stdout.write(JSON.stringify({ object: { type: "commit", sha: ${JSON.stringify(producerSha)} } }));`,
        '} else if (command === "run" && route === "download") {',
        '  const directory = args[args.indexOf("--dir") + 1];',
        `  writeFileSync(join(directory, "full-release-execution-plan.json"), JSON.stringify(${JSON.stringify(plan)}));`,
        "} else {",
        '  console.error("historical execution plan child identities accepted");',
        "  process.exitCode = 1;",
        "}",
      ].join("\n"),
      { mode: 0o755 },
    );

    const result = spawnSync(
      process.execPath,
      [
        validatorPath,
        "verify",
        "--candidate-root",
        root,
        "--artifact",
        join(trustedRoot, "unused-evidence.json"),
        "--producer-run-id",
        "123",
        "--producer-run-attempt",
        "1",
        "--producer-workflow-full-ref",
        `refs/tags/${producerRef}`,
        "--producer-workflow-sha",
        producerSha,
      ],
      {
        encoding: "utf8",
        env: { ...process.env, PATH: `${trustedRoot}:${process.env.PATH ?? ""}` },
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("historical execution plan child identities accepted");
    expect(result.stderr).not.toContain("historical execution plan child run id");
  });

  it.each([
    { outcome: "flagged" as const, description: "accepts ANSI-bearing flagged Actions logs" },
    { outcome: "legacy" as const, description: "retries once for the exact legacy gh flag error" },
    {
      outcome: "unrelated" as const,
      description: "propagates unrelated gh errors without retrying",
    },
  ])("$description", ({ outcome }) => {
    const { calls, policy, result } = runFocusedValidatorLogProbe(outcome);
    const ciLogArgs = [
      "api",
      `repos/openclaw/openclaw/actions/jobs/${policy.focusedProof.ciTargetLogJobId}/logs`,
    ];
    const pluginLogArgs = [
      "api",
      `repos/openclaw/openclaw/actions/jobs/${policy.focusedProof.pluginTargetLogJobId}/logs`,
    ];
    const flaggedCiLogArgs = [...ciLogArgs, "--allow-escape-sequences"];
    const flaggedPluginLogArgs = [...pluginLogArgs, "--allow-escape-sequences"];

    if (outcome === "unrelated") {
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("error: unknown flag: --allow-escape-sequences");
      expect(calls).toEqual([flaggedCiLogArgs]);
      return;
    }

    expect(result.stderr).toBe(
      outcome === "legacy"
        ? "unknown flag: --allow-escape-sequences\r\n\r\nUsage: gh api <endpoint> [flags]\r\n"
        : "",
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(
      `authorized beta focused evidence verified for ${policy.releaseTag} at ${policy.candidateSha}\n`,
    );
    expect(calls).toEqual(
      outcome === "legacy"
        ? [flaggedCiLogArgs, ciLogArgs, flaggedPluginLogArgs]
        : [flaggedCiLogArgs, flaggedPluginLogArgs],
    );
  });

  it("binds the direct-child tree, exact diff, and unchanged published projection", () => {
    const { policy, root } = fixturePolicy();
    const changedPath = policy.changedPaths[0];
    if (!changedPath) {
      throw new Error("fixture policy must include one changed path");
    }
    expect(() => assertAuthorizedBetaFocusedCandidate(policy, root)).not.toThrow();
    expect(() =>
      assertAuthorizedBetaFocusedCandidate(
        {
          ...policy,
          changedPaths: [{ ...changedPath, added: 2 }],
        },
        root,
      ),
    ).toThrow("candidate diff does not match authorized path");
  });

  it("verifies the policy candidate when the release checkout has diverged", () => {
    const { policy, root } = fixturePolicy();
    git(root, ["checkout", "--quiet", "--detach", policy.baseCandidateSha]);
    writeFileSync(join(root, "published.txt"), "divergent release\n");
    const releaseSha = commit(root, "divergent release");
    const ancestry = spawnSync(
      "git",
      ["merge-base", "--is-ancestor", policy.candidateSha, releaseSha],
      { cwd: root },
    );
    expect(ancestry.status).toBe(1);

    const staged = stageCandidateVerifier(policy);
    const checkoutHookMarker = join(root, "checkout-hook-ran");
    writeFileSync(
      join(root, ".git", "hooks", "post-checkout"),
      `#!/bin/sh\n: > ${JSON.stringify(checkoutHookMarker)}\n`,
      { mode: 0o755 },
    );
    const producerSha = "a".repeat(40);
    const verifierArgs = [
      "--artifact",
      join(root, "evidence.json"),
      "--producer-run-id",
      "123",
      "--producer-run-attempt",
      "1",
      "--producer-workflow-full-ref",
      "refs/tags/release-publish/aaaaaaaaaaaa-1",
      "--producer-workflow-sha",
      producerSha,
    ];
    const direct = spawnSync(
      process.execPath,
      [staged.validatorPath, "verify", "--candidate-root", root, ...verifierArgs],
      { encoding: "utf8" },
    );
    expect(direct.status).toBe(1);
    expect(direct.stderr).toContain(
      `candidate checkout must be ${policy.candidateSha}, got ${releaseSha}`,
    );

    const originalWorktrees = git(root, ["worktree", "list", "--porcelain"]);
    const stagedResult = runCandidateVerifier({
      helperPath: staged.helperPath,
      policyPath: staged.policyPath,
      repositoryRoot: root,
      validatorPath: staged.fixtureValidatorPath,
      verifierArgs,
    });
    expect(stagedResult.status).toBe(0);
    const invocation = JSON.parse(readFileSync(staged.markerPath, "utf8")) as {
      args: string[];
      candidateRoot: string;
      entries: string[];
    };
    expect(invocation.args).toEqual([
      "verify",
      "--candidate-root",
      invocation.candidateRoot,
      ...verifierArgs,
    ]);
    expect(invocation.entries).toEqual([".git"]);
    expect(existsSync(checkoutHookMarker)).toBe(false);
    expect(existsSync(invocation.candidateRoot)).toBe(false);
    expect(git(root, ["worktree", "list", "--porcelain"])).toBe(originalWorktrees);
    expect(git(root, ["rev-parse", "HEAD"])).toBe(releaseSha);
  });

  it.each([
    { name: "null policy", policy: null },
    { name: "array policy", policy: [] },
    {
      name: "wrong policy schema",
      policy: { schema: "other", mode: "authorized-beta-focused-v1", candidateSha: "a".repeat(40) },
    },
    {
      name: "wrong policy mode",
      policy: {
        schema: "openclaw.authorized-beta-focused-policy.v1",
        mode: "other",
        candidateSha: "a".repeat(40),
      },
    },
    {
      name: "missing candidate",
      policy: {
        schema: "openclaw.authorized-beta-focused-policy.v1",
        mode: "authorized-beta-focused-v1",
      },
    },
    {
      name: "short candidate",
      policy: {
        schema: "openclaw.authorized-beta-focused-policy.v1",
        mode: "authorized-beta-focused-v1",
        candidateSha: "abc",
      },
    },
    {
      name: "uppercase candidate",
      policy: {
        schema: "openclaw.authorized-beta-focused-policy.v1",
        mode: "authorized-beta-focused-v1",
        candidateSha: "A".repeat(40),
      },
    },
  ])("rejects $name before touching the repository or verifier", ({ policy }) => {
    const trustedRoot = tempDirs.make("authorized-beta-focused-invalid-");
    const policyPath = join(trustedRoot, "authorized-beta-focused-policy.json");
    writeFileSync(policyPath, JSON.stringify(policy));
    const result = runCandidateVerifier({
      policyPath,
      repositoryRoot: join(trustedRoot, "missing-repository"),
      validatorPath: join(trustedRoot, "missing-verifier.mjs"),
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("invalid trusted focused evidence policy");
    expect(result.stderr).not.toContain("missing-repository");
  });

  it("rejects a policy that is not adjacent to the trusted verifier", () => {
    const { policy, root } = fixturePolicy();
    const staged = stageCandidateVerifier(policy);
    const otherRoot = tempDirs.make("authorized-beta-focused-other-policy-");
    const policyPath = join(otherRoot, "authorized-beta-focused-policy.json");
    writeFileSync(policyPath, JSON.stringify(policy));
    const result = runCandidateVerifier({
      policyPath,
      repositoryRoot: root,
      validatorPath: staged.fixtureValidatorPath,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("trusted validator's adjacent policy");
    expect(existsSync(staged.markerPath)).toBe(false);
  });

  it("rejects an unavailable policy candidate without invoking the verifier", () => {
    const { policy, root } = fixturePolicy();
    git(root, ["remote", "add", "origin", root]);
    const staged = stageCandidateVerifier({ ...policy, candidateSha: "f".repeat(40) });
    const originalWorktrees = git(root, ["worktree", "list", "--porcelain"]);
    const result = runCandidateVerifier({
      policyPath: staged.policyPath,
      repositoryRoot: root,
      validatorPath: staged.fixtureValidatorPath,
    });
    expect(result.status).toBe(1);
    expect(existsSync(staged.markerPath)).toBe(false);
    expect(git(root, ["worktree", "list", "--porcelain"])).toBe(originalWorktrees);
  });

  it("fetches only the exact policy candidate when the release clone does not contain it", () => {
    const { policy, root } = fixturePolicy();
    git(root, ["checkout", "--quiet", "--detach", policy.baseCandidateSha]);
    writeFileSync(join(root, "published.txt"), "divergent release\n");
    const releaseSha = commit(root, "divergent release");
    git(root, ["branch", "release-candidate", releaseSha]);
    const releaseRoot = tempDirs.make("authorized-beta-focused-release-clone-");
    execFileSync("git", [
      "clone",
      "--quiet",
      "--no-local",
      "--depth",
      "1",
      "--branch",
      "release-candidate",
      root,
      releaseRoot,
    ]);
    expect(
      spawnSync("git", ["cat-file", "-e", `${policy.candidateSha}^{commit}`], {
        cwd: releaseRoot,
      }).status,
    ).not.toBe(0);

    const staged = stageCandidateVerifier(policy);
    const originalWorktrees = git(releaseRoot, ["worktree", "list", "--porcelain"]);
    const result = runCandidateVerifier({
      policyPath: staged.policyPath,
      repositoryRoot: releaseRoot,
      validatorPath: staged.fixtureValidatorPath,
    });
    expect(result.status).toBe(0);
    expect(existsSync(staged.markerPath)).toBe(true);
    expect(git(releaseRoot, ["rev-parse", "HEAD"])).toBe(releaseSha);
    expect(git(releaseRoot, ["worktree", "list", "--porcelain"])).toBe(originalWorktrees);
  });

  it("rejects candidate-root overrides before staging a trusted candidate", () => {
    const { policy, root } = fixturePolicy();
    const staged = stageCandidateVerifier(policy);
    const originalWorktrees = git(root, ["worktree", "list", "--porcelain"]);
    const result = runCandidateVerifier({
      policyPath: staged.policyPath,
      repositoryRoot: root,
      validatorPath: staged.fixtureValidatorPath,
      verifierArgs: ["--candidate-root", root],
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("invalid focused evidence verifier option: --candidate-root");
    expect(existsSync(staged.markerPath)).toBe(false);
    expect(git(root, ["worktree", "list", "--porcelain"])).toBe(originalWorktrees);
  });

  it("removes and prunes the candidate worktree when trusted verification fails", () => {
    const { policy, root } = fixturePolicy();
    const staged = stageCandidateVerifier(policy, true);
    const originalWorktrees = git(root, ["worktree", "list", "--porcelain"]);
    const result = runCandidateVerifier({
      policyPath: staged.policyPath,
      repositoryRoot: root,
      validatorPath: staged.fixtureValidatorPath,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("trusted fixture verifier rejected evidence");
    const invocation = JSON.parse(readFileSync(staged.markerPath, "utf8")) as {
      candidateRoot: string;
    };
    expect(existsSync(invocation.candidateRoot)).toBe(false);
    expect(git(root, ["worktree", "list", "--porcelain"])).toBe(originalWorktrees);
  });

  it("hashes sorted unique package inventories and rejects duplicates", () => {
    expect(digestAuthorizedPackageNames(["b", "a"])).toBe(
      createHash("sha256").update("a\nb\n").digest("hex"),
    );
    expect(() => digestAuthorizedPackageNames(["a", "a"])).toThrow(
      "package inventory contains duplicate names",
    );
  });

  it("derives the eligibility digest from the canonical full release plan", async () => {
    const plan = JSON.parse(
      readFileSync("test/fixtures/release-plan-v1.source.json", "utf8"),
    ) as unknown;
    const lock = JSON.parse(
      readFileSync("test/fixtures/release-plan-lock-v1.compatibility.json", "utf8"),
    ) as { digest: string };
    await expect(assertAuthorizedEligibilityPlanDigest(plan, lock.digest)).resolves.toBe(
      lock.digest,
    );
    await expect(
      assertAuthorizedEligibilityPlanDigest(plan, `sha256:${"0".repeat(64)}`),
    ).rejects.toThrow("authorized eligibility plan digest mismatch");
  });

  it.each([
    { name: "downloaded verifier", scriptsDirectory: false },
    { name: "sparse scripts checkout", scriptsDirectory: true },
  ])("executes the $name module closure", ({ scriptsDirectory }) => {
    const root = tempDirs.make("authorized-beta-focused-stage-");
    const validatorPath = stageValidatorClosure(root, scriptsDirectory);
    const probePath = join(root, "probe.mjs");
    writeFileSync(
      probePath,
      [
        `import { digestAuthorizedBetaFocusedPolicy, readAuthorizedBetaFocusedPolicy, validateAuthorizedBetaFocusedArtifactShape } from ${JSON.stringify(pathToFileURL(validatorPath).href)};`,
        `const policy = readAuthorizedBetaFocusedPolicy();`,
        `const producer = { repository: "openclaw/openclaw", runId: "123", runAttempt: 1, workflowPath: ".github/workflows/authorized-beta-focused-validation.yml", workflowFullRef: "refs/tags/release-publish/aaaaaaaaaaaa-1", workflowRef: "release-publish/aaaaaaaaaaaa-1", workflowSha: "a".repeat(40) };`,
        `const inventory = { eligibilityPlanDigest: policy.eligibilityPlanDigest, ...policy.inventory };`,
        `const evidence = { schema: "openclaw.authorized-beta-focused-evidence.v1", mode: policy.mode, policySha256: digestAuthorizedBetaFocusedPolicy(policy), releaseTag: policy.releaseTag, candidate: { sha: policy.candidateSha, parentSha: policy.baseCandidateSha, treeSha: policy.candidateTreeSha, packageProjectionSha256: policy.packageProjectionSha256, changedPaths: policy.changedPaths }, producer, historical: { frvRunId: policy.historicalFrv.runId, frvRunAttempt: policy.historicalFrv.runAttempt, releaseChecksRunId: policy.historicalFrv.releaseChecksRunId, performanceRunId: policy.historicalFrv.performanceRunId }, focused: { ciRunId: policy.focusedProof.ciRunId, ciJobId: policy.focusedProof.ciSuccessJobId, pluginRunId: policy.focusedProof.pluginRunId, pluginJobId: policy.focusedProof.pluginSuccessJobId, reviewedHeadSha: policy.reviewedHeadSha }, inventory };`,
        `validateAuthorizedBetaFocusedArtifactShape(evidence, policy, producer, inventory);`,
        `process.stdout.write("verified");`,
      ].join("\n"),
    );
    const result = spawnSync(process.execPath, [probePath], {
      cwd: root,
      encoding: "utf8",
    });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("verified");
  });

  it("accepts the exact artifact shape and rejects inventory drift", () => {
    const policy = readAuthorizedBetaFocusedPolicy();
    const producer: AuthorizedBetaFocusedProducerIdentity = {
      repository: "openclaw/openclaw",
      runId: "123",
      runAttempt: 1,
      workflowPath: ".github/workflows/authorized-beta-focused-validation.yml",
      workflowFullRef: "refs/tags/release-publish/aaaaaaaaaaaa-1",
      workflowRef: "release-publish/aaaaaaaaaaaa-1",
      workflowSha: "a".repeat(40),
    };
    const expectedInventory = {
      eligibilityPlanDigest: policy.eligibilityPlanDigest,
      ...policy.inventory,
    };
    const evidence = {
      schema: "openclaw.authorized-beta-focused-evidence.v1",
      mode: "authorized-beta-focused-v1",
      policySha256: digestAuthorizedBetaFocusedPolicy(policy),
      releaseTag: policy.releaseTag,
      candidate: {
        sha: policy.candidateSha,
        parentSha: policy.baseCandidateSha,
        treeSha: policy.candidateTreeSha,
        packageProjectionSha256: policy.packageProjectionSha256,
        changedPaths: policy.changedPaths,
      },
      producer,
      historical: {
        frvRunId: policy.historicalFrv.runId,
        frvRunAttempt: policy.historicalFrv.runAttempt,
        releaseChecksRunId: policy.historicalFrv.releaseChecksRunId,
        performanceRunId: policy.historicalFrv.performanceRunId,
      },
      focused: {
        ciRunId: policy.focusedProof.ciRunId,
        ciJobId: policy.focusedProof.ciSuccessJobId,
        pluginRunId: policy.focusedProof.pluginRunId,
        pluginJobId: policy.focusedProof.pluginSuccessJobId,
        reviewedHeadSha: policy.reviewedHeadSha,
      },
      inventory: expectedInventory,
    } as AuthorizedBetaFocusedEvidence;
    expect(() =>
      validateAuthorizedBetaFocusedArtifactShape(evidence, policy, producer, expectedInventory),
    ).not.toThrow();
    expect(() =>
      validateAuthorizedBetaFocusedArtifactShape(
        {
          ...evidence,
          inventory: { ...evidence.inventory, npmCount: 92 },
        },
        policy,
        producer,
        expectedInventory,
      ),
    ).toThrow("focused evidence inventory");
  });

  it("wires a no-input attested producer and explicit parent/child evidence mode", () => {
    const producer = parse(
      readFileSync(".github/workflows/authorized-beta-focused-validation.yml", "utf8"),
    ) as ParsedWorkflow;
    expect(producer.on.workflow_dispatch).toBeNull();
    expect(producer.permissions).toMatchObject({
      actions: "read",
      attestations: "write",
      contents: "read",
      "id-token": "write",
    });
    const producerSource = readFileSync(
      ".github/workflows/authorized-beta-focused-validation.yml",
      "utf8",
    );
    expect(producerSource).toContain("3fbe94065c2b94f4c08acb6742a69938bf408d94");
    expect(producerSource).toContain("actions/attest@");

    const workflows = new Map<string, ParsedWorkflow>();
    for (const path of [
      ".github/workflows/openclaw-release-publish.yml",
      ".github/workflows/openclaw-npm-release.yml",
    ]) {
      const workflow = parse(readFileSync(path, "utf8")) as ParsedWorkflow;
      workflows.set(path, workflow);
      const inputs = workflow.on.workflow_dispatch?.inputs;
      expect(inputs).toBeDefined();
      if (!inputs) {
        throw new Error(`workflow inputs missing: ${path}`);
      }
      const evidenceMode = inputs.release_evidence_mode;
      if (!evidenceMode) {
        throw new Error(`release evidence mode input missing: ${path}`);
      }
      expect(evidenceMode.options).toEqual([
        "full-release-validation",
        "authorized-beta-focused-v1",
      ]);
      expect(inputs.focused_release_evidence_run_id).toBeDefined();
      expect(inputs.focused_release_evidence_run_attempt).toBeDefined();
      const source = readFileSync(path, "utf8");
      expect(source).toContain("Verify focused release evidence");
      expect(source).toContain("gh attestation verify");
      const signerSha = path.endsWith("openclaw-release-publish.yml")
        ? "PRODUCER_WORKFLOW_SHA"
        : "WORKFLOW_SHA";
      expect(source).toContain(`--signer-digest "\${${signerSha}}"`);
      expect(source).toContain(`--source-digest "\${${signerSha}}"`);
      expect(source).toContain("validate-authorized-beta-focused-evidence.mts");
      expect(source).toContain("inputs.release_evidence_mode == 'full-release-validation'");
      expect(source).toContain("validate-full-release-validation-evidence.mjs");
    }
    const parentSource = readFileSync(".github/workflows/openclaw-release-publish.yml", "utf8");
    expect(parentSource).toContain('proof_label="authorized beta focused validation"');
    expect(parentSource).toContain('proof_run_id="${FOCUSED_RELEASE_EVIDENCE_RUN_ID}"');
    expect(parentSource).toContain(
      "${process.env.RELEASE_VALIDATION_LABEL}: https://github.com/${process.env.RELEASE_REPO}/actions/runs/${process.env.RELEASE_VALIDATION_RUN_ID}",
    );
    const parentWorkflow = workflows.get(".github/workflows/openclaw-release-publish.yml");
    const npmWorkflow = workflows.get(".github/workflows/openclaw-npm-release.yml");
    if (!parentWorkflow || !npmWorkflow) {
      throw new Error("release workflows missing");
    }
    const downloadedTooling = namedStep(
      parentWorkflow,
      "resolve_release_target",
      "Download trusted release validation tooling",
    ).run;
    for (const path of VALIDATOR_CLOSURE) {
      expect(downloadedTooling).toContain(path);
    }
    const resolveSteps = parentWorkflow.jobs?.resolve_release_target?.steps ?? [];
    const resolveStepNames = resolveSteps.map((step) => step.name);
    expect(resolveStepNames).not.toContain("Install focused release verifier dependency");
    expect(parentWorkflow.jobs?.resolve_release_target?.outputs).toMatchObject({
      focused_release_evidence_workflow_full_ref:
        "${{ steps.focused_run.outputs.workflow_full_ref }}",
      focused_release_evidence_workflow_sha: "${{ steps.focused_run.outputs.workflow_sha }}",
    });
    for (const [jobName, stepName] of [
      ["resolve_release_target", "Verify focused release evidence"],
      ["publish", "Verify focused release evidence after approval"],
    ] as const) {
      const verifyStep = namedStep(parentWorkflow, jobName, stepName);
      const outputPrefix =
        jobName === "publish"
          ? "needs.resolve_release_target.outputs.focused_release_evidence_"
          : "steps.focused_run.outputs.";
      expect(verifyStep.env).toMatchObject({
        PRODUCER_WORKFLOW_FULL_REF: `\${{ ${outputPrefix}workflow_full_ref }}`,
        PRODUCER_WORKFLOW_SHA: `\${{ ${outputPrefix}workflow_sha }}`,
      });
      expect(verifyStep.run).toContain('--source-ref "${PRODUCER_WORKFLOW_FULL_REF}"');
      expect(verifyStep.run).toContain(
        '--producer-workflow-full-ref "${PRODUCER_WORKFLOW_FULL_REF}"',
      );
      expect(verifyStep.run).toContain('--producer-workflow-sha "${PRODUCER_WORKFLOW_SHA}"');
      expect(verifyStep.run).toContain("verify-authorized-beta-focused-candidate.mjs");
      expect(verifyStep.run).toContain("--repository-root .");
      expect(verifyStep.run).not.toContain("--candidate-root .");
      expect(verifyStep.run?.indexOf("gh attestation verify")).toBeLessThan(
        verifyStep.run?.indexOf("verify-authorized-beta-focused-candidate.mjs") ?? -1,
      );
    }
    const publishSteps = parentWorkflow.jobs?.publish?.steps ?? [];
    const publishStepNames = publishSteps.map((step) => step.name);
    expect(publishStepNames.indexOf("Verify focused release evidence after approval")).toBeLessThan(
      publishStepNames.indexOf("Setup Node environment"),
    );
    const npmSteps = npmWorkflow.jobs?.publish_openclaw_npm?.steps ?? [];
    const npmStepNames = npmSteps.map((step) => step.name);
    expect(npmStepNames.indexOf("Setup Node environment")).toBeLessThan(
      npmStepNames.indexOf("Verify focused release evidence"),
    );
    expect(
      namedStep(npmWorkflow, "publish_openclaw_npm", "Checkout trusted validation verifier").with,
    ).toMatchObject({ "sparse-checkout": "scripts" });
    const validatorSource = readFileSync(
      "scripts/validate-authorized-beta-focused-evidence.mts",
      "utf8",
    );
    expect(validatorSource).toContain('"--intent",');
    expect(validatorSource).toContain('"--tooling-sha",');
    expect(validatorSource).toContain("policy.historicalToolingSha");
    expect(validatorSource).toContain("policy.historicalToolingRef");
    expect(validatorSource).toContain("assertAuthorizedEligibilityPlanDigest(");
    expect(validatorSource).toContain('await import("./release-plan-contract.mjs")');
    const trustBranch = validatorSource.indexOf("if (includeTrust)");
    const pluginImport = validatorSource.indexOf('await import("./lib/plugin-clawhub-release.ts")');
    expect(trustBranch).toBeGreaterThan(-1);
    expect(pluginImport).toBeGreaterThan(trustBranch);
    const verifyBranch = validatorSource.indexOf(
      'const evidence = JSON.parse(readFileSync(artifactPath, "utf8"))',
    );
    expect(verifyBranch).toBeGreaterThan(-1);
    expect(validatorSource.slice(verifyBranch)).not.toContain("collectInventory(");
  });
});
