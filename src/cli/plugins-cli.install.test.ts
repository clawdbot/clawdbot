import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { installedPluginRoot } from "../../test/helpers/bundled-plugin-paths.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  applyExclusiveSlotSelection,
  buildPluginDiagnosticsReport,
  clearPluginManifestRegistryCache,
  enablePluginInConfig,
  installHooksFromNpmSpec,
  installHooksFromPath,
  installPluginFromClawHub,
  installPluginFromMarketplace,
  installPluginFromNpmSpec,
  installPluginFromPath,
  loadConfig,
  readConfigFileSnapshot,
  parseClawHubPluginSpec,
  recordHookInstall,
  recordPluginInstall,
  resetPluginsCliTestState,
  runPluginsCommand,
  runtimeErrors,
  runtimeLogs,
  writeConfigFile,
} from "./plugins-cli-test-helpers.js";

const CLI_STATE_ROOT = "/tmp/openclaw-state";

function cliInstallPath(pluginId: string): string {
  return installedPluginRoot(CLI_STATE_ROOT, pluginId);
}

function createEnabledPluginConfig(pluginId: string): OpenClawConfig {
  return {
    plugins: {
      entries: {
        [pluginId]: {
          enabled: true,
        },
      },
    },
  } as OpenClawConfig;
}

function createEmptyPluginConfig(): OpenClawConfig {
  return {
    plugins: {
      entries: {},
    },
  } as OpenClawConfig;
}

function createClawHubInstalledConfig(params: {
  pluginId: string;
  install: Record<string, unknown>;
}): OpenClawConfig {
  const enabledCfg = createEnabledPluginConfig(params.pluginId);
  return {
    ...enabledCfg,
    plugins: {
      ...enabledCfg.plugins,
      installs: {
        [params.pluginId]: params.install,
      },
    },
  } as OpenClawConfig;
}

function createClawHubInstallResult(params: {
  pluginId: string;
  packageName: string;
  version: string;
  channel: string;
}): Awaited<ReturnType<typeof installPluginFromClawHub>> {
  return {
    ok: true,
    pluginId: params.pluginId,
    targetDir: cliInstallPath(params.pluginId),
    version: params.version,
    packageName: params.packageName,
    clawhub: {
      source: "clawhub",
      clawhubUrl: "https://clawhub.ai",
      clawhubPackage: params.packageName,
      clawhubFamily: "code-plugin",
      clawhubChannel: params.channel,
      version: params.version,
      integrity: "sha256-abc",
      resolvedAt: "2026-03-22T00:00:00.000Z",
    },
  };
}

function createNpmPluginInstallResult(
  pluginId = "demo",
): Awaited<ReturnType<typeof installPluginFromNpmSpec>> {
  return {
    ok: true,
    pluginId,
    targetDir: cliInstallPath(pluginId),
    version: "1.2.3",
    npmResolution: {
      packageName: pluginId,
      resolvedVersion: "1.2.3",
      tarballUrl: `https://registry.npmjs.org/${pluginId}/-/${pluginId}-1.2.3.tgz`,
    },
  };
}

function mockClawHubPackageNotFound(packageName: string) {
  installPluginFromClawHub.mockResolvedValue({
    ok: false,
    error: `ClawHub /api/v1/packages/${packageName} failed (404): Package not found`,
    code: "package_not_found",
  });
}

function primeNpmPluginFallback(pluginId = "demo") {
  const cfg = createEmptyPluginConfig();
  const enabledCfg = createEnabledPluginConfig(pluginId);

  loadConfig.mockReturnValue(cfg);
  mockClawHubPackageNotFound(pluginId);
  installPluginFromNpmSpec.mockResolvedValue(createNpmPluginInstallResult(pluginId));
  enablePluginInConfig.mockReturnValue({ config: enabledCfg });
  recordPluginInstall.mockReturnValue(enabledCfg);
  applyExclusiveSlotSelection.mockReturnValue({
    config: enabledCfg,
    warnings: [],
  });

  return { cfg, enabledCfg };
}

function createPathHookPackInstalledConfig(tmpRoot: string): OpenClawConfig {
  return {
    hooks: {
      internal: {
        installs: {
          "demo-hooks": {
            source: "path",
            sourcePath: tmpRoot,
            installPath: tmpRoot,
          },
        },
      },
    },
  } as OpenClawConfig;
}

function createNpmHookPackInstalledConfig(): OpenClawConfig {
  return {
    hooks: {
      internal: {
        installs: {
          "demo-hooks": {
            source: "npm",
            spec: "@acme/demo-hooks@1.2.3",
          },
        },
      },
    },
  } as OpenClawConfig;
}

function createHookPackInstallResult(targetDir: string): {
  ok: true;
  hookPackId: string;
  hooks: string[];
  targetDir: string;
  version: string;
} {
  return {
    ok: true,
    hookPackId: "demo-hooks",
    hooks: ["command-audit"],
    targetDir,
    version: "1.2.3",
  };
}

function primeHookPackNpmFallback() {
  const cfg = {} as OpenClawConfig;
  const installedCfg = createNpmHookPackInstalledConfig();

  loadConfig.mockReturnValue(cfg);
  mockClawHubPackageNotFound("@acme/demo-hooks");
  installPluginFromNpmSpec.mockResolvedValue({
    ok: false,
    error: "package.json missing openclaw.plugin.json",
  });
  installHooksFromNpmSpec.mockResolvedValue({
    ...createHookPackInstallResult("/tmp/hooks/demo-hooks"),
    npmResolution: {
      name: "@acme/demo-hooks",
      spec: "@acme/demo-hooks@1.2.3",
      integrity: "sha256-demo",
    },
  });
  recordHookInstall.mockReturnValue(installedCfg);

  return { cfg, installedCfg };
}

function primeHookPackPathFallback(params: {
  tmpRoot: string;
  pluginInstallError: string;
}): OpenClawConfig {
  const installedCfg = createPathHookPackInstalledConfig(params.tmpRoot);

  loadConfig.mockReturnValue({} as OpenClawConfig);
  installPluginFromPath.mockResolvedValueOnce({
    ok: false,
    error: params.pluginInstallError,
  });
  installHooksFromPath.mockResolvedValueOnce(createHookPackInstallResult(params.tmpRoot));
  recordHookInstall.mockReturnValue(installedCfg);

  return installedCfg;
}

describe("plugins cli install", () => {
  beforeEach(() => {
    resetPluginsCliTestState();
  });

  it("shows the force overwrite option in install help", async () => {
    const { Command } = await import("commander");
    const { registerPluginsCli } = await import("./plugins-cli.js");
    const program = new Command();
    registerPluginsCli(program);

    const pluginsCommand = program.commands.find((command) => command.name() === "plugins");
    const installCommand = pluginsCommand?.commands.find((command) => command.name() === "install");
    const helpText = installCommand?.helpInformation() ?? "";

    expect(helpText).toContain("--force");
    expect(helpText).toContain("Overwrite an existing installed plugin or");
    expect(helpText).toContain("hook pack");
  });

  it("exits when --marketplace is combined with --link", async () => {
    await expect(
      runPluginsCommand(["plugins", "install", "alpha", "--marketplace", "local/repo", "--link"]),
    ).rejects.toThrow("__exit__:1");

    expect(runtimeErrors.at(-1)).toContain("`--link` is not supported with `--marketplace`.");
    expect(installPluginFromMarketplace).not.toHaveBeenCalled();
  });

  it("exits when --force is combined with --link", async () => {
    await expect(
      runPluginsCommand(["plugins", "install", "./plugin", "--link", "--force"]),
    ).rejects.toThrow("__exit__:1");

    expect(runtimeErrors.at(-1)).toContain("`--force` is not supported with `--link`.");
    expect(installPluginFromMarketplace).not.toHaveBeenCalled();
    expect(installPluginFromNpmSpec).not.toHaveBeenCalled();
  });

  it("exits when marketplace install fails", async () => {
    await expect(
      runPluginsCommand(["plugins", "install", "alpha", "--marketplace", "local/repo"]),
    ).rejects.toThrow("__exit__:1");

    expect(installPluginFromMarketplace).toHaveBeenCalledWith(
      expect.objectContaining({
        marketplace: "local/repo",
        plugin: "alpha",
      }),
    );
    expect(writeConfigFile).not.toHaveBeenCalled();
  });

  it("fails closed for unrelated invalid config before installer side effects", async () => {
    const invalidConfigErr = new Error("config invalid");
    (invalidConfigErr as { code?: string }).code = "INVALID_CONFIG";
    loadConfig.mockImplementation(() => {
      throw invalidConfigErr;
    });
    readConfigFileSnapshot.mockResolvedValue({
      path: "/tmp/openclaw-config.json5",
      exists: true,
      raw: '{ "models": { "default": 123 } }',
      parsed: { models: { default: 123 } },
      resolved: { models: { default: 123 } },
      valid: false,
      config: { models: { default: 123 } },
      hash: "mock",
      issues: [{ path: "models.default", message: "invalid model ref" }],
      warnings: [],
      legacyIssues: [],
    });

    await expect(runPluginsCommand(["plugins", "install", "alpha"])).rejects.toThrow("__exit__:1");

    expect(runtimeErrors.at(-1)).toContain(
      "Config invalid; run `openclaw doctor --fix` before installing plugins.",
    );
    expect(installPluginFromMarketplace).not.toHaveBeenCalled();
    expect(installPluginFromNpmSpec).not.toHaveBeenCalled();
    expect(writeConfigFile).not.toHaveBeenCalled();
  });

  it("installs marketplace plugins and persists config", async () => {
    const cfg = {
      plugins: {
        entries: {},
      },
    } as OpenClawConfig;
    const enabledCfg = {
      plugins: {
        entries: {
          alpha: {
            enabled: true,
          },
        },
      },
    } as OpenClawConfig;
    const installedCfg = {
      ...enabledCfg,
      plugins: {
        ...enabledCfg.plugins,
        installs: {
          alpha: {
            source: "marketplace",
            installPath: cliInstallPath("alpha"),
          },
        },
      },
    } as OpenClawConfig;

    loadConfig.mockReturnValue(cfg);
    installPluginFromMarketplace.mockResolvedValue({
      ok: true,
      pluginId: "alpha",
      targetDir: cliInstallPath("alpha"),
      extensions: ["index.js"],
      version: "1.2.3",
      marketplaceName: "Claude",
      marketplaceSource: "local/repo",
      marketplacePlugin: "alpha",
    });
    enablePluginInConfig.mockReturnValue({ config: enabledCfg });
    recordPluginInstall.mockReturnValue(installedCfg);
    buildPluginDiagnosticsReport.mockReturnValue({
      plugins: [{ id: "alpha", kind: "provider" }],
      diagnostics: [],
    });
    applyExclusiveSlotSelection.mockReturnValue({
      config: installedCfg,
      warnings: ["slot adjusted"],
    });

    await runPluginsCommand(["plugins", "install", "alpha", "--marketplace", "local/repo"]);

    expect(clearPluginManifestRegistryCache).toHaveBeenCalledTimes(1);
    expect(writeConfigFile).toHaveBeenCalledWith(installedCfg);
    expect(runtimeLogs.some((line) => line.includes("slot adjusted"))).toBe(true);
    expect(runtimeLogs.some((line) => line.includes("Installed plugin: alpha"))).toBe(true);
  });

  it("passes force through as overwrite mode for marketplace installs", async () => {
    await expect(
      runPluginsCommand(["plugins", "install", "alpha", "--marketplace", "local/repo", "--force"]),
    ).rejects.toThrow("__exit__:1");

    expect(installPluginFromMarketplace).toHaveBeenCalledWith(
      expect.objectContaining({
        marketplace: "local/repo",
        plugin: "alpha",
        mode: "update",
      }),
    );
  });

  it("installs ClawHub plugins and persists source metadata", async () => {
    const cfg = {
      plugins: {
        entries: {},
      },
    } as OpenClawConfig;
    const enabledCfg = createEnabledPluginConfig("demo");
    const installedCfg = createClawHubInstalledConfig({
      pluginId: "demo",
      install: {
        source: "clawhub",
        spec: "clawhub:demo@1.2.3",
        installPath: cliInstallPath("demo"),
        clawhubPackage: "demo",
        clawhubFamily: "code-plugin",
        clawhubChannel: "official",
      },
    });

    loadConfig.mockReturnValue(cfg);
    parseClawHubPluginSpec.mockReturnValue({ name: "demo" });
    installPluginFromClawHub.mockResolvedValue(
      createClawHubInstallResult({
        pluginId: "demo",
        packageName: "demo",
        version: "1.2.3",
        channel: "official",
      }),
    );
    enablePluginInConfig.mockReturnValue({ config: enabledCfg });
    recordPluginInstall.mockReturnValue(installedCfg);
    applyExclusiveSlotSelection.mockReturnValue({
      config: installedCfg,
      warnings: [],
    });

    await runPluginsCommand(["plugins", "install", "clawhub:demo"]);

    expect(installPluginFromClawHub).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: "clawhub:demo",
      }),
    );
    expect(recordPluginInstall).toHaveBeenCalledWith(
      enabledCfg,
      expect.objectContaining({
        pluginId: "demo",
        source: "clawhub",
        spec: "clawhub:demo@1.2.3",
        clawhubPackage: "demo",
        clawhubFamily: "code-plugin",
        clawhubChannel: "official",
      }),
    );
    expect(writeConfigFile).toHaveBeenCalledWith(installedCfg);
    expect(runtimeLogs.some((line) => line.includes("Installed plugin: demo"))).toBe(true);
    expect(installPluginFromNpmSpec).not.toHaveBeenCalled();
  });

  it("passes force through as overwrite mode for ClawHub installs", async () => {
    const cfg = {
      plugins: {
        entries: {},
      },
    } as OpenClawConfig;
    const enabledCfg = createEnabledPluginConfig("demo");

    loadConfig.mockReturnValue(cfg);
    parseClawHubPluginSpec.mockReturnValue({ name: "demo" });
    installPluginFromClawHub.mockResolvedValue(
      createClawHubInstallResult({
        pluginId: "demo",
        packageName: "demo",
        version: "1.2.3",
        channel: "official",
      }),
    );
    enablePluginInConfig.mockReturnValue({ config: enabledCfg });
    recordPluginInstall.mockReturnValue(enabledCfg);
    applyExclusiveSlotSelection.mockReturnValue({
      config: enabledCfg,
      warnings: [],
    });

    await runPluginsCommand(["plugins", "install", "clawhub:demo", "--force"]);

    expect(installPluginFromClawHub).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: "clawhub:demo",
        mode: "update",
      }),
    );
  });

  it("prefers ClawHub before npm for bare plugin specs", async () => {
    const cfg = {
      plugins: {
        entries: {},
      },
    } as OpenClawConfig;
    const enabledCfg = createEnabledPluginConfig("demo");
    const installedCfg = createClawHubInstalledConfig({
      pluginId: "demo",
      install: {
        source: "clawhub",
        spec: "clawhub:demo@1.2.3",
        installPath: cliInstallPath("demo"),
        clawhubPackage: "demo",
      },
    });

    loadConfig.mockReturnValue(cfg);
    installPluginFromClawHub.mockResolvedValue(
      createClawHubInstallResult({
        pluginId: "demo",
        packageName: "demo",
        version: "1.2.3",
        channel: "community",
      }),
    );
    enablePluginInConfig.mockReturnValue({ config: enabledCfg });
    recordPluginInstall.mockReturnValue(installedCfg);
    applyExclusiveSlotSelection.mockReturnValue({
      config: installedCfg,
      warnings: [],
    });

    await runPluginsCommand(["plugins", "install", "demo"]);

    expect(installPluginFromClawHub).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: "clawhub:demo",
      }),
    );
    expect(installPluginFromNpmSpec).not.toHaveBeenCalled();
    expect(writeConfigFile).toHaveBeenCalledWith(installedCfg);
  });

  it("falls back to npm when ClawHub does not have the package", async () => {
    primeNpmPluginFallback();

    await runPluginsCommand(["plugins", "install", "demo"]);

    expect(installPluginFromClawHub).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: "clawhub:demo",
      }),
    );
    expect(installPluginFromNpmSpec).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: "demo",
      }),
    );
  });

  it("passes dangerous force unsafe install to marketplace installs", async () => {
    await expect(
      runPluginsCommand([
        "plugins",
        "install",
        "alpha",
        "--marketplace",
        "local/repo",
        "--dangerously-force-unsafe-install",
      ]),
    ).rejects.toThrow("__exit__:1");

    expect(installPluginFromMarketplace).toHaveBeenCalledWith(
      expect.objectContaining({
        marketplace: "local/repo",
        plugin: "alpha",
        dangerouslyForceUnsafeInstall: true,
      }),
    );
  });

  it("passes dangerous force unsafe install to npm installs", async () => {
    primeNpmPluginFallback();

    await runPluginsCommand(["plugins", "install", "demo", "--dangerously-force-unsafe-install"]);

    expect(installPluginFromNpmSpec).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: "demo",
        dangerouslyForceUnsafeInstall: true,
      }),
    );
  });

  it("passes dangerous force unsafe install to linked path probe installs", async () => {
    const cfg = {
      plugins: {
        entries: {},
      },
    } as OpenClawConfig;
    const enabledCfg = createEnabledPluginConfig("demo");
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-plugin-link-"));

    loadConfig.mockReturnValue(cfg);
    installPluginFromPath.mockResolvedValueOnce({
      ok: true,
      pluginId: "demo",
      targetDir: tmpRoot,
      version: "1.2.3",
      extensions: ["./dist/index.js"],
    });
    enablePluginInConfig.mockReturnValue({ config: enabledCfg });
    recordPluginInstall.mockReturnValue(enabledCfg);
    applyExclusiveSlotSelection.mockReturnValue({
      config: enabledCfg,
      warnings: [],
    });

    try {
      await runPluginsCommand([
        "plugins",
        "install",
        tmpRoot,
        "--link",
        "--dangerously-force-unsafe-install",
      ]);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }

    expect(installPluginFromPath).toHaveBeenCalledWith(
      expect.objectContaining({
        path: tmpRoot,
        dryRun: true,
        dangerouslyForceUnsafeInstall: true,
      }),
    );
  });

  it("passes dangerous force unsafe install to linked hook-pack probe fallback", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-hook-link-"));
    primeHookPackPathFallback({
      tmpRoot,
      pluginInstallError: "plugin install probe failed",
    });

    try {
      await runPluginsCommand([
        "plugins",
        "install",
        tmpRoot,
        "--link",
        "--dangerously-force-unsafe-install",
      ]);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }

    expect(installHooksFromPath).toHaveBeenCalledWith(
      expect.objectContaining({
        path: tmpRoot,
        dryRun: true,
        dangerouslyForceUnsafeInstall: true,
      }),
    );
  });

  it("passes dangerous force unsafe install to local hook-pack fallback installs", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-hook-install-"));
    primeHookPackPathFallback({
      tmpRoot,
      pluginInstallError: "plugin install failed",
    });

    try {
      await runPluginsCommand([
        "plugins",
        "install",
        tmpRoot,
        "--dangerously-force-unsafe-install",
      ]);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }

    expect(installHooksFromPath).toHaveBeenCalledWith(
      expect.objectContaining({
        path: tmpRoot,
        mode: "install",
        dangerouslyForceUnsafeInstall: true,
      }),
    );
  });
  it("passes force through as overwrite mode for npm installs", async () => {
    primeNpmPluginFallback();

    await runPluginsCommand(["plugins", "install", "demo", "--force"]);

    expect(installPluginFromNpmSpec).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: "demo",
        mode: "update",
      }),
    );
  });

  it("suggests update or --force when npm plugin install target already exists", async () => {
    loadConfig.mockReturnValue({} as OpenClawConfig);
    mockClawHubPackageNotFound("@example/lossless-claw");
    installPluginFromNpmSpec.mockResolvedValue({
      ok: false,
      error:
        "plugin already exists: /home/openclaw/.openclaw/extensions/lossless-claw (delete it first)",
    });
    installHooksFromNpmSpec.mockResolvedValue({
      ok: false,
      error: "package.json missing openclaw.hooks",
    });

    await expect(
      runPluginsCommand(["plugins", "install", "@example/lossless-claw"]),
    ).rejects.toThrow("__exit__:1");

    expect(runtimeErrors.at(-1)).toContain(
      "Use `openclaw plugins update <id-or-npm-spec>` to upgrade the tracked plugin, or rerun install with `--force` to replace it.",
    );
    expect(runtimeErrors.at(-1)).not.toContain("Also not a valid hook pack");
  });

  it("passes the install logger to the --link dry-run probe", async () => {
    const localPluginDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-link-plugin-"));
    const cfg = {
      plugins: {
        entries: {},
        load: {
          paths: [],
        },
      },
    } as OpenClawConfig;
    const enabledCfg = createEnabledPluginConfig("demo");

    loadConfig.mockReturnValue(cfg);
    installPluginFromPath.mockImplementation(async (...args: unknown[]) => {
      const [params] = args as [
        {
          logger?: { warn?: (message: string) => void };
          path: string;
          dryRun?: boolean;
          dangerouslyForceUnsafeInstall?: boolean;
        },
      ];
      params.logger?.warn?.(
        'WARNING: Plugin "demo" forced despite dangerous code patterns via --dangerously-force-unsafe-install: index.js:1',
      );
      return {
        ok: true,
        pluginId: "demo",
        targetDir: localPluginDir,
        version: "1.0.0",
        extensions: [],
      };
    });
    enablePluginInConfig.mockReturnValue({ config: enabledCfg });
    recordPluginInstall.mockReturnValue(enabledCfg);
    applyExclusiveSlotSelection.mockReturnValue({
      config: enabledCfg,
      warnings: [],
    });

    try {
      await runPluginsCommand([
        "plugins",
        "install",
        localPluginDir,
        "--link",
        "--dangerously-force-unsafe-install",
      ]);
    } finally {
      fs.rmSync(localPluginDir, { recursive: true, force: true });
    }

    expect(installPluginFromPath).toHaveBeenCalledWith(
      expect.objectContaining({
        path: localPluginDir,
        dryRun: true,
        dangerouslyForceUnsafeInstall: true,
        logger: expect.objectContaining({
          info: expect.any(Function),
          warn: expect.any(Function),
        }),
      }),
    );
    expect(
      runtimeLogs.some((line) =>
        line.includes(
          "forced despite dangerous code patterns via --dangerously-force-unsafe-install",
        ),
      ),
    ).toBe(true);
  });

  it("does not fall back to hook pack for local path when dangerous force unsafe install is set", async () => {
    const localPluginDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-local-plugin-"));
    const cfg = {} as OpenClawConfig;
    const pluginInstallError = "plugin blocked by security scan";

    loadConfig.mockReturnValue(cfg);
    installPluginFromPath.mockResolvedValue({
      ok: false,
      error: pluginInstallError,
      code: "security_scan_blocked",
    });

    try {
      await expect(
        runPluginsCommand([
          "plugins",
          "install",
          localPluginDir,
          "--dangerously-force-unsafe-install",
        ]),
      ).rejects.toThrow("__exit__:1");
    } finally {
      fs.rmSync(localPluginDir, { recursive: true, force: true });
    }

    expect(installHooksFromPath).not.toHaveBeenCalled();
    expect(runtimeErrors.at(-1)).toContain(pluginInstallError);
  });

  it("does not fall back to hook pack for local path when security scan fails under dangerous force unsafe install", async () => {
    const localPluginDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-local-plugin-"));
    const cfg = {} as OpenClawConfig;
    const pluginInstallError = "plugin security scan failed";

    loadConfig.mockReturnValue(cfg);
    installPluginFromPath.mockResolvedValue({
      ok: false,
      error: pluginInstallError,
      code: "security_scan_failed",
    });

    try {
      await expect(
        runPluginsCommand([
          "plugins",
          "install",
          localPluginDir,
          "--dangerously-force-unsafe-install",
        ]),
      ).rejects.toThrow("__exit__:1");
    } finally {
      fs.rmSync(localPluginDir, { recursive: true, force: true });
    }

    expect(installHooksFromPath).not.toHaveBeenCalled();
    expect(runtimeErrors.at(-1)).toContain(pluginInstallError);
  });

  it("does not fall back to hook pack for npm installs when dangerous force unsafe install is set", async () => {
    const cfg = {} as OpenClawConfig;
    const pluginInstallError = "plugin blocked by security scan";

    loadConfig.mockReturnValue(cfg);
    installPluginFromClawHub.mockResolvedValue({
      ok: false,
      error: "ClawHub /api/v1/packages/demo failed (404): Package not found",
      code: "package_not_found",
    });
    installPluginFromNpmSpec.mockResolvedValue({
      ok: false,
      error: pluginInstallError,
      code: "security_scan_blocked",
    });

    await expect(
      runPluginsCommand(["plugins", "install", "demo", "--dangerously-force-unsafe-install"]),
    ).rejects.toThrow("__exit__:1");

    expect(installHooksFromNpmSpec).not.toHaveBeenCalled();
    expect(runtimeErrors.at(-1)).toContain(pluginInstallError);
  });

  it("does not fall back to hook pack for npm installs when security scan fails under dangerous force unsafe install", async () => {
    const cfg = {} as OpenClawConfig;
    const pluginInstallError = "plugin security scan failed";

    loadConfig.mockReturnValue(cfg);
    installPluginFromClawHub.mockResolvedValue({
      ok: false,
      error: "ClawHub /api/v1/packages/demo failed (404): Package not found",
      code: "package_not_found",
    });
    installPluginFromNpmSpec.mockResolvedValue({
      ok: false,
      error: pluginInstallError,
      code: "security_scan_failed",
    });

    await expect(
      runPluginsCommand(["plugins", "install", "demo", "--dangerously-force-unsafe-install"]),
    ).rejects.toThrow("__exit__:1");

    expect(installHooksFromNpmSpec).not.toHaveBeenCalled();
    expect(runtimeErrors.at(-1)).toContain(pluginInstallError);
  });

  it("still falls back to local hook pack when dangerous force unsafe install is set for non-security errors", async () => {
    const localHookDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-local-hook-pack-"));
    const cfg = {} as OpenClawConfig;
    const installedCfg = {
      hooks: {
        internal: {
          installs: {
            "demo-hooks": {
              source: "path",
              sourcePath: localHookDir,
            },
          },
        },
      },
    } as OpenClawConfig;

    loadConfig.mockReturnValue(cfg);
    installPluginFromPath.mockResolvedValue({
      ok: false,
      error: "package.json missing openclaw.plugin.json",
      code: "missing_openclaw_extensions",
    });
    installHooksFromPath.mockResolvedValue({
      ok: true,
      hookPackId: "demo-hooks",
      hooks: ["command-audit"],
      targetDir: "/tmp/hooks/demo-hooks",
      version: "1.2.3",
    });
    recordHookInstall.mockReturnValue(installedCfg);

    try {
      await runPluginsCommand([
        "plugins",
        "install",
        localHookDir,
        "--dangerously-force-unsafe-install",
      ]);
    } finally {
      fs.rmSync(localHookDir, { recursive: true, force: true });
    }

    expect(installHooksFromPath).toHaveBeenCalledWith(
      expect.objectContaining({
        path: localHookDir,
      }),
    );
    expect(runtimeLogs.some((line) => line.includes("Installed hook pack: demo-hooks"))).toBe(true);
  });

  it("still falls back to npm hook pack when dangerous force unsafe install is set for non-security errors", async () => {
    const cfg = {} as OpenClawConfig;
    const installedCfg = {
      hooks: {
        internal: {
          installs: {
            "demo-hooks": {
              source: "npm",
              spec: "@acme/demo-hooks@1.2.3",
            },
          },
        },
      },
    } as OpenClawConfig;

    loadConfig.mockReturnValue(cfg);
    installPluginFromClawHub.mockResolvedValue({
      ok: false,
      error: "ClawHub /api/v1/packages/@acme/demo-hooks failed (404): Package not found",
      code: "package_not_found",
    });
    installPluginFromNpmSpec.mockResolvedValue({
      ok: false,
      error: "package.json missing openclaw.plugin.json",
      code: "missing_openclaw_extensions",
    });
    installHooksFromNpmSpec.mockResolvedValue({
      ok: true,
      hookPackId: "demo-hooks",
      hooks: ["command-audit"],
      targetDir: "/tmp/hooks/demo-hooks",
      version: "1.2.3",
      npmResolution: {
        name: "@acme/demo-hooks",
        spec: "@acme/demo-hooks@1.2.3",
        integrity: "sha256-demo",
      },
    });
    recordHookInstall.mockReturnValue(installedCfg);

    await runPluginsCommand([
      "plugins",
      "install",
      "@acme/demo-hooks",
      "--dangerously-force-unsafe-install",
    ]);

    expect(installHooksFromNpmSpec).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: "@acme/demo-hooks",
      }),
    );
    expect(runtimeLogs.some((line) => line.includes("Installed hook pack: demo-hooks"))).toBe(true);
  });

  it("does not fall back to npm when ClawHub rejects a real package", async () => {
    installPluginFromClawHub.mockResolvedValue({
      ok: false,
      error: 'Use "openclaw skills install demo" instead.',
      code: "skill_package",
    });

    await expect(runPluginsCommand(["plugins", "install", "demo"])).rejects.toThrow("__exit__:1");

    expect(installPluginFromNpmSpec).not.toHaveBeenCalled();
    expect(runtimeErrors.at(-1)).toContain('Use "openclaw skills install demo" instead.');
  });

  it("falls back to installing hook packs from npm specs", async () => {
    const { installedCfg } = primeHookPackNpmFallback();

    await runPluginsCommand(["plugins", "install", "@acme/demo-hooks"]);

    expect(installHooksFromNpmSpec).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: "@acme/demo-hooks",
      }),
    );
    expect(recordHookInstall).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        hookId: "demo-hooks",
        hooks: ["command-audit"],
      }),
    );
    expect(writeConfigFile).toHaveBeenCalledWith(installedCfg);
    expect(runtimeLogs.some((line) => line.includes("Installed hook pack: demo-hooks"))).toBe(true);
  });

  it("passes force through as overwrite mode for hook-pack npm fallback installs", async () => {
    primeHookPackNpmFallback();

    await runPluginsCommand(["plugins", "install", "@acme/demo-hooks", "--force"]);

    expect(installHooksFromNpmSpec).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: "@acme/demo-hooks",
        mode: "update",
      }),
    );
  });
});
