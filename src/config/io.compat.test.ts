// Verifies config IO compatibility loading and migration behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { resolveContextTokensForModelFromCache } from "../agents/context-resolution.js";
import * as pluginManifestRegistry from "../plugins/manifest-registry.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { withTempDir } from "../test-utils/temp-dir.js";
import { VERSION } from "../version.js";
import { createConfigIO } from "./io.factory.js";
import * as configPluginMetadata from "./io.plugin-metadata.js";
import { tryGetLegacyDefaultAgentId } from "./legacy.default-agent-owner.js";
import { normalizeExecSafeBinProfilesInConfig } from "./normalize-exec-safe-bin.js";
import { createPluginMetadataSnapshot } from "./plugin-auto-enable.test-helpers.js";

vi.mock("../commands/doctor/shared/legacy-config-compat.js", () => ({
  applyLegacyDoctorMigrations: () => {
    throw new Error("config IO compatibility tests must not enter recovery migration");
  },
}));

vi.mock("../plugins/plugin-metadata-snapshot.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/plugin-metadata-snapshot.js")>();
  const loadSnapshot = (params: Parameters<typeof actual.loadPluginMetadataSnapshot>[0]) =>
    createPluginMetadataSnapshot({
      config: params.config,
      workspaceDir: params.workspaceDir,
      manifestRegistry: { plugins: [], diagnostics: [] },
    });
  return {
    ...actual,
    loadPluginMetadataSnapshot: loadSnapshot,
    resolvePluginMetadataSnapshot: loadSnapshot,
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

// The process owner retains this file's mocked snapshot loader across module resets.
afterAll(clearPluginMetadataLifecycleCaches);

function withTempHome<T>(run: (home: string) => Promise<T>): Promise<T> {
  return withTempDir("openclaw-config-compat-", run);
}

async function writeConfig(
  home: string,
  dirname: ".openclaw",
  port: number,
  filename = "openclaw.json",
) {
  const dir = path.join(home, dirname);
  await fs.mkdir(dir, { recursive: true });
  const configPath = path.join(dir, filename);
  await fs.writeFile(configPath, JSON.stringify({ gateway: { port } }, null, 2));
  return configPath;
}

function createIoForHome(home: string, env: NodeJS.ProcessEnv = {} as NodeJS.ProcessEnv) {
  return createConfigIO({
    env: { HOME: home, ...env },
    homedir: () => home,
  });
}

describe("config io paths", () => {
  it("uses ~/.openclaw/openclaw.json when config exists", async () => {
    await withTempHome(async (home) => {
      const configPath = await writeConfig(home, ".openclaw", 19001);
      const io = createIoForHome(home);
      expect(io.configPath).toBe(configPath);
    });
  });

  it("defaults to ~/.openclaw/openclaw.json when config is missing", async () => {
    await withTempHome(async (home) => {
      const io = createIoForHome(home);
      expect(io.configPath).toBe(path.join(home, ".openclaw", "openclaw.json"));
    });
  });

  it("uses OPENCLAW_HOME for default config path", async () => {
    await withTempHome(async (home) => {
      const io = createConfigIO({
        env: { OPENCLAW_HOME: path.join(home, "svc-home") } as NodeJS.ProcessEnv,
        homedir: () => path.join(home, "ignored-home"),
      });
      expect(io.configPath).toBe(path.join(home, "svc-home", ".openclaw", "openclaw.json"));
    });
  });

  it("honors explicit OPENCLAW_CONFIG_PATH override", async () => {
    await withTempHome(async (home) => {
      const customPath = await writeConfig(home, ".openclaw", 20002, "custom.json");
      const io = createIoForHome(home, { OPENCLAW_CONFIG_PATH: customPath } as NodeJS.ProcessEnv);
      expect(io.configPath).toBe(customPath);
    });
  });

  it("keeps canonical custom gateway bind byte-identical during load", async () => {
    await withTempHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      const gateway = {
        mode: "local" as const,
        bind: "custom" as const,
        customBindHost: "127.0.0.1",
      };
      const raw = `${JSON.stringify({ gateway }, null, 2)}\n`;
      await fs.writeFile(configPath, raw, "utf-8");
      const io = createConfigIO({
        configPath,
        env: { HOME: home } as NodeJS.ProcessEnv,
        homedir: () => home,
      });

      const config = io.loadConfig();

      expect(config.gateway).toMatchObject({ bind: "custom", customBindHost: "127.0.0.1" });
      await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(raw);
    });
  });

  it("loads retired context-budget shapes and surfaces migration guidance without rewriting", async () => {
    await withTempHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      const authored = {
        models: {
          providers: {
            openai: {
              contextTokens: 64_000,
              contextWindow: 128_000,
              models: [{ id: "gpt-5.4", name: "GPT-5.4" }],
            },
          },
        },
        agents: {
          defaults: { contextTokens: 48_000 },
          entries: { ops: { contextTokens: 32_000 } },
        },
      };
      const raw = `${JSON.stringify(authored, null, 2)}\n`;
      await fs.writeFile(configPath, raw, "utf-8");
      const logger = { error: vi.fn(), warn: vi.fn() };
      const io = createConfigIO({
        configPath,
        env: { HOME: home } as NodeJS.ProcessEnv,
        homedir: () => home,
        logger,
        pluginValidation: "core-only",
      });

      const config = io.loadConfig();
      const snapshot = await io.readConfigFileSnapshot();
      const provider = config.models?.providers?.openai;
      const resolvedBudget = resolveContextTokensForModelFromCache({
        cfg: config,
        provider: "openai",
        model: "gpt-5.4",
      });

      expect(snapshot.valid, JSON.stringify(snapshot.issues)).toBe(true);
      expect(provider).not.toHaveProperty("contextTokens");
      expect(provider).not.toHaveProperty("contextWindow");
      expect(provider?.models?.[0]).toMatchObject({
        contextTokens: 64_000,
        contextWindow: 128_000,
      });
      expect(config.agents?.defaults).not.toHaveProperty("contextTokens");
      expect(config.agents?.entries?.ops).not.toHaveProperty("contextTokens");
      expect(resolvedBudget).toBe(64_000);
      expect(snapshot.sourceConfigBeforeMigrations).toMatchObject(authored);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("models.providers.<provider>.models[].contextTokens"),
      );
      expect(snapshot.warnings).toContainEqual({
        path: "agents.defaults.contextTokens",
        message: "Removed agents.defaults.contextTokens.",
      });
      expect(snapshot.warnings).toContainEqual({
        path: "agents.defaults.contextTokens",
        message: expect.stringContaining("models.providers.<provider>.models[].contextTokens"),
      });
      expect(snapshot.warnings).not.toContainEqual(expect.objectContaining({ path: "" }));
      await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(raw);
    });
  });

  it("keeps core-only legacy roster reads independent from plugin metadata", async () => {
    await withTempHome(async (home) => {
      const configPath = await writeConfig(home, ".openclaw", 19001);
      const authored = {
        gateway: { mode: "local" },
        agents: { list: [{ id: "ops", default: true }, { id: "other" }] },
        channels: { "fixture-channel": { enabled: true } },
      };
      const raw = `${JSON.stringify(authored, null, 2)}\n`;
      await fs.writeFile(configPath, raw);
      const metadataRead = vi
        .spyOn(configPluginMetadata, "resolveConfigWidePluginManifestRegistry")
        .mockImplementation(() => {
          throw new Error("core-only config must not read plugin metadata");
        });
      const io = createConfigIO({
        configPath,
        env: { HOME: home },
        homedir: () => home,
        logger: { error: vi.fn(), warn: vi.fn() },
        observe: false,
        pluginValidation: "core-only",
      });

      const snapshot = await io.readConfigFileSnapshot();

      expect(snapshot.valid, JSON.stringify(snapshot.issues)).toBe(true);
      expect(snapshot.sourceConfigBeforeMigrations).toEqual(authored);
      for (const config of [snapshot.config, io.loadConfig(), await io.readBestEffortConfig()]) {
        expect(config.agents?.entries).toEqual({ ops: {}, other: {} });
        expect(config.agents?.defaults?.systemAgent?.agentId).toBe("ops");
        expect(config.bindings).toContainEqual({
          agentId: "ops",
          match: { channel: "fixture-channel", accountId: "*" },
        });
        expect(tryGetLegacyDefaultAgentId(config)).toBe("ops");
      }
      expect(metadataRead).not.toHaveBeenCalled();
      await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(raw);
    });
  });

  it("keeps core-only invalid config diagnostics independent from plugin metadata", async () => {
    await withTempHome(async (home) => {
      const configPath = await writeConfig(home, ".openclaw", 19001);
      const authored = {
        gateway: { port: "invalid", webchat: { enabled: true } },
        plugins: { entries: { "fixture-plugin": { enabled: true } } },
      };
      const raw = `${JSON.stringify(authored, null, 2)}\n`;
      await fs.writeFile(configPath, raw);
      const metadataRead = vi
        .spyOn(configPluginMetadata, "resolveConfigWidePluginManifestRegistry")
        .mockImplementation(() => {
          throw new Error("core-only config must not read plugin metadata");
        });
      const io = createConfigIO({
        configPath,
        env: { HOME: home },
        homedir: () => home,
        logger: { error: vi.fn(), warn: vi.fn() },
        observe: false,
        pluginValidation: "core-only",
      });

      const snapshot = await io.readConfigFileSnapshot();

      expect(snapshot.valid).toBe(false);
      expect(snapshot.issues).toContainEqual(expect.objectContaining({ path: "gateway.port" }));
      expect(snapshot.legacyIssues).toContainEqual({
        path: "gateway.webchat",
        message: 'gateway.webchat is retired. Run "openclaw doctor --fix".',
      });
      expect(io.loadConfig).toThrow(/gateway\.port/);
      expect(metadataRead).not.toHaveBeenCalled();
      await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(raw);
    });
  });

  it("keeps core-only custom provider defaults independent from plugin metadata", async () => {
    await withTempHome(async (home) => {
      const configPath = await writeConfig(home, ".openclaw", 19001);
      await fs.writeFile(
        configPath,
        JSON.stringify({
          models: {
            providers: {
              "fixture-external": {
                baseUrl: "https://fixture.invalid/v1",
                api: "openai-completions",
                models: [{ id: "custom-model", name: "Custom model" }],
              },
            },
          },
        }),
      );
      const metadataRead = vi
        .spyOn(pluginManifestRegistry, "loadPluginManifestRegistryCore")
        .mockImplementation(() => {
          throw new Error("core-only defaults must not read plugin metadata");
        });
      const io = createConfigIO({
        configPath,
        env: { HOME: home },
        homedir: () => home,
        logger: { error: vi.fn(), warn: vi.fn() },
        observe: false,
        pluginValidation: "core-only",
      });

      const snapshot = await io.readConfigFileSnapshot();

      expect(snapshot.valid, JSON.stringify(snapshot.issues)).toBe(true);
      for (const config of [snapshot.config, io.loadConfig(), await io.readBestEffortConfig()]) {
        expect(config.models?.providers?.["fixture-external"]?.models).toEqual([
          expect.objectContaining({ id: "custom-model", maxTokens: 8192, input: ["text"] }),
        ]);
      }
      expect(metadataRead).not.toHaveBeenCalled();
    });
  });

  it("logs each warning payload once until warnings clear", async () => {
    await withTempHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      const logger = {
        error: vi.fn(),
        warn: vi.fn(),
      };
      const load = () =>
        createConfigIO({
          configPath,
          env: { HOME: home } as NodeJS.ProcessEnv,
          homedir: () => home,
          logger,
        }).loadConfig();
      const writeRemovedPlugin = async (pluginId: string) => {
        await fs.writeFile(
          configPath,
          JSON.stringify({ plugins: { entries: { [pluginId]: { enabled: false } } } }),
        );
      };

      await writeRemovedPlugin("google-antigravity-auth");
      load();
      load();
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(
        "Config warnings: plugins.entries.google-antigravity-auth: plugin removed: google-antigravity-auth (stale config entry ignored; remove it from plugins config)",
      );

      createConfigIO({
        configPath,
        env: { HOME: home } as NodeJS.ProcessEnv,
        homedir: () => home,
        logger,
        pluginValidation: "skip",
      }).loadConfig();
      load();
      expect(logger.warn).toHaveBeenCalledTimes(1);

      await fs.writeFile(
        configPath,
        JSON.stringify({
          gateway: { port: "invalid" },
          plugins: { entries: { "google-antigravity-auth": { enabled: false } } },
        }),
      );
      expect(load).toThrow();
      await writeRemovedPlugin("google-antigravity-auth");
      load();
      expect(logger.warn).toHaveBeenCalledTimes(1);

      await writeRemovedPlugin("google-gemini-cli-auth");
      load();
      expect(logger.warn).toHaveBeenCalledTimes(2);

      await fs.writeFile(configPath, JSON.stringify({}));
      load();
      await writeRemovedPlugin("google-gemini-cli-auth");
      load();
      expect(logger.warn).toHaveBeenCalledTimes(3);

      // A null root is invalid config (throws) and, like the invalid-port
      // step above, preserves the logged-warning fingerprint.
      await fs.writeFile(configPath, "null");
      expect(load).toThrow();
      await writeRemovedPlugin("google-gemini-cli-auth");
      load();
      expect(logger.warn).toHaveBeenCalledTimes(3);
    });
  });

  it("explains what to check when config was written by a newer OpenClaw", async () => {
    await withTempHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(
        configPath,
        JSON.stringify(
          {
            meta: { lastTouchedVersion: "9999.1.1" },
            gateway: { mode: "local" },
          },
          null,
          2,
        ),
      );
      const logger = {
        error: vi.fn(),
        warn: vi.fn(),
      };

      const io = createConfigIO({
        configPath,
        env: { HOME: home } as NodeJS.ProcessEnv,
        homedir: () => home,
        logger,
      });
      io.loadConfig();

      expect(logger.warn).toHaveBeenCalledWith(
        [
          `Your OpenClaw config was written by version 9999.1.1, but this command is running ${VERSION}.`,
          "Check: `openclaw --version`, `which openclaw`, and `openclaw gateway status --deep`.",
          "If unexpected, update PATH so `openclaw` points to the version you want, or reinstall the Gateway service from that same OpenClaw install.",
        ].join("\n"),
      );
    });
  });

  it("does not warn about newer config during internal update handoff reads", async () => {
    await withTempHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(
        configPath,
        JSON.stringify(
          {
            meta: { lastTouchedVersion: "9999.1.1" },
            gateway: { mode: "local" },
          },
          null,
          2,
        ),
      );
      const logger = {
        error: vi.fn(),
        warn: vi.fn(),
      };

      const io = createConfigIO({
        configPath,
        env: { HOME: home, OPENCLAW_UPDATE_POST_CORE: "1" } as NodeJS.ProcessEnv,
        homedir: () => home,
        logger,
      });
      io.loadConfig();

      expect(logger.warn).not.toHaveBeenCalled();
    });
  });

  it("normalizes safe-bin config entries at config load time", () => {
    const cfg = {
      tools: {
        exec: {
          safeBinTrustedDirs: [" /custom/bin ", "", "/custom/bin", "/agent/bin"],
          safeBinProfiles: {
            " MyFilter ": {
              allowedValueFlags: ["--limit", " --limit ", ""],
            },
          },
        },
      },
      agents: {
        list: [
          {
            id: "ops",
            tools: {
              exec: {
                safeBinTrustedDirs: [" /ops/bin ", "/ops/bin"],
                safeBinProfiles: {
                  " Custom ": {
                    deniedFlags: ["-f", " -f ", ""],
                  },
                },
              },
            },
          },
        ],
      },
    };
    normalizeExecSafeBinProfilesInConfig(cfg);
    expect(cfg.tools?.exec?.safeBinProfiles).toEqual({
      myfilter: {
        allowedValueFlags: ["--limit"],
      },
    });
    expect(cfg.tools?.exec?.safeBinTrustedDirs).toEqual(["/custom/bin", "/agent/bin"]);
    expect(cfg.agents?.list?.[0]?.tools?.exec?.safeBinProfiles).toEqual({
      custom: {
        deniedFlags: ["-f"],
      },
    });
    expect(cfg.agents?.list?.[0]?.tools?.exec?.safeBinTrustedDirs).toEqual(["/ops/bin"]);
  });
});
