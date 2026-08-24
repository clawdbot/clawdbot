import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  capturePriorExtendedStableSelector,
  extendedStableSelectorRepairCommand,
  parseExtendedStableGuardBypass,
  parsePriorExtendedStableSelector,
  validateFullReleaseValidationManifest,
  validateNpmPublishBoundary,
  validateExtendedStableNpmReleaseRequest,
  validateExtendedStableRunIdentity,
  verifyExtendedStableRegistryReadback,
} from "../../scripts/openclaw-npm-extended-stable-release.mjs";

const sha = "a".repeat(40);
const branch = "extended-stable/2026.6.33";

describe("npm extended-stable publication boundary", () => {
  it("parses only explicit boolean extended-stable guard values", () => {
    expect(parseExtendedStableGuardBypass()).toBe(false);
    expect(parseExtendedStableGuardBypass("")).toBe(false);
    expect(parseExtendedStableGuardBypass("false")).toBe(false);
    expect(parseExtendedStableGuardBypass("true")).toBe(true);
    expect(() => parseExtendedStableGuardBypass("1")).toThrow(/must be "true" or "false"/u);
  });

  it.each([
    ["2026.6.11-alpha.1", "alpha"],
    ["2026.6.11-beta.1", "beta"],
    ["2026.6.11", "alpha"],
    ["2026.6.11", "beta"],
    ["2026.6.11", "latest"],
    ["2026.6.11-1", "alpha"],
    ["2026.6.11-1", "beta"],
    ["2026.6.11-1", "latest"],
    ["2026.6.33", "extended-stable"],
    ["2026.6.34", "extended-stable"],
  ])("accepts %s on %s", (version, distTag) => {
    expect(() => validateNpmPublishBoundary(version, distTag)).not.toThrow();
  });

  it.each([
    ["2026.6.11", "extended-stable"],
    ["2026.6.11-alpha.1", "beta"],
    ["2026.6.11-alpha.1", "extended-stable"],
    ["2026.6.11-beta.1", "latest"],
    ["2026.6.11-beta.1", "extended-stable"],
    ["2026.6.33", "alpha"],
    ["2026.6.33", "beta"],
    ["2026.6.33", "latest"],
    ["2026.6.33-1", "alpha"],
    ["2026.6.33-1", "beta"],
    ["2026.6.33-1", "latest"],
    ["2026.6.33-1", "extended-stable"],
    ["2026.6.33", "stable"],
    ["2026.6.33", "nightly"],
  ])("rejects %s on %s", (version, distTag) => {
    expect(() => validateNpmPublishBoundary(version, distTag)).toThrow();
  });

  it("prints exactly channel then publish tag from the dependency-free CLI", () => {
    const result = spawnSync(
      process.execPath,
      ["scripts/openclaw-npm-extended-stable-release.mjs", "publish-plan"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PACKAGE_VERSION: "2026.6.33",
          REQUESTED_PUBLISH_TAG: "extended-stable",
        },
      },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("stable\nextended-stable\n");
    expect(result.stderr).toBe("");
  });

  it("allows a pre-.33 final extended-stable version only with the explicit bypass", () => {
    expect(() =>
      validateNpmPublishBoundary("2026.6.11", "extended-stable", {
        bypassExtendedStableGuard: true,
      }),
    ).not.toThrow();
    expect(() => validateNpmPublishBoundary("2026.6.11", "extended-stable")).toThrow(
      /patch 33 or above/u,
    );
    expect(() =>
      validateNpmPublishBoundary("2026.6.11-1", "extended-stable", {
        bypassExtendedStableGuard: true,
      }),
    ).toThrow(/does not allow correction suffixes/u);
  });

  it.each(["alpha", "beta", "latest"])(
    "rejects extended-stable guard bypass with the %s dist-tag",
    (distTag) => {
      expect(() =>
        validateNpmPublishBoundary("2026.6.11", distTag, {
          bypassExtendedStableGuard: true,
        }),
      ).toThrow(/only be used with the extended-stable npm dist-tag/u);
    },
  );

  it("preserves the unknown dist-tag rejection when bypass is requested", () => {
    expect(() =>
      validateNpmPublishBoundary("2026.6.11", "nightly", {
        bypassExtendedStableGuard: true,
      }),
    ).toThrow('Unsupported npm dist-tag "nightly"');
  });

  it.each([
    ["malformed bypass", "extended-stable", "sometimes", /must be "true" or "false"/u],
    [
      "non-extended-stable bypass",
      "beta",
      "true",
      /only be used with the extended-stable npm dist-tag/u,
    ],
  ])("rejects %s in the dependency-free CLI", (_label, distTag, bypass, error) => {
    const result = spawnSync(
      process.execPath,
      ["scripts/openclaw-npm-extended-stable-release.mjs", "publish-plan"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          BYPASS_EXTENDED_STABLE_GUARD: bypass,
          PACKAGE_VERSION: "2026.6.11",
          REQUESTED_PUBLISH_TAG: distTag,
        },
      },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(error);
  });
});

describe("extended-stable npm release request", () => {
  const valid = {
    npmDistTag: "extended-stable",
    releaseTag: "v2026.6.33",
    npmWorkflowRef: "refs/heads/extended-stable/2026.6.33",
    checkoutSha: sha,
    tagSha: sha,
    extendedStableBranchSha: sha,
    packageVersion: "2026.6.33",
    mainPackageVersion: "2026.7.2",
  };

  it("accepts .33, later patches, and any later protected-main calendar month", () => {
    expect(validateExtendedStableNpmReleaseRequest(valid)).toEqual({
      extendedStable: true,
      releaseVersion: "2026.6.33",
      extendedStableBranch: "extended-stable/2026.6.33",
    });
    expect(
      validateExtendedStableNpmReleaseRequest({
        ...valid,
        releaseTag: "v2026.6.34",
        packageVersion: "2026.6.34",
      }),
    ).toMatchObject({ extendedStable: true, releaseVersion: "2026.6.34" });
    expect(
      validateExtendedStableNpmReleaseRequest({
        ...valid,
        releaseTag: "v2026.12.33",
        npmWorkflowRef: "refs/heads/extended-stable/2026.12.33",
        packageVersion: "2026.12.33",
        mainPackageVersion: "2027.1.1",
      }),
    ).toMatchObject({
      extendedStable: true,
      extendedStableBranch: "extended-stable/2026.12.33",
    });
    expect(() =>
      validateExtendedStableNpmReleaseRequest({ ...valid, mainPackageVersion: "2026.8.1" }),
    ).not.toThrow();
    expect(() =>
      validateExtendedStableNpmReleaseRequest({ ...valid, mainPackageVersion: "2027.1.1" }),
    ).not.toThrow();
    expect(() =>
      validateExtendedStableNpmReleaseRequest({ ...valid, mainPackageVersion: "2028.12.32" }),
    ).not.toThrow();
  });

  it.each([
    ["patch below 33", { releaseTag: "v2026.6.32", packageVersion: "2026.6.32" }],
    ["beta prerelease", { releaseTag: "v2026.6.33-beta.1", packageVersion: "2026.6.33-beta.1" }],
    ["alpha prerelease", { releaseTag: "v2026.6.33-alpha.1", packageVersion: "2026.6.33-alpha.1" }],
    ["correction suffix", { releaseTag: "v2026.6.33-1", packageVersion: "2026.6.33-1" }],
    ["wrong branch", { npmWorkflowRef: "refs/heads/extended-stable/2026.6.34" }],
    ["checkout mismatch", { checkoutSha: "b".repeat(40) }],
    ["tag mismatch", { tagSha: "b".repeat(40) }],
    ["branch tip mismatch", { extendedStableBranchSha: "b".repeat(40) }],
    ["package mismatch", { packageVersion: "2026.6.34" }],
    ["main same month", { mainPackageVersion: "2026.6.1" }],
    ["main earlier month", { mainPackageVersion: "2026.5.32" }],
    ["main earlier year", { mainPackageVersion: "2025.12.32" }],
    ["main patch at monthly boundary", { mainPackageVersion: "2026.7.33" }],
  ])("rejects %s", (_label, changes) => {
    expect(() => validateExtendedStableNpmReleaseRequest({ ...valid, ...changes })).toThrow();
  });

  it("preserves SHA-only regular preflight requests", () => {
    expect(
      validateExtendedStableNpmReleaseRequest({
        ...valid,
        npmDistTag: "beta",
        releaseTag: sha,
      }),
    ).toEqual({ extendedStable: false });
  });

  it("accepts a SHA-only extended-stable preflight from an arbitrary workflow ref", () => {
    expect(
      validateExtendedStableNpmReleaseRequest({
        ...valid,
        preflightOnly: true,
        releaseTag: sha,
        npmWorkflowRef: "refs/heads/main",
        extendedStableBranchSha: "",
      }),
    ).toEqual({
      extendedStable: true,
      releaseVersion: "2026.6.33",
      extendedStableBranch: "extended-stable/2026.6.33",
    });
    expect(() =>
      validateExtendedStableNpmReleaseRequest({
        ...valid,
        preflightOnly: true,
        releaseTag: "b".repeat(40),
        npmWorkflowRef: "refs/heads/dev/preflight-candidate",
        extendedStableBranchSha: "",
      }),
    ).toThrow(/must match the checked-out commit/u);
    expect(() =>
      validateExtendedStableNpmReleaseRequest({
        ...valid,
        preflightOnly: true,
        releaseTag: sha,
        checkoutSha: "",
      }),
    ).toThrow(/requires the full checked-out commit SHA/u);
    expect(() => validateExtendedStableNpmReleaseRequest({ ...valid, releaseTag: sha })).toThrow(
      /exact final vYYYY\.M\.P release tag/u,
    );
  });

  it("bypasses patch and protected-main policy while preserving canonical branch identity", () => {
    const bypassed = {
      ...valid,
      bypassExtendedStableGuard: true,
      releaseTag: "v2026.6.11",
      packageVersion: "2026.6.11",
      mainPackageVersion: "",
    };
    expect(validateExtendedStableNpmReleaseRequest(bypassed)).toEqual({
      extendedStable: true,
      releaseVersion: "2026.6.11",
      extendedStableBranch: "extended-stable/2026.6.33",
      bypassExtendedStableGuard: true,
    });
    expect(() =>
      validateExtendedStableNpmReleaseRequest({ ...bypassed, packageVersion: "2026.6.12" }),
    ).toThrow(/package version mismatch/u);
    expect(() =>
      validateExtendedStableNpmReleaseRequest({
        ...bypassed,
        npmWorkflowRef: "refs/heads/dev/extended-stable-publish-test",
      }),
    ).toThrow(/workflow ref mismatch/u);
    expect(() =>
      validateExtendedStableNpmReleaseRequest({
        ...bypassed,
        extendedStableBranchSha: "b".repeat(40),
      }),
    ).toThrow(/branch tip SHAs must match/u);
  });

  it("rejects bypass on a regular npm release request", () => {
    expect(() =>
      validateExtendedStableNpmReleaseRequest({
        ...valid,
        bypassExtendedStableGuard: true,
        npmDistTag: "beta",
        releaseTag: sha,
      }),
    ).toThrow(/only be used with the extended-stable npm dist-tag/u);
  });
});

describe("extended-stable npm run identity", () => {
  const validPreflight = {
    workflowName: "OpenClaw NPM Release",
    event: "workflow_dispatch",
    conclusion: "success",
    headBranch: branch,
    headSha: sha,
  };

  it("accepts exact extended-stable preflight and validation runs", () => {
    expect(
      validateExtendedStableRunIdentity({
        run: validPreflight,
        kind: "preflight",
        npmDistTag: "extended-stable",
        expectedBranch: branch,
        expectedSha: sha,
      }),
    ).toBe(validPreflight);
    expect(() =>
      validateExtendedStableRunIdentity({
        run: {
          ...validPreflight,
          workflowName: "Full Release Validation",
          status: "completed",
        },
        kind: "validation",
        npmDistTag: "extended-stable",
        expectedBranch: branch,
        expectedSha: sha,
      }),
    ).not.toThrow();
  });

  it("accepts only a completed successful Plugin NPM Release run on the exact branch and SHA", () => {
    const pluginRun = {
      workflowName: "Plugin NPM Release",
      displayTitle: `Plugin NPM Release [extended-stable] ${sha}`,
      event: "workflow_dispatch",
      status: "completed",
      conclusion: "success",
      headBranch: branch,
      headSha: sha,
    };
    expect(
      validateExtendedStableRunIdentity({
        run: pluginRun,
        kind: "plugin",
        npmDistTag: "extended-stable",
        expectedBranch: branch,
        expectedSha: sha,
      }),
    ).toBe(pluginRun);
    for (const changes of [
      { workflowName: "OpenClaw NPM Release" },
      { displayTitle: `Plugin NPM Release [default] ${sha}` },
      { displayTitle: `Plugin NPM Release [extended-stable] ${"b".repeat(40)}` },
      { status: "in_progress" },
      { conclusion: "failure" },
      { headBranch: "main" },
      { headSha: "b".repeat(40) },
    ]) {
      expect(() =>
        validateExtendedStableRunIdentity({
          run: { ...pluginRun, ...changes },
          kind: "plugin",
          npmDistTag: "extended-stable",
          expectedBranch: branch,
          expectedSha: sha,
        }),
      ).toThrow();
    }
  });

  it.each([
    ["wrong branch", { headBranch: "main" }],
    ["missing branch", { headBranch: undefined }],
    ["wrong SHA", { headSha: "b".repeat(40) }],
    ["missing SHA", { headSha: undefined }],
  ])("rejects %s", (_label, changes) => {
    expect(() =>
      validateExtendedStableRunIdentity({
        run: { ...validPreflight, ...changes },
        kind: "preflight",
        npmDistTag: "extended-stable",
        expectedBranch: branch,
        expectedSha: sha,
      }),
    ).toThrow(/headBranch=.*headSha=/u);
  });
});

describe("Full Validation manifest identity", () => {
  const valid = {
    workflowName: "Full Release Validation",
    workflowRef: branch,
    targetSha: sha,
    runId: "123",
    runAttempt: "2",
  };

  it("accepts the exact branch and target SHA", () => {
    expect(
      validateFullReleaseValidationManifest({
        manifest: valid,
        npmDistTag: "extended-stable",
        expectedWorkflowRef: branch,
        expectedSha: sha,
        expectedRunId: "123",
        expectedRunAttempt: "2",
      }),
    ).toBe(valid);
  });

  it.each([
    ["wrong workflow ref", { workflowRef: "main" }],
    ["missing workflow ref", { workflowRef: undefined }],
    ["wrong target SHA", { targetSha: "b".repeat(40) }],
    ["missing target SHA", { targetSha: undefined }],
    ["wrong run ID", { runId: "124" }],
    ["wrong run attempt", { runAttempt: "1" }],
  ])("rejects %s", (_label, changes) => {
    expect(() =>
      validateFullReleaseValidationManifest({
        manifest: { ...valid, ...changes },
        npmDistTag: "extended-stable",
        expectedWorkflowRef: branch,
        expectedSha: sha,
        expectedRunId: "123",
        expectedRunAttempt: "2",
      }),
    ).toThrow();
  });
});

describe("extended-stable selector capture", () => {
  it("distinguishes bootstrap absence from an existing selector", () => {
    expect(parsePriorExtendedStableSelector('{"latest":"2026.7.1"}')).toBe("absent");
    expect(parsePriorExtendedStableSelector('{"extended-stable":"2026.6.33"}')).toBe("2026.6.33");
  });

  it.each(["not json", "null", "[]", '"2026.6.33"'])("rejects invalid result %s", (value) => {
    expect(() => parsePriorExtendedStableSelector(value)).toThrow();
  });

  it("rejects command failure rather than treating it as bootstrap", () => {
    expect(() =>
      capturePriorExtendedStableSelector({ query: () => ({ status: 1, stdout: "" }) }),
    ).toThrow(/query failed/u);
  });
});

describe("extended-stable registry readback", () => {
  it("accepts eventual convergence and sleeps 10 seconds between attempts", async () => {
    let attempt = 0;
    const sleep = vi.fn(async (_delay: number) => {});
    const result = await verifyExtendedStableRegistryReadback({
      expectedVersion: "2026.6.33",
      query: async (target: string) => {
        if (target === "openclaw@2026.6.33") {
          attempt += 1;
        }
        return { status: 0, stdout: attempt >= 2 ? "2026.6.33\n" : "2026.6.32\n" };
      },
      sleep,
    });
    expect(result).toEqual({
      exactVersion: "2026.6.33",
      extendedStableSelector: "2026.6.33",
      attemptsUsed: 2,
    });
    expect(sleep).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledWith(10_000);
  });

  it("exhausts exactly 12 dual-query attempts on mismatch or failure", async () => {
    const query = vi.fn(async () => ({ status: 1, stdout: "" }));
    const sleep = vi.fn(async (_delay: number) => {});
    await expect(
      verifyExtendedStableRegistryReadback({ expectedVersion: "2026.6.33", query, sleep }),
    ).rejects.toThrow(/after 12 attempts/u);
    expect(query).toHaveBeenCalledTimes(24);
    expect(sleep).toHaveBeenCalledTimes(11);
    expect(sleep.mock.calls.every(([delay]) => delay === 10_000)).toBe(true);
  });
});

describe("extended-stable selector repair", () => {
  it("points the selector at the expected published version", () => {
    expect(extendedStableSelectorRepairCommand("v2026.6.33")).toBe(
      "npm dist-tag add openclaw@2026.6.33 extended-stable",
    );
  });

  it.each([undefined, "absent", "2026.6.33-beta.1", "2026.6.33-1"])(
    "rejects an invalid expected version: %s",
    (expectedVersion) => {
      expect(() => extendedStableSelectorRepairCommand(expectedVersion)).toThrow(
        "Extended-stable selector repair requires an exact final YYYY.M.P version.",
      );
    },
  );
});
