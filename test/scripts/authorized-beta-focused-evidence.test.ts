import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
      steps?: Array<{
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

describe("authorized beta focused evidence", () => {
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
      expect(source).toContain('--signer-digest "${WORKFLOW_SHA}"');
      expect(source).toContain('--source-digest "${WORKFLOW_SHA}"');
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
