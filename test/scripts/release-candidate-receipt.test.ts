import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import {
  canonicalCandidateReceiptJson,
  canonicalCandidateReceiptLockJson,
  CANDIDATE_RECEIPT_CANONICALIZATION,
  createCandidateReceiptLock,
  parseCandidateReceiptLockJson,
  validateCandidateReceipt,
} from "../../scripts/release-candidate-receipt-contract.mjs";
import {
  locateCandidateReceipt,
  runCandidateReceiptGh,
  validateCandidateReceiptProvenance,
} from "../../scripts/release-candidate-receipt-locator.mts";

const fixtureDir = resolve("test/fixtures");
const sourceText = readFileSync(resolve(fixtureDir, "candidate-receipt-v1.source.json"), "utf8");
const lockText = readFileSync(
  resolve(fixtureDir, "candidate-receipt-lock-v1.compatibility.json"),
  "utf8",
);
const sourceFixture = JSON.parse(sourceText) as Record<string, unknown>;
const lockFixture = parseCandidateReceiptLockJson(lockText);
const runId = lockFixture.receipt.producer.run_id;
const runAttempt = lockFixture.receipt.producer.run_attempt;
const workflowId = lockFixture.receipt.producer.workflow_id;
const workflowSha = lockFixture.receipt.producer.workflow_sha;
const dispatchId = "candidate-2026.8.1-beta.3";
const runTitle = `Release Candidate Artifacts ${dispatchId}`;

function runFixture(overrides: Record<string, unknown> = {}) {
  return {
    conclusion: "success",
    display_title: runTitle,
    event: "workflow_dispatch",
    head_sha: workflowSha,
    id: Number(runId),
    path: ".github/workflows/release-candidate-artifacts.yml",
    run_attempt: Number(runAttempt),
    status: "completed",
    workflow_id: Number(workflowId),
    ...overrides,
  };
}

function workflowFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: Number(workflowId),
    path: ".github/workflows/release-candidate-artifacts.yml",
    ...overrides,
  };
}

function artifactFixture(
  artifact: (typeof lockFixture.receipt.artifacts)[keyof typeof lockFixture.receipt.artifacts],
) {
  return {
    digest: artifact.artifact_digest,
    expired: false,
    id: Number(artifact.artifact_id),
    name: artifact.artifact_name,
    workflow_run: { id: Number(runId) },
  };
}

function artifactsFixture() {
  return {
    artifacts: Object.values(lockFixture.receipt.artifacts).map(artifactFixture),
    total_count: 4,
  };
}

describe("candidate receipt contract", () => {
  it("pins canonical source and lock bytes as the cross-workflow golden fixture", () => {
    expect(CANDIDATE_RECEIPT_CANONICALIZATION).toBe(
      "ascii-sorted-compact-json-trailing-newline-v1",
    );
    expect(sourceText).toBe(canonicalCandidateReceiptJson(sourceFixture));
    expect(lockText).toBe(canonicalCandidateReceiptLockJson(lockFixture));
    expect(createCandidateReceiptLock(sourceFixture)).toEqual(lockFixture);
    expect(lockText.endsWith("\n")).toBe(true);
  });

  it("rejects duplicate, reordered, pretty, CRLF, and non-ASCII lock bytes", () => {
    const duplicate = lockText.replace('{"digest":', `{"digest":"${lockFixture.digest}","digest":`);
    expect(() => parseCandidateReceiptLockJson(duplicate)).toThrow("duplicate key");
    expect(() =>
      parseCandidateReceiptLockJson(
        `${JSON.stringify({
          schema: lockFixture.schema,
          receipt: lockFixture.receipt,
          digest: lockFixture.digest,
        })}\n`,
      ),
    ).toThrow("canonical bytes");
    expect(() =>
      parseCandidateReceiptLockJson(`${JSON.stringify(lockFixture, null, 2)}\n`),
    ).toThrow("compact printable ASCII");
    expect(() => parseCandidateReceiptLockJson(lockText.replace(/\n$/u, "\r\n"))).toThrow(
      "exactly one trailing LF",
    );
    expect(() =>
      parseCandidateReceiptLockJson(lockText.replace("openclaw/openclaw", "opénclaw")),
    ).toThrow("printable ASCII");
  });

  it("rejects digest drift, duplicate artifact IDs, and names from another attempt", () => {
    expect(() =>
      parseCandidateReceiptLockJson(
        lockText.replace(lockFixture.digest, `sha256:${"9".repeat(64)}`),
      ),
    ).toThrow("does not match");
    expect(() =>
      validateCandidateReceipt({
        ...sourceFixture,
        artifacts: {
          ...(sourceFixture.artifacts as Record<string, unknown>),
          root_image: {
            ...(sourceFixture.artifacts as Record<string, Record<string, unknown>>).root_image,
            artifact_id: "103",
          },
        },
      }),
    ).toThrow("artifact IDs must be unique");
    expect(() =>
      validateCandidateReceipt({
        ...sourceFixture,
        artifacts: {
          ...(sourceFixture.artifacts as Record<string, unknown>),
          package: {
            ...(sourceFixture.artifacts as Record<string, Record<string, unknown>>).package,
            artifact_name: "docker-e2e-package-12345-1",
          },
        },
      }),
    ).toThrow("name must bind the producer run attempt");
    expect(() =>
      validateCandidateReceipt({
        ...sourceFixture,
        artifacts: {
          ...(sourceFixture.artifacts as Record<string, unknown>),
          package: {
            ...(sourceFixture.artifacts as Record<string, Record<string, unknown>>).package,
            artifact_name: "release-candidate-root-image-12345-2",
          },
        },
      }),
    ).toThrow("name does not match its artifact kind");
  });

  it("references ReleasePlan only by digest", () => {
    const receipt = validateCandidateReceipt(sourceFixture);
    expect(receipt).not.toHaveProperty("candidate_sha");
    expect(receipt).not.toHaveProperty("version");
    expect(receipt).not.toHaveProperty("validation");
    expect(receipt.artifacts).toHaveProperty("e2e_plugin_registry");
    expect(receipt.artifacts).not.toHaveProperty("plugin_registry");
    expect(() =>
      validateCandidateReceipt({ ...sourceFixture, candidate_sha: "a".repeat(40) }),
    ).toThrow("candidate receipt keys must be exactly");
    expect(() =>
      validateCandidateReceipt({
        ...sourceFixture,
        artifacts: {
          ...(sourceFixture.artifacts as Record<string, unknown>),
          plugin_registry: (sourceFixture.artifacts as Record<string, unknown>).e2e_plugin_registry,
        },
      }),
    ).toThrow("candidate receipt artifacts keys must be exactly");
  });
});

describe("candidate receipt locator", () => {
  it("validates the exact workflow, run attempt, ReleasePlan, and artifact service digests", () => {
    expect(
      validateCandidateReceiptProvenance({
        artifacts: artifactsFixture(),
        expectedDispatchId: dispatchId,
        expectedReleasePlanDigest: lockFixture.receipt.release_plan_digest,
        expectedRunAttempt: runAttempt,
        expectedRunId: runId,
        expectedWorkflowId: workflowId,
        expectedWorkflowSha: workflowSha,
        lock: lockFixture,
        run: runFixture(),
        workflow: workflowFixture(),
      }),
    ).toEqual(lockFixture);
  });

  it.each([
    ["workflow id", { run: runFixture({ workflow_id: 999 }) }],
    ["workflow path", { run: runFixture({ path: ".github/workflows/ci.yml" }) }],
    ["workflow SHA", { run: runFixture({ head_sha: "c".repeat(40) }) }],
    ["run attempt", { run: runFixture({ run_attempt: 1 }) }],
    ["dispatch title", { run: runFixture({ display_title: "other" }) }],
    ["event", { run: runFixture({ event: "push" }) }],
    ["conclusion", { run: runFixture({ conclusion: "failure" }) }],
  ])("rejects mismatched %s provenance", (_label, overrides) => {
    expect(() =>
      validateCandidateReceiptProvenance({
        artifacts: artifactsFixture(),
        expectedDispatchId: dispatchId,
        expectedReleasePlanDigest: lockFixture.receipt.release_plan_digest,
        expectedRunAttempt: runAttempt,
        expectedRunId: runId,
        expectedWorkflowId: workflowId,
        expectedWorkflowSha: workflowSha,
        lock: lockFixture,
        run: overrides.run,
        workflow: workflowFixture(),
      }),
    ).toThrow("exact successful producer attempt");
  });

  it("rejects missing, expired, moved, or digest-mismatched artifacts", () => {
    const artifacts = artifactsFixture();
    const firstArtifact = artifacts.artifacts[0]!;
    artifacts.artifacts[0] = { ...firstArtifact, digest: `sha256:${"8".repeat(64)}` };
    expect(() =>
      validateCandidateReceiptProvenance({
        artifacts,
        expectedDispatchId: dispatchId,
        expectedReleasePlanDigest: lockFixture.receipt.release_plan_digest,
        expectedRunAttempt: runAttempt,
        expectedRunId: runId,
        expectedWorkflowId: workflowId,
        expectedWorkflowSha: workflowSha,
        lock: lockFixture,
        run: runFixture(),
        workflow: workflowFixture(),
      }),
    ).toThrow("metadata does not match");
  });

  it("bounds each gh lookup", () => {
    const execFileSyncImpl = vi.fn(() => "result");
    expect(
      runCandidateReceiptGh(["api", "repos/openclaw/openclaw/actions/runs/12345"], {
        execFileSyncImpl,
      }),
    ).toBe("result");
    expect(execFileSyncImpl).toHaveBeenCalledWith(
      "gh",
      ["api", "repos/openclaw/openclaw/actions/runs/12345"],
      {
        encoding: "utf8",
        killSignal: "SIGKILL",
        maxBuffer: 32 * 1024 * 1024,
        timeout: 60_000,
      },
    );
  });

  it("bounds transient API failures", async () => {
    const runGh = vi.fn(() => {
      throw new Error("GitHub API unavailable");
    });
    await expect(
      locateCandidateReceipt({
        dispatchId,
        releasePlanDigest: lockFixture.receipt.release_plan_digest,
        repo: "openclaw/openclaw",
        runGh,
        sleep: async () => {},
        timeoutMs: 1000,
        workflowId,
        workflowSha,
      }),
    ).rejects.toThrow("failed after 3 attempts");
    expect(runGh).toHaveBeenCalledTimes(3);
  });

  it("retries APIs and artifact propagation before reading the exact receipt", async () => {
    const receiptArtifactName = `release-candidate-receipt-${runId}-${runAttempt}`;
    const artifactResponse = artifactsFixture();
    artifactResponse.artifacts.push({
      digest: `sha256:${"5".repeat(64)}`,
      expired: false,
      id: 105,
      name: receiptArtifactName,
      workflow_run: { id: Number(runId) },
    });
    artifactResponse.total_count = 5;
    const incompleteArtifactResponse = {
      artifacts: artifactResponse.artifacts.filter(
        (artifact) => artifact.id !== Number(lockFixture.receipt.artifacts.root_image.artifact_id),
      ),
      total_count: 4,
    };
    const responses = new Map<string, unknown>([
      [
        `api repos/openclaw/openclaw/actions/workflows/${workflowId} --method GET`,
        workflowFixture(),
      ],
      [
        `api repos/openclaw/openclaw/actions/workflows/${workflowId}/runs?event=workflow_dispatch&per_page=100 --method GET`,
        { workflow_runs: [runFixture()] },
      ],
      [
        `api repos/openclaw/openclaw/actions/runs/${runId}/attempts/${runAttempt} --method GET`,
        runFixture(),
      ],
      [
        `api repos/openclaw/openclaw/actions/runs/${runId}/artifacts?per_page=100 --method GET`,
        artifactResponse,
      ],
    ]);
    let workflowAttempts = 0;
    let artifactAttempts = 0;
    const runGh = vi.fn((args: string[]) => {
      if (args[0] === "run" && args[1] === "download") {
        const dir = args[args.indexOf("--dir") + 1];
        if (!dir) {
          throw new Error("missing download dir");
        }
        writeFileSync(resolve(dir, "candidate-receipt-lock.json"), lockText);
        return "";
      }
      if (
        args.join(" ") ===
          `api repos/openclaw/openclaw/actions/workflows/${workflowId} --method GET` &&
        workflowAttempts++ === 0
      ) {
        throw new Error("transient GitHub API failure");
      }
      if (
        args.join(" ") ===
        `api repos/openclaw/openclaw/actions/runs/${runId}/artifacts?per_page=100 --method GET`
      ) {
        artifactAttempts += 1;
        return JSON.stringify(
          artifactAttempts === 1
            ? { artifacts: artifactsFixture().artifacts, total_count: 4 }
            : artifactAttempts === 2
              ? incompleteArtifactResponse
              : artifactResponse,
        );
      }
      const response = responses.get(args.join(" "));
      if (!response) {
        throw new Error(`unexpected gh invocation: ${args.join(" ")}`);
      }
      return JSON.stringify(response);
    });
    const sleep = vi.fn(async () => {});

    await expect(
      locateCandidateReceipt({
        dispatchId,
        releasePlanDigest: lockFixture.receipt.release_plan_digest,
        repo: "openclaw/openclaw",
        runGh,
        sleep,
        timeoutMs: 1000,
        workflowId,
        workflowSha,
      }),
    ).resolves.toEqual(lockFixture);
    expect(workflowAttempts).toBe(2);
    expect(artifactAttempts).toBe(3);
    expect(sleep).toHaveBeenCalled();
    expect(runGh).toHaveBeenCalledWith([
      "run",
      "download",
      runId,
      "--repo",
      "openclaw/openclaw",
      "--name",
      receiptArtifactName,
      "--dir",
      expect.any(String),
    ]);
  });

  it("keeps an exact successful attempt valid without consulting later reruns", async () => {
    const receiptArtifactName = `release-candidate-receipt-${runId}-${runAttempt}`;
    const artifactResponse = artifactsFixture();
    artifactResponse.artifacts.push({
      digest: `sha256:${"5".repeat(64)}`,
      expired: false,
      id: 105,
      name: receiptArtifactName,
      workflow_run: { id: Number(runId) },
    });
    artifactResponse.total_count = 5;
    const runGh = vi.fn((args: string[]) => {
      const key = args.join(" ");
      if (args[0] === "run" && args[1] === "download") {
        const dir = args[args.indexOf("--dir") + 1];
        if (!dir) {
          throw new Error("missing download dir");
        }
        writeFileSync(resolve(dir, "candidate-receipt-lock.json"), lockText);
        return "";
      }
      if (key.includes(`actions/workflows/${workflowId} --method GET`)) {
        return JSON.stringify(workflowFixture());
      }
      if (key.includes(`actions/runs/${runId}/attempts/${runAttempt}`)) {
        return JSON.stringify(runFixture());
      }
      if (key.includes(`actions/runs/${runId}/artifacts?per_page=100`)) {
        return JSON.stringify(artifactResponse);
      }
      throw new Error(`unexpected gh invocation: ${key}`);
    });
    await expect(
      locateCandidateReceipt({
        dispatchId,
        releasePlanDigest: lockFixture.receipt.release_plan_digest,
        repo: "openclaw/openclaw",
        runAttempt,
        runGh,
        runId,
        sleep: async () => {},
        timeoutMs: 1000,
        workflowId,
        workflowSha,
      }),
    ).resolves.toEqual(lockFixture);
    expect(runGh).not.toHaveBeenCalledWith([
      "api",
      `repos/openclaw/openclaw/actions/runs/${runId}`,
      "--method",
      "GET",
    ]);
  });
});

type WorkflowStep = {
  env?: Record<string, string>;
  id?: string;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
};

type WorkflowJob = {
  "runs-on"?: string;
  needs?: string | string[];
  outputs?: Record<string, string>;
  permissions?: Record<string, string>;
  steps?: WorkflowStep[];
  uses?: string;
  with?: Record<string, unknown>;
};

type Workflow = {
  jobs: Record<string, WorkflowJob>;
  on?: {
    workflow_dispatch?: { inputs?: Record<string, Record<string, unknown>> };
    workflow_call?: unknown;
  };
  permissions?: Record<string, string>;
  "run-name"?: string;
};

function workflowJob(workflow: Workflow, name: string): WorkflowJob {
  const found = workflow.jobs[name];
  expect(found, name).toBeDefined();
  return found!;
}

function workflowStep(job: WorkflowJob, name: string): WorkflowStep {
  const found = job.steps?.find((step) => step.name === name);
  expect(found, name).toBeDefined();
  return found!;
}

describe("release candidate artifact producer workflow", () => {
  const path = ".github/workflows/release-candidate-artifacts.yml";
  const text = readFileSync(path, "utf8");
  const workflow = parse(text) as Workflow;

  it("is one read-only standalone producer keyed by a caller nonce", () => {
    expect(workflow["run-name"]).toBe("Release Candidate Artifacts ${{ inputs.dispatch_id }}");
    expect(workflow.on?.workflow_call).toBeUndefined();
    expect(workflow.on?.workflow_dispatch?.inputs).toMatchObject({
      dispatch_id: { required: true, type: "string" },
      release_plan_lock_base64: { required: true, type: "string" },
    });
    expect(workflow.permissions).toEqual({
      actions: "read",
      contents: "read",
      packages: "read",
      "pull-requests": "read",
    });
    expect(text).not.toContain("contents: write");
    expect(text).not.toContain("packages: write");
    expect(text).not.toContain("--push");
  });

  it("verifies repository-derived ReleasePlan authority before exposing candidate inputs", () => {
    const validate = workflowJob(workflow, "validate_release_plan");
    const step = workflowStep(validate, "Verify repository-derived ReleasePlan authority");
    expect(step.run).toContain("parseReleasePlanLockJson");
    expect(step.run).toContain("verifyReleasePlanLock");
    expect(step.run).toContain("dispatch_id must be one safe unique caller nonce");
    expect(step.run).toContain("repos/${process.env.GITHUB_REPOSITORY}/commits/${candidateSha}");
    expect(step.run).toContain('"fetch", "--force", "--no-tags", "origin", candidateSha');
    expect(step.run).toContain("toolingFullRef: workflowFullRef");
    expect(step.run).toContain("toolingSha: workflowSha");
    expect(step.run).toContain("candidate_sha=${lock.plan.candidate_sha}");
    expect(step.run).toContain("release_plan_digest=${lock.digest}");
    expect(step.run).toContain("release_profile=${lock.plan.validation.profile}");
  });

  it("runs the existing candidate producer and root-image producer in parallel", () => {
    const candidate = workflowJob(workflow, "candidate_artifacts");
    const root = workflowJob(workflow, "root_image");
    expect(candidate.needs).toBe("validate_release_plan");
    expect(root.needs).toBe("validate_release_plan");
    expect(candidate.uses).toBe("./.github/workflows/openclaw-live-and-e2e-checks-reusable.yml");
    expect(candidate.with).toMatchObject({
      prepare_only: true,
      include_repo_e2e: false,
      include_release_path_suites: false,
      include_openwebui: false,
      include_live_suites: false,
      enable_prepublish_plugin_registry: true,
      shared_image_artifact_namespace: "release-candidate",
      shared_image_policy: "no-push-artifact",
    });
    expect(root["runs-on"]).toBe("blacksmith-32vcpu-ubuntu-2404");
    const build = workflowStep(root, "Build root Dockerfile image");
    expect(build.env).toMatchObject({
      BUILD_TIMESTAMP: "2000-01-01T00:00:00.000Z",
      TARGET_SHA: "${{ needs.validate_release_plan.outputs.candidate_sha }}",
    });
    expect(build.run).toContain('--build-arg "GIT_COMMIT=$TARGET_SHA"');
    expect(build.run).toContain('--build-arg "OPENCLAW_BUILD_TIMESTAMP=$BUILD_TIMESTAMP"');
    const verify = workflowStep(root, "Verify root image build provenance");
    expect(verify.run).toContain("/app/dist/build-info.json");
    expect(verify.run).toContain('embedded_commit" != "$TARGET_SHA');
    const stepNames = root.steps?.map((step) => step.name) ?? [];
    expect(stepNames.indexOf("Verify root image build provenance")).toBeLessThan(
      stepNames.indexOf("Pack root Dockerfile image artifact"),
    );
    expect(workflowStep(root, "Pack root Dockerfile image artifact").run).toContain(
      "scripts/docker/shared-image-artifact.sh",
    );
    expect(workflowStep(root, "Upload root Dockerfile image artifact").with).toMatchObject({
      "compression-level": 0,
      "if-no-files-found": "error",
      "retention-days": 7,
    });
  });

  it("emits one receipt only after all four immutable artifacts exist", () => {
    const receipt = workflowJob(workflow, "candidate_receipt");
    expect(receipt.needs).toEqual(["validate_release_plan", "candidate_artifacts", "root_image"]);
    const provenance = workflowStep(receipt, "Verify exact producer workflow attempt");
    expect(provenance.run).toContain(
      "actions/runs/${GITHUB_RUN_ID}/attempts/${GITHUB_RUN_ATTEMPT}",
    );
    expect(provenance.run).toContain(".display_title == $title");
    expect(provenance.run).toContain("actions/workflows/${workflow_id}");
    expect(provenance.run).not.toContain('.state == "active"');
    const create = workflowStep(receipt, "Create canonical CandidateReceiptLock");
    expect(create.run).toContain("createCandidateReceiptLock");
    expect(create.run).toContain('docker_image: artifact("DOCKER_IMAGE"');
    expect(create.run).toContain("e2e_plugin_registry: artifact(");
    expect(create.run).toContain('package: artifact("PACKAGE"');
    expect(create.run).toContain('root_image: artifact("ROOT_IMAGE"');
    expect(workflowStep(receipt, "Upload CandidateReceiptLock").with).toMatchObject({
      name: "release-candidate-receipt-${{ github.run_id }}-${{ github.run_attempt }}",
      path: ".artifacts/candidate-receipt/candidate-receipt-lock.json",
      "if-no-files-found": "error",
      "retention-days": 7,
    });
  });
});
