import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveRegistryUpdateChannel } from "../infra/update-channels.js";
import type { PluginEnableResult } from "../plugins/enable.js";
import { resolveNpmInstallSpecsForUpdateChannel } from "../plugins/install-channel-specs.js";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { VERSION } from "../version.js";

function expectedNpmInstallSpec(spec: string): string {
  return resolveNpmInstallSpecsForUpdateChannel({
    spec,
    updateChannel: resolveRegistryUpdateChannel({ currentVersion: VERSION }),
  }).installSpec;
}

const resolveBundledInstallPlanForCatalogEntry = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => unknown>(() => undefined),
);
vi.mock("../cli/plugin-install-plan.js", () => ({
  resolveBundledInstallPlanForCatalogEntry,
}));

const refreshPluginRegistryAfterConfigMutation = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../cli/plugins-registry-refresh.js", () => ({
  refreshPluginRegistryAfterConfigMutation,
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
vi.mock("../plugins/installs.js", () => ({
  recordPluginInstall,
  buildNpmResolutionInstallFields,
}));

const withTimeout = vi.hoisted(() => vi.fn(async <T>(promise: Promise<T>) => await promise));
vi.mock("../utils/with-timeout.js", () => ({
  withTimeout,
}));

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
  expectedPluginId?: string;
  trustedSourceLinkedOfficialInstall?: boolean;
};

type NpmSpecInstallCall = {
  expectedIntegrity?: string;
  expectedPluginId?: string;
  mode?: string;
  spec?: string;
  timeoutMs?: number;
  trustedSourceLinkedOfficialInstall?: boolean;
};

type ClawHubInstallCall = {
  expectedPluginId?: string;
  mode?: string;
  spec?: string;
  timeoutMs?: number;
};

type PluginInstallRecord = {
  artifactFormat?: string;
  artifactKind?: string;
  clawhubPackage?: string;
  clawpackSize?: number;
  installPath?: string;
  integrity?: string;
  npmIntegrity?: string;
  npmShasum?: string;
  npmTarballName?: string;
  pluginId?: string;
  resolvedAt?: string;
  resolvedName?: string;
  resolvedSpec?: string;
  resolvedVersion?: string;
  shasum?: string;
  source?: string;
  sourcePath?: string;
  spec?: string;
  version?: string;
};

describe("ensureOnboardingPluginInstalled", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.OPENCLAW_ALLOW_PLUGIN_INSTALL_OVERRIDES;
    delete process.env.OPENCLAW_PLUGIN_INSTALL_OVERRIDES;
    withTimeout.mockImplementation(async <T>(promise: Promise<T>) => await promise);
    refreshPluginRegistryAfterConfigMutation.mockResolvedValue(undefined);
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
      cfg: {},
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
    });

    expect(select).not.toHaveBeenCalled();
    expect(installPluginFromNpmSpec).not.toHaveBeenCalled();
    const [packCall] = readFirstMockCall(
      installPluginFromNpmPackArchive,
      "installPluginFromNpmPackArchive",
    ) as [NpmPackInstallCall];
    expect(packCall.archivePath).toBe(archivePath);
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

  it("installs and records ClawHub provider plugins with source facts", async () => {
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
      cfg: {},
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
    expect(clawHubCall.expectedPluginId).toBe("demo-plugin");
    expect(clawHubCall.mode).toBe("install");
    expect(clawHubCall.timeoutMs).toBe(300_000);
    expect(update).toHaveBeenCalledWith("Downloading");
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
      cfg: {},
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
    expect(npmCall.mode).toBe("update");
    expect(npmCall.expectedPluginId).toBe("demo-plugin");
    expect(npmCall.expectedIntegrity).toBe("sha512-wecom");
    expect(npmCall.trustedSourceLinkedOfficialInstall).toBe(true);
    expect(npmCall.timeoutMs).toBe(300_000);
    expect(update).toHaveBeenCalledWith("Downloading");
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
    expect(refreshPluginRegistryAfterConfigMutation).not.toHaveBeenCalled();
  });

  it("logs npm install warnings once while shortening the progress label", async () => {
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

    expect(update).toHaveBeenCalledWith("Retrying");
    expect(update).not.toHaveBeenCalledWith(warning);
    expect(log).toHaveBeenCalledWith(`${warning}\n`);
    expect(stop).toHaveBeenCalledWith("Installed Codex plugin");
    expect(result.status).toBe("installed");
  });

  it("returns a timed out status and notes the retry path when npm install hangs", async () => {
    const note = vi.fn(async () => {});
    const stop = vi.fn();
    withTimeout.mockRejectedValue(new Error("timeout"));

    const result = await ensureOnboardingPluginInstalled({
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

    expect(result).toEqual({
      cfg: {},
      installed: false,
      pluginId: "demo-plugin",
      status: "timed_out",
    });
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
      { value: "npm", label: `Download from npm (${expectedNpmInstallSpec("@demo/plugin")})` },
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
      { value: "clawhub", label: "Download from ClawHub (clawhub:demo-plugin@2026.5.2)" },
      { value: "npm", label: "Download from npm (@openclaw/demo-plugin@2026.5.2)" },
      { value: "skip", label: "Skip for now" },
    ]);
    expect(captured?.initialValue).toBe("npm");
    expect(installPluginFromClawHub).not.toHaveBeenCalled();
    expect(installPluginFromNpmSpec).not.toHaveBeenCalled();
  });

  it("honors explicit ClawHub defaults for dual-source remote installs", async () => {
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

    expect(captured?.initialValue).toBe("clawhub");
  });

  it("falls back from ClawHub to npm when the ClawHub package is unavailable", async () => {
    installPluginFromClawHub.mockResolvedValueOnce({
      ok: false,
      code: "package_not_found",
      error: "Package not found on ClawHub.",
    });
    installPluginFromNpmSpec.mockResolvedValueOnce({
      ok: true,
      pluginId: "demo-plugin",
      targetDir: "/tmp/demo-plugin",
      version: "2026.5.2",
      npmResolution: {
        name: "@openclaw/demo-plugin",
        version: "2026.5.2",
        resolvedSpec: "@openclaw/demo-plugin@2026.5.2",
        resolvedAt: "2026-05-01T00:00:00.000Z",
      },
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
        confirm: vi.fn(async () => true),
        note: vi.fn(async () => {}),
        progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
      } as never,
      runtime: {} as never,
      promptInstall: false,
    });

    const [npmCall] = readFirstMockCall(installPluginFromNpmSpec, "installPluginFromNpmSpec") as [
      NpmSpecInstallCall,
    ];
    expect(npmCall.spec).toBe("@openclaw/demo-plugin@2026.5.2");
    expect(npmCall.expectedPluginId).toBe("demo-plugin");
    expect(result.installed).toBe(true);
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
      promptInstall: false,
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
    });
  });

  it("does not offer local installs when the workspace only has a spoofed .git marker", async () => {
    await withTempDir({ prefix: "openclaw-onboarding-install-spoofed-git-" }, async (temp) => {
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
    await withTempDir({ prefix: "openclaw-onboarding-install-gitdir-" }, async (temp) => {
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
    });
  });

  it("does not add local plugin paths when enablement is blocked by policy", async () => {
    await withTempDir({ prefix: "openclaw-onboarding-install-blocked-enable-" }, async (temp) => {
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
    await withTempDir({ prefix: "openclaw-onboarding-install-worktree-" }, async (temp) => {
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
    await withTempDir({ prefix: "openclaw-onboarding-install-local-record-" }, async (temp) => {
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
        sourcePath: "./plugins/demo",
        spec: "@demo/plugin@1.2.3",
      });
      expect(result.installed).toBe(true);
      expect(result.status).toBe("installed");
      expect(result.cfg.plugins?.installs).toEqual({
        "demo-plugin": {
          pluginId: "demo-plugin",
          source: "path",
          sourcePath: "./plugins/demo",
          spec: "@demo/plugin@1.2.3",
        },
      });
    });
  });

  it("hides the npm download option for bundled plugins so the menu matches non-npm channels", async () => {
    await withTempDir({ prefix: "openclaw-onboarding-install-bundled-prompt-" }, async (temp) => {
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
    await withTempDir({ prefix: "openclaw-onboarding-install-bundled-record-" }, async (temp) => {
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
    await withTempDir(
      { prefix: "openclaw-onboarding-install-npm-fallback-record-" },
      async (temp) => {
        const workspaceDir = path.join(temp, "workspace");
        const pluginDir = path.join(workspaceDir, "plugins", "demo");
        await fs.mkdir(path.join(workspaceDir, ".git"), { recursive: true });
        await fs.mkdir(pluginDir, { recursive: true });
        installPluginFromNpmSpec.mockResolvedValueOnce({
          ok: false,
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
          sourcePath: "./plugins/demo",
          spec: "@demo/plugin@1.2.3",
        });
        expect(result.installed).toBe(true);
        expect(result.status).toBe("installed");
        expect(result.cfg.plugins?.installs).toEqual({
          "demo-plugin": {
            pluginId: "demo-plugin",
            source: "path",
            sourcePath: "./plugins/demo",
            spec: "@demo/plugin@1.2.3",
          },
        });
      },
    );
  });

  it("records absolute local catalog paths as workspace-relative source metadata", async () => {
    await withTempDir({ prefix: "openclaw-onboarding-install-portable-record-" }, async (temp) => {
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
        sourcePath: "./plugins/demo",
      });
    });
  });

  it("keeps local installs available when cwd is a git repo but workspaceDir is not", async () => {
    await withTempDir({ prefix: "openclaw-onboarding-install-cwd-git-" }, async (temp) => {
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
    await withTempDir({ prefix: "openclaw-onboarding-install-outside-root-" }, async (temp) => {
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

  it("rejects local install paths when relative resolution looks cross-drive", async () => {
    await withTempDir({ prefix: "openclaw-onboarding-install-cross-drive-" }, async (temp) => {
      const workspaceDir = path.join(temp, "workspace");
      const pluginDir = path.join(workspaceDir, "plugins", "demo");
      await fs.mkdir(path.join(workspaceDir, ".git"), { recursive: true });
      await fs.mkdir(pluginDir, { recursive: true });
      const realWorkspaceDir = await fs.realpath(workspaceDir);

      const originalRelative = path.relative;
      const originalIsAbsolute = path.isAbsolute;
      const relativeSpy = vi.spyOn(path, "relative").mockImplementation((from, to) => {
        if (
          typeof from === "string" &&
          typeof to === "string" &&
          from === realWorkspaceDir &&
          to === path.join(realWorkspaceDir, "plugins", "demo")
        ) {
          return "D:\\evil";
        }
        return originalRelative(from, to);
      });
      const isAbsoluteSpy = vi.spyOn(path, "isAbsolute").mockImplementation((value) => {
        if (value === "D:\\evil") {
          return true;
        }
        return originalIsAbsolute(value);
      });

      try {
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

        expect(captured?.options).toEqual([{ value: "skip", label: "Skip for now" }]);
      } finally {
        relativeSpy.mockRestore();
        isAbsoluteSpy.mockRestore();
      }
    });
  });
});
