// Memory Wiki tests cover source sync plugin behavior.
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../api.js";
import { resolveMemoryWikiConfig } from "./config.js";
import { withMemoryWikiVaultMutation } from "./mutation-coordinator.js";
import { syncMemoryWikiImportedSources } from "./source-sync.js";

const { syncBridgeMock, syncUnsafeLocalMock, refreshIndexesMock } = vi.hoisted(() => ({
  syncBridgeMock: vi.fn(),
  syncUnsafeLocalMock: vi.fn(),
  refreshIndexesMock: vi.fn(),
}));

vi.mock("./bridge.js", () => ({
  syncMemoryWikiBridgeSources: syncBridgeMock,
}));

vi.mock("./unsafe-local.js", () => ({
  syncMemoryWikiUnsafeLocalSources: syncUnsafeLocalMock,
}));

vi.mock("./compile.js", () => ({
  refreshMemoryWikiIndexesAfterImport: refreshIndexesMock,
}));

const bridgeResult = {
  importedCount: 1,
  updatedCount: 2,
  skippedCount: 3,
  removedCount: 4,
  artifactCount: 10,
  workspaces: 2,
  pagePaths: ["sources/alpha.md"],
};

const refreshResult = {
  refreshed: true,
  reason: "import-changed" as const,
  compile: { updatedFiles: ["index.md", "sources/index.md"] },
};

const appConfig = {
  agents: { list: [{ id: "main", default: true }] },
} as OpenClawConfig;

let vaultCounter = 0;

function createConfig(
  vaultMode: "bridge" | "unsafe-local" | "isolated" = "bridge",
  vaultPath = path.join(os.tmpdir(), `memory-wiki-source-sync-${vaultCounter++}`),
) {
  return resolveMemoryWikiConfig({ vaultMode, vault: { path: vaultPath } });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("syncMemoryWikiImportedSources", () => {
  beforeEach(() => {
    syncBridgeMock.mockReset();
    syncUnsafeLocalMock.mockReset();
    refreshIndexesMock.mockReset();
    syncBridgeMock.mockResolvedValue(bridgeResult);
    syncUnsafeLocalMock.mockResolvedValue({
      ...bridgeResult,
      workspaces: 0,
    });
    refreshIndexesMock.mockResolvedValue(refreshResult);
  });

  it("routes bridge mode through bridge sync and merges refresh results", async () => {
    const config = createConfig();

    const result = await syncMemoryWikiImportedSources({ config, appConfig });

    expect(syncBridgeMock).toHaveBeenCalledWith({ config, appConfig });
    expect(syncUnsafeLocalMock).not.toHaveBeenCalled();
    expect(refreshIndexesMock).toHaveBeenCalledWith({
      config,
      syncResult: bridgeResult,
    });
    expect(result).toEqual({
      ...bridgeResult,
      indexesRefreshed: true,
      indexRefreshReason: "import-changed",
      indexUpdatedFiles: ["index.md", "sources/index.md"],
    });
  });

  it("shares one full source and index flight across equivalent polls", async () => {
    const config = createConfig();
    const bridgeGate = deferred<typeof bridgeResult>();
    syncBridgeMock.mockReturnValueOnce(bridgeGate.promise);

    const requests = Array.from({ length: 32 }, () =>
      syncMemoryWikiImportedSources({ config, appConfig }),
    );
    await vi.waitFor(() => expect(syncBridgeMock).toHaveBeenCalledTimes(1));

    bridgeGate.resolve(bridgeResult);
    const results = await Promise.all(requests);

    expect(refreshIndexesMock).toHaveBeenCalledTimes(1);
    expect(results.every((result) => result === results[0])).toBe(true);
  });

  it("coalesces separately resolved equivalent configs for one vault", async () => {
    const vaultPath = path.join(os.tmpdir(), `memory-wiki-source-sync-${vaultCounter++}`);
    const firstConfig = createConfig("bridge", vaultPath);
    const secondConfig = createConfig("bridge", vaultPath);
    const bridgeGate = deferred<typeof bridgeResult>();
    syncBridgeMock.mockReturnValueOnce(bridgeGate.promise);

    const first = syncMemoryWikiImportedSources({ config: firstConfig, appConfig });
    await vi.waitFor(() => expect(syncBridgeMock).toHaveBeenCalledTimes(1));
    const second = syncMemoryWikiImportedSources({ config: secondConfig, appConfig });
    await Promise.resolve();

    expect(syncBridgeMock).toHaveBeenCalledTimes(1);
    bridgeGate.resolve(bridgeResult);
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(refreshIndexesMock).toHaveBeenCalledTimes(1);
    expect(secondResult).toBe(firstResult);
  });

  it("keeps sharing the active flight while indexes refresh", async () => {
    const config = createConfig();
    const refreshGate = deferred<typeof refreshResult>();
    refreshIndexesMock.mockReturnValueOnce(refreshGate.promise);

    const first = syncMemoryWikiImportedSources({ config, appConfig });
    await vi.waitFor(() => expect(refreshIndexesMock).toHaveBeenCalledTimes(1));
    const followers = Array.from({ length: 32 }, () =>
      syncMemoryWikiImportedSources({ config, appConfig }),
    );
    await Promise.resolve();

    expect(syncBridgeMock).toHaveBeenCalledTimes(1);
    expect(refreshIndexesMock).toHaveBeenCalledTimes(1);
    refreshGate.resolve(refreshResult);
    const [firstResult, ...followerResults] = await Promise.all([first, ...followers]);
    expect(followerResults.every((result) => result === firstResult)).toBe(true);
  });

  it("clears completed flights so later polls observe new source state", async () => {
    const config = createConfig();
    const secondResult = { ...bridgeResult, updatedCount: 3 };
    syncBridgeMock.mockResolvedValueOnce(bridgeResult).mockResolvedValueOnce(secondResult);

    await syncMemoryWikiImportedSources({ config, appConfig });
    await expect(syncMemoryWikiImportedSources({ config, appConfig })).resolves.toMatchObject({
      updatedCount: 3,
    });

    expect(syncBridgeMock).toHaveBeenCalledTimes(2);
    expect(refreshIndexesMock).toHaveBeenCalledTimes(2);
  });

  it("waits for an existing vault mutation before starting source sync", async () => {
    const config = createConfig();
    const blockerEntered = deferred<void>();
    const blockerGate = deferred<void>();
    const blocker = withMemoryWikiVaultMutation(config.vault.path, async () => {
      blockerEntered.resolve(undefined);
      await blockerGate.promise;
    });
    await blockerEntered.promise;

    const sync = syncMemoryWikiImportedSources({ config, appConfig });
    await Promise.resolve();
    expect(syncBridgeMock).not.toHaveBeenCalled();

    blockerGate.resolve(undefined);
    await blocker;
    await sync;
    expect(syncBridgeMock).toHaveBeenCalledTimes(1);
  });

  it("serializes different config snapshots for the same vault", async () => {
    const config = createConfig();
    const firstAppConfig = {
      agents: { list: [{ id: "main", default: true }] },
      update: { channel: "stable" },
    } as OpenClawConfig;
    const secondAppConfig = {
      agents: { list: [{ id: "main", default: true }] },
      update: { channel: "beta" },
    } as OpenClawConfig;
    const firstGate = deferred<typeof bridgeResult>();
    const secondResult = { ...bridgeResult, pagePaths: ["sources/beta.md"] };
    syncBridgeMock.mockReturnValueOnce(firstGate.promise).mockResolvedValueOnce(secondResult);

    const first = syncMemoryWikiImportedSources({ config, appConfig: firstAppConfig });
    await vi.waitFor(() => expect(syncBridgeMock).toHaveBeenCalledTimes(1));
    const second = syncMemoryWikiImportedSources({ config, appConfig: secondAppConfig });
    await Promise.resolve();
    expect(syncBridgeMock).toHaveBeenCalledTimes(1);

    firstGate.resolve(bridgeResult);
    await first;
    await vi.waitFor(() => expect(syncBridgeMock).toHaveBeenCalledTimes(2));
    await expect(second).resolves.toMatchObject({ pagePaths: ["sources/beta.md"] });
    expect(refreshIndexesMock).toHaveBeenCalledTimes(2);
  });

  it("serializes bridge and unsafe-local syncs for one vault", async () => {
    const vaultPath = path.join(os.tmpdir(), `memory-wiki-source-sync-${vaultCounter++}`);
    const bridgeConfig = createConfig("bridge", vaultPath);
    const unsafeConfig = createConfig("unsafe-local", vaultPath);
    const bridgeGate = deferred<typeof bridgeResult>();
    syncBridgeMock.mockReturnValueOnce(bridgeGate.promise);

    const bridge = syncMemoryWikiImportedSources({ config: bridgeConfig, appConfig });
    await vi.waitFor(() => expect(syncBridgeMock).toHaveBeenCalledTimes(1));
    const unsafe = syncMemoryWikiImportedSources({ config: unsafeConfig, appConfig });
    await Promise.resolve();
    expect(syncUnsafeLocalMock).not.toHaveBeenCalled();

    bridgeGate.resolve(bridgeResult);
    await bridge;
    await vi.waitFor(() => expect(syncUnsafeLocalMock).toHaveBeenCalledTimes(1));
    await unsafe;
    expect(refreshIndexesMock).toHaveBeenCalledTimes(2);
  });

  it("allows different agent vaults to sync in parallel", async () => {
    const firstConfig = createConfig();
    const secondConfig = createConfig();
    const firstGate = deferred<typeof bridgeResult>();
    const secondResult = { ...bridgeResult, pagePaths: ["sources/other.md"] };
    syncBridgeMock.mockReturnValueOnce(firstGate.promise).mockResolvedValueOnce(secondResult);

    const first = syncMemoryWikiImportedSources({ config: firstConfig, appConfig });
    await vi.waitFor(() => expect(syncBridgeMock).toHaveBeenCalledTimes(1));
    const second = syncMemoryWikiImportedSources({ config: secondConfig, appConfig });
    await vi.waitFor(() => expect(syncBridgeMock).toHaveBeenCalledTimes(2));

    await expect(second).resolves.toMatchObject({ pagePaths: ["sources/other.md"] });
    firstGate.resolve(bridgeResult);
    await first;
  });

  it("clears failed flights so a later sync can retry", async () => {
    const config = createConfig();
    syncBridgeMock.mockRejectedValueOnce(new Error("bridge unavailable"));

    await expect(syncMemoryWikiImportedSources({ config, appConfig })).rejects.toThrow(
      "bridge unavailable",
    );
    await expect(syncMemoryWikiImportedSources({ config, appConfig })).resolves.toMatchObject({
      pagePaths: bridgeResult.pagePaths,
    });
    expect(syncBridgeMock).toHaveBeenCalledTimes(2);
  });

  it("routes unsafe-local mode through unsafe-local sync", async () => {
    const unsafeLocalResult = {
      ...bridgeResult,
      importedCount: 2,
      workspaces: 0,
      pagePaths: ["sources/private.md"],
    };
    syncUnsafeLocalMock.mockResolvedValueOnce(unsafeLocalResult);
    refreshIndexesMock.mockResolvedValueOnce({
      refreshed: false,
      reason: "auto-compile-disabled",
    });
    const config = createConfig("unsafe-local");

    const result = await syncMemoryWikiImportedSources({ config });

    expect(syncUnsafeLocalMock).toHaveBeenCalledWith(config);
    expect(syncBridgeMock).not.toHaveBeenCalled();
    expect(refreshIndexesMock).toHaveBeenCalledWith({
      config,
      syncResult: unsafeLocalResult,
    });
    expect(result).toEqual({
      ...unsafeLocalResult,
      indexesRefreshed: false,
      indexRefreshReason: "auto-compile-disabled",
      indexUpdatedFiles: [],
    });
  });

  it("returns a no-op sync result outside imported-source modes", async () => {
    const config = createConfig("isolated");

    const result = await syncMemoryWikiImportedSources({ config });

    expect(syncBridgeMock).not.toHaveBeenCalled();
    expect(syncUnsafeLocalMock).not.toHaveBeenCalled();
    expect(refreshIndexesMock).toHaveBeenCalledWith({
      config,
      syncResult: {
        importedCount: 0,
        updatedCount: 0,
        skippedCount: 0,
        removedCount: 0,
        artifactCount: 0,
        workspaces: 0,
        pagePaths: [],
      },
    });
    expect(result).toEqual({
      importedCount: 0,
      updatedCount: 0,
      skippedCount: 0,
      removedCount: 0,
      artifactCount: 0,
      workspaces: 0,
      pagePaths: [],
      indexesRefreshed: true,
      indexRefreshReason: "import-changed",
      indexUpdatedFiles: ["index.md", "sources/index.md"],
    });
  });
});
