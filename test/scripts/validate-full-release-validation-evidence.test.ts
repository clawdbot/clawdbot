// Full release validation evidence tests cover producer and candidate binding.
import { describe, expect, it, vi } from "vitest";
import {
  isShaPinnedReleaseValidationBranch,
  normalizeFullReleaseValidationRun,
  validateFullReleaseValidationEvidence,
} from "../../scripts/validate-full-release-validation-evidence.mjs";

const targetSha = "b".repeat(40);
const workflowSha = "a".repeat(40);
const pinnedBranch = `release-ci/${workflowSha.slice(0, 12)}-1783705000000`;

function releaseRun(overrides: Record<string, unknown> = {}) {
  return {
    id: 123,
    run_attempt: 2,
    name: "Full Release Validation",
    path: ".github/workflows/full-release-validation.yml",
    repository: { full_name: "openclaw/openclaw" },
    head_branch: pinnedBranch,
    head_sha: workflowSha,
    event: "workflow_dispatch",
    status: "completed",
    conclusion: "success",
    html_url: "https://github.com/openclaw/openclaw/actions/runs/123",
    ...overrides,
  };
}

function releaseManifest(overrides: Record<string, unknown> = {}) {
  return {
    version: 3,
    workflowName: "Full Release Validation",
    runId: "123",
    runAttempt: "2",
    workflowRef: pinnedBranch,
    workflowSha,
    workflowFullRef: `refs/heads/${pinnedBranch}`,
    workflowRefType: "branch",
    targetRef: targetSha,
    targetSha,
    ...overrides,
  };
}

function exactTargetEvidenceReuse() {
  return {
    changedPaths: [],
    evidenceSha: targetSha,
    policy: "exact-target-full-validation-v1",
    runId: "122",
    selectedRunId: "122",
  };
}

function strictEvidenceReuse() {
  return {
    schema: "openclaw.release-validation-evidence/v3",
    valid: true,
    current: { runId: "123", targetSha },
    root: { runId: "122", targetSha },
    evidenceReuse: {
      changedPaths: [],
      evidenceSha: targetSha,
      policy: "exact-target-full-validation-v1",
      rootRunId: "122",
      selectedRunId: "122",
    },
    conclusions: { allRequiredSucceeded: true },
  };
}

function validate(
  runOverrides: Record<string, unknown> = {},
  manifestOverrides: Record<string, unknown> = {},
  trusted = true,
) {
  const isTrustedMainAncestor = vi.fn(() => trusted);
  const result = validateFullReleaseValidationEvidence({
    run: releaseRun(runOverrides),
    manifest: releaseManifest(manifestOverrides),
    expectedRepository: "openclaw/openclaw",
    expectedRunId: "123",
    expectedTargetSha: targetSha,
    expectedWorkflowBranch: "release/2026.7.1",
    isTrustedMainAncestor,
    validateEvidenceReuseStrictly: () => strictEvidenceReuse(),
  });
  return { isTrustedMainAncestor, result };
}

describe("full release validation evidence", () => {
  it("normalizes REST and gh run metadata", () => {
    const normalized = normalizeFullReleaseValidationRun(releaseRun());

    expect(normalized).toMatchObject({
      databaseId: "123",
      runAttempt: 2,
      workflowName: "Full Release Validation",
      workflowPath: ".github/workflows/full-release-validation.yml",
      repository: "openclaw/openclaw",
      headBranch: pinnedBranch,
      headSha: workflowSha,
    });
    expect(
      normalizeFullReleaseValidationRun({
        databaseId: 123,
        attempt: 2,
        workflowName: "Full Release Validation",
        workflowPath: ".github/workflows/full-release-validation.yml@refs/heads/main",
      }),
    ).toMatchObject({
      databaseId: "123",
      runAttempt: 2,
      workflowPath: ".github/workflows/full-release-validation.yml",
      workflowQualifiedRef: "refs/heads/main",
    });
  });

  it("accepts canonical SHA-pinned evidence bound to current main", () => {
    const { isTrustedMainAncestor, result } = validate();

    expect(result.source).toBe("sha-pinned-main");
    expect(isTrustedMainAncestor).toHaveBeenCalledWith(workflowSha);
    expect(isShaPinnedReleaseValidationBranch(pinnedBranch)).toBe(true);
  });

  it.each([pinnedBranch, `refs/heads/${pinnedBranch}`])(
    "accepts a REST workflow path qualified with %s",
    (qualifiedRef) => {
      const { result } = validate({
        path: `.github/workflows/full-release-validation.yml@${qualifiedRef}`,
      });

      expect(result.source).toBe("sha-pinned-main");
    },
  );

  it.each(["main", "release/2026.7.1"])("keeps direct %s evidence valid", (branch) => {
    const { isTrustedMainAncestor, result } = validate(
      { head_branch: branch },
      {
        workflowRef: branch,
        workflowFullRef: `refs/heads/${branch}`,
        targetRef: "v2026.7.1-beta.3",
      },
    );

    expect(result.source).toBe("direct");
    if (branch === "main") {
      expect(isTrustedMainAncestor).toHaveBeenCalledWith(workflowSha);
    } else {
      expect(isTrustedMainAncestor).not.toHaveBeenCalled();
    }
  });

  it("rejects direct main evidence outside current main", () => {
    expect(() =>
      validate(
        { head_branch: "main" },
        {
          workflowRef: "main",
          workflowFullRef: "refs/heads/main",
          targetRef: "v2026.7.1-beta.3",
        },
        false,
      ),
    ).toThrow("not reachable from current main");
  });

  it.each([
    ["repository", { repository: { full_name: "attacker/openclaw" } }, {}, "repository"],
    ["workflow path", { path: ".github/workflows/other.yml" }, {}, "workflowPath"],
    [
      "qualified workflow ref",
      { path: ".github/workflows/full-release-validation.yml@refs/heads/other" },
      {},
      "workflow path ref",
    ],
    ["run id", { id: 124 }, {}, "databaseId"],
    ["manifest run id", {}, { runId: "124" }, "runId"],
    ["run attempt", {}, { runAttempt: "1" }, "runAttempt"],
    ["workflow ref", {}, { workflowRef: "main" }, "workflowRef"],
    ["workflow SHA", {}, { workflowSha: "c".repeat(40) }, "workflowSha"],
    ["workflow full ref", {}, { workflowFullRef: "refs/heads/main" }, "workflowFullRef"],
    ["target SHA", {}, { targetSha: "c".repeat(40) }, "targetSha"],
    ["target ref", {}, { targetRef: "v2026.7.1-beta.3" }, "target ref"],
    ["manifest version", {}, { version: 2 }, "version 3"],
  ])("rejects mismatched %s", (_name, runOverrides, manifestOverrides, message) => {
    expect(() => validate(runOverrides, manifestOverrides)).toThrow(message);
  });

  it("rejects a forged SHA-pinned branch prefix", () => {
    const branch = `release-ci/${"c".repeat(12)}-1783705000000`;
    expect(() =>
      validate(
        { head_branch: branch },
        { workflowRef: branch, workflowFullRef: `refs/heads/${branch}` },
      ),
    ).toThrow("does not match workflow SHA");
  });

  it("rejects SHA-pinned workflow commits outside current main", () => {
    expect(() => validate({}, {}, false)).toThrow("not reachable from current main");
  });

  it("accepts exact-target evidence reuse on the SHA-pinned path", () => {
    expect(validate({}, { evidenceReuse: exactTargetEvidenceReuse() }).result.source).toBe(
      "sha-pinned-main",
    );
  });

  it("accepts changelog-only release evidence reuse on the SHA-pinned path", () => {
    const codeSha = "c".repeat(40);
    const reuse = {
      changedPaths: ["CHANGELOG.md"],
      evidenceSha: codeSha,
      policy: "changelog-only-release-v1",
      runId: "122",
      selectedRunId: "122",
    };
    const result = validateFullReleaseValidationEvidence({
      run: releaseRun(),
      manifest: releaseManifest({ evidenceReuse: reuse }),
      expectedRepository: "openclaw/openclaw",
      expectedRunId: "123",
      expectedTargetSha: targetSha,
      expectedWorkflowBranch: "release/2026.7.1",
      isTrustedMainAncestor: () => true,
      validateEvidenceReuseStrictly: () => ({
        ...strictEvidenceReuse(),
        current: { runId: "123", targetSha },
        root: { runId: "122", targetSha: codeSha },
        evidenceReuse: {
          changedPaths: ["CHANGELOG.md"],
          evidenceSha: codeSha,
          policy: "changelog-only-release-v1",
          rootRunId: "122",
          selectedRunId: "122",
        },
      }),
    });

    expect(result.source).toBe("sha-pinned-main");
  });

  it("requires strict root and child validation for reused evidence", () => {
    expect(() =>
      validateFullReleaseValidationEvidence({
        run: releaseRun(),
        manifest: releaseManifest({ evidenceReuse: exactTargetEvidenceReuse() }),
        expectedRepository: "openclaw/openclaw",
        expectedRunId: "123",
        expectedTargetSha: targetSha,
        expectedWorkflowBranch: "release/2026.7.1",
        isTrustedMainAncestor: () => true,
      }),
    ).toThrow("requires strict chain validation");

    expect(() =>
      validateFullReleaseValidationEvidence({
        run: releaseRun(),
        manifest: releaseManifest({ evidenceReuse: exactTargetEvidenceReuse() }),
        expectedRepository: "openclaw/openclaw",
        expectedRunId: "123",
        expectedTargetSha: targetSha,
        expectedWorkflowBranch: "release/2026.7.1",
        isTrustedMainAncestor: () => true,
        validateEvidenceReuseStrictly: () => ({
          ...strictEvidenceReuse(),
          conclusions: { allRequiredSucceeded: false },
        }),
      }),
    ).toThrow("failed strict chain validation");
  });

  it("rejects malformed evidence reuse on the SHA-pinned path", () => {
    expect(() =>
      validate(
        {},
        { evidenceReuse: { ...exactTargetEvidenceReuse(), changedPaths: ["src/a.ts"] } },
      ),
    ).toThrow("evidence reuse is invalid");
    expect(() =>
      validate(
        {},
        { evidenceReuse: { ...exactTargetEvidenceReuse(), evidenceSha: "c".repeat(40) } },
      ),
    ).toThrow("evidence reuse is invalid");
    expect(() =>
      validate(
        {},
        {
          evidenceReuse: {
            ...exactTargetEvidenceReuse(),
            changedPaths: ["src/a.ts"],
            evidenceSha: "c".repeat(40),
            policy: "changelog-only-release-v1",
          },
        },
      ),
    ).toThrow("evidence reuse is invalid");
  });

  it("keeps a pinned-shaped expected branch on the pinned trust path", () => {
    expect(() =>
      validateFullReleaseValidationEvidence({
        run: releaseRun(),
        manifest: releaseManifest({
          evidenceReuse: { ...exactTargetEvidenceReuse(), selectedRunId: "" },
        }),
        expectedRepository: "openclaw/openclaw",
        expectedRunId: "123",
        expectedTargetSha: targetSha,
        expectedWorkflowBranch: pinnedBranch,
        isTrustedMainAncestor: () => true,
        validateEvidenceReuseStrictly: () => strictEvidenceReuse(),
      }),
    ).toThrow("evidence reuse is invalid");
  });

  it("does not treat a malformed release-ci expected branch as direct", () => {
    const branch = "release-ci/not-canonical";
    expect(() =>
      validateFullReleaseValidationEvidence({
        run: releaseRun({ head_branch: branch }),
        manifest: releaseManifest({
          workflowRef: branch,
          workflowFullRef: `refs/heads/${branch}`,
        }),
        expectedRepository: "openclaw/openclaw",
        expectedRunId: "123",
        expectedTargetSha: targetSha,
        expectedWorkflowBranch: branch,
        isTrustedMainAncestor: () => true,
      }),
    ).toThrow("untrusted head branch");
  });
});
