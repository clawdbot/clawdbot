import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { createPathResolutionEnv, withEnvAsync } from "../test-utils/env.js";
import { collectPluginsTrustFindings } from "./audit-plugins-trust.js";

const mockChannelPlugins = vi.hoisted(() => [
  {
    id: "discord",
    capabilities: {},
    commands: {},
    config: {
      listAccountIds: () => [],
      resolveAccount: () => null,
    },
  },
]);

const readInstalledPackageVersionMock = vi.hoisted(() =>
  vi.fn(async (dir: string) => {
    if (dir.includes("/extensions/voice-call") || dir.includes("\\extensions\\voice-call")) {
      return "9.9.9";
    }
    if (dir.includes("/hooks/test-hooks") || dir.includes("\\hooks\\test-hooks")) {
      return "8.8.8";
    }
    return undefined;
  }),
);

vi.mock("../infra/package-update-utils.js", () => ({
  readInstalledPackageVersion: readInstalledPackageVersionMock,
}));

vi.mock("../plugins/config-state.js", () => ({
  normalizePluginId: (id: string) => id,
  normalizePluginsConfig: (
    config:
      | {
          allow?: string[];
          deny?: string[];
          enabled?: boolean;
          entries?: Record<string, { enabled?: boolean }>;
        }
      | undefined,
  ) => ({
    allow: config?.allow ?? [],
    deny: config?.deny ?? [],
    enabled: config?.enabled !== false,
    entries: config?.entries ?? {},
  }),
}));

vi.mock("../channels/plugins/index.js", () => ({
  getChannelPlugin: (id: string) => mockChannelPlugins.find((plugin) => plugin.id === id),
  getLoadedChannelPlugin: () => undefined,
  listChannelPlugins: () => mockChannelPlugins,
  normalizeChannelId: (id: unknown) => (typeof id === "string" && id ? id : null),
}));

vi.mock("../channels/read-only-account-inspect.js", () => ({
  inspectReadOnlyChannelAccount: () => null,
}));

vi.mock("../agents/sandbox/config.js", () => ({
  resolveSandboxConfigForAgent: () => ({ mode: "off" }),
}));

vi.mock("../agents/sandbox/tool-policy.js", () => ({
  resolveSandboxToolPolicyForAgent: () => undefined,
}));

vi.mock("../agents/tool-policy-match.js", () => ({
  isToolAllowedByPolicies: (_tool: string, policies: unknown[]) =>
    policies.every((policy) => policy == null),
}));

vi.mock("../agents/tool-policy.js", () => ({
  resolveToolProfilePolicy: (profile: unknown) =>
    profile === "coding" || profile === "minimal" ? {} : undefined,
}));

vi.mock("./audit-tool-policy.js", () => ({
  pickSandboxToolPolicy: () => undefined,
}));

describe("security audit install metadata findings", () => {
  let fixtureRoot = "";
  let sharedInstallMetadataStateDir = "";
  let caseId = 0;

  const makeTmpDir = async (label: string) => {
    const dir = path.join(fixtureRoot, `case-${caseId++}-${label}`);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  };

  const runInstallMetadataAudit = async (cfg: OpenClawConfig, stateDir: string) => {
    return await collectPluginsTrustFindings({ cfg, stateDir });
  };

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-security-install-"));
    sharedInstallMetadataStateDir = path.join(fixtureRoot, "shared-install-metadata-state");
    await fs.mkdir(sharedInstallMetadataStateDir, { recursive: true });
  });

  afterAll(async () => {
    if (fixtureRoot) {
      await fs.rm(fixtureRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("evaluates install metadata findings", async () => {
    const cases: Array<{
      name: string;
      run: () => Promise<Awaited<ReturnType<typeof runInstallMetadataAudit>>>;
      expectedPresent?: readonly string[];
      expectedAbsent?: readonly string[];
    }> = [
      {
        name: "warns on unpinned npm install specs and missing integrity metadata",
        run: async () =>
          runInstallMetadataAudit(
            {
              plugins: {
                installs: {
                  "voice-call": {
                    source: "npm",
                    spec: "@openclaw/voice-call",
                  },
                },
              },
              hooks: {
                internal: {
                  installs: {
                    "test-hooks": {
                      source: "npm",
                      spec: "@openclaw/test-hooks",
                    },
                  },
                },
              },
            },
            sharedInstallMetadataStateDir,
          ),
        expectedPresent: [
          "plugins.installs_unpinned_npm_specs",
          "plugins.installs_missing_integrity",
          "hooks.installs_unpinned_npm_specs",
          "hooks.installs_missing_integrity",
        ],
      },
      {
        name: "does not warn on pinned npm install specs with integrity metadata",
        run: async () =>
          runInstallMetadataAudit(
            {
              plugins: {
                installs: {
                  "voice-call": {
                    source: "npm",
                    spec: "@openclaw/voice-call@1.2.3",
                    integrity: "sha512-plugin",
                  },
                },
              },
              hooks: {
                internal: {
                  installs: {
                    "test-hooks": {
                      source: "npm",
                      spec: "@openclaw/test-hooks@1.2.3",
                      integrity: "sha512-hook",
                    },
                  },
                },
              },
            },
            sharedInstallMetadataStateDir,
          ),
        expectedAbsent: [
          "plugins.installs_unpinned_npm_specs",
          "plugins.installs_missing_integrity",
          "hooks.installs_unpinned_npm_specs",
          "hooks.installs_missing_integrity",
        ],
      },
      {
        name: "warns when install records drift from installed package versions",
        run: async () =>
          runInstallMetadataAudit(
            {
              plugins: {
                installs: {
                  "voice-call": {
                    source: "npm",
                    spec: "@openclaw/voice-call@1.2.3",
                    integrity: "sha512-plugin",
                    resolvedVersion: "1.2.3",
                  },
                },
              },
              hooks: {
                internal: {
                  installs: {
                    "test-hooks": {
                      source: "npm",
                      spec: "@openclaw/test-hooks@1.2.3",
                      integrity: "sha512-hook",
                      resolvedVersion: "1.2.3",
                    },
                  },
                },
              },
            },
            sharedInstallMetadataStateDir,
          ),
        expectedPresent: ["plugins.installs_version_drift", "hooks.installs_version_drift"],
      },
    ];

    for (const testCase of cases) {
      const findings = await testCase.run();
      for (const checkId of testCase.expectedPresent ?? []) {
        expect(
          findings.some((finding) => finding.checkId === checkId && finding.severity === "warn"),
          testCase.name,
        ).toBe(true);
      }
      for (const checkId of testCase.expectedAbsent ?? []) {
        expect(
          findings.some((finding) => finding.checkId === checkId),
          testCase.name,
        ).toBe(false);
      }
    }
  });

  it("evaluates phantom allowlist findings", async () => {
    const bundledStateDir = await makeTmpDir("phantom-bundled-excluded");
    await fs.mkdir(path.join(bundledStateDir, "extensions", "some-installed-plugin"), {
      recursive: true,
    });

    const bundledFindings = await runInstallMetadataAudit(
      {
        plugins: { allow: ["discord", "some-installed-plugin"] },
      },
      bundledStateDir,
    );
    expect(
      bundledFindings.find((finding) => finding.checkId === "plugins.allow_phantom_entries"),
    ).toBeUndefined();

    const reportedStateDir = await makeTmpDir("phantom-reported");
    await fs.mkdir(path.join(reportedStateDir, "extensions", "installed-plugin"), {
      recursive: true,
    });

    const reportedFindings = await runInstallMetadataAudit(
      {
        plugins: { allow: ["installed-plugin", "ghost-plugin-xyz"] },
      },
      reportedStateDir,
    );
    const phantomFinding = reportedFindings.find(
      (finding) => finding.checkId === "plugins.allow_phantom_entries",
    );
    expect(phantomFinding?.severity).toBe("warn");
    expect(phantomFinding?.detail).toContain("ghost-plugin-xyz");
    expect(phantomFinding?.detail).not.toContain("installed-plugin");
  });
});

describe("security audit extension tool reachability findings", () => {
  let fixtureRoot = "";
  let sharedExtensionsStateDir = "";
  let isolatedHome = "";
  let homedirSpy: { mockRestore(): void } | undefined;
  const pathResolutionEnvKeys = [
    "HOME",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "OPENCLAW_HOME",
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_BUNDLED_PLUGINS_DIR",
  ] as const;
  const previousPathResolutionEnv: Partial<Record<(typeof pathResolutionEnvKeys)[number], string>> =
    {};

  const runSharedExtensionsAudit = async (config: OpenClawConfig) => {
    return await collectPluginsTrustFindings({
      cfg: config,
      stateDir: sharedExtensionsStateDir,
    });
  };

  beforeAll(async () => {
    const osModule = await import("node:os");
    const vitestModule = await import("vitest");
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-security-extensions-"));
    isolatedHome = path.join(fixtureRoot, "home");
    const isolatedEnv = createPathResolutionEnv(isolatedHome, { OPENCLAW_HOME: isolatedHome });
    for (const key of pathResolutionEnvKeys) {
      previousPathResolutionEnv[key] = process.env[key];
      const value = isolatedEnv[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    homedirSpy = vitestModule.vi
      .spyOn(osModule.default ?? osModule, "homedir")
      .mockReturnValue(isolatedHome);
    await fs.mkdir(isolatedHome, { recursive: true, mode: 0o700 });
    sharedExtensionsStateDir = path.join(fixtureRoot, "shared-extensions-state");
    await fs.mkdir(path.join(sharedExtensionsStateDir, "extensions", "some-plugin"), {
      recursive: true,
      mode: 0o700,
    });
  });

  afterAll(async () => {
    homedirSpy?.mockRestore();
    for (const key of pathResolutionEnvKeys) {
      const value = previousPathResolutionEnv[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    if (fixtureRoot) {
      await fs.rm(fixtureRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("evaluates extension tool reachability findings", async () => {
    const cases = [
      {
        name: "flags extensions without plugins.allow",
        cfg: {} satisfies OpenClawConfig,
        assert: (findings: Awaited<ReturnType<typeof runSharedExtensionsAudit>>) => {
          expect(
            findings.some(
              (finding) =>
                finding.checkId === "plugins.extensions_no_allowlist" &&
                finding.severity === "warn",
            ),
          ).toBe(true);
        },
      },
      {
        name: "flags enabled extensions when tool policy can expose plugin tools",
        cfg: {
          plugins: { allow: ["some-plugin"] },
        } satisfies OpenClawConfig,
        assert: (findings: Awaited<ReturnType<typeof runSharedExtensionsAudit>>) => {
          expect(
            findings.some(
              (finding) =>
                finding.checkId === "plugins.tools_reachable_permissive_policy" &&
                finding.severity === "warn",
            ),
          ).toBe(true);
        },
      },
      {
        name: "does not flag plugin tool reachability when profile is restrictive",
        cfg: {
          plugins: { allow: ["some-plugin"] },
          tools: { profile: "coding" },
        } satisfies OpenClawConfig,
        assert: (findings: Awaited<ReturnType<typeof runSharedExtensionsAudit>>) => {
          expect(
            findings.some(
              (finding) => finding.checkId === "plugins.tools_reachable_permissive_policy",
            ),
          ).toBe(false);
        },
      },
      {
        name: "flags unallowlisted extensions as warn-level findings when extension inventory exists",
        cfg: {
          channels: {
            discord: { enabled: true, token: "t" },
          },
        } satisfies OpenClawConfig,
        assert: (findings: Awaited<ReturnType<typeof runSharedExtensionsAudit>>) => {
          expect(
            findings.some(
              (finding) =>
                finding.checkId === "plugins.extensions_no_allowlist" &&
                finding.severity === "warn",
            ),
          ).toBe(true);
        },
      },
      {
        name: "treats SecretRef channel credentials as configured for extension allowlist severity",
        cfg: {
          channels: {
            discord: {
              enabled: true,
              token: {
                source: "env",
                provider: "default",
                id: "DISCORD_BOT_TOKEN",
              } as unknown as string,
            },
          },
        } satisfies OpenClawConfig,
        assert: (findings: Awaited<ReturnType<typeof runSharedExtensionsAudit>>) => {
          expect(
            findings.some(
              (finding) =>
                finding.checkId === "plugins.extensions_no_allowlist" &&
                finding.severity === "warn",
            ),
          ).toBe(true);
        },
      },
    ] as const;

    await withEnvAsync(
      {
        DISCORD_BOT_TOKEN: undefined,
        TELEGRAM_BOT_TOKEN: undefined,
        SLACK_BOT_TOKEN: undefined,
        SLACK_APP_TOKEN: undefined,
      },
      async () => {
        for (const testCase of cases) {
          testCase.assert(await runSharedExtensionsAudit(testCase.cfg));
        }
      },
    );
  });
});
