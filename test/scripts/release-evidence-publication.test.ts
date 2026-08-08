import { describe, expect, it } from "vitest";
import {
  assessReleaseEvidencePublication,
  publishedReleaseEvidenceMatches,
} from "../../scripts/release-evidence-publication.mjs";

const RUN_ID = 31144937783;
const RUN_ATTEMPT = 2;
const HEAD_SHA = "a".repeat(40);
const UPDATED_AT = "2026-08-07T05:30:00Z";

function run(overrides: Record<string, unknown> = {}) {
  return {
    conclusion: "success",
    event: "workflow_dispatch",
    head_repository: { full_name: "openclaw/openclaw" },
    head_sha: HEAD_SHA,
    id: RUN_ID,
    name: "Full Release Validation",
    path: ".github/workflows/full-release-validation.yml",
    repository: { full_name: "openclaw/openclaw" },
    run_attempt: RUN_ATTEMPT,
    status: "completed",
    updated_at: UPDATED_AT,
    ...overrides,
  };
}

function event(overrides: Record<string, unknown> = {}) {
  return { workflow_run: run(overrides) };
}

function evidence(
  publication: Record<string, unknown> = {
    packageSpec: "openclaw@2026.8.7",
    releaseRef: "v2026.8.7",
    requested: true,
  },
  rootPublication: Record<string, unknown> = publication,
) {
  return {
    current: {
      conclusion: "success",
      runAttempt: RUN_ATTEMPT,
      runId: String(RUN_ID),
      status: "completed",
      workflowSha: HEAD_SHA,
    },
    directRoot: true,
    evidenceReuse: null,
    releaseEvidencePublication: publication,
    manifest: {
      releaseEvidencePublication: rootPublication,
    },
    rerunGroup: "all",
    valid: true,
  };
}

describe("release evidence publication", () => {
  it("prepares one exact dispatch after a successful terminal run", () => {
    expect(assessReleaseEvidencePublication({ event: event(), evidence: evidence() })).toEqual({
      fullValidationRunId: String(RUN_ID),
      headSha: HEAD_SHA,
      notes: `Automatically requested after Full Release Validation ${RUN_ID}/${RUN_ATTEMPT} completed successfully.`,
      packageSpec: "openclaw@2026.8.7",
      publicationKey: `${RUN_ID}:${RUN_ATTEMPT}:${HEAD_SHA}`,
      reason: "requested",
      releaseId: "2026.8.7",
      releaseRef: "v2026.8.7",
      runAttempt: RUN_ATTEMPT,
      shouldDispatch: true,
      updatedAt: UPDATED_AT,
    });
  });

  it("does not dispatch when the current wrapper did not request publication", () => {
    expect(
      assessReleaseEvidencePublication({
        event: event(),
        evidence: evidence({ packageSpec: "", releaseRef: "main", requested: false }),
      }),
    ).toEqual({ reason: "not-requested", shouldDispatch: false });
  });

  it.each(["missing", "null"] as const)(
    "keeps historical manifests with %s publication intent as a no-op",
    (intent) => {
      const historicalEvidence = evidence();
      if (intent === "missing") {
        delete (historicalEvidence as { releaseEvidencePublication?: unknown })
          .releaseEvidencePublication;
      } else {
        (historicalEvidence as { releaseEvidencePublication: unknown }).releaseEvidencePublication =
          null;
      }

      expect(
        assessReleaseEvidencePublication({
          event: event(),
          evidence: historicalEvidence,
        }),
      ).toEqual({ reason: "not-requested", shouldDispatch: false });
    },
  );

  it.each([false, [], "requested", { requested: true }])(
    "rejects malformed present publication intent: %j",
    (publication) => {
      expect(() =>
        assessReleaseEvidencePublication({
          event: event(),
          evidence: {
            ...evidence(),
            releaseEvidencePublication: publication,
          },
        }),
      ).toThrow(/publication intent (?:must be an object|is invalid)/u);
    },
  );

  it("uses current wrapper publication intent instead of stale reused root intent", () => {
    expect(
      assessReleaseEvidencePublication({
        event: event(),
        evidence: evidence(
          { packageSpec: "", releaseRef: "main", requested: false },
          {
            packageSpec: "openclaw@2026.7.31",
            releaseRef: "v2026.7.31",
            requested: true,
          },
        ),
      }),
    ).toEqual({ reason: "not-requested", shouldDispatch: false });
  });

  it("accepts publication from a verified full-validation reuse root", () => {
    expect(
      assessReleaseEvidencePublication({
        event: event(),
        evidence: {
          ...evidence(),
          directRoot: false,
          evidenceReuse: {
            changedPaths: [],
            evidenceSha: HEAD_SHA,
            policy: "exact-target-full-validation-v1",
            rootRunId: "30000000000",
            selectedRunId: "30000000000",
          },
        },
      }),
    ).toMatchObject({
      reason: "requested",
      runAttempt: RUN_ATTEMPT,
      shouldDispatch: true,
    });
  });

  it("rejects successful partial reruns and inconsistent reuse claims", () => {
    expect(() =>
      assessReleaseEvidencePublication({
        event: event(),
        evidence: { ...evidence(), rerunGroup: "release-checks" },
      }),
    ).toThrow("complete direct validation or verified evidence reuse root");
    expect(() =>
      assessReleaseEvidencePublication({
        event: event(),
        evidence: { ...evidence(), directRoot: false },
      }),
    ).toThrow("complete direct validation or verified evidence reuse root");
    expect(() =>
      assessReleaseEvidencePublication({
        event: event(),
        evidence: { ...evidence(), evidenceReuse: { rootRunId: "30000000000" } },
      }),
    ).toThrow("complete direct validation or verified evidence reuse root");
  });

  it("keeps an unrequested partial rerun as a no-op", () => {
    expect(
      assessReleaseEvidencePublication({
        event: event(),
        evidence: {
          ...evidence({ packageSpec: "", releaseRef: "main", requested: false }),
          rerunGroup: "release-checks",
        },
      }),
    ).toEqual({ reason: "not-requested", shouldDispatch: false });
  });

  it.each([
    { packageSpec: "openclaw@2026.8.7\nrelease_ref=forged", releaseRef: "v2026.8.7" },
    { packageSpec: "openclaw@2026.8.7", releaseRef: "v2026.8.7\rpackage_spec=forged" },
    { packageSpec: "openclaw@2026.8.7\u001b[2K", releaseRef: "v2026.8.7" },
  ])("rejects control characters in publication outputs: $packageSpec", (publication) => {
    expect(() =>
      assessReleaseEvidencePublication({
        event: event(),
        evidence: evidence({ ...publication, requested: true }),
      }),
    ).toThrow("publication intent is invalid");
  });

  it.each(["failure", "cancelled"])("rejects a terminal %s run", (conclusion) => {
    expect(() =>
      assessReleaseEvidencePublication({
        event: event({ conclusion }),
        evidence: evidence(),
      }),
    ).toThrow("exact completed/success publication tuple");
  });

  it("rejects stale or forged event and verifier tuples", () => {
    expect(() =>
      assessReleaseEvidencePublication({
        event: event({ run_attempt: 1 }),
        evidence: evidence(),
      }),
    ).toThrow("does not match the workflow_run event");
    expect(() =>
      assessReleaseEvidencePublication({
        event: event({ head_sha: "b".repeat(40) }),
        evidence: evidence(),
      }),
    ).toThrow("does not match the workflow_run event");
  });

  it("gives each successful attempt a distinct durable publication identity", () => {
    const firstAttempt = assessReleaseEvidencePublication({
      event: event({ run_attempt: 1 }),
      evidence: {
        ...evidence(),
        current: { ...evidence().current, runAttempt: 1 },
      },
    });
    const rerun = assessReleaseEvidencePublication({ event: event(), evidence: evidence() });

    expect(firstAttempt.shouldDispatch).toBe(true);
    expect(rerun.shouldDispatch).toBe(true);
    if (!firstAttempt.shouldDispatch || !rerun.shouldDispatch) {
      throw new Error("expected publication assessments");
    }
    expect(rerun.publicationKey).not.toBe(firstAttempt.publicationKey);
    expect(rerun.releaseId).toBe(firstAttempt.releaseId);
    expect(rerun.releaseRef).toBe(firstAttempt.releaseRef);
    expect(rerun.runAttempt).toBe(2);
    expect(firstAttempt.runAttempt).toBe(1);
  });

  it("recognizes only the exact durable publication binding", () => {
    const expected = assessReleaseEvidencePublication({ event: event(), evidence: evidence() });
    expect(expected.shouldDispatch).toBe(true);
    if (!expected.shouldDispatch) {
      throw new Error("expected a publication assessment");
    }
    const published = {
      release: {
        id: expected.releaseId,
        packageSpec: expected.packageSpec,
        ref: expected.releaseRef,
      },
      runs: [
        {
          conclusion: "success",
          headSha: expected.headSha,
          label: "full-release-validation",
          path: ".github/workflows/full-release-validation.yml",
          repo: "openclaw/openclaw",
          runAttempt: expected.runAttempt,
          runId: Number(expected.fullValidationRunId),
          status: "completed",
          updatedAt: expected.updatedAt,
        },
      ],
    };
    expect(publishedReleaseEvidenceMatches(published, expected)).toBe(true);
    expect(publishedReleaseEvidenceMatches(published, expected)).toBe(true);
    expect(
      publishedReleaseEvidenceMatches(
        {
          ...published,
          runs: [{ ...published.runs[0], headSha: "b".repeat(40) }],
        },
        expected,
      ),
    ).toBe(false);
    expect(
      publishedReleaseEvidenceMatches(
        {
          ...published,
          runs: [{ ...published.runs[0], updatedAt: "2026-08-07T06:00:00Z" }],
        },
        expected,
      ),
    ).toBe(false);
    expect(
      publishedReleaseEvidenceMatches(
        {
          ...published,
          runs: [{ ...published.runs[0], runAttempt: 1 }],
        },
        expected,
      ),
    ).toBe(false);
    expect(
      publishedReleaseEvidenceMatches(
        {
          ...published,
          runs: [{ ...published.runs[0], conclusion: "failure" }],
        },
        expected,
      ),
    ).toBe(false);
  });

  it("rejects publication intent that cannot derive a safe release id", () => {
    expect(() =>
      assessReleaseEvidencePublication({
        event: event(),
        evidence: evidence({ packageSpec: "", releaseRef: "feature/bad", requested: true }),
      }),
    ).toThrow("safe release ID");
  });
});
