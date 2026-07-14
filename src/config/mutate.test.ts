// Covers config mutation helpers and persisted write behavior.
import fsNode from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { initializePublishedConfigRuntimeEnv, prepareConfigRuntimeEnv } from "./config-env-vars.js";
import { hashConfigIncludeRaw } from "./includes.js";
import type { ConfigWriteOptions } from "./io.js";
import {
  ConfigMutationConflictError,
  mutateConfigFile,
  replaceConfigFile,
  transformConfigFileWithRetry,
} from "./mutate.js";
import { resolveConfigPath } from "./paths.js";
import {
  registerRuntimeConfigWriteListener,
  registerManagedRuntimeConfigWriteOwner,
  resetConfigRuntimeState,
  setRuntimeConfigSnapshot,
  setRuntimeConfigSnapshotRefreshHandler,
} from "./runtime-snapshot.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "./types.js";

type MockValidationIssue = { path: string; message: string };
type MockValidationResult =
  | { ok: true; config: OpenClawConfig; warnings: MockValidationIssue[] }
  | { ok: false; issues: MockValidationIssue[]; warnings: MockValidationIssue[] };
type ConfigIOReadForWrite = ReturnType<
  typeof import("./io.js").createConfigIO
>["readConfigFileSnapshotForWrite"];

const ioMocks = vi.hoisted(() => {
  const readConfigFileSnapshotForWrite = vi.fn<ConfigIOReadForWrite>();
  return {
    createConfigIO: vi.fn(
      (
        _options?: Parameters<typeof import("./io.js").createConfigIO>[0],
      ): { readConfigFileSnapshotForWrite: ConfigIOReadForWrite } => ({
        readConfigFileSnapshotForWrite,
      }),
    ),
    readConfigFileSnapshotForWrite,
    resolveConfigSnapshotHash: vi.fn(),
    writeConfigFile: vi.fn(),
  };
});
const validationMocks = vi.hoisted(() => ({
  validateConfigObjectWithPlugins: vi.fn(
    (config: OpenClawConfig): MockValidationResult => ({
      ok: true,
      config,
      warnings: [],
    }),
  ),
}));
const backupMocks = vi.hoisted(() => ({
  maintainConfigBackups: vi.fn<typeof import("./backup-rotation.js").maintainConfigBackups>(),
}));

vi.mock("./io.js", async () => ({
  ...(await vi.importActual<typeof import("./io.js")>("./io.js")),
  ...ioMocks,
}));
vi.mock("./validation.js", () => validationMocks);
vi.mock("./backup-rotation.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./backup-rotation.js")>();
  backupMocks.maintainConfigBackups.mockImplementation(actual.maintainConfigBackups);
  return {
    ...actual,
    maintainConfigBackups: backupMocks.maintainConfigBackups,
  };
});

function createSnapshot(params: {
  hash: string;
  path?: string;
  parsed?: unknown;
  sourceConfig: OpenClawConfig;
  runtimeConfig?: OpenClawConfig;
}): ConfigFileSnapshot {
  const runtimeConfig = (params.runtimeConfig ??
    params.sourceConfig) as ConfigFileSnapshot["config"];
  const sourceConfig = params.sourceConfig as ConfigFileSnapshot["sourceConfig"];
  const parsed = params.parsed ?? params.sourceConfig;
  return {
    path: params.path ?? "/tmp/openclaw.json",
    exists: true,
    raw: `${JSON.stringify(parsed, null, 2)}\n`,
    parsed,
    sourceConfig,
    resolved: sourceConfig,
    valid: true,
    runtimeConfig,
    config: runtimeConfig,
    hash: params.hash,
    issues: [],
    warnings: [],
    legacyIssues: [],
  };
}

async function resolveIncludeTarget(filePath: string): Promise<string> {
  return path.join(await fs.realpath(path.dirname(filePath)), path.basename(filePath));
}

const allowConfigPathWrite = () => {};

describe("config mutate helpers", () => {
  const suiteRootTracker = createSuiteTempRootTracker({ prefix: "openclaw-config-mutate-" });
  const originalNixMode = process.env.OPENCLAW_NIX_MODE;

  beforeAll(async () => {
    await suiteRootTracker.setup();
  });

  afterAll(async () => {
    if (originalNixMode === undefined) {
      delete process.env.OPENCLAW_NIX_MODE;
    } else {
      process.env.OPENCLAW_NIX_MODE = originalNixMode;
    }
    await suiteRootTracker.cleanup();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    resetConfigRuntimeState();
    validationMocks.validateConfigObjectWithPlugins.mockImplementation(
      (config: OpenClawConfig) => ({
        ok: true,
        config,
        warnings: [],
      }),
    );
    ioMocks.resolveConfigSnapshotHash.mockImplementation(
      (snapshot: { hash?: string }) => snapshot.hash ?? null,
    );
    delete process.env.OPENCLAW_NIX_MODE;
  });

  it("mutates source config with optimistic hash protection", async () => {
    const snapshot = createSnapshot({
      hash: "source-hash",
      sourceConfig: { gateway: { port: 18789 } },
      runtimeConfig: { gateway: { port: 19001 } },
    });
    ioMocks.readConfigFileSnapshotForWrite.mockResolvedValue({
      snapshot,
      writeOptions: { expectedConfigPath: snapshot.path },
    });

    const result = await mutateConfigFile({
      baseHash: snapshot.hash,
      base: "source",
      mutate(draft) {
        draft.gateway = {
          ...draft.gateway,
          auth: { mode: "token" },
        };
      },
    });

    expect(result.previousHash).toBe("source-hash");
    expect(result.nextConfig.gateway).toEqual({
      port: 18789,
      auth: { mode: "token" },
    });
    expect(result.afterWrite).toEqual({ mode: "auto" });
    expect(result.followUp).toEqual({ mode: "auto", requiresRestart: false });
    expect(ioMocks.writeConfigFile).toHaveBeenCalledWith(
      {
        gateway: {
          port: 18789,
          auth: { mode: "token" },
        },
      },
      { baseSnapshot: snapshot, expectedConfigPath: snapshot.path, afterWrite: { mode: "auto" } },
    );
  });

  it("retries transform mutations on stale config conflicts", async () => {
    const initial = createSnapshot({
      hash: "hash-1",
      sourceConfig: { agents: { list: [] } },
    });
    const fresh = createSnapshot({
      hash: "hash-2",
      sourceConfig: { agents: { list: [{ id: "other-agent" }] } },
    });
    ioMocks.readConfigFileSnapshotForWrite
      .mockResolvedValueOnce({
        snapshot: initial,
        writeOptions: {
          expectedConfigPath: initial.path,
          ownedConfigPathForWrite: initial.path,
        },
      })
      .mockResolvedValueOnce({
        snapshot: fresh,
        writeOptions: {
          expectedConfigPath: fresh.path,
          ownedConfigPathForWrite: fresh.path,
        },
      });
    ioMocks.writeConfigFile
      .mockRejectedValueOnce(new ConfigMutationConflictError("stale", { currentHash: "hash-2" }))
      .mockResolvedValueOnce(undefined);

    const result = await transformConfigFileWithRetry({
      io: ioMocks,
      transform(config, context) {
        return {
          nextConfig: {
            ...config,
            agents: {
              list: [...(config.agents?.list ?? []), { id: "work" }],
            },
          },
          result: context.attempt,
        };
      },
    });

    expect(result.attempts).toBe(2);
    expect(result.result).toBe(1);
    expect(ioMocks.writeConfigFile).toHaveBeenCalledTimes(2);
    expect(ioMocks.writeConfigFile).toHaveBeenNthCalledWith(
      2,
      {
        agents: {
          list: [{ id: "other-agent" }, { id: "work" }],
        },
      },
      {
        baseSnapshot: fresh,
        expectedConfigPath: fresh.path,
        ownedConfigPathForWrite: initial.path,
        afterWrite: { mode: "auto" },
        preCommitRuntimePreflight: expect.any(Function),
      },
    );
  });

  it("preserves config path ownership across transform retries", async () => {
    const initial = createSnapshot({
      hash: "hash-1",
      path: "/tmp/first-openclaw.json",
      sourceConfig: { agents: { list: [] } },
    });
    const fresh = createSnapshot({
      hash: "hash-2",
      path: "/tmp/second-openclaw.json",
      sourceConfig: { agents: { list: [] } },
    });
    ioMocks.readConfigFileSnapshotForWrite
      .mockResolvedValueOnce({
        snapshot: initial,
        writeOptions: { expectedConfigPath: initial.path },
      })
      .mockResolvedValueOnce({
        snapshot: fresh,
        writeOptions: { expectedConfigPath: fresh.path },
      });
    ioMocks.writeConfigFile.mockRejectedValueOnce(
      new ConfigMutationConflictError("stale", { currentHash: fresh.hash ?? null }),
    );

    const transform = vi.fn((config: OpenClawConfig) => ({ nextConfig: config }));

    await expect(
      transformConfigFileWithRetry({
        io: ioMocks,
        transform,
      }),
    ).rejects.toThrow("config path changed since last load");

    expect(ioMocks.readConfigFileSnapshotForWrite).toHaveBeenCalledTimes(2);
    expect(ioMocks.writeConfigFile).toHaveBeenCalledTimes(1);
    expect(transform).toHaveBeenCalledTimes(1);
  });

  it("captures retry ownership before checking a caller base hash", async () => {
    const initial = createSnapshot({
      hash: "hash-1",
      path: "/tmp/first-openclaw.json",
      sourceConfig: { agents: { list: [] } },
    });
    const fresh = createSnapshot({
      hash: "hash-2",
      path: "/tmp/second-openclaw.json",
      sourceConfig: { agents: { list: [] } },
    });
    ioMocks.readConfigFileSnapshotForWrite
      .mockResolvedValueOnce({
        snapshot: initial,
        writeOptions: {
          expectedConfigPath: initial.path,
          ownedConfigPathForWrite: initial.path,
        },
      })
      .mockResolvedValueOnce({
        snapshot: fresh,
        writeOptions: {
          expectedConfigPath: fresh.path,
          ownedConfigPathForWrite: fresh.path,
        },
      });
    const transform = vi.fn((config: OpenClawConfig) => ({ nextConfig: config }));

    await expect(
      transformConfigFileWithRetry({
        baseHash: fresh.hash,
        io: ioMocks,
        transform,
      }),
    ).rejects.toThrow("config path changed since last load");

    expect(ioMocks.readConfigFileSnapshotForWrite).toHaveBeenCalledTimes(2);
    expect(transform).not.toHaveBeenCalled();
    expect(ioMocks.writeConfigFile).not.toHaveBeenCalled();
  });

  it("does not retry transform mutations after config path ownership changes", async () => {
    const initialConfigPath = resolveConfigPath();
    const snapshot = createSnapshot({
      hash: "hash-1",
      path: initialConfigPath,
      sourceConfig: { agents: { list: [] } },
    });
    let activeConfigPath = snapshot.path;
    ioMocks.readConfigFileSnapshotForWrite.mockResolvedValue({
      snapshot,
      writeOptions: {
        assertConfigPathForWrite: () => {
          if (activeConfigPath !== snapshot.path) {
            throw new ConfigMutationConflictError("config path changed since last load", {
              currentHash: null,
              retryable: false,
            });
          }
        },
        expectedConfigPath: snapshot.path,
      },
    });

    await expect(
      transformConfigFileWithRetry({
        transform(config) {
          activeConfigPath = "/tmp/second-openclaw.json";
          return { nextConfig: config };
        },
      }),
    ).rejects.toThrow("config path changed since last load");

    expect(ioMocks.readConfigFileSnapshotForWrite).toHaveBeenCalledTimes(1);
    expect(ioMocks.writeConfigFile).not.toHaveBeenCalled();
  });

  it("serializes same-process transform mutations before reading snapshots", async () => {
    const configPath = resolveConfigPath();
    const initial = createSnapshot({
      hash: "hash-1",
      path: configPath,
      sourceConfig: { agents: { list: [] } },
    });
    const fresh = createSnapshot({
      hash: "hash-2",
      path: configPath,
      sourceConfig: { agents: { list: [{ id: "first" }] } },
    });
    ioMocks.readConfigFileSnapshotForWrite
      .mockResolvedValueOnce({
        snapshot: initial,
        writeOptions: { expectedConfigPath: initial.path },
      })
      .mockResolvedValueOnce({
        snapshot: fresh,
        writeOptions: { expectedConfigPath: fresh.path },
      });
    ioMocks.writeConfigFile.mockResolvedValue(undefined);

    let releaseFirstTransform!: () => void;
    let markFirstTransformStarted!: () => void;
    const firstTransformStarted = new Promise<void>((resolve) => {
      markFirstTransformStarted = resolve;
    });
    const first = transformConfigFileWithRetry({
      transform: async (config) => {
        markFirstTransformStarted();
        await new Promise<void>((release) => {
          releaseFirstTransform = release;
        });
        return {
          nextConfig: {
            ...config,
            agents: { list: [{ id: "first" }] },
          },
        };
      },
    });
    await firstTransformStarted;
    const second = transformConfigFileWithRetry({
      transform: (config) => ({
        nextConfig: {
          ...config,
          agents: {
            list: [...(config.agents?.list ?? []), { id: "second" }],
          },
        },
      }),
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(ioMocks.readConfigFileSnapshotForWrite).toHaveBeenCalledTimes(1);

    releaseFirstTransform();
    await Promise.all([first, second]);
    expect(ioMocks.writeConfigFile).toHaveBeenNthCalledWith(
      2,
      {
        agents: {
          list: [{ id: "first" }, { id: "second" }],
        },
      },
      { baseSnapshot: fresh, expectedConfigPath: fresh.path, afterWrite: { mode: "auto" } },
    );
  });

  it("rejects stale replace attempts when the base hash changed", async () => {
    ioMocks.readConfigFileSnapshotForWrite.mockResolvedValue({
      snapshot: createSnapshot({
        hash: "new-hash",
        sourceConfig: { gateway: { port: 19001 } },
      }),
      writeOptions: {},
    });

    await expect(
      replaceConfigFile({
        baseHash: "old-hash",
        nextConfig: { gateway: { port: 19002 } },
      }),
    ).rejects.toBeInstanceOf(ConfigMutationConflictError);
    expect(ioMocks.writeConfigFile).not.toHaveBeenCalled();
  });

  it("rejects replace attempts when the active config path changed", async () => {
    const snapshot = createSnapshot({
      path: "/tmp/second-openclaw.json",
      hash: "same-hash",
      sourceConfig: { gateway: { port: 18789 } },
    });
    ioMocks.readConfigFileSnapshotForWrite.mockResolvedValue({
      snapshot,
      writeOptions: { expectedConfigPath: snapshot.path },
    });

    await expect(
      replaceConfigFile({
        baseHash: snapshot.hash,
        nextConfig: { gateway: { port: 19002 } },
        writeOptions: { expectedConfigPath: "/tmp/first-openclaw.json" },
      }),
    ).rejects.toThrow("config path changed since last load");
    expect(ioMocks.writeConfigFile).not.toHaveBeenCalled();
  });

  it("refuses replace writes in Nix mode before touching disk", async () => {
    process.env.OPENCLAW_NIX_MODE = "1";
    const snapshot = createSnapshot({
      hash: "hash-1",
      sourceConfig: { gateway: { port: 18789 } },
    });
    ioMocks.readConfigFileSnapshotForWrite.mockResolvedValue({
      snapshot,
      writeOptions: { expectedConfigPath: snapshot.path },
    });

    await expect(
      replaceConfigFile({
        nextConfig: { gateway: { port: 19001 } },
      }),
    ).rejects.toThrow(
      "Agent-first Nix setup: https://github.com/openclaw/nix-openclaw#quick-start",
    );

    expect(ioMocks.writeConfigFile).not.toHaveBeenCalled();
  });

  it("refuses mutate writes in Nix mode before touching disk", async () => {
    process.env.OPENCLAW_NIX_MODE = "1";
    const snapshot = createSnapshot({
      hash: "hash-1",
      sourceConfig: { gateway: { port: 18789 } },
    });
    ioMocks.readConfigFileSnapshotForWrite.mockResolvedValue({
      snapshot,
      writeOptions: { expectedConfigPath: snapshot.path },
    });

    await expect(
      mutateConfigFile({
        mutate(draft) {
          draft.gateway = { ...draft.gateway, port: 19001 };
        },
      }),
    ).rejects.toThrow("OpenClaw Nix overview: https://docs.openclaw.ai/install/nix");

    expect(ioMocks.writeConfigFile).not.toHaveBeenCalled();
  });

  it("reuses a provided snapshot and write options for replace", async () => {
    const snapshot = createSnapshot({
      hash: "hash-1",
      sourceConfig: { gateway: { auth: { mode: "token" } } },
    });

    await replaceConfigFile({
      baseHash: snapshot.hash,
      nextConfig: { gateway: { auth: { mode: "token", token: "minted" } } },
      snapshot,
      writeOptions: { expectedConfigPath: snapshot.path },
    });

    expect(ioMocks.readConfigFileSnapshotForWrite).not.toHaveBeenCalled();
    expect(ioMocks.writeConfigFile).toHaveBeenCalledWith(
      { gateway: { auth: { mode: "token", token: "minted" } } },
      {
        baseSnapshot: snapshot,
        expectedConfigPath: snapshot.path,
        afterWrite: { mode: "auto" },
      },
    );
  });

  it("uses skipPluginValidation for replace pre-write snapshots", async () => {
    const snapshot = createSnapshot({
      hash: "hash-1",
      sourceConfig: { plugins: { entries: { "strict-plugin": { enabled: true } } } },
    });
    ioMocks.readConfigFileSnapshotForWrite.mockResolvedValue({
      snapshot,
      writeOptions: { expectedConfigPath: snapshot.path },
    });

    await replaceConfigFile({
      nextConfig: { plugins: { entries: { "strict-plugin": { enabled: false } } } },
      writeOptions: { skipPluginValidation: true },
    });

    expect(ioMocks.readConfigFileSnapshotForWrite).toHaveBeenCalledWith({
      skipPluginValidation: true,
    });
    expect(ioMocks.writeConfigFile).toHaveBeenCalledWith(
      { plugins: { entries: { "strict-plugin": { enabled: false } } } },
      {
        baseSnapshot: snapshot,
        expectedConfigPath: snapshot.path,
        skipPluginValidation: true,
        afterWrite: { mode: "auto" },
      },
    );
  });

  it("returns explicit restart follow-up intent for replace writes", async () => {
    const snapshot = createSnapshot({
      hash: "hash-restart",
      sourceConfig: { gateway: { auth: { mode: "token" } } },
    });

    const result = await replaceConfigFile({
      baseHash: snapshot.hash,
      nextConfig: { gateway: { auth: { mode: "token", token: "minted" } } },
      snapshot,
      afterWrite: { mode: "restart", reason: "plugin auth changed" },
      writeOptions: { expectedConfigPath: snapshot.path },
    });

    expect(result.afterWrite).toEqual({ mode: "restart", reason: "plugin auth changed" });
    expect(result.followUp).toEqual({
      mode: "restart",
      reason: "plugin auth changed",
      requiresRestart: true,
    });
    expect(ioMocks.writeConfigFile).toHaveBeenCalledWith(
      { gateway: { auth: { mode: "token", token: "minted" } } },
      {
        baseSnapshot: snapshot,
        expectedConfigPath: snapshot.path,
        afterWrite: { mode: "restart", reason: "plugin auth changed" },
      },
    );
  });

  it("returns the canonical persisted config from replace writes", async () => {
    const snapshot = createSnapshot({
      hash: "hash-persisted",
      sourceConfig: { gateway: { auth: { mode: "token" } } },
    });
    ioMocks.writeConfigFile.mockResolvedValue({
      persistedHash: "hash-after",
      persistedConfig: {
        gateway: { auth: { mode: "token", token: "minted" } },
        meta: { lastTouchedVersion: "test" },
      },
    });

    const result = await replaceConfigFile({
      baseHash: snapshot.hash,
      nextConfig: { gateway: { auth: { mode: "token", token: "minted" } } },
      snapshot,
      writeOptions: { expectedConfigPath: snapshot.path },
    });

    expect(result.persistedHash).toBe("hash-after");
    expect(result.nextConfig).toEqual({
      gateway: { auth: { mode: "token", token: "minted" } },
      meta: { lastTouchedVersion: "test" },
    });
  });

  it("repairs invalid config through a single-file top-level plugins include", async () => {
    const home = await suiteRootTracker.make("include");
    const configPath = path.join(home, ".openclaw", "openclaw.json");
    const pluginsPath = path.join(home, ".openclaw", "config", "plugins.json5");
    await fs.mkdir(path.dirname(pluginsPath), { recursive: true });
    await fs.writeFile(
      configPath,
      `${JSON.stringify({ plugins: { $include: "./config/plugins.json5" } }, null, 2)}\n`,
      "utf-8",
    );
    await fs.writeFile(
      pluginsPath,
      `${JSON.stringify(
        {
          entries: {
            old: {
              enabled: true,
              config: { token: "${OPENCLAW_TEST_PLUGIN_TOKEN}" },
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
    const previousBackupPath = `${pluginsPath}.bak`;
    await fs.writeFile(previousBackupPath, "previous backup", { mode: 0o644 });
    const oldEntry = {
      enabled: true,
      config: { token: "plugin-token-runtime" },
    };
    const snapshot: ConfigFileSnapshot = {
      ...createSnapshot({
        hash: "hash-include",
        path: configPath,
        parsed: { plugins: { $include: "./config/plugins.json5" } },
        sourceConfig: {
          plugins: {
            entries: { old: oldEntry },
          },
        },
      }),
      valid: false,
      issues: [{ path: "plugins.load.paths", message: "plugin path not found: /gone" }],
    };
    const refreshedSnapshot = createSnapshot({
      hash: "hash-include-refreshed",
      path: configPath,
      parsed: { plugins: { $include: "./config/plugins.json5" } },
      sourceConfig: {
        plugins: {
          entries: {
            old: oldEntry,
            demo: { enabled: true },
          },
        },
      },
    });
    ioMocks.readConfigFileSnapshotForWrite
      .mockResolvedValueOnce({
        snapshot,
        writeOptions: {
          expectedConfigPath: configPath,
          envSnapshotForRestore: { OPENCLAW_TEST_PLUGIN_TOKEN: "plugin-token-runtime" },
          assertConfigPathForWrite: allowConfigPathWrite,
          includeFileTargetsForWrite: { [pluginsPath]: await resolveIncludeTarget(pluginsPath) },
        },
      })
      .mockResolvedValueOnce({
        snapshot: refreshedSnapshot,
        writeOptions: { expectedConfigPath: configPath },
      });
    const notifications: unknown[] = [];
    const unregister = registerRuntimeConfigWriteListener((event) => {
      notifications.push(event);
    });

    try {
      await replaceConfigFile({
        baseHash: snapshot.hash,
        afterWrite: { mode: "restart", reason: "test include refresh" },
        writeOptions: {
          expectedConfigPath: snapshot.path,
          unsetPaths: [["plugins", "installs"]],
        },
        nextConfig: {
          plugins: {
            entries: {
              old: oldEntry,
              demo: { enabled: true },
            },
            installs: {
              demo: {
                source: "npm",
                spec: "demo",
                installPath: "/tmp/demo",
              },
            },
          },
        },
        io: {
          env: { OPENCLAW_TEST_PLUGIN_TOKEN: "plugin-token-after-read" },
          readConfigFileSnapshotForWrite: ioMocks.readConfigFileSnapshotForWrite,
          writeConfigFile: ioMocks.writeConfigFile,
        },
      });
    } finally {
      unregister();
    }

    expect(ioMocks.writeConfigFile).not.toHaveBeenCalled();
    expect(notifications).toHaveLength(1);
    const [notification] = notifications as Array<{
      configPath?: string;
      persistedHash?: string;
      sourceConfig?: unknown;
      runtimeConfig?: unknown;
      afterWrite?: unknown;
    }>;
    expect(notification?.configPath).toBe(configPath);
    expect(notification?.persistedHash).toBe("hash-include-refreshed");
    expect(notification?.sourceConfig).toEqual({
      plugins: {
        entries: {
          old: oldEntry,
          demo: { enabled: true },
        },
      },
    });
    expect(notification?.runtimeConfig).toEqual({
      plugins: {
        entries: {
          old: oldEntry,
          demo: { enabled: true },
        },
      },
    });
    expect(notification?.afterWrite).toEqual({ mode: "restart", reason: "test include refresh" });
    await expect(fs.readFile(configPath, "utf-8")).resolves.toContain(
      '"$include": "./config/plugins.json5"',
    );
    await expect(fs.readFile(`${pluginsPath}.bak`, "utf-8")).resolves.toContain('"old"');
    await expect(fs.readFile(`${pluginsPath}.bak.1`, "utf-8")).resolves.toBe("previous backup");
    if (process.platform !== "win32") {
      expect((await fs.stat(`${pluginsPath}.bak`)).mode & 0o777).toBe(0o600);
      expect((await fs.stat(`${pluginsPath}.bak.1`)).mode & 0o777).toBe(0o600);
    }
    const persistedPlugins = JSON.parse(await fs.readFile(pluginsPath, "utf-8")) as {
      entries?: Record<string, { config?: { token?: string } }>;
      installs?: Record<string, unknown>;
    };
    expect(persistedPlugins.entries?.old?.config?.token).toBe("${OPENCLAW_TEST_PLUGIN_TOKEN}");
    expect(persistedPlugins.entries?.demo).toEqual({ enabled: true });
    expect(persistedPlugins.installs).toBeUndefined();
  });

  it("repairs a malformed single-file top-level include", async () => {
    const home = await suiteRootTracker.make("malformed-include");
    const configPath = path.join(home, ".openclaw", "openclaw.json");
    const pluginsPath = path.join(home, ".openclaw", "config", "plugins.json5");
    await fs.mkdir(path.dirname(pluginsPath), { recursive: true });
    await fs.writeFile(
      configPath,
      `${JSON.stringify({ plugins: { $include: "./config/plugins.json5" } }, null, 2)}\n`,
      "utf-8",
    );
    await fs.writeFile(pluginsPath, "{ malformed", "utf-8");

    const snapshot: ConfigFileSnapshot = {
      ...createSnapshot({
        hash: "hash-malformed-include",
        path: configPath,
        parsed: { plugins: { $include: "./config/plugins.json5" } },
        sourceConfig: { plugins: {} },
      }),
      valid: false,
      issues: [
        {
          path: "",
          message: `Failed to parse include file: ./config/plugins.json5 (resolved: ${pluginsPath})`,
        },
      ],
    };
    const nextConfig = {
      plugins: { entries: { demo: { enabled: true } } },
    } satisfies OpenClawConfig;
    ioMocks.readConfigFileSnapshotForWrite
      .mockResolvedValueOnce({
        snapshot,
        writeOptions: {
          expectedConfigPath: configPath,
          includeFileHashesForWrite: { [pluginsPath]: hashConfigIncludeRaw("{ malformed") },
          assertConfigPathForWrite: allowConfigPathWrite,
          includeFileTargetsForWrite: { [pluginsPath]: await resolveIncludeTarget(pluginsPath) },
        },
      })
      .mockResolvedValueOnce({
        snapshot: createSnapshot({
          hash: "hash-malformed-include-refreshed",
          path: configPath,
          parsed: { plugins: { $include: "./config/plugins.json5" } },
          sourceConfig: nextConfig,
        }),
        writeOptions: { expectedConfigPath: configPath },
      });

    await replaceConfigFile({
      baseHash: snapshot.hash,
      nextConfig,
      io: {
        readConfigFileSnapshotForWrite: ioMocks.readConfigFileSnapshotForWrite,
        writeConfigFile: ioMocks.writeConfigFile,
      },
    });

    expect(ioMocks.writeConfigFile).not.toHaveBeenCalled();
    await expect(fs.readFile(`${pluginsPath}.bak`, "utf-8")).resolves.toBe("{ malformed");
    await expect(fs.readFile(pluginsPath, "utf-8")).resolves.toBe(
      `${JSON.stringify(nextConfig.plugins, null, 2)}\n`,
    );
  });

  it("repairs a missing single-file top-level include from its snapshot", async () => {
    const home = await suiteRootTracker.make("missing-include");
    const configPath = path.join(home, ".openclaw", "openclaw.json");
    const pluginsPath = path.join(home, ".openclaw", "config", "plugins.json5");
    await fs.mkdir(path.dirname(pluginsPath), { recursive: true });
    await fs.writeFile(
      configPath,
      `${JSON.stringify({ plugins: { $include: "./config/plugins.json5" } }, null, 2)}\n`,
      "utf-8",
    );

    const snapshot: ConfigFileSnapshot = {
      ...createSnapshot({
        hash: "hash-missing-include",
        path: configPath,
        parsed: { plugins: { $include: "./config/plugins.json5" } },
        sourceConfig: { plugins: {} },
      }),
      valid: false,
      issues: [
        {
          path: "",
          message: `Failed to read include file: ./config/plugins.json5 (resolved: ${pluginsPath})`,
        },
      ],
    };
    const nextConfig = {
      plugins: { entries: { demo: { enabled: true } } },
    } satisfies OpenClawConfig;
    ioMocks.readConfigFileSnapshotForWrite
      .mockResolvedValueOnce({
        snapshot,
        writeOptions: {
          expectedConfigPath: configPath,
          includeFileHashesForWrite: { [pluginsPath]: hashConfigIncludeRaw(null) },
          assertConfigPathForWrite: allowConfigPathWrite,
          includeFileTargetsForWrite: { [pluginsPath]: await resolveIncludeTarget(pluginsPath) },
        },
      })
      .mockResolvedValueOnce({
        snapshot: createSnapshot({
          hash: "hash-missing-include-refreshed",
          path: configPath,
          parsed: { plugins: { $include: "./config/plugins.json5" } },
          sourceConfig: nextConfig,
        }),
        writeOptions: { expectedConfigPath: configPath },
      });

    await replaceConfigFile({
      baseHash: snapshot.hash,
      nextConfig,
      io: {
        readConfigFileSnapshotForWrite: ioMocks.readConfigFileSnapshotForWrite,
        writeConfigFile: ioMocks.writeConfigFile,
      },
    });

    expect(ioMocks.writeConfigFile).not.toHaveBeenCalled();
    await expect(fs.readFile(pluginsPath, "utf-8")).resolves.toBe(
      `${JSON.stringify(nextConfig.plugins, null, 2)}\n`,
    );
  });

  it.runIf(process.platform !== "win32")(
    "rejects missing include repairs through symlinked parents outside config roots",
    async () => {
      const home = await suiteRootTracker.make("missing-include-symlink-escape");
      const outside = await suiteRootTracker.make("missing-include-symlink-outside");
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      const linkPath = path.join(home, ".openclaw", "link");
      const pluginsPath = path.join(linkPath, "plugins.json5");
      const outsidePluginsPath = path.join(outside, "plugins.json5");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.symlink(outside, linkPath);
      await fs.writeFile(
        configPath,
        `${JSON.stringify({ plugins: { $include: "./link/plugins.json5" } }, null, 2)}\n`,
        "utf-8",
      );

      const snapshot: ConfigFileSnapshot = {
        ...createSnapshot({
          hash: "hash-missing-include-symlink-escape",
          path: configPath,
          parsed: { plugins: { $include: "./link/plugins.json5" } },
          sourceConfig: { plugins: {} },
        }),
        valid: false,
        issues: [
          {
            path: "",
            message: `Failed to read include file: ./link/plugins.json5 (resolved: ${pluginsPath})`,
          },
        ],
      };
      ioMocks.readConfigFileSnapshotForWrite.mockResolvedValue({
        snapshot,
        writeOptions: {
          expectedConfigPath: configPath,
          includeFileHashesForWrite: { [pluginsPath]: hashConfigIncludeRaw(null) },
          assertConfigPathForWrite: allowConfigPathWrite,
          includeFileTargetsForWrite: { [pluginsPath]: await resolveIncludeTarget(pluginsPath) },
        },
      });

      await expect(
        replaceConfigFile({
          baseHash: snapshot.hash,
          nextConfig: { plugins: { entries: { demo: { enabled: true } } } },
          io: {
            readConfigFileSnapshotForWrite: ioMocks.readConfigFileSnapshotForWrite,
            writeConfigFile: ioMocks.writeConfigFile,
          },
        }),
      ).rejects.toThrow("Config mutation cannot update external $include target");

      await expect(fs.stat(outsidePluginsPath)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("does not overwrite a malformed include changed after its snapshot", async () => {
    const home = await suiteRootTracker.make("malformed-include-concurrent");
    const configPath = path.join(home, ".openclaw", "openclaw.json");
    const pluginsPath = path.join(home, ".openclaw", "config", "plugins.json5");
    const snapshotRaw = "{ malformed";
    const concurrentRaw = "{ differently malformed";
    await fs.mkdir(path.dirname(pluginsPath), { recursive: true });
    await fs.writeFile(
      configPath,
      `${JSON.stringify({ plugins: { $include: "./config/plugins.json5" } }, null, 2)}\n`,
      "utf-8",
    );
    await fs.writeFile(pluginsPath, concurrentRaw, "utf-8");

    const snapshot: ConfigFileSnapshot = {
      ...createSnapshot({
        hash: "hash-malformed-include-concurrent",
        path: configPath,
        parsed: { plugins: { $include: "./config/plugins.json5" } },
        sourceConfig: { plugins: {} },
      }),
      valid: false,
      issues: [
        {
          path: "",
          message: `Failed to parse include file: ./config/plugins.json5 (resolved: ${pluginsPath})`,
        },
      ],
    };
    ioMocks.readConfigFileSnapshotForWrite.mockResolvedValue({
      snapshot,
      writeOptions: {
        expectedConfigPath: configPath,
        includeFileHashesForWrite: { [pluginsPath]: hashConfigIncludeRaw(snapshotRaw) },
        assertConfigPathForWrite: allowConfigPathWrite,
        includeFileTargetsForWrite: { [pluginsPath]: await resolveIncludeTarget(pluginsPath) },
      },
    });

    await expect(
      replaceConfigFile({
        baseHash: snapshot.hash,
        nextConfig: { plugins: { entries: { demo: { enabled: true } } } },
        io: {
          readConfigFileSnapshotForWrite: ioMocks.readConfigFileSnapshotForWrite,
          writeConfigFile: ioMocks.writeConfigFile,
        },
      }),
    ).rejects.toThrow("included config changed since last load");

    expect(ioMocks.writeConfigFile).not.toHaveBeenCalled();
    await expect(fs.readFile(pluginsPath, "utf-8")).resolves.toBe(concurrentRaw);
  });

  it("prefers mutation-start include hashes over commit-time reread hashes", async () => {
    const home = await suiteRootTracker.make("include-mutation-start-hash");
    const configPath = path.join(home, ".openclaw", "openclaw.json");
    const pluginsPath = path.join(home, ".openclaw", "config", "plugins.json5");
    const initialRaw = `${JSON.stringify({ entries: {} }, null, 2)}\n`;
    const concurrentRaw = `${JSON.stringify(
      { entries: { concurrent: { enabled: true } } },
      null,
      2,
    )}\n`;
    await fs.mkdir(path.dirname(pluginsPath), { recursive: true });
    await fs.writeFile(
      configPath,
      `${JSON.stringify({ plugins: { $include: "./config/plugins.json5" } }, null, 2)}\n`,
      "utf-8",
    );
    await fs.writeFile(pluginsPath, concurrentRaw, "utf-8");

    const snapshot = createSnapshot({
      hash: "hash-include-mutation-start",
      path: configPath,
      parsed: { plugins: { $include: "./config/plugins.json5" } },
      sourceConfig: { plugins: { entries: { concurrent: { enabled: true } } } },
    });
    ioMocks.readConfigFileSnapshotForWrite.mockResolvedValue({
      snapshot,
      writeOptions: {
        expectedConfigPath: configPath,
        includeFileHashesForWrite: { [pluginsPath]: hashConfigIncludeRaw(concurrentRaw) },
        assertConfigPathForWrite: allowConfigPathWrite,
        includeFileTargetsForWrite: { [pluginsPath]: await resolveIncludeTarget(pluginsPath) },
      },
    });

    await expect(
      replaceConfigFile({
        baseHash: snapshot.hash,
        writeOptions: {
          expectedConfigPath: configPath,
          includeFileHashesForWrite: { [pluginsPath]: hashConfigIncludeRaw(initialRaw) },
          assertConfigPathForWrite: allowConfigPathWrite,
          includeFileTargetsForWrite: { [pluginsPath]: await resolveIncludeTarget(pluginsPath) },
        },
        nextConfig: { plugins: { entries: { demo: { enabled: true } } } },
        io: {
          readConfigFileSnapshotForWrite: ioMocks.readConfigFileSnapshotForWrite,
          writeConfigFile: ioMocks.writeConfigFile,
        },
      }),
    ).rejects.toThrow("included config changed since last load");

    expect(ioMocks.writeConfigFile).not.toHaveBeenCalled();
    await expect(fs.readFile(pluginsPath, "utf-8")).resolves.toBe(concurrentRaw);
  });

  it("uses a provided mutation-start snapshot even without write options", async () => {
    const home = await suiteRootTracker.make("include-mutation-start-snapshot");
    const configPath = path.join(home, ".openclaw", "openclaw.json");
    const pluginsPath = path.join(home, ".openclaw", "config", "plugins.json5");
    const concurrentRaw = `${JSON.stringify(
      { entries: { concurrent: { enabled: true } } },
      null,
      2,
    )}\n`;
    await fs.mkdir(path.dirname(pluginsPath), { recursive: true });
    await fs.writeFile(
      configPath,
      `${JSON.stringify({ plugins: { $include: "./config/plugins.json5" } }, null, 2)}\n`,
      "utf-8",
    );
    await fs.writeFile(pluginsPath, concurrentRaw, "utf-8");

    const snapshot = createSnapshot({
      hash: "hash-include-mutation-start-snapshot",
      path: configPath,
      parsed: { plugins: { $include: "./config/plugins.json5" } },
      sourceConfig: { plugins: { entries: { old: { enabled: true } } } },
    });

    await expect(
      replaceConfigFile({
        snapshot,
        baseHash: snapshot.hash,
        nextConfig: { plugins: { entries: { demo: { enabled: true } } } },
        io: {
          readConfigFileSnapshotForWrite: ioMocks.readConfigFileSnapshotForWrite,
          writeConfigFile: ioMocks.writeConfigFile,
        },
      }),
    ).rejects.toThrow("included config target changed since last load");

    expect(ioMocks.readConfigFileSnapshotForWrite).not.toHaveBeenCalled();
    expect(ioMocks.writeConfigFile).not.toHaveBeenCalled();
    await expect(fs.readFile(pluginsPath, "utf-8")).resolves.toBe(concurrentRaw);
  });

  it("keeps single-file top-level plugins include writes when plugin validation is skipped", async () => {
    const home = await suiteRootTracker.make("include-skip-plugin-validation");
    const configPath = path.join(home, ".openclaw", "openclaw.json");
    const pluginsPath = path.join(home, ".openclaw", "config", "plugins.json5");
    await fs.mkdir(path.dirname(pluginsPath), { recursive: true });
    await fs.writeFile(
      configPath,
      `${JSON.stringify({ plugins: { $include: "./config/plugins.json5" } }, null, 2)}\n`,
      "utf-8",
    );
    await fs.writeFile(pluginsPath, `${JSON.stringify({ entries: {} }, null, 2)}\n`, "utf-8");
    const snapshot = createSnapshot({
      hash: "hash-include-skip",
      path: configPath,
      parsed: { plugins: { $include: "./config/plugins.json5" } },
      sourceConfig: { plugins: { entries: {} } },
    });
    const refreshedSnapshot = createSnapshot({
      hash: "hash-include-skip-refreshed",
      path: configPath,
      parsed: { plugins: { $include: "./config/plugins.json5" } },
      sourceConfig: {
        plugins: {
          entries: {
            "strict-plugin": { enabled: true },
          },
        },
      },
    });
    ioMocks.readConfigFileSnapshotForWrite.mockResolvedValue({
      snapshot: refreshedSnapshot,
      writeOptions: { expectedConfigPath: configPath },
    });
    const nextConfig: OpenClawConfig = {
      plugins: {
        entries: {
          "strict-plugin": { enabled: true },
        },
      },
    };

    await replaceConfigFile({
      baseHash: snapshot.hash,
      snapshot,
      writeOptions: {
        expectedConfigPath: snapshot.path,
        assertConfigPathForWrite: allowConfigPathWrite,
        includeFileTargetsForWrite: { [pluginsPath]: await resolveIncludeTarget(pluginsPath) },
        skipPluginValidation: true,
      },
      nextConfig,
    });

    expect(ioMocks.writeConfigFile).not.toHaveBeenCalled();
    expect(validationMocks.validateConfigObjectWithPlugins).toHaveBeenCalledWith(nextConfig, {
      pluginValidation: "skip",
    });
    expect(ioMocks.createConfigIO).toHaveBeenCalledWith({
      configPath,
      pluginValidation: "skip",
    });
    expect(ioMocks.readConfigFileSnapshotForWrite).toHaveBeenCalledWith();
    await expect(fs.readFile(configPath, "utf-8")).resolves.toContain(
      '"$include": "./config/plugins.json5"',
    );
    const persistedPlugins = JSON.parse(await fs.readFile(pluginsPath, "utf-8")) as {
      entries?: Record<string, unknown>;
    };
    expect(persistedPlugins.entries?.["strict-plugin"]).toEqual({ enabled: true });
  });

  it("rejects direct mutations to external include roots", async () => {
    const home = await suiteRootTracker.make("include-allowed-root");
    const sharedRoot = path.join(home, "shared");
    const configPath = path.join(home, ".openclaw", "openclaw.json");
    const pluginsPath = path.join(sharedRoot, "plugins.json5");
    await fs.mkdir(sharedRoot, { recursive: true });
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(
      configPath,
      `${JSON.stringify({ plugins: { $include: pluginsPath } }, null, 2)}\n`,
      "utf-8",
    );
    await fs.writeFile(pluginsPath, `${JSON.stringify({ entries: {} }, null, 2)}\n`, "utf-8");
    const snapshot = createSnapshot({
      hash: "hash-include-allowed-root",
      path: configPath,
      parsed: { plugins: { $include: pluginsPath } },
      sourceConfig: { plugins: { entries: {} } },
    });
    const nextConfig = {
      plugins: { entries: { demo: { enabled: true } } },
    } satisfies OpenClawConfig;
    ioMocks.readConfigFileSnapshotForWrite.mockResolvedValue({
      snapshot: createSnapshot({
        hash: "hash-include-allowed-root-refreshed",
        path: configPath,
        parsed: { plugins: { $include: pluginsPath } },
        sourceConfig: nextConfig,
      }),
      writeOptions: { expectedConfigPath: configPath },
    });

    await expect(
      replaceConfigFile({
        baseHash: snapshot.hash,
        snapshot,
        writeOptions: {
          expectedConfigPath: snapshot.path,
          assertConfigPathForWrite: allowConfigPathWrite,
          includeFileTargetsForWrite: { [pluginsPath]: await resolveIncludeTarget(pluginsPath) },
        },
        nextConfig,
        io: {
          env: { OPENCLAW_INCLUDE_ROOTS: "~/shared" },
          readConfigFileSnapshotForWrite: ioMocks.readConfigFileSnapshotForWrite,
          writeConfigFile: ioMocks.writeConfigFile,
        },
      }),
    ).rejects.toThrow("Config mutation cannot update external $include target");

    expect(ioMocks.writeConfigFile).not.toHaveBeenCalled();
    await expect(fs.readFile(pluginsPath, "utf-8")).resolves.toBe(
      `${JSON.stringify({ entries: {} }, null, 2)}\n`,
    );
  });

  it("preflights single-file top-level include writes before persisting", async () => {
    const home = await suiteRootTracker.make("include-runtime-preflight");
    const configPath = path.join(home, ".openclaw", "openclaw.json");
    const pluginsPath = path.join(home, ".openclaw", "config", "plugins.json5");
    await fs.mkdir(path.dirname(pluginsPath), { recursive: true });
    await fs.writeFile(
      configPath,
      `${JSON.stringify({ plugins: { $include: "./config/plugins.json5" } }, null, 2)}\n`,
      "utf-8",
    );
    const initialPluginsRaw = `${JSON.stringify({ entries: {} }, null, 2)}\n`;
    await fs.writeFile(pluginsPath, initialPluginsRaw, "utf-8");
    const snapshot = createSnapshot({
      hash: "hash-include-preflight",
      path: configPath,
      parsed: { plugins: { $include: "./config/plugins.json5" } },
      sourceConfig: { plugins: { entries: {} } },
    });

    try {
      setRuntimeConfigSnapshotRefreshHandler({
        preflight: () => {
          throw new Error("missing include secret");
        },
        refresh: () => true,
      });

      await expect(
        replaceConfigFile({
          baseHash: snapshot.hash,
          snapshot,
          writeOptions: {
            expectedConfigPath: snapshot.path,
            assertConfigPathForWrite: allowConfigPathWrite,
            includeFileTargetsForWrite: { [pluginsPath]: await resolveIncludeTarget(pluginsPath) },
          },
          nextConfig: {
            plugins: {
              entries: {
                demo: { enabled: true },
              },
            },
          },
        }),
      ).rejects.toThrow(/active SecretRef resolution failed: missing include secret/);

      await expect(fs.readFile(pluginsPath, "utf-8")).resolves.toBe(initialPluginsRaw);
    } finally {
      setRuntimeConfigSnapshotRefreshHandler(null);
    }
  });

  it("runs a caller commit guard after runtime preflight and before an include write", async () => {
    const home = await suiteRootTracker.make("include-caller-preflight");
    const configPath = path.join(home, ".openclaw", "openclaw.json");
    const pluginsPath = path.join(home, ".openclaw", "config", "plugins.json5");
    await fs.mkdir(path.dirname(pluginsPath), { recursive: true });
    await fs.writeFile(
      configPath,
      `${JSON.stringify({ plugins: { $include: "./config/plugins.json5" } }, null, 2)}\n`,
      "utf-8",
    );
    const initialPluginsRaw = `${JSON.stringify({ entries: {} }, null, 2)}\n`;
    await fs.writeFile(pluginsPath, initialPluginsRaw, "utf-8");
    const snapshot = createSnapshot({
      hash: "hash-include-caller-preflight",
      path: configPath,
      parsed: { plugins: { $include: "./config/plugins.json5" } },
      sourceConfig: { plugins: { entries: {} } },
    });
    const events: string[] = [];

    try {
      setRuntimeConfigSnapshotRefreshHandler({
        preflight: () => {
          events.push("runtime");
        },
        refresh: () => true,
      });

      await expect(
        replaceConfigFile({
          baseHash: snapshot.hash,
          snapshot,
          writeOptions: {
            expectedConfigPath: snapshot.path,
            assertConfigPathForWrite: allowConfigPathWrite,
            includeFileTargetsForWrite: { [pluginsPath]: await resolveIncludeTarget(pluginsPath) },
            preCommitRuntimePreflight: async (sourceConfig) => {
              events.push(
                `caller:${String(sourceConfig.plugins?.entries?.demo?.enabled ?? false)}`,
              );
              await expect(fs.readFile(`${pluginsPath}.bak`, "utf-8")).resolves.toBe(
                initialPluginsRaw,
              );
              await expect(fs.readFile(pluginsPath, "utf-8")).resolves.toBe(initialPluginsRaw);
              throw new Error("include authority changed");
            },
          },
          nextConfig: {
            plugins: {
              entries: {
                demo: { enabled: true },
              },
            },
          },
        }),
      ).rejects.toThrow("include authority changed");

      expect(events).toEqual(["runtime", "caller:true"]);
      await expect(fs.readFile(pluginsPath, "utf-8")).resolves.toBe(initialPluginsRaw);
    } finally {
      setRuntimeConfigSnapshotRefreshHandler(null);
    }
  });

  it("preserves auth-store refresh scope for managed top-level include writes", async () => {
    const home = await suiteRootTracker.make("include-managed-refresh-scope");
    const configPath = path.join(home, ".openclaw", "openclaw.json");
    const pluginsPath = path.join(home, ".openclaw", "config", "plugins.json5");
    await fs.mkdir(path.dirname(pluginsPath), { recursive: true });
    await fs.writeFile(
      configPath,
      `${JSON.stringify({ plugins: { $include: "./config/plugins.json5" } }, null, 2)}\n`,
      "utf-8",
    );
    await fs.writeFile(pluginsPath, `${JSON.stringify({ entries: {} }, null, 2)}\n`, "utf-8");
    const snapshot = createSnapshot({
      hash: "hash-include-managed-refresh-scope",
      path: configPath,
      parsed: { plugins: { $include: "./config/plugins.json5" } },
      sourceConfig: { plugins: { entries: {} } },
    });
    const nextConfig = {
      plugins: { entries: { demo: { enabled: true } } },
    } satisfies OpenClawConfig;
    ioMocks.readConfigFileSnapshotForWrite.mockResolvedValue({
      snapshot: createSnapshot({
        hash: "hash-include-managed-refresh-scope-written",
        path: configPath,
        parsed: { plugins: { $include: "./config/plugins.json5" } },
        sourceConfig: nextConfig,
      }),
      writeOptions: { expectedConfigPath: configPath },
    });
    const preflight = vi.fn(
      async (sourceConfig: OpenClawConfig, refreshOptions?: { includeAuthStoreRefs?: boolean }) => {
        if (refreshOptions?.includeAuthStoreRefs !== false) {
          throw new Error("unavailable auth-profile SecretRef");
        }
        return { runtimeConfig: sourceConfig, compareConfig: sourceConfig };
      },
    );
    const releaseOwner = registerManagedRuntimeConfigWriteOwner(configPath, preflight);
    const notifications: Array<{ includeAuthStoreRefs?: boolean } | undefined> = [];
    const releaseListener = registerRuntimeConfigWriteListener((event) => {
      if (event.configPath === configPath) {
        notifications.push(event.runtimeRefresh);
      }
    });

    try {
      await replaceConfigFile({
        baseHash: snapshot.hash,
        snapshot,
        writeOptions: {
          expectedConfigPath: snapshot.path,
          assertConfigPathForWrite: allowConfigPathWrite,
          includeFileTargetsForWrite: {
            [pluginsPath]: await resolveIncludeTarget(pluginsPath),
          },
          runtimeRefresh: { includeAuthStoreRefs: false },
        },
        nextConfig,
      });
    } finally {
      releaseListener();
      releaseOwner();
    }

    expect(preflight).toHaveBeenCalledWith(expect.any(Object), {
      includeAuthStoreRefs: false,
    });
    expect(notifications).toEqual([{ includeAuthStoreRefs: false }]);
    const persisted = JSON.parse(
      await fs.readFile(pluginsPath, "utf-8"),
    ) as OpenClawConfig["plugins"];
    expect(persisted?.entries?.demo?.enabled).toBe(true);
  });

  it("uses the published restart env source for isolated managed include writes", async () => {
    const home = await suiteRootTracker.make("include-managed-deferred-restart-env");
    const configPath = path.join(home, ".openclaw", "openclaw.json");
    const envPath = path.join(home, ".openclaw", "config", "env.json5");
    const envKey = "OC";
    await fs.mkdir(path.dirname(envPath), { recursive: true });
    await fs.writeFile(
      configPath,
      `${JSON.stringify(
        {
          env: { $include: "./config/env.json5" },
          gateway: { auth: { mode: "token", token: "${OC}" } },
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
    await fs.writeFile(
      envPath,
      `${JSON.stringify({ vars: { [envKey]: "live" } }, null, 2)}\n`,
      "utf-8",
    );
    const initialConfig = {
      env: { vars: { [envKey]: "old" } },
      gateway: { auth: { mode: "token" as const, token: "old" } },
    } satisfies OpenClawConfig;
    const acceptedRestartConfig = {
      env: { vars: { [envKey]: "live" } },
      gateway: { auth: { mode: "token" as const, token: "live" } },
    } satisfies OpenClawConfig;
    const nextConfig = {
      env: { vars: { [envKey]: "next" } },
      gateway: { auth: { mode: "token" as const, token: "live" } },
    } satisfies OpenClawConfig;
    const snapshot = createSnapshot({
      hash: "hash-include-managed-deferred-restart-env",
      path: configPath,
      parsed: {
        env: { $include: "./config/env.json5" },
        gateway: { auth: { mode: "token", token: "${OC}" } },
      },
      sourceConfig: acceptedRestartConfig,
      runtimeConfig: initialConfig,
    });
    const refreshedSnapshot = createSnapshot({
      hash: "hash-include-managed-deferred-restart-env-written",
      path: configPath,
      parsed: snapshot.parsed,
      sourceConfig: {
        ...nextConfig,
        gateway: { auth: { mode: "token", token: "next" } },
      },
    });
    let preflightSource: OpenClawConfig | undefined;
    const releaseOwner = registerManagedRuntimeConfigWriteOwner(
      configPath,
      async (sourceConfig) => {
        preflightSource = sourceConfig;
        return { runtimeConfig: sourceConfig, compareConfig: sourceConfig };
      },
    );
    const previousEnv = process.env[envKey];
    process.env[envKey] = "old";
    setRuntimeConfigSnapshot(initialConfig, initialConfig);
    initializePublishedConfigRuntimeEnv(initialConfig, {
      ownedEnv: { [envKey]: "old" },
    });
    const rollbackRestartEnv = prepareConfigRuntimeEnv({
      previousConfig: initialConfig,
      nextConfig: acceptedRestartConfig,
    }).publish();
    let rereadEnv: NodeJS.ProcessEnv | undefined;
    ioMocks.createConfigIO.mockImplementation((options?: { env?: NodeJS.ProcessEnv }) => ({
      readConfigFileSnapshotForWrite: async () => {
        rereadEnv = options?.env;
        expect(rereadEnv?.[envKey]).toBeUndefined();
        if (rereadEnv) {
          rereadEnv[envKey] = "next";
        }
        return {
          snapshot: refreshedSnapshot,
          writeOptions: { expectedConfigPath: configPath },
        };
      },
    }));

    try {
      await replaceConfigFile({
        baseHash: snapshot.hash,
        snapshot,
        writeOptions: {
          expectedConfigPath: snapshot.path,
          assertConfigPathForWrite: allowConfigPathWrite,
          includeFileTargetsForWrite: { [envPath]: await resolveIncludeTarget(envPath) },
        },
        nextConfig,
      });

      expect(rereadEnv).toBeDefined();
      expect(rereadEnv).not.toBe(process.env);
      expect(rereadEnv?.[envKey]).toBe("next");
      expect(preflightSource?.gateway?.auth?.token).toBe("next");
      expect(process.env[envKey]).toBe("live");
    } finally {
      rollbackRestartEnv();
      releaseOwner();
      ioMocks.createConfigIO.mockImplementation(() => ({
        readConfigFileSnapshotForWrite: ioMocks.readConfigFileSnapshotForWrite,
      }));
      if (previousEnv === undefined) {
        delete process.env[envKey];
      } else {
        process.env[envKey] = previousEnv;
      }
    }
  });

  it("does not overwrite concurrent include edits made during preflight", async () => {
    const home = await suiteRootTracker.make("include-preflight-concurrent");
    const configPath = path.join(home, ".openclaw", "openclaw.json");
    const pluginsPath = path.join(home, ".openclaw", "config", "plugins.json5");
    await fs.mkdir(path.dirname(pluginsPath), { recursive: true });
    await fs.writeFile(
      configPath,
      `${JSON.stringify({ plugins: { $include: "./config/plugins.json5" } }, null, 2)}\n`,
      "utf-8",
    );
    await fs.writeFile(pluginsPath, `${JSON.stringify({ entries: {} }, null, 2)}\n`, "utf-8");
    const concurrentRaw = `${JSON.stringify(
      { entries: { concurrent: { enabled: true } } },
      null,
      2,
    )}\n`;
    const snapshot = createSnapshot({
      hash: "hash-include-preflight-concurrent",
      path: configPath,
      parsed: { plugins: { $include: "./config/plugins.json5" } },
      sourceConfig: { plugins: { entries: {} } },
    });

    try {
      setRuntimeConfigSnapshotRefreshHandler({
        preflight: async () => {
          await fs.writeFile(pluginsPath, concurrentRaw, "utf-8");
        },
        refresh: () => true,
      });

      await expect(
        replaceConfigFile({
          baseHash: snapshot.hash,
          snapshot,
          writeOptions: {
            expectedConfigPath: snapshot.path,
            assertConfigPathForWrite: allowConfigPathWrite,
            includeFileTargetsForWrite: { [pluginsPath]: await resolveIncludeTarget(pluginsPath) },
          },
          nextConfig: {
            plugins: {
              entries: {
                demo: { enabled: true },
              },
            },
          },
        }),
      ).rejects.toBeInstanceOf(ConfigMutationConflictError);

      await expect(fs.readFile(pluginsPath, "utf-8")).resolves.toBe(concurrentRaw);
    } finally {
      setRuntimeConfigSnapshotRefreshHandler(null);
    }
  });

  it("does not overwrite concurrent include edits made during backup rotation", async () => {
    const home = await suiteRootTracker.make("include-backup-concurrent");
    const configPath = path.join(home, ".openclaw", "openclaw.json");
    const pluginsPath = path.join(home, ".openclaw", "config", "plugins.json5");
    const rootConfig = { plugins: { $include: "./config/plugins.json5" } };
    const initialPluginsRaw = `${JSON.stringify({ entries: {} }, null, 2)}\n`;
    const concurrentPluginsRaw = `${JSON.stringify(
      { entries: { concurrent: { enabled: true } } },
      null,
      2,
    )}\n`;
    await fs.mkdir(path.dirname(pluginsPath), { recursive: true });
    await fs.writeFile(configPath, `${JSON.stringify(rootConfig, null, 2)}\n`, "utf-8");
    await fs.writeFile(pluginsPath, initialPluginsRaw, "utf-8");
    const snapshot = createSnapshot({
      hash: "hash-include-backup-concurrent",
      path: configPath,
      parsed: rootConfig,
      sourceConfig: { plugins: { entries: {} } },
    });
    backupMocks.maintainConfigBackups.mockImplementationOnce(async () => {
      await fs.writeFile(pluginsPath, concurrentPluginsRaw, "utf-8");
    });

    await expect(
      replaceConfigFile({
        baseHash: snapshot.hash,
        snapshot,
        writeOptions: {
          expectedConfigPath: snapshot.path,
          assertConfigPathForWrite: allowConfigPathWrite,
          includeFileTargetsForWrite: { [pluginsPath]: await resolveIncludeTarget(pluginsPath) },
        },
        nextConfig: {
          plugins: {
            entries: {
              demo: { enabled: true },
            },
          },
        },
      }),
    ).rejects.toBeInstanceOf(ConfigMutationConflictError);

    await expect(fs.readFile(pluginsPath, "utf-8")).resolves.toBe(concurrentPluginsRaw);
  });

  it("does not write an include after its root ownership changes during backup rotation", async () => {
    const home = await suiteRootTracker.make("include-root-backup-concurrent");
    const configPath = path.join(home, ".openclaw", "openclaw.json");
    const pluginsPath = path.join(home, ".openclaw", "config", "plugins.json5");
    const rootConfig = { plugins: { $include: "./config/plugins.json5" } };
    const initialPluginsRaw = `${JSON.stringify({ entries: {} }, null, 2)}\n`;
    const concurrentRootRaw = `${JSON.stringify(
      { plugins: { entries: { concurrent: { enabled: true } } } },
      null,
      2,
    )}\n`;
    await fs.mkdir(path.dirname(pluginsPath), { recursive: true });
    await fs.writeFile(configPath, `${JSON.stringify(rootConfig, null, 2)}\n`, "utf-8");
    await fs.writeFile(pluginsPath, initialPluginsRaw, "utf-8");
    const snapshot = createSnapshot({
      hash: "hash-include-root-backup-concurrent",
      path: configPath,
      parsed: rootConfig,
      sourceConfig: { plugins: { entries: {} } },
    });
    backupMocks.maintainConfigBackups.mockImplementationOnce(async () => {
      await fs.writeFile(configPath, concurrentRootRaw, "utf-8");
    });

    await expect(
      replaceConfigFile({
        baseHash: snapshot.hash,
        snapshot,
        writeOptions: {
          expectedConfigPath: snapshot.path,
          assertConfigPathForWrite: allowConfigPathWrite,
          includeFileTargetsForWrite: { [pluginsPath]: await resolveIncludeTarget(pluginsPath) },
        },
        nextConfig: {
          plugins: {
            entries: {
              demo: { enabled: true },
            },
          },
        },
      }),
    ).rejects.toBeInstanceOf(ConfigMutationConflictError);

    await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(concurrentRootRaw);
    await expect(fs.readFile(pluginsPath, "utf-8")).resolves.toBe(initialPluginsRaw);
  });

  it("does not write an include after its root ownership changes during preflight", async () => {
    const home = await suiteRootTracker.make("include-root-preflight-concurrent");
    const configPath = path.join(home, ".openclaw", "openclaw.json");
    const pluginsPath = path.join(home, ".openclaw", "config", "plugins.json5");
    const rootConfig = { plugins: { $include: "./config/plugins.json5" } };
    const initialPluginsRaw = `${JSON.stringify({ entries: {} }, null, 2)}\n`;
    const concurrentRootRaw = `${JSON.stringify(
      { plugins: { entries: { concurrent: { enabled: true } } } },
      null,
      2,
    )}\n`;
    await fs.mkdir(path.dirname(pluginsPath), { recursive: true });
    await fs.writeFile(configPath, `${JSON.stringify(rootConfig, null, 2)}\n`, "utf-8");
    await fs.writeFile(pluginsPath, initialPluginsRaw, "utf-8");
    const snapshot = createSnapshot({
      hash: "hash-include-root-preflight-concurrent",
      path: configPath,
      parsed: rootConfig,
      sourceConfig: { plugins: { entries: {} } },
    });

    try {
      setRuntimeConfigSnapshotRefreshHandler({
        preflight: async () => {
          await fs.writeFile(configPath, concurrentRootRaw, "utf-8");
        },
        refresh: () => true,
      });

      await expect(
        replaceConfigFile({
          baseHash: snapshot.hash,
          snapshot,
          writeOptions: {
            expectedConfigPath: snapshot.path,
            assertConfigPathForWrite: allowConfigPathWrite,
            includeFileTargetsForWrite: { [pluginsPath]: await resolveIncludeTarget(pluginsPath) },
          },
          nextConfig: {
            plugins: {
              entries: {
                demo: { enabled: true },
              },
            },
          },
        }),
      ).rejects.toBeInstanceOf(ConfigMutationConflictError);

      await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(concurrentRootRaw);
      await expect(fs.readFile(pluginsPath, "utf-8")).resolves.toBe(initialPluginsRaw);
    } finally {
      setRuntimeConfigSnapshotRefreshHandler(null);
    }
  });

  it("does not write an include after the active config path changes during preflight", async () => {
    const home = await suiteRootTracker.make("include-active-path-preflight-concurrent");
    const firstConfigPath = path.join(home, "first", "openclaw.json");
    const secondConfigPath = path.join(home, "second", "openclaw.json");
    const pluginsPath = path.join(home, "first", "plugins.json5");
    const rootConfig = { plugins: { $include: "./plugins.json5" } };
    const initialPluginsRaw = `${JSON.stringify({ entries: {} }, null, 2)}\n`;
    await fs.mkdir(path.dirname(firstConfigPath), { recursive: true });
    await fs.mkdir(path.dirname(secondConfigPath), { recursive: true });
    await fs.writeFile(firstConfigPath, `${JSON.stringify(rootConfig, null, 2)}\n`, "utf-8");
    await fs.writeFile(secondConfigPath, `${JSON.stringify(rootConfig, null, 2)}\n`, "utf-8");
    await fs.writeFile(pluginsPath, initialPluginsRaw, "utf-8");
    const snapshot = createSnapshot({
      hash: "hash-include-active-path-preflight-concurrent",
      path: firstConfigPath,
      parsed: rootConfig,
      sourceConfig: { plugins: { entries: {} } },
    });
    let activeConfigPath = firstConfigPath;
    const assertConfigPathForWrite = () => {
      if (activeConfigPath !== firstConfigPath) {
        throw new ConfigMutationConflictError("config path changed since last load", {
          currentHash: null,
          retryable: false,
        });
      }
    };

    try {
      setRuntimeConfigSnapshotRefreshHandler({
        preflight: () => {
          activeConfigPath = secondConfigPath;
        },
        refresh: () => true,
      });

      await expect(
        replaceConfigFile({
          baseHash: snapshot.hash,
          snapshot,
          writeOptions: {
            expectedConfigPath: snapshot.path,
            assertConfigPathForWrite,
            includeFileTargetsForWrite: { [pluginsPath]: await resolveIncludeTarget(pluginsPath) },
          },
          nextConfig: {
            plugins: {
              entries: {
                demo: { enabled: true },
              },
            },
          },
        }),
      ).rejects.toThrow("config path changed since last load");

      await expect(fs.readFile(pluginsPath, "utf-8")).resolves.toBe(initialPluginsRaw);
    } finally {
      setRuntimeConfigSnapshotRefreshHandler(null);
    }
  });

  it("rolls back an include write when config path ownership changes during commit", async () => {
    const home = await suiteRootTracker.make("include-active-path-commit-concurrent");
    const configPath = path.join(home, ".openclaw", "openclaw.json");
    const pluginsPath = path.join(home, ".openclaw", "plugins.json5");
    const rootConfig = { plugins: { $include: "./plugins.json5" } };
    const initialPluginsRaw = `${JSON.stringify({ entries: {} }, null, 2)}\n`;
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, `${JSON.stringify(rootConfig, null, 2)}\n`, "utf-8");
    await fs.writeFile(pluginsPath, initialPluginsRaw, "utf-8");
    const snapshot = createSnapshot({
      hash: "hash-include-active-path-commit-concurrent",
      path: configPath,
      parsed: rootConfig,
      sourceConfig: { plugins: { entries: {} } },
    });
    let activeConfigPath = configPath;
    const assertConfigPathForWrite = () => {
      if (fsNode.readFileSync(pluginsPath, "utf-8") !== initialPluginsRaw) {
        activeConfigPath = "/tmp/other-openclaw.json";
      }
      if (activeConfigPath !== configPath) {
        throw new ConfigMutationConflictError("config path changed since last load", {
          currentHash: null,
          retryable: false,
        });
      }
    };

    await expect(
      replaceConfigFile({
        baseHash: snapshot.hash,
        snapshot,
        writeOptions: {
          expectedConfigPath: snapshot.path,
          assertConfigPathForWrite,
          includeFileTargetsForWrite: { [pluginsPath]: await resolveIncludeTarget(pluginsPath) },
        },
        nextConfig: {
          plugins: {
            entries: {
              demo: { enabled: true },
            },
          },
        },
      }),
    ).rejects.toThrow("config path changed since last load");

    await expect(fs.readFile(pluginsPath, "utf-8")).resolves.toBe(initialPluginsRaw);
  });

  it.each(["active path", "refreshed snapshot path"] as const)(
    "rolls back an include write when the %s changes during the post-write read",
    async (changeKind) => {
      const home = await suiteRootTracker.make(
        `include-post-write-${changeKind.replaceAll(" ", "-")}`,
      );
      const configPath = path.join(home, "first", "openclaw.json");
      const otherConfigPath = path.join(home, "second", "openclaw.json");
      const pluginsPath = path.join(home, "first", "plugins.json5");
      const rootConfig = { plugins: { $include: "./plugins.json5" } };
      const initialPluginsRaw = `${JSON.stringify({ entries: {} }, null, 2)}\n`;
      const nextConfig = { plugins: { entries: { demo: { enabled: true } } } };
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, `${JSON.stringify(rootConfig, null, 2)}\n`, "utf-8");
      await fs.writeFile(pluginsPath, initialPluginsRaw, "utf-8");
      const snapshot = createSnapshot({
        hash: "hash-include-post-write-path-change",
        path: configPath,
        parsed: rootConfig,
        sourceConfig: { plugins: { entries: {} } },
      });
      let activeConfigPath = configPath;
      const assertConfigPathForWrite = () => {
        if (activeConfigPath !== configPath) {
          throw new ConfigMutationConflictError("config path changed since last load", {
            currentHash: null,
            retryable: false,
          });
        }
      };
      ioMocks.readConfigFileSnapshotForWrite.mockImplementation(async () => {
        if (changeKind === "active path") {
          activeConfigPath = otherConfigPath;
        }
        return {
          snapshot: createSnapshot({
            hash: "hash-include-post-write-refreshed",
            path: changeKind === "refreshed snapshot path" ? otherConfigPath : configPath,
            parsed: rootConfig,
            sourceConfig: nextConfig,
          }),
          writeOptions: { expectedConfigPath: configPath },
        };
      });

      await expect(
        replaceConfigFile({
          baseHash: snapshot.hash,
          snapshot,
          io: { ...ioMocks, env: {} },
          writeOptions: {
            expectedConfigPath: snapshot.path,
            assertConfigPathForWrite,
            includeFileTargetsForWrite: { [pluginsPath]: await resolveIncludeTarget(pluginsPath) },
          },
          nextConfig,
        }),
      ).rejects.toThrow("config path changed since last load");

      await expect(fs.readFile(pluginsPath, "utf-8")).resolves.toBe(initialPluginsRaw);
    },
  );

  it.runIf(process.platform !== "win32")(
    "does not create a missing include through a parent symlink swapped during preflight",
    async () => {
      const home = await suiteRootTracker.make("include-preflight-parent-swap");
      const outside = await suiteRootTracker.make("include-preflight-parent-swap-outside");
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      const includeDir = path.join(home, ".openclaw", "config");
      const movedIncludeDir = path.join(home, ".openclaw", "config-original");
      const pluginsPath = path.join(includeDir, "plugins.json5");
      const outsidePluginsPath = path.join(outside, "plugins.json5");
      await fs.mkdir(includeDir, { recursive: true });
      await fs.writeFile(
        configPath,
        `${JSON.stringify({ plugins: { $include: "./config/plugins.json5" } }, null, 2)}\n`,
        "utf-8",
      );
      const snapshot: ConfigFileSnapshot = {
        ...createSnapshot({
          hash: "hash-include-preflight-parent-swap",
          path: configPath,
          parsed: { plugins: { $include: "./config/plugins.json5" } },
          sourceConfig: { plugins: {} },
        }),
        valid: false,
        issues: [
          {
            path: "",
            message: `Failed to read include file: ./config/plugins.json5 (resolved: ${pluginsPath})`,
          },
        ],
      };
      ioMocks.readConfigFileSnapshotForWrite.mockResolvedValue({
        snapshot: createSnapshot({
          hash: "hash-include-preflight-parent-swap-refreshed",
          path: configPath,
          parsed: { plugins: { $include: "./config/plugins.json5" } },
          sourceConfig: { plugins: { entries: { demo: { enabled: true } } } },
        }),
        writeOptions: { expectedConfigPath: configPath },
      });

      try {
        setRuntimeConfigSnapshotRefreshHandler({
          preflight: async () => {
            await fs.rename(includeDir, movedIncludeDir);
            await fs.symlink(outside, includeDir);
          },
          refresh: () => true,
        });

        await expect(
          replaceConfigFile({
            baseHash: snapshot.hash,
            snapshot,
            writeOptions: {
              expectedConfigPath: configPath,
              includeFileHashesForWrite: { [pluginsPath]: hashConfigIncludeRaw(null) },
              assertConfigPathForWrite: allowConfigPathWrite,
              includeFileTargetsForWrite: {
                [pluginsPath]: await resolveIncludeTarget(pluginsPath),
              },
            },
            nextConfig: { plugins: { entries: { demo: { enabled: true } } } },
            io: {
              readConfigFileSnapshotForWrite: ioMocks.readConfigFileSnapshotForWrite,
              writeConfigFile: ioMocks.writeConfigFile,
            },
          }),
        ).rejects.toThrow();

        await expect(fs.stat(outsidePluginsPath)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(fs.stat(path.join(movedIncludeDir, "plugins.json5"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      } finally {
        setRuntimeConfigSnapshotRefreshHandler(null);
      }
    },
  );

  it("does not overwrite include edits made after the mutation snapshot", async () => {
    const home = await suiteRootTracker.make("include-snapshot-concurrent");
    const configPath = path.join(home, ".openclaw", "openclaw.json");
    const pluginsPath = path.join(home, ".openclaw", "config", "plugins.json5");
    await fs.mkdir(path.dirname(pluginsPath), { recursive: true });
    await fs.writeFile(
      configPath,
      `${JSON.stringify({ plugins: { $include: "./config/plugins.json5" } }, null, 2)}\n`,
      "utf-8",
    );
    const concurrentRaw = `${JSON.stringify(
      { entries: { concurrent: { enabled: true } } },
      null,
      2,
    )}\n`;
    await fs.writeFile(pluginsPath, concurrentRaw, "utf-8");
    const snapshot: ConfigFileSnapshot = {
      ...createSnapshot({
        hash: "hash-include-snapshot-concurrent",
        path: configPath,
        parsed: { plugins: { $include: "./config/plugins.json5" } },
        sourceConfig: { plugins: { entries: {} } },
      }),
      valid: false,
      issues: [{ path: "plugins.load.paths", message: "plugin path not found: /gone" }],
    };

    await expect(
      replaceConfigFile({
        baseHash: snapshot.hash,
        snapshot,
        writeOptions: {
          expectedConfigPath: snapshot.path,
          assertConfigPathForWrite: allowConfigPathWrite,
          includeFileTargetsForWrite: { [pluginsPath]: await resolveIncludeTarget(pluginsPath) },
        },
        nextConfig: {
          plugins: {
            entries: {
              demo: { enabled: true },
            },
          },
        },
      }),
    ).rejects.toBeInstanceOf(ConfigMutationConflictError);

    await expect(fs.readFile(pluginsPath, "utf-8")).resolves.toBe(concurrentRaw);
  });

  it("preflights the restored include payload with the current environment", async () => {
    const home = await suiteRootTracker.make("include-restored-preflight");
    const configPath = path.join(home, ".openclaw", "openclaw.json");
    const pluginsPath = path.join(home, ".openclaw", "config", "plugins.json5");
    await fs.mkdir(path.dirname(pluginsPath), { recursive: true });
    await fs.writeFile(
      configPath,
      `${JSON.stringify({ plugins: { $include: "./config/plugins.json5" } }, null, 2)}\n`,
      "utf-8",
    );
    const initialPluginsRaw = `${JSON.stringify(
      {
        entries: {
          old: { enabled: true, config: { token: "${OPENCLAW_TEST_INCLUDE_TOKEN}" } },
        },
      },
      null,
      2,
    )}\n`;
    await fs.writeFile(pluginsPath, initialPluginsRaw, "utf-8");
    const oldEntry = { enabled: true, config: { token: "old-token" } };
    const snapshot = createSnapshot({
      hash: "hash-include-restored-preflight",
      path: configPath,
      parsed: { plugins: { $include: "./config/plugins.json5" } },
      sourceConfig: { plugins: { entries: { old: oldEntry } } },
    });
    const observedSources: OpenClawConfig[] = [];

    try {
      setRuntimeConfigSnapshotRefreshHandler({
        preflight: ({ sourceConfig }) => {
          observedSources.push(sourceConfig);
          throw new Error("stop before write");
        },
        refresh: () => true,
      });

      await expect(
        replaceConfigFile({
          baseHash: snapshot.hash,
          snapshot,
          writeOptions: {
            expectedConfigPath: snapshot.path,
            envSnapshotForRestore: { OPENCLAW_TEST_INCLUDE_TOKEN: "old-token" },
            assertConfigPathForWrite: allowConfigPathWrite,
            includeFileTargetsForWrite: { [pluginsPath]: await resolveIncludeTarget(pluginsPath) },
          },
          nextConfig: {
            plugins: {
              entries: {
                old: oldEntry,
                demo: { enabled: true },
              },
            },
          },
          io: {
            env: { OPENCLAW_TEST_INCLUDE_TOKEN: "new-token" },
            readConfigFileSnapshotForWrite: ioMocks.readConfigFileSnapshotForWrite,
            writeConfigFile: ioMocks.writeConfigFile,
          },
        }),
      ).rejects.toThrow(/active SecretRef resolution failed: stop before write/);

      expect(observedSources[0]?.plugins?.entries?.old?.config).toEqual({ token: "new-token" });
      await expect(fs.readFile(pluginsPath, "utf-8")).resolves.toBe(initialPluginsRaw);
    } finally {
      setRuntimeConfigSnapshotRefreshHandler(null);
    }
  });

  it("does not re-substitute resolved root values during include preflight", async () => {
    const home = await suiteRootTracker.make("include-root-escaped-env");
    const configPath = path.join(home, ".openclaw", "openclaw.json");
    const pluginsPath = path.join(home, ".openclaw", "config", "plugins.json5");
    await fs.mkdir(path.dirname(pluginsPath), { recursive: true });
    await fs.writeFile(
      configPath,
      `${JSON.stringify(
        {
          gateway: { auth: { mode: "token", token: "$${ROOT_LITERAL_TOKEN}" } },
          plugins: { $include: "./config/plugins.json5" },
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
    await fs.writeFile(pluginsPath, `${JSON.stringify({ entries: {} }, null, 2)}\n`, "utf-8");
    const snapshot = createSnapshot({
      hash: "hash-include-root-escaped-env",
      path: configPath,
      parsed: {
        gateway: { auth: { mode: "token", token: "$${ROOT_LITERAL_TOKEN}" } },
        plugins: { $include: "./config/plugins.json5" },
      },
      sourceConfig: {
        gateway: { auth: { mode: "token", token: "${ROOT_LITERAL_TOKEN}" } },
        plugins: { entries: {} },
      },
    });
    const observedSources: OpenClawConfig[] = [];

    try {
      setRuntimeConfigSnapshotRefreshHandler({
        preflight: ({ sourceConfig }) => {
          observedSources.push(sourceConfig);
          throw new Error("stop before write");
        },
        refresh: () => true,
      });

      await expect(
        replaceConfigFile({
          baseHash: snapshot.hash,
          snapshot,
          writeOptions: {
            expectedConfigPath: snapshot.path,
            assertConfigPathForWrite: allowConfigPathWrite,
            includeFileTargetsForWrite: { [pluginsPath]: await resolveIncludeTarget(pluginsPath) },
          },
          nextConfig: {
            gateway: { auth: { mode: "token", token: "${ROOT_LITERAL_TOKEN}" } },
            plugins: { entries: { demo: { enabled: true } } },
          },
          io: {
            env: { ROOT_LITERAL_TOKEN: "secret" },
            readConfigFileSnapshotForWrite: ioMocks.readConfigFileSnapshotForWrite,
            writeConfigFile: ioMocks.writeConfigFile,
          },
        }),
      ).rejects.toThrow(/active SecretRef resolution failed: stop before write/);

      expect(observedSources[0]?.gateway?.auth?.token).toBe("${ROOT_LITERAL_TOKEN}");
    } finally {
      setRuntimeConfigSnapshotRefreshHandler(null);
    }
  });

  it("preserves unresolved optional env refs during include write-through", async () => {
    const home = await suiteRootTracker.make("include-unresolved-env");
    const configPath = path.join(home, ".openclaw", "openclaw.json");
    const pluginsPath = path.join(home, ".openclaw", "config", "plugins.json5");
    await fs.mkdir(path.dirname(pluginsPath), { recursive: true });
    await fs.writeFile(
      configPath,
      `${JSON.stringify({ plugins: { $include: "./config/plugins.json5" } }, null, 2)}\n`,
      "utf-8",
    );
    await fs.writeFile(
      pluginsPath,
      `${JSON.stringify(
        {
          entries: {
            old: { enabled: true, config: { token: "${OPTIONAL_TOKEN}" } },
          },
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
    const oldEntry = { enabled: true, config: { token: "${OPTIONAL_TOKEN}" } };
    const snapshot = createSnapshot({
      hash: "hash-include-unresolved-env",
      path: configPath,
      parsed: { plugins: { $include: "./config/plugins.json5" } },
      sourceConfig: { plugins: { entries: { old: oldEntry } } },
    });

    await replaceConfigFile({
      baseHash: snapshot.hash,
      snapshot,
      writeOptions: {
        expectedConfigPath: snapshot.path,
        envSnapshotForRestore: {},
        assertConfigPathForWrite: allowConfigPathWrite,
        includeFileTargetsForWrite: { [pluginsPath]: await resolveIncludeTarget(pluginsPath) },
        skipRuntimeSnapshotRefresh: true,
      },
      nextConfig: {
        plugins: {
          entries: {
            old: oldEntry,
            demo: { enabled: true },
          },
        },
      },
      io: {
        env: {},
        readConfigFileSnapshotForWrite: ioMocks.readConfigFileSnapshotForWrite,
        writeConfigFile: ioMocks.writeConfigFile,
      },
    });

    const persisted = JSON.parse(await fs.readFile(pluginsPath, "utf-8")) as {
      entries?: Record<string, { config?: { token?: string } }>;
    };
    expect(persisted.entries?.old?.config?.token).toBe("${OPTIONAL_TOKEN}");
    expect(persisted.entries?.demo).toEqual({ enabled: true });
  });

  it("rolls back single-file top-level include writes when runtime refresh fails", async () => {
    const home = await suiteRootTracker.make("include-runtime-refresh-rollback");
    const configPath = path.join(home, ".openclaw", "openclaw.json");
    const pluginsPath = path.join(home, ".openclaw", "config", "plugins.json5");
    const env = {} as NodeJS.ProcessEnv;
    const envKey = "OPENCLAW_TEST_INCLUDE_ROLLBACK_ENV";
    await fs.mkdir(path.dirname(pluginsPath), { recursive: true });
    await fs.writeFile(
      configPath,
      `${JSON.stringify({ plugins: { $include: "./config/plugins.json5" } }, null, 2)}\n`,
      "utf-8",
    );
    const initialPluginsRaw = `${JSON.stringify({ entries: {} }, null, 2)}\n`;
    await fs.writeFile(pluginsPath, initialPluginsRaw, "utf-8");
    const snapshot = createSnapshot({
      hash: "hash-include-refresh-rollback",
      path: configPath,
      parsed: { plugins: { $include: "./config/plugins.json5" } },
      sourceConfig: { plugins: { entries: {} } },
    });
    const nextConfig = {
      plugins: {
        entries: {
          demo: { enabled: true },
        },
      },
    };
    ioMocks.readConfigFileSnapshotForWrite.mockImplementation(async () => {
      env[envKey] = "written-env-value";
      return {
        snapshot: createSnapshot({
          hash: "hash-include-refresh-written",
          path: configPath,
          parsed: { plugins: { $include: "./config/plugins.json5" } },
          sourceConfig: nextConfig,
        }),
        writeOptions: { expectedConfigPath: configPath },
      };
    });

    try {
      delete env[envKey];
      setRuntimeConfigSnapshotRefreshHandler({
        preflight: () => true,
        refresh: () => {
          throw new Error("lost include secret");
        },
      });

      await expect(
        replaceConfigFile({
          baseHash: snapshot.hash,
          snapshot,
          io: { ...ioMocks, env },
          writeOptions: {
            expectedConfigPath: snapshot.path,
            assertConfigPathForWrite: allowConfigPathWrite,
            includeFileTargetsForWrite: { [pluginsPath]: await resolveIncludeTarget(pluginsPath) },
          },
          nextConfig,
        }),
      ).rejects.toThrow(/runtime snapshot refresh failed: lost include secret/);

      await expect(fs.readFile(pluginsPath, "utf-8")).resolves.toBe(initialPluginsRaw);
      expect(env[envKey]).toBeUndefined();
    } finally {
      setRuntimeConfigSnapshotRefreshHandler(null);
      delete env[envKey];
    }
  });

  it("does not overwrite concurrent include edits during failed refresh rollback", async () => {
    const home = await suiteRootTracker.make("include-runtime-refresh-concurrent");
    const configPath = path.join(home, ".openclaw", "openclaw.json");
    const pluginsPath = path.join(home, ".openclaw", "config", "plugins.json5");
    await fs.mkdir(path.dirname(pluginsPath), { recursive: true });
    await fs.writeFile(
      configPath,
      `${JSON.stringify({ plugins: { $include: "./config/plugins.json5" } }, null, 2)}\n`,
      "utf-8",
    );
    await fs.writeFile(pluginsPath, `${JSON.stringify({ entries: {} }, null, 2)}\n`, "utf-8");
    const concurrentPluginsRaw = `${JSON.stringify(
      { entries: { concurrent: { enabled: true } } },
      null,
      2,
    )}\n`;
    const snapshot = createSnapshot({
      hash: "hash-include-refresh-concurrent",
      path: configPath,
      parsed: { plugins: { $include: "./config/plugins.json5" } },
      sourceConfig: { plugins: { entries: {} } },
    });
    const nextConfig = {
      plugins: {
        entries: {
          demo: { enabled: true },
        },
      },
    };
    ioMocks.readConfigFileSnapshotForWrite.mockResolvedValue({
      snapshot: createSnapshot({
        hash: "hash-include-refresh-concurrent-written",
        path: configPath,
        parsed: { plugins: { $include: "./config/plugins.json5" } },
        sourceConfig: nextConfig,
      }),
      writeOptions: { expectedConfigPath: configPath },
    });

    try {
      setRuntimeConfigSnapshotRefreshHandler({
        preflight: () => true,
        refresh: async () => {
          await fs.writeFile(pluginsPath, concurrentPluginsRaw, "utf-8");
          throw new Error("lost include secret");
        },
      });

      await expect(
        replaceConfigFile({
          baseHash: snapshot.hash,
          snapshot,
          writeOptions: {
            expectedConfigPath: snapshot.path,
            assertConfigPathForWrite: allowConfigPathWrite,
            includeFileTargetsForWrite: { [pluginsPath]: await resolveIncludeTarget(pluginsPath) },
          },
          nextConfig,
        }),
      ).rejects.toThrow(/runtime snapshot refresh failed: lost include secret/);

      await expect(fs.readFile(pluginsPath, "utf-8")).resolves.toBe(concurrentPluginsRaw);
    } finally {
      setRuntimeConfigSnapshotRefreshHandler(null);
    }
  });

  it("rejects invalid base config before skipped-plugin include writes", async () => {
    const home = await suiteRootTracker.make("include-skip-invalid-base");
    const configPath = path.join(home, ".openclaw", "openclaw.json");
    const pluginsPath = path.join(home, ".openclaw", "config", "plugins.json5");
    await fs.mkdir(path.dirname(pluginsPath), { recursive: true });
    await fs.writeFile(
      configPath,
      `${JSON.stringify({ plugins: { $include: "./config/plugins.json5" } }, null, 2)}\n`,
      "utf-8",
    );
    await fs.writeFile(
      pluginsPath,
      `${JSON.stringify({ entries: { old: { enabled: true } } }, null, 2)}\n`,
      "utf-8",
    );
    const snapshot = createSnapshot({
      hash: "hash-include-invalid-base",
      path: configPath,
      parsed: { plugins: { $include: "./config/plugins.json5" } },
      sourceConfig: { plugins: { entries: { old: { enabled: true } } } },
    });
    const nextConfig = {
      plugins: {
        entries: {
          "strict-plugin": { enabled: "yes" },
        },
      },
    } as unknown as OpenClawConfig;
    validationMocks.validateConfigObjectWithPlugins.mockReturnValue({
      ok: false,
      issues: [
        {
          path: "plugins.entries.strict-plugin.enabled",
          message: "Expected boolean",
        },
      ],
      warnings: [],
    });

    await expect(
      replaceConfigFile({
        baseHash: snapshot.hash,
        snapshot,
        writeOptions: {
          expectedConfigPath: snapshot.path,
          assertConfigPathForWrite: allowConfigPathWrite,
          includeFileTargetsForWrite: { [pluginsPath]: await resolveIncludeTarget(pluginsPath) },
          skipPluginValidation: true,
        },
        nextConfig,
      }),
    ).rejects.toThrow("plugins.entries.strict-plugin.enabled: Expected boolean");

    expect(ioMocks.writeConfigFile).not.toHaveBeenCalled();
    expect(ioMocks.readConfigFileSnapshotForWrite).not.toHaveBeenCalled();
    const persistedPlugins = JSON.parse(await fs.readFile(pluginsPath, "utf-8")) as {
      entries?: Record<string, unknown>;
    };
    expect(persistedPlugins.entries).toEqual({ old: { enabled: true } });
  });

  it("falls back to the root writer when a plugins include write is not isolated", async () => {
    const snapshot = createSnapshot({
      hash: "hash-multi",
      path: "/tmp/openclaw.json",
      parsed: { plugins: { $include: "./config/plugins.json5" }, gateway: { mode: "local" } },
      sourceConfig: {
        gateway: { mode: "local" },
        plugins: { entries: {} },
      },
    });
    ioMocks.readConfigFileSnapshotForWrite.mockResolvedValue({
      snapshot,
      writeOptions: { expectedConfigPath: snapshot.path },
    });

    await replaceConfigFile({
      snapshot,
      writeOptions: { expectedConfigPath: snapshot.path },
      nextConfig: {
        gateway: { mode: "local", port: 18789 },
        plugins: { entries: { demo: { enabled: true } } },
      },
    });

    expect(ioMocks.writeConfigFile).toHaveBeenCalledWith(
      {
        gateway: { mode: "local", port: 18789 },
        plugins: { entries: { demo: { enabled: true } } },
      },
      {
        baseSnapshot: snapshot,
        expectedConfigPath: snapshot.path,
        afterWrite: { mode: "auto" },
      },
    );
  });

  it("preflights injected root writers before persisting", async () => {
    const home = await suiteRootTracker.make("injected-root-runtime-preflight");
    const configPath = path.join(home, ".openclaw", "openclaw.json");
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    const initialConfig = { gateway: { mode: "local" } } satisfies OpenClawConfig;
    const initialRaw = `${JSON.stringify(initialConfig, null, 2)}\n`;
    await fs.writeFile(configPath, initialRaw, "utf-8");
    const snapshot = createSnapshot({
      hash: "hash-injected-root",
      path: configPath,
      sourceConfig: initialConfig,
    });
    const nextConfig = {
      gateway: {
        mode: "local",
        auth: {
          mode: "token",
          token: { source: "exec", provider: "execmain", id: "gateway/token" },
        },
      },
    } as OpenClawConfig;
    const injectedWrite = vi.fn(async (config: OpenClawConfig, options?: ConfigWriteOptions) => {
      await options?.preCommitRuntimePreflight?.(config);
      await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
      return { persistedHash: "hash-written", persistedConfig: config };
    });

    try {
      setRuntimeConfigSnapshotRefreshHandler({
        preflight: () => {
          throw new Error("missing root secret");
        },
        refresh: () => true,
      });

      await expect(
        replaceConfigFile({
          snapshot,
          baseHash: snapshot.hash,
          writeOptions: { expectedConfigPath: snapshot.path },
          nextConfig,
          io: {
            readConfigFileSnapshotForWrite: vi.fn(),
            writeConfigFile: injectedWrite,
          },
        }),
      ).rejects.toThrow(/active SecretRef resolution failed: missing root secret/);

      expect(injectedWrite).toHaveBeenCalledTimes(1);
      expect(injectedWrite.mock.calls[0]?.[1]?.preCommitRuntimePreflight).toEqual(
        expect.any(Function),
      );
      await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(initialRaw);
    } finally {
      setRuntimeConfigSnapshotRefreshHandler(null);
    }
  });
});
