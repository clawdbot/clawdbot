// Covers plugin install record normalization and config interactions.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildNpmResolutionInstallFields,
  recordPluginInstall,
  resolveNpmInstallRecordSpec,
} from "./installs.js";

function expectRecordedInstall(pluginId: string, next: ReturnType<typeof recordPluginInstall>) {
  expect(next).toEqual({
    plugins: {
      installs: {
        [pluginId]: {
          source: "npm",
          spec: `${pluginId}@latest`,
          installedAt: "2026-05-11T04:00:00.000Z",
        },
      },
    },
  });
}

function createExpectedResolutionFields(
  overrides: Partial<ReturnType<typeof buildNpmResolutionInstallFields>>,
) {
  return {
    resolvedName: undefined,
    resolvedVersion: undefined,
    resolvedSpec: undefined,
    integrity: undefined,
    shasum: undefined,
    resolvedAt: undefined,
    ...overrides,
  };
}

function expectResolutionFieldsCase(params: {
  input: Parameters<typeof buildNpmResolutionInstallFields>[0];
  expected: ReturnType<typeof buildNpmResolutionInstallFields>;
}) {
  expect(buildNpmResolutionInstallFields(params.input)).toEqual(params.expected);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("buildNpmResolutionInstallFields", () => {
  it.each([
    {
      name: "maps npm resolution metadata into install record fields",
      input: {
        name: "@openclaw/demo",
        version: "1.2.3",
        resolvedSpec: "@openclaw/demo@1.2.3",
        integrity: "sha512-abc",
        shasum: "deadbeef",
        resolvedAt: "2026-02-22T00:00:00.000Z",
      },
      expected: createExpectedResolutionFields({
        resolvedName: "@openclaw/demo",
        resolvedVersion: "1.2.3",
        resolvedSpec: "@openclaw/demo@1.2.3",
        integrity: "sha512-abc",
        shasum: "deadbeef",
        resolvedAt: "2026-02-22T00:00:00.000Z",
      }),
    },
    {
      name: "returns undefined fields when resolution is missing",
      input: undefined,
      expected: createExpectedResolutionFields({}),
    },
    {
      name: "keeps missing partial resolution fields undefined",
      input: {
        name: "@openclaw/demo",
      },
      expected: createExpectedResolutionFields({
        resolvedName: "@openclaw/demo",
      }),
    },
  ] as const)("$name", expectResolutionFieldsCase);
});

describe("resolveNpmInstallRecordSpec", () => {
  it("uses an exact resolved registry spec when managed installs request pinning", () => {
    expect(
      resolveNpmInstallRecordSpec({
        requestedSpec: "@openclaw/codex",
        resolution: {
          name: "@openclaw/codex",
          version: "2026.5.30-beta.1",
          resolvedSpec: "@openclaw/codex@2026.5.30-beta.1",
        },
        pinResolvedRegistrySpec: true,
      }),
    ).toBe("@openclaw/codex@2026.5.30-beta.1");
  });

  it("keeps moving specs unless the caller owns managed pinning", () => {
    expect(
      resolveNpmInstallRecordSpec({
        requestedSpec: "@openclaw/codex",
        resolution: {
          name: "@openclaw/codex",
          version: "2026.5.30-beta.1",
          resolvedSpec: "@openclaw/codex@2026.5.30-beta.1",
        },
      }),
    ).toBe("@openclaw/codex");
  });

  it("does not replace the requested spec with tags or non-registry resolutions", () => {
    expect(
      resolveNpmInstallRecordSpec({
        requestedSpec: "@openclaw/codex",
        resolution: {
          name: "@openclaw/codex",
          version: "2026.5.30-beta.1",
          resolvedSpec: "@openclaw/codex@beta",
        },
        pinResolvedRegistrySpec: true,
      }),
    ).toBe("@openclaw/codex");
    expect(
      resolveNpmInstallRecordSpec({
        requestedSpec: "file:codex.tgz",
        resolution: {
          name: "@openclaw/codex",
          version: "2026.5.30-beta.1",
          resolvedSpec: "file:codex.tgz",
        },
        pinResolvedRegistrySpec: true,
      }),
    ).toBe("file:codex.tgz");
  });
});

describe("recordPluginInstall", () => {
  it("stores install metadata for the plugin id", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-11T04:00:00.000Z"));

    const next = recordPluginInstall({}, { pluginId: "demo", source: "npm", spec: "demo@latest" });

    expectRecordedInstall("demo", next);
  });

  it("clears stale ClawHub trust metadata when a later install omits it", () => {
    const existing = recordPluginInstall(
      {},
      {
        pluginId: "demo",
        source: "clawhub",
        spec: "clawhub:demo@1.0.0",
        installPath: "/tmp/openclaw/plugins/demo",
        clawhubUrl: "https://clawhub.ai",
        clawhubPackage: "demo",
        clawhubFamily: "code-plugin",
        clawhubTrustDisposition: "review-required",
        clawhubTrustScanStatus: "suspicious",
        clawhubTrustReasons: ["payload_strings"],
        clawhubTrustPending: true,
        clawhubTrustCheckedAt: "2026-05-14T18:00:00.000Z",
        clawhubTrustAcknowledgedAt: "2026-05-14T18:00:03.000Z",
      },
    );

    const next = recordPluginInstall(existing, {
      pluginId: "demo",
      source: "clawhub",
      spec: "clawhub:demo@1.1.0",
      installPath: "/tmp/openclaw/plugins/demo",
      clawhubUrl: "https://clawhub.ai",
      clawhubPackage: "demo",
      clawhubFamily: "code-plugin",
      clawhubTrustDisposition: "clean",
      clawhubTrustCheckedAt: "2026-05-15T00:00:00.000Z",
      installedAt: "2026-05-15T00:00:03.000Z",
    });

    expect(next.plugins?.installs?.demo).toEqual({
      source: "clawhub",
      spec: "clawhub:demo@1.1.0",
      installPath: "/tmp/openclaw/plugins/demo",
      clawhubUrl: "https://clawhub.ai",
      clawhubPackage: "demo",
      clawhubFamily: "code-plugin",
      clawhubTrustDisposition: "clean",
      clawhubTrustCheckedAt: "2026-05-15T00:00:00.000Z",
      installedAt: "2026-05-15T00:00:03.000Z",
    });
  });

  it("replaces local npm-pack provenance on a registry reinstall", () => {
    const localInstall = recordPluginInstall(
      {},
      {
        pluginId: "diffs",
        source: "npm",
        spec: "/tmp/openclaw-diffs.tgz",
        sourcePath: "/tmp/openclaw-diffs.tgz",
        installPath: "/tmp/openclaw/plugins/diffs-local",
        artifactKind: "npm-pack",
        artifactFormat: "tgz",
        npmTarballName: "openclaw-diffs-1.0.0.tgz",
        installedAt: "2026-05-14T18:00:03.000Z",
      },
    );

    const registryInstall = recordPluginInstall(localInstall, {
      pluginId: "diffs",
      source: "npm",
      spec: "@openclaw/diffs",
      installPath: "/tmp/openclaw/plugins/diffs",
      resolvedName: "@openclaw/diffs",
      resolvedVersion: "1.1.0",
      resolvedSpec: "@openclaw/diffs@1.1.0",
      installedAt: "2026-05-15T00:00:03.000Z",
    });

    expect(registryInstall.plugins?.installs?.diffs).toEqual({
      source: "npm",
      spec: "@openclaw/diffs",
      installPath: "/tmp/openclaw/plugins/diffs",
      resolvedName: "@openclaw/diffs",
      resolvedVersion: "1.1.0",
      resolvedSpec: "@openclaw/diffs@1.1.0",
      installedAt: "2026-05-15T00:00:03.000Z",
    });
  });
});
