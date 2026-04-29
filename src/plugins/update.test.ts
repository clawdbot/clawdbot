import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bundledPluginRootAt } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { PluginNpmIntegrityDriftParams } from "./install.js";

const APP_ROOT = "/app";

function appBundledPluginRoot(pluginId: string): string {
  return bundledPluginRootAt(APP_ROOT, pluginId);
}

const installPluginFromNpmSpecMock = vi.fn();
const installPluginFromMarketplaceMock = vi.fn();
const installPluginFromClawHubMock = vi.fn();
const resolveBundledPluginSourcesMock = vi.fn();
const runCommandWithTimeoutMock = vi.fn();
const tempDirs: string[] = [];

vi.mock("./install.js", () => ({
  installPluginFromNpmSpec: (...args: unknown[]) => installPluginFromNpmSpecMock(...args),
  resolvePluginInstallDir: (pluginId: string, extensionsDir = "/tmp") =>
    `${extensionsDir}/${pluginId}`,
  PLUGIN_INSTALL_ERROR_CODE: {
    NPM_PACKAGE_NOT_FOUND: "npm_package_not_found",
  },
}));

vi.mock("./marketplace.js", () => ({
  installPluginFromMarketplace: (...args: unknown[]) => installPluginFromMarketplaceMock(...args),
}));

vi.mock("./clawhub.js", () => ({
  installPluginFromClawHub: (...args: unknown[]) => installPluginFromClawHubMock(...args),
}));

vi.mock("./bundled-sources.js", () => ({
  resolveBundledPluginSources: (...args: unknown[]) => resolveBundledPluginSourcesMock(...args),
}));

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: (...args: unknown[]) => runCommandWithTimeoutMock(...args),
}));

vi.resetModules();

const { syncPluginsForUpdateChannel, updateNpmInstalledPlugins } = await import("./update.js");

function createSuccessfulNpmUpdateResult(params?: {
  pluginId?: string;
  targetDir?: string;
  version?: string;
  npmResolution?: {
    name: string;
    version: string;
    resolvedSpec: string;
  };
}) {
  return {
    ok: true,
    pluginId: params?.pluginId ?? "opik-openclaw",
    targetDir: params?.targetDir ?? "/tmp/opik-openclaw",
    version: params?.version ?? "0.2.6",
    extensions: ["index.ts"],
    ...(params?.npmResolution ? { npmResolution: params.npmResolution } : {}),
  };
}

function createNpmInstallConfig(params: {
  pluginId: string;
  spec: string;
  installPath: string;
  integrity?: string;
  shasum?: string;
  resolvedName?: string;
  resolvedSpec?: string;
  resolvedVersion?: string;
}) {
  return {
    plugins: {
      installs: {
        [params.pluginId]: {
          source: "npm" as const,
          spec: params.spec,
          installPath: params.installPath,
          ...(params.integrity ? { integrity: params.integrity } : {}),
          ...(params.shasum ? { shasum: params.shasum } : {}),
          ...(params.resolvedName ? { resolvedName: params.resolvedName } : {}),
          ...(params.resolvedSpec ? { resolvedSpec: params.resolvedSpec } : {}),
          ...(params.resolvedVersion ? { resolvedVersion: params.resolvedVersion } : {}),
        },
      },
    },
  };
}

function createMarketplaceInstallConfig(params: {
  pluginId: string;
  installPath: string;
  marketplaceSource: string;
  marketplacePlugin: string;
  marketplaceName?: string;
}): OpenClawConfig {
  return {
    plugins: {
      installs: {
        [params.pluginId]: {
          source: "marketplace" as const,
          installPath: params.installPath,
          marketplaceSource: params.marketplaceSource,
          marketplacePlugin: params.marketplacePlugin,
          ...(params.marketplaceName ? { marketplaceName: params.marketplaceName } : {}),
        },
      },
    },
  };
}

function createClawHubInstallConfig(params: {
  pluginId: string;
  installPath: string;
  clawhubUrl: string;
  clawhubPackage: string;
  clawhubFamily: "bundle-plugin" | "code-plugin";
  clawhubChannel: "community" | "official" | "private";
}): OpenClawConfig {
  return {
    plugins: {
      installs: {
        [params.pluginId]: {
          source: "clawhub" as const,
          spec: `clawhub:${params.clawhubPackage}`,
          installPath: params.installPath,
          clawhubUrl: params.clawhubUrl,
          clawhubPackage: params.clawhubPackage,
          clawhubFamily: params.clawhubFamily,
          clawhubChannel: params.clawhubChannel,
        },
      },
    },
  };
}

function createBundledPathInstallConfig(params: {
  loadPaths: string[];
  installPath: string;
  sourcePath?: string;
  spec?: string;
}): OpenClawConfig {
  return {
    plugins: {
      load: { paths: params.loadPaths },
      installs: {
        feishu: {
          source: "path",
          sourcePath: params.sourcePath ?? appBundledPluginRoot("feishu"),
          installPath: params.installPath,
          ...(params.spec ? { spec: params.spec } : {}),
        },
      },
    },
  };
}

function createCodexAppServerInstallConfig(params: {
  spec: string;
  resolvedName?: string;
  resolvedSpec?: string;
}) {
  return {
    plugins: {
      installs: {
        "openclaw-codex-app-server": {
          source: "npm" as const,
          spec: params.spec,
          installPath: "/tmp/openclaw-codex-app-server",
          ...(params.resolvedName ? { resolvedName: params.resolvedName } : {}),
          ...(params.resolvedSpec ? { resolvedSpec: params.resolvedSpec } : {}),
        },
      },
    },
  };
}

function createInstalledPackageDir(params: { name?: string; version: string }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-plugin-update-test-"));
  tempDirs.push(dir);
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: params.name ?? "test-plugin", version: params.version }, null, 2),
  );
  return dir;
}

function mockNpmViewMetadata(params: {
  name: string;
  version: string;
  integrity?: string;
  shasum?: string;
}) {
  runCommandWithTimeoutMock.mockResolvedValueOnce({
    code: 0,
    stdout: JSON.stringify({
      name: params.name,
      version: params.version,
      ...(params.integrity ? { "dist.integrity": params.integrity } : {}),
      ...(params.shasum ? { "dist.shasum": params.shasum } : {}),
    }),
    stderr: "",
  });
}

function expectNpmUpdateCall(params: {
  spec: string;
  expectedIntegrity?: string;
  expectedPluginId?: string;
  timeoutMs?: number;
}) {
  expect(installPluginFromNpmSpecMock).toHaveBeenCalledWith(
    expect.objectContaining({
      spec: params.spec,
      expectedIntegrity: params.expectedIntegrity,
      ...(params.expectedPluginId ? { expectedPluginId: params.expectedPluginId } : {}),
      ...(params.timeoutMs ? { timeoutMs: params.timeoutMs } : {}),
    }),
  );
}

function createBundledSource(params?: { pluginId?: string; localPath?: string; npmSpec?: string }) {
  const pluginId = params?.pluginId ?? "feishu";
  return {
    pluginId,
    localPath: params?.localPath ?? appBundledPluginRoot(pluginId),
    npmSpec: params?.npmSpec ?? `@openclaw/${pluginId}`,
  };
}

function mockBundledSources(...sources: ReturnType<typeof createBundledSource>[]) {
  resolveBundledPluginSourcesMock.mockReturnValue(
    new Map(sources.map((source) => [source.pluginId, source])),
  );
}

function expectBundledPathInstall(params: {
  install: Record<string, unknown> | undefined;
  sourcePath: string;
  installPath: string;
  spec?: string;
}) {
  expect(params.install).toMatchObject({
    source: "path",
    sourcePath: params.sourcePath,
    installPath: params.installPath,
    ...(params.spec ? { spec: params.spec } : {}),
  });
}

function expectCodexAppServerInstallState(params: {
  result: Awaited<ReturnType<typeof updateNpmInstalledPlugins>>;
  spec: string;
  version: string;
  resolvedSpec?: string;
}) {
  expect(params.result.config.plugins?.installs?.["openclaw-codex-app-server"]).toMatchObject({
    source: "npm",
    spec: params.spec,
    installPath: "/tmp/openclaw-codex-app-server",
    version: params.version,
    ...(params.resolvedSpec ? { resolvedSpec: params.resolvedSpec } : {}),
  });
}

describe("updateNpmInstalledPlugins", () => {
  beforeEach(() => {
    installPluginFromNpmSpecMock.mockReset();
    installPluginFromMarketplaceMock.mockReset();
    installPluginFromClawHubMock.mockReset();
    resolveBundledPluginSourcesMock.mockReset();
    runCommandWithTimeoutMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    {
      name: "skips integrity drift checks for unpinned npm specs during dry-run updates",
      config: createNpmInstallConfig({
        pluginId: "opik-openclaw",
        spec: "@opik/opik-openclaw",
        integrity: "sha512-old",
        installPath: "/tmp/opik-openclaw",
      }),
      pluginIds: ["opik-openclaw"],
      dryRun: true,
      expectedCall: {
        spec: "@opik/opik-openclaw",
        expectedIntegrity: undefined,
      },
    },
    {
      name: "keeps integrity drift checks for exact-version npm specs during dry-run updates",
      config: createNpmInstallConfig({
        pluginId: "opik-openclaw",
        spec: "@opik/opik-openclaw@0.2.5",
        integrity: "sha512-old",
        installPath: "/tmp/opik-openclaw",
      }),
      pluginIds: ["opik-openclaw"],
      dryRun: true,
      expectedCall: {
        spec: "@opik/opik-openclaw@0.2.5",
        expectedIntegrity: "sha512-old",
      },
    },
    {
      name: "skips recorded integrity checks when an explicit npm version override changes the spec",
      config: createNpmInstallConfig({
        pluginId: "openclaw-codex-app-server",
        spec: "openclaw-codex-app-server@0.2.0-beta.3",
        integrity: "sha512-old",
        installPath: "/tmp/openclaw-codex-app-server",
      }),
      pluginIds: ["openclaw-codex-app-server"],
      specOverrides: {
        "openclaw-codex-app-server": "openclaw-codex-app-server@0.2.0-beta.4",
      },
      installerResult: createSuccessfulNpmUpdateResult({
        pluginId: "openclaw-codex-app-server",
        targetDir: "/tmp/openclaw-codex-app-server",
        version: "0.2.0-beta.4",
      }),
      expectedCall: {
        spec: "openclaw-codex-app-server@0.2.0-beta.4",
        expectedIntegrity: undefined,
      },
    },
  ] as const)(
    "$name",
    async ({ config, pluginIds, dryRun, specOverrides, installerResult, expectedCall }) => {
      installPluginFromNpmSpecMock.mockResolvedValue(
        installerResult ?? createSuccessfulNpmUpdateResult(),
      );

      await updateNpmInstalledPlugins({
        config,
        pluginIds: [...pluginIds],
        ...(dryRun ? { dryRun: true } : {}),
        ...(specOverrides ? { specOverrides } : {}),
      });

      expectNpmUpdateCall(expectedCall);
    },
  );

  it("passes timeout budget to npm plugin metadata checks and installs", async () => {
    const installPath = createInstalledPackageDir({
      name: "@martian-engineering/lossless-claw",
      version: "0.9.0",
    });
    mockNpmViewMetadata({
      name: "@martian-engineering/lossless-claw",
      version: "0.10.0",
      integrity: "sha512-next",
    });
    installPluginFromNpmSpecMock.mockResolvedValue(
      createSuccessfulNpmUpdateResult({
        pluginId: "lossless-claw",
        targetDir: installPath,
        version: "0.10.0",
      }),
    );

    await updateNpmInstalledPlugins({
      config: createNpmInstallConfig({
        pluginId: "lossless-claw",
        spec: "@martian-engineering/lossless-claw",
        installPath,
        resolvedName: "@martian-engineering/lossless-claw",
        resolvedSpec: "@martian-engineering/lossless-claw@0.9.0",
        resolvedVersion: "0.9.0",
      }),
      pluginIds: ["lossless-claw"],
      timeoutMs: 1_800_000,
    });

    const npmViewCall = runCommandWithTimeoutMock.mock.calls.find(
      ([argv]) => Array.isArray(argv) && argv[0] === "npm" && argv[1] === "view",
    );
    expect(npmViewCall?.[1]).toEqual(expect.objectContaining({ timeoutMs: 1_800_000 }));
    expectNpmUpdateCall({
      spec: "@martian-engineering/lossless-claw",
      expectedPluginId: "lossless-claw",
      timeoutMs: 1_800_000,
    });
  });

  it("skips npm reinstall and config rewrite when the installed artifact is unchanged", async () => {
    const installPath = createInstalledPackageDir({
      name: "@martian-engineering/lossless-claw",
      version: "0.9.0",
    });
    mockNpmViewMetadata({
      name: "@martian-engineering/lossless-claw",
      version: "0.9.0",
      integrity: "sha512-same",
      shasum: "same",
    });
    installPluginFromNpmSpecMock.mockRejectedValue(new Error("installer should not run"));
    const config: OpenClawConfig = {
      plugins: {
        installs: {
          "lossless-claw": {
            source: "npm",
            spec: "@martian-engineering/lossless-claw",
            installPath,
            resolvedName: "@martian-engineering/lossless-claw",
            resolvedVersion: "0.9.0",
            resolvedSpec: "@martian-engineering/lossless-claw@0.9.0",
            integrity: "sha512-same",
            shasum: "same",
          },
        },
      },
    };

    const result = await updateNpmInstalledPlugins({
      config,
      pluginIds: ["lossless-claw"],
    });

    expect(runCommandWithTimeoutMock).toHaveBeenCalledWith(
      [
        "npm",
        "view",
        "@martian-engineering/lossless-claw",
        "name",
        "version",
        "dist.integrity",
        "dist.shasum",
        "--json",
      ],
      expect.any(Object),
    );
    expect(installPluginFromNpmSpecMock).not.toHaveBeenCalled();
    expect(result.changed).toBe(false);
    expect(result.config).toBe(config);
    expect(result.outcomes).toEqual([
      {
        pluginId: "lossless-claw",
        status: "unchanged",
        currentVersion: "0.9.0",
        nextVersion: "0.9.0",
        message: "lossless-claw is up to date (0.9.0).",
      },
    ]);
  });

  it("refreshes legacy npm install records before skipping unchanged artifacts", async () => {
    const installPath = createInstalledPackageDir({
      name: "@martian-engineering/lossless-claw",
      version: "0.9.0",
    });
    mockNpmViewMetadata({
      name: "@martian-engineering/lossless-claw",
      version: "0.9.0",
      integrity: "sha512-same",
      shasum: "same",
    });
    installPluginFromNpmSpecMock.mockResolvedValue(
      createSuccessfulNpmUpdateResult({
        pluginId: "lossless-claw",
        targetDir: installPath,
        version: "0.9.0",
        npmResolution: {
          name: "@martian-engineering/lossless-claw",
          version: "0.9.0",
          resolvedSpec: "@martian-engineering/lossless-claw@0.9.0",
        },
      }),
    );

    const result = await updateNpmInstalledPlugins({
      config: createNpmInstallConfig({
        pluginId: "lossless-claw",
        spec: "@martian-engineering/lossless-claw",
        installPath,
      }),
      pluginIds: ["lossless-claw"],
    });

    expect(installPluginFromNpmSpecMock).toHaveBeenCalledTimes(1);
    expect(result.changed).toBe(true);
    expect(result.outcomes[0]).toMatchObject({
      pluginId: "lossless-claw",
      status: "unchanged",
      currentVersion: "0.9.0",
      nextVersion: "0.9.0",
    });
    expect(result.config.plugins?.installs?.["lossless-claw"]).toMatchObject({
      source: "npm",
      resolvedName: "@martian-engineering/lossless-claw",
      resolvedVersion: "0.9.0",
      resolvedSpec: "@martian-engineering/lossless-claw@0.9.0",
    });
  });

  it("expands home-relative install paths before checking installed npm versions", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-plugin-update-home-"));
    tempDirs.push(home);
    const installPath = path.join(home, ".openclaw", "extensions", "lossless-claw");
    fs.mkdirSync(installPath, { recursive: true });
    fs.writeFileSync(
      path.join(installPath, "package.json"),
      JSON.stringify({ name: "@martian-engineering/lossless-claw", version: "0.9.0" }),
    );
    vi.stubEnv("HOME", home);
    mockNpmViewMetadata({
      name: "@martian-engineering/lossless-claw",
      version: "0.9.0",
      integrity: "sha512-same",
      shasum: "same",
    });
    installPluginFromNpmSpecMock.mockRejectedValue(new Error("installer should not run"));

    const result = await updateNpmInstalledPlugins({
      config: createNpmInstallConfig({
        pluginId: "lossless-claw",
        spec: "@martian-engineering/lossless-claw",
        installPath: "~/.openclaw/extensions/lossless-claw",
        resolvedName: "@martian-engineering/lossless-claw",
        resolvedVersion: "0.9.0",
        resolvedSpec: "@martian-engineering/lossless-claw@0.9.0",
        integrity: "sha512-same",
        shasum: "same",
      }),
      pluginIds: ["lossless-claw"],
    });

    expect(installPluginFromNpmSpecMock).not.toHaveBeenCalled();
    expect(result.changed).toBe(false);
    expect(result.outcomes).toEqual([
      expect.objectContaining({
        pluginId: "lossless-claw",
        status: "unchanged",
        currentVersion: "0.9.0",
      }),
    ]);
  });

  it("falls through to npm reinstall when the recorded integrity differs", async () => {
    const installPath = createInstalledPackageDir({
      name: "@martian-engineering/lossless-claw",
      version: "0.9.0",
    });
    mockNpmViewMetadata({
      name: "@martian-engineering/lossless-claw",
      version: "0.9.0",
      integrity: "sha512-new",
    });
    installPluginFromNpmSpecMock.mockResolvedValue(
      createSuccessfulNpmUpdateResult({
        pluginId: "lossless-claw",
        targetDir: installPath,
        version: "0.9.0",
        npmResolution: {
          name: "@martian-engineering/lossless-claw",
          version: "0.9.0",
          resolvedSpec: "@martian-engineering/lossless-claw@0.9.0",
        },
      }),
    );

    const result = await updateNpmInstalledPlugins({
      config: {
        plugins: {
          installs: {
            "lossless-claw": {
              source: "npm",
              spec: "@martian-engineering/lossless-claw",
              installPath,
              resolvedName: "@martian-engineering/lossless-claw",
              resolvedVersion: "0.9.0",
              resolvedSpec: "@martian-engineering/lossless-claw@0.9.0",
              integrity: "sha512-old",
            },
          },
        },
      },
      pluginIds: ["lossless-claw"],
    });

    expect(installPluginFromNpmSpecMock).toHaveBeenCalledTimes(1);
    expect(result.changed).toBe(true);
    expect(result.outcomes[0]).toMatchObject({
      pluginId: "lossless-claw",
      status: "unchanged",
      currentVersion: "0.9.0",
      nextVersion: "0.9.0",
    });
  });

  it("falls through to npm reinstall when metadata probing fails", async () => {
    const warn = vi.fn();
    const installPath = createInstalledPackageDir({
      name: "@martian-engineering/lossless-claw",
      version: "0.9.0",
    });
    runCommandWithTimeoutMock.mockResolvedValueOnce({
      code: 1,
      stdout: "",
      stderr: "registry timeout",
    });
    installPluginFromNpmSpecMock.mockResolvedValue(
      createSuccessfulNpmUpdateResult({
        pluginId: "lossless-claw",
        targetDir: installPath,
        version: "0.9.0",
      }),
    );

    await updateNpmInstalledPlugins({
      config: createNpmInstallConfig({
        pluginId: "lossless-claw",
        spec: "@martian-engineering/lossless-claw",
        installPath,
      }),
      pluginIds: ["lossless-claw"],
      logger: { warn },
    });

    expect(warn).toHaveBeenCalledWith(
      "Could not check lossless-claw before update; falling back to installer path: npm view failed: registry timeout",
    );
    expect(installPluginFromNpmSpecMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      source: "npm",
      config: {
        plugins: {
          entries: {
            demo: {
              enabled: false,
              config: { preserved: true },
            },
          },
          installs: {
            demo: {
              source: "npm" as const,
              spec: "@acme/demo",
              installPath: "/tmp/demo",
              resolvedName: "@acme/demo",
            },
          },
        },
      } satisfies OpenClawConfig,
    },
    {
      source: "ClawHub",
      config: {
        plugins: {
          entries: {
            demo: {
              enabled: false,
              config: { preserved: true },
            },
          },
          installs: {
            demo: {
              source: "clawhub" as const,
              spec: "clawhub:demo",
              installPath: "/tmp/demo",
              clawhubUrl: "https://clawhub.ai",
              clawhubPackage: "demo",
              clawhubFamily: "code-plugin",
              clawhubChannel: "official",
            },
          },
        },
      } satisfies OpenClawConfig,
    },
    {
      source: "marketplace",
      config: {
        plugins: {
          entries: {
            demo: {
              enabled: false,
              config: { preserved: true },
            },
          },
          installs: {
            demo: {
              source: "marketplace" as const,
              installPath: "/tmp/demo",
              marketplaceSource: "acme/plugins",
              marketplacePlugin: "demo",
            },
          },
        },
      } satisfies OpenClawConfig,
    },
  ])("skips disabled $source installs before update network calls", async ({ config }) => {
    installPluginFromNpmSpecMock.mockRejectedValue(new Error("npm installer should not run"));
    installPluginFromClawHubMock.mockRejectedValue(new Error("ClawHub installer should not run"));
    installPluginFromMarketplaceMock.mockRejectedValue(
      new Error("marketplace installer should not run"),
    );

    const result = await updateNpmInstalledPlugins({
      config,
      skipDisabledPlugins: true,
    });

    expect(runCommandWithTimeoutMock).not.toHaveBeenCalled();
    expect(installPluginFromNpmSpecMock).not.toHaveBeenCalled();
    expect(installPluginFromClawHubMock).not.toHaveBeenCalled();
    expect(installPluginFromMarketplaceMock).not.toHaveBeenCalled();
    expect(result.changed).toBe(false);
    expect(result.config).toBe(config);
    expect(result.config.plugins?.installs?.demo).toEqual(config.plugins.installs.demo);
    expect(result.config.plugins?.entries?.demo).toEqual({
      enabled: false,
      config: { preserved: true },
    });
    expect(result.outcomes).toEqual([
      {
        pluginId: "demo",
        status: "skipped",
        message: 'Skipping "demo" (disabled in config).',
      },
    ]);
  });

  it("keeps enabled tracked plugin update failures fatal when disabled skipping is enabled", async () => {
    installPluginFromNpmSpecMock.mockResolvedValue({
      ok: false,
      error: "registry timeout",
    });
    const config = {
      plugins: {
        entries: {
          demo: {
            enabled: true,
          },
        },
        installs: {
          demo: {
            source: "npm" as const,
            spec: "@acme/demo",
            installPath: "/tmp/demo",
          },
        },
      },
    } satisfies OpenClawConfig;

    const result = await updateNpmInstalledPlugins({
      config,
      skipDisabledPlugins: true,
      dryRun: true,
    });

    expect(installPluginFromNpmSpecMock).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: "@acme/demo",
        expectedPluginId: "demo",
        dryRun: true,
      }),
    );
    expect(result.changed).toBe(false);
    expect(result.config).toBe(config);
    expect(result.outcomes).toEqual([
      {
        pluginId: "demo",
        status: "error",
        message: "Failed to check demo: registry timeout",
      },
    ]);
  });

  it("aborts exact pinned npm plugin updates on integrity drift by default", async () => {
    const warn = vi.fn();
    installPluginFromNpmSpecMock.mockImplementation(
      async (params: {
        spec: string;
        onIntegrityDrift?: (drift: PluginNpmIntegrityDriftParams) => boolean | Promise<boolean>;
      }) => {
        const proceed = await params.onIntegrityDrift?.({
          spec: params.spec,
          expectedIntegrity: "sha512-old",
          actualIntegrity: "sha512-new",
          resolution: {
            integrity: "sha512-new",
            resolvedSpec: "@opik/opik-openclaw@0.2.5",
            version: "0.2.5",
          },
        });
        if (proceed === false) {
          return {
            ok: false,
            error: "aborted: npm package integrity drift detected for @opik/opik-openclaw@0.2.5",
          };
        }
        return createSuccessfulNpmUpdateResult();
      },
    );

    const config = createNpmInstallConfig({
      pluginId: "opik-openclaw",
      spec: "@opik/opik-openclaw@0.2.5",
      integrity: "sha512-old",
      installPath: "/tmp/opik-openclaw",
    });
    const result = await updateNpmInstalledPlugins({
      config,
      pluginIds: ["opik-openclaw"],
      logger: { warn },
    });

    expect(warn).toHaveBeenCalledWith(
      'Integrity drift for "opik-openclaw" (@opik/opik-openclaw@0.2.5): expected sha512-old, got sha512-new',
    );
    expect(result.changed).toBe(false);
    expect(result.config).toBe(config);
    expect(result.outcomes).toEqual([
      {
        pluginId: "opik-openclaw",
        status: "error",
        message:
          "Failed to update opik-openclaw: aborted: npm package integrity drift detected for @opik/opik-openclaw@0.2.5",
      },
    ]);
  });

  it.each([
    {
      name: "formats package-not-found updates with a stable message",
      installerResult: {
        ok: false,
        code: "npm_package_not_found",
        error: "Package not found on npm: @openclaw/missing.",
      },
      config: createNpmInstallConfig({
        pluginId: "missing",
        spec: "@openclaw/missing",
        installPath: "/tmp/missing",
      }),
      pluginId: "missing",
      expectedMessage: "Failed to check missing: npm package not found for @openclaw/missing.",
    },
    {
      name: "falls back to raw installer error for unknown error codes",
      installerResult: {
        ok: false,
        code: "invalid_npm_spec",
        error: "unsupported npm spec: github:evil/evil",
      },
      config: createNpmInstallConfig({
        pluginId: "bad",
        spec: "github:evil/evil",
        installPath: "/tmp/bad",
      }),
      pluginId: "bad",
      expectedMessage: "Failed to check bad: unsupported npm spec: github:evil/evil",
    },
  ] as const)("$name", async ({ installerResult, config, pluginId, expectedMessage }) => {
    installPluginFromNpmSpecMock.mockResolvedValue(installerResult);

    const result = await updateNpmInstalledPlugins({
      config,
      pluginIds: [pluginId],
      dryRun: true,
    });

    expect(result.outcomes).toEqual([
      {
        pluginId,
        status: "error",
        message: expectedMessage,
      },
    ]);
  });

  it.each([
    {
      name: "reuses a recorded npm dist-tag spec for id-based updates",
      installerResult: {
        ok: true,
        pluginId: "openclaw-codex-app-server",
        targetDir: "/tmp/openclaw-codex-app-server",
        version: "0.2.0-beta.4",
        extensions: ["index.ts"],
      },
      config: createCodexAppServerInstallConfig({
        spec: "openclaw-codex-app-server@beta",
        resolvedName: "openclaw-codex-app-server",
        resolvedSpec: "openclaw-codex-app-server@0.2.0-beta.3",
      }),
      expectedSpec: "openclaw-codex-app-server@beta",
      expectedVersion: "0.2.0-beta.4",
    },
    {
      name: "uses and persists an explicit npm spec override during updates",
      installerResult: {
        ok: true,
        pluginId: "openclaw-codex-app-server",
        targetDir: "/tmp/openclaw-codex-app-server",
        version: "0.2.0-beta.4",
        extensions: ["index.ts"],
        npmResolution: {
          name: "openclaw-codex-app-server",
          version: "0.2.0-beta.4",
          resolvedSpec: "openclaw-codex-app-server@0.2.0-beta.4",
        },
      },
      config: createCodexAppServerInstallConfig({
        spec: "openclaw-codex-app-server",
      }),
      specOverrides: {
        "openclaw-codex-app-server": "openclaw-codex-app-server@beta",
      },
      expectedSpec: "openclaw-codex-app-server@beta",
      expectedVersion: "0.2.0-beta.4",
      expectedResolvedSpec: "openclaw-codex-app-server@0.2.0-beta.4",
    },
  ] as const)(
    "$name",
    async ({
      installerResult,
      config,
      specOverrides,
      expectedSpec,
      expectedVersion,
      expectedResolvedSpec,
    }) => {
      installPluginFromNpmSpecMock.mockResolvedValue(installerResult);

      const result = await updateNpmInstalledPlugins({
        config,
        pluginIds: ["openclaw-codex-app-server"],
        ...(specOverrides ? { specOverrides } : {}),
      });

      expectNpmUpdateCall({
        spec: expectedSpec,
        expectedPluginId: "openclaw-codex-app-server",
      });
      expectCodexAppServerInstallState({
        result,
        spec: expectedSpec,
        version: expectedVersion,
        ...(expectedResolvedSpec ? { resolvedSpec: expectedResolvedSpec } : {}),
      });
    },
  );

  it("updates ClawHub-installed plugins via recorded package metadata", async () => {
    installPluginFromClawHubMock.mockResolvedValue({
      ok: true,
      pluginId: "demo",
      targetDir: "/tmp/demo",
      version: "1.2.4",
      clawhub: {
        source: "clawhub",
        clawhubUrl: "https://clawhub.ai",
        clawhubPackage: "demo",
        clawhubFamily: "code-plugin",
        clawhubChannel: "official",
        integrity: "sha256-next",
        resolvedAt: "2026-03-22T00:00:00.000Z",
      },
    });

    const result = await updateNpmInstalledPlugins({
      config: createClawHubInstallConfig({
        pluginId: "demo",
        installPath: "/tmp/demo",
        clawhubUrl: "https://clawhub.ai",
        clawhubPackage: "demo",
        clawhubFamily: "code-plugin",
        clawhubChannel: "official",
      }),
      pluginIds: ["demo"],
      timeoutMs: 1_800_000,
    });

    expect(installPluginFromClawHubMock).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: "clawhub:demo",
        baseUrl: "https://clawhub.ai",
        expectedPluginId: "demo",
        mode: "update",
        timeoutMs: 1_800_000,
      }),
    );
    expect(result.config.plugins?.installs?.demo).toMatchObject({
      source: "clawhub",
      spec: "clawhub:demo",
      installPath: "/tmp/demo",
      version: "1.2.4",
      clawhubPackage: "demo",
      clawhubFamily: "code-plugin",
      clawhubChannel: "official",
      integrity: "sha256-next",
    });
  });

  it("migrates legacy unscoped install keys when a scoped npm package updates", async () => {
    installPluginFromNpmSpecMock.mockResolvedValue({
      ok: true,
      pluginId: "@openclaw/voice-call",
      targetDir: "/tmp/openclaw-voice-call",
      version: "0.0.2",
      extensions: ["index.ts"],
    });

    const result = await updateNpmInstalledPlugins({
      config: {
        plugins: {
          allow: ["voice-call"],
          deny: ["voice-call"],
          slots: { memory: "voice-call" },
          entries: {
            "voice-call": {
              enabled: false,
              hooks: { allowPromptInjection: false },
            },
          },
          installs: {
            "voice-call": {
              source: "npm",
              spec: "@openclaw/voice-call",
              installPath: "/tmp/voice-call",
            },
          },
        },
      },
      pluginIds: ["voice-call"],
    });

    expect(installPluginFromNpmSpecMock).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: "@openclaw/voice-call",
        expectedPluginId: "voice-call",
      }),
    );
    expect(result.config.plugins?.allow).toEqual(["@openclaw/voice-call"]);
    expect(result.config.plugins?.deny).toEqual(["@openclaw/voice-call"]);
    expect(result.config.plugins?.slots?.memory).toBe("@openclaw/voice-call");
    expect(result.config.plugins?.entries?.["@openclaw/voice-call"]).toEqual({
      enabled: false,
      hooks: { allowPromptInjection: false },
    });
    expect(result.config.plugins?.entries?.["voice-call"]).toBeUndefined();
    expect(result.config.plugins?.installs?.["@openclaw/voice-call"]).toMatchObject({
      source: "npm",
      spec: "@openclaw/voice-call",
      installPath: "/tmp/openclaw-voice-call",
      version: "0.0.2",
    });
    expect(result.config.plugins?.installs?.["voice-call"]).toBeUndefined();
  });

  it("migrates context engine slot when a plugin id changes during update", async () => {
    installPluginFromNpmSpecMock.mockResolvedValue({
      ok: true,
      pluginId: "@openclaw/context-engine",
      targetDir: "/tmp/openclaw-context-engine",
      version: "0.0.2",
      extensions: ["index.ts"],
    });

    const result = await updateNpmInstalledPlugins({
      config: {
        plugins: {
          slots: { contextEngine: "context-engine" },
          installs: {
            "context-engine": {
              source: "npm",
              spec: "@openclaw/context-engine",
              installPath: "/tmp/context-engine",
            },
          },
        },
      } as OpenClawConfig,
      pluginIds: ["context-engine"],
    });

    expect(result.config.plugins?.slots?.contextEngine).toBe("@openclaw/context-engine");
    expect(result.config.plugins?.installs?.["@openclaw/context-engine"]).toMatchObject({
      source: "npm",
      spec: "@openclaw/context-engine",
      installPath: "/tmp/openclaw-context-engine",
      version: "0.0.2",
    });
    expect(result.config.plugins?.installs?.["context-engine"]).toBeUndefined();
  });

  it("checks marketplace installs during dry-run updates", async () => {
    installPluginFromMarketplaceMock.mockResolvedValue({
      ok: true,
      pluginId: "claude-bundle",
      targetDir: "/tmp/claude-bundle",
      version: "1.2.0",
      extensions: ["index.ts"],
      marketplaceSource: "vincentkoc/claude-marketplace",
      marketplacePlugin: "claude-bundle",
    });

    const result = await updateNpmInstalledPlugins({
      config: createMarketplaceInstallConfig({
        pluginId: "claude-bundle",
        installPath: "/tmp/claude-bundle",
        marketplaceSource: "vincentkoc/claude-marketplace",
        marketplacePlugin: "claude-bundle",
      }),
      pluginIds: ["claude-bundle"],
      timeoutMs: 1_800_000,
      dryRun: true,
    });

    expect(installPluginFromMarketplaceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        marketplace: "vincentkoc/claude-marketplace",
        plugin: "claude-bundle",
        expectedPluginId: "claude-bundle",
        dryRun: true,
        timeoutMs: 1_800_000,
      }),
    );
    expect(result.outcomes).toEqual([
      {
        pluginId: "claude-bundle",
        status: "updated",
        currentVersion: undefined,
        nextVersion: "1.2.0",
        message: "Would update claude-bundle: unknown -> 1.2.0.",
      },
    ]);
  });

  it("updates marketplace installs and preserves source metadata", async () => {
    installPluginFromMarketplaceMock.mockResolvedValue({
      ok: true,
      pluginId: "claude-bundle",
      targetDir: "/tmp/claude-bundle",
      version: "1.3.0",
      extensions: ["index.ts"],
      marketplaceName: "Vincent's Claude Plugins",
      marketplaceSource: "vincentkoc/claude-marketplace",
      marketplacePlugin: "claude-bundle",
    });

    const result = await updateNpmInstalledPlugins({
      config: createMarketplaceInstallConfig({
        pluginId: "claude-bundle",
        installPath: "/tmp/claude-bundle",
        marketplaceName: "Vincent's Claude Plugins",
        marketplaceSource: "vincentkoc/claude-marketplace",
        marketplacePlugin: "claude-bundle",
      }),
      pluginIds: ["claude-bundle"],
    });

    expect(result.changed).toBe(true);
    expect(result.config.plugins?.installs?.["claude-bundle"]).toMatchObject({
      source: "marketplace",
      installPath: "/tmp/claude-bundle",
      version: "1.3.0",
      marketplaceName: "Vincent's Claude Plugins",
      marketplaceSource: "vincentkoc/claude-marketplace",
      marketplacePlugin: "claude-bundle",
    });
  });

  it("forwards dangerous force unsafe install to plugin update installers", async () => {
    installPluginFromNpmSpecMock.mockResolvedValue(
      createSuccessfulNpmUpdateResult({
        pluginId: "openclaw-codex-app-server",
        targetDir: "/tmp/openclaw-codex-app-server",
        version: "0.2.0-beta.4",
      }),
    );

    await updateNpmInstalledPlugins({
      config: createCodexAppServerInstallConfig({
        spec: "openclaw-codex-app-server@beta",
      }),
      pluginIds: ["openclaw-codex-app-server"],
      dangerouslyForceUnsafeInstall: true,
    });

    expect(installPluginFromNpmSpecMock).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: "openclaw-codex-app-server@beta",
        dangerouslyForceUnsafeInstall: true,
        expectedPluginId: "openclaw-codex-app-server",
      }),
    );
  });

  it("reuses the recorded managed extensions root when updating external plugins", async () => {
    const installPath = "/var/openclaw/extensions/demo";
    const extensionsDir = "/var/openclaw/extensions";
    installPluginFromNpmSpecMock.mockResolvedValue(
      createSuccessfulNpmUpdateResult({
        pluginId: "demo",
        targetDir: installPath,
        version: "1.2.0",
      }),
    );
    installPluginFromClawHubMock.mockResolvedValue({
      ok: true,
      pluginId: "demo",
      targetDir: installPath,
      version: "1.2.0",
      extensions: ["index.ts"],
      clawhub: {
        source: "clawhub",
        clawhubUrl: "https://clawhub.ai",
        clawhubPackage: "demo",
        clawhubFamily: "code-plugin",
        clawhubChannel: "official",
        integrity: "sha256-next",
        resolvedAt: "2026-03-22T00:00:00.000Z",
      },
    });
    installPluginFromMarketplaceMock.mockResolvedValue({
      ok: true,
      pluginId: "demo",
      targetDir: installPath,
      version: "1.2.0",
      extensions: ["index.ts"],
      marketplaceSource: "acme/plugins",
      marketplacePlugin: "demo",
    });

    await updateNpmInstalledPlugins({
      config: createNpmInstallConfig({
        pluginId: "demo",
        spec: "@acme/demo",
        installPath,
      }),
      pluginIds: ["demo"],
    });
    await updateNpmInstalledPlugins({
      config: createClawHubInstallConfig({
        pluginId: "demo",
        installPath,
        clawhubUrl: "https://clawhub.ai",
        clawhubPackage: "demo",
        clawhubFamily: "code-plugin",
        clawhubChannel: "official",
      }),
      pluginIds: ["demo"],
    });
    await updateNpmInstalledPlugins({
      config: createMarketplaceInstallConfig({
        pluginId: "demo",
        installPath,
        marketplaceSource: "acme/plugins",
        marketplacePlugin: "demo",
      }),
      pluginIds: ["demo"],
    });

    expect(installPluginFromNpmSpecMock).toHaveBeenCalledWith(
      expect.objectContaining({ extensionsDir }),
    );
    expect(installPluginFromClawHubMock).toHaveBeenCalledWith(
      expect.objectContaining({ extensionsDir }),
    );
    expect(installPluginFromMarketplaceMock).toHaveBeenCalledWith(
      expect.objectContaining({ extensionsDir }),
    );
  });
});

describe("syncPluginsForUpdateChannel", () => {
  beforeEach(() => {
    installPluginFromNpmSpecMock.mockReset();
    resolveBundledPluginSourcesMock.mockReset();
  });

  it.each([
    {
      name: "keeps bundled path installs on beta without reinstalling from npm",
      config: createBundledPathInstallConfig({
        loadPaths: [appBundledPluginRoot("feishu")],
        installPath: appBundledPluginRoot("feishu"),
        spec: "@openclaw/feishu",
      }),
      expectedChanged: false,
      expectedLoadPaths: [appBundledPluginRoot("feishu")],
      expectedInstallPath: appBundledPluginRoot("feishu"),
    },
    {
      name: "repairs bundled install metadata when the load path is re-added",
      config: createBundledPathInstallConfig({
        loadPaths: [],
        installPath: "/tmp/old-feishu",
        spec: "@openclaw/feishu",
      }),
      expectedChanged: true,
      expectedLoadPaths: [appBundledPluginRoot("feishu")],
      expectedInstallPath: appBundledPluginRoot("feishu"),
    },
  ] as const)(
    "$name",
    async ({ config, expectedChanged, expectedLoadPaths, expectedInstallPath }) => {
      mockBundledSources(createBundledSource());

      const result = await syncPluginsForUpdateChannel({
        channel: "beta",
        config,
      });

      expect(installPluginFromNpmSpecMock).not.toHaveBeenCalled();
      expect(result.changed).toBe(expectedChanged);
      expect(result.summary.switchedToNpm).toEqual([]);
      expect(result.config.plugins?.load?.paths).toEqual(expectedLoadPaths);
      expectBundledPathInstall({
        install: result.config.plugins?.installs?.feishu,
        sourcePath: appBundledPluginRoot("feishu"),
        installPath: expectedInstallPath,
        spec: "@openclaw/feishu",
      });
    },
  );

  it("forwards an explicit env to bundled plugin source resolution", async () => {
    resolveBundledPluginSourcesMock.mockReturnValue(new Map());
    const env = { OPENCLAW_HOME: "/srv/openclaw-home" } as NodeJS.ProcessEnv;

    await syncPluginsForUpdateChannel({
      channel: "beta",
      config: {},
      workspaceDir: "/workspace",
      env,
    });

    expect(resolveBundledPluginSourcesMock).toHaveBeenCalledWith({
      workspaceDir: "/workspace",
      env,
    });
  });

  it("uses the provided env when matching bundled load and install paths", async () => {
    const bundledHome = "/tmp/openclaw-home";
    mockBundledSources(
      createBundledSource({
        localPath: `${bundledHome}/plugins/feishu`,
      }),
    );

    const previousHome = process.env.HOME;
    process.env.HOME = "/tmp/process-home";
    try {
      const result = await syncPluginsForUpdateChannel({
        channel: "beta",
        env: {
          ...process.env,
          OPENCLAW_HOME: bundledHome,
          HOME: "/tmp/ignored-home",
        },
        config: {
          plugins: {
            load: { paths: ["~/plugins/feishu"] },
            installs: {
              feishu: {
                source: "path",
                sourcePath: "~/plugins/feishu",
                installPath: "~/plugins/feishu",
                spec: "@openclaw/feishu",
              },
            },
          },
        },
      });

      expect(result.changed).toBe(false);
      expect(result.config.plugins?.load?.paths).toEqual(["~/plugins/feishu"]);
      expectBundledPathInstall({
        install: result.config.plugins?.installs?.feishu,
        sourcePath: "~/plugins/feishu",
        installPath: "~/plugins/feishu",
      });
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
    }
  });

  it("installs an externalized bundled plugin and rewrites its old bundled path plugin index", async () => {
    resolveBundledPluginSourcesMock.mockReturnValue(new Map());
    installPluginFromNpmSpecMock.mockResolvedValue(
      createSuccessfulNpmUpdateResult({
        pluginId: "legacy-chat",
        targetDir: "/tmp/openclaw-plugins/legacy-chat",
        version: "2.0.0",
        npmResolution: {
          name: "@openclaw/legacy-chat",
          version: "2.0.0",
          resolvedSpec: "@openclaw/legacy-chat@2.0.0",
        },
      }),
    );

    const result = await syncPluginsForUpdateChannel({
      channel: "stable",
      externalizedBundledPluginBridges: [
        {
          bundledPluginId: "legacy-chat",
          npmSpec: "@openclaw/legacy-chat",
          channelIds: ["legacy-chat"],
        },
      ],
      config: {
        channels: {
          "legacy-chat": {
            enabled: true,
          },
        },
        plugins: {
          load: { paths: [appBundledPluginRoot("legacy-chat")] },
          installs: {
            "legacy-chat": {
              source: "path",
              sourcePath: appBundledPluginRoot("legacy-chat"),
              installPath: appBundledPluginRoot("legacy-chat"),
            },
          },
        },
      },
    });

    expect(installPluginFromNpmSpecMock).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: "@openclaw/legacy-chat",
        mode: "update",
        expectedPluginId: "legacy-chat",
      }),
    );
    expect(result.changed).toBe(true);
    expect(result.summary.switchedToNpm).toEqual(["legacy-chat"]);
    expect(result.summary.errors).toEqual([]);
    expect(result.config.plugins?.load?.paths).toEqual([]);
    expect(result.config.plugins?.installs?.["legacy-chat"]).toMatchObject({
      source: "npm",
      spec: "@openclaw/legacy-chat",
      installPath: "/tmp/openclaw-plugins/legacy-chat",
      version: "2.0.0",
      resolvedName: "@openclaw/legacy-chat",
      resolvedVersion: "2.0.0",
      resolvedSpec: "@openclaw/legacy-chat@2.0.0",
    });
  });

  it("externalizes bundled plugins that were enabled by default", async () => {
    resolveBundledPluginSourcesMock.mockReturnValue(new Map());
    installPluginFromNpmSpecMock.mockResolvedValue(
      createSuccessfulNpmUpdateResult({
        pluginId: "default-chat",
        targetDir: "/tmp/openclaw-plugins/default-chat",
        version: "2.0.0",
      }),
    );

    const result = await syncPluginsForUpdateChannel({
      channel: "stable",
      externalizedBundledPluginBridges: [
        {
          bundledPluginId: "default-chat",
          enabledByDefault: true,
          npmSpec: "@openclaw/default-chat",
          channelIds: ["default-chat"],
        },
      ],
      config: {},
    });

    expect(installPluginFromNpmSpecMock).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: "@openclaw/default-chat",
        mode: "update",
        expectedPluginId: "default-chat",
      }),
    );
    expect(result.changed).toBe(true);
    expect(result.summary.switchedToNpm).toEqual(["default-chat"]);
    expect(result.config.plugins?.installs?.["default-chat"]).toMatchObject({
      source: "npm",
      spec: "@openclaw/default-chat",
      installPath: "/tmp/openclaw-plugins/default-chat",
      version: "2.0.0",
    });
  });

  it("does not externalize disabled bundled plugins", async () => {
    resolveBundledPluginSourcesMock.mockReturnValue(new Map());

    const result = await syncPluginsForUpdateChannel({
      channel: "stable",
      externalizedBundledPluginBridges: [
        {
          bundledPluginId: "legacy-chat",
          npmSpec: "@openclaw/legacy-chat",
          channelIds: ["legacy-chat"],
        },
      ],
      config: {
        plugins: {
          entries: {
            "legacy-chat": {
              enabled: false,
            },
          },
          load: { paths: [appBundledPluginRoot("legacy-chat")] },
          installs: {
            "legacy-chat": {
              source: "path",
              sourcePath: appBundledPluginRoot("legacy-chat"),
              installPath: appBundledPluginRoot("legacy-chat"),
            },
          },
        },
      },
    });

    expect(installPluginFromNpmSpecMock).not.toHaveBeenCalled();
    expect(result.changed).toBe(false);
    expect(result.config.plugins?.installs?.["legacy-chat"]).toMatchObject({
      source: "path",
    });
  });

  it("leaves config unchanged when externalized plugin installation fails", async () => {
    resolveBundledPluginSourcesMock.mockReturnValue(new Map());
    installPluginFromNpmSpecMock.mockResolvedValue({
      ok: false,
      error: "package unavailable",
    });
    const config: OpenClawConfig = {
      channels: {
        "legacy-chat": {
          enabled: true,
        },
      },
      plugins: {
        load: { paths: [appBundledPluginRoot("legacy-chat")] },
        installs: {
          "legacy-chat": {
            source: "path",
            sourcePath: appBundledPluginRoot("legacy-chat"),
            installPath: appBundledPluginRoot("legacy-chat"),
          },
        },
      },
    };

    const result = await syncPluginsForUpdateChannel({
      channel: "stable",
      externalizedBundledPluginBridges: [
        {
          bundledPluginId: "legacy-chat",
          npmSpec: "@openclaw/legacy-chat",
          channelIds: ["legacy-chat"],
        },
      ],
      config,
    });

    expect(result.changed).toBe(false);
    expect(result.config).toBe(config);
    expect(result.summary.errors).toEqual(["Failed to update legacy-chat: package unavailable"]);
  });

  it("does not externalize custom local path installs that only share the old plugin id", async () => {
    resolveBundledPluginSourcesMock.mockReturnValue(new Map());

    const result = await syncPluginsForUpdateChannel({
      channel: "stable",
      externalizedBundledPluginBridges: [
        {
          bundledPluginId: "legacy-chat",
          npmSpec: "@openclaw/legacy-chat",
          channelIds: ["legacy-chat"],
        },
      ],
      config: {
        channels: {
          "legacy-chat": {
            enabled: true,
          },
        },
        plugins: {
          load: { paths: ["/workspace/plugins/legacy-chat"] },
          installs: {
            "legacy-chat": {
              source: "path",
              sourcePath: "/workspace/plugins/legacy-chat",
              installPath: "/workspace/plugins/legacy-chat",
            },
          },
        },
      },
    });

    expect(installPluginFromNpmSpecMock).not.toHaveBeenCalled();
    expect(result.changed).toBe(false);
    expect(result.config.plugins?.installs?.["legacy-chat"]).toMatchObject({
      source: "path",
      sourcePath: "/workspace/plugins/legacy-chat",
    });
  });

  it("does not externalize while the bundled source is still present in the current build", async () => {
    mockBundledSources(
      createBundledSource({
        pluginId: "legacy-chat",
        localPath: appBundledPluginRoot("legacy-chat"),
      }),
    );

    const result = await syncPluginsForUpdateChannel({
      channel: "stable",
      externalizedBundledPluginBridges: [
        {
          bundledPluginId: "legacy-chat",
          npmSpec: "@openclaw/legacy-chat",
          channelIds: ["legacy-chat"],
        },
      ],
      config: {
        channels: {
          "legacy-chat": {
            enabled: true,
          },
        },
        plugins: {
          load: { paths: [appBundledPluginRoot("legacy-chat")] },
          installs: {
            "legacy-chat": {
              source: "path",
              sourcePath: appBundledPluginRoot("legacy-chat"),
              installPath: appBundledPluginRoot("legacy-chat"),
            },
          },
        },
      },
    });

    expect(installPluginFromNpmSpecMock).not.toHaveBeenCalled();
    expect(result.changed).toBe(false);
    expect(result.config.plugins?.installs?.["legacy-chat"]).toMatchObject({
      source: "path",
    });
  });

  it("removes stale bundled load paths for already-externalized npm installs", async () => {
    resolveBundledPluginSourcesMock.mockReturnValue(new Map());

    const result = await syncPluginsForUpdateChannel({
      channel: "stable",
      externalizedBundledPluginBridges: [
        {
          bundledPluginId: "legacy-chat",
          npmSpec: "@openclaw/legacy-chat",
          channelIds: ["legacy-chat"],
        },
      ],
      config: {
        channels: {
          "legacy-chat": {
            enabled: true,
          },
        },
        plugins: {
          load: {
            paths: [appBundledPluginRoot("legacy-chat"), "/workspace/plugins/other"],
          },
          installs: {
            "legacy-chat": {
              source: "npm",
              spec: "@openclaw/legacy-chat",
              installPath: "/tmp/openclaw-plugins/legacy-chat",
            },
          },
        },
      },
    });

    expect(installPluginFromNpmSpecMock).not.toHaveBeenCalled();
    expect(result.changed).toBe(true);
    expect(result.config.plugins?.load?.paths).toEqual(["/workspace/plugins/other"]);
    expect(result.config.plugins?.installs?.["legacy-chat"]).toMatchObject({
      source: "npm",
      spec: "@openclaw/legacy-chat",
    });
  });
});
