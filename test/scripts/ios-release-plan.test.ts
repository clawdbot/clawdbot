// iOS release plan tests cover deterministic App Store version and build allocation.
import { describe, expect, it } from "vitest";
import {
  cutIosReleaseChangelog,
  decodeIosAppStoreVersion,
  resolveIosReleasePlan,
  type IosReleasePlanInput,
} from "../../scripts/lib/ios-release-plan.ts";
import { installIosFixtureCleanup, writeIosFixture } from "./ios-version.test-support.ts";

installIosFixtureCleanup();

function input(overrides: Partial<IosReleasePlanInput> = {}): IosReleasePlanInput {
  const rootDir = writeIosFixture({
    packageVersion: "2026.7.2",
    changelog: "# OpenClaw iOS Changelog\n\n## Unreleased\n\nRetry notes.\n",
  });
  return {
    appStoreVersions: [],
    buildUploads: [],
    gatewayVersion: "2026.7.2",
    rootDir,
    ...overrides,
  };
}

describe("resolveIosReleasePlan", () => {
  it("starts a new gateway at revision zero and build one", () => {
    expect(resolveIosReleasePlan(input())).toMatchObject({
      appStoreRevision: 0,
      appStoreVersion: "2026.7.20",
      buildNumber: 1,
      changelogStatus: "needs-cut",
      decision: "new-revision",
    });
  });

  it("treats a legacy released gateway version as consumed revision zero", () => {
    const plan = resolveIosReleasePlan(
      input({
        appStoreVersions: [
          { id: "legacy", state: "READY_FOR_DISTRIBUTION", versionString: "2026.7.2" },
        ],
      }),
    );

    expect(plan).toMatchObject({
      appStoreRevision: 1,
      appStoreVersion: "2026.7.21",
      buildNumber: 1,
      decision: "new-revision",
    });
  });

  it("treats legacy build-upload-only history as consumed revision zero", () => {
    const plan = resolveIosReleasePlan(
      input({
        buildUploads: [
          {
            buildNumber: "4",
            shortVersion: "2026.7.2",
            state: "COMPLETE",
          },
        ],
      }),
    );

    expect(plan).toMatchObject({
      appStoreRevision: 1,
      appStoreVersion: "2026.7.21",
      buildNumber: 1,
      decision: "new-revision",
    });
  });

  it("reuses the one editable revision", () => {
    const plan = resolveIosReleasePlan(
      input({
        appStoreVersions: [
          { id: "editable", state: "PREPARE_FOR_SUBMISSION", versionString: "2026.7.21" },
        ],
      }),
    );

    expect(plan).toMatchObject({
      appStoreRevision: 1,
      appStoreVersionId: "editable",
      appStoreVersionState: "PREPARE_FOR_SUBMISSION",
      decision: "resume-editable",
    });
  });

  it("retries an uploaded but unreleased revision after its version record is removed", () => {
    const plan = resolveIosReleasePlan(
      input({
        appStoreVersions: [
          { id: "legacy", state: "READY_FOR_DISTRIBUTION", versionString: "2026.7.2" },
        ],
        buildUploads: [
          {
            buildNumber: "1",
            shortVersion: "2026.7.21",
            state: "FAILED",
          },
        ],
      }),
    );

    expect(plan).toMatchObject({
      appStoreRevision: 1,
      buildNumber: 2,
      decision: "retry-upload",
    });
  });

  it("rejects multiple upload-only unreleased revisions", () => {
    expect(() =>
      resolveIosReleasePlan(
        input({
          appStoreVersions: [
            { id: "legacy", state: "READY_FOR_DISTRIBUTION", versionString: "2026.7.2" },
          ],
          buildUploads: [
            { buildNumber: "1", shortVersion: "2026.7.21", state: "FAILED" },
            { buildNumber: "1", shortVersion: "2026.7.22", state: "FAILED" },
          ],
        }),
      ),
    ).toThrow("Multiple unreleased App Store build-upload revisions");
  });

  it.each(["AWAITING_UPLOAD", "PROCESSING", "FAILED", "COMPLETE"])(
    "increments after %s build uploads",
    (state) => {
      const plan = resolveIosReleasePlan(
        input({
          appStoreVersions: [
            { id: "editable", state: "READY_FOR_REVIEW", versionString: "2026.7.21" },
          ],
          buildUploads: [
            { buildNumber: "7", shortVersion: "2026.7.21", state },
            { buildNumber: "3", shortVersion: "2026.7.21", state: "COMPLETE" },
          ],
        }),
      );

      expect(plan.buildNumber).toBe(8);
    },
  );

  it("rejects locked and mismatched active versions", () => {
    expect(() =>
      resolveIosReleasePlan(
        input({
          appStoreVersions: [{ id: "locked", state: "IN_REVIEW", versionString: "2026.7.21" }],
        }),
      ),
    ).toThrow("locked in state IN_REVIEW");

    expect(() =>
      resolveIosReleasePlan(
        input({
          appStoreVersions: [
            { id: "other", state: "PREPARE_FOR_SUBMISSION", versionString: "2026.7.30" },
          ],
        }),
      ),
    ).toThrow("does not belong to gateway 2026.7.2");
  });

  it("rejects multiple active versions and unknown upload states", () => {
    expect(() =>
      resolveIosReleasePlan(
        input({
          appStoreVersions: [
            { id: "one", state: "PREPARE_FOR_SUBMISSION", versionString: "2026.7.21" },
            { id: "two", state: "READY_FOR_REVIEW", versionString: "2026.7.22" },
          ],
        }),
      ),
    ).toThrow("multiple active iOS versions");

    expect(() =>
      resolveIosReleasePlan(
        input({
          buildUploads: [{ buildNumber: "1", shortVersion: "2026.7.20", state: "NEW_APPLE_STATE" }],
        }),
      ),
    ).toThrow("Unknown App Store build upload state");
  });

  it("fails after revision 9 is distributed", () => {
    expect(() =>
      resolveIosReleasePlan(
        input({
          appStoreVersions: [
            { id: "last", state: "READY_FOR_DISTRIBUTION", versionString: "2026.7.29" },
          ],
        }),
      ),
    ).toThrow("exhausted App Store revisions 0 through 9");
  });

  it("rejects a planned version older than released history from another gateway", () => {
    expect(() =>
      resolveIosReleasePlan(
        input({
          appStoreVersions: [
            { id: "newer", state: "READY_FOR_DISTRIBUTION", versionString: "2026.7.2" },
          ],
          gatewayVersion: "2026.6.11",
        }),
      ),
    ).toThrow("must be greater than latest released version 2026.7.2");
  });

  it("rejects explicit selections that disagree with remote state", () => {
    expect(() => resolveIosReleasePlan(input({ explicitRevision: 4 }))).toThrow(
      "does not match the deterministic revision 0",
    );
    expect(() => resolveIosReleasePlan(input({ explicitBuildNumber: "4" }))).toThrow(
      "does not match the deterministic next build 1",
    );
  });

  it("decodes only legacy or single-digit revision versions for the selected gateway", () => {
    expect(decodeIosAppStoreVersion("2026.7.2", "2026.7.2")).toEqual({
      legacy: true,
      revision: 0,
    });
    expect(decodeIosAppStoreVersion("2026.7.2", "2026.7.20")).toEqual({
      legacy: false,
      revision: 0,
    });
    expect(decodeIosAppStoreVersion("2026.7.2", "2026.7.21")).toEqual({
      legacy: false,
      revision: 1,
    });
    expect(decodeIosAppStoreVersion("2026.7.2", "2026.7.29")).toEqual({
      legacy: false,
      revision: 9,
    });
    expect(decodeIosAppStoreVersion("2026.7.2", "2026.7.201")).toBeNull();
    expect(decodeIosAppStoreVersion("2026.7.2", "2026.7.30")).toBeNull();
    expect(decodeIosAppStoreVersion("2026.7.3", "2026.7.3")).toBeNull();
    expect(decodeIosAppStoreVersion("2026.7.21", "2026.7.21")).toBeNull();
    expect(decodeIosAppStoreVersion("2026.7.21", "2026.7.210")).toEqual({
      legacy: false,
      revision: 0,
    });
  });

  it("does not mistake an appended version for a future gateway's legacy release", () => {
    const plan = resolveIosReleasePlan(
      input({
        appStoreVersions: [
          { id: "older", state: "READY_FOR_DISTRIBUTION", versionString: "2026.7.21" },
        ],
        gatewayVersion: "2026.7.21",
      }),
    );

    expect(plan).toMatchObject({
      appStoreRevision: 0,
      appStoreVersion: "2026.7.210",
      decision: "new-revision",
    });
  });

  it("requires another cut when retry notes remain Unreleased", () => {
    const rootDir = writeIosFixture({
      packageVersion: "2026.7.2",
      changelog:
        "# OpenClaw iOS Changelog\n\n## Unreleased\n\nRetry notes.\n\n## 2026.7.21\n\nOriginal notes.\n",
    });
    const plan = resolveIosReleasePlan({
      appStoreVersions: [
        { id: "editable", state: "PREPARE_FOR_SUBMISSION", versionString: "2026.7.21" },
      ],
      buildUploads: [],
      gatewayVersion: "2026.7.2",
      rootDir,
    });

    expect(plan.changelogStatus).toBe("needs-cut");
  });
});

describe("cutIosReleaseChangelog", () => {
  it("cuts Unreleased notes into a new exact App Store version section", () => {
    const current =
      "# OpenClaw iOS Changelog\n\n## Unreleased\n\nNew notes.\n\n## 2026.7.2\n\nOld notes.\n";
    const updated = cutIosReleaseChangelog(current, "2026.7.21");

    expect(updated).toContain("## Unreleased\n\n## 2026.7.21\n\nNew notes.");
    expect(updated).toContain("## 2026.7.2\n\nOld notes.");
    expect(cutIosReleaseChangelog(updated, "2026.7.21")).toBe(updated);
  });

  it("merges retry notes into the existing release section", () => {
    const current =
      "# OpenClaw iOS Changelog\n\n## Unreleased\n\nRetry fix.\n\n## 2026.7.21\n\nOriginal notes.\n";
    const updated = cutIosReleaseChangelog(current, "2026.7.21");

    expect(updated).toContain("## 2026.7.21\n\nRetry fix.\n\nOriginal notes.");
  });

  it("preserves an existing release heading suffix", () => {
    const current =
      "# OpenClaw iOS Changelog\n\n## Unreleased\n\nRetry fix.\n\n## 2026.7.21 - 2026-07-23\n\nOriginal notes.\n";
    const updated = cutIosReleaseChangelog(current, "2026.7.21");

    expect(updated).toContain("## 2026.7.21 - 2026-07-23\n\nRetry fix.\n\nOriginal notes.");
  });
});
