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
const installPluginFromGitSpecMock = vi.fn();
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

vi.mock("./git-install.js", () => ({
  installPluginFromGitSpec: (...args: unknown[]) => installPluginFromGitSpecMock(...args),
}));

vi.mock("./marketplace.js", () => ({
  installPluginFromMarketplace: (...args: unknown[]) => installPluginFromMarketplaceMock(...args),
}));

vi.mock("./clawhub.js", () => ({
  CLAWHUB_INSTALL_ERROR_CODE: {
    PACKAGE_NOT_FOUND: "package_not_found",
    VERSION_NOT_FOUND: "version_not_found",
    ARCHIVE_INTEGRITY_MISMATCH: "archive_integrity_mismatch",
  },
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

function createSuccessfulClawHubUpdateResult(params?: {
  pluginId?: string;
  targetDir?: string;
  version?: string;
  clawhubPackage?: string;
}) {
  return {
    ok: true,
    pluginId: params?.pluginId ?? "legacy-chat",
    targetDir: params?.targetDir ?? "/tmp/openclaw-plugins/legacy-chat",
    version: params?.version ?? "2026.5.1-beta.2",
    extensions: ["index.ts"],
    packageName: params?.clawhubPackage ?? "legacy-chat",
    clawhub: {
      source: "clawhub" as const,
      clawhubUrl: "https://clawhub.ai",
      clawhubPackage: params?.clawhubPackage ?? "legacy-chat",
      clawhubFamily: "code-plugin" as const,
      clawhubChannel: "official" as const,
      version: params?.version ?? "2026.5.1-beta.2",
      integrity: "sha256-clawpack",
      resolvedAt: "2026-05-01T00:00:00.000Z",
      artifactKind: "npm-pack" as const,
      artifactFormat: "tgz" as const,
      npmIntegrity: "sha512-clawpack",
      npmShasum: "2".repeat(40),
      npmTarballName: `${params?.clawhubPackage ?? "legacy-chat"}-${params?.version ?? "2026.5.1-beta.2"}.tgz`,
      clawpackSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      clawpackSpecVersion: 1,
      clawpackManifestSha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      clawpackSize: 4096,
    },
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
  spec?: string;
}): OpenClawConfig {
  return {
    plugins: {
      installs: {
        [params.pluginId]: {
          source: "clawhub" as const,
          spec: params.spec ?? `clawhub:${params.clawhubPackage}`,
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

function createGitInstallConfig(params: {
  pluginId: string;
  spec: string;
  installPath: string;
  commit?: string;
}): OpenClawConfig {
  return {
    plugins: {
      installs: {
        [params.pluginId]: {
          source: "git" as const,
          spec: params.spec,
          installPath: params.installPath,
          ...(params.commit ? { gitCommit: params.commit } : {}),
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

function createInstalledPackageDir(params: {
  name?: string;
  version: string;
  peerDependencies?: Record<string, string>;
}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-plugin-update-test-"));
  tempDirs.push(dir);
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify(
      {
        name: params.name ?? "test-plugin",
        version: params.version,
        ...(params.peerDependencies ? { peerDependencies: params.peerDependencies } : {}),
      },
      null,
      2,
    ),
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
    installPluginFromGitSpecMock.mockReset();
    resolveBundledPluginSourcesMock.mockReset();
    resolveBundledPluginSourcesMock.mockReturnValue(new Map());
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

  it("trusts official catalog npm updates when the installed package matches the catalog", async () => {
    const installPath = createInstalledPackageDir({
      name: "@openclaw/acpx",
      version: "2026.5.2-beta.1",
    });
    mockNpmViewMetadata({
      name: "@openclaw/acpx",
      version: "2026.5.2-beta.2",
    });
    installPluginFromNpmSpecMock.mockResolvedValue(
      createSuccessfulNpmUpdateResult({
        pluginId: "acpx",
        targetDir: installPath,
        version: "2026.5.2-beta.2",
      }),
    );

    await updateNpmInstalledPlugins({
      config: createNpmInstallConfig({
        pluginId: "acpx",
        spec: "@openclaw/acpx",
        installPath,
        resolvedName: "@openclaw/acpx",
        resolvedSpec: "@openclaw/acpx@2026.5.2-beta.1",
        resolvedVersion: "2026.5.2-beta.1",
      }),
      pluginIds: ["acpx"],
    });

    expect(installPluginFromNpmSpecMock).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: "@openclaw/acpx",
        expectedPluginId: "acpx",
        trustedSourceLinkedOfficialInstall: true,
      }),
    );
  });

  it("does not skip trusted official default updates when latest resolves to the installed prerelease", async () => {
    const installPath = createInstalledPackageDir({
      name: "@openclaw/acpx",
      version: "2026.5.2-beta.2",
    });
    mockNpmViewMetadata({
      name: "@openclaw/acpx",
      version: "2026.5.2-beta.2",
      integrity: "sha512-beta",
      shasum: "beta",
    });
    installPluginFromNpmSpecMock.mockResolvedValue(
      createSuccessfulNpmUpdateResult({
        pluginId: "acpx",
        targetDir: installPath,
        version: "2026.5.2",
        npmResolution: {
          name: "@openclaw/acpx",
          version: "2026.5.2",
          resolvedSpec: "@openclaw/acpx@2026.5.2",
        },
      }),
    );

    const result = await updateNpmInstalledPlugins({
      config: createNpmInstallConfig({
        pluginId: "acpx",
        spec: "@openclaw/acpx",
        installPath,
        integrity: "sha512-beta",
        shasum: "beta",
        resolvedName: "@openclaw/acpx",
        resolvedSpec: "@openclaw/acpx@2026.5.2-beta.2",
        resolvedVersion: "2026.5.2-beta.2",
      }),
      pluginIds: ["acpx"],
    });

    expect(installPluginFromNpmSpecMock).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: "@openclaw/acpx",
        expectedPluginId: "acpx",
        trustedSourceLinkedOfficialInstall: true,
      }),
    );
    expect(result.outcomes[0]).toMatchObject({
      pluginId: "acpx",
      status: "updated",
      currentVersion: "2026.5.2-beta.2",
      nextVersion: "2026.5.2",
    });
  });

  it("updates trusted official npm plugins when latest resolves to a stable correction release", async () => {
    const installPath = createInstalledPackageDir({
      name: "@openclaw/acpx",
      version: "2026.5.3",
    });
    mockNpmViewMetadata({
      name: "@openclaw/acpx",
      version: "2026.5.3-1",
      integrity: "sha512-correction",
      shasum: "correction",
    });
    installPluginFromNpmSpecMock.mockResolvedValue(
      createSuccessfulNpmUpdateResult({
        pluginId: "acpx",
        targetDir: installPath,
        version: "2026.5.3-1",
        npmResolution: {
          name: "@openclaw/acpx",
          version: "2026.5.3-1",
          resolvedSpec: "@openclaw/acpx@2026.5.3-1",
        },
      }),
    );

    const result = await updateNpmInstalledPlugins({
      config: createNpmInstallConfig({
        pluginId: "acpx",
        spec: "@openclaw/acpx",
        installPath,
        resolvedName: "@openclaw/acpx",
        resolvedSpec: "@openclaw/acpx@2026.5.3",
        resolvedVersion: "2026.5.3",
      }),
      pluginIds: ["acpx"],
    });

    expect(installPluginFromNpmSpecMock).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: "@openclaw/acpx",
        expectedPluginId: "acpx",
        trustedSourceLinkedOfficialInstall: true,
      }),
    );
    expect(result.outcomes[0]).toMatchObject({
      pluginId: "acpx",
      status: "updated",
      currentVersion: "2026.5.3",
      nextVersion: "2026.5.3-1",
    });
  });

  it("does not trust official npm updates when the install record package mismatches", async () => {
    const installPath = createInstalledPackageDir({
      name: "@vendor/acpx-fork",
      version: "1.0.0",
    });
    mockNpmViewMetadata({
      name: "@vendor/acpx-fork",
      version: "1.0.1",
    });
    installPluginFromNpmSpecMock.mockResolvedValue(
      createSuccessfulNpmUpdateResult({
        pluginId: "acpx",
        targetDir: installPath,
        version: "1.0.1",
      }),
    );

    await updateNpmInstalledPlugins({
      config: createNpmInstallConfig({
        pluginId: "acpx",
        spec: "@vendor/acpx-fork",
        installPath,
        resolvedName: "@vendor/acpx-fork",
        resolvedSpec: "@vendor/acpx-fork@1.0.0",
        resolvedVersion: "1.0.0",
      }),
      pluginIds: ["acpx"],
    });

    expect(installPluginFromNpmSpecMock).toHaveBeenCalledWith(
      expect.not.objectContaining({
        trustedSourceLinkedOfficialInstall: true,
      }),
    );
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

  it("repairs missing openclaw peer links before skipping unchanged npm plugins", async () => {
    const installPath = createInstalledPackageDir({
      name: "@openclaw/codex",
      version: "2026.5.3",
      peerDependencies: { openclaw: ">=2026.5.3" },
    });
    mockNpmViewMetadata({
      name: "@openclaw/codex",
      version: "2026.5.3",
      integrity: "sha512-same",
      shasum: "same",
    });
    installPluginFromNpmSpecMock.mockResolvedValue(
      createSuccessfulNpmUpdateResult({
        pluginId: "codex",
        targetDir: installPath,
        version: "2026.5.3",
        npmResolution: {
          name: "@openclaw/codex",
          version: "2026.5.3",
          resolvedSpec: "@openclaw/codex@2026.5.3",
        },
      }),
    );
    const config: OpenClawConfig = {
      plugins: {
        installs: {
          codex: {
            source: "npm",
            spec: "@openclaw/codex",
            installPath,
            resolvedName: "@openclaw/codex",
            resolvedVersion: "2026.5.3",
            resolvedSpec: "@openclaw/codex@2026.5.3",
            integrity: "sha512-same",
            shasum: "same",
          },
        },
      },
    };

    const result = await updateNpmInstalledPlugins({
      config,
      pluginIds: ["codex"],
    });

    expect(installPluginFromNpmSpecMock).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: "@openclaw/codex",
        mode: "update",
        expectedPluginId: "codex",
      }),
    );
    expect(result.changed).toBe(true);
    expect(result.outcomes).toEqual([
      {
        pluginId: "codex",
        status: "unchanged",
        currentVersion: "2026.5.3",
        nextVersion: "2026.5.3",
        message: "codex already at 2026.5.3.",
      },
    ]);
  });

  it("skips unchanged npm plugins when the openclaw peer link already resolves", async () => {
    const installPath = createInstalledPackageDir({
      name: "@openclaw/codex",
      version: "2026.5.3",
      peerDependencies: { openclaw: ">=2026.5.3" },
    });
    fs.mkdirSync(path.join(installPath, "node_modules", "openclaw"), { recursive: true });
    mockNpmViewMetadata({
      name: "@openclaw/codex",
      version: "2026.5.3",
      integrity: "sha512-same",
      shasum: "same",
    });
    installPluginFromNpmSpecMock.mockRejectedValue(new Error("installer should not run"));

    const result = await updateNpmInstalledPlugins({
      config: {
        plugins: {
          installs: {
            codex: {
              source: "npm",
              spec: "@openclaw/codex",
              installPath,
              resolvedName: "@openclaw/codex",
              resolvedVersion: "2026.5.3",
              resolvedSpec: "@openclaw/codex@2026.5.3",
              integrity: "sha512-same",
              shasum: "same",
            },
          },
        },
      },
      pluginIds: ["codex"],
    });

    expect(installPluginFromNpmSpecMock).not.toHaveBeenCalled();
    expect(result.changed).toBe(false);
    expect(result.outcomes).toEqual([
      {
        pluginId: "codex",
        status: "unchanged",
        currentVersion: "2026.5.3",
        nextVersion: "2026.5.3",
        message: "codex is up to date (2026.5.3).",
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

  it("disables enabled tracked plugin update failures when requested", async () => {
    const warn = vi.fn();
    installPluginFromNpmSpecMock.mockResolvedValue({
      ok: false,
      error: "registry timeout",
    });
    const config = {
      plugins: {
        entries: {
          demo: {
            enabled: true,
            config: { preserved: true },
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
      disableOnFailure: true,
      logger: { warn },
    });

    expect(installPluginFromNpmSpecMock).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: "@acme/demo",
        expectedPluginId: "demo",
      }),
    );
    const message =
      'Disabled "demo" after plugin update failure; OpenClaw will continue without it. Failed to update demo: registry timeout';
    expect(warn).toHaveBeenCalledWith(message);
    expect(result.changed).toBe(true);
    expect(result.config.plugins?.entries?.demo).toEqual({
      enabled: false,
      config: { preserved: true },
    });
    expect(result.config.plugins?.installs?.demo).toEqual(config.plugins.installs.demo);
    expect(result.outcomes).toEqual([
      {
        pluginId: "demo",
        status: "skipped",
        message,
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

  it("tries npm beta for default npm specs on beta channel without persisting the beta tag", async () => {
    installPluginFromNpmSpecMock.mockResolvedValue(
      createSuccessfulNpmUpdateResult({
        pluginId: "openclaw-codex-app-server",
        targetDir: "/tmp/openclaw-codex-app-server",
        version: "0.2.0-beta.4",
        npmResolution: {
          name: "openclaw-codex-app-server",
          version: "0.2.0-beta.4",
          resolvedSpec: "openclaw-codex-app-server@0.2.0-beta.4",
        },
      }),
    );

    const result = await updateNpmInstalledPlugins({
      config: createCodexAppServerInstallConfig({
        spec: "openclaw-codex-app-server",
      }),
      pluginIds: ["openclaw-codex-app-server"],
      updateChannel: "beta",
    });

    expectNpmUpdateCall({
      spec: "openclaw-codex-app-server@beta",
      expectedPluginId: "openclaw-codex-app-server",
    });
    expectCodexAppServerInstallState({
      result,
      spec: "openclaw-codex-app-server",
      version: "0.2.0-beta.4",
      resolvedSpec: "openclaw-codex-app-server@0.2.0-beta.4",
    });
  });

  it("falls back to the default npm spec when a beta tag is unavailable", async () => {
    installPluginFromNpmSpecMock
      .mockResolvedValueOnce({
        ok: false,
        error:
          "npm ERR! code ETARGET\nnpm ERR! No matching version found for openclaw-codex-app-server@beta.",
      })
      .mockResolvedValueOnce(
        createSuccessfulNpmUpdateResult({
          pluginId: "openclaw-codex-app-server",
          targetDir: "/tmp/openclaw-codex-app-server",
          version: "0.2.6",
          npmResolution: {
            name: "openclaw-codex-app-server",
            version: "0.2.6",
            resolvedSpec: "openclaw-codex-app-server@0.2.6",
          },
        }),
      );

    const warnMessages: string[] = [];
    const result = await updateNpmInstalledPlugins({
      config: createCodexAppServerInstallConfig({
        spec: "openclaw-codex-app-server",
      }),
      pluginIds: ["openclaw-codex-app-server"],
      updateChannel: "beta",
      logger: { warn: (msg) => warnMessages.push(msg) },
    });

    expect(installPluginFromNpmSpecMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        spec: "openclaw-codex-app-server@beta",
      }),
    );
    expect(installPluginFromNpmSpecMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        spec: "openclaw-codex-app-server",
      }),
    );
    expect(warnMessages).toEqual([expect.stringContaining("has no beta npm release")]);
    expectCodexAppServerInstallState({
      result,
      spec: "openclaw-codex-app-server",
      version: "0.2.6",
      resolvedSpec: "openclaw-codex-app-server@0.2.6",
    });
  });

  it("falls back to the default npm spec when the beta package exists but is invalid", async () => {
    installPluginFromNpmSpecMock
      .mockResolvedValueOnce({
        ok: false,
        error: "Installed plugin package uses a TypeScript entry without compiled runtime output.",
      })
      .mockResolvedValueOnce(
        createSuccessfulNpmUpdateResult({
          pluginId: "openclaw-codex-app-server",
          targetDir: "/tmp/openclaw-codex-app-server",
          version: "0.2.6",
          npmResolution: {
            name: "openclaw-codex-app-server",
            version: "0.2.6",
            resolvedSpec: "openclaw-codex-app-server@0.2.6",
          },
        }),
      );

    const warnMessages: string[] = [];
    const result = await updateNpmInstalledPlugins({
      config: createCodexAppServerInstallConfig({
        spec: "openclaw-codex-app-server",
      }),
      pluginIds: ["openclaw-codex-app-server"],
      updateChannel: "beta",
      logger: { warn: (msg) => warnMessages.push(msg) },
    });

    expect(installPluginFromNpmSpecMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        spec: "openclaw-codex-app-server@beta",
      }),
    );
    expect(installPluginFromNpmSpecMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        spec: "openclaw-codex-app-server",
      }),
    );
    expect(warnMessages).toEqual([expect.stringContaining("failed beta npm update")]);
    expectCodexAppServerInstallState({
      result,
      spec: "openclaw-codex-app-server",
      version: "0.2.6",
      resolvedSpec: "openclaw-codex-app-server@0.2.6",
    });
  });

  it("reports the fallback npm spec when beta fallback also fails", async () => {
    installPluginFromNpmSpecMock
      .mockResolvedValueOnce({
        ok: false,
        error: "Installed plugin package uses a TypeScript entry without compiled runtime output.",
      })
      .mockResolvedValueOnce({
        ok: false,
        code: "npm_package_not_found",
        error: "npm package not found",
      });

    const result = await updateNpmInstalledPlugins({
      config: createCodexAppServerInstallConfig({
        spec: "openclaw-codex-app-server",
      }),
      pluginIds: ["openclaw-codex-app-server"],
      updateChannel: "beta",
    });

    expect(installPluginFromNpmSpecMock).toHaveBeenCalledTimes(2);
    expect(result.outcomes).toEqual([
      {
        pluginId: "openclaw-codex-app-server",
        status: "error",
        message:
          "Failed to update openclaw-codex-app-server: npm package not found for openclaw-codex-app-server.",
      },
    ]);
  });

  it("preserves explicit npm tags when updating on the beta channel", async () => {
    installPluginFromNpmSpecMock.mockResolvedValue(
      createSuccessfulNpmUpdateResult({
        pluginId: "openclaw-codex-app-server",
        targetDir: "/tmp/openclaw-codex-app-server",
        version: "0.2.0-rc.1",
      }),
    );

    await updateNpmInstalledPlugins({
      config: createCodexAppServerInstallConfig({
        spec: "openclaw-codex-app-server@rc",
      }),
      pluginIds: ["openclaw-codex-app-server"],
      updateChannel: "beta",
      dryRun: true,
    });

    expectNpmUpdateCall({
      spec: "openclaw-codex-app-server@rc",
      expectedPluginId: "openclaw-codex-app-server",
    });
  });

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
        artifactKind: "npm-pack",
        artifactFormat: "tgz",
        npmIntegrity: "sha512-next",
        npmShasum: "1".repeat(40),
        npmTarballName: "demo-1.2.4.tgz",
        integrity: "sha256-next",
        resolvedAt: "2026-03-22T00:00:00.000Z",
        clawpackSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        clawpackSpecVersion: 1,
        clawpackManifestSha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        clawpackSize: 4096,
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
      artifactKind: "npm-pack",
      artifactFormat: "tgz",
      npmIntegrity: "sha512-next",
      npmShasum: "1".repeat(40),
      npmTarballName: "demo-1.2.4.tgz",
      integrity: "sha256-next",
      clawpackSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      clawpackSpecVersion: 1,
      clawpackManifestSha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      clawpackSize: 4096,
    });
  });

  it("tries ClawHub beta for default ClawHub specs on beta channel without persisting the beta tag", async () => {
    installPluginFromClawHubMock.mockResolvedValue(
      createSuccessfulClawHubUpdateResult({
        pluginId: "demo",
        targetDir: "/tmp/demo",
        version: "1.3.0-beta.1",
        clawhubPackage: "demo",
      }),
    );

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
      updateChannel: "beta",
    });

    expect(installPluginFromClawHubMock).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: "clawhub:demo@beta",
        baseUrl: "https://clawhub.ai",
        expectedPluginId: "demo",
      }),
    );
    expect(result.config.plugins?.installs?.demo).toMatchObject({
      source: "clawhub",
      spec: "clawhub:demo",
      installPath: "/tmp/demo",
      version: "1.3.0-beta.1",
      clawhubPackage: "demo",
    });
  });

  it("falls back to the default ClawHub spec when a beta release is unavailable", async () => {
    installPluginFromClawHubMock
      .mockResolvedValueOnce({
        ok: false,
        code: "version_not_found",
        error: "version not found: beta",
      })
      .mockResolvedValueOnce(
        createSuccessfulClawHubUpdateResult({
          pluginId: "demo",
          targetDir: "/tmp/demo",
          version: "1.2.4",
          clawhubPackage: "demo",
        }),
      );

    const warnMessages: string[] = [];
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
      updateChannel: "beta",
      logger: { warn: (msg) => warnMessages.push(msg) },
    });

    expect(installPluginFromClawHubMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        spec: "clawhub:demo@beta",
      }),
    );
    expect(installPluginFromClawHubMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        spec: "clawhub:demo",
      }),
    );
    expect(warnMessages).toEqual([expect.stringContaining("has no beta ClawHub release")]);
    expect(result.config.plugins?.installs?.demo).toMatchObject({
      source: "clawhub",
      spec: "clawhub:demo",
      installPath: "/tmp/demo",
      version: "1.2.4",
      clawhubPackage: "demo",
    });
  });

  it("preserves explicit ClawHub tags when updating on the beta channel", async () => {
    installPluginFromClawHubMock.mockResolvedValue(
      createSuccessfulClawHubUpdateResult({
        pluginId: "demo",
        targetDir: "/tmp/demo",
        version: "1.3.0-rc.1",
        clawhubPackage: "demo",
      }),
    );

    await updateNpmInstalledPlugins({
      config: createClawHubInstallConfig({
        pluginId: "demo",
        installPath: "/tmp/demo",
        clawhubUrl: "https://clawhub.ai",
        clawhubPackage: "demo",
        clawhubFamily: "code-plugin",
        clawhubChannel: "official",
        spec: "clawhub:demo@rc",
      }),
      pluginIds: ["demo"],
      updateChannel: "beta",
      dryRun: true,
    });

    expect(installPluginFromClawHubMock).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: "clawhub:demo@rc",
      }),
    );
  });

  it("skips ClawHub plugin update when bundled version is newer", async () => {
    resolveBundledPluginSourcesMock.mockReturnValue(
      new Map([
        [
          "whatsapp",
          {
            pluginId: "whatsapp",
            localPath: appBundledPluginRoot("whatsapp"),
            version: "2026.4.20",
          },
        ],
      ]),
    );

    const config = createClawHubInstallConfig({
      pluginId: "whatsapp",
      installPath: "/tmp/whatsapp",
      clawhubUrl: "https://clawhub.ai",
      clawhubPackage: "whatsapp",
      clawhubFamily: "bundle-plugin",
      clawhubChannel: "community",
    });
    (config.plugins!.installs!.whatsapp as Record<string, unknown>).version = "2026.2.9";

    const warnMessages: string[] = [];
    const result = await updateNpmInstalledPlugins({
      config,
      pluginIds: ["whatsapp"],
      logger: { warn: (msg) => warnMessages.push(msg) },
    });

    expect(installPluginFromClawHubMock).not.toHaveBeenCalled();
    expect(result.changed).toBe(false);
    expect(result.outcomes).toEqual([
      expect.objectContaining({
        pluginId: "whatsapp",
        status: "skipped",
        message: expect.stringContaining("bundled version 2026.4.20 is newer"),
      }),
    ]);
    expect(warnMessages).toEqual([expect.stringContaining("bundled version 2026.4.20 is newer")]);
  });

  it("proceeds with ClawHub plugin update when bundled version is older", async () => {
    resolveBundledPluginSourcesMock.mockReturnValue(
      new Map([
        [
          "demo",
          {
            pluginId: "demo",
            localPath: appBundledPluginRoot("demo"),
            version: "1.0.0",
          },
        ],
      ]),
    );
    installPluginFromClawHubMock.mockResolvedValue({
      ok: true,
      pluginId: "demo",
      targetDir: "/tmp/demo",
      version: "2.0.0",
      clawhub: {
        source: "clawhub",
        clawhubUrl: "https://clawhub.ai",
        clawhubPackage: "demo",
        clawhubFamily: "code-plugin",
        clawhubChannel: "official",
        integrity: "sha256-new",
        resolvedAt: "2026-04-30T00:00:00.000Z",
      },
    });

    const config = createClawHubInstallConfig({
      pluginId: "demo",
      installPath: "/tmp/demo",
      clawhubUrl: "https://clawhub.ai",
      clawhubPackage: "demo",
      clawhubFamily: "code-plugin",
      clawhubChannel: "official",
    });
    (config.plugins!.installs!.demo as Record<string, unknown>).version = "1.5.0";

    const result = await updateNpmInstalledPlugins({
      config,
      pluginIds: ["demo"],
    });

    expect(installPluginFromClawHubMock).toHaveBeenCalled();
    expect(result.changed).toBe(true);
  });

  it("does not treat an older bundled stable release as newer than an installed correction release", async () => {
    resolveBundledPluginSourcesMock.mockReturnValue(
      new Map([
        [
          "demo",
          {
            pluginId: "demo",
            localPath: appBundledPluginRoot("demo"),
            version: "2026.5.3",
          },
        ],
      ]),
    );
    installPluginFromClawHubMock.mockResolvedValue(
      createSuccessfulClawHubUpdateResult({
        pluginId: "demo",
        targetDir: "/tmp/demo",
        version: "2026.5.3-2",
        clawhubPackage: "demo",
      }),
    );

    const config = createClawHubInstallConfig({
      pluginId: "demo",
      installPath: "/tmp/demo",
      clawhubUrl: "https://clawhub.ai",
      clawhubPackage: "demo",
      clawhubFamily: "code-plugin",
      clawhubChannel: "official",
    });
    (config.plugins!.installs!.demo as Record<string, unknown>).version = "2026.5.3-1";

    const result = await updateNpmInstalledPlugins({
      config,
      pluginIds: ["demo"],
    });

    expect(installPluginFromClawHubMock).toHaveBeenCalled();
    expect(result.changed).toBe(true);
    expect(result.outcomes[0]).toMatchObject({
      pluginId: "demo",
      status: "updated",
      currentVersion: undefined,
      nextVersion: "2026.5.3-2",
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

  it("updates git installs and records resolved commit metadata", async () => {
    installPluginFromGitSpecMock.mockResolvedValue({
      ok: true,
      pluginId: "demo",
      targetDir: "/tmp/demo",
      version: "1.3.0",
      extensions: ["index.ts"],
      git: {
        url: "https://github.com/acme/demo.git",
        ref: "main",
        commit: "def456",
        resolvedAt: "2026-04-30T00:00:00.000Z",
      },
    });

    const result = await updateNpmInstalledPlugins({
      config: createGitInstallConfig({
        pluginId: "demo",
        installPath: "/tmp/demo",
        spec: "git:github.com/acme/demo@main",
        commit: "abc123",
      }),
      pluginIds: ["demo"],
    });

    expect(installPluginFromGitSpecMock).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: "git:github.com/acme/demo@main",
        expectedPluginId: "demo",
        mode: "update",
      }),
    );
    expect(result.changed).toBe(true);
    expect(result.config.plugins?.installs?.demo).toMatchObject({
      source: "git",
      spec: "git:github.com/acme/demo@main",
      installPath: "/tmp/demo",
      version: "1.3.0",
      gitUrl: "https://github.com/acme/demo.git",
      gitRef: "main",
      gitCommit: "def456",
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
    installPluginFromGitSpecMock.mockResolvedValue({
      ok: true,
      pluginId: "demo",
      targetDir: installPath,
      version: "1.2.0",
      extensions: ["index.ts"],
      git: {
        url: "https://github.com/acme/demo.git",
        ref: "main",
        commit: "abc123",
        resolvedAt: "2026-04-30T00:00:00.000Z",
      },
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
    await updateNpmInstalledPlugins({
      config: createGitInstallConfig({
        pluginId: "demo",
        installPath,
        spec: "git:github.com/acme/demo@main",
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
    expect(installPluginFromGitSpecMock).toHaveBeenCalledWith(
      expect.objectContaining({ extensionsDir }),
    );
  });
});

describe("syncPluginsForUpdateChannel", () => {
  beforeEach(() => {
    installPluginFromNpmSpecMock.mockReset();
    installPluginFromClawHubMock.mockReset();
    installPluginFromGitSpecMock.mockReset();
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
    expect(installPluginFromNpmSpecMock).not.toHaveBeenCalledWith(
      expect.objectContaining({
        trustedSourceLinkedOfficialInstall: true,
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

  it("marks official externalized bundled npm installs as trusted", async () => {
    resolveBundledPluginSourcesMock.mockReturnValue(new Map());
    installPluginFromNpmSpecMock.mockResolvedValue(
      createSuccessfulNpmUpdateResult({
        pluginId: "voice-call",
        targetDir: "/tmp/openclaw-plugins/voice-call",
        version: "0.0.2-beta.1",
      }),
    );

    await syncPluginsForUpdateChannel({
      channel: "stable",
      externalizedBundledPluginBridges: [
        {
          bundledPluginId: "voice-call",
          npmSpec: "@openclaw/voice-call",
          channelIds: ["voice-call"],
        },
      ],
      config: {
        channels: {
          "voice-call": {
            enabled: true,
          },
        },
        plugins: {
          load: { paths: [appBundledPluginRoot("voice-call")] },
          installs: {
            "voice-call": {
              source: "path",
              sourcePath: appBundledPluginRoot("voice-call"),
              installPath: appBundledPluginRoot("voice-call"),
            },
          },
        },
      },
    });

    expect(installPluginFromNpmSpecMock).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: "@openclaw/voice-call",
        expectedPluginId: "voice-call",
        trustedSourceLinkedOfficialInstall: true,
      }),
    );
  });

  it("installs a ClawHub-preferred externalized bundled plugin", async () => {
    resolveBundledPluginSourcesMock.mockReturnValue(new Map());
    installPluginFromClawHubMock.mockResolvedValue(
      createSuccessfulClawHubUpdateResult({
        pluginId: "legacy-chat",
        targetDir: "/tmp/openclaw-plugins/legacy-chat",
        version: "2026.5.1-beta.2",
        clawhubPackage: "legacy-chat",
      }),
    );

    const result = await syncPluginsForUpdateChannel({
      channel: "stable",
      externalizedBundledPluginBridges: [
        {
          bundledPluginId: "legacy-chat",
          preferredSource: "clawhub",
          clawhubSpec: "clawhub:legacy-chat@2026.5.1-beta.2",
          clawhubUrl: "https://clawhub.ai",
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

    expect(installPluginFromClawHubMock).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: "clawhub:legacy-chat@2026.5.1-beta.2",
        baseUrl: "https://clawhub.ai",
        mode: "update",
        expectedPluginId: "legacy-chat",
      }),
    );
    expect(installPluginFromNpmSpecMock).not.toHaveBeenCalled();
    expect(result.changed).toBe(true);
    expect(result.summary.switchedToClawHub).toEqual(["legacy-chat"]);
    expect(result.summary.switchedToNpm).toEqual([]);
    expect(result.summary.errors).toEqual([]);
    expect(result.config.plugins?.load?.paths).toEqual([]);
    expect(result.config.plugins?.installs?.["legacy-chat"]).toMatchObject({
      source: "clawhub",
      spec: "clawhub:legacy-chat@2026.5.1-beta.2",
      installPath: "/tmp/openclaw-plugins/legacy-chat",
      version: "2026.5.1-beta.2",
      integrity: "sha256-clawpack",
      clawhubUrl: "https://clawhub.ai",
      clawhubPackage: "legacy-chat",
      clawhubFamily: "code-plugin",
      clawhubChannel: "official",
      artifactKind: "npm-pack",
      artifactFormat: "tgz",
      npmIntegrity: "sha512-clawpack",
      npmShasum: "2".repeat(40),
      npmTarballName: "legacy-chat-2026.5.1-beta.2.tgz",
      clawpackSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      clawpackSpecVersion: 1,
      clawpackManifestSha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      clawpackSize: 4096,
    });
  });

  it("falls back from ClawHub to npm only when the ClawHub package is absent", async () => {
    resolveBundledPluginSourcesMock.mockReturnValue(new Map());
    installPluginFromClawHubMock.mockResolvedValue({
      ok: false,
      code: "package_not_found",
      error: "Package not found on ClawHub.",
    });
    installPluginFromNpmSpecMock.mockResolvedValue(
      createSuccessfulNpmUpdateResult({
        pluginId: "legacy-chat",
        targetDir: "/tmp/openclaw-plugins/legacy-chat",
        version: "2.0.0",
      }),
    );

    const result = await syncPluginsForUpdateChannel({
      channel: "stable",
      externalizedBundledPluginBridges: [
        {
          bundledPluginId: "legacy-chat",
          preferredSource: "clawhub",
          clawhubSpec: "clawhub:legacy-chat@2026.5.1-beta.2",
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
    expect(installPluginFromNpmSpecMock).not.toHaveBeenCalledWith(
      expect.objectContaining({
        trustedSourceLinkedOfficialInstall: true,
      }),
    );
    expect(result.changed).toBe(true);
    expect(result.summary.switchedToClawHub).toEqual([]);
    expect(result.summary.switchedToNpm).toEqual(["legacy-chat"]);
    expect(result.summary.warnings).toEqual([
      "ClawHub clawhub:legacy-chat@2026.5.1-beta.2 unavailable for legacy-chat; falling back to npm @openclaw/legacy-chat.",
    ]);
    expect(result.summary.errors).toEqual([]);
    expect(result.config.plugins?.installs?.["legacy-chat"]).toMatchObject({
      source: "npm",
      spec: "@openclaw/legacy-chat",
      installPath: "/tmp/openclaw-plugins/legacy-chat",
      version: "2.0.0",
    });
  });

  it("marks official externalized ClawHub-to-npm fallbacks as trusted", async () => {
    resolveBundledPluginSourcesMock.mockReturnValue(new Map());
    installPluginFromClawHubMock.mockResolvedValue({
      ok: false,
      code: "package_not_found",
      error: "Package not found on ClawHub.",
    });
    installPluginFromNpmSpecMock.mockResolvedValue(
      createSuccessfulNpmUpdateResult({
        pluginId: "voice-call",
        targetDir: "/tmp/openclaw-plugins/voice-call",
        version: "0.0.2-beta.1",
      }),
    );

    await syncPluginsForUpdateChannel({
      channel: "stable",
      externalizedBundledPluginBridges: [
        {
          bundledPluginId: "voice-call",
          preferredSource: "clawhub",
          clawhubSpec: "clawhub:@openclaw/voice-call",
          npmSpec: "@openclaw/voice-call",
          channelIds: ["voice-call"],
        },
      ],
      config: {
        channels: {
          "voice-call": {
            enabled: true,
          },
        },
        plugins: {
          load: { paths: [appBundledPluginRoot("voice-call")] },
          installs: {
            "voice-call": {
              source: "path",
              sourcePath: appBundledPluginRoot("voice-call"),
              installPath: appBundledPluginRoot("voice-call"),
            },
          },
        },
      },
    });

    expect(installPluginFromNpmSpecMock).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: "@openclaw/voice-call",
        expectedPluginId: "voice-call",
        trustedSourceLinkedOfficialInstall: true,
      }),
    );
  });

  it("moves ClawHub-preferred externalized plugin fallbacks back to ClawHub", async () => {
    resolveBundledPluginSourcesMock.mockReturnValue(new Map());
    installPluginFromClawHubMock.mockResolvedValue(
      createSuccessfulClawHubUpdateResult({
        pluginId: "legacy-chat",
        targetDir: "/tmp/openclaw-plugins/legacy-chat",
        version: "2026.5.1-beta.2",
        clawhubPackage: "legacy-chat",
      }),
    );

    const result = await syncPluginsForUpdateChannel({
      channel: "stable",
      externalizedBundledPluginBridges: [
        {
          bundledPluginId: "legacy-chat",
          preferredSource: "clawhub",
          clawhubSpec: "clawhub:legacy-chat@2026.5.1-beta.2",
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

    expect(installPluginFromClawHubMock).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: "clawhub:legacy-chat@2026.5.1-beta.2",
        mode: "update",
        expectedPluginId: "legacy-chat",
      }),
    );
    expect(installPluginFromNpmSpecMock).not.toHaveBeenCalled();
    expect(result.changed).toBe(true);
    expect(result.summary.switchedToClawHub).toEqual(["legacy-chat"]);
    expect(result.config.plugins?.installs?.["legacy-chat"]).toMatchObject({
      source: "clawhub",
      spec: "clawhub:legacy-chat@2026.5.1-beta.2",
      installPath: "/tmp/openclaw-plugins/legacy-chat",
    });
  });

  it("fails closed without npm fallback when ClawHub returns integrity drift", async () => {
    resolveBundledPluginSourcesMock.mockReturnValue(new Map());
    installPluginFromClawHubMock.mockResolvedValue({
      ok: false,
      code: "archive_integrity_mismatch",
      error: "ClawHub ClawPack integrity mismatch.",
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
          preferredSource: "clawhub",
          clawhubSpec: "clawhub:legacy-chat@2026.5.1-beta.2",
          npmSpec: "@openclaw/legacy-chat",
          channelIds: ["legacy-chat"],
        },
      ],
      config,
    });

    expect(installPluginFromNpmSpecMock).not.toHaveBeenCalled();
    expect(result.changed).toBe(false);
    expect(result.config).toBe(config);
    expect(result.summary.errors).toEqual([
      "Failed to update legacy-chat: ClawHub ClawPack integrity mismatch. (ClawHub clawhub:legacy-chat@2026.5.1-beta.2).",
    ]);
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

  it("removes stale bundled load paths for already-externalized resolved-name-only npm installs", async () => {
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
              resolvedName: "@openclaw/legacy-chat",
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
      resolvedName: "@openclaw/legacy-chat",
    });
  });

  it("removes stale bundled load paths for already-externalized pinned npm installs", async () => {
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
              spec: "@openclaw/legacy-chat@1.2.3",
              resolvedSpec: "@openclaw/legacy-chat@1.2.3",
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
      spec: "@openclaw/legacy-chat@1.2.3",
    });
  });

  it("removes stale bundled load paths for already-externalized pinned ClawHub installs", async () => {
    resolveBundledPluginSourcesMock.mockReturnValue(new Map());

    const result = await syncPluginsForUpdateChannel({
      channel: "stable",
      externalizedBundledPluginBridges: [
        {
          bundledPluginId: "legacy-chat",
          preferredSource: "clawhub",
          clawhubSpec: "clawhub:legacy-chat",
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
              source: "clawhub",
              spec: "clawhub:legacy-chat@2026.5.1",
              clawhubPackage: "legacy-chat",
              installPath: "/tmp/openclaw-plugins/legacy-chat",
            },
          },
        },
      },
    });

    expect(installPluginFromClawHubMock).not.toHaveBeenCalled();
    expect(installPluginFromNpmSpecMock).not.toHaveBeenCalled();
    expect(result.changed).toBe(true);
    expect(result.config.plugins?.load?.paths).toEqual(["/workspace/plugins/other"]);
    expect(result.config.plugins?.installs?.["legacy-chat"]).toMatchObject({
      source: "clawhub",
      spec: "clawhub:legacy-chat@2026.5.1",
    });
  });
});
