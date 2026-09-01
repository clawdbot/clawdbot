import { describe, expect, it, vi } from "vitest";
import {
  validateNpmPreflightProducer,
  verifyReleasePreflightToolingIdentity,
} from "../../scripts/npm-preflight-tooling-identity.mjs";
import {
  resolveReleaseToolingIdentity,
  validateReleasePublishParentRun,
  validateReleaseToolingIdentity,
  verifyReleaseToolingIdentity,
} from "../../scripts/release-tooling-identity.mjs";

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
      if (!route || !(route in responses)) throw new Error("unavailable provenance");
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
    expect(() =>
      verifyReleasePreflightToolingIdentity(proof({ [String(route)]: response })),
    ).toThrow();
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
