import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginEnableResult } from "../plugins/enable.js";
import { withTempDir } from "../test-helpers/temp-dir.js";

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
vi.mock("../plugins/install.js", () => ({
  installPluginFromNpmSpec,
}));

const installPluginFromClawHub = vi.hoisted(() => vi.fn());
vi.mock("../plugins/clawhub.js", () => ({
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

describe("ensureOnboardingPluginInstalled", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    withTimeout.mockImplementation(async <T>(promise: Promise<T>) => await promise);
    refreshPluginRegistryAfterConfigMutation.mockResolvedValue(undefined);
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

    expect(installPluginFromClawHub).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: "clawhub:demo-plugin@2026.5.2",
        expectedPluginId: "demo-plugin",
        mode: "install",
        timeoutMs: 300_000,
      }),
    );
    expect(update).toHaveBeenCalledWith("Downloading");
    expect(stop).toHaveBeenCalledWith("Installed Demo Provider plugin");
    expect(recordPluginInstall).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        pluginId: "demo-plugin",
        source: "clawhub",
        spec: "clawhub:demo-plugin@2026.5.2",
        installPath: "/tmp/demo-plugin",
        version: "2026.5.2",
        integrity: "sha256-clawpack",
        clawhubPackage: "demo-plugin",
        clawpackSize: 4096,
      }),
    );
    expect(result.installed).toBe(true);
    expect(result.status).toBe("installed");
    expect(result.cfg.plugins?.installs).toEqual({
      "demo-plugin": expect.objectContaining({
        pluginId: "demo-plugin",
        source: "clawhub",
        spec: "clawhub:demo-plugin@2026.5.2",
      }),
    });
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

    expect(installPluginFromNpmSpec).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: "@wecom/wecom-openclaw-plugin@1.2.3",
        expectedPluginId: "demo-plugin",
        expectedIntegrity: "sha512-wecom",
        trustedSourceLinkedOfficialInstall: true,
        timeoutMs: 300_000,
      }),
    );
    expect(update).toHaveBeenCalledWith("Downloading");
    expect(stop).toHaveBeenCalledWith("Installed WeCom plugin");
    expect(buildNpmResolutionInstallFields).toHaveBeenCalledWith(npmResolution);
    expect(recordPluginInstall).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        pluginId: "demo-plugin",
        source: "npm",
        spec: "@wecom/wecom-openclaw-plugin@1.2.3",
        installPath: "/tmp/demo-plugin",
        version: "1.2.3",
        ...installFields,
      }),
    );
    expect(result.installed).toBe(true);
    expect(result.status).toBe("installed");
    expect(result.cfg.plugins?.installs).toEqual({
      "demo-plugin": expect.objectContaining({
        pluginId: "demo-plugin",
        source: "npm",
        spec: "@wecom/wecom-openclaw-plugin@1.2.3",
      }),
    });
    expect(refreshPluginRegistryAfterConfigMutation).not.toHaveBeenCalled();
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

      expect(captured).toBeDefined();
      expect(captured?.message).toBe("Install Demo Plugin plugin?");
      expect(captured?.options).toEqual([{ value: "skip", label: "Skip for now" }]);
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
      expect(captured).toBeDefined();
      expect(captured?.message).toBe("Install Demo Plugin\\n plugin?");
      expect(captured?.options).toEqual([
        { value: "npm", label: "Download from npm (@demo/plugin@1.2.3)" },
        {
          value: "local",
          label: "Use local plugin path",
          hint: realPluginDir,
        },
        { value: "skip", label: "Skip for now" },
      ]);
      expect(captured?.message).not.toContain("\x1b");
      expect(captured?.options[0]?.label).not.toContain("\x1b");
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
      expect(recordPluginInstall).toHaveBeenCalledWith(
        expect.objectContaining({
          plugins: {
            load: {
              paths: [realPluginDir],
            },
          },
        }),
        {
          pluginId: "demo-plugin",
          source: "path",
          sourcePath: "./plugins/demo",
          spec: "@demo/plugin@1.2.3",
        },
      );
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

      expect(captured).toBeDefined();
      // "Download from npm (@openclaw/tlon)" must NOT appear: the bundled
      // copy is what gets enabled, so the npm hint would only confuse
      // users into thinking the plugin is missing.
      expect(captured?.options).toEqual([
        {
          value: "local",
          label: "Use local plugin path",
          hint: realBundledDir,
        },
        { value: "skip", label: "Skip for now" },
      ]);
      expect(captured?.initialValue).toBe("local");
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
        expect(recordPluginInstall).toHaveBeenCalledWith(
          expect.objectContaining({
            plugins: {
              load: {
                paths: [realPluginDir],
              },
            },
          }),
          {
            pluginId: "demo-plugin",
            source: "path",
            sourcePath: "./plugins/demo",
            spec: "@demo/plugin@1.2.3",
          },
        );
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

      expect(recordPluginInstall).toHaveBeenCalledWith(expect.anything(), {
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
