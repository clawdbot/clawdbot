/** Tests plugin version drift detection between package, manifest, and install records. */
import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { fetchNpmPackageTargetStatus } from "../infra/update-check-package-target.js";
import {
  detectPluginVersionDrift,
  resolvePluginVersionDriftUpdateCommand,
  resolvePluginVersionDriftTargets,
} from "./plugin-version-drift.js";

vi.mock("../infra/update-check-package-target.js", () => ({
  fetchNpmPackageTargetStatus: vi.fn(),
}));

function npmRecord(
  version: string,
  overrides: Partial<PluginInstallRecord> = {},
): PluginInstallRecord {
  const resolvedName = overrides.resolvedName ?? "@openclaw/whatsapp";
  return {
    source: "npm",
    spec: `${resolvedName}@latest`,
    resolvedName,
    resolvedVersion: version,
    ...overrides,
  };
}

function clawhubRecord(
  version: string,
  overrides: Partial<PluginInstallRecord> = {},
): PluginInstallRecord {
  return {
    source: "clawhub",
    spec: "clawhub:@openclaw/whatsapp",
    clawhubPackage: "@openclaw/whatsapp",
    resolvedVersion: version,
    ...overrides,
  };
}

function resolvedNpmTarget(packageName: string, target: string, version = target) {
  return {
    targetResolution: {
      status: "resolved" as const,
      packageName,
      requestedTarget: target,
      version,
    },
  };
}

describe("detectPluginVersionDrift", () => {
  it("returns empty drifts when all externalized plugins match the gateway", () => {
    const result = detectPluginVersionDrift({
      gatewayVersion: "2026.5.4",
      installRecords: {
        whatsapp: npmRecord("2026.5.4"),
        discord: npmRecord("2026.5.4", { resolvedName: "@openclaw/discord" }),
      },
    });

    expect(result.drifts).toEqual([]);
    expect(result.gatewayVersion).toBe("2026.5.4");
  });

  it("reports plugins whose installed version does not match the gateway", () => {
    const result = detectPluginVersionDrift({
      gatewayVersion: "2026.5.4",
      installRecords: {
        whatsapp: npmRecord("2026.5.3", {
          resolvedName: "@openclaw/whatsapp",
          spec: "@openclaw/whatsapp@2026.5.3",
        }),
        discord: npmRecord("2026.5.4", { resolvedName: "@openclaw/discord" }),
      },
    });

    expect(result.drifts).toHaveLength(1);
    expect(result.drifts[0]).toEqual({
      pluginId: "whatsapp",
      installedVersion: "2026.5.3",
      gatewayVersion: "2026.5.4",
      source: "npm",
      packageName: "@openclaw/whatsapp",
      spec: "@openclaw/whatsapp@2026.5.3",
    });
  });

  it("treats a build-qualifier suffix on either side as matching (2026.5.4-1 ≈ 2026.5.4)", () => {
    const result = detectPluginVersionDrift({
      gatewayVersion: "2026.5.4-1",
      installRecords: {
        whatsapp: npmRecord("2026.5.4"),
        // ...and the inverse direction
        discord: npmRecord("2026.5.4-1", { resolvedName: "@openclaw/discord" }),
      },
    });

    expect(result.drifts).toEqual([]);
  });

  it("includes ClawHub-installed plugins in the drift check", () => {
    const result = detectPluginVersionDrift({
      gatewayVersion: "2026.5.4",
      installRecords: {
        whatsapp: clawhubRecord("2026.5.3"),
      },
    });

    expect(result.drifts).toHaveLength(1);
    expect(result.drifts[0]?.source).toBe("clawhub");
  });

  it("includes official ClawHub installs whose catalog entry only declares npm install metadata", () => {
    const result = detectPluginVersionDrift({
      gatewayVersion: "2026.5.4",
      installRecords: {
        discord: clawhubRecord("2026.5.3", {
          spec: "clawhub:@openclaw/discord",
          clawhubPackage: "@openclaw/discord",
          clawhubChannel: "official",
          clawhubUrl: "https://clawhub.ai",
        }),
      },
    });

    expect(result.drifts.map((d) => d.pluginId)).toEqual(["discord"]);
  });

  it("ignores community npm installs without an official lockstep contract", () => {
    const result = detectPluginVersionDrift({
      gatewayVersion: "2026.5.4",
      installRecords: {
        community: npmRecord("1.2.3", {
          resolvedName: "community-plugin",
          spec: "community-plugin@1.2.3",
        }),
      },
    });

    expect(result.drifts).toEqual([]);
  });

  it("ignores community ClawHub installs without an official lockstep contract", () => {
    const result = detectPluginVersionDrift({
      gatewayVersion: "2026.5.4",
      installRecords: {
        community: clawhubRecord("1.2.3", {
          spec: "clawhub:community-plugin@1.2.3",
          clawhubPackage: "community-plugin",
        }),
      },
    });

    expect(result.drifts).toEqual([]);
  });

  it("ignores official catalog installs pinned to independent package versions", () => {
    const result = detectPluginVersionDrift({
      gatewayVersion: "2026.5.4",
      installRecords: {
        "openclaw-plugin-yuanbao": npmRecord("2.13.1", {
          resolvedName: "openclaw-plugin-yuanbao",
          spec: "openclaw-plugin-yuanbao@2.13.1",
        }),
      },
    });

    expect(result.drifts).toEqual([]);
  });

  it("ignores exact catalog pins even when the pin matches the gateway version", () => {
    const result = detectPluginVersionDrift({
      gatewayVersion: "2026.5.7",
      installRecords: {
        "wecom-openclaw-plugin": npmRecord("2026.5.6", {
          resolvedName: "@wecom/wecom-openclaw-plugin",
          spec: "@wecom/wecom-openclaw-plugin@2026.5.6",
        }),
      },
    });

    expect(result.drifts).toEqual([]);
  });

  it("ignores install sources that are not official external installs", () => {
    const result = detectPluginVersionDrift({
      gatewayVersion: "2026.5.4",
      installRecords: {
        // archive/path/git installs are local artifacts; they pin to whatever
        // the operator chose and should not be flagged on a gateway version
        // bump alone.
        archive: {
          source: "archive",
          resolvedName: "@openclaw/whatsapp",
          resolvedVersion: "2026.5.3",
          spec: "@openclaw/whatsapp@archive",
        },
        local: {
          source: "path",
          resolvedName: "@openclaw/whatsapp",
          resolvedVersion: "2026.5.3",
          spec: "/tmp/local-plugin",
        },
        forked: {
          source: "git",
          resolvedName: "@openclaw/whatsapp",
          resolvedVersion: "2026.5.3",
          spec: "git+ssh://example/forked",
        },
      },
    });

    expect(result.drifts).toEqual([]);
  });

  it("falls back to the install record's `version` field when `resolvedVersion` is absent", () => {
    const result = detectPluginVersionDrift({
      gatewayVersion: "2026.5.4",
      installRecords: {
        whatsapp: {
          source: "npm",
          spec: "@openclaw/whatsapp@latest",
          resolvedName: "@openclaw/whatsapp",
          version: "2026.5.3",
        },
      },
    });

    expect(result.drifts).toHaveLength(1);
    expect(result.drifts[0]?.installedVersion).toBe("2026.5.3");
  });

  it("skips plugins with no recorded version (cannot detect drift)", () => {
    const result = detectPluginVersionDrift({
      gatewayVersion: "2026.5.4",
      installRecords: {
        whatsapp: { source: "npm", spec: "@openclaw/whatsapp@latest" },
      },
    });

    expect(result.drifts).toEqual([]);
  });

  it("skips plugins that are explicitly disabled in config", () => {
    const config: OpenClawConfig = {
      plugins: {
        entries: {
          whatsapp: { enabled: false },
          discord: { enabled: true },
        },
      },
    } as OpenClawConfig;

    const result = detectPluginVersionDrift({
      gatewayVersion: "2026.5.4",
      installRecords: {
        whatsapp: npmRecord("2026.5.3"),
        discord: npmRecord("2026.5.3", { resolvedName: "@openclaw/discord" }),
      },
      config,
    });

    expect(result.drifts.map((d) => d.pluginId)).toEqual(["discord"]);
  });

  it("skips plugins disabled by the global plugin activation policy", () => {
    const config: OpenClawConfig = {
      plugins: {
        enabled: false,
      },
    } as OpenClawConfig;

    const result = detectPluginVersionDrift({
      gatewayVersion: "2026.5.4",
      installRecords: {
        whatsapp: npmRecord("2026.5.3"),
      },
      config,
    });

    expect(result.drifts).toEqual([]);
  });

  it("skips plugins blocked by denylist or restrictive allowlist policy", () => {
    const denied = detectPluginVersionDrift({
      gatewayVersion: "2026.5.4",
      installRecords: {
        whatsapp: npmRecord("2026.5.3"),
      },
      config: {
        plugins: {
          deny: ["whatsapp"],
        },
      } as OpenClawConfig,
    });
    const notAllowed = detectPluginVersionDrift({
      gatewayVersion: "2026.5.4",
      installRecords: {
        whatsapp: npmRecord("2026.5.3"),
      },
      config: {
        plugins: {
          allow: ["discord"],
        },
      } as OpenClawConfig,
    });

    expect(denied.drifts).toEqual([]);
    expect(notAllowed.drifts).toEqual([]);
  });

  it("includes plugins with no entry in config (default-enabled)", () => {
    const config: OpenClawConfig = { plugins: { entries: {} } } as OpenClawConfig;
    const result = detectPluginVersionDrift({
      gatewayVersion: "2026.5.4",
      installRecords: {
        whatsapp: npmRecord("2026.5.3"),
      },
      config,
    });

    expect(result.drifts).toHaveLength(1);
  });

  it("returns drifts sorted by pluginId for deterministic output", () => {
    const result = detectPluginVersionDrift({
      gatewayVersion: "2026.5.4",
      installRecords: {
        whatsapp: npmRecord("2026.5.3"),
        discord: npmRecord("2026.5.3", { resolvedName: "@openclaw/discord" }),
        matrix: npmRecord("2026.5.3", { resolvedName: "@openclaw/matrix" }),
      },
    });

    expect(result.drifts.map((d) => d.pluginId)).toEqual(["discord", "matrix", "whatsapp"]);
  });
});

describe("resolvePluginVersionDriftTargets", () => {
  beforeEach(() => vi.mocked(fetchNpmPackageTargetStatus).mockReset());

  function driftReport(
    gatewayVersion = "2026.7.1-2",
    spec = "@openclaw/brave-plugin@2026.7.1-beta.2",
  ) {
    return detectPluginVersionDrift({
      gatewayVersion,
      installRecords: {
        brave: npmRecord("2026.7.1-beta.2", { resolvedName: "@openclaw/brave-plugin", spec }),
      },
    });
  }

  it("uses the exact published correction-version cohort for a pinned repair", async () => {
    vi.mocked(fetchNpmPackageTargetStatus).mockResolvedValue({
      target: "2026.7.1",
      version: "2026.7.1",
      nodeEngine: null,
    });
    const report = await resolvePluginVersionDriftTargets(driftReport());
    expect(fetchNpmPackageTargetStatus).toHaveBeenCalledWith({
      packageName: "@openclaw/brave-plugin",
      target: "2026.7.1",
    });
    expect(
      resolvePluginVersionDriftUpdateCommand(
        expectDefined(report.drifts[0], "detected plugin drift"),
      ),
    ).toBe("openclaw plugins update @openclaw/brave-plugin@2026.7.1");
  });

  it.each([
    { version: null, error: "HTTP 404" },
    { version: null, error: "TimeoutError: request timed out" },
    { version: null },
    { version: "not-a-version" },
    { version: "2026.7.2" },
    { version: "2026.7.1-2" },
  ])(
    "withholds pinned commands when the requested version is unconfirmed: $version $error",
    async (result) => {
      vi.mocked(fetchNpmPackageTargetStatus).mockResolvedValue({
        target: "2026.7.1",
        nodeEngine: null,
        ...result,
      });
      const report = await resolvePluginVersionDriftTargets(driftReport());
      const entry = expectDefined(report.drifts[0], "detected plugin drift");
      expect(entry.targetResolution).toMatchObject({
        status: "unresolved",
        packageName: "@openclaw/brave-plugin",
        requestedTarget: "2026.7.1",
        error: expect.stringContaining(result.error ?? JSON.stringify(result.version)),
      });
      expect(resolvePluginVersionDriftUpdateCommand(entry)).toBeUndefined();
    },
  );

  it("does not query npm for non-release cohorts or floating installs", async () => {
    const invalid = await resolvePluginVersionDriftTargets(driftReport("unknown"));
    expect(
      resolvePluginVersionDriftUpdateCommand(
        expectDefined(invalid.drifts[0], "invalid-cohort plugin drift"),
      ),
    ).toBeUndefined();
    const floating = await resolvePluginVersionDriftTargets(
      driftReport("2026.7.1", "@openclaw/brave-plugin@latest"),
    );
    expect(
      resolvePluginVersionDriftUpdateCommand(
        expectDefined(floating.drifts[0], "floating plugin drift"),
      ),
    ).toBe("openclaw plugins update brave");
    expect(fetchNpmPackageTargetStatus).not.toHaveBeenCalled();
  });
});

describe("resolvePluginVersionDriftUpdateCommand", () => {
  it("normalizes a gateway correction version for exact npm package targets", () => {
    expect(
      resolvePluginVersionDriftUpdateCommand({
        pluginId: "brave",
        installedVersion: "2026.7.0",
        gatewayVersion: "2026.7.1-2",
        source: "npm",
        packageName: "@openclaw/brave-plugin",
        spec: "@openclaw/brave-plugin@2026.7.0",
        ...resolvedNpmTarget("@openclaw/brave-plugin", "2026.7.1"),
      }),
    ).toBe("openclaw plugins update @openclaw/brave-plugin@2026.7.1");
  });

  it("uses an exact npm package target when the drifted install is pinned", () => {
    expect(
      resolvePluginVersionDriftUpdateCommand({
        pluginId: "brave",
        installedVersion: "2026.6.9",
        gatewayVersion: "2026.6.10-beta.1",
        source: "npm",
        packageName: "@openclaw/brave-plugin",
        spec: "@openclaw/brave-plugin@2026.6.9",
        ...resolvedNpmTarget("@openclaw/brave-plugin", "2026.6.10-beta.1"),
      }),
    ).toBe("openclaw plugins update @openclaw/brave-plugin@2026.6.10-beta.1");
  });

  it("parses the package name from exact npm specs when drift metadata is sparse", () => {
    expect(
      resolvePluginVersionDriftUpdateCommand({
        pluginId: "brave",
        installedVersion: "2026.6.9",
        gatewayVersion: "2026.6.10-beta.1",
        source: "npm",
        spec: "@openclaw/brave-plugin@2026.6.9",
        ...resolvedNpmTarget("@openclaw/brave-plugin", "2026.6.10-beta.1"),
      }),
    ).toBe("openclaw plugins update @openclaw/brave-plugin@2026.6.10-beta.1");
  });

  it("prefers the parsed exact npm spec package over inconsistent drift metadata", () => {
    expect(
      resolvePluginVersionDriftUpdateCommand({
        pluginId: "brave",
        installedVersion: "2026.6.9",
        gatewayVersion: "2026.6.10-beta.1",
        source: "npm",
        packageName: "@openclaw/other-plugin",
        spec: "@openclaw/brave-plugin@2026.6.9",
        ...resolvedNpmTarget("@openclaw/brave-plugin", "2026.6.10-beta.1"),
      }),
    ).toBe("openclaw plugins update @openclaw/brave-plugin@2026.6.10-beta.1");
  });

  it.each([
    {
      pluginId: "codex",
      source: "npm" as const,
      packageName: "@openclaw/codex",
      spec: "@openclaw/codex",
    },
    {
      pluginId: "diagnostics-otel",
      source: "clawhub" as const,
      packageName: "@openclaw/diagnostics-otel",
      spec: "clawhub:@openclaw/diagnostics-otel",
    },
  ])("keeps the repairing plugin-id update for a floating $source install", (entry) => {
    expect(
      resolvePluginVersionDriftUpdateCommand({
        pluginId: entry.pluginId,
        installedVersion: "2026.6.9",
        gatewayVersion: "2026.6.10-beta.1",
        source: entry.source,
        packageName: entry.packageName,
        spec: entry.spec,
      }),
    ).toBe(`openclaw plugins update ${entry.pluginId}`);
  });

  it("does not fabricate a command when an exact npm target was not resolved", () => {
    expect(
      resolvePluginVersionDriftUpdateCommand({
        pluginId: "brave",
        installedVersion: "2026.6.9",
        gatewayVersion: "unknown",
        source: "npm",
        packageName: "@openclaw/brave-plugin",
        spec: "@openclaw/brave-plugin@2026.6.9",
      }),
    ).toBeUndefined();
  });
});
