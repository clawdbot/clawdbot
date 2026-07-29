// Covers config write preparation, backup, and persistence behavior.
import fsNode from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import chokidar from "chokidar";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { startGatewayConfigReloader } from "../gateway/config-reload.js";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { readConfigMachineState } from "../state/config-machine-state.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import { initializePublishedConfigRuntimeEnv, prepareConfigRuntimeEnv } from "./config-env-vars.js";
import { readConfigSnapshotAuditRecord } from "./config-journal-snapshot.js";
import { hashConfigIncludeRaw } from "./includes.js";
import { listConfigAuditRecordsForTests } from "./io.audit.test-support.js";
import {
  createConfigIO as createObservedConfigIO,
  getRuntimeConfigSourceSnapshot,
  readConfigFileSnapshotForRuntimeTransaction,
  registerConfigWriteListener,
  resetConfigRuntimeState,
  setRuntimeConfigSnapshot,
  setRuntimeConfigSnapshotRefreshHandler,
  writeConfigFile,
} from "./io.js";
import { ConfigMutationConflictError } from "./mutation-conflict.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "./types.openclaw.js";

const CONFIG_CLOBBER_SNAPSHOT_LIMIT = 32;
type ConfigHealthDatabase = Pick<OpenClawStateKyselyDatabase, "config_health_entries">;

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

vi.mock("../plugins/plugin-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/plugin-registry.js")>();
  return {
    ...actual,
    loadPluginManifestRegistryForPluginRegistry: mockLoadPluginManifestRegistry,
  };
});

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

type ConfigIoOptions = Parameters<typeof createObservedConfigIO>[0];

function createConfigIO(options: ConfigIoOptions = {}) {
  const env = options.env ?? ({} as NodeJS.ProcessEnv);
  if (!("NODE_ENV" in env)) {
    // Route real SQLite state through Vitest's worker DB without adding a key to config env snapshots.
    Object.defineProperty(env, "NODE_ENV", { configurable: true, value: "test" });
  }
  return createObservedConfigIO({
    observe: false,
    ...options,
    env,
  });
}

describe("config io write", () => {
  const suiteRootTracker = createSuiteTempRootTracker({ prefix: "openclaw-config-io-" });
  const silentLogger = {
    warn: () => {},
    error: () => {},
  };

  async function withSuiteHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
    const home = await suiteRootTracker.make("case");
    return withEnvAsync(
      {
        OPENCLAW_DEFER_SHELL_ENV_FALLBACK: undefined,
        OPENCLAW_LOAD_SHELL_ENV: undefined,
        OPENCLAW_SHELL_ENV_TIMEOUT_MS: undefined,
      },
      () => fn(home),
    );
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
    closeOpenClawStateDatabaseForTest();
    resetConfigRuntimeState();
    await suiteRootTracker.cleanup();
  });

  function readConfigHealthRow(home: string, configPath: string) {
    const { db } = openOpenClawStateDatabase({ env: { HOME: home } as NodeJS.ProcessEnv });
    const healthDb = getNodeSqliteKysely<ConfigHealthDatabase>(db);
    return executeSqliteQueryTakeFirstSync(
      db,
      healthDb
        .selectFrom("config_health_entries")
        .select(["config_path", "last_known_good_json"])
        .where("config_path", "=", configPath),
    );
  }

  const expectInputCommandRestartUnchanged = (input: Record<string, unknown>) => {
    expect((input.commands as Record<string, unknown>).restart).toBe(false);
  };

  const readPersistedCommands = async (configPath: string) => {
    const persisted = JSON.parse(await fs.readFile(configPath, "utf-8")) as {
      commands?: Record<string, unknown>;
    };
    return persisted.commands;
  };

  const requireRecord = (value: unknown, label: string): Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`expected ${label} to be a record`);
    }
    return value as Record<string, unknown>;
  };

  const expectConfigWriteRejected = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (error) {
      expect(requireRecord(error, "config write rejection").code).toBe("CONFIG_WRITE_REJECTED");
      return;
    }
    throw new Error("expected config write rejection");
  };

  const expectPersistedHashResult = (result: unknown) => {
    const persistedHash = requireRecord(result, "config write result").persistedHash;
    expect(typeof persistedHash).toBe("string");
    expect(persistedHash).not.toBe("");
  };

  const warnMessages = (warn: ReturnType<typeof vi.fn>): string[] =>
    warn.mock.calls.map(([message]) => String(message));

  const expectWarnContaining = (warn: ReturnType<typeof vi.fn>, expected: string) => {
    expect(warnMessages(warn).join("\n")).toContain(expected);
  };

  const configPathForHome = (home: string, fileName = "openclaw.json") =>
    path.join(home, ".openclaw", fileName);

  const formatConfig = (config: unknown) => `${JSON.stringify(config, null, 2)}\n`;

  const readPersistedConfig = async (configPath: string): Promise<OpenClawConfig> =>
    JSON.parse(await fs.readFile(configPath, "utf-8")) as OpenClawConfig;

  const writeConfigJson = async (configPath: string, config: unknown) => {
    await fs.writeFile(configPath, formatConfig(config), "utf-8");
  };

  const writeConfigFixture = async (home: string, config: unknown) => {
    const configPath = configPathForHome(home);
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await writeConfigJson(configPath, config);
    return { configPath, raw: formatConfig(config) };
  };

  const createHomeConfigIO = (home: string, options: ConfigIoOptions = {}) =>
    createConfigIO({ homedir: () => home, logger: silentLogger, ...options });

  const itWithHome = (name: string, testCase: (home: string) => Promise<void>) => {
    it(name, () => withSuiteHome(testCase));
  };

  const createFastConfigIO = (home: string, options: ConfigIoOptions = {}) =>
    createHomeConfigIO(home, {
      env: { OPENCLAW_TEST_FAST: "1" } as NodeJS.ProcessEnv,
      ...options,
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

  itWithHome("writes health state to SQLite through public config reads", async (home) => {
    const configPath = configPathForHome(home);
    const healthPath = path.join(home, ".openclaw", "logs", "config-health.json");
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await writeConfigJson(configPath, { gateway: { mode: "local" } });
    const warn = vi.fn();
    const io = createHomeConfigIO(home, {
      configPath,
      env: {
        OPENCLAW_STATE_DIR: path.join(home, ".openclaw"),
        OPENCLAW_TEST_FAST: "1",
      } as NodeJS.ProcessEnv,
      logger: { warn, error: vi.fn() },
      observe: true,
    });

    const snapshot = await io.readConfigFileSnapshot();
    expect(snapshot.exists).toBe(true);
    expect(io.loadConfig().gateway).toEqual({ mode: "local" });
    await expect(fs.stat(healthPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(readConfigHealthRow(home, configPath)).toMatchObject({
      config_path: configPath,
      last_known_good_json: expect.any(String),
    });
    expect(warn.mock.calls.flat()).not.toContainEqual(
      expect.stringContaining("Config health-state write failed"),
    );
  });

  itWithHome("refuses direct config writes in Nix mode without changing the file", async (home) => {
    const { configPath, raw: initialRaw } = await writeConfigFixture(home, {
      gateway: { mode: "local" },
    });
    const io = createHomeConfigIO(home, {
      configPath,
      env: {
        OPENCLAW_NIX_MODE: "1",
        OPENCLAW_TEST_FAST: "1",
      } as NodeJS.ProcessEnv,
    });

    await expect(io.writeConfigFile({ gateway: { mode: "local", port: 19001 } })).rejects.toThrow(
      "Agent-first Nix setup: https://github.com/openclaw/nix-openclaw#quick-start",
    );

    await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(initialRaw);
  });

  itWithHome(
    "dedupes validation warnings across writes and reloads until config becomes clean",
    async (home) => {
      const warn = vi.fn();
      const io = createHomeConfigIO(home, {
        env: { HOME: home, OPENCLAW_TEST_FAST: "1" } as NodeJS.ProcessEnv,
        logger: { warn, error: vi.fn() },
      });
      const staleConfig = {
        plugins: { entries: { demo: { enabled: true } } },
      };

      await io.writeConfigFile(staleConfig);
      await io.writeConfigFile(staleConfig);
      io.loadConfig();
      expect(warn).toHaveBeenCalledTimes(1);

      await expect(
        io.writeConfigFile(
          {},
          {
            preCommitRuntimePreflight: async () => {
              throw new Error("blocked");
            },
          },
        ),
      ).rejects.toThrow("blocked");
      io.loadConfig();
      expect(warn).toHaveBeenCalledTimes(1);

      await io.writeConfigFile(staleConfig, { skipPluginValidation: true });
      io.loadConfig();
      expect(warn).toHaveBeenCalledTimes(1);

      await io.writeConfigFile({});
      await io.writeConfigFile(staleConfig);
      expect(warn).toHaveBeenCalledTimes(2);
    },
  );

  itWithHome(
    "keeps writes inside an OPENCLAW_STATE_DIR override even when the real home config exists",
    async (home) => {
      const liveConfigPath = configPathForHome(home);
      await fs.mkdir(path.dirname(liveConfigPath), { recursive: true });
      await writeConfigJson(liveConfigPath, { gateway: { mode: "local", port: 18789 } });

      const overrideDir = path.join(home, "isolated-state");
      const env = { OPENCLAW_STATE_DIR: overrideDir } as NodeJS.ProcessEnv;
      const io = createHomeConfigIO(home, {
        env,
      });

      expect(io.configPath).toBe(path.join(overrideDir, "openclaw.json"));

      await io.writeConfigFile({
        agents: { entries: { main: { default: true } } },
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
    },
  );

  itWithHome(
    "does not mutate caller config when unsetPaths is applied on first write",
    async (home) => {
      const configPath = configPathForHome(home);
      const io = createHomeConfigIO(home, {
        env: {} as NodeJS.ProcessEnv,
      });

      const input: Record<string, unknown> = {
        gateway: { mode: "local" },
        commands: { restart: false },
      };

      await io.writeConfigFile(input, { unsetPaths: [["commands", "restart"]] });

      expect(input).toEqual({
        gateway: { mode: "local" },
        commands: { restart: false },
      });
      expectInputCommandRestartUnchanged(input);
      expect((await readPersistedCommands(configPath)) ?? {}).not.toHaveProperty("restart");
    },
  );

  itWithHome("drops keys that exist only on the next-config prototype", async (home) => {
    const { configPath } = await writeConfigFixture(home, {
      gateway: { mode: "local", port: 18789 },
      commands: { restart: false },
    });

    const io = createFastConfigIO(home, { configPath });

    const nextConfig = Object.assign(
      Object.create({ commands: { restart: true } }) as Record<string, unknown>,
      { gateway: { mode: "local", port: 19001 } },
    );

    await io.writeConfigFile(nextConfig as OpenClawConfig);

    const persisted = JSON.parse(await fs.readFile(configPath, "utf-8")) as Record<string, unknown>;
    expect(persisted.gateway).toEqual({ mode: "local", port: 19001 });
    expect(Object.hasOwn(persisted, "commands")).toBe(false);
  });

  type WriteAuditCase = {
    name: string;
    seedExistingConfig?: boolean;
    env?: NodeJS.ProcessEnv;
    logPrefix: string;
    expectedWarnings?: readonly string[];
    skipOutputLogs?: boolean;
  };

  const writeAuditCases: readonly WriteAuditCase[] = [
    {
      name: "does not log an overwrite audit entry when creating config for the first time",
      logPrefix: "Config overwrite:",
    },
    {
      name: "does not print overwrite audit output by default when updating config",
      seedExistingConfig: true,
      logPrefix: "Config overwrite:",
    },
    {
      name: "does not print benign missing-meta write anomalies by default",
      seedExistingConfig: true,
      logPrefix: "Config write anomaly:",
    },
    {
      name: "prints missing-meta write anomalies when test anomaly logging is requested",
      seedExistingConfig: true,
      env: { OPENCLAW_TEST_CONFIG_WRITE_LOG: "1" },
      logPrefix: "Config write anomaly:",
      expectedWarnings: ["Config write anomaly:", "missing-meta-before-write"],
    },
    {
      name: "suppresses overwrite audit output when skipOutputLogs is set",
      seedExistingConfig: true,
      env: { VITEST: "true", OPENCLAW_TEST_CONFIG_WRITE_LOG: "1" },
      logPrefix: "Config overwrite:",
      skipOutputLogs: true,
    },
  ];

  for (const auditCase of writeAuditCases) {
    itWithHome(auditCase.name, async (home) => {
      if (auditCase.seedExistingConfig) {
        await writeConfigFixture(home, { gateway: { mode: "local", port: 18789 } });
      }
      const warn = vi.fn();
      const io = createHomeConfigIO(home, {
        env: auditCase.env ?? ({} as NodeJS.ProcessEnv),
        logger: { warn, error: vi.fn() },
      });
      const config: OpenClawConfig = auditCase.seedExistingConfig
        ? { gateway: { mode: "local", port: 18790 } }
        : { gateway: { mode: "local" } };

      await io.writeConfigFile(
        config,
        auditCase.skipOutputLogs ? { skipOutputLogs: true } : undefined,
      );

      if (auditCase.expectedWarnings) {
        for (const expectedWarning of auditCase.expectedWarnings) {
          expect(warn.mock.calls).toContainEqual([expect.stringContaining(expectedWarning)]);
        }
      } else {
        const auditLogs = warn.mock.calls.filter(
          (call) => typeof call[0] === "string" && call[0].startsWith(auditCase.logPrefix),
        );
        expect(auditLogs).toHaveLength(0);
      }
    });
  }

  itWithHome("preserves root $schema during partial writes", async (home) => {
    const { configPath } = await writeConfigFixture(home, {
      $schema: "https://openclaw.ai/config.json",
      gateway: { mode: "local" },
    });

    const persisted = await writeGatewayPortAndReadConfig(home, configPath);
    expect(persisted.$schema).toBe("https://openclaw.ai/config.json");
    expect(persisted.gateway).toEqual({ mode: "local", port: 18789 });
  });

  itWithHome("recovers configs polluted by a leading status line", async (home) => {
    const configPath = configPathForHome(home);
    const cleanConfig = {
      gateway: { mode: "local" },
      agents: { entries: { main: { default: true }, "discord-dm": {} } },
    } satisfies ConfigFileSnapshot["config"];
    const cleanRaw = formatConfig(cleanConfig);
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, `Found and updated: False\n${cleanRaw}`, "utf-8");
    const warn = vi.fn();
    const io = createHomeConfigIO(home, {
      env: { VITEST: "true" } as NodeJS.ProcessEnv,
      logger: { warn, error: vi.fn() },
    });

    const initialSnapshot = await io.readConfigFileSnapshot();
    expect(initialSnapshot.valid).toBe(false);

    await expect(io.recoverConfigFromJsonRootSuffix(initialSnapshot)).resolves.toBe(true);
    const recoveredSnapshot = await io.readConfigFileSnapshot();

    expect(recoveredSnapshot.valid).toBe(true);
    expect(recoveredSnapshot.config.gateway?.mode).toBe("local");
    expect(Object.keys(recoveredSnapshot.config.agents?.entries ?? {})).toEqual([
      "main",
      "discord-dm",
    ]);
    await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(cleanRaw);
    const entries = await fs.readdir(path.dirname(configPath));
    const clobberedEntries = entries.filter((entry) => entry.includes(".clobbered."));
    expect(clobberedEntries).toHaveLength(1);
    expect(warn.mock.calls).toEqual([
      [
        `Config auto-stripped non-JSON prefix: ${configPath} (original saved as ${path.join(
          path.dirname(configPath),
          clobberedEntries[0] ?? "",
        )})`,
      ],
    ]);
  });

  itWithHome("warns when prefix recovery cannot tighten config permissions", async (home) => {
    const configPath = configPathForHome(home);
    const cleanConfig = {
      gateway: { mode: "local" },
      agents: { entries: { main: { default: true }, "discord-dm": {} } },
    } satisfies ConfigFileSnapshot["config"];
    const cleanRaw = formatConfig(cleanConfig);
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, `Found and updated: False\n${cleanRaw}`, "utf-8");
    const chmodError = Object.assign(new Error("EPERM: chmod denied"), { code: "EPERM" });
    const warn = vi.fn();
    const chmod = fsNode.promises.chmod.bind(fsNode.promises);
    const io = createHomeConfigIO(home, {
      fs: {
        ...fsNode,
        promises: {
          ...fsNode.promises,
          chmod: async (target, mode) => {
            if (target === configPath) {
              throw chmodError;
            }
            return await chmod(target, mode);
          },
        },
      },
      env: { VITEST: "true" } as NodeJS.ProcessEnv,
      logger: { warn, error: vi.fn() },
    });

    const initialSnapshot = await io.readConfigFileSnapshot();
    expect(initialSnapshot.valid).toBe(false);

    await expect(io.recoverConfigFromJsonRootSuffix(initialSnapshot)).resolves.toBe(true);
    await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(cleanRaw);
    expect(warnMessages(warn)).toContain(
      `Config permission hardening failed (prefix recovery): ${configPath}: EPERM: chmod denied`,
    );
    expectWarnContaining(warn, `Config auto-stripped non-JSON prefix: ${configPath}`);
  });

  itWithHome(
    "rotates repeated prefix-recovery clobber snapshots for doctor-style repair loops",
    async (home) => {
      const configPath = configPathForHome(home);
      const cleanConfig = {
        gateway: { mode: "local" },
        agents: { entries: { main: { default: true } } },
      } satisfies ConfigFileSnapshot["config"];
      const cleanRaw = formatConfig(cleanConfig);
      const warn = vi.fn();
      const io = createHomeConfigIO(home, {
        env: { VITEST: "true" } as NodeJS.ProcessEnv,
        logger: { warn, error: vi.fn() },
      });

      await fs.mkdir(path.dirname(configPath), { recursive: true });
      for (let index = 0; index < CONFIG_CLOBBER_SNAPSHOT_LIMIT + 4; index++) {
        await fs.writeFile(configPath, `Found and updated: False ${index}\n${cleanRaw}`, "utf-8");
        const snapshot = await io.readConfigFileSnapshot();
        expect(snapshot.valid).toBe(false);
        await expect(io.recoverConfigFromJsonRootSuffix(snapshot)).resolves.toBe(true);
      }

      const entries = await fs.readdir(path.dirname(configPath));
      const clobbered = entries.filter((entry) => entry.includes(".clobbered."));
      expect(clobbered).toHaveLength(CONFIG_CLOBBER_SNAPSHOT_LIMIT);
      const clobberedContents = await Promise.all(
        clobbered.map((entry) => fs.readFile(path.join(path.dirname(configPath), entry), "utf-8")),
      );
      expect(clobberedContents).not.toContain(`Found and updated: False 0\n${cleanRaw}`);
      expect(clobberedContents).toContain(
        `Found and updated: False ${CONFIG_CLOBBER_SNAPSHOT_LIMIT + 3}\n${cleanRaw}`,
      );
      const capWarnings = warn.mock.calls.filter(
        ([message]) =>
          typeof message === "string" && message.includes("Config clobber snapshot cap reached"),
      );
      expect(capWarnings).toHaveLength(1);
      await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(cleanRaw);
    },
  );

  itWithHome("rejects destructive internal writes before replacing the config", async (home) => {
    const configPath = configPathForHome(home);
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    const original = {
      gateway: { mode: "local" },
      channels: { telegram: { enabled: true, dmPolicy: "pairing" } },
      agents: { entries: { main: { default: true, workspace: "/tmp/openclaw-main" } } },
      tools: { profile: "messaging" },
      commands: { restart: false },
    } satisfies ConfigFileSnapshot["config"];
    const originalRaw = formatConfig(original);
    await fs.writeFile(configPath, originalRaw, "utf-8");
    const warn = vi.fn();
    const io = createHomeConfigIO(home, {
      env: { VITEST: "true" } as NodeJS.ProcessEnv,
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

    await expectConfigWriteRejected(
      io.writeConfigFile(
        { update: { channel: "beta" } },
        {
          baseSnapshot,
        },
      ),
    );

    await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(originalRaw);
    const entries = await fs.readdir(path.dirname(configPath));
    const rejectedEntries = entries.filter((entry) => entry.includes(".rejected."));
    expect(rejectedEntries).toHaveLength(1);
    expect(warn.mock.calls).toEqual([
      [
        `Config write rejected: ${configPath} (gateway-mode-removed). Rejected payload saved to ${path.join(
          path.dirname(configPath),
          rejectedEntries[0] ?? "",
        )}.`,
      ],
    ]);
  });

  itWithHome(
    "does not preflight runtime secrets before rejecting blocked root writes",
    async (home) => {
      const configPath = configPathForHome(home);
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      const original = {
        meta: { lastTouchedVersion: "2026.4.30" },
        gateway: { mode: "local", port: 18789 },
      } satisfies ConfigFileSnapshot["config"];
      const originalRaw = formatConfig(original);
      await fs.writeFile(configPath, originalRaw, "utf-8");
      const io = createHomeConfigIO(home, {
        configPath,
        env: { VITEST: "true" } as NodeJS.ProcessEnv,
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
      let preflightCalls = 0;

      await expectConfigWriteRejected(
        io.writeConfigFile(
          { update: { channel: "beta" } },
          {
            baseSnapshot,
            preCommitRuntimePreflight: async () => {
              preflightCalls += 1;
              throw new Error("should not preflight rejected writes");
            },
          },
        ),
      );

      expect(preflightCalls).toBe(0);
      await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(originalRaw);
    },
  );

  itWithHome(
    "ignores verbose BOM formatting but still rejects a destructive size drop",
    async (home) => {
      const configPath = configPathForHome(home);
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      const original = {
        meta: { lastTouchedVersion: "2026.4.23" },
        gateway: { mode: "local" },
        channels: {
          telegram: {
            enabled: true,
            allowFrom: Array.from({ length: 80 }, (_, index) => `telegram:${index}`),
          },
        },
      } satisfies ConfigFileSnapshot["config"];
      const powerShellRaw = `\uFEFF${JSON.stringify(original, null, 12)}\n`;
      await fs.writeFile(configPath, powerShellRaw, "utf-8");
      const io = createHomeConfigIO(home, {
        env: { VITEST: "true" } as NodeJS.ProcessEnv,
      });

      const snapshot = await io.readConfigFileSnapshot();
      expect(snapshot.valid).toBe(true);
      await expectConfigWriteRejected(
        io.writeConfigFile(
          { meta: original.meta, gateway: { mode: "local" } },
          { baseSnapshot: snapshot },
        ),
      );
      await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(powerShellRaw);

      await io.writeConfigFile(
        {
          ...original,
          gateway: { mode: "local", port: 18789 },
        },
        { baseSnapshot: snapshot },
      );
      const canonicalRaw = await fs.readFile(configPath, "utf-8");
      expect(Buffer.byteLength(powerShellRaw, "utf-8")).toBeGreaterThan(
        Buffer.byteLength(canonicalRaw, "utf-8") * 2,
      );
    },
  );

  itWithHome(
    "canonicalizes parseable schema-invalid config for the size baseline",
    async (home) => {
      const configPath = configPathForHome(home);
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      const channels = {
        telegram: {
          enabled: true,
          allowFrom: Array.from({ length: 60 }, (_, index) => `telegram:${index}`),
        },
      };
      const invalid = {
        gateway: { mode: "local" },
        channels,
        agents: { entries: "not-an-array" },
      };
      const invalidRaw = `\uFEFF${JSON.stringify(invalid, null, 12)}\n`;
      await fs.writeFile(configPath, invalidRaw, "utf-8");
      const io = createHomeConfigIO(home, {
        env: { VITEST: "true" } as NodeJS.ProcessEnv,
      });
      const snapshot = {
        path: configPath,
        exists: true,
        raw: invalidRaw,
        parsed: invalid,
        sourceConfig: {},
        resolved: {},
        valid: false,
        runtimeConfig: {},
        config: {},
        issues: [],
        warnings: [],
        legacyIssues: [],
      } satisfies ConfigFileSnapshot;
      await expect(
        io.writeConfigFile(
          { gateway: { mode: "local", port: 18789 }, channels },
          { baseSnapshot: snapshot, skipPluginValidation: true },
        ),
      ).resolves.toBeDefined();
    },
  );

  itWithHome("keeps the raw-byte size baseline for malformed config", async (home) => {
    const configPath = configPathForHome(home);
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    const malformedRaw = `not-json\n${"x".repeat(2048)}\n`;
    await fs.writeFile(configPath, malformedRaw, "utf-8");
    const io = createHomeConfigIO(home, {
      env: { VITEST: "true" } as NodeJS.ProcessEnv,
    });

    await expectConfigWriteRejected(io.writeConfigFile({ gateway: { mode: "local" } }));
    await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(malformedRaw);
  });

  itWithHome(
    "allows intentional size-drop writes without disabling gateway-mode protection",
    async (home) => {
      const configPath = configPathForHome(home);
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      const original = {
        meta: { lastTouchedVersion: "2026.4.30" },
        gateway: { mode: "local" },
        channels: {
          telegram: {
            enabled: true,
            allowFrom: Array.from({ length: 80 }, (_, index) => `telegram:${index}`),
          },
        },
      } satisfies ConfigFileSnapshot["config"];
      const originalRaw = formatConfig(original);
      await fs.writeFile(configPath, originalRaw, "utf-8");
      const io = createHomeConfigIO(home, {
        env: { VITEST: "true" } as NodeJS.ProcessEnv,
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

      const acceptedWrite = await io.writeConfigFile(
        { meta: original.meta, gateway: { mode: "local" } },
        {
          allowConfigSizeDrop: true,
          baseSnapshot,
        },
      );
      expect(acceptedWrite.persistedConfig.gateway).toEqual({ mode: "local" });
      const acceptedSnapshot = await io.readConfigFileSnapshot();

      await expectConfigWriteRejected(
        io.writeConfigFile(
          { meta: original.meta },
          {
            allowConfigSizeDrop: true,
            baseSnapshot: acceptedSnapshot,
          },
        ),
      );
    },
  );

  itWithHome(
    "keeps authored agent provider params during narrowed internal agent writes",
    async (home) => {
      const configPath = configPathForHome(home);
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      const original = {
        gateway: { mode: "local" },
        agents: {
          defaults: {
            params: { transport: "sse", openaiWsWarmup: false },
            models: {
              "openai/gpt-5.4": {
                alias: "GPT",
                params: { transport: "sse", openaiWsWarmup: false },
              },
            },
          },
          entries: { main: {} },
        },
      } satisfies ConfigFileSnapshot["sourceConfig"];
      const originalRaw = formatConfig(original);
      await fs.writeFile(configPath, originalRaw, "utf-8");
      const io = createHomeConfigIO(home, {
        env: { VITEST: "true" } as NodeJS.ProcessEnv,
      });
      const baseSnapshot = {
        path: configPath,
        exists: true,
        raw: originalRaw,
        parsed: original,
        sourceConfig: original,
        resolved: original,
        valid: true,
        runtimeConfig: {
          ...original,
          agents: {
            ...original.agents,
            defaults: {
              ...original.agents.defaults,
              maxConcurrent: 4,
            },
          },
        },
        config: {
          ...original,
          agents: {
            ...original.agents,
            defaults: {
              ...original.agents.defaults,
              maxConcurrent: 4,
            },
          },
        },
        issues: [],
        warnings: [],
        legacyIssues: [],
      } satisfies ConfigFileSnapshot;

      await io.writeConfigFile(
        {
          gateway: { mode: "local" },
          agents: { entries: { main: {}, ops: {} } },
        },
        { baseSnapshot },
      );

      const persisted = await readPersistedConfig(configPath);
      expect(persisted.agents?.defaults?.params).toEqual({
        transport: "sse",
        openaiWsWarmup: false,
      });
      expect(persisted.agents?.defaults?.models?.["openai/gpt-5.4"]).toEqual({
        alias: "GPT",
        params: { transport: "sse", openaiWsWarmup: false },
      });
      expect(persisted.agents?.entries).toEqual({ main: {}, ops: {} });
    },
  );

  itWithHome("preserves parsed source config when snapshot validation fails", async (home) => {
    const configPath = configPathForHome(home);
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    const original = {
      gateway: { mode: "local" },
      channels: { "test-plugin-channel": { enabled: true } },
    };
    const originalRaw = formatConfig(original);
    await fs.writeFile(configPath, originalRaw, "utf-8");
    const io = createFastConfigIO(home);

    const snapshot = await io.readConfigFileSnapshot();

    expect(snapshot.valid).toBe(false);
    expect(snapshot.raw).toBe(originalRaw);
    expect(snapshot.parsed).toEqual(original);
    expect(snapshot.sourceConfig).toEqual({
      ...original,
      agents: { entries: { main: { default: true } } },
    });
    expect(snapshot.config).toEqual({
      ...original,
      agents: { entries: { main: { default: true } } },
    });
    expect(snapshot.issues[0]?.message).toContain("unknown channel id: test-plugin-channel");
  });

  itWithHome(
    "returns the read-time environment snapshot for invalid config repairs",
    async (home) => {
      await writeConfigFixture(home, {
        gateway: {
          mode: "local",
          auth: { mode: "token", token: "${OPENCLAW_GATEWAY_TOKEN}" },
        },
        channels: { "test-plugin-channel": { enabled: true } },
      });
      const io = createHomeConfigIO(home, {
        env: {
          OPENCLAW_GATEWAY_TOKEN: "gateway-token-at-read",
          OPENCLAW_TEST_FAST: "1",
        } as NodeJS.ProcessEnv,
      });

      const result = await io.readConfigFileSnapshotForWrite();

      expect(result.snapshot.valid).toBe(false);
      expect(result.writeOptions.envSnapshotForRestore?.OPENCLAW_GATEWAY_TOKEN).toBe(
        "gateway-token-at-read",
      );
    },
  );

  itWithHome(
    "returns the read-time environment snapshot when invalid reads fall back after resolution",
    async (home) => {
      await writeConfigFixture(home, {
        gateway: {
          mode: "local",
          auth: { mode: "token", token: "${OPENCLAW_GATEWAY_TOKEN}" },
        },
        channels: { "test-plugin-channel": { enabled: true } },
      });
      mockLoadPluginManifestRegistry.mockImplementationOnce(() => {
        throw new Error("plugin metadata failed");
      });
      const io = createHomeConfigIO(home, {
        env: {
          OPENCLAW_GATEWAY_TOKEN: "gateway-token-at-read",
          OPENCLAW_TEST_FAST: "1",
        } as NodeJS.ProcessEnv,
      });

      const result = await io.readConfigFileSnapshotForWrite();

      expect(result.snapshot.valid).toBe(false);
      expect(result.writeOptions.envSnapshotForRestore?.OPENCLAW_GATEWAY_TOKEN).toBe(
        "gateway-token-at-read",
      );
    },
  );

  itWithHome("returns the snapshot-time hash when an included file is malformed", async (home) => {
    const configPath = configPathForHome(home);
    const includePath = path.join(home, ".openclaw", "plugins.json5");
    const malformedRaw = "{ malformed";
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await writeConfigJson(configPath, { plugins: { $include: "./plugins.json5" } });
    await fs.writeFile(includePath, malformedRaw, "utf-8");
    const io = createFastConfigIO(home);

    const result = await io.readConfigFileSnapshotForWrite();
    await fs.writeFile(includePath, "{ differently malformed", "utf-8");

    expect(result.snapshot.valid).toBe(false);
    expect(result.writeOptions.includeFileHashesForWrite?.[includePath]).toBe(
      hashConfigIncludeRaw(malformedRaw),
    );
    expect(result.writeOptions.includeFileTargetsForWrite?.[includePath]).toBe(
      await fs.realpath(includePath),
    );
  });

  itWithHome("returns a write guard that rejects a changed active config path", async (home) => {
    const firstConfigPath = path.join(home, ".openclaw", "first.json");
    const secondConfigPath = path.join(home, ".openclaw", "second.json");
    await fs.mkdir(path.dirname(firstConfigPath), { recursive: true });
    await fs.writeFile(firstConfigPath, "{}", "utf-8");
    await fs.writeFile(secondConfigPath, "{}", "utf-8");
    const env = {
      OPENCLAW_CONFIG_PATH: firstConfigPath,
      OPENCLAW_TEST_FAST: "1",
    } as NodeJS.ProcessEnv;
    const io = createHomeConfigIO(home, { env });

    const result = await io.readConfigFileSnapshotForWrite();
    env.OPENCLAW_CONFIG_PATH = secondConfigPath;

    expect(() => result.writeOptions.assertConfigPathForWrite?.()).toThrow(
      "config path changed since last load",
    );
  });

  itWithHome(
    "rejects write snapshots when the IO instance no longer owns its config path",
    async (home) => {
      const firstConfigPath = path.join(home, ".openclaw", "first.json");
      const secondConfigPath = path.join(home, ".openclaw", "second.json");
      await fs.mkdir(path.dirname(firstConfigPath), { recursive: true });
      await fs.writeFile(firstConfigPath, "{}", "utf-8");
      await fs.writeFile(secondConfigPath, "{}", "utf-8");
      const env = {
        OPENCLAW_CONFIG_PATH: firstConfigPath,
        OPENCLAW_TEST_FAST: "1",
      } as NodeJS.ProcessEnv;
      const io = createHomeConfigIO(home, { env });
      env.OPENCLAW_CONFIG_PATH = secondConfigPath;

      await expect(io.readConfigFileSnapshotForWrite()).rejects.toThrow(
        "config path changed since last load",
      );
    },
  );

  itWithHome("does not use expectedConfigPath as the write destination", async (home) => {
    const expectedConfigPath = path.join(home, ".openclaw", "expected.json");
    const activeConfigPath = path.join(home, ".openclaw", "active.json");
    await fs.mkdir(path.dirname(expectedConfigPath), { recursive: true });
    await writeConfigJson(expectedConfigPath, { gateway: { mode: "local" } });
    await fs.writeFile(activeConfigPath, "{}\n", "utf-8");

    await withEnvAsync(
      {
        OPENCLAW_CONFIG_PATH: activeConfigPath,
        OPENCLAW_TEST_FAST: "1",
      },
      async () => {
        await writeConfigFile(
          { gateway: { mode: "remote" } },
          {
            expectedConfigPath,
          },
        );
      },
    );

    const expectedConfig = await readPersistedConfig(expectedConfigPath);
    const activeConfig = await readPersistedConfig(activeConfigPath);
    expect(expectedConfig.gateway?.mode).toBe("local");
    expect(activeConfig.gateway?.mode).toBe("remote");
  });

  itWithHome("returns the missing-file hash when an included file is absent", async (home) => {
    const configPath = configPathForHome(home);
    const includePath = path.join(home, ".openclaw", "plugins.json5");
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await writeConfigJson(configPath, { plugins: { $include: "./plugins.json5" } });
    const io = createFastConfigIO(home);

    const result = await io.readConfigFileSnapshotForWrite();

    expect(result.snapshot.valid).toBe(false);
    expect(result.writeOptions.includeFileHashesForWrite?.[includePath]).toBe(
      hashConfigIncludeRaw(null),
    );
    expect(result.writeOptions.includeFileTargetsForWrite?.[includePath]).toBe(
      path.join(await fs.realpath(path.dirname(includePath)), path.basename(includePath)),
    );
  });

  itWithHome(
    "rejects root-include partial writes instead of flattening the root config",
    async (home) => {
      const configPath = configPathForHome(home);
      const includePath = path.join(home, ".openclaw", "extra.json5");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await writeConfigJson(includePath, {
        $schema: "https://openclaw.ai/config-from-include.json",
      });
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
    },
  );

  itWithHome("rejects a stale base snapshot before overwriting the root config", async (home) => {
    const { configPath } = await writeConfigFixture(home, {
      gateway: { mode: "local", port: 18789 },
    });
    const io = createFastConfigIO(home);
    const snapshot = await io.readConfigFileSnapshot();
    const concurrentRaw = formatConfig({ gateway: { mode: "local", port: 19001 } });
    await fs.writeFile(configPath, concurrentRaw, "utf-8");

    await expect(
      io.writeConfigFile({ gateway: { mode: "local", port: 19002 } }, { baseSnapshot: snapshot }),
    ).rejects.toThrow("config changed since last load");

    await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(concurrentRaw);
  });

  itWithHome(
    "rejects a base snapshot from a different config path before overwriting the root config",
    async (home) => {
      const firstConfigPath = path.join(home, ".openclaw", "first.json");
      const secondConfigPath = path.join(home, ".openclaw", "second.json");
      await fs.mkdir(path.dirname(firstConfigPath), { recursive: true });
      const originalRaw = formatConfig({ gateway: { mode: "local", port: 18789 } });
      await fs.writeFile(firstConfigPath, originalRaw, "utf-8");
      await fs.writeFile(secondConfigPath, originalRaw, "utf-8");
      const firstIo = createHomeConfigIO(home, {
        configPath: firstConfigPath,
        env: { OPENCLAW_TEST_FAST: "1" } as NodeJS.ProcessEnv,
      });
      const secondIo = createHomeConfigIO(home, {
        configPath: secondConfigPath,
        env: { OPENCLAW_TEST_FAST: "1" } as NodeJS.ProcessEnv,
      });
      const firstSnapshot = await firstIo.readConfigFileSnapshot();

      await expect(
        secondIo.writeConfigFile(
          { gateway: { mode: "local", port: 19002 } },
          { baseSnapshot: firstSnapshot },
        ),
      ).rejects.toThrow("config path changed since last load");

      await expect(fs.readFile(secondConfigPath, "utf-8")).resolves.toBe(originalRaw);
    },
  );

  itWithHome(
    "rolls back a root write when config path ownership changes during commit",
    async (home) => {
      const configPath = configPathForHome(home);
      const secondConfigPath = path.join(home, ".openclaw", "second.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      const originalRaw = formatConfig({ gateway: { mode: "local", port: 18789 } });
      await fs.writeFile(configPath, originalRaw, "utf-8");
      const io = createFastConfigIO(home, { configPath });
      const snapshot = await io.readConfigFileSnapshot();
      let activeConfigPath = configPath;
      const assertConfigPathForWrite = () => {
        if (fsNode.readFileSync(configPath, "utf-8") !== originalRaw) {
          activeConfigPath = secondConfigPath;
        }
        if (activeConfigPath !== configPath) {
          throw new ConfigMutationConflictError("config path changed since last load", {
            currentHash: null,
            retryable: false,
          });
        }
      };

      await expect(
        io.writeConfigFile(
          { gateway: { mode: "local", port: 19002 } },
          { baseSnapshot: snapshot, assertConfigPathForWrite },
        ),
      ).rejects.toThrow("config path changed since last load");

      await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(originalRaw);
    },
  );

  itWithHome(
    "rejects a base snapshot changed during preflight before replacing the root config",
    async (home) => {
      const { configPath } = await writeConfigFixture(home, {
        gateway: { mode: "local", port: 18789 },
      });
      const io = createFastConfigIO(home);
      const snapshot = await io.readConfigFileSnapshot();
      const concurrentRaw = formatConfig({ gateway: { mode: "local", port: 19001 } });

      await expect(
        io.writeConfigFile(
          { gateway: { mode: "local", port: 19002 } },
          {
            baseSnapshot: snapshot,
            preCommitRuntimePreflight: async () => {
              await fs.writeFile(configPath, concurrentRaw, "utf-8");
            },
          },
        ),
      ).rejects.toThrow("config changed since last load");

      expect(mockMaintainConfigBackups).not.toHaveBeenCalled();
      await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(concurrentRaw);
    },
  );

  itWithHome("rejects a base snapshot changed during backup rotation", async (home) => {
    const { configPath } = await writeConfigFixture(home, {
      gateway: { mode: "local", port: 18789 },
    });
    const io = createFastConfigIO(home);
    const snapshot = await io.readConfigFileSnapshot();
    const concurrentRaw = formatConfig({ gateway: { mode: "local", port: 19001 } });
    mockMaintainConfigBackups.mockImplementationOnce(async () => {
      await fs.writeFile(configPath, concurrentRaw, "utf-8");
    });

    await expect(
      io.writeConfigFile({ gateway: { mode: "local", port: 19002 } }, { baseSnapshot: snapshot }),
    ).rejects.toThrow("config changed since last load");

    await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(concurrentRaw);
  });

  itWithHome("rejects a missing base config created empty during preflight", async (home) => {
    const configPath = configPathForHome(home);
    const io = createFastConfigIO(home, { configPath });
    const snapshot = await io.readConfigFileSnapshot();
    expect(snapshot.exists).toBe(false);

    await expect(
      io.writeConfigFile(
        { gateway: { mode: "local", port: 19002 } },
        {
          baseSnapshot: snapshot,
          preCommitRuntimePreflight: async () => {
            await fs.writeFile(configPath, "", "utf-8");
          },
        },
      ),
    ).rejects.toThrow("config changed since last load");

    await expect(fs.readFile(configPath, "utf-8")).resolves.toBe("");
  });

  itWithHome("does not persist the injected roster for a non-roster first write", async (home) => {
    const configPath = configPathForHome(home);
    const io = createFastConfigIO(home, { configPath });
    const snapshot = await io.readConfigFileSnapshot();
    expect(snapshot.exists).toBe(false);
    expect(snapshot.config.agents?.entries).toEqual({ main: { default: true } });
    let preflightConfig: OpenClawConfig | undefined;

    await io.writeConfigFile(
      {
        ...snapshot.config,
        agents: {
          ...snapshot.config.agents,
          defaults: { model: "claude-cli/claude-opus-4-8" },
        },
      },
      {
        baseSnapshot: snapshot,
        preCommitRuntimePreflight: async (config) => {
          preflightConfig = config;
        },
      },
    );

    expect(preflightConfig?.agents?.entries).toEqual({ main: { default: true } });
    const persisted = await readPersistedConfig(configPath);
    expect(persisted.agents?.defaults?.model).toBe("claude-cli/claude-opus-4-8");
    expect(persisted.agents?.entries).toBeUndefined();
    expect(persisted.agents?.list).toBeUndefined();
  });

  itWithHome("persists an explicitly authored bootstrap roster on first write", async (home) => {
    const configPath = configPathForHome(home);
    const io = createFastConfigIO(home, { configPath });
    const snapshot = await io.readConfigFileSnapshot();

    await io.writeConfigFile(snapshot.config, {
      baseSnapshot: snapshot,
      explicitSetPaths: [["agents", "entries"]],
    });

    const persisted = await readPersistedConfig(configPath);
    expect(persisted.agents?.entries).toEqual({ main: { default: true } });
    expect(persisted.agents?.list).toBeUndefined();
  });

  itWithHome("forwards explicitly authorized agent roster removals", async (home) => {
    const { configPath } = await writeConfigFixture(home, {
      agents: {
        entries: {
          main: { default: true, workspace: "/srv/shared" },
          ops: { workspace: "/srv/shared" },
        },
      },
    });

    await withEnvAsync(
      {
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_TEST_FAST: "1",
      },
      async () => {
        await writeConfigFile(
          {
            agents: {
              entries: { main: { default: true, workspace: "/srv/shared" } },
            },
          },
          {
            allowedAgentRosterRemovals: ["ops"],
            skipRuntimeSnapshotRefresh: true,
          },
        );
      },
    );

    const persisted = await readPersistedConfig(configPath);
    expect(persisted.agents?.entries).toEqual({
      main: { default: true, workspace: "/srv/shared" },
    });
  });

  itWithHome("assigns distinct snapshot hashes to missing and empty root config", async (home) => {
    const configPath = configPathForHome(home);
    const io = createFastConfigIO(home, { configPath });
    const missingSnapshot = await io.readConfigFileSnapshot();
    expect(missingSnapshot.exists).toBe(false);

    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, "", "utf-8");
    const emptySnapshot = await io.readConfigFileSnapshot();
    expect(emptySnapshot.exists).toBe(true);
    expect(emptySnapshot.hash).not.toBe(missingSnapshot.hash);
  });

  itWithHome("rejects an empty base config removed during preflight", async (home) => {
    const configPath = configPathForHome(home);
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, "", "utf-8");
    const io = createFastConfigIO(home, { configPath });
    const snapshot = await io.readConfigFileSnapshot();
    expect(snapshot.exists).toBe(true);

    await expect(
      io.writeConfigFile(
        { gateway: { mode: "local", port: 19002 } },
        {
          baseSnapshot: snapshot,
          preCommitRuntimePreflight: async () => {
            await fs.unlink(configPath);
          },
        },
      ),
    ).rejects.toThrow("config changed since last load");

    await expect(fs.stat(configPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  itWithHome(
    "rejects invalid include-backed repairs instead of persisting substituted secrets",
    async (home) => {
      const configPath = configPathForHome(home);
      const includePath = path.join(home, ".openclaw", "gateway.json5");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await writeConfigJson(includePath, {
        mode: "local",
        auth: { mode: "token", token: "${OPENCLAW_GATEWAY_TOKEN}" },
        invalid: true,
      });
      await writeConfigJson(configPath, { gateway: { $include: "./gateway.json5" } });
      const originalRootRaw = await fs.readFile(configPath, "utf-8");
      const io = createHomeConfigIO(home, {
        env: {
          OPENCLAW_GATEWAY_TOKEN: "gateway-token-runtime",
          OPENCLAW_TEST_FAST: "1",
        } as NodeJS.ProcessEnv,
      });
      const snapshot = await io.readConfigFileSnapshot();
      expect(snapshot.valid).toBe(false);

      await expect(
        io.writeConfigFile({
          gateway: {
            mode: "local",
            auth: { mode: "token", token: "gateway-token-runtime" },
          },
        }),
      ).rejects.toThrow("Config write would flatten $include-owned config at gateway");

      await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(originalRootRaw);
      await expect(fs.readFile(includePath, "utf-8")).resolves.toContain(
        '"token": "${OPENCLAW_GATEWAY_TOKEN}"',
      );
    },
  );

  itWithHome(
    "repairs invalid root-authored siblings without flattening included config",
    async (home) => {
      const configPath = configPathForHome(home);
      const includePath = path.join(home, ".openclaw", "agent-defaults.json5");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await writeConfigJson(includePath, { maxConcurrent: 1 });
      await writeConfigJson(configPath, {
        agents: {
          defaults: { $include: "./agent-defaults.json5", legacyKey: true },
        },
      });
      const originalIncludeRaw = await fs.readFile(includePath, "utf-8");
      const io = createFastConfigIO(home);
      const snapshot = await io.readConfigFileSnapshot();
      expect(snapshot.valid).toBe(false);

      await io.writeConfigFile({ agents: { defaults: { maxConcurrent: 1 } } });

      const persisted = JSON.parse(await fs.readFile(configPath, "utf-8")) as {
        agents?: { defaults?: Record<string, unknown> };
      };
      expect(persisted.agents?.defaults).toEqual({ $include: "./agent-defaults.json5" });
      await expect(fs.readFile(includePath, "utf-8")).resolves.toBe(originalIncludeRaw);
    },
  );

  itWithHome(
    "does not let an unrelated include mask removal of a local gateway mode",
    async (home) => {
      const configPath = configPathForHome(home);
      const includePath = path.join(home, ".openclaw", "agents.json5");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(
        includePath,
        `${JSON.stringify({
          defaults: { workspace: "/srv/old" },
          entries: { ops: { default: true } },
        })}\n`,
        "utf-8",
      );
      await fs.writeFile(
        configPath,
        `${JSON.stringify({
          agents: { $include: "./agents.json5" },
          gateway: { mode: "${GATEWAY_MODE}" },
        })}\n`,
        "utf-8",
      );
      const io = createHomeConfigIO(home, {
        env: { GATEWAY_MODE: "local", OPENCLAW_TEST_FAST: "1" } as NodeJS.ProcessEnv,
      });
      const snapshot = await io.readConfigFileSnapshot();

      await expectConfigWriteRejected(
        io.writeConfigFile(
          { agents: snapshot.config.agents },
          {
            explicitSetPaths: [["agents", "defaults", "workspace"]],
            explicitSetValueSource: {
              agents: { defaults: { workspace: "/srv/next" } },
            },
            allowIncludeAncestorExplicitSetPaths: true,
          },
        ),
      );

      const persisted = JSON.parse(await fs.readFile(configPath, "utf-8")) as {
        agents?: { $include?: string };
        gateway?: { mode?: string };
      };
      expect(persisted.agents?.$include).toBe("./agents.json5");
      expect(persisted.gateway?.mode).toBe("${GATEWAY_MODE}");
    },
  );

  itWithHome(
    "preserves a leaf-included gateway mode during an unrelated include override",
    async (home) => {
      const configPath = configPathForHome(home);
      const agentsPath = path.join(home, ".openclaw", "agents.json5");
      const modePath = path.join(home, ".openclaw", "gateway-mode.json5");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(
        agentsPath,
        `${JSON.stringify({
          defaults: { workspace: "/srv/old" },
          entries: { ops: { default: true } },
        })}\n`,
        "utf-8",
      );
      await fs.writeFile(modePath, `${JSON.stringify("local")}\n`, "utf-8");
      await fs.writeFile(
        configPath,
        `${JSON.stringify({
          agents: { $include: "./agents.json5" },
          gateway: { mode: { $include: "./gateway-mode.json5" } },
        })}\n`,
        "utf-8",
      );
      const io = createFastConfigIO(home);
      const snapshot = await io.readConfigFileSnapshot();

      await io.writeConfigFile(snapshot.config, {
        explicitSetPaths: [["agents", "defaults", "workspace"]],
        explicitSetValueSource: {
          agents: { defaults: { workspace: "/srv/next" } },
        },
        allowIncludeAncestorExplicitSetPaths: true,
      });

      const persisted = JSON.parse(await fs.readFile(configPath, "utf-8")) as {
        agents?: { $include?: string; defaults?: { workspace?: string } };
        gateway?: { mode?: { $include?: string } };
      };
      expect(persisted.agents).toMatchObject({
        $include: "./agents.json5",
        defaults: { workspace: "/srv/next" },
      });
      expect(persisted.gateway?.mode?.$include).toBe("./gateway-mode.json5");
    },
  );

  itWithHome(
    "does not let a surviving sibling include mask removal of the gateway include",
    async (home) => {
      const configPath = configPathForHome(home);
      const agentsPath = path.join(home, ".openclaw", "agents.json5");
      const gatewayPath = path.join(home, ".openclaw", "gateway.json5");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(
        agentsPath,
        `${JSON.stringify({
          defaults: { workspace: "/srv/old" },
          entries: { ops: { default: true } },
        })}\n`,
        "utf-8",
      );
      await fs.writeFile(gatewayPath, `${JSON.stringify({ mode: "local" })}\n`, "utf-8");
      const authored = {
        agents: { $include: "./agents.json5" },
        gateway: { $include: "./gateway.json5" },
      };
      await fs.writeFile(configPath, `${JSON.stringify(authored)}\n`, "utf-8");
      const io = createFastConfigIO(home);
      const snapshot = await io.readConfigFileSnapshot();

      await expect(
        io.writeConfigFile(
          { agents: snapshot.config.agents },
          {
            explicitSetPaths: [["agents", "defaults", "workspace"]],
            explicitSetValueSource: {
              agents: { defaults: { workspace: "/srv/next" } },
            },
            allowIncludeAncestorExplicitSetPaths: true,
          },
        ),
      ).rejects.toThrow("Config write would flatten $include-owned config at gateway");

      await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(`${JSON.stringify(authored)}\n`);
    },
  );

  itWithHome(
    "rejects repairs that would flatten a valid outer include with a broken nested include",
    async (home) => {
      const configPath = configPathForHome(home);
      const pluginsPath = path.join(home, ".openclaw", "plugins.json5");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await writeConfigJson(pluginsPath, { $include: "./missing-entries.json5" });
      await writeConfigJson(configPath, { plugins: { $include: "./plugins.json5" } });
      const originalRootRaw = await fs.readFile(configPath, "utf-8");
      const originalPluginsRaw = await fs.readFile(pluginsPath, "utf-8");
      const io = createFastConfigIO(home);
      const snapshot = await io.readConfigFileSnapshot();
      expect(snapshot.valid).toBe(false);

      await expect(io.writeConfigFile({ plugins: { entries: {} } })).rejects.toThrow(
        "Config write would flatten $include-owned config at plugins",
      );

      await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(originalRootRaw);
      await expect(fs.readFile(pluginsPath, "utf-8")).resolves.toBe(originalPluginsRaw);
    },
  );

  itWithHome("allows replacement repair of a malformed include directive", async (home) => {
    const { configPath } = await writeConfigFixture(home, { plugins: { $include: 42 } });
    const io = createFastConfigIO(home);
    const snapshot = await io.readConfigFileSnapshot();
    expect(snapshot.valid).toBe(false);

    await io.writeConfigFile({ plugins: {} });

    const persisted = JSON.parse(await fs.readFile(configPath, "utf-8")) as {
      plugins?: Record<string, unknown>;
    };
    expect(persisted.plugins).toEqual({});
  });

  it("preserves escaped root literals before validating unrelated includes", async () => {
    mockLoadPluginManifestRegistry.mockReturnValue({
      diagnostics: [],
      plugins: [
        {
          id: "literal-plugin",
          origin: "bundled",
          channels: [],
          providers: [],
          cliBackends: [],
          skills: [],
          hooks: [],
          rootDir: "/tmp/openclaw-test-literal-plugin",
          source: "/tmp/openclaw-test-literal-plugin/index.ts",
          manifestPath: "/tmp/openclaw-test-literal-plugin/openclaw.plugin.json",
          configSchema: {
            type: "object",
            properties: {
              token: { type: "string", const: "${ROOT_LITERAL_TOKEN}" },
            },
            required: ["token"],
            additionalProperties: false,
          },
        },
      ],
    } satisfies PluginManifestRegistry);

    await withSuiteHome(async (home) => {
      const configPath = configPathForHome(home);
      const agentsPath = path.join(home, ".openclaw", "agents.json5");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await writeConfigJson(agentsPath, { entries: { main: { default: true } } });
      await writeConfigJson(configPath, {
        agents: { $include: "./agents.json5" },
        plugins: {
          entries: {
            "literal-plugin": {
              enabled: true,
              config: { token: "$${ROOT_LITERAL_TOKEN}" },
            },
          },
        },
      });
      const io = createHomeConfigIO(home, {
        env: {
          OPENCLAW_TEST_FAST: "1",
          ROOT_LITERAL_TOKEN: "secret",
        } as NodeJS.ProcessEnv,
      });
      const snapshot = await io.readConfigFileSnapshot();
      expect(snapshot.valid).toBe(true);

      await io.writeConfigFile({
        ...snapshot.sourceConfig,
        gateway: { mode: "local" },
      });

      await expect(fs.readFile(configPath, "utf-8")).resolves.toContain(
        '"token": "$${ROOT_LITERAL_TOKEN}"',
      );
    });
  });

  itWithHome("repairs invalid config without flattening record-nested includes", async (home) => {
    const configPath = configPathForHome(home);
    const includePath = path.join(home, ".openclaw", "main-agent.json5");
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await writeConfigJson(includePath, { workspace: "${OPENCLAW_AGENT_WORKSPACE}" });
    await writeConfigJson(configPath, {
      agents: {
        defaults: { params: { stale: true } },
        entries: { main: { $include: "./main-agent.json5" } },
      },
      channels: { "test-plugin-channel": { enabled: true } },
    });
    const originalRootRaw = await fs.readFile(configPath, "utf-8");
    const io = createHomeConfigIO(home, {
      env: {
        OPENCLAW_AGENT_WORKSPACE: "/resolved/agent-workspace",
        OPENCLAW_TEST_FAST: "1",
      } as NodeJS.ProcessEnv,
    });
    const snapshot = await io.readConfigFileSnapshot();
    expect(snapshot.valid).toBe(false);

    await io.writeConfigFile({
      agents: {
        entries: {
          main: { default: true, workspace: "/resolved/agent-workspace" },
        },
      },
    });

    await expect(fs.readFile(configPath, "utf-8")).resolves.not.toBe(originalRootRaw);
    const persistedRoot = JSON.parse(await fs.readFile(configPath, "utf-8")) as {
      agents?: { defaults?: unknown; entries?: Record<string, unknown> };
    };
    expect(persistedRoot.agents?.defaults).toBeUndefined();
    expect(persistedRoot.agents?.entries).toEqual({
      main: { $include: "./main-agent.json5" },
    });
    await expect(fs.readFile(includePath, "utf-8")).resolves.toContain(
      '"workspace": "${OPENCLAW_AGENT_WORKSPACE}"',
    );
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
      const io = createHomeConfigIO(home, {
        env: { VITEST: "true" } as NodeJS.ProcessEnv,
      });

      expectPersistedHashResult(
        await io.writeConfigFile({
          agents: { entries: { main: { default: true } } },
          plugins: {
            entries: {
              "required-plugin": {
                enabled: false,
              },
            },
          },
        }),
      );
    });

    mockLoadPluginManifestRegistry.mockReturnValue({
      diagnostics: [],
      plugins: [],
    } satisfies PluginManifestRegistry);
  });

  itWithHome("writes runtime-derived edits back to source SecretRef markers", async (home) => {
    const { configPath } = await writeConfigFixture(home, {
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
    });

    await withEnvAsync({ OPENCLAW_CONFIG_PATH: configPath }, async () => {
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

      const persisted = JSON.parse(await fs.readFile(configPath, "utf-8")) as {
        meta?: Record<string, unknown>;
      };
      expect(persisted).toEqual({
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
          lastTouchedVersion: persisted.meta?.lastTouchedVersion,
          migrations: { modelPolicyAllowlist: true },
        },
      });
      expect(typeof persisted.meta?.lastTouchedVersion).toBe("string");
      expect(readConfigMachineState<string>("config.lastTouchedAt")).toEqual(expect.any(String));
    });
  });

  itWithHome(
    "notifies in-process reloaders with resolved source config when persisted env refs are restored",
    async (home) => {
      const { configPath } = await writeConfigFixture(home, {
        gateway: {
          mode: "local",
          auth: { mode: "token", token: "${OPENCLAW_GATEWAY_TOKEN}" },
        },
        agents: { defaults: { model: { primary: "openai/gpt-5.4" } } },
      });
      const observedSources: unknown[] = [];
      const unsubscribe = registerConfigWriteListener((event) => {
        observedSources.push(event.sourceConfig);
      });

      try {
        await withEnvAsync(
          {
            OPENCLAW_CONFIG_PATH: configPath,
            OPENCLAW_GATEWAY_TOKEN: "gateway-token-runtime",
          },
          async () => {
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
              agents: {
                defaults: { model: { primary: "openrouter/anthropic/claude-sonnet-4.6" } },
              },
            });

            const persisted = JSON.parse(await fs.readFile(configPath, "utf-8")) as {
              gateway?: { auth?: { token?: string } };
            };
            expect(persisted.gateway?.auth?.token).toBe("${OPENCLAW_GATEWAY_TOKEN}");
            expect(observedSources).toHaveLength(1);
            const observedSource = requireRecord(observedSources[0], "observed source config");
            expect(observedSource.gateway).toEqual({
              mode: "local",
              auth: { mode: "token", token: "gateway-token-runtime" },
            });
            expect(observedSource.agents).toEqual({
              defaults: {
                model: { primary: "openrouter/anthropic/claude-sonnet-4.6" },
              },
              entries: { main: { default: true } },
            });
          },
        );
      } finally {
        unsubscribe();
      }
    },
  );

  itWithHome(
    "preserves auth-store refresh scope through managed preflight and notification",
    async (home) => {
      const configPath = configPathForHome(home);
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      const initialConfig = {
        gateway: { mode: "local" as const },
        logging: { level: "info" as const },
      } satisfies OpenClawConfig;
      await writeConfigJson(configPath, initialConfig);
      const preflight = vi.fn(
        async (
          sourceConfig: OpenClawConfig,
          refreshOptions?: { includeAuthStoreRefs?: boolean },
        ) => ({
          runtimeConfig: sourceConfig,
          compareConfig: sourceConfig,
          refreshOptions,
        }),
      );
      const notifications: Array<{ includeAuthStoreRefs?: boolean } | undefined> = [];
      const unsubscribe = registerConfigWriteListener(
        (event) => notifications.push(event.runtimeRefresh),
        {
          ownsRuntimeActivationFor: configPath,
          preCommitRuntimePreflight: preflight,
        },
      );

      try {
        await withEnvAsync({ OPENCLAW_CONFIG_PATH: configPath }, async () => {
          setRuntimeConfigSnapshot(initialConfig, initialConfig);
          await writeConfigFile(
            { ...initialConfig, logging: { level: "debug" } },
            { runtimeRefresh: { includeAuthStoreRefs: false } },
          );
        });
      } finally {
        unsubscribe();
      }

      expect(preflight).toHaveBeenCalledWith(expect.any(Object), {
        includeAuthStoreRefs: false,
      });
      expect(notifications).toEqual([{ includeAuthStoreRefs: false }]);
    },
  );

  itWithHome("stages managed root-write config env until the owner accepts it", async (home) => {
    const configPath = configPathForHome(home);
    const envKey = "OPENCLAW_TEST_MANAGED_ROOT_ENV";
    const initialAuthoredConfig = {
      gateway: {
        mode: "local" as const,
        auth: { mode: "token" as const, token: "${OPENCLAW_TEST_MANAGED_ROOT_ENV}" },
      },
      env: { vars: { [envKey]: "old" } },
    } satisfies OpenClawConfig;
    const initialConfig = {
      ...initialAuthoredConfig,
      gateway: {
        ...initialAuthoredConfig.gateway,
        auth: { mode: "token" as const, token: "old" },
      },
    } satisfies OpenClawConfig;
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await writeConfigJson(configPath, initialAuthoredConfig);
    let preparedEnv: NodeJS.ProcessEnv | undefined;
    let notifiedSource: OpenClawConfig | undefined;
    const unsubscribe = registerConfigWriteListener(
      (event) => {
        notifiedSource = event.sourceConfig;
      },
      {
        ownsRuntimeActivationFor: configPath,
        preCommitRuntimePreflight: async (sourceConfig) => {
          const runtimeEnv = prepareConfigRuntimeEnv({
            previousConfig: initialConfig,
            nextConfig: sourceConfig,
          });
          preparedEnv = runtimeEnv.env;
          return { runtimeConfig: sourceConfig, compareConfig: sourceConfig, runtimeEnv };
        },
      },
    );

    try {
      await withEnvAsync({ OPENCLAW_CONFIG_PATH: configPath, [envKey]: "old" }, async () => {
        setRuntimeConfigSnapshot(initialConfig, initialConfig);
        initializePublishedConfigRuntimeEnv(initialConfig, {
          ownedEnv: { [envKey]: "old" },
        });
        await writeConfigFile({
          ...initialConfig,
          env: { vars: { [envKey]: "candidate" } },
        });

        expect(preparedEnv?.[envKey]).toBe("candidate");
        expect(notifiedSource?.gateway?.auth?.token).toBe("candidate");
        expect(process.env[envKey]).toBe("old");
      });
    } finally {
      unsubscribe();
    }
  });

  itWithHome(
    "resolves watcher candidates after removing the accepted config env layer",
    async (home) => {
      const configPath = configPathForHome(home);
      const envKey = "OPENCLAW_TEST_WATCHER_ENV";
      const activeConfig = {
        env: { vars: { [envKey]: "old" } },
        gateway: { auth: { mode: "token" as const, token: "old" } },
      } satisfies OpenClawConfig;
      const candidate = {
        env: { vars: { [envKey]: "new" } },
        gateway: { auth: { mode: "token" as const, token: "${OPENCLAW_TEST_WATCHER_ENV}" } },
      } satisfies OpenClawConfig;
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await writeConfigJson(configPath, candidate);

      await withEnvAsync({ OPENCLAW_CONFIG_PATH: configPath, [envKey]: "old" }, async () => {
        initializePublishedConfigRuntimeEnv(activeConfig, {
          ownedEnv: { [envKey]: "old" },
        });
        const snapshot = await readConfigFileSnapshotForRuntimeTransaction(activeConfig);

        expect(snapshot.sourceConfig.gateway?.auth?.token).toBe("new");
        expect(process.env[envKey]).toBe("old");
      });
    },
  );

  itWithHome(
    "rereads a managed write against an env transaction accepted during preflight",
    async (home) => {
      const configPath = configPathForHome(home);
      const envKey = "OPENCLAW_TEST_INTERLEAVED_WRITE_ENV";
      const makeConfig = (value: string, token: string): OpenClawConfig => ({
        env: { vars: { [envKey]: value } },
        gateway: { mode: "local", auth: { mode: "token", token } },
      });
      const configA = makeConfig("a", "a");
      const authoredA = makeConfig("a", `\${${envKey}}`);
      const configB = makeConfig("b", "a");
      const configC = makeConfig("c", "c");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await writeConfigJson(configPath, authoredA);
      let notifiedSource: OpenClawConfig | undefined;
      const unsubscribe = registerConfigWriteListener(
        (event) => {
          notifiedSource = event.sourceConfig;
        },
        {
          ownsRuntimeActivationFor: configPath,
          preCommitRuntimePreflight: async (sourceConfig) => {
            const staleRuntimeEnv = prepareConfigRuntimeEnv({
              previousConfig: configA,
              nextConfig: sourceConfig,
            });
            await Promise.resolve();
            process.env[envKey] = "c";
            initializePublishedConfigRuntimeEnv(configC, {
              ownedEnv: { [envKey]: "c" },
            });
            return {
              runtimeConfig: sourceConfig,
              compareConfig: sourceConfig,
              runtimeEnv: staleRuntimeEnv,
            };
          },
        },
      );

      try {
        await withEnvAsync({ OPENCLAW_CONFIG_PATH: configPath, [envKey]: "a" }, async () => {
          setRuntimeConfigSnapshot(configA, configA);
          initializePublishedConfigRuntimeEnv(configA, {
            ownedEnv: { [envKey]: "a" },
          });
          await writeConfigFile(configB);

          expect(notifiedSource?.gateway?.auth?.token).toBe("b");
          expect(process.env[envKey]).toBe("c");
        });
      } finally {
        unsubscribe();
      }
    },
  );

  itWithHome(
    "rejects ambiguous removals from arrays containing environment references",
    async (home) => {
      const { configPath, raw: originalRaw } = await writeConfigFixture(home, {
        plugins: { allow: ["${PLUGIN_A}", "${PLUGIN_B}"] },
      });
      const io = createHomeConfigIO(home, {
        env: {
          OPENCLAW_TEST_FAST: "1",
          PLUGIN_A: "same-plugin",
          PLUGIN_B: "same-plugin",
        } as NodeJS.ProcessEnv,
      });

      await expect(io.writeConfigFile({ plugins: { allow: ["same-plugin"] } })).rejects.toThrow(
        "Config write would reorder or modify an array",
      );

      await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(originalRaw);
    },
  );

  itWithHome("preserves escaped literals when config writes reorder arrays", async (home) => {
    const { configPath } = await writeConfigFixture(home, {
      plugins: { allow: ["$${PLUGIN_ID}", "literal-plugin"] },
    });
    const io = createFastConfigIO(home);

    await io.writeConfigFile({ plugins: { allow: ["literal-plugin", "${PLUGIN_ID}"] } });

    const persisted = JSON.parse(await fs.readFile(configPath, "utf-8")) as {
      plugins?: { allow?: string[] };
    };
    expect(persisted.plugins?.allow).toEqual(["literal-plugin", "$${PLUGIN_ID}"]);
  });

  it("notifies in-process reloaders with canonical post-write source config", async () => {
    mockLoadPluginManifestRegistry.mockReturnValue({
      diagnostics: [],
      plugins: [
        {
          id: "demo",
          origin: "bundled",
          channels: [],
          providers: [],
          cliBackends: [],
          skills: [],
          hooks: [],
          rootDir: "/tmp/openclaw-test-demo",
          source: "/tmp/openclaw-test-demo/index.ts",
          manifestPath: "/tmp/openclaw-test-demo/openclaw.plugin.json",
          configSchema: {
            type: "object",
            properties: {
              mode: { type: "string", default: "auto" },
            },
            additionalProperties: true,
          },
        },
      ],
    } satisfies PluginManifestRegistry);

    await withSuiteHome(async (home) => {
      const configPath = configPathForHome(home);
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      const sourceConfig = {
        gateway: { mode: "local" },
        agents: { defaults: { model: { primary: "openai/gpt-5.4" } } },
        plugins: { entries: { demo: { enabled: true, config: {} } } },
      } satisfies ConfigFileSnapshot["sourceConfig"];
      await writeConfigJson(configPath, sourceConfig);
      const runtimeConfig = {
        ...structuredClone(sourceConfig),
        plugins: {
          entries: {
            demo: { enabled: true, config: { mode: "auto" } },
          },
        },
      } satisfies ConfigFileSnapshot["config"];
      const observedSources: unknown[] = [];
      const unsubscribe = registerConfigWriteListener((event) => {
        observedSources.push(event.sourceConfig);
      });

      try {
        await withEnvAsync({ OPENCLAW_CONFIG_PATH: configPath }, async () => {
          setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);

          await writeConfigFile({
            ...runtimeConfig,
            agents: {
              defaults: {
                model: { primary: "openrouter/anthropic/claude-sonnet-4.6" },
              },
            },
          });

          const postWriteSnapshot = await createHomeConfigIO(home, {
            env: { OPENCLAW_CONFIG_PATH: configPath, VITEST: "true" } as NodeJS.ProcessEnv,
          }).readConfigFileSnapshot();

          expect(postWriteSnapshot.valid).toBe(true);
          expect(observedSources).toEqual([postWriteSnapshot.sourceConfig]);
          expect(getRuntimeConfigSourceSnapshot()).toEqual(postWriteSnapshot.sourceConfig);
          expect(postWriteSnapshot.sourceConfig.meta).not.toHaveProperty("lastTouchedAt");
          expect(readConfigMachineState<string>("config.lastTouchedAt")).toEqual(
            expect.any(String),
          );
          expect(postWriteSnapshot.sourceConfig.plugins?.entries?.demo?.config).toStrictEqual({});
        });
      } finally {
        unsubscribe();
        mockLoadPluginManifestRegistry.mockReturnValue({
          diagnostics: [],
          plugins: [],
        } satisfies PluginManifestRegistry);
      }
    });
  });

  itWithHome("rolls back the root config when post-write runtime refresh fails", async (home) => {
    const configPath = configPathForHome(home);
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    const initialConfig = {
      gateway: { mode: "local", port: 18789 },
      plugins: { entries: { "google-antigravity-auth": { enabled: false } } },
    } satisfies OpenClawConfig;
    const initialRaw = formatConfig(initialConfig);
    await fs.writeFile(configPath, initialRaw, "utf-8");
    const warn = vi.fn();
    const io = createHomeConfigIO(home, {
      configPath,
      env: { HOME: home } as NodeJS.ProcessEnv,
      logger: { warn, error: vi.fn() },
    });
    io.loadConfig();
    expect(warn).toHaveBeenCalledTimes(1);

    try {
      await withEnvAsync({ OPENCLAW_CONFIG_PATH: configPath }, async () => {
        setRuntimeConfigSnapshotRefreshHandler({
          refresh: () => {
            throw new Error("synthetic refresh failure");
          },
        });

        await expect(
          writeConfigFile({
            gateway: { mode: "local", port: 19001 },
            plugins: { entries: { "google-gemini-cli-auth": { enabled: false } } },
          }),
        ).rejects.toThrow(/runtime snapshot refresh failed: synthetic refresh failure/);

        await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(initialRaw);
        io.loadConfig();
        expect(warn).toHaveBeenCalledTimes(1);
      });
    } finally {
      setRuntimeConfigSnapshotRefreshHandler(null);
    }
  });

  itWithHome(
    "does not delete an existing root config when rollback has no previous raw payload",
    async (home) => {
      const configPath = configPathForHome(home);
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      const initialConfig = { gateway: { mode: "local", port: 18789 } } satisfies OpenClawConfig;
      await writeConfigJson(configPath, initialConfig);
      const baseSnapshot = {
        path: configPath,
        exists: true,
        raw: null,
        parsed: initialConfig,
        sourceConfig: initialConfig,
        resolved: initialConfig,
        valid: true,
        runtimeConfig: initialConfig,
        config: initialConfig,
        issues: [],
        warnings: [],
        legacyIssues: [],
      } satisfies ConfigFileSnapshot;

      try {
        await withEnvAsync({ OPENCLAW_CONFIG_PATH: configPath }, async () => {
          setRuntimeConfigSnapshotRefreshHandler({
            refresh: () => {
              throw new Error("synthetic refresh failure");
            },
          });

          await expect(
            writeConfigFile(
              { gateway: { mode: "local", port: 19001 } },
              {
                baseSnapshot,
              },
            ),
          ).rejects.toThrow(/runtime snapshot refresh failed: synthetic refresh failure/);

          const persisted = await readPersistedConfig(configPath);
          expect(persisted.gateway).toEqual({ mode: "local", port: 19001 });
        });
      } finally {
        setRuntimeConfigSnapshotRefreshHandler(null);
      }
    },
  );

  itWithHome(
    "does not overwrite concurrent root config edits during failed refresh rollback",
    async (home) => {
      const { configPath } = await writeConfigFixture(home, {
        gateway: { mode: "local", port: 18789 },
      });
      const concurrentRaw = formatConfig({ gateway: { mode: "local", port: 19191 } });

      try {
        await withEnvAsync({ OPENCLAW_CONFIG_PATH: configPath }, async () => {
          setRuntimeConfigSnapshotRefreshHandler({
            refresh: async () => {
              await fs.writeFile(configPath, concurrentRaw, "utf-8");
              throw new Error("synthetic refresh failure");
            },
          });

          await expect(
            writeConfigFile({ gateway: { mode: "local", port: 19001 } }),
          ).rejects.toThrow(/runtime snapshot refresh failed: synthetic refresh failure/);

          await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(concurrentRaw);
        });
      } finally {
        setRuntimeConfigSnapshotRefreshHandler(null);
      }
    },
  );

  itWithHome("blocks runtime preflight failures before committing root writes", async (home) => {
    const configPath = configPathForHome(home);
    const initialRaw = formatConfig({ gateway: { mode: "local" } });
    let observedSource: OpenClawConfig | undefined;

    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, initialRaw, "utf-8");

    try {
      await withEnvAsync({ OPENCLAW_CONFIG_PATH: configPath }, async () => {
        setRuntimeConfigSnapshotRefreshHandler({
          preflight: async ({ sourceConfig }) => {
            observedSource = sourceConfig;
            throw new Error("missing included secret");
          },
          refresh: () => true,
        });

        await expect(
          writeConfigFile({
            gateway: { mode: "local", port: 19001 },
            logging: { level: "debug" },
          }),
        ).rejects.toThrow(/active SecretRef resolution failed: missing included secret/);

        expect(observedSource?.gateway?.port).toBe(19001);
        await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(initialRaw);
      });
    } finally {
      setRuntimeConfigSnapshotRefreshHandler(null);
    }
  });

  itWithHome(
    "runs a caller commit guard after runtime preflight and before the root write",
    async (home) => {
      const configPath = configPathForHome(home);
      const initialRaw = formatConfig({ gateway: { mode: "local" } });
      const events: string[] = [];

      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, initialRaw, "utf-8");

      try {
        await withEnvAsync({ OPENCLAW_CONFIG_PATH: configPath }, async () => {
          setRuntimeConfigSnapshotRefreshHandler({
            preflight: () => {
              events.push("runtime");
            },
            refresh: () => true,
          });

          await expect(
            writeConfigFile(
              { gateway: { mode: "local", port: 19001 } },
              {
                preCommitRuntimePreflight: async (sourceConfig) => {
                  events.push(`caller:${String(sourceConfig.gateway?.port)}`);
                  await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(initialRaw);
                  throw new Error("authority changed");
                },
              },
            ),
          ).rejects.toThrow("authority changed");

          expect(events).toEqual(["runtime", "caller:19001"]);
          await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(initialRaw);
        });
      } finally {
        setRuntimeConfigSnapshotRefreshHandler(null);
      }
    },
  );

  itWithHome(
    "blocks runtime preflight failures before direct config IO commits root writes",
    async (home) => {
      const configPath = configPathForHome(home);
      const initialRaw = formatConfig({ gateway: { mode: "local" } });
      const env = {
        ...process.env,
        OPENCLAW_CONFIG_PATH: configPath,
      } as NodeJS.ProcessEnv;
      let observedSource: OpenClawConfig | undefined;

      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, initialRaw, "utf-8");

      try {
        setRuntimeConfigSnapshotRefreshHandler({
          preflight: async ({ sourceConfig }) => {
            observedSource = sourceConfig;
            throw new Error("missing direct IO secret");
          },
          refresh: () => true,
        });

        await expect(
          createConfigIO({ env, logger: silentLogger }).writeConfigFile({
            gateway: { mode: "local", port: 19001 },
          }),
        ).rejects.toThrow(/active SecretRef resolution failed: missing direct IO secret/);

        expect(observedSource?.gateway?.port).toBe(19001);
        await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(initialRaw);
      } finally {
        setRuntimeConfigSnapshotRefreshHandler(null);
      }
    },
  );

  itWithHome(
    "restores config env vars when post-write runtime refresh rollback succeeds",
    async (home) => {
      const configPath = configPathForHome(home);
      const envKey = "OPENCLAW_TEST_RUNTIME_ROLLBACK_ENV";
      const initialConfig = { gateway: { mode: "local", port: 18789 } } satisfies OpenClawConfig;
      const initialRaw = formatConfig(initialConfig);

      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, initialRaw, "utf-8");

      try {
        await withEnvAsync(
          {
            OPENCLAW_CONFIG_PATH: configPath,
            [envKey]: undefined,
          },
          async () => {
            setRuntimeConfigSnapshotRefreshHandler({
              refresh: () => {
                expect(process.env[envKey]).toBe("written-env-value");
                throw new Error("synthetic refresh failure");
              },
            });

            await expect(
              writeConfigFile({
                gateway: { mode: "local", port: 19001 },
                env: { vars: { [envKey]: "written-env-value" } },
              }),
            ).rejects.toThrow(/runtime snapshot refresh failed: synthetic refresh failure/);

            await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(initialRaw);
            expect(process.env[envKey]).toBeUndefined();
          },
        );
      } finally {
        setRuntimeConfigSnapshotRefreshHandler(null);
      }
    },
  );

  itWithHome(
    "restores the prior snapshot slot when post-commit refresh rolls back",
    async (home) => {
      const configPath = configPathForHome(home);
      const initialConfig = { gateway: { mode: "local", port: 18789 } } satisfies OpenClawConfig;
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await writeConfigJson(configPath, initialConfig);

      try {
        await withEnvAsync(
          { OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_TEST_FAST: "1" },
          async () => {
            await writeConfigFile(initialConfig, { skipRuntimeSnapshotRefresh: true });
            const priorSlot = readConfigSnapshotAuditRecord({
              env: process.env,
              homedir: () => home,
              configPath,
            });
            setRuntimeConfigSnapshotRefreshHandler({
              refresh: () => {
                throw new Error("synthetic refresh failure");
              },
            });

            await expect(
              writeConfigFile({ gateway: { mode: "local", port: 19001 } }),
            ).rejects.toThrow(/runtime snapshot refresh failed: synthetic refresh failure/);

            expect(
              readConfigSnapshotAuditRecord({
                env: process.env,
                homedir: () => home,
                configPath,
              }),
            ).toEqual(priorSlot);
          },
        );
      } finally {
        setRuntimeConfigSnapshotRefreshHandler(null);
      }
    },
  );

  itWithHome(
    "rolls back a managed root write when canonical rereads exhaust env generations",
    async (home) => {
      const configPath = configPathForHome(home);
      const initialConfig = { gateway: { mode: "local", port: 18789 } } satisfies OpenClawConfig;
      const initialRaw = formatConfig(initialConfig);
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, initialRaw, "utf-8");

      const readFileSync = fsNode.readFileSync.bind(fsNode);
      let generationChanges = 0;
      const readSpy = vi.spyOn(fsNode, "readFileSync").mockImplementation((target, options) => {
        const result = readFileSync(target, options);
        if (String(target) === configPath && String(result).includes("19001")) {
          generationChanges += 1;
          initializePublishedConfigRuntimeEnv(initialConfig);
        }
        return result;
      });
      const unsubscribe = registerConfigWriteListener(() => {}, {
        ownsRuntimeActivationFor: configPath,
        preCommitRuntimePreflight: async (sourceConfig) => ({
          runtimeConfig: sourceConfig,
          compareConfig: sourceConfig,
        }),
      });

      try {
        await withEnvAsync({ OPENCLAW_CONFIG_PATH: configPath }, async () => {
          setRuntimeConfigSnapshot(initialConfig, initialConfig);
          initializePublishedConfigRuntimeEnv(initialConfig);

          await expect(
            writeConfigFile({ gateway: { mode: "local", port: 19001 } }),
          ).rejects.toThrow("active config environment changed during every canonical reread");
        });
      } finally {
        unsubscribe();
        readSpy.mockRestore();
      }

      expect(generationChanges).toBeGreaterThanOrEqual(3);
      await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(initialRaw);
    },
  );

  itWithHome(
    "uses injected filesystem operations when rolling back ownership loss",
    async (home) => {
      const configPath = configPathForHome(home);
      const otherConfigPath = path.join(home, ".openclaw", "other.json");
      const initialConfig = { gateway: { mode: "local", port: 18789 } } satisfies OpenClawConfig;
      const initialRaw = formatConfig(initialConfig);
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, initialRaw, "utf-8");
      const env = {
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_TEST_FAST: "1",
      } as NodeJS.ProcessEnv;
      const readFile = fsNode.promises.readFile.bind(fsNode.promises);
      const rename = fsNode.promises.rename.bind(fsNode.promises);
      let committed = false;
      let rollbackReadUsedInjectedFs = false;
      const injectedFs = {
        ...fsNode,
        promises: {
          ...fsNode.promises,
          readFile: async (target, options) => {
            if (committed && target === configPath) {
              rollbackReadUsedInjectedFs = true;
            }
            return await readFile(target, options);
          },
          rename: async (from, to) => {
            await rename(from, to);
            if (!committed && to === configPath) {
              committed = true;
              env.OPENCLAW_CONFIG_PATH = otherConfigPath;
            }
          },
        },
      } as typeof fsNode;
      const io = createConfigIO({ env, fs: injectedFs, homedir: () => home, logger: silentLogger });
      const prepared = await io.readConfigFileSnapshotForWrite();

      await expect(
        io.writeConfigFile(
          { gateway: { mode: "local", port: 19001 } },
          {
            baseSnapshot: prepared.snapshot,
            ...prepared.writeOptions,
          },
        ),
      ).rejects.toThrow("config path changed since last load");

      expect(rollbackReadUsedInjectedFs).toBe(true);
      await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(initialRaw);
    },
  );

  itWithHome(
    "keeps snapshot-injected materialization defaults out of the persisted config",
    async (home) => {
      const { configPath } = await writeConfigFixture(home, {
        gateway: { mode: "local", port: 18789 },
        agents: { defaults: { compaction: {} } },
      });
      const io = createFastConfigIO(home);
      const prepared = await io.readConfigFileSnapshotForWrite();

      // Snapshot materialization injects load-parity defaults into the runtime shape,
      // while mutation flows round-trip the raw sourceConfig; injected defaults must
      // never reach the user's file through a write.
      expect(prepared.snapshot.config.agents?.defaults?.compaction?.mode).toBe("safeguard");
      expect(prepared.snapshot.sourceConfig.agents?.defaults?.compaction?.mode).toBeUndefined();

      const next = structuredClone(prepared.snapshot.sourceConfig);
      next.gateway = { ...next.gateway, mode: "local", port: 19001 };
      await io.writeConfigFile(next, {
        baseSnapshot: prepared.snapshot,
        ...prepared.writeOptions,
      });

      const persisted = await readPersistedConfig(configPath);
      expect(persisted.gateway?.port).toBe(19001);
      expect(persisted.agents?.defaults?.compaction).toStrictEqual({});
    },
  );

  it("persists explicit default-valued paths through the exported write wrapper", async () => {
    mockLoadPluginManifestRegistry.mockReturnValue({
      diagnostics: [],
      plugins: [
        {
          id: "demo",
          origin: "bundled",
          channels: [],
          providers: [],
          cliBackends: [],
          skills: [],
          hooks: [],
          rootDir: "/tmp/openclaw-test-demo",
          source: "/tmp/openclaw-test-demo/index.ts",
          manifestPath: "/tmp/openclaw-test-demo/openclaw.plugin.json",
          configSchema: {
            type: "object",
            properties: {
              mode: { type: "string", default: "auto" },
            },
            additionalProperties: true,
          },
        },
      ],
    } satisfies PluginManifestRegistry);

    await withSuiteHome(async (home) => {
      const configPath = configPathForHome(home);
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      const sourceConfig = {
        gateway: { mode: "local" },
        plugins: { entries: { demo: { enabled: true, config: {} } } },
      } satisfies ConfigFileSnapshot["sourceConfig"];
      await writeConfigJson(configPath, sourceConfig);
      const runtimeConfig = {
        ...structuredClone(sourceConfig),
        plugins: {
          entries: {
            demo: { enabled: true, config: { mode: "auto" } },
          },
        },
      } satisfies ConfigFileSnapshot["config"];

      try {
        await withEnvAsync({ OPENCLAW_CONFIG_PATH: configPath }, async () => {
          setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);

          await writeConfigFile(runtimeConfig, {
            explicitSetPaths: [["plugins", "entries", "demo", "config"]],
          });

          const persisted = await readPersistedConfig(configPath);
          expect(persisted.plugins?.entries?.demo?.config).toStrictEqual({ mode: "auto" });
          const auditRecord = listConfigAuditRecordsForTests({
            env: process.env,
            homedir: () => home,
          })
            .filter((record) => record.event === "config.write")
            .findLast((record) => record.configPath === configPath);
          expect(auditRecord).toMatchObject({ changedPathCount: expect.any(Number) });
          if (!auditRecord || auditRecord.event !== "config.write") {
            throw new Error("expected config write audit record");
          }
          expect(auditRecord.changedPathCount).toBeGreaterThanOrEqual(1);
          expect(auditRecord.changedPaths).toContain("plugins.entries.demo.config");
        });
      } finally {
        mockLoadPluginManifestRegistry.mockReturnValue({
          diagnostics: [],
          plugins: [],
        } satisfies PluginManifestRegistry);
      }
    });
  });

  itWithHome(
    "skipPluginValidation bypasses plugin schema rejection on writeConfigFile (#76800)",
    async (home) => {
      const configPath = configPathForHome(home);
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, "{}\n", "utf-8");
      mockLoadPluginManifestRegistry.mockReturnValue({
        diagnostics: [],
        plugins: [
          {
            id: "strict-plugin",
            origin: "bundled",
            channels: [],
            providers: [],
            cliBackends: [],
            skills: [],
            hooks: [],
            rootDir: "/tmp/openclaw-test-strict-plugin",
            source: "/tmp/openclaw-test-strict-plugin/index.ts",
            manifestPath: "/tmp/openclaw-test-strict-plugin/openclaw.plugin.json",
            configSchema: {
              type: "object",
              properties: { token: { type: "string" } },
              required: ["token"],
              additionalProperties: false,
            },
          },
        ],
      } satisfies PluginManifestRegistry);

      try {
        // Plugin is enabled but missing required "token" — validation fails without skip.
        const cfg: OpenClawConfig = {
          agents: { entries: { main: { default: true } } },
          plugins: { entries: { "strict-plugin": { enabled: true } } },
        };

        await withEnvAsync({ OPENCLAW_CONFIG_PATH: configPath }, async () => {
          await writeConfigFile(cfg, { skipPluginValidation: true });
          await expect(fs.readFile(configPath, "utf-8")).resolves.toContain('"strict-plugin"');

          await expect(writeConfigFile(cfg, { skipPluginValidation: false })).rejects.toThrow(
            /Config validation failed/,
          );
          await expect(
            writeConfigFile({ agents: { entries: "not-array" } } as unknown as OpenClawConfig, {
              skipPluginValidation: true,
            }),
          ).rejects.toThrow(/Config validation failed/);
        });
      } finally {
        mockLoadPluginManifestRegistry.mockReturnValue({
          diagnostics: [],
          plugins: [],
        } satisfies PluginManifestRegistry);
      }
    },
  );

  itWithHome(
    "preserves authored tilde paths when runtime-shaped writes hand back absolute paths",
    async (home) => {
      const { configPath } = await writeConfigFixture(home, {
        logging: { file: "~/openclaw-upgrade-survivor/gateway.jsonl" },
      });
      const io = createFastConfigIO(home);
      const snapshot = await io.readConfigFileSnapshot();

      await io.writeConfigFile(
        {
          logging: {
            file: path.join(home, "openclaw-upgrade-survivor", "gateway.jsonl"),
            level: "debug",
          },
        },
        { baseSnapshot: snapshot },
      );

      const persisted = await readPersistedConfig(configPath);
      expect(persisted.logging?.file).toBe("~/openclaw-upgrade-survivor/gateway.jsonl");
      expect(persisted.logging?.level).toBe("debug");
    },
  );

  itWithHome("warns immediately before a root config write strips JSON5 comments", async (home) => {
    const configPath = configPathForHome(home);
    const raw = `{
// Keep this operator note.
gateway: { mode: "local", port: 18789 }
}
`;
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, raw, "utf-8");
    const commentWarnings: string[] = [];
    const warn = vi.fn((message: string) => {
      if (!message.startsWith("Config write will strip JSON5 comments")) {
        return;
      }
      expect(fsNode.readFileSync(configPath, "utf-8")).toBe(raw);
      commentWarnings.push(message);
    });
    const io = createHomeConfigIO(home, {
      env: { OPENCLAW_TEST_FAST: "1" } as NodeJS.ProcessEnv,
      logger: { warn, error: vi.fn() },
    });
    const nextConfig = { gateway: { mode: "local" as const, port: 18790 } };

    await expect(
      io.writeConfigFile(nextConfig, {
        preCommitRuntimePreflight: async () => {
          throw new Error("blocked before commit");
        },
      }),
    ).rejects.toThrow("blocked before commit");
    expect(commentWarnings).toEqual([]);

    await io.writeConfigFile(nextConfig);

    expect(commentWarnings).toEqual([`Config write will strip JSON5 comments from ${configPath}.`]);
    await expect(fs.readFile(configPath, "utf-8")).resolves.not.toContain("operator note");
  });

  itWithHome(
    "records capped changed paths, origin, and the latest redacted source snapshot",
    async (home) => {
      const configPath = configPathForHome(home);
      const originalVars = Object.fromEntries(
        Array.from({ length: 70 }, (_, index) => [
          `SETTING_${index.toString().padStart(2, "0")}`,
          "before",
        ]),
      );
      const nextVars = Object.fromEntries(Object.keys(originalVars).map((key) => [key, "after"]));
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(
        configPath,
        formatConfig({ env: { vars: originalVars }, gateway: { port: 18789 } }),
      );
      const io = createFastConfigIO(home);
      const snapshot = await io.readConfigFileSnapshot();
      const nextConfig = structuredClone(snapshot.config);
      nextConfig.env = { ...nextConfig.env, vars: nextVars };

      const result = await io.writeConfigFile(nextConfig, { auditOrigin: "doctor" });

      const record = listConfigAuditRecordsForTests({
        env: { OPENCLAW_TEST_FAST: "1" } as NodeJS.ProcessEnv,
        homedir: () => home,
      })
        .filter((candidate) => candidate.event === "config.write")
        .findLast((candidate) => candidate.configPath === configPath);
      expect(record).toMatchObject({
        event: "config.write",
        origin: "doctor",
        changedPathCount: 70,
      });
      if (!record || record.event !== "config.write") {
        throw new Error("expected config write audit record");
      }
      expect(record.changedPaths).toHaveLength(64);
      expect(record.changedPaths?.at(-1)).toBe("…+7 more");
      expect(record.changedPaths?.slice(0, 2)).toEqual([
        "env.vars.SETTING_00",
        "env.vars.SETTING_01",
      ]);

      const slot = readConfigSnapshotAuditRecord({
        env: { OPENCLAW_TEST_FAST: "1" } as NodeJS.ProcessEnv,
        homedir: () => home,
        configPath,
      });
      expect(slot).toMatchObject({ configPath, rawHash: result.persistedHash });
      if (!slot) {
        throw new Error("expected snapshot slot");
      }
      // The slot is diff-only, so every leaf is fingerprinted.
      const slotVars =
        (slot.fingerprintedAuthoredConfig as { env?: { vars?: Record<string, string> } }).env
          ?.vars ?? {};
      expect(Object.keys(slotVars)).toHaveLength(70);
      for (const [name, value] of Object.entries(slotVars)) {
        expect(value, name).toMatch(/^fp:[0-9a-f]{12}$/);
      }
      expect(
        (slot.fingerprintedAuthoredConfig as { gateway?: { port?: string } }).gateway?.port,
      ).toMatch(/^fp:[0-9a-f]{12}$/);
    },
  );

  itWithHome(
    "journals an offline edit before a later config write replaces the snapshot slot",
    async (home) => {
      const configPath = configPathForHome(home);
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await withEnvAsync(
        {
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_STATE_DIR: path.join(home, ".openclaw"),
          OPENCLAW_TEST_FAST: "1",
        },
        async () => {
          const io = createHomeConfigIO(home, {
            configPath,
            env: process.env,
          });
          const firstWrite = await io.writeConfigFile({ gateway: { port: 18789 } });
          await writeConfigJson(configPath, { gateway: { port: 18790 } });
          const offlineSnapshot = await io.readConfigFileSnapshot();
          const secondWrite = await io.writeConfigFile({ gateway: { port: 18791 } });
          const records = listConfigAuditRecordsForTests({ env: process.env, homedir: () => home });

          expect(records).toContainEqual(
            expect.objectContaining({
              event: "config.external",
              detectedBy: "write",
              previousHash: firstWrite.persistedHash,
              nextHash: offlineSnapshot.hash,
              changedPaths: expect.arrayContaining(["gateway.port"]),
            }),
          );
          expect(records).toContainEqual(
            expect.objectContaining({
              event: "config.write",
              nextHash: secondWrite.persistedHash,
            }),
          );
        },
      );
    },
  );

  itWithHome(
    "shares raw snapshot hashes between config writes and gateway startup reconciliation",
    async (home) => {
      const configPath = configPathForHome(home);
      const stateDir = path.join(home, ".openclaw");
      await withEnvAsync(
        {
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_TEST_FAST: "1",
        },
        async () => {
          const io = createHomeConfigIO(home, {
            configPath,
            env: process.env,
          });
          const write = await io.writeConfigFile({ gateway: { port: 18789 } });
          const writtenSnapshot = await readConfigFileSnapshotForRuntimeTransaction({});
          const slot = readConfigSnapshotAuditRecord({
            env: process.env,
            homedir: () => home,
            configPath,
          });
          expect(writtenSnapshot.valid).toBe(true);
          expect(slot).toMatchObject({ rawHash: write.persistedHash });
          expect(slot?.rawHash).toBe(writtenSnapshot.hash);

          const watcher = {
            options: { usePolling: false },
            on: vi.fn(),
            close: vi.fn(async () => {}),
          };
          watcher.on.mockImplementation(() => watcher);
          const watchSpy = vi.spyOn(chokidar, "watch").mockReturnValue(watcher as never);
          const startForSnapshot = (snapshot: ConfigFileSnapshot) =>
            startGatewayConfigReloader({
              initialConfig: snapshot.config,
              initialCompareConfig: snapshot.sourceConfig,
              initialSnapshotRawHash: snapshot.hash ?? null,
              initialAuthoredConfig: snapshot.parsed,
              initialSnapshotValid: snapshot.valid,
              initialSnapshotIssues: snapshot.issues,
              readSnapshot: async () => snapshot,
              initialPluginInstallRecords: {},
              readPluginInstallRecords: async () => ({}),
              onNoopConfigCommit: async () => {},
              onHotReload: async () => {},
              onRestart: async () => {},
              log: { info: () => {}, ...silentLogger },
              watchPath: configPath,
            });

          const firstReloader = startForSnapshot(writtenSnapshot);
          await firstReloader.stop();
          expect(
            listConfigAuditRecordsForTests({ env: process.env, homedir: () => home }).filter(
              (record) => record.event === "config.external",
            ),
          ).toEqual([]);

          const handEditedAuthoredConfig = structuredClone(
            writtenSnapshot.parsed,
          ) as OpenClawConfig;
          handEditedAuthoredConfig.gateway = {
            ...handEditedAuthoredConfig.gateway,
            port: 18790,
          };
          await writeConfigJson(configPath, handEditedAuthoredConfig);
          const handEditedSnapshot = await readConfigFileSnapshotForRuntimeTransaction({});
          const secondReloader = startForSnapshot(handEditedSnapshot);
          await secondReloader.stop();
          watchSpy.mockRestore();

          const externalRecord = listConfigAuditRecordsForTests({
            env: process.env,
            homedir: () => home,
          }).findLast((record) => record.event === "config.external");
          expect(externalRecord).toMatchObject({
            event: "config.external",
            detectedBy: "startup",
            previousHash: write.persistedHash,
            nextHash: handEditedSnapshot.hash,
            changedPaths: ["gateway.port"],
            valid: true,
          });
        },
      );
    },
  );

  itWithHome(
    "reseeds a shared state slot when the gateway starts for another config path",
    async (home) => {
      const configPathA = path.join(home, ".openclaw", "config-a.json");
      const configPathB = path.join(home, ".openclaw", "config-b.json");
      const stateDir = path.join(home, ".openclaw");
      await withEnvAsync(
        {
          OPENCLAW_CONFIG_PATH: configPathA,
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_TEST_FAST: "1",
        },
        async () => {
          const io = createHomeConfigIO(home, {
            configPath: configPathA,
            env: process.env,
          });
          await io.writeConfigFile({ gateway: { port: 18789 } });
          await writeConfigJson(configPathB, { gateway: { port: 18790 } });

          await withEnvAsync({ OPENCLAW_CONFIG_PATH: configPathB }, async () => {
            const snapshot = await readConfigFileSnapshotForRuntimeTransaction({});
            const watcher = {
              options: { usePolling: false },
              on: vi.fn(),
              close: vi.fn(async () => {}),
            };
            watcher.on.mockImplementation(() => watcher);
            const watchSpy = vi.spyOn(chokidar, "watch").mockReturnValue(watcher as never);
            const reloader = startGatewayConfigReloader({
              initialConfig: snapshot.config,
              initialCompareConfig: snapshot.sourceConfig,
              initialSnapshotRawHash: snapshot.hash ?? null,
              initialAuthoredConfig: snapshot.parsed,
              initialSnapshotValid: snapshot.valid,
              initialSnapshotIssues: snapshot.issues,
              readSnapshot: async () => snapshot,
              initialPluginInstallRecords: {},
              readPluginInstallRecords: async () => ({}),
              onNoopConfigCommit: async () => {},
              onHotReload: async () => {},
              onRestart: async () => {},
              log: { info: () => {}, ...silentLogger },
              watchPath: configPathB,
            });
            await reloader.stop();
            watchSpy.mockRestore();

            expect(
              listConfigAuditRecordsForTests({ env: process.env, homedir: () => home }).filter(
                (record) => record.event === "config.external",
              ),
            ).toEqual([]);
            expect(
              readConfigSnapshotAuditRecord({
                env: process.env,
                homedir: () => home,
                configPath: configPathB,
              }),
            ).toMatchObject({
              configPath: configPathB,
              rawHash: snapshot.hash,
            });
          });
        },
      );
    },
  );
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
