// Onboarding plugin install tests cover install sources, trust checks, and install records.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord as PersistedPluginInstallRecord } from "../config/types.plugins.js";
import type { PluginEnableResult } from "../plugins/enable.js";
import { installPluginDirectoryIntoExtensions } from "../plugins/install-shared.js";
import type { PluginInstallArtifactConsentHandler } from "../plugins/install-types.js";
import { createColdPluginFixture } from "../plugins/test-helpers/cold-plugin-fixtures.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { VERSION } from "../version.js";
import { WizardNavigationError } from "../wizard/prompts.js";
import { WizardSession } from "../wizard/session.js";

// Stable setup is the default fixture, independent of the checkout's release version.
const coreVersion = vi.hoisted(() => ({ value: "2026.8.1" }));
vi.mock("../version.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../version.js")>()),
  get VERSION() {
    return coreVersion.value;
  },
}));

const resolveBundledInstallPlanForCatalogEntry = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => unknown>(() => undefined),
);
vi.mock("../plugins/install-source-plan.js", () => ({
  resolveBundledInstallPlanForCatalogEntry,
}));

const invalidatePluginRuntimeDiscoveryAfterConfigMutation = vi.hoisted(() =>
  vi.fn(async () => undefined),
);
vi.mock("../plugins/registry-refresh.js", () => ({
  invalidatePluginRuntimeDiscoveryAfterConfigMutation,
}));

const resolveBundledPluginSources = vi.hoisted(() => vi.fn(() => new Map()));
const findBundledPluginSourceInMap = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => { localPath: string } | undefined>(() => undefined),
);
vi.mock("../plugins/bundled-sources.js", () => ({
  resolveBundledPluginSources,
  findBundledPluginSourceInMap,
}));

const installPluginFromNpmSpec = vi.hoisted(() => vi.fn());
const installPluginFromNpmPackArchive = vi.hoisted(() => vi.fn());
vi.mock("../plugins/install.js", () => ({
  installPluginFromNpmSpec,
  installPluginFromNpmPackArchive,
}));

const installPluginFromClawHub = vi.hoisted(() => vi.fn());
vi.mock("../plugins/clawhub.js", () => ({
  CLAWHUB_INSTALL_ERROR_CODE: {
    PACKAGE_NOT_FOUND: "package_not_found",
    VERSION_NOT_FOUND: "version_not_found",
    ARTIFACT_UNAVAILABLE: "artifact_unavailable",
    ARTIFACT_DOWNLOAD_UNAVAILABLE: "artifact_download_unavailable",
  },
  installPluginFromClawHub,
}));

const enablePluginInConfig = vi.hoisted(() =>
  vi.fn<(cfg: OpenClawConfig, pluginId: string) => PluginEnableResult>((cfg, pluginId) => ({
    config: cfg,
    enabled: true,
    pluginId,
  })),
);
vi.mock("../plugins/enable.js", () => ({
  enableExplicitlySelectedPluginInConfig: enablePluginInConfig,
  enablePluginInConfig,
}));

const recordPluginInstall = vi.hoisted(() =>
  vi.fn((cfg: OpenClawConfig, update: { pluginId: string }) => ({
    ...cfg,
    plugins: {
      ...cfg.plugins,
      installs: {
        ...cfg.plugins?.installs,
        [update.pluginId]: update,
      },
    },
  })),
);
const buildNpmResolutionInstallFields = vi.hoisted(() => vi.fn(() => ({})));
const resolveNpmInstallRecordSpec = vi.hoisted(() =>
  vi.fn(
    (params: {
      requestedSpec?: string;
      resolution?: { resolvedSpec?: string };
      pinResolvedRegistrySpec?: boolean;
    }) => {
      if (params.pinResolvedRegistrySpec && params.resolution?.resolvedSpec) {
        return params.resolution.resolvedSpec;
      }
      return params.requestedSpec;
    },
  ),
);
vi.mock("../plugins/installs.js", () => ({
  recordPluginInstall,
  buildNpmResolutionInstallFields,
  resolveNpmInstallRecordSpec,
}));

const clearPluginMetadataLifecycleCaches = vi.hoisted(() => vi.fn());
vi.mock("../plugins/plugin-metadata-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/plugin-metadata-lifecycle.js")>()),
  clearPluginMetadataLifecycleCaches,
}));
const clearLoadInstalledPluginIndexInstallRecordsCache = vi.hoisted(() => vi.fn());
vi.mock("../plugins/installed-plugin-index-records.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/installed-plugin-index-records.js")>()),
  clearLoadInstalledPluginIndexInstallRecordsCache,
  loadInstalledPluginIndexInstallRecords: async () => ({}),
}));

const withPluginLifecycleLease = vi.hoisted(() =>
  vi.fn(async (_options: unknown, run: () => Promise<unknown>) => await run()),
);
vi.mock("../plugins/plugin-lifecycle-lease.js", () => ({
  withPluginLifecycleLease,
}));

const withTimeout = vi.hoisted(() => vi.fn(async <T>(promise: Promise<T>) => await promise));
vi.mock("../utils/with-timeout.js", () => ({
  withTimeout,
}));

const prepareManagedPluginArtifactConsentHandler = vi.hoisted(() =>
  vi.fn<
    typeof import("../plugins/capability-consent.js").prepareManagedPluginArtifactConsentHandler
  >(),
);
vi.mock("../plugins/capability-consent.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/capability-consent.js")>()),
  prepareManagedPluginArtifactConsentHandler,
}));

import { ensureChannelSetupPluginInstalled } from "./channel-setup/plugin-install.js";
import { ensureOnboardingPluginInstalled } from "./onboarding-plugin-install.js";

function requireCapturedPrompt<T>(captured: T | undefined): T {
  if (!captured) {
    throw new Error("expected captured install prompt");
  }
  return captured;
}

type MockWithUnknownCalls = {
  mock: {
    calls: unknown[][];
  };
};

function readFirstMockCall(mock: unknown, label: string): unknown[] {
  const calls = (mock as MockWithUnknownCalls).mock.calls;
  const call = calls[0];
  if (!call) {
    throw new Error(`Expected ${label} to be called`);
  }
  return call;
}

type NpmPackInstallCall = {
  archivePath?: string;
  config?: OpenClawConfig;
  expectedPluginId?: string;
  trustedSourceLinkedOfficialInstall?: boolean;
};

type NpmSpecInstallCall = {
  config?: OpenClawConfig;
  expectedIntegrity?: string;
  expectedPluginId?: string;
  mode?: string;
  spec?: string;
  timeoutMs?: number;
  trustedSourceLinkedOfficialInstall?: boolean;
};

type ClawHubInstallCall = {
  config?: OpenClawConfig;
  expectedPluginId?: string;
  logger?: {
    info?: (message: string) => void;
    warn?: (message: string) => void;
  };
  mode?: string;
  spec?: string;
  timeoutMs?: number;
};

type PluginInstallRecord = Partial<PersistedPluginInstallRecord> & { pluginId?: string };

describe("ensureOnboardingPluginInstalled", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("OPENCLAW_ALLOW_PLUGIN_INSTALL_OVERRIDES", undefined);
    vi.stubEnv("OPENCLAW_PLUGIN_INSTALL_OVERRIDES", undefined);
    withTimeout.mockImplementation(async <T>(promise: Promise<T>) => await promise);
    prepareManagedPluginArtifactConsentHandler.mockResolvedValue({
      onBeforePluginArtifactCommit: async () => {},
      applyAcceptedSurface: (_pluginId, record) => record,
    });
    invalidatePluginRuntimeDiscoveryAfterConfigMutation.mockResolvedValue(undefined);
  });

  afterEach(() => {
    coreVersion.value = "2026.8.1";
    vi.unstubAllEnvs();
  });

  it.each(["npm", "clawhub", "npm-pack"] as const)(
    "reports only installer activity while %s is pending",
    async (source) => {
      vi.useFakeTimers();
      const started = createDeferredCore();
      const release = createDeferredCore();
      const update = vi.fn();
      const stop = vi.fn();
      const install = async (params: ClawHubInstallCall) => {
        params.logger?.info?.("Downloading demo-plugin\u001b[31m from registry…");
        started.resolve();
        await release.promise;
        return { ok: false, error: "registry unavailable" };
      };
      if (source === "npm-pack") {
        vi.stubEnv("OPENCLAW_ALLOW_PLUGIN_INSTALL_OVERRIDES", "1");
        vi.stubEnv(
          "OPENCLAW_PLUGIN_INSTALL_OVERRIDES",
          JSON.stringify({
            "demo-plugin": "npm-pack:/tmp/demo-plugin.tgz",
          }),
        );
        installPluginFromNpmPackArchive.mockImplementationOnce(install);
      } else if (source === "clawhub") {
        installPluginFromClawHub.mockImplementationOnce(install);
      } else {
        installPluginFromNpmSpec.mockImplementationOnce(install);
      }
      const pending = ensureOnboardingPluginInstalled({
        cfg: {},
        entry: {
          pluginId: "demo-plugin",
          label: "Demo Plugin",
          install:
            source === "clawhub"
              ? { clawhubSpec: "clawhub:demo-plugin@1.0.0" }
              : { npmSpec: "@demo/plugin@1.0.0" },
          preferRemoteInstall: true,
        },
        prompter: {
          progress: () => ({ update, stop }),
          note: vi.fn(async () => {}),
        } as never,
        runtime: { log: vi.fn(), error: vi.fn() } as never,
        promptInstall: false,
      });
      try {
        await started.promise;
        const updates = [...update.mock.calls];
        await vi.advanceTimersByTimeAsync(12_000);
        expect(update.mock.calls).toEqual(updates);
        expect(update).toHaveBeenLastCalledWith("Downloading demo-plugin from registry…");
        expect(stop).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        await pending;
        vi.useRealTimers();
      }
      expect(stop).toHaveBeenCalledWith("Install failed: Demo Plugin");
      expect(stop).toHaveBeenCalledTimes(1);
      expect(recordPluginInstall).not.toHaveBeenCalled();
    },
  );

  it.each([
    ...(["npm", "clawhub", "npm-pack", "local"] as const).flatMap((source) =>
      [false, true].map((accepted) => ({ source, accepted, promptError: undefined })),
    ),
    { source: "local" as const, accepted: false, promptError: new WizardNavigationError("back") },
    ...(["npm", "clawhub"] as const).map((source) => ({
      source,
      accepted: false,
      promptError: new Error("capability review guard rejected the operation"),
    })),
  ])(
    "reviews $source artifact capabilities before onboarding activation, accepted=$accepted promptError=$promptError",
    async ({ source, accepted, promptError }) => {
      const actual = await vi.importActual<typeof import("../plugins/capability-consent.js")>(
        "../plugins/capability-consent.js",
      );
      prepareManagedPluginArtifactConsentHandler.mockImplementationOnce(
        actual.prepareManagedPluginArtifactConsentHandler,
      );
      await withTestDir({ prefix: "openclaw-onboarding-consent-" }, async (artifactDir) => {
        createColdPluginFixture({
          rootDir: artifactDir,
          pluginId: "demo-plugin",
          manifest: { contracts: { tools: ["demo.write"] } },
        });
        let committed = false;
        const install = async (params: {
          onBeforePluginArtifactCommit?: PluginInstallArtifactConsentHandler;
        }) => {
          await params.onBeforePluginArtifactCommit?.({
            pluginId: "demo-plugin",
            stagedArtifactDir: artifactDir,
            mode: "install",
          });
          committed = true;
          return {
            ok: true,
            pluginId: "demo-plugin",
            targetDir: artifactDir,
            version: "1.0.0",
            clawhub: { source: "clawhub", clawhubPackage: "demo-plugin" },
          };
        };
        if (source === "npm-pack") {
          process.env.OPENCLAW_ALLOW_PLUGIN_INSTALL_OVERRIDES = "1";
          process.env.OPENCLAW_PLUGIN_INSTALL_OVERRIDES = JSON.stringify({
            "demo-plugin": `npm-pack:${path.join(artifactDir, "plugin.tgz")}`,
          });
          installPluginFromNpmPackArchive.mockImplementationOnce(install);
        } else if (source === "clawhub") {
          installPluginFromClawHub.mockImplementationOnce(install);
        } else if (source === "npm") {
          installPluginFromNpmSpec.mockImplementationOnce(install);
        }
        const beforePersistentEffect = vi.fn();
        const confirm = vi.fn(async () => {
          expect(beforePersistentEffect).not.toHaveBeenCalled();
          if (promptError) {
            throw promptError;
          }
          return accepted;
        });
        const note = vi.fn(async () => {});
        const log = vi.fn();
        if (accepted || source === "local") {
          const actualEnable =
            await vi.importActual<typeof import("../plugins/enable.js")>("../plugins/enable.js");
          enablePluginInConfig.mockImplementationOnce(
            actualEnable.enableExplicitlySelectedPluginInConfig,
          );
        }
        const cfg: OpenClawConfig = { plugins: { entries: { "demo-plugin": { enabled: false } } } };
        const pending = ensureOnboardingPluginInstalled({
          cfg,
          entry: {
            pluginId: "demo-plugin",
            label: "Demo Plugin",
            install:
              source === "local"
                ? { localPath: artifactDir }
                : source === "clawhub"
                  ? { clawhubSpec: "clawhub:demo-plugin@1.0.0" }
                  : { npmSpec: "@example/demo-plugin@1.0.0" },
            preferRemoteInstall: source !== "local",
          },
          prompter: {
            confirm,
            note,
            progress: () => ({ update: vi.fn(), stop: vi.fn() }),
          } as never,
          runtime: { log, error: vi.fn() } as never,
          promptInstall: false,
          workspaceDir: artifactDir,
          beforePersistentEffect,
        });
        if (promptError) {
          await expect(pending).rejects.toBe(promptError);
          expect(committed).toBe(false);
          expect(recordPluginInstall).not.toHaveBeenCalled();
          return;
        }
        const result = await pending;

        expect(confirm).toHaveBeenCalledOnce();
        expect([...note.mock.calls, ...log.mock.calls].flat().join("\n")).toContain("demo.write");
        if (source !== "local") {
          expect(committed).toBe(accepted);
        }
        if (accepted) {
          expect(beforePersistentEffect).toHaveBeenCalledOnce();
          expect(result).toMatchObject({ installed: true, status: "installed" });
          expect(result.cfg.plugins?.entries?.["demo-plugin"]?.enabled).toBe(true);
          expect(result.cfg.plugins?.installs?.["demo-plugin"]).toMatchObject({
            acceptedSurface: { tools: ["demo.write"] },
            acceptedSurfaceHash: expect.stringMatching(/^[a-f\d]{64}$/),
            acceptedSurfaceAt: expect.any(String),
          });
        } else {
          expect(beforePersistentEffect).not.toHaveBeenCalled();
          expect(result).toMatchObject({ installed: false, status: "failed", cfg });
          expect(recordPluginInstall).not.toHaveBeenCalled();
        }
      });
    },
  );

  it.each(
    (["onboarding", "channel"] as const).flatMap((entryPoint) =>
      (["cancel", "expire", "commit"] as const).map((action) => ({ entryPoint, action })),
    ),
  )(
    "keeps hosted $entryPoint artifact review cancellable until commit ($action)",
    async ({ entryPoint, action }) => {
      const actual = await vi.importActual<typeof import("../plugins/capability-consent.js")>(
        "../plugins/capability-consent.js",
      );
      prepareManagedPluginArtifactConsentHandler.mockImplementationOnce(
        actual.prepareManagedPluginArtifactConsentHandler,
      );
      await withTestDir({ prefix: "openclaw-hosted-install-consent-" }, async (root) => {
        const sourceDir = path.join(root, "source");
        const targetDir = path.join(root, "installed", "demo-plugin");
        await fs.mkdir(sourceDir);
        createColdPluginFixture({ rootDir: sourceDir, pluginId: "demo-plugin" });
        const committed = createDeferredCore();
        const releaseInstaller = createDeferredCore();
        installPluginFromNpmSpec.mockImplementationOnce(
          async (params: {
            onBeforePluginArtifactCommit?: PluginInstallArtifactConsentHandler;
          }) => {
            const result = await installPluginDirectoryIntoExtensions({
              sourceDir,
              targetDir,
              pluginId: "demo-plugin",
              extensions: ["index.cjs"],
              logger: {},
              timeoutMs: 10_000,
              mode: "install",
              dryRun: false,
              copyErrorPrefix: "failed to stage fixture",
              hasDeps: false,
              depsLogMessage: "fixture has no dependencies",
              onBeforePluginArtifactCommit: params.onBeforePluginArtifactCommit,
            });
            committed.resolve();
            await releaseInstaller.promise;
            return result;
          },
        );
        if (action === "expire") {
          vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        }
        const session = new WizardSession(
          async (prompter, _signal, owner) => {
            const shared = {
              cfg: {},
              prompter,
              runtime: { log: vi.fn(), error: vi.fn() } as never,
              promptInstall: false,
              beforePersistentEffect: async () => {
                owner.lockCancellation();
              },
            };
            const install = { npmSpec: "@example/demo-plugin@1.0.0" };
            if (entryPoint === "channel") {
              await ensureChannelSetupPluginInstalled({
                ...shared,
                entry: {
                  id: "demo-channel",
                  pluginId: "demo-plugin",
                  meta: {
                    id: "demo-channel",
                    label: "Demo channel",
                    selectionLabel: "Demo channel",
                    docsPath: "/channels/demo",
                    blurb: "Fixture channel",
                  },
                  install,
                },
              });
            } else {
              await ensureOnboardingPluginInstalled({
                ...shared,
                entry: {
                  pluginId: "demo-plugin",
                  label: "Demo plugin",
                  install,
                  preferRemoteInstall: true,
                },
              });
            }
          },
          action === "expire" ? { timeoutMs: 1_000 } : undefined,
        );
        try {
          let pending = await session.next();
          while (pending.step && pending.step.type !== "confirm") {
            if (pending.step.type !== "progress") {
              await session.answer(pending.step.id, undefined);
            }
            pending = await session.next();
          }
          expect(pending.step?.type).toBe("confirm");
          const step = requireCapturedPrompt(pending.step);
          if (action === "commit") {
            await session.answer(step.id, true);
            await committed.promise;
            expect(await fs.stat(targetDir)).toBeDefined();
            expect(session.cancel()).toBe(false);
          } else {
            if (action === "expire") {
              await vi.advanceTimersByTimeAsync(1_000);
            } else {
              session.cancel();
            }
            const status = session.getStatus();
            // Unwind the broken pre-fix path before asserting, so its locked
            // prompt cannot leak a runner into the next case.
            if (status === "running") {
              await session.answer(step.id, false);
            }
            await session.whenSettled();
            expect(status).toBe("cancelled");
            await expect(fs.stat(targetDir)).rejects.toMatchObject({ code: "ENOENT" });
            expect(recordPluginInstall).not.toHaveBeenCalled();
          }
        } finally {
          releaseInstaller.resolve();
          await session.whenSettled();
          vi.useRealTimers();
        }
      });
    },
  );

  it("localizes plugin install choices", async () => {
    const previousLocale = process.env.OPENCLAW_LOCALE;
    process.env.OPENCLAW_LOCALE = "zh-CN";
    let captured:
      | {
          message: string;
          options: Array<{
            value: "clawhub" | "npm" | "local" | "skip";
            label: string;
            hint?: string;
          }>;
        }
      | undefined;

    try {
      await ensureOnboardingPluginInstalled({
        cfg: {},
        entry: {
          pluginId: "openclaw-qqbot",
          label: "QQ Bot",
          install: {
            npmSpec: "@tencent-connect/openclaw-qqbot@2.0.1",
          },
        },
        prompter: {
          select: vi.fn(async (input) => {
            captured = input;
            return "skip";
          }),
        } as never,
        runtime: {} as never,
      });

      expect(captured?.message).toBe("安装 QQ Bot 插件？");
      expect(captured?.options).toEqual([
        { value: "npm", label: "从 npm 下载（@tencent-connect/openclaw-qqbot@2.0.1）" },
        { value: "skip", label: "暂时跳过" },
      ]);
    } finally {
      if (previousLocale === undefined) {
        delete process.env.OPENCLAW_LOCALE;
      } else {
        process.env.OPENCLAW_LOCALE = previousLocale;
      }
    }
  });

  it("localizes plugin install progress and enablement failures", async () => {
    const previousLocale = process.env.OPENCLAW_LOCALE;
    process.env.OPENCLAW_LOCALE = "zh-CN";
    enablePluginInConfig.mockReturnValueOnce({
      config: {},
      enabled: false,
      pluginId: "demo-plugin",
      reason: "blocked by allowlist",
    });
    installPluginFromNpmSpec.mockResolvedValueOnce({
      ok: true,
      pluginId: "demo-plugin",
      targetDir: "/tmp/demo-plugin",
      version: "1.2.3",
    });
    const note = vi.fn(async () => {});
    const progress = vi.fn(() => ({ update: vi.fn(), stop: vi.fn() }));

    try {
      await ensureOnboardingPluginInstalled({
        cfg: {},
        entry: {
          pluginId: "demo-plugin",
          label: "Demo Plugin",
          install: {
            npmSpec: "@demo/plugin@1.2.3",
          },
        },
        prompter: {
          select: vi.fn(async () => "npm"),
          note,
          progress,
        } as never,
        runtime: { error: vi.fn() } as never,
      });

      expect(progress).toHaveBeenCalledWith("正在安装 Demo Plugin 插件...");
      expect(note).toHaveBeenCalledWith("无法启用 Demo Plugin：blocked by allowlist。", "插件安装");
      expect(withPluginLifecycleLease).toHaveBeenCalledOnce();
    } finally {
      if (previousLocale === undefined) {
        delete process.env.OPENCLAW_LOCALE;
      } else {
        process.env.OPENCLAW_LOCALE = previousLocale;
      }
    }
  });

  it("refuses non-skipped installs in Nix mode before package work", async () => {
    const previous = process.env.OPENCLAW_NIX_MODE;
    process.env.OPENCLAW_NIX_MODE = "1";
    try {
      await expect(
        ensureOnboardingPluginInstalled({
          cfg: {},
          entry: {
            pluginId: "demo-plugin",
            label: "Demo Provider",
            install: {
              npmSpec: "@openclaw/demo-plugin@1.2.3",
            },
          },
          promptInstall: false,
          prompter: {
            select: vi.fn(async () => "npm"),
            progress: vi.fn(),
          } as never,
          runtime: {} as never,
        }),
      ).rejects.toThrow("OPENCLAW_NIX_MODE=1");
    } finally {
      if (previous === undefined) {
        delete process.env.OPENCLAW_NIX_MODE;
      } else {
        process.env.OPENCLAW_NIX_MODE = previous;
      }
    }

    expect(installPluginFromNpmSpec).not.toHaveBeenCalled();
    expect(installPluginFromClawHub).not.toHaveBeenCalled();
    expect(enablePluginInConfig).not.toHaveBeenCalled();
  });

  it("uses a guarded npm-pack install override for the matching plugin id", async () => {
    const archivePath = path.resolve("tmp/demo-plugin.tgz");
    const cfg: OpenClawConfig = {
      security: {
        installPolicy: {
          enabled: true,
          exec: {
            source: "exec",
            command: process.execPath,
            args: ["-e", "process.exit(1)"],
          },
        },
      },
    };
    process.env.OPENCLAW_ALLOW_PLUGIN_INSTALL_OVERRIDES = "1";
    process.env.OPENCLAW_PLUGIN_INSTALL_OVERRIDES = JSON.stringify({
      "other-plugin": "npm:@demo/other@1.0.0",
      "demo-plugin": `npm-pack:${archivePath}`,
    });
    installPluginFromNpmPackArchive.mockResolvedValue({
      ok: true,
      pluginId: "demo-plugin",
      targetDir: "/tmp/openclaw/extensions/demo-plugin",
      version: "1.2.3",
      manifestName: "@demo/plugin",
      npmTarballName: "demo-plugin-1.2.3.tgz",
      npmResolution: {
        name: "@demo/plugin",
        version: "1.2.3",
        resolvedSpec: "file:demo-plugin-1.2.3.tgz",
        integrity: "sha512-demo",
        shasum: "abc123",
        resolvedAt: "2026-05-09T00:00:00.000Z",
      },
    });

    const select = vi.fn(async () => "npm");
    const result = await ensureOnboardingPluginInstalled({
      cfg,
      entry: {
        pluginId: "demo-plugin",
        label: "Demo Plugin",
        install: {
          npmSpec: "@demo/plugin@1.2.3",
        },
        trustedSourceLinkedOfficialInstall: true,
      },
      prompter: {
        select,
        note: vi.fn(),
        progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
      } as never,
      runtime: { log: vi.fn() } as never,
      workspaceDir: "/tmp/workspace",
    });

    expect(select).not.toHaveBeenCalled();
    expect(installPluginFromNpmSpec).not.toHaveBeenCalled();
    const [packCall] = readFirstMockCall(
      installPluginFromNpmPackArchive,
      "installPluginFromNpmPackArchive",
    ) as [NpmPackInstallCall];
    expect(packCall.archivePath).toBe(archivePath);
    expect(packCall.config).toBe(cfg);
    expect(packCall.expectedPluginId).toBe("demo-plugin");
    expect(packCall).not.toHaveProperty("trustedSourceLinkedOfficialInstall");
    const [, recordUpdate] = readFirstMockCall(recordPluginInstall, "recordPluginInstall") as [
      OpenClawConfig,
      PluginInstallRecord,
    ];
    expect(recordUpdate).toEqual({
      pluginId: "demo-plugin",
      source: "npm",
      spec: "file:demo-plugin-1.2.3.tgz",
      sourcePath: archivePath,
      installPath: "/tmp/openclaw/extensions/demo-plugin",
      version: "1.2.3",
      artifactKind: "npm-pack",
      artifactFormat: "tgz",
      npmIntegrity: "sha512-demo",
      npmShasum: "abc123",
      npmTarballName: "demo-plugin-1.2.3.tgz",
    });
    expect(result.status).toBe("installed");
    expect(clearLoadInstalledPluginIndexInstallRecordsCache).toHaveBeenCalledOnce();
    expect(clearPluginMetadataLifecycleCaches).toHaveBeenCalledOnce();
    expect(invalidatePluginRuntimeDiscoveryAfterConfigMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        logger: expect.objectContaining({ warn: expect.any(Function) }),
      }),
    );
  });

  it("uses a guarded npm install override without official-trust flags", async () => {
    process.env.OPENCLAW_ALLOW_PLUGIN_INSTALL_OVERRIDES = "1";
    process.env.OPENCLAW_PLUGIN_INSTALL_OVERRIDES = JSON.stringify({
      codex: "npm:@openclaw/codex@2026.5.8",
      "other-plugin": "npm-pack:/tmp/other.tgz",
    });
    installPluginFromNpmSpec.mockResolvedValue({
      ok: true,
      pluginId: "codex",
      targetDir: "/tmp/openclaw/extensions/codex",
      version: "2026.5.8",
      npmResolution: {
        name: "@openclaw/codex",
        version: "2026.5.8",
        resolvedSpec: "@openclaw/codex@2026.5.8",
      },
    });

    await ensureOnboardingPluginInstalled({
      cfg: {},
      entry: {
        pluginId: "codex",
        label: "Codex",
        install: {
          npmSpec: "@openclaw/codex",
        },
        trustedSourceLinkedOfficialInstall: true,
      },
      prompter: {
        select: vi.fn(async () => "npm"),
        note: vi.fn(),
        progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
      } as never,
      runtime: { log: vi.fn() } as never,
    });

    const [npmCall] = readFirstMockCall(installPluginFromNpmSpec, "installPluginFromNpmSpec") as [
      NpmSpecInstallCall,
    ];
    expect(npmCall.trustedSourceLinkedOfficialInstall).toBeUndefined();
    expect(npmCall.spec).toBe("@openclaw/codex@2026.5.8");
    expect(npmCall.expectedPluginId).toBe("codex");
  });

  it.each(["@openclaw/codex", "@openclaw/codex@latest"])(
    "falls back to the operator selector %s when no beta release is published",
    async (spec) => {
      installPluginFromNpmSpec
        .mockResolvedValueOnce({
          ok: false,
          code: "npm_package_not_found",
          error: "Package not found on npm: @openclaw/codex@beta.",
        })
        .mockResolvedValue({
          ok: true,
          pluginId: "codex",
          targetDir: "/tmp/openclaw/extensions/codex",
          version: "2026.7.1",
          npmResolution: {
            name: "@openclaw/codex",
            version: "2026.7.1",
            resolvedSpec: "@openclaw/codex@2026.7.1",
          },
        });
      const note = vi.fn();

      await ensureOnboardingPluginInstalled({
        cfg: { update: { channel: "beta" } },
        entry: {
          pluginId: "codex",
          label: "Codex",
          install: { npmSpec: spec },
          trustedSourceLinkedOfficialInstall: true,
        },
        prompter: {
          select: vi.fn(async () => "npm"),
          note,
          progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
        } as never,
        runtime: { log: vi.fn() } as never,
      });

      const calls = installPluginFromNpmSpec.mock.calls as [NpmSpecInstallCall][];
      expect(calls[0]?.[0]?.spec).toBe("@openclaw/codex@beta");
      expect(calls[1]?.[0]?.spec).toBe(spec);
      expect(
        note.mock.calls.some(([message]) =>
          String(message).includes("No @openclaw/codex@beta release is published"),
        ),
      ).toBe(true);
    },
  );

  it.each(["clawhub:demo-plugin", "clawhub:demo-plugin@latest"])(
    "retries the operator ClawHub selector %s when no beta release is published",
    async (spec) => {
      installPluginFromClawHub
        .mockResolvedValueOnce({
          ok: false,
          code: "version_not_found",
          error: "Version not found on ClawHub: demo-plugin@beta.",
        })
        .mockResolvedValue({
          ok: true,
          pluginId: "demo-plugin",
          targetDir: "/tmp/demo-plugin",
          version: "2026.5.2",
          packageName: "demo-plugin",
          clawhub: {
            source: "clawhub",
            clawhubUrl: "https://clawhub.ai",
            clawhubPackage: "demo-plugin",
            clawhubFamily: "code-plugin",
            clawhubChannel: "official",
            version: "2026.5.2",
            integrity: "sha256-clawpack",
            resolvedAt: "2026-05-02T00:00:00.000Z",
            clawpackSha256: "a".repeat(64),
            clawpackSpecVersion: 1,
            clawpackManifestSha256: "b".repeat(64),
            clawpackSize: 4096,
          },
        });
      const note = vi.fn();

      await ensureOnboardingPluginInstalled({
        cfg: { update: { channel: "beta" } } as never,
        entry: {
          pluginId: "demo-plugin",
          label: "Demo Provider",
          install: { clawhubSpec: spec, defaultChoice: "clawhub" },
        },
        prompter: {
          select: vi.fn(async () => "clawhub"),
          note,
          progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
        } as never,
        runtime: {} as never,
      });

      const calls = installPluginFromClawHub.mock.calls as [{ spec?: string }][];
      expect(calls[0]?.[0]?.spec).toBe("clawhub:demo-plugin@beta");
      expect(calls[1]?.[0]?.spec).toBe(spec);
      expect(
        note.mock.calls.some(([message]) =>
          String(message).includes("No clawhub:demo-plugin@beta release is published"),
        ),
      ).toBe(true);
    },
  );

  it("installs and records ClawHub provider plugins with source facts", async () => {
    const cfg: OpenClawConfig = {
      security: {
        installPolicy: {
          enabled: true,
          exec: {
            source: "exec",
            command: process.execPath,
            args: ["-e", "process.exit(1)"],
          },
        },
      },
    };
    installPluginFromClawHub.mockImplementation(async (params) => {
      params.logger?.info?.("Downloading demo-plugin from ClawHub…");
      return {
        ok: true,
        pluginId: "demo-plugin",
        targetDir: "/tmp/demo-plugin",
        version: "2026.5.2",
        packageName: "demo-plugin",
        clawhub: {
          source: "clawhub",
          clawhubUrl: "https://clawhub.ai",
          clawhubPackage: "demo-plugin",
          clawhubFamily: "code-plugin",
          clawhubChannel: "official",
          version: "2026.5.2",
          integrity: "sha256-clawpack",
          resolvedAt: "2026-05-02T00:00:00.000Z",
          clawpackSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          clawpackSpecVersion: 1,
          clawpackManifestSha256:
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          clawpackSize: 4096,
        },
      };
    });
    const stop = vi.fn();
    const update = vi.fn();

    const result = await ensureOnboardingPluginInstalled({
      cfg,
      entry: {
        pluginId: "demo-plugin",
        label: "Demo Provider",
        install: {
          clawhubSpec: "clawhub:demo-plugin@2026.5.2",
          npmSpec: "@openclaw/demo-plugin@2026.5.2",
          defaultChoice: "clawhub",
        },
      },
      prompter: {
        select: vi.fn(async () => "clawhub"),
        progress: vi.fn(() => ({ update, stop })),
      } as never,
      runtime: {} as never,
    });

    const [clawHubCall] = readFirstMockCall(
      installPluginFromClawHub,
      "installPluginFromClawHub",
    ) as [ClawHubInstallCall];
    expect(clawHubCall.spec).toBe("clawhub:demo-plugin@2026.5.2");
    expect(clawHubCall.config).toBe(cfg);
    expect(clawHubCall.expectedPluginId).toBe("demo-plugin");
    expect(clawHubCall.mode).toBe("install");
    expect(clawHubCall.timeoutMs).toBe(300_000);
    expect(update).toHaveBeenCalledWith("Downloading demo-plugin from ClawHub…");
    expect(stop).toHaveBeenCalledWith("Installed Demo Provider plugin");
    const [, recordUpdate] = readFirstMockCall(recordPluginInstall, "recordPluginInstall") as [
      OpenClawConfig,
      PluginInstallRecord,
    ];
    expect(recordUpdate.pluginId).toBe("demo-plugin");
    expect(recordUpdate.source).toBe("clawhub");
    expect(recordUpdate.spec).toBe("clawhub:demo-plugin@2026.5.2");
    expect(recordUpdate.installPath).toBe("/tmp/demo-plugin");
    expect(recordUpdate.version).toBe("2026.5.2");
    expect(recordUpdate.integrity).toBe("sha256-clawpack");
    expect(recordUpdate.clawhubPackage).toBe("demo-plugin");
    expect(recordUpdate.clawpackSize).toBe(4096);
    expect(result.installed).toBe(true);
    expect(result.status).toBe("installed");
    const installed = result.cfg.plugins?.installs?.["demo-plugin"] as
      | PluginInstallRecord
      | undefined;
    expect(installed?.pluginId).toBe("demo-plugin");
    expect(installed?.source).toBe("clawhub");
    expect(installed?.spec).toBe("clawhub:demo-plugin@2026.5.2");
  });

  it("passes npm specs and optional expected integrity to npm installs with progress", async () => {
    const cfg: OpenClawConfig = {
      security: {
        installPolicy: {
          enabled: true,
          exec: {
            source: "exec",
            command: process.execPath,
            args: ["-e", "process.exit(1)"],
          },
        },
      },
    };
    const npmResolution = {
      name: "@wecom/wecom-openclaw-plugin",
      version: "1.2.3",
      resolvedSpec: "@wecom/wecom-openclaw-plugin@1.2.3",
      integrity: "sha512-wecom",
      shasum: "deadbeef",
      resolvedAt: "2026-04-24T00:00:00.000Z",
    };
    const installFields = {
      resolvedName: npmResolution.name,
      resolvedVersion: npmResolution.version,
      resolvedSpec: npmResolution.resolvedSpec,
      integrity: npmResolution.integrity,
      shasum: npmResolution.shasum,
      resolvedAt: npmResolution.resolvedAt,
    };
    buildNpmResolutionInstallFields.mockReturnValueOnce(installFields);
    installPluginFromNpmSpec.mockImplementation(async (params) => {
      params.logger?.info?.("Downloading demo-plugin…");
      return {
        ok: true,
        pluginId: "demo-plugin",
        targetDir: "/tmp/demo-plugin",
        version: "1.2.3",
        npmResolution,
      };
    });
    const stop = vi.fn();
    const update = vi.fn();

    const result = await ensureOnboardingPluginInstalled({
      cfg,
      entry: {
        pluginId: "demo-plugin",
        label: "WeCom",
        install: {
          npmSpec: "@wecom/wecom-openclaw-plugin@1.2.3",
          expectedIntegrity: "sha512-wecom",
        },
        trustedSourceLinkedOfficialInstall: true,
      },
      prompter: {
        select: vi.fn(async () => "npm"),
        progress: vi.fn(() => ({ update, stop })),
      } as never,
      runtime: {} as never,
    });

    const [npmCall] = readFirstMockCall(installPluginFromNpmSpec, "installPluginFromNpmSpec") as [
      NpmSpecInstallCall,
    ];
    expect(npmCall.spec).toBe("@wecom/wecom-openclaw-plugin@1.2.3");
    expect(npmCall.config).toBe(cfg);
    expect(npmCall.mode).toBe("update");
    expect(npmCall.expectedPluginId).toBe("demo-plugin");
    expect(npmCall.expectedIntegrity).toBe("sha512-wecom");
    expect(npmCall.trustedSourceLinkedOfficialInstall).toBe(true);
    expect(npmCall.timeoutMs).toBe(300_000);
    expect(update).toHaveBeenCalledWith("Downloading demo-plugin…");
    expect(stop).toHaveBeenCalledWith("Installed WeCom plugin");
    expect(buildNpmResolutionInstallFields).toHaveBeenCalledWith(npmResolution);
    const [, recordUpdate] = readFirstMockCall(recordPluginInstall, "recordPluginInstall") as [
      OpenClawConfig,
      PluginInstallRecord,
    ];
    expect(recordUpdate.pluginId).toBe("demo-plugin");
    expect(recordUpdate.source).toBe("npm");
    expect(recordUpdate.spec).toBe("@wecom/wecom-openclaw-plugin@1.2.3");
    expect(recordUpdate.installPath).toBe("/tmp/demo-plugin");
    expect(recordUpdate.version).toBe("1.2.3");
    expect(recordUpdate.resolvedName).toBe(installFields.resolvedName);
    expect(recordUpdate.resolvedVersion).toBe(installFields.resolvedVersion);
    expect(recordUpdate.resolvedSpec).toBe(installFields.resolvedSpec);
    expect(recordUpdate.integrity).toBe(installFields.integrity);
    expect(recordUpdate.shasum).toBe(installFields.shasum);
    expect(recordUpdate.resolvedAt).toBe(installFields.resolvedAt);
    expect(result.installed).toBe(true);
    expect(result.status).toBe("installed");
    const installed = result.cfg.plugins?.installs?.["demo-plugin"] as
      | PluginInstallRecord
      | undefined;
    expect(installed?.pluginId).toBe("demo-plugin");
    expect(installed?.source).toBe("npm");
    expect(installed?.spec).toBe("@wecom/wecom-openclaw-plugin@1.2.3");
    expect(clearLoadInstalledPluginIndexInstallRecordsCache).toHaveBeenCalledOnce();
    expect(clearPluginMetadataLifecycleCaches).toHaveBeenCalledOnce();
    expect(invalidatePluginRuntimeDiscoveryAfterConfigMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        logger: expect.objectContaining({ warn: expect.any(Function) }),
      }),
    );
  });

  it.each(["@openclaw/discord", "@openclaw/discord@latest"])(
    "installs trusted official intent %s at the exact extended-stable core version",
    async (spec) => {
      coreVersion.value = "2026.7.33";
      installPluginFromNpmSpec.mockResolvedValueOnce({
        ok: true,
        pluginId: "discord",
        targetDir: "/tmp/discord",
        version: VERSION,
        npmResolution: {
          name: "@openclaw/discord",
          version: VERSION,
          resolvedSpec: `@openclaw/discord@${VERSION}`,
        },
      });

      await ensureOnboardingPluginInstalled({
        cfg: { update: { channel: "extended-stable" } },
        entry: {
          pluginId: "discord",
          label: "Discord",
          install: { npmSpec: spec },
          trustedSourceLinkedOfficialInstall: true,
        },
        prompter: {
          select: vi.fn(async () => "npm"),
          progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
        } as never,
        runtime: {} as never,
        promptInstall: false,
      });

      const [npmCall] = readFirstMockCall(installPluginFromNpmSpec, "installPluginFromNpmSpec") as [
        NpmSpecInstallCall,
      ];
      expect(npmCall.spec).toBe(`@openclaw/discord@${VERSION}`);
      const [, recordUpdate] = readFirstMockCall(recordPluginInstall, "recordPluginInstall") as [
        OpenClawConfig,
        PluginInstallRecord,
      ];
      expect(recordUpdate.spec).toBe(spec);
    },
  );

  it("preserves default intent for trusted official stable installs", async () => {
    installPluginFromNpmSpec.mockResolvedValueOnce({
      ok: true,
      pluginId: "discord",
      targetDir: "/tmp/discord",
      version: "2026.7.21",
      npmResolution: {
        name: "@openclaw/discord",
        version: "2026.7.21",
        resolvedSpec: "@openclaw/discord@2026.7.21",
      },
    });

    await ensureOnboardingPluginInstalled({
      cfg: { update: { channel: "stable" } },
      entry: {
        pluginId: "discord",
        label: "Discord",
        install: { npmSpec: "@openclaw/discord" },
        trustedSourceLinkedOfficialInstall: true,
      },
      prompter: {
        select: vi.fn(async () => "npm"),
        progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
      } as never,
      runtime: {} as never,
      promptInstall: false,
    });

    const [, recordUpdate] = readFirstMockCall(recordPluginInstall, "recordPluginInstall") as [
      OpenClawConfig,
      PluginInstallRecord,
    ];
    expect(recordUpdate.spec).toBe("@openclaw/discord");
  });

  it.each(
    (
      [
        { version: "2026.8.1", channel: undefined, installVersion: "2026.8.1" },
        { version: "2026.8.1", channel: "stable", installVersion: "2026.8.1" },
        { version: "2026.8.1-2", channel: "stable", installVersion: "2026.8.1" },
        { version: "2026.7.33-1", channel: "extended-stable", installVersion: "2026.7.33" },
        { version: "2026.8.1", channel: "beta", installVersion: "beta" },
        { version: "2026.8.1-beta.4", channel: undefined, installVersion: "2026.8.1-beta.4" },
        { version: "2026.8.1-beta.4", channel: "stable", installVersion: "2026.8.1-beta.4" },
      ] as const
    ).flatMap(({ version, channel, installVersion }) =>
      ["@openclaw/codex", "@openclaw/codex@latest"].map((spec) => ({
        version,
        channel,
        installVersion,
        spec,
      })),
    ),
  )(
    "aligns version-bound plugins from $spec on core $version with channel $channel",
    async ({ version, channel, installVersion, spec }) => {
      coreVersion.value = version;
      installPluginFromNpmSpec.mockResolvedValueOnce({
        ok: true,
        pluginId: "codex",
        targetDir: "/tmp/codex",
        version: VERSION,
        npmResolution: {
          name: "@openclaw/codex",
          version: VERSION,
          resolvedSpec: `@openclaw/codex@${VERSION}`,
        },
      });

      await ensureOnboardingPluginInstalled({
        cfg: channel ? { update: { channel } } : {},
        entry: {
          pluginId: "codex",
          label: "Codex",
          install: { npmSpec: spec },
          trustedSourceLinkedOfficialInstall: true,
          versionBoundToOpenClaw: true,
        },
        prompter: {
          select: vi.fn(async () => "npm"),
          progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
        } as never,
        runtime: {} as never,
        promptInstall: false,
      });

      const [npmCall] = readFirstMockCall(installPluginFromNpmSpec, "installPluginFromNpmSpec") as [
        NpmSpecInstallCall,
      ];
      expect(npmCall.spec).toBe(`@openclaw/codex@${installVersion}`);
      const [, recordUpdate] = readFirstMockCall(recordPluginInstall, "recordPluginInstall") as [
        OpenClawConfig,
        PluginInstallRecord,
      ];
      expect(recordUpdate.spec).toBe(spec);
    },
  );

  it("preserves npm install warnings in progress and logs them once", async () => {
    const warning =
      "npm rejected managed npm alias overrides; retrying plugin install without alias overrides for this npm version.";
    installPluginFromNpmSpec.mockImplementation(async (params) => {
      params.logger?.warn?.(warning);
      return {
        ok: true,
        pluginId: "codex",
        targetDir: "/tmp/openclaw/extensions/codex",
        version: "2026.5.10-beta.5",
      };
    });
    const log = vi.fn();
    const stop = vi.fn();
    const update = vi.fn();

    const result = await ensureOnboardingPluginInstalled({
      cfg: {},
      entry: {
        pluginId: "codex",
        label: "Codex",
        install: {
          npmSpec: "@openclaw/codex@beta",
        },
      },
      prompter: {
        select: vi.fn(async () => "npm"),
        progress: vi.fn(() => ({ update, stop })),
      } as never,
      runtime: { log } as never,
    });

    expect(update).toHaveBeenCalledWith(warning);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(`${warning}\n`);
    expect(stop).toHaveBeenCalledWith("Installed Codex plugin");
    expect(result.status).toBe("installed");
  });

  it("cancels a timed out npm install before returning and releasing its lease", async () => {
    const note = vi.fn(async () => {});
    const stop = vi.fn();
    let installSignal: AbortSignal | undefined;
    let releaseCleanup = () => {};
    let leaseActive = false;
    const cleanupGate = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    let observeAbort = () => {};
    const abortObserved = new Promise<void>((resolve) => {
      observeAbort = resolve;
    });
    withPluginLifecycleLease.mockImplementationOnce(async (_options, run) => {
      leaseActive = true;
      try {
        return await run();
      } finally {
        leaseActive = false;
      }
    });
    installPluginFromNpmSpec.mockImplementationOnce(async (params: { signal?: AbortSignal }) => {
      installSignal = params.signal;
      await new Promise<void>((resolve) => {
        params.signal?.addEventListener(
          "abort",
          () => {
            observeAbort();
            resolve();
          },
          { once: true },
        );
      });
      await cleanupGate;
      return { ok: false, error: "installer canceled" };
    });
    withTimeout.mockRejectedValue(new Error("timeout"));

    const pendingResult = ensureOnboardingPluginInstalled({
      cfg: {},
      entry: {
        pluginId: "demo-plugin",
        label: "Demo Plugin",
        install: {
          npmSpec: "@demo/plugin@1.2.3",
          expectedIntegrity: "sha512-demo",
        },
      },
      prompter: {
        select: vi.fn(async () => "npm"),
        note,
        progress: vi.fn(() => ({ update: vi.fn(), stop })),
      } as never,
      runtime: {
        error: vi.fn(),
      } as never,
    });
    let returned = false;
    void pendingResult.then(() => {
      returned = true;
    });

    await abortObserved;
    expect(installSignal?.aborted).toBe(true);
    expect(leaseActive).toBe(true);
    expect(returned).toBe(false);

    releaseCleanup();
    const result = await pendingResult;

    expect(leaseActive).toBe(false);
    expect(result).toEqual({
      cfg: {},
      installed: false,
      pluginId: "demo-plugin",
      status: "timed_out",
    });
    expect(clearLoadInstalledPluginIndexInstallRecordsCache).not.toHaveBeenCalled();
    expect(clearPluginMetadataLifecycleCaches).not.toHaveBeenCalled();
    expect(invalidatePluginRuntimeDiscoveryAfterConfigMutation).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledWith("Install timed out: Demo Plugin");
    expect(note).toHaveBeenCalledWith(
      "Installing @demo/plugin@1.2.3 timed out after 5 minutes.\nReturning to selection.",
      "Plugin install",
    );
  });

  it("offers registry npm specs without requiring an exact version or integrity pin", async () => {
    let captured:
      | {
          options: Array<{
            value: "clawhub" | "npm" | "local" | "skip";
            label: string;
            hint?: string;
          }>;
          initialValue: "clawhub" | "npm" | "local" | "skip";
        }
      | undefined;

    await ensureOnboardingPluginInstalled({
      cfg: {},
      entry: {
        pluginId: "demo-plugin",
        label: "Demo Plugin",
        install: {
          npmSpec: "@demo/plugin",
        },
      },
      prompter: {
        select: vi.fn(async (input) => {
          captured = input;
          return "skip";
        }),
      } as never,
      runtime: {} as never,
    });

    expect(captured?.options).toEqual([
      { value: "npm", label: "Download from npm (@demo/plugin)" },
      { value: "skip", label: "Skip for now" },
    ]);
    expect(captured?.initialValue).toBe("npm");
    expect(installPluginFromNpmSpec).not.toHaveBeenCalled();
  });

  it("defaults dual-source remote installs to npm unless ClawHub is explicit", async () => {
    let captured:
      | {
          options: Array<{
            value: "clawhub" | "npm" | "local" | "skip";
            label: string;
            hint?: string;
          }>;
          initialValue: "clawhub" | "npm" | "local" | "skip";
        }
      | undefined;

    await ensureOnboardingPluginInstalled({
      cfg: {},
      entry: {
        pluginId: "demo-plugin",
        label: "Demo Plugin",
        install: {
          clawhubSpec: "clawhub:demo-plugin@2026.5.2",
          npmSpec: "@openclaw/demo-plugin@2026.5.2",
        },
      },
      prompter: {
        select: vi.fn(async (input) => {
          captured = input;
          return "skip";
        }),
      } as never,
      runtime: {} as never,
    });

    expect(captured?.options).toEqual([
      { value: "npm", label: "Download from npm (@openclaw/demo-plugin@2026.5.2)" },
      { value: "clawhub", label: "Download from ClawHub (clawhub:demo-plugin@2026.5.2)" },
      { value: "skip", label: "Skip for now" },
    ]);
    expect(captured?.initialValue).toBe("npm");
    expect(installPluginFromClawHub).not.toHaveBeenCalled();
    expect(installPluginFromNpmSpec).not.toHaveBeenCalled();
  });

  it("uses npm before historical ClawHub defaults for dual-source remote installs", async () => {
    let captured:
      | {
          initialValue: "clawhub" | "npm" | "local" | "skip";
        }
      | undefined;

    await ensureOnboardingPluginInstalled({
      cfg: { update: { channel: "stable" } },
      entry: {
        pluginId: "demo-plugin",
        label: "Demo Plugin",
        install: {
          clawhubSpec: "clawhub:demo-plugin@2026.5.2",
          npmSpec: "@openclaw/demo-plugin@2026.5.2",
          defaultChoice: "clawhub",
        },
      },
      prompter: {
        select: vi.fn(async (input) => {
          captured = input;
          return "skip";
        }),
      } as never,
      runtime: {} as never,
    });

    expect(captured?.initialValue).toBe("npm");
  });

  it.each([
    {
      name: "explicit stable selector",
      version: "2026.8.1",
      npmSpec: "@openclaw/demo-plugin@2026.5.2",
      clawhubSpec: "clawhub:demo-plugin@2026.5.2",
      expectedNpmSpecs: ["@openclaw/demo-plugin@2026.5.2"],
      expectedClawHubSpec: "clawhub:demo-plugin@2026.5.2",
      installVersion: "2026.5.2",
      trustedSourceLinkedOfficialInstall: false,
    },
    {
      name: "official beta core",
      version: "2026.8.1-beta.3",
      npmSpec: "@openclaw/demo-plugin",
      clawhubSpec: "clawhub:demo-plugin",
      expectedNpmSpecs: ["@openclaw/demo-plugin@2026.8.1-beta.3", "@openclaw/demo-plugin"],
      expectedClawHubSpec: "clawhub:demo-plugin@2026.8.1-beta.3",
      installVersion: "2026.8.1-beta.3",
      trustedSourceLinkedOfficialInstall: true,
    },
  ])(
    "uses the declared ClawHub secondary when npm is absent ($name)",
    async ({
      version,
      npmSpec,
      clawhubSpec,
      expectedNpmSpecs,
      expectedClawHubSpec,
      installVersion,
      trustedSourceLinkedOfficialInstall,
    }) => {
      coreVersion.value = version;
      for (const spec of expectedNpmSpecs) {
        installPluginFromNpmSpec.mockResolvedValueOnce({
          ok: false,
          code: "npm_package_not_found",
          error: `npm artifact absent: ${spec}`,
        });
      }
      installPluginFromClawHub.mockResolvedValueOnce({
        ok: true,
        pluginId: "demo-plugin",
        targetDir: "/tmp/demo-plugin",
        version: installVersion,
        clawhub: {
          source: "clawhub",
          clawhubPackage: "demo-plugin",
          version: installVersion,
        },
      });

      const result = await ensureOnboardingPluginInstalled({
        cfg: {},
        entry: {
          pluginId: "demo-plugin",
          label: "Demo Plugin",
          install: {
            clawhubSpec,
            npmSpec,
            defaultChoice: "clawhub",
          },
          trustedSourceLinkedOfficialInstall,
        },
        prompter: {
          select: vi.fn(async () => "clawhub"),
          confirm: vi.fn(async () => true),
          note: vi.fn(async () => {}),
          progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
        } as never,
        runtime: {} as never,
        promptInstall: false,
      });

      const npmCalls = installPluginFromNpmSpec.mock.calls as [NpmSpecInstallCall][];
      expect(npmCalls.map(([call]) => call.spec)).toEqual(expectedNpmSpecs);
      const [npmCall] = readFirstMockCall(installPluginFromNpmSpec, "installPluginFromNpmSpec") as [
        NpmSpecInstallCall,
      ];
      expect(npmCall.expectedPluginId).toBe("demo-plugin");
      expect(installPluginFromClawHub).toHaveBeenCalledOnce();
      const [clawhubCall] = readFirstMockCall(
        installPluginFromClawHub,
        "installPluginFromClawHub",
      ) as [ClawHubInstallCall];
      expect(clawhubCall.spec).toBe(expectedClawHubSpec);
      expect(clawhubCall.expectedPluginId).toBe("demo-plugin");
      const [, record] = readFirstMockCall(recordPluginInstall, "recordPluginInstall") as [
        OpenClawConfig,
        PluginInstallRecord,
      ];
      expect(record.source).toBe("clawhub");
      expect(record.spec).toBe(clawhubSpec);
      expect(record.version).toBe(installVersion);
      expect(result.installed).toBe(true);
    },
  );

  it("does not fall back from ClawHub to non-OpenClaw npm packages", async () => {
    const confirm = vi.fn(async () => true);
    const runtimeError = vi.fn();
    installPluginFromClawHub.mockResolvedValueOnce({
      ok: false,
      code: "artifact_download_unavailable",
      error: "ClawHub ClawPack artifact is unavailable.",
    });

    const result = await ensureOnboardingPluginInstalled({
      cfg: {},
      entry: {
        pluginId: "demo-plugin",
        label: "Demo Plugin",
        install: {
          clawhubSpec: "clawhub:demo-plugin@2026.5.2",
          npmSpec: "@someone-else/demo-plugin@2026.5.2",
          defaultChoice: "clawhub",
        },
      },
      prompter: {
        select: vi.fn(async () => "clawhub"),
        confirm,
        note: vi.fn(async () => {}),
        progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
      } as never,
      runtime: { error: runtimeError } as never,
      promptInstall: true,
    });

    expect(confirm).not.toHaveBeenCalled();
    expect(installPluginFromNpmSpec).not.toHaveBeenCalled();
    expect(runtimeError).toHaveBeenCalledWith(
      "Plugin install failed: ClawHub ClawPack artifact is unavailable.",
    );
    expect(result).toStrictEqual({
      cfg: {},
      installed: false,
      pluginId: "demo-plugin",
      status: "failed",
      error: "ClawHub ClawPack artifact is unavailable.",
    });
  });

  it("does not fall back from ClawHub to npm when ClawHub verification fails", async () => {
    const confirm = vi.fn(async () => true);
    const runtimeError = vi.fn();
    installPluginFromClawHub.mockResolvedValueOnce({
      ok: false,
      code: "archive_integrity_mismatch",
      error: "ClawHub ClawPack integrity mismatch.",
    });

    const result = await ensureOnboardingPluginInstalled({
      cfg: {},
      entry: {
        pluginId: "demo-plugin",
        label: "Demo Plugin",
        install: {
          clawhubSpec: "clawhub:demo-plugin@2026.5.2",
          npmSpec: "@openclaw/demo-plugin@2026.5.2",
          defaultChoice: "clawhub",
        },
      },
      prompter: {
        select: vi.fn(async () => "clawhub"),
        confirm,
        note: vi.fn(async () => {}),
        progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
      } as never,
      runtime: { error: runtimeError } as never,
      promptInstall: true,
    });

    expect(confirm).not.toHaveBeenCalled();
    expect(installPluginFromNpmSpec).not.toHaveBeenCalled();
    expect(runtimeError).toHaveBeenCalledWith(
      "Plugin install failed: ClawHub ClawPack integrity mismatch.",
    );
    expect(result).toEqual({
      cfg: {},
      installed: false,
      pluginId: "demo-plugin",
      status: "failed",
      error: "ClawHub ClawPack integrity mismatch.",
    });
  });

  it("returns bounded multiline ClawHub failure detail to non-interactive callers", async () => {
    const runtimeError = vi.fn();
    const summaryPrefix = "x".repeat(178);
    installPluginFromClawHub.mockResolvedValueOnce({
      ok: false,
      code: "archive_integrity_mismatch",
      error: `Install failed: ${summaryPrefix}🚀tail\tvalue[31m\nsecond\tline\n${"y".repeat(20_000)}`,
    });

    const result = await ensureOnboardingPluginInstalled({
      cfg: {},
      entry: {
        pluginId: "demo-plugin",
        label: "Demo Plugin",
        install: {
          clawhubSpec: "clawhub:demo-plugin@2026.5.2",
          defaultChoice: "clawhub",
        },
      },
      prompter: {
        select: vi.fn(async () => "clawhub"),
        confirm: vi.fn(async () => true),
        note: vi.fn(async () => {}),
        progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
      } as never,
      runtime: { error: runtimeError } as never,
      promptInstall: false,
    });

    expect(result.error).toMatch(/^Install failed: x{178}🚀tail/);
    expect(result.error).toContain("\\tvalue");
    expect(result.error).toContain("\nsecond\\tline\n");
    expect(result.error).not.toContain("");
    expect(result.error?.endsWith("\n… (installer output truncated)")).toBe(true);
    expect(result.error?.length).toBe(12_000);
    const runtimeMessage = String(readFirstMockCall(runtimeError, "runtime.error")[0]);
    expect(runtimeMessage).toContain(`${summaryPrefix}…`);
    expect(runtimeMessage).not.toContain("");
  });

  it("does not offer local installs when the workspace only has a spoofed .git marker", async () => {
    await withTestDir({ prefix: "openclaw-onboarding-install-spoofed-git-" }, async (temp) => {
      const workspaceDir = path.join(temp, "workspace");
      const cwdDir = path.join(temp, "cwd");
      const pluginDir = path.join(workspaceDir, "plugins", "demo");
      await fs.mkdir(pluginDir, { recursive: true });
      await fs.mkdir(cwdDir, { recursive: true });
      await fs.writeFile(path.join(workspaceDir, ".git"), "not-a-gitdir-pointer\n", "utf8");

      let captured:
        | {
            message: string;
            options: Array<{
              value: "clawhub" | "npm" | "local" | "skip";
              label: string;
              hint?: string;
            }>;
            initialValue: "clawhub" | "npm" | "local" | "skip";
          }
        | undefined;

      const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(cwdDir);
      let result: Awaited<ReturnType<typeof ensureOnboardingPluginInstalled>> | undefined;
      try {
        result = await ensureOnboardingPluginInstalled({
          cfg: {},
          entry: {
            pluginId: "demo-plugin",
            label: "Demo Plugin",
            install: {
              localPath: "plugins/demo",
            },
          },
          prompter: {
            select: vi.fn(async (input) => {
              captured = input;
              return "skip";
            }),
          } as never,
          runtime: {} as never,
          workspaceDir,
        });
      } finally {
        cwdSpy.mockRestore();
      }

      const prompt = requireCapturedPrompt(captured);
      expect(prompt.message).toBe("Install Demo Plugin plugin?");
      expect(prompt.options).toEqual([{ value: "skip", label: "Skip for now" }]);
      expect(result).toEqual({
        cfg: {},
        installed: false,
        pluginId: "demo-plugin",
        status: "skipped",
      });
    });
  });

  it("allows local installs for real gitdir checkouts and sanitizes prompt text", async () => {
    await withTestDir({ prefix: "openclaw-onboarding-install-gitdir-" }, async (temp) => {
      const workspaceDir = path.join(temp, "workspace");
      const pluginDir = path.join(workspaceDir, "plugins", "demo");
      await fs.mkdir(pluginDir, { recursive: true });
      await fs.mkdir(path.join(workspaceDir, ".git"), { recursive: true });

      let captured:
        | {
            message: string;
            options: Array<{
              value: "clawhub" | "npm" | "local" | "skip";
              label: string;
              hint?: string;
            }>;
            initialValue: "clawhub" | "npm" | "local" | "skip";
          }
        | undefined;

      await ensureOnboardingPluginInstalled({
        cfg: {},
        entry: {
          pluginId: "demo-plugin",
          label: "Demo\x1b[31m Plugin\n",
          install: {
            npmSpec: "@demo/plugin@1.2.3",
            expectedIntegrity: "sha512-demo",
            localPath: "plugins/demo",
          },
        },
        prompter: {
          select: vi.fn(async (input) => {
            captured = input;
            return "skip";
          }),
        } as never,
        runtime: {} as never,
        workspaceDir,
      });

      const realPluginDir = await fs.realpath(pluginDir);
      const prompt = requireCapturedPrompt(captured);
      expect(prompt.message).toBe("Install Demo Plugin\\n plugin?");
      expect(prompt.options).toEqual([
        { value: "npm", label: "Download from npm (@demo/plugin@1.2.3)" },
        {
          value: "local",
          label: "Use local plugin path",
          hint: realPluginDir,
        },
        { value: "skip", label: "Skip for now" },
      ]);
      expect(prompt.message).not.toContain("\x1b");
      expect(prompt.options[0]?.label).not.toContain("\x1b");
      expect(clearPluginMetadataLifecycleCaches).not.toHaveBeenCalled();
    });
  });

  it("does not add local plugin paths when enablement is blocked by policy", async () => {
    await withTestDir({ prefix: "openclaw-onboarding-install-blocked-enable-" }, async (temp) => {
      const workspaceDir = path.join(temp, "workspace");
      const pluginDir = path.join(workspaceDir, "plugins", "demo");
      await fs.mkdir(pluginDir, { recursive: true });
      await fs.mkdir(path.join(workspaceDir, ".git"), { recursive: true });
      enablePluginInConfig.mockReturnValueOnce({
        config: {},
        enabled: false,
        pluginId: "demo",
        reason: "blocked by allowlist",
      });
      const note = vi.fn(async () => {});
      const error = vi.fn();

      const result = await ensureOnboardingPluginInstalled({
        cfg: {},
        entry: {
          pluginId: "demo-plugin",
          label: "Demo Plugin",
          install: {
            localPath: "plugins/demo",
          },
        },
        prompter: {
          select: vi.fn(async () => "local"),
          note,
        } as never,
        runtime: { error } as never,
        workspaceDir,
      });

      expect(result).toEqual({
        cfg: {},
        installed: false,
        pluginId: "demo-plugin",
        status: "failed",
      });
      expect(note).toHaveBeenCalledWith(
        "Cannot enable Demo Plugin: blocked by allowlist.",
        "Plugin install",
      );
      expect(error).toHaveBeenCalledWith(
        "Plugin install failed: demo-plugin is disabled (blocked by allowlist).",
      );
    });
  });

  it("allows local installs for linked git worktrees", async () => {
    await withTestDir({ prefix: "openclaw-onboarding-install-worktree-" }, async (temp) => {
      const workspaceDir = path.join(temp, "workspace");
      const pluginDir = path.join(workspaceDir, "plugins", "demo");
      const commonGitDir = path.join(temp, "repo.git");
      await fs.mkdir(pluginDir, { recursive: true });
      await fs.mkdir(commonGitDir, { recursive: true });
      const realCommonGitDir = await fs.realpath(commonGitDir);
      await fs.writeFile(path.join(workspaceDir, ".git"), `gitdir: ${realCommonGitDir}\n`, "utf8");

      let captured:
        | {
            message: string;
            options: Array<{
              value: "clawhub" | "npm" | "local" | "skip";
              label: string;
              hint?: string;
            }>;
            initialValue: "clawhub" | "npm" | "local" | "skip";
          }
        | undefined;

      await ensureOnboardingPluginInstalled({
        cfg: {},
        entry: {
          pluginId: "demo-plugin",
          label: "Demo Plugin",
          install: {
            localPath: "plugins/demo",
          },
        },
        prompter: {
          select: vi.fn(async (input) => {
            captured = input;
            return "skip";
          }),
        } as never,
        runtime: {} as never,
        workspaceDir,
      });

      const realPluginDir = await fs.realpath(pluginDir);
      expect(captured?.options).toEqual([
        {
          value: "local",
          label: "Use local plugin path",
          hint: realPluginDir,
        },
        { value: "skip", label: "Skip for now" },
      ]);
      expect(captured?.initialValue).toBe("local");
    });
  });

  it("records local install source metadata when a local path is selected", async () => {
    await withTestDir({ prefix: "openclaw-onboarding-install-local-record-" }, async (temp) => {
      const workspaceDir = path.join(temp, "workspace");
      const pluginDir = path.join(workspaceDir, "plugins", "demo");
      await fs.mkdir(path.join(workspaceDir, ".git"), { recursive: true });
      await fs.mkdir(pluginDir, { recursive: true });

      const result = await ensureOnboardingPluginInstalled({
        cfg: {},
        entry: {
          pluginId: "demo-plugin",
          label: "Demo Plugin",
          install: {
            npmSpec: "@demo/plugin@1.2.3",
            localPath: "plugins/demo",
          },
        },
        prompter: {
          select: vi.fn(async () => "local"),
        } as never,
        runtime: {} as never,
        workspaceDir,
      });

      const realPluginDir = await fs.realpath(pluginDir);
      const [recordCfg, recordUpdate] = readFirstMockCall(
        recordPluginInstall,
        "recordPluginInstall",
      ) as [OpenClawConfig, PluginInstallRecord];
      expect(recordCfg.plugins?.load?.paths).toEqual([realPluginDir]);
      expect(recordUpdate).toEqual({
        pluginId: "demo-plugin",
        source: "path",
        installPath: realPluginDir,
        sourcePath: "./plugins/demo",
        spec: "@demo/plugin@1.2.3",
      });
      expect(result.installed).toBe(true);
      expect(result.status).toBe("installed");
      expect(clearLoadInstalledPluginIndexInstallRecordsCache).toHaveBeenCalledOnce();
      expect(clearPluginMetadataLifecycleCaches).toHaveBeenCalledOnce();
      expect(invalidatePluginRuntimeDiscoveryAfterConfigMutation).toHaveBeenCalledWith(
        expect.objectContaining({
          logger: expect.objectContaining({ warn: expect.any(Function) }),
        }),
      );
      expect(result.cfg.plugins?.installs).toEqual({
        "demo-plugin": {
          pluginId: "demo-plugin",
          source: "path",
          installPath: realPluginDir,
          sourcePath: "./plugins/demo",
          spec: "@demo/plugin@1.2.3",
        },
      });
    });
  });

  it("hides the npm download option for bundled plugins so the menu matches non-npm channels", async () => {
    await withTestDir({ prefix: "openclaw-onboarding-install-bundled-prompt-" }, async (temp) => {
      const bundledDir = path.join(temp, "dist", "extensions", "tlon");
      await fs.mkdir(bundledDir, { recursive: true });
      const realBundledDir = await fs.realpath(bundledDir);
      // Both code paths that surface a bundled plugin to the install
      // pipeline must agree on the local path: the catalog-driven
      // resolver (used when an npm spec is present) and the pluginId
      // fallback. We stub both so the prompt sees a stable bundled path.
      resolveBundledInstallPlanForCatalogEntry.mockReturnValue({
        bundledSource: { localPath: realBundledDir },
      });
      findBundledPluginSourceInMap.mockReturnValue({ localPath: realBundledDir });

      let captured:
        | {
            message: string;
            options: Array<{
              value: "clawhub" | "npm" | "local" | "skip";
              label: string;
              hint?: string;
            }>;
            initialValue: "clawhub" | "npm" | "local" | "skip";
          }
        | undefined;

      await ensureOnboardingPluginInstalled({
        cfg: {},
        entry: {
          pluginId: "tlon",
          label: "Tlon",
          install: {
            npmSpec: "@openclaw/tlon",
            defaultChoice: "npm",
          },
        },
        prompter: {
          select: vi.fn(async (input) => {
            captured = input;
            return "skip";
          }),
        } as never,
        runtime: {} as never,
      });

      const prompt = requireCapturedPrompt(captured);
      // "Download from npm (@openclaw/tlon)" must NOT appear: the bundled
      // copy is what gets enabled, so the npm hint would only confuse
      // users into thinking the plugin is missing.
      expect(prompt.options).toEqual([
        {
          value: "local",
          label: "Use local plugin path",
          hint: realBundledDir,
        },
        { value: "skip", label: "Skip for now" },
      ]);
      expect(prompt.initialValue).toBe("local");
      findBundledPluginSourceInMap.mockReset();
      resolveBundledInstallPlanForCatalogEntry.mockReset();
    });
  });

  it("enables bundled plugins without adding their bundled directory as a local install", async () => {
    await withTestDir({ prefix: "openclaw-onboarding-install-bundled-record-" }, async (temp) => {
      const bundledDir = path.join(temp, "dist", "extensions", "discord");
      await fs.mkdir(bundledDir, { recursive: true });
      const realBundledDir = await fs.realpath(bundledDir);
      resolveBundledInstallPlanForCatalogEntry.mockReturnValueOnce({
        bundledSource: {
          localPath: realBundledDir,
        },
      });
      enablePluginInConfig.mockReturnValueOnce({
        config: {
          plugins: {
            entries: {
              discord: { enabled: true },
            },
          },
        },
        enabled: true,
        pluginId: "discord",
      });

      const result = await ensureOnboardingPluginInstalled({
        cfg: {},
        entry: {
          pluginId: "discord",
          label: "Discord",
          install: {
            npmSpec: "@openclaw/discord",
          },
        },
        prompter: {
          select: vi.fn(async () => "local"),
        } as never,
        runtime: {} as never,
        promptInstall: false,
      });

      expect(result.installed).toBe(true);
      expect(result.cfg.plugins?.entries?.discord?.enabled).toBe(true);
      expect(result.cfg.plugins?.load?.paths).toBeUndefined();
      expect(result.cfg.plugins?.installs).toBeUndefined();
      expect(recordPluginInstall).not.toHaveBeenCalled();
    });
  });

  it("records local install source metadata when npm install falls back to local", async () => {
    await withTestDir(
      { prefix: "openclaw-onboarding-install-npm-fallback-record-" },
      async (temp) => {
        const workspaceDir = path.join(temp, "workspace");
        const pluginDir = path.join(workspaceDir, "plugins", "demo");
        await fs.mkdir(path.join(workspaceDir, ".git"), { recursive: true });
        await fs.mkdir(pluginDir, { recursive: true });
        installPluginFromNpmSpec.mockResolvedValueOnce({
          ok: false,
          code: "npm_package_not_found",
          error: "registry unavailable",
        });
        const note = vi.fn(async () => {});

        const result = await ensureOnboardingPluginInstalled({
          cfg: {},
          entry: {
            pluginId: "demo-plugin",
            label: "Demo Plugin",
            install: {
              npmSpec: "@demo/plugin@1.2.3",
              localPath: "plugins/demo",
            },
          },
          prompter: {
            select: vi.fn(async () => "npm"),
            note,
            confirm: vi.fn(async () => true),
            progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
          } as never,
          runtime: {} as never,
          workspaceDir,
        });

        const realPluginDir = await fs.realpath(pluginDir);
        expect(note).toHaveBeenCalledWith(
          "Failed to install @demo/plugin@1.2.3: registry unavailable\nReturning to selection.",
          "Plugin install",
        );
        const [recordCfg, recordUpdate] = readFirstMockCall(
          recordPluginInstall,
          "recordPluginInstall",
        ) as [OpenClawConfig, PluginInstallRecord];
        expect(recordCfg.plugins?.load?.paths).toEqual([realPluginDir]);
        expect(recordUpdate).toEqual({
          pluginId: "demo-plugin",
          source: "path",
          installPath: realPluginDir,
          sourcePath: "./plugins/demo",
          spec: "@demo/plugin@1.2.3",
        });
        expect(result.installed).toBe(true);
        expect(result.status).toBe("installed");
        expect(result.cfg.plugins?.installs).toEqual({
          "demo-plugin": {
            pluginId: "demo-plugin",
            source: "path",
            installPath: realPluginDir,
            sourcePath: "./plugins/demo",
            spec: "@demo/plugin@1.2.3",
          },
        });
      },
    );
  });

  it("records absolute local catalog paths as workspace-relative source metadata", async () => {
    await withTestDir({ prefix: "openclaw-onboarding-install-portable-record-" }, async (temp) => {
      const workspaceDir = path.join(temp, "workspace");
      const pluginDir = path.join(workspaceDir, "plugins", "demo");
      await fs.mkdir(path.join(workspaceDir, ".git"), { recursive: true });
      await fs.mkdir(pluginDir, { recursive: true });
      const realPluginDir = await fs.realpath(pluginDir);

      await ensureOnboardingPluginInstalled({
        cfg: {},
        entry: {
          pluginId: "demo-plugin",
          label: "Demo Plugin",
          install: {
            localPath: realPluginDir,
          },
        },
        prompter: {
          select: vi.fn(async () => "local"),
        } as never,
        runtime: {} as never,
        workspaceDir,
      });

      const [recordCfg, recordUpdate] = readFirstMockCall(
        recordPluginInstall,
        "recordPluginInstall",
      ) as [OpenClawConfig, PluginInstallRecord];
      expect(recordCfg).toEqual({
        plugins: {
          load: {
            paths: [realPluginDir],
          },
        },
      });
      expect(recordUpdate).toEqual({
        pluginId: "demo-plugin",
        source: "path",
        installPath: realPluginDir,
        sourcePath: "./plugins/demo",
      });
    });
  });

  it("keeps local installs available when cwd is a git repo but workspaceDir is not", async () => {
    await withTestDir({ prefix: "openclaw-onboarding-install-cwd-git-" }, async (temp) => {
      const repoDir = path.join(temp, "repo");
      const workspaceDir = path.join(temp, "workspace");
      const pluginDir = path.join(repoDir, "demo-plugin");
      await fs.mkdir(path.join(repoDir, ".git"), { recursive: true });
      await fs.mkdir(pluginDir, { recursive: true });
      await fs.mkdir(workspaceDir, { recursive: true });

      let captured:
        | {
            options: Array<{
              value: "clawhub" | "npm" | "local" | "skip";
              label: string;
              hint?: string;
            }>;
          }
        | undefined;
      const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(repoDir);
      try {
        await ensureOnboardingPluginInstalled({
          cfg: {},
          entry: {
            pluginId: "demo-plugin",
            label: "Demo Plugin",
            install: {
              localPath: pluginDir,
            },
          },
          prompter: {
            select: vi.fn(async (input) => {
              captured = input;
              return "skip";
            }),
          } as never,
          runtime: {} as never,
          workspaceDir,
        });
      } finally {
        cwdSpy.mockRestore();
      }

      const realPluginDir = await fs.realpath(pluginDir);
      expect(captured?.options).toEqual([
        {
          value: "local",
          label: "Use local plugin path",
          hint: realPluginDir,
        },
        { value: "skip", label: "Skip for now" },
      ]);
    });
  });

  it("rejects local install paths outside the trusted workspace roots", async () => {
    await withTestDir({ prefix: "openclaw-onboarding-install-outside-root-" }, async (temp) => {
      const workspaceDir = path.join(temp, "workspace");
      const pluginDir = path.join(temp, "external-plugin");
      await fs.mkdir(path.join(workspaceDir, ".git"), { recursive: true });
      await fs.mkdir(pluginDir, { recursive: true });

      let captured:
        | {
            options: Array<{
              value: "clawhub" | "npm" | "local" | "skip";
              label: string;
              hint?: string;
            }>;
          }
        | undefined;

      await ensureOnboardingPluginInstalled({
        cfg: {},
        entry: {
          pluginId: "demo-plugin",
          label: "Demo Plugin",
          install: {
            localPath: pluginDir,
          },
        },
        prompter: {
          select: vi.fn(async (input) => {
            captured = input;
            return "skip";
          }),
        } as never,
        runtime: {} as never,
        workspaceDir,
      });

      expect(captured?.options).toEqual([{ value: "skip", label: "Skip for now" }]);
    });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
