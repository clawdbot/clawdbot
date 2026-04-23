import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { ConfigMutationConflictError, mutateConfigFile, replaceConfigFile } from "./mutate.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "./types.js";

const ioMocks = vi.hoisted(() => ({
  readConfigFileSnapshotForWrite: vi.fn(),
  resolveConfigSnapshotHash: vi.fn(),
  writeConfigFile: vi.fn(),
}));

vi.mock("./io.js", () => ioMocks);

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
  return {
    path: params.path ?? "/tmp/openclaw.json",
    exists: true,
    raw: "{}",
    parsed: params.parsed ?? params.sourceConfig,
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

describe("config mutate helpers", () => {
  const suiteRootTracker = createSuiteTempRootTracker({ prefix: "openclaw-config-mutate-" });

  beforeAll(async () => {
    await suiteRootTracker.setup();
  });

  afterAll(async () => {
    await suiteRootTracker.cleanup();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    ioMocks.resolveConfigSnapshotHash.mockImplementation(
      (snapshot: { hash?: string }) => snapshot.hash ?? null,
    );
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
    expect(ioMocks.writeConfigFile).toHaveBeenCalledWith(
      {
        gateway: {
          port: 18789,
          auth: { mode: "token" },
        },
      },
      { expectedConfigPath: snapshot.path },
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
      },
    );
  });

  it("writes through a single-file top-level plugins include", async () => {
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
      `${JSON.stringify({ entries: { old: { enabled: true } } }, null, 2)}\n`,
      "utf-8",
    );
    const snapshot = createSnapshot({
      hash: "hash-include",
      path: configPath,
      parsed: { plugins: { $include: "./config/plugins.json5" } },
      sourceConfig: {
        plugins: {
          entries: { old: { enabled: true } },
        },
      },
    });

    await replaceConfigFile({
      baseHash: snapshot.hash,
      snapshot,
      writeOptions: { expectedConfigPath: snapshot.path },
      nextConfig: {
        plugins: {
          entries: {
            old: { enabled: true },
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
    });

    expect(ioMocks.writeConfigFile).not.toHaveBeenCalled();
    await expect(fs.readFile(configPath, "utf-8")).resolves.toContain(
      '"$include": "./config/plugins.json5"',
    );
    await expect(fs.readFile(`${pluginsPath}.bak`, "utf-8")).resolves.toContain('"old"');
    const persistedPlugins = JSON.parse(await fs.readFile(pluginsPath, "utf-8")) as {
      entries?: Record<string, unknown>;
      installs?: Record<string, unknown>;
    };
    expect(persistedPlugins.entries?.demo).toEqual({ enabled: true });
    expect(persistedPlugins.installs?.demo).toMatchObject({ source: "npm", spec: "demo" });
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
      },
    );
  });
});
