import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { createConfigIO } from "./io.js";

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

  afterAll(async () => {
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

  it("does not inject include-only $schema into the root config during partial writes", async () => {
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

      const persisted = await writeGatewayPortAndReadConfig(home, configPath);
      expect(persisted).not.toHaveProperty("$schema");
      expect(persisted.gateway).toEqual({ mode: "local", port: 18789 });
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
      ).resolves.toEqual({ persistedHash: expect.any(String) });
    });

    mockLoadPluginManifestRegistry.mockReturnValue({
      diagnostics: [],
      plugins: [],
    } satisfies PluginManifestRegistry);
  });
});
