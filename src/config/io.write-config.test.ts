import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readPersistedInstalledPluginIndex } from "../plugins/installed-plugin-index-store.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import {
  createConfigIO,
  registerConfigWriteListener,
  resetConfigRuntimeState,
  setRuntimeConfigSnapshot,
  writeConfigFile,
} from "./io.js";
import type { ConfigFileSnapshot } from "./types.openclaw.js";

// Mock the plugin manifest registry so we can register a fake channel whose
// AJV JSON Schema carries a `default` value.  This lets the #56772 regression
// test exercise the exact code path that caused the bug: AJV injecting
// defaults during the write-back validation pass.
const mockLoadPluginManifestRegistry = vi.hoisted(() =>
  vi.fn(
    (): PluginManifestRegistry => ({
      diagnostics: [],
      plugins: [],
    }),
  ),
);
const mockMaintainConfigBackups = vi.hoisted(() =>
  vi.fn<typeof import("./backup-rotation.js").maintainConfigBackups>(async () => {}),
);

vi.mock("../plugins/manifest-registry.js", () => ({
  loadPluginManifestRegistry: mockLoadPluginManifestRegistry,
}));

vi.mock("../plugins/doctor-contract-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/doctor-contract-registry.js")>();
  return {
    ...actual,
    listPluginDoctorLegacyConfigRules: () => [],
    applyPluginDoctorCompatibilityMigrations: () => ({ next: null, changes: [] }),
  };
});

vi.mock("./backup-rotation.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./backup-rotation.js")>();
  return {
    ...actual,
    maintainConfigBackups: mockMaintainConfigBackups,
  };
});

describe("config io write", () => {
  const suiteRootTracker = createSuiteTempRootTracker({ prefix: "openclaw-config-io-" });
  const silentLogger = {
    warn: () => {},
    error: () => {},
  };

  async function withSuiteHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
    const home = await suiteRootTracker.make("case");
    return fn(home);
  }

  beforeAll(async () => {
    await suiteRootTracker.setup();

    // Default: return an empty plugin list so existing tests that don't need
    // plugin-owned channel schemas keep working unchanged.
    mockLoadPluginManifestRegistry.mockReturnValue({
      diagnostics: [],
      plugins: [],
    } satisfies PluginManifestRegistry);
  });

  afterEach(() => {
    resetConfigRuntimeState();
    mockMaintainConfigBackups.mockReset();
    mockMaintainConfigBackups.mockResolvedValue(undefined);
  });

  afterAll(async () => {
    resetConfigRuntimeState();
    await suiteRootTracker.cleanup();
  });

  const expectInputOwnerDisplayUnchanged = (input: Record<string, unknown>) => {
    expect((input.commands as Record<string, unknown>).ownerDisplay).toBe("hash");
  };

  const readPersistedCommands = async (configPath: string) => {
    const persisted = JSON.parse(await fs.readFile(configPath, "utf-8")) as {
      commands?: Record<string, unknown>;
    };
    return persisted.commands;
  };

  const createFastConfigIO = (home: string) =>
    createConfigIO({
      env: { OPENCLAW_TEST_FAST: "1" } as NodeJS.ProcessEnv,
      homedir: () => home,
      logger: silentLogger,
    });

  it("migrates shipped plugin install config records into the plugin index", async () => {
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      const pluginDir = path.join(home, ".openclaw", "plugins", "demo");
      const manifestPath = path.join(pluginDir, "openclaw.plugin.json");
      const source = path.join(pluginDir, "index.ts");
      await fs.mkdir(pluginDir, { recursive: true });
      await fs.writeFile(source, "export function register() {}\n", "utf-8");
      await fs.writeFile(
        manifestPath,
        `${JSON.stringify({ id: "demo", configSchema: { type: "object" } }, null, 2)}\n`,
        "utf-8",
      );
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(
        configPath,
        `${JSON.stringify(
          {
            plugins: {
              entries: { demo: { enabled: true } },
              installs: {
                demo: {
                  source: "npm",
                  spec: "demo@1.0.0",
                  installPath: pluginDir,
                },
              },
            },
          },
          null,
          2,
        )}\n`,
        "utf-8",
      );
      mockLoadPluginManifestRegistry.mockReturnValue({
        diagnostics: [],
        plugins: [
          {
            id: "demo",
            origin: "global",
            channels: [],
            providers: [],
            cliBackends: [],
            skills: [],
            hooks: [],
            rootDir: pluginDir,
            source,
            manifestPath,
            configSchema: {
              type: "object",
            },
          },
        ],
      } satisfies PluginManifestRegistry);

      const io = createFastConfigIO(home);
      try {
        const cfg = io.loadConfig();

        expect(cfg.plugins?.installs).toBeUndefined();
        await expect(
          readPersistedInstalledPluginIndex({
            stateDir: path.join(home, ".openclaw"),
          }),
        ).resolves.toMatchObject({
          installRecords: {
            demo: {
              source: "npm",
              spec: "demo@1.0.0",
              installPath: pluginDir,
            },
          },
          plugins: [
            expect.objectContaining({
              pluginId: "demo",
              installRecordHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
            }),
          ],
        });
        const persistedConfig = JSON.parse(await fs.readFile(configPath, "utf-8")) as {
          plugins?: { installs?: unknown };
        };
        expect(persistedConfig.plugins?.installs).toBeUndefined();
      } finally {
        mockLoadPluginManifestRegistry.mockReturnValue({
          diagnostics: [],
          plugins: [],
        } satisfies PluginManifestRegistry);
      }
    });
  });

  it("migrates shipped plugin install config records even when the manifest is missing", async () => {
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      const pluginDir = path.join(home, ".openclaw", "plugins", "missing");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(
        configPath,
        `${JSON.stringify(
          {
            plugins: {
              entries: { missing: { enabled: true } },
              installs: {
                missing: {
                  source: "npm",
                  spec: "missing-plugin@1.0.0",
                  installPath: pluginDir,
                },
              },
            },
          },
          null,
          2,
        )}\n`,
        "utf-8",
      );

      const io = createFastConfigIO(home);
      const cfg = io.loadConfig();

      expect(cfg.plugins?.installs).toBeUndefined();
      await expect(
        readPersistedInstalledPluginIndex({
          stateDir: path.join(home, ".openclaw"),
        }),
      ).resolves.toMatchObject({
        installRecords: {
          missing: {
            source: "npm",
            spec: "missing-plugin@1.0.0",
            installPath: pluginDir,
          },
        },
        plugins: [],
      });
      const persistedConfig = JSON.parse(await fs.readFile(configPath, "utf-8")) as {
        plugins?: { installs?: unknown };
      };
      expect(persistedConfig.plugins?.installs).toBeUndefined();
    });
  });

  it("keeps shipped plugin install config records when index migration fails", async () => {
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      const unwritableStatePath = path.join(home, ".openclaw");
      const pluginDir = path.join(unwritableStatePath, "plugins", "demo");
      const original = {
        plugins: {
          entries: { demo: { enabled: true } },
          installs: {
            demo: {
              source: "npm",
              spec: "demo@1.0.0",
              installPath: pluginDir,
            },
          },
        },
      };
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, `${JSON.stringify(original, null, 2)}\n`, "utf-8");
      const warn = vi.fn();
      const io = createConfigIO({
        env: { OPENCLAW_TEST_FAST: "1" } as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: { warn, error: vi.fn() },
      });
      await fs.writeFile(path.join(unwritableStatePath, "plugins"), "not a directory", "utf-8");

      expect(() => io.loadConfig()).toThrow('Unrecognized key: "installs"');
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("could not migrate shipped plugins.installs records"),
      );

      await expect(io.writeConfigFile({ gateway: { mode: "local" } })).rejects.toThrow(
        "Config write blocked: shipped plugins.installs records",
      );

      const persisted = JSON.parse(await fs.readFile(configPath, "utf-8")) as typeof original;
      expect(persisted.plugins.installs.demo).toMatchObject({
        source: "npm",
        spec: "demo@1.0.0",
        installPath: pluginDir,
      });
    });
  });

  it("rolls back shipped plugin install index migration when config write fails", async () => {
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      const pluginDir = path.join(home, ".openclaw", "plugins", "demo");
      const original = {
        plugins: {
          entries: { demo: { enabled: true } },
          installs: {
            demo: {
              source: "npm",
              spec: "demo@1.0.0",
              installPath: pluginDir,
            },
          },
        },
      };
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, `${JSON.stringify(original, null, 2)}\n`, "utf-8");
      mockMaintainConfigBackups.mockRejectedValueOnce(new Error("backup failed"));

      const io = createFastConfigIO(home);
      await expect(io.writeConfigFile({ gateway: { mode: "local" } })).rejects.toThrow(
        "backup failed",
      );

      const persistedConfig = JSON.parse(await fs.readFile(configPath, "utf-8")) as typeof original;
      expect(persistedConfig.plugins.installs.demo).toMatchObject({
        source: "npm",
        spec: "demo@1.0.0",
        installPath: pluginDir,
      });
      await expect(
        readPersistedInstalledPluginIndex({
          stateDir: path.join(home, ".openclaw"),
        }),
      ).resolves.toBeNull();
    });
  });

  const writeGatewayPortAndReadConfig = async (home: string, configPath: string) => {
    const io = createFastConfigIO(home);

    await io.writeConfigFile({
      gateway: { mode: "local", port: 18789 },
    });

    return JSON.parse(await fs.readFile(configPath, "utf-8")) as {
      $schema?: string;
      gateway?: { mode?: string; port?: number };
    };
  };

  it.runIf(process.platform !== "win32")(
    "tightens world-writable state dir when writing the default config",
    async () => {
      await withSuiteHome(async (home) => {
        const stateDir = path.join(home, ".openclaw");
        await fs.mkdir(stateDir, { recursive: true, mode: 0o777 });
        await fs.chmod(stateDir, 0o777);

        const io = createConfigIO({
          env: {} as NodeJS.ProcessEnv,
          homedir: () => home,
          logger: silentLogger,
        });

        await io.writeConfigFile({ gateway: { mode: "local" } });

        const stat = await fs.stat(stateDir);
        expect(stat.mode & 0o777).toBe(0o700);
      });
    },
  );

  it("keeps writes inside an OPENCLAW_STATE_DIR override even when the real home config exists", async () => {
    await withSuiteHome(async (home) => {
      const liveConfigPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(liveConfigPath), { recursive: true });
      await fs.writeFile(
        liveConfigPath,
        `${JSON.stringify({ gateway: { mode: "local", port: 18789 } }, null, 2)}\n`,
        "utf-8",
      );

      const overrideDir = path.join(home, "isolated-state");
      const env = { OPENCLAW_STATE_DIR: overrideDir } as NodeJS.ProcessEnv;
      const io = createConfigIO({
        env,
        homedir: () => home,
        logger: silentLogger,
      });

      expect(io.configPath).toBe(path.join(overrideDir, "openclaw.json"));

      await io.writeConfigFile({
        agents: { list: [{ id: "main", default: true }] },
        gateway: { mode: "local" },
        session: { mainKey: "main", store: path.join(overrideDir, "sessions.json") },
      });

      const livePersisted = JSON.parse(await fs.readFile(liveConfigPath, "utf-8")) as {
        gateway?: { mode?: unknown; port?: unknown };
      };
      expect(livePersisted.gateway).toEqual({ mode: "local", port: 18789 });

      const overridePersisted = JSON.parse(
        await fs.readFile(path.join(overrideDir, "openclaw.json"), "utf-8"),
      ) as {
        session?: { store?: unknown };
      };
      expect(overridePersisted.session?.store).toBe(path.join(overrideDir, "sessions.json"));
    });
  });

  it("does not mutate caller config when unsetPaths is applied on first write", async () => {
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      const io = createConfigIO({
        env: {} as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: silentLogger,
      });

      const input: Record<string, unknown> = {
        gateway: { mode: "local" },
        commands: { ownerDisplay: "hash" },
      };

      await io.writeConfigFile(input, { unsetPaths: [["commands", "ownerDisplay"]] });

      expect(input).toEqual({
        gateway: { mode: "local" },
        commands: { ownerDisplay: "hash" },
      });
      expectInputOwnerDisplayUnchanged(input);
      expect((await readPersistedCommands(configPath)) ?? {}).not.toHaveProperty("ownerDisplay");
    });
  });

  it("does not log an overwrite audit entry when creating config for the first time", async () => {
    await withSuiteHome(async (home) => {
      const warn = vi.fn();
      const io = createConfigIO({
        env: {} as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: {
          warn,
          error: vi.fn(),
        },
      });

      await io.writeConfigFile({
        gateway: { mode: "local" },
      });

      const overwriteLogs = warn.mock.calls.filter(
        (call) => typeof call[0] === "string" && call[0].startsWith("Config overwrite:"),
      );
      expect(overwriteLogs).toHaveLength(0);
    });
  });

  it("suppresses overwrite audit output when skipOutputLogs is set", async () => {
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(
        configPath,
        `${JSON.stringify({ gateway: { mode: "local", port: 18789 } }, null, 2)}\n`,
        "utf-8",
      );
      const warn = vi.fn();
      const io = createConfigIO({
        env: {
          VITEST: "true",
          OPENCLAW_TEST_CONFIG_OVERWRITE_LOG: "1",
        } as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: {
          warn,
          error: vi.fn(),
        },
      });

      await io.writeConfigFile(
        {
          gateway: { mode: "local", port: 18790 },
        },
        { skipOutputLogs: true },
      );

      const overwriteLogs = warn.mock.calls.filter(
        (call) => typeof call[0] === "string" && call[0].startsWith("Config overwrite:"),
      );
      expect(overwriteLogs).toHaveLength(0);
    });
  });

  it("preserves root $schema during partial writes", async () => {
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(
        configPath,
        `${JSON.stringify(
          {
            $schema: "https://openclaw.ai/config.json",
            gateway: { mode: "local" },
          },
          null,
          2,
        )}\n`,
        "utf-8",
      );

      const persisted = await writeGatewayPortAndReadConfig(home, configPath);
      expect(persisted.$schema).toBe("https://openclaw.ai/config.json");
      expect(persisted.gateway).toEqual({ mode: "local", port: 18789 });
    });
  });

  it("recovers configs polluted by a leading status line", async () => {
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      const cleanConfig = {
        gateway: { mode: "local" },
        agents: { list: [{ id: "main", default: true }, { id: "discord-dm" }] },
      } satisfies ConfigFileSnapshot["config"];
      const cleanRaw = `${JSON.stringify(cleanConfig, null, 2)}\n`;
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, `Found and updated: False\n${cleanRaw}`, "utf-8");
      const warn = vi.fn();
      const io = createConfigIO({
        env: { VITEST: "true" } as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: { warn, error: vi.fn() },
      });

      const initialSnapshot = await io.readConfigFileSnapshot();
      expect(initialSnapshot.valid).toBe(false);

      await expect(io.recoverConfigFromJsonRootSuffix(initialSnapshot)).resolves.toBe(true);
      const recoveredSnapshot = await io.readConfigFileSnapshot();

      expect(recoveredSnapshot.valid).toBe(true);
      expect(recoveredSnapshot.config.gateway?.mode).toBe("local");
      expect(recoveredSnapshot.config.agents?.list?.map((entry) => entry.id)).toEqual([
        "main",
        "discord-dm",
      ]);
      await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(cleanRaw);
      const entries = await fs.readdir(path.dirname(configPath));
      expect(entries.some((entry) => entry.includes(".clobbered."))).toBe(true);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("Config auto-stripped non-JSON prefix:"),
      );
    });
  });

  it("rejects destructive internal writes before replacing the config", async () => {
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      const original = {
        gateway: { mode: "local" },
        channels: { telegram: { enabled: true, dmPolicy: "pairing" } },
        agents: { list: [{ id: "main", default: true, workspace: "/tmp/openclaw-main" }] },
        tools: { profile: "messaging" },
        commands: { ownerDisplay: "hash" },
      } satisfies ConfigFileSnapshot["config"];
      const originalRaw = `${JSON.stringify(original, null, 2)}\n`;
      await fs.writeFile(configPath, originalRaw, "utf-8");
      const warn = vi.fn();
      const io = createConfigIO({
        env: { VITEST: "true" } as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: { warn, error: vi.fn() },
      });
      const baseSnapshot = {
        path: configPath,
        exists: true,
        raw: originalRaw,
        parsed: original,
        sourceConfig: original,
        resolved: original,
        valid: true,
        runtimeConfig: original,
        config: original,
        issues: [],
        warnings: [],
        legacyIssues: [],
      } satisfies ConfigFileSnapshot;

      await expect(
        io.writeConfigFile(
          { update: { channel: "beta" } },
          {
            baseSnapshot,
          },
        ),
      ).rejects.toMatchObject({
        code: "CONFIG_WRITE_REJECTED",
      });

      await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(originalRaw);
      const entries = await fs.readdir(path.dirname(configPath));
      expect(entries.some((entry) => entry.includes(".rejected."))).toBe(true);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("Config write rejected:"));
    });
  });

  it("preserves parsed source config when snapshot validation throws", async () => {
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      const original = {
        gateway: { mode: "local" },
        channels: { "test-plugin-channel": { enabled: true } },
      };
      const originalRaw = `${JSON.stringify(original, null, 2)}\n`;
      await fs.writeFile(configPath, originalRaw, "utf-8");
      mockLoadPluginManifestRegistry.mockImplementationOnce(() => {
        throw new Error("manifest registry unavailable");
      });

      const io = createFastConfigIO(home);

      const snapshot = await io.readConfigFileSnapshot();

      expect(snapshot.valid).toBe(false);
      expect(snapshot.raw).toBe(originalRaw);
      expect(snapshot.parsed).toEqual(original);
      expect(snapshot.sourceConfig).toEqual(original);
      expect(snapshot.config).toEqual(original);
      expect(snapshot.issues[0]?.message).toContain("manifest registry unavailable");
    });
  });

  it("rejects root-include partial writes instead of flattening the root config", async () => {
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      const includePath = path.join(home, ".openclaw", "extra.json5");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(
        includePath,
        `${JSON.stringify({ $schema: "https://openclaw.ai/config-from-include.json" }, null, 2)}\n`,
        "utf-8",
      );
      await fs.writeFile(
        configPath,
        `{\n  "$include": "./extra.json5",\n  "gateway": { "mode": "local" }\n}\n`,
        "utf-8",
      );
      const originalRaw = await fs.readFile(configPath, "utf-8");

      await expect(writeGatewayPortAndReadConfig(home, configPath)).rejects.toThrow(
        "Config write would flatten $include-owned config at <root>",
      );
      await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(originalRaw);
    });
  });

  it("writes disabled plugin entries without requiring plugin config", async () => {
    mockLoadPluginManifestRegistry.mockReturnValue({
      diagnostics: [],
      plugins: [
        {
          id: "required-plugin",
          origin: "bundled",
          channels: [],
          providers: [],
          cliBackends: [],
          skills: [],
          hooks: [],
          rootDir: "/tmp/openclaw-test-required-plugin",
          source: "/tmp/openclaw-test-required-plugin/index.ts",
          manifestPath: "/tmp/openclaw-test-required-plugin/openclaw.plugin.json",
          configSchema: {
            type: "object",
            properties: {
              token: { type: "string" },
            },
            required: ["token"],
            additionalProperties: true,
          },
        },
      ],
    } satisfies PluginManifestRegistry);

    await withSuiteHome(async (home) => {
      const io = createConfigIO({
        env: { VITEST: "true" } as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: silentLogger,
      });

      await expect(
        io.writeConfigFile({
          agents: { list: [{ id: "main", default: true }] },
          plugins: {
            entries: {
              "required-plugin": {
                enabled: false,
              },
            },
          },
        }),
      ).resolves.toMatchObject({ persistedHash: expect.any(String) });
    });

    mockLoadPluginManifestRegistry.mockReturnValue({
      diagnostics: [],
      plugins: [],
    } satisfies PluginManifestRegistry);
  });

  it("writes runtime-derived edits back to source SecretRef markers", async () => {
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      const previousConfigPath = process.env.OPENCLAW_CONFIG_PATH;
      process.env.OPENCLAW_CONFIG_PATH = configPath;
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(
        configPath,
        `${JSON.stringify(
          {
            gateway: { mode: "local" },
            models: {
              providers: {
                openai: {
                  baseUrl: "https://api.openai.com/v1",
                  apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
                  models: [],
                },
              },
            },
          },
          null,
          2,
        )}\n`,
        "utf-8",
      );

      try {
        setRuntimeConfigSnapshot(
          {
            gateway: { mode: "local" },
            models: {
              providers: {
                openai: {
                  baseUrl: "https://api.openai.com/v1",
                  apiKey: "sk-runtime-resolved",
                  models: [],
                },
              },
            },
          },
          {
            gateway: { mode: "local" },
            models: {
              providers: {
                openai: {
                  baseUrl: "https://api.openai.com/v1",
                  apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
                  models: [],
                },
              },
            },
          },
        );

        await writeConfigFile({
          gateway: { mode: "local", port: 18789 },
          models: {
            providers: {
              openai: {
                baseUrl: "https://api.openai.com/v1",
                apiKey: "sk-runtime-resolved",
                models: [],
              },
            },
          },
        });

        expect(JSON.parse(await fs.readFile(configPath, "utf-8"))).toEqual({
          gateway: { mode: "local", port: 18789 },
          models: {
            providers: {
              openai: {
                baseUrl: "https://api.openai.com/v1",
                apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
                models: [],
              },
            },
          },
          meta: {
            lastTouchedAt: expect.any(String),
            lastTouchedVersion: expect.any(String),
          },
        });
      } finally {
        if (previousConfigPath === undefined) {
          delete process.env.OPENCLAW_CONFIG_PATH;
        } else {
          process.env.OPENCLAW_CONFIG_PATH = previousConfigPath;
        }
      }
    });
  });

  it("notifies in-process reloaders with resolved source config when persisted env refs are restored", async () => {
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      const previousConfigPath = process.env.OPENCLAW_CONFIG_PATH;
      const previousGatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;
      process.env.OPENCLAW_CONFIG_PATH = configPath;
      process.env.OPENCLAW_GATEWAY_TOKEN = "gateway-token-runtime";
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(
        configPath,
        `${JSON.stringify(
          {
            gateway: {
              mode: "local",
              auth: { mode: "token", token: "${OPENCLAW_GATEWAY_TOKEN}" },
            },
            agents: { defaults: { model: { primary: "openai/gpt-5.4" } } },
          },
          null,
          2,
        )}\n`,
        "utf-8",
      );
      const observedSources: unknown[] = [];
      const unsubscribe = registerConfigWriteListener((event) => {
        observedSources.push(event.sourceConfig);
      });

      try {
        setRuntimeConfigSnapshot(
          {
            gateway: {
              mode: "local",
              auth: { mode: "token", token: "gateway-token-runtime" },
            },
            agents: { defaults: { model: { primary: "openai/gpt-5.4" } } },
          },
          {
            gateway: {
              mode: "local",
              auth: { mode: "token", token: "gateway-token-runtime" },
            },
            agents: { defaults: { model: { primary: "openai/gpt-5.4" } } },
          },
        );

        await writeConfigFile({
          gateway: {
            mode: "local",
            auth: { mode: "token", token: "gateway-token-runtime" },
          },
          agents: { defaults: { model: { primary: "openrouter/anthropic/claude-sonnet-4.6" } } },
        });

        expect(JSON.parse(await fs.readFile(configPath, "utf-8"))).toMatchObject({
          gateway: {
            auth: { token: "${OPENCLAW_GATEWAY_TOKEN}" },
          },
        });
        expect(observedSources).toEqual([
          expect.objectContaining({
            gateway: {
              mode: "local",
              auth: { mode: "token", token: "gateway-token-runtime" },
            },
            agents: {
              defaults: {
                model: { primary: "openrouter/anthropic/claude-sonnet-4.6" },
              },
            },
          }),
        ]);
      } finally {
        unsubscribe();
        if (previousConfigPath === undefined) {
          delete process.env.OPENCLAW_CONFIG_PATH;
        } else {
          process.env.OPENCLAW_CONFIG_PATH = previousConfigPath;
        }
        if (previousGatewayToken === undefined) {
          delete process.env.OPENCLAW_GATEWAY_TOKEN;
        } else {
          process.env.OPENCLAW_GATEWAY_TOKEN = previousGatewayToken;
        }
      }
    });
  });
});
