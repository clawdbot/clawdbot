import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import JSZip from "jszip";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  downloadFullReleaseNpmPreflight,
  resolveFullReleaseNpmPreflight,
  validateNpmPreflightProducer,
  validateFullReleaseNpmPreflight,
  verifyNpmPreflightProducer,
  verifyReleasePreflightToolingIdentity,
} from "../../scripts/npm-preflight-tooling-identity.mjs";
import {
  resolveReleaseToolingIdentity,
  validateReleasePublishParentRun,
  validateReleaseToolingIdentity,
  verifyReleaseToolingIdentity,
} from "../../scripts/release-tooling-identity.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);
const RUN_ID = "12345";
const PARENT_RUN_ID = "67890";
const PARENT_RUN_ATTEMPT = "2";
const REF = `release-publish/${SHA.slice(0, 12)}-${RUN_ID}`;
const FULL_REF = `refs/tags/${REF}`;

function protectedIdentity(
  overrides: Partial<Parameters<typeof verifyReleaseToolingIdentity>[0]> = {},
) {
  return {
    repository: "openclaw/openclaw",
    workflowFullRef: FULL_REF,
    workflowRef: REF,
    workflowSha: SHA,
    ...overrides,
  };
}

describe("release tooling identity", () => {
  it.each([
    ["1", "main", "refs/heads/main"],
    ["2", "release/2026.8.1", "refs/heads/release/2026.8.1"],
    ["2", "tideclaw/alpha/2026-08-21-1200Z", "refs/heads/tideclaw/alpha/2026-08-21-1200Z"],
  ])("derives contract %s identity for safe direct workflow ref %s", (contract, ref, fullRef) => {
    expect(
      resolveReleaseToolingIdentity({
        workflowContract: contract,
        workflowFullRef: fullRef,
        workflowRef: ref,
        workflowSha: SHA,
      }),
    ).toEqual({ fullRef, ref, sha: SHA });
  });

  it("rejects unsupported contract 3 even with explicit identity", () => {
    expect(() =>
      resolveReleaseToolingIdentity({
        requestedIdentityJson: JSON.stringify({
          ref: "main",
          fullRef: "refs/heads/main",
          sha: SHA,
        }),
        workflowContract: "3",
        workflowFullRef: "refs/heads/main",
        workflowRef: "main",
        workflowSha: SHA,
      }),
    ).toThrow("release tooling contract 3 is not supported");
  });

  it.each([
    [
      "release-ci ref",
      {
        workflowContract: "2",
        workflowFullRef: `refs/heads/release-ci/${SHA.slice(0, 12)}-123`,
        workflowRef: `release-ci/${SHA.slice(0, 12)}-123`,
      },
    ],
    [
      "protected tag",
      {
        workflowContract: "2",
        workflowFullRef: FULL_REF,
        workflowRef: REF,
      },
    ],
  ])("requires explicit identity for $0", (_label, overrides) => {
    const { workflowContract, workflowFullRef } = overrides;
    const workflowRef = "workflowRef" in overrides ? overrides.workflowRef : "main";
    expect(() =>
      resolveReleaseToolingIdentity({
        workflowContract,
        workflowFullRef,
        workflowRef,
        workflowSha: SHA,
      }),
    ).toThrow(/requires explicit trusted workflow identity|require explicit trusted workflow/u);
  });

  it("accepts explicit main identity for a matching release-ci workflow", () => {
    const releaseCiRef = `release-ci/${SHA.slice(0, 12)}-123`;
    expect(
      resolveReleaseToolingIdentity({
        requestedIdentityJson: JSON.stringify({
          ref: "main",
          fullRef: "refs/heads/main",
          sha: SHA,
        }),
        workflowContract: "2",
        workflowFullRef: `refs/heads/${releaseCiRef}`,
        workflowRef: releaseCiRef,
        workflowSha: SHA,
      }),
    ).toEqual({ ref: "main", fullRef: "refs/heads/main", sha: SHA });
  });

  it("rejects explicit identity that does not match a direct workflow", () => {
    expect(() =>
      resolveReleaseToolingIdentity({
        requestedIdentityJson: JSON.stringify({
          ref: "main",
          fullRef: "refs/heads/main",
          sha: OTHER_SHA,
        }),
        workflowContract: "2",
        workflowFullRef: "refs/heads/main",
        workflowRef: "main",
        workflowSha: SHA,
      }),
    ).toThrow("must match the executing workflow ref and SHA");
  });

  it("accepts only the live exact lightweight protected tag", () => {
    const runGh = vi.fn(() =>
      JSON.stringify({
        ref: FULL_REF,
        object: { sha: SHA, type: "commit" },
      }),
    );

    expect(verifyReleaseToolingIdentity({ ...protectedIdentity(), runGh })).toEqual({
      fullRef: FULL_REF,
      ref: REF,
      route: "protected-tag",
      sha: SHA,
    });
    expect(runGh).toHaveBeenCalledWith([
      "api",
      `repos/openclaw/openclaw/git/ref/tags/${REF}`,
      "--method",
      "GET",
    ]);
  });

  it.each([
    [
      "moved tag",
      {
        runGh: () =>
          JSON.stringify({
            ref: FULL_REF,
            object: { sha: OTHER_SHA, type: "commit" },
          }),
      },
      "missing, moved, annotated, or bound to the wrong SHA",
    ],
    [
      "deleted tag",
      {
        runGh: () => {
          throw new Error("HTTP 404");
        },
      },
      "missing or unreadable",
    ],
    [
      "annotated tag",
      {
        runGh: () =>
          JSON.stringify({
            ref: FULL_REF,
            object: { sha: OTHER_SHA, type: "tag" },
          }),
      },
      "missing, moved, annotated, or bound to the wrong SHA",
    ],
    [
      "wrong SHA prefix",
      {
        workflowRef: `release-publish/${OTHER_SHA.slice(0, 12)}-${RUN_ID}`,
        workflowFullRef: `refs/tags/release-publish/${OTHER_SHA.slice(0, 12)}-${RUN_ID}`,
      },
      "SHA prefix does not match",
    ],
    ["same-name branch", { workflowFullRef: `refs/heads/${REF}` }, "exact tag full ref"],
  ])("rejects $0", (_label, overrides, expectedError) => {
    expect(() =>
      verifyReleaseToolingIdentity({
        ...protectedIdentity(),
        ...overrides,
      }),
    ).toThrow(expectedError);
  });

  it.each(["ahead", "identical"])(
    "accepts main tooling reachable from current main: %s",
    (status) => {
      const runGh = vi.fn(() => JSON.stringify({ status }));
      expect(
        verifyReleaseToolingIdentity({
          repository: "openclaw/openclaw",
          runGh,
          workflowFullRef: "refs/heads/main",
          workflowRef: "main",
          workflowSha: SHA,
        }),
      ).toMatchObject({ route: "main", sha: SHA });
      expect(runGh).toHaveBeenCalledWith([
        "api",
        `repos/openclaw/openclaw/compare/${SHA}...main`,
        "--method",
        "GET",
        "--jq",
        "{status}",
      ]);
    },
  );

  it("rejects main tooling outside current main ancestry", () => {
    expect(() =>
      validateReleaseToolingIdentity({
        mainComparisonStatus: "diverged",
        workflowFullRef: "refs/heads/main",
        workflowRef: "main",
        workflowSha: SHA,
      }),
    ).toThrow("not reachable from current main");
  });

  it("preserves explicitly prevalidated non-main branch routes", () => {
    const runGh = vi.fn(() =>
      JSON.stringify({
        ref: "refs/heads/release/2026.8.1",
        object: { sha: SHA, type: "commit" },
      }),
    );
    expect(
      verifyReleaseToolingIdentity({
        allowPrevalidatedRef: true,
        repository: "openclaw/openclaw",
        runGh,
        workflowFullRef: "refs/heads/release/2026.8.1",
        workflowRef: "release/2026.8.1",
        workflowSha: SHA,
      }),
    ).toMatchObject({ route: "prevalidated-branch" });
    expect(runGh).toHaveBeenCalledWith([
      "api",
      "repos/openclaw/openclaw/git/ref/heads/release/2026.8.1",
      "--method",
      "GET",
    ]);
  });

  it("rejects a prevalidated branch moved after approval", () => {
    expect(() =>
      verifyReleaseToolingIdentity({
        allowPrevalidatedRef: true,
        repository: "openclaw/openclaw",
        runGh: () =>
          JSON.stringify({
            ref: "refs/heads/release/2026.8.1",
            object: { sha: OTHER_SHA, type: "commit" },
          }),
        workflowFullRef: "refs/heads/release/2026.8.1",
        workflowRef: "release/2026.8.1",
        workflowSha: SHA,
      }),
    ).toThrow("branch is missing or moved");
  });

  it("binds a distinct current parent run independently from tag provenance", () => {
    const calls: string[][] = [];
    const runGh = vi.fn((args: string[]) => {
      calls.push(args);
      if (args[1]?.includes("/git/ref/tags/")) {
        return JSON.stringify({
          ref: FULL_REF,
          object: { sha: SHA, type: "commit" },
        });
      }
      return JSON.stringify({
        id: Number(PARENT_RUN_ID),
        run_attempt: Number(PARENT_RUN_ATTEMPT),
        repository: { full_name: "openclaw/openclaw" },
        path: ".github/workflows/openclaw-release-publish.yml@refs/heads/main",
        event: "workflow_dispatch",
        head_branch: "main",
        head_sha: SHA,
        status: "in_progress",
        conclusion: null,
      });
    });

    expect(
      verifyReleaseToolingIdentity({
        ...protectedIdentity(),
        releasePublishFullRef: "refs/heads/main",
        releasePublishParentStatePolicy: "active",
        releasePublishRef: "main",
        releasePublishRunAttempt: PARENT_RUN_ATTEMPT,
        releasePublishRunId: PARENT_RUN_ID,
        runGh,
      }),
    ).toMatchObject({ route: "protected-tag", sha: SHA });
    expect(PARENT_RUN_ID).not.toBe(RUN_ID);
    expect(calls).toContainEqual([
      "api",
      `repos/openclaw/openclaw/actions/runs/${PARENT_RUN_ID}`,
      "--method",
      "GET",
    ]);
  });

  it.each([
    ["active", "in_progress", null, true],
    ["active", "completed", "success", false],
    ["active-or-failure", "in_progress", null, true],
    ["active-or-failure", "completed", "failure", true],
    ["active-or-failure", "completed", "success", false],
    ["active-or-failure", "completed", "cancelled", false],
    ["active-or-success", "in_progress", null, true],
    ["active-or-success", "completed", "success", true],
    ["active-or-success", "completed", "failure", false],
    ["manual-recovery", "in_progress", null, true],
    ["manual-recovery", "completed", "success", true],
    ["manual-recovery", "completed", "failure", true],
    ["manual-recovery", "completed", "cancelled", false],
  ] as const)(
    "enforces parent state policy %s for %s/%s",
    (releasePublishParentStatePolicy, status, conclusion, accepted) => {
      const validate = () =>
        validateReleasePublishParentRun({
          identity: { ref: REF, fullRef: FULL_REF, sha: SHA },
          releasePublishFullRef: "refs/heads/main",
          releasePublishParentStatePolicy,
          releasePublishRef: "main",
          releasePublishRunAttempt: PARENT_RUN_ATTEMPT,
          releasePublishRunId: PARENT_RUN_ID,
          repository: "openclaw/openclaw",
          run: {
            id: Number(PARENT_RUN_ID),
            run_attempt: Number(PARENT_RUN_ATTEMPT),
            repository: { full_name: "openclaw/openclaw" },
            path: ".github/workflows/openclaw-release-publish.yml@refs/heads/main",
            event: "workflow_dispatch",
            head_branch: "main",
            head_sha: SHA,
            status,
            conclusion,
          },
        });

      if (accepted) {
        expect(validate).not.toThrow();
      } else {
        expect(validate).toThrow(`state is not allowed by ${releasePublishParentStatePolicy}`);
      }
    },
  );

  it("requires the parent state policy with the exact parent run tuple", () => {
    expect(() =>
      verifyReleaseToolingIdentity({
        ...protectedIdentity(),
        releasePublishRunAttempt: PARENT_RUN_ATTEMPT,
        releasePublishRunId: PARENT_RUN_ID,
        runGh: () =>
          JSON.stringify({
            ref: FULL_REF,
            object: { sha: SHA, type: "commit" },
          }),
      }),
    ).toThrow("run id, attempt, ref, full ref, and parent state policy must be provided together");
  });

  it.each([
    ["wrong parent branch", "release/2026.8.1", "refs/heads/main"],
    ["wrong parent full ref", "main", "refs/heads/release/2026.8.1"],
    ["untrusted parent ref", "feature/release", "refs/heads/feature/release"],
  ])("rejects %s independently of protected child identity", (_label, parentRef, parentFullRef) => {
    expect(() =>
      validateReleasePublishParentRun({
        identity: { ref: REF, fullRef: FULL_REF, sha: SHA },
        releasePublishFullRef: parentFullRef,
        releasePublishParentStatePolicy: "active",
        releasePublishRef: parentRef,
        releasePublishRunAttempt: PARENT_RUN_ATTEMPT,
        releasePublishRunId: PARENT_RUN_ID,
        repository: "openclaw/openclaw",
        run: {
          id: Number(PARENT_RUN_ID),
          run_attempt: Number(PARENT_RUN_ATTEMPT),
          repository: { full_name: "openclaw/openclaw" },
          path: ".github/workflows/openclaw-release-publish.yml@refs/heads/main",
          event: "workflow_dispatch",
          head_branch: "main",
          head_sha: SHA,
          status: "in_progress",
          conclusion: null,
        },
      }),
    ).toThrow();
  });
});

describe("historical npm preflight tooling", () => {
  const producer = {
    repository: "openclaw/openclaw",
    workflowRef: `openclaw/openclaw/.github/workflows/openclaw-npm-release.yml@${FULL_REF}`,
    workflowSha: SHA,
    runId: RUN_ID,
    runAttempt: "1",
  };
  const expectedProducer = {
    repository: producer.repository,
    workflowFullRef: FULL_REF,
    workflowSha: SHA,
    runId: RUN_ID,
    runAttempt: "1",
  };

  it("distinguishes immutable original ref evidence from legacy unknown provenance", () => {
    expect(
      validateNpmPreflightProducer({ ...expectedProducer, manifest: { version: 2, producer } }),
    ).toEqual({ originalWorkflowRef: producer.workflowRef, provenance: "immutable-manifest" });
    expect(validateNpmPreflightProducer({ ...expectedProducer, manifest: { version: 1 } })).toEqual(
      { originalWorkflowRef: null, provenance: "legacy-unrecorded" },
    );
  });

  it.each([
    { version: 2 },
    { version: 1, producer },
    { version: "2", producer },
    {
      version: 2,
      producer: {
        ...producer,
        workflowRef: producer.workflowRef.replace("refs/tags/", "refs/heads/"),
      },
    },
    { version: 2, producer: { ...producer, workflowSha: OTHER_SHA } },
    { version: 2, producer: { ...producer, runId: PARENT_RUN_ID } },
    { version: 2, producer: { ...producer, runAttempt: "2" } },
    { version: 2, producer: { ...producer, repository: "other/repo" } },
    { version: 2, producer: { ...producer, extra: true } },
  ])("rejects incomplete or mismatched immutable producer evidence %j", (manifest) => {
    expect(() => validateNpmPreflightProducer({ ...expectedProducer, manifest })).toThrow();
  });

  function proof(overrides: Record<string, unknown> = {}) {
    const responses: Record<string, unknown> = {
      [`git/ref/tags/${REF}`]: { ref: FULL_REF, object: { sha: SHA, type: "commit" } },
      [`git/matching-refs/heads/${REF}`]: [],
      [`compare/${SHA}...main`]: { status: "ahead" },
      [`compare/${SHA}...${OTHER_SHA}`]: { status: "ahead" },
      ...overrides,
    };
    const runGh = vi.fn((args: string[]) => {
      const route = args[1]?.replace("repos/openclaw/openclaw/", "");
      if (!route || !(route in responses)) {
        throw new Error("unavailable provenance");
      }
      return JSON.stringify(responses[route]);
    });
    return { ...protectedIdentity(), publisherSha: OTHER_SHA, runGh };
  }

  it("accepts an unchanged historical producer under a distinct descendant publisher", () => {
    const options = proof();
    expect(verifyReleasePreflightToolingIdentity(options)).toMatchObject({
      ref: REF,
      sha: SHA,
      route: "protected-tag",
    });
    expect(options.runGh.mock.calls.map(([args]) => args[1])).toEqual([
      `repos/openclaw/openclaw/git/ref/tags/${REF}`,
      `repos/openclaw/openclaw/git/matching-refs/heads/${REF}`,
      `repos/openclaw/openclaw/compare/${SHA}...main`,
      `repos/openclaw/openclaw/compare/${SHA}...${OTHER_SHA}`,
    ]);
  });

  it.each([
    ["missing tag", `git/ref/tags/${REF}`, null],
    [
      "moved tag",
      `git/ref/tags/${REF}`,
      { ref: FULL_REF, object: { sha: OTHER_SHA, type: "commit" } },
    ],
    ["annotated tag", `git/ref/tags/${REF}`, { ref: FULL_REF, object: { sha: SHA, type: "tag" } }],
    ["ambiguous branch", `git/matching-refs/heads/${REF}`, [{ ref: `refs/heads/${REF}` }]],
    ["malformed branches", `git/matching-refs/heads/${REF}`, {}],
    ["malformed branch entry", `git/matching-refs/heads/${REF}`, [{}]],
    ["producer outside main", `compare/${SHA}...main`, { status: "diverged" }],
    ["producer newer than publisher", `compare/${SHA}...${OTHER_SHA}`, { status: "behind" }],
    ["unrelated publisher", `compare/${SHA}...${OTHER_SHA}`, { status: "diverged" }],
    ["missing ancestry", `compare/${SHA}...${OTHER_SHA}`, {}],
  ])("rejects %s", (_name, route, response) => {
    expect(() => verifyReleasePreflightToolingIdentity(proof({ [route]: response }))).toThrow();
  });

  it("fails closed when provenance cannot be read", () => {
    expect(() =>
      verifyReleasePreflightToolingIdentity({
        ...proof(),
        runGh: () => {
          throw new Error("HTTP 503");
        },
      }),
    ).toThrow("HTTP 503");
  });

  it.each([
    { publisherSha: "invalid" },
    { workflowFullRef: `refs/heads/${REF}` },
    { workflowSha: OTHER_SHA },
  ])("rejects invalid producer or publisher identity %j", (override) => {
    expect(() => verifyReleasePreflightToolingIdentity({ ...proof(), ...override })).toThrow();
  });
});

describe.each([
  {
    label: "FRV-owned",
    workflowPath: ".github/workflows/full-release-validation.yml",
    fullRunId: RUN_ID,
    fullRunAttempt: "1",
  },
  {
    label: "independent producer after FRV rerun",
    workflowPath: ".github/workflows/full-release-artifacts.yml",
    fullRunId: PARENT_RUN_ID,
    fullRunAttempt: "3",
  },
])("$label npm qualification", ({ workflowPath, fullRunId, fullRunAttempt }) => {
  const producer = {
    repository: "openclaw/openclaw",
    workflowRef: `openclaw/openclaw/${workflowPath}@refs/heads/main`,
    workflowSha: SHA,
    runId: RUN_ID,
    runAttempt: "1",
    jobId: "999",
    jobName: "Qualify release npm artifacts / Qualify prepared npm package",
    producerWorkflowPath: ".github/workflows/openclaw-npm-preflight.yml",
  };
  const manifest = {
    version: 3,
    releaseSha: OTHER_SHA,
    tarballName: "openclaw.tgz",
    tarballSha256: "c".repeat(64),
    producer,
    preparedBundle: {
      schema: "openclaw.prepared-npm-bundle/v1",
      source: { sha: OTHER_SHA },
      package: { sha256: "c".repeat(64) },
      producer: { repository: producer.repository, workflowSha: SHA },
    },
  };
  const qualified = {
    schema: "openclaw.qualified-npm-preflight/v1",
    source: { sha: OTHER_SHA },
    producer,
    manifestSha256: "d".repeat(64),
    artifact: {
      id: "555",
      name: `openclaw-npm-preflight-${OTHER_SHA}`,
      digest: "e".repeat(64),
      runId: RUN_ID,
      runAttempt: "1",
    },
  };
  const fullReleaseManifest = {
    workflowName: "Full Release Validation",
    runId: fullRunId,
    runAttempt: fullRunAttempt,
    workflowFullRef: "refs/heads/main",
    targetSha: OTHER_SHA,
    workflowSha: SHA,
    publicationArtifacts: { npmPreflight: qualified },
  };
  const input = {
    manifest,
    repository: producer.repository,
    workflowFullRef: "refs/heads/main",
    workflowSha: SHA,
    workflowPath,
    runId: RUN_ID,
    runAttempt: "1",
    fullReleaseManifest,
    fullReleaseRunId: fullRunId,
    fullReleaseRunAttempt: fullRunAttempt,
    manifestSha256: "d".repeat(64),
  };
  const resolutionInput = {
    manifest: fullReleaseManifest,
    repository: producer.repository,
    runId: fullRunId,
    runAttempt: fullRunAttempt,
    sourceSha: OTHER_SHA,
    toolingSha: SHA,
  };
  function reader(jobOverrides = {}, artifactOverrides = {}, runOverrides = {}) {
    const job = {
      id: 999,
      name: producer.jobName,
      run_id: Number(RUN_ID),
      run_attempt: 1,
      head_sha: SHA,
      status: "completed",
      conclusion: "success",
      ...jobOverrides,
    };
    return (args: string[]) => {
      const endpoint = args[1];
      if (!endpoint) {
        throw new Error("Expected GitHub API endpoint.");
      }
      if (endpoint.endsWith("/artifacts/555")) {
        return JSON.stringify({
          id: 555,
          name: qualified.artifact.name,
          digest: `sha256:${qualified.artifact.digest}`,
          expired: false,
          workflow_run: { id: Number(RUN_ID), head_sha: SHA },
          ...artifactOverrides,
        });
      }
      if (endpoint.includes("/jobs?")) {
        return JSON.stringify({ total_count: 1, jobs: [job] });
      }
      if (endpoint.endsWith("/attempts/1")) {
        return JSON.stringify({
          id: Number(RUN_ID),
          run_attempt: 1,
          head_sha: SHA,
          path: workflowPath,
          head_branch: "main",
          event: "workflow_dispatch",
          status: "completed",
          conclusion: "success",
          repository: { full_name: producer.repository },
          head_repository: { full_name: producer.repository },
          ...runOverrides,
        });
      }
      throw new Error(`Unexpected proof request: ${endpoint}`);
    };
  }
  it("requires the exact successful qualifier and immutable artifact from the selected FRV", () => {
    const runGh = vi.fn(reader());
    expect(resolveFullReleaseNpmPreflight({ ...resolutionInput, runGh })).toMatchObject({
      producer: { runId: RUN_ID, runAttempt: "1" },
      artifact: { id: 555 },
    });
    expect(runGh.mock.calls.map(([args]) => args[1])).toContain(
      `repos/openclaw/openclaw/actions/runs/${RUN_ID}/attempts/1`,
    );
    expect(verifyNpmPreflightProducer({ ...input, runGh: reader() })).toMatchObject({
      provenance: "immutable-manifest",
    });
    expect(() =>
      verifyNpmPreflightProducer({ ...input, runGh: reader({ conclusion: "failure" }) }),
    ).toThrow("completed producer job");
    expect(() =>
      verifyNpmPreflightProducer({ ...input, manifestSha256: "f".repeat(64), runGh: reader() }),
    ).toThrow("exact full release qualification");
    expect(() =>
      verifyNpmPreflightProducer({ ...input, fullReleaseManifest: undefined, runGh: reader() }),
    ).toThrow("qualified npm preflight");
  });
  it("rejects stale source or attempt and raw-only package evidence", () => {
    expect(() =>
      verifyNpmPreflightProducer({ ...input, manifest: { version: 1 }, runGh: reader() }),
    ).toThrow("qualified version 3");
    const expected = {
      manifest: fullReleaseManifest,
      runId: fullRunId,
      runAttempt: fullRunAttempt,
      sourceSha: OTHER_SHA,
      toolingSha: SHA,
    };
    expect(() => validateFullReleaseNpmPreflight({ ...expected, sourceSha: SHA })).toThrow(
      "qualified npm preflight",
    );
    expect(() => validateFullReleaseNpmPreflight({ ...expected, runAttempt: "2" })).toThrow(
      "qualified npm preflight",
    );
    expect(() =>
      validateNpmPreflightProducer({
        ...input,
        manifest: {
          ...manifest,
          producer: { ...producer, jobName: "Prepare publishable npm package" },
        },
      }),
    ).toThrow("qualification");
  });

  it.each(["run", "attempt", "tooling", "workflow", "repository", "ref"])(
    "rejects a descriptor detached from its %s binding",
    (mismatch) => {
      const changed = structuredClone(fullReleaseManifest);
      const descriptor = changed.publicationArtifacts.npmPreflight;
      if (mismatch === "run") {
        descriptor.artifact.runId = "99999";
      }
      if (mismatch === "attempt") {
        descriptor.artifact.runAttempt = "2";
      }
      if (mismatch === "tooling") {
        descriptor.producer.workflowSha = OTHER_SHA;
      }
      if (mismatch === "workflow") {
        descriptor.producer.workflowRef = producer.workflowRef.replace(
          workflowPath,
          ".github/workflows/ci.yml",
        );
      }
      if (mismatch === "repository") {
        descriptor.producer.repository = "other/repository";
      }
      if (mismatch === "ref") {
        descriptor.producer.workflowRef = producer.workflowRef.replace(
          "refs/heads/main",
          "refs/heads/other",
        );
      }
      expect(() =>
        resolveFullReleaseNpmPreflight({ ...resolutionInput, manifest: changed, runGh: reader() }),
      ).toThrow();
    },
  );

  it.each(["run", "attempt", "tooling", "workflow", "repository", "unfinished", "artifact"])(
    "rejects changed live %s evidence before downloading package bytes",
    (mismatch) => {
      const runOverrides: Record<string, unknown> = {};
      const artifactOverrides: Record<string, unknown> = {};
      if (mismatch === "run") {
        runOverrides.id = 777;
      }
      if (mismatch === "attempt") {
        runOverrides.run_attempt = 2;
      }
      if (mismatch === "tooling") {
        runOverrides.head_sha = OTHER_SHA;
      }
      if (mismatch === "workflow") {
        runOverrides.path = ".github/workflows/ci.yml";
      }
      if (mismatch === "repository") {
        runOverrides.repository = { full_name: "other/repository" };
      }
      if (mismatch === "unfinished") {
        Object.assign(runOverrides, { status: "in_progress", conclusion: null });
      }
      if (mismatch === "artifact") {
        artifactOverrides.workflow_run = { id: 777, head_sha: SHA };
      }
      expect(() =>
        resolveFullReleaseNpmPreflight({
          ...resolutionInput,
          runGh: reader({}, artifactOverrides, runOverrides),
        }),
      ).toThrow();
    },
  );

  it.each(["valid", "archive changed", "manifest changed", "deadline exceeded"])(
    "downloads only the exact qualified archive (%s)",
    async (outcome) => {
      const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
      const tarballBytes = Buffer.from("prepared package bytes");
      const zip = new JSZip();
      zip.file("preflight-manifest.json", manifestBytes);
      zip.file(manifest.tarballName, tarballBytes);
      zip.file("dependency-evidence/dependency-evidence-manifest.json", "{}", {
        createFolders: false,
      });
      const archive = await zip.generateAsync({
        type: "nodebuffer",
        compression: "STORE",
        platform: "UNIX",
      });
      const selected = structuredClone(fullReleaseManifest);
      selected.publicationArtifacts.npmPreflight.artifact.digest = createHash("sha256")
        .update(archive)
        .digest("hex");
      selected.publicationArtifacts.npmPreflight.manifestSha256 =
        outcome === "manifest changed"
          ? "f".repeat(64)
          : createHash("sha256").update(manifestBytes).digest("hex");
      const metadata = {
        id: 555,
        name: qualified.artifact.name,
        digest: `sha256:${selected.publicationArtifacts.npmPreflight.artifact.digest}`,
        size_in_bytes: archive.length,
        expired: false,
        expires_at: "2099-10-01T00:00:00Z",
        workflow_run: { id: Number(RUN_ID), head_sha: SHA },
      };
      const delivered = Buffer.from(archive);
      if (outcome === "archive changed") {
        delivered.writeUInt8(delivered.readUInt8(0) ^ 1, 0);
      }
      const requests: string[] = [];
      const fetchImpl: typeof fetch = async (url) => {
        const requestUrl = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
        requests.push(requestUrl);
        return requestUrl.endsWith("/zip")
          ? new Response(new Uint8Array(delivered))
          : Response.json(metadata);
      };
      const root = tempDirs.make("qualified-npm-preflight-");
      const outputDir = join(root, "qualified");
      const downloadOptions = {
        ...resolutionInput,
        manifest: selected,
        outputDir,
        token: "test-artifact-token",
        runGh: reader({}, metadata),
        fetchImpl,
        archivePath: join(root, "555.zip"),
        deadlineMs: Date.now() + (outcome === "deadline exceeded" ? -1 : 10_000),
      };
      const download = downloadFullReleaseNpmPreflight(downloadOptions);
      if (outcome === "valid") {
        await expect(download).resolves.toMatchObject({
          producer: { runId: RUN_ID, runAttempt: "1" },
        });
        expect(readFileSync(join(outputDir, "preflight-manifest.json"))).toEqual(manifestBytes);
        expect(readFileSync(join(outputDir, manifest.tarballName))).toEqual(tarballBytes);
        expect(
          readFileSync(
            join(outputDir, "dependency-evidence/dependency-evidence-manifest.json"),
            "utf8",
          ),
        ).toBe("{}");
        const retriedDir = join(root, "retried");
        await downloadFullReleaseNpmPreflight({ ...downloadOptions, outputDir: retriedDir });
        expect(readFileSync(join(retriedDir, manifest.tarballName))).toEqual(tarballBytes);
        expect(requests.filter((url) => url.endsWith("/zip"))).toHaveLength(1);
      } else {
        await expect(download).rejects.toThrow(
          outcome === "archive changed"
            ? "digest"
            : outcome === "deadline exceeded"
              ? "deadline exceeded"
              : "qualified descriptor",
        );
        expect(existsSync(outputDir)).toBe(false);
        if (outcome === "deadline exceeded") {
          expect(requests).toHaveLength(0);
        }
      }
    },
  );
});
