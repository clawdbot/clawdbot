import { beforeEach, describe, expect, it, vi } from "vitest";
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
    parsed: params.sourceConfig,
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
});
