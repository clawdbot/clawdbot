// Verifies runtime config snapshots preserve normalized public settings.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  finalizeRuntimeSnapshotWrite,
  getRuntimeConfigAppliedHash,
  hashRuntimeConfigValue,
  hasManagedRuntimeConfigWriteOwner,
  getRuntimeConfigSnapshotMetadata,
  getRuntimeConfigSourceSnapshot,
  getRuntimeConfigSnapshot,
  preflightManagedRuntimeConfigWrite,
  loadPinnedRuntimeConfig,
  notifyRuntimeConfigWriteListeners,
  registerRuntimeConfigWriteListener,
  registerManagedRuntimeConfigWriteOwner,
  resetConfigRuntimeState,
  resolveRuntimeConfigCacheKey,
  selectApplicableRuntimeConfig,
  setRuntimeConfigSnapshot,
  setRuntimeConfigAppliedHash,
  setRuntimeConfigSnapshotRefreshHandler,
} from "./runtime-snapshot.js";
import type { OpenClawConfig } from "./types.js";

function resetRuntimeConfigState(): void {
  setRuntimeConfigSnapshotRefreshHandler(null);
  resetConfigRuntimeState();
}

describe("runtime snapshot state", () => {
  afterEach(() => {
    resetRuntimeConfigState();
  });

  it("pins the first successful load in memory until the snapshot is cleared", () => {
    let freshPort = 18789;
    let loadCount = 0;
    const loadFresh = (): OpenClawConfig => {
      loadCount += 1;
      return { gateway: { port: freshPort } };
    };

    expect(loadPinnedRuntimeConfig(loadFresh).gateway?.port).toBe(18789);
    expect(loadCount).toBe(1);

    freshPort = 19001;
    expect(loadPinnedRuntimeConfig(loadFresh).gateway?.port).toBe(18789);
    expect(loadCount).toBe(1);

    resetRuntimeConfigState();
    expect(loadPinnedRuntimeConfig(loadFresh).gateway?.port).toBe(19001);
    expect(loadCount).toBe(2);
  });

  it("returns the source snapshot when runtime snapshot is active", () => {
    const sourceConfig: OpenClawConfig = {
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
            models: [],
          },
        },
      },
    };
    const runtimeConfig: OpenClawConfig = {
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            apiKey: "sk-runtime-resolved",
            models: [],
          },
        },
      },
    };

    setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);
    expect(getRuntimeConfigSourceSnapshot()).toEqual(sourceConfig);
  });

  it("tracks snapshot metadata and cache keys across runtime refreshes", () => {
    const firstConfig: OpenClawConfig = { gateway: { port: 18789 } };
    const secondConfig: OpenClawConfig = { gateway: { port: 19001 } };

    setRuntimeConfigSnapshot(firstConfig);
    const firstMetadata = getRuntimeConfigSnapshotMetadata();
    expect(firstMetadata?.revision).toBe(1);
    expect(resolveRuntimeConfigCacheKey(firstConfig)).toBe(
      `runtime:${firstMetadata?.revision}:${firstMetadata?.fingerprint}`,
    );

    setRuntimeConfigSnapshot(secondConfig);
    const secondMetadata = getRuntimeConfigSnapshotMetadata();
    expect(secondMetadata?.revision).toBe(2);
    expect(secondMetadata?.fingerprint).not.toBe(firstMetadata?.fingerprint);
    expect(resolveRuntimeConfigCacheKey(secondConfig)).toBe(
      `runtime:${secondMetadata?.revision}:${secondMetadata?.fingerprint}`,
    );
  });

  it("tracks the applied source revision independently from runtime fingerprints", () => {
    expect(getRuntimeConfigAppliedHash()).toBeNull();

    setRuntimeConfigAppliedHash("disk-hash-1");
    setRuntimeConfigSnapshot({ gateway: { port: 18789 } });
    expect(getRuntimeConfigAppliedHash()).toBe("disk-hash-1");

    resetConfigRuntimeState();
    expect(getRuntimeConfigAppliedHash()).toBeNull();
  });

  it("hashes resolved source content independently from root-file revision metadata", () => {
    const first = hashRuntimeConfigValue({ logging: { level: "info" } });
    const second = hashRuntimeConfigValue({ logging: { level: "debug" } });

    expect(first).not.toBe(second);
    expect(hashRuntimeConfigValue({ logging: { level: "info" } })).toBe(first);
  });

  it("selects runtime config only when input still matches the runtime source", () => {
    const sourceConfig: OpenClawConfig = {
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
            models: [],
          },
        },
      },
    };
    const runtimeConfig: OpenClawConfig = {
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            apiKey: "sk-runtime-resolved",
            models: [],
          },
        },
      },
    };
    const scopedResolvedConfig: OpenClawConfig = {
      ...runtimeConfig,
      tools: {
        experimental: {
          planTool: true,
        },
      },
    };

    expect(
      selectApplicableRuntimeConfig({
        inputConfig: structuredClone(sourceConfig),
        runtimeConfig,
        runtimeSourceConfig: sourceConfig,
      }),
    ).toBe(runtimeConfig);
    expect(
      selectApplicableRuntimeConfig({
        inputConfig: scopedResolvedConfig,
        runtimeConfig,
        runtimeSourceConfig: sourceConfig,
      }),
    ).toBe(scopedResolvedConfig);
  });

  it("clears runtime source snapshot when runtime snapshot is cleared", () => {
    setRuntimeConfigSnapshot({ gateway: { port: 18789 } }, { gateway: { port: 18789 } });
    resetRuntimeConfigState();
    expect(getRuntimeConfigSnapshot()).toBeNull();
    expect(getRuntimeConfigSourceSnapshot()).toBeNull();
    expect(getRuntimeConfigSnapshotMetadata()).toBeNull();
  });

  it("refreshes both snapshots from disk after a write when source + runtime snapshots exist", async () => {
    const notifyCommittedWrite = vi.fn();
    const loadFreshConfig = vi.fn<() => OpenClawConfig>(() => ({
      gateway: { auth: { mode: "token" } },
    }));
    const nextSourceConfig: OpenClawConfig = {
      gateway: { auth: { mode: "token" } },
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
            models: [],
          },
        },
      },
    };

    setRuntimeConfigSnapshot(
      {
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
      nextSourceConfig,
    );

    await finalizeRuntimeSnapshotWrite({
      nextSourceConfig,
      hadRuntimeSnapshot: true,
      hadBothSnapshots: true,
      loadFreshConfig,
      notifyCommittedWrite,
      formatRefreshError: (error) => String(error),
      createRefreshError: (detail, cause) => new Error(detail, { cause }),
    });

    expect(loadFreshConfig).toHaveBeenCalledTimes(1);
    expect(getRuntimeConfigSnapshot()).toEqual({ gateway: { auth: { mode: "token" } } });
    expect(getRuntimeConfigSourceSnapshot()).toEqual(nextSourceConfig);
    expect(notifyCommittedWrite).toHaveBeenCalledTimes(1);
  });

  it("refreshes a plain runtime snapshot after writes without restoring a source snapshot", async () => {
    const notifyCommittedWrite = vi.fn();
    const loadFreshConfig = vi.fn(() => ({ gateway: { port: 19002 } }));

    setRuntimeConfigSnapshot({ gateway: { port: 18789 } });

    await finalizeRuntimeSnapshotWrite({
      nextSourceConfig: { gateway: { port: 19002 } },
      hadRuntimeSnapshot: true,
      hadBothSnapshots: false,
      loadFreshConfig,
      notifyCommittedWrite,
      formatRefreshError: (error) => String(error),
      createRefreshError: (detail, cause) => new Error(detail, { cause }),
    });

    expect(loadFreshConfig).toHaveBeenCalledTimes(1);
    expect(getRuntimeConfigSnapshot()).toEqual({ gateway: { port: 19002 } });
    expect(getRuntimeConfigSourceSnapshot()).toBeNull();
    expect(notifyCommittedWrite).toHaveBeenCalledTimes(1);
  });

  it("keeps the last-known-good runtime snapshot active while specialized refresh is pending", async () => {
    const notifyCommittedWrite = vi.fn();
    const loadFreshConfig = vi.fn<() => OpenClawConfig>(() => ({
      gateway: { auth: { mode: "token" } },
    }));
    let releaseRefresh: (() => void) | undefined;
    const refreshPending = new Promise<boolean>((resolve) => {
      releaseRefresh = () => resolve(true);
    });

    setRuntimeConfigSnapshot(
      {
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
    setRuntimeConfigSnapshotRefreshHandler({
      refresh: async ({ sourceConfig }) => {
        expect(sourceConfig.gateway?.auth).toEqual({ mode: "token" });
        expect(getRuntimeConfigSnapshot()?.gateway?.auth).toBeUndefined();
        return await refreshPending;
      },
    });

    const writePromise = finalizeRuntimeSnapshotWrite({
      nextSourceConfig: {
        gateway: { auth: { mode: "token" } },
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
      hadRuntimeSnapshot: true,
      hadBothSnapshots: true,
      loadFreshConfig,
      notifyCommittedWrite,
      formatRefreshError: (error) => String(error),
      createRefreshError: (detail, cause) => new Error(detail, { cause }),
    });

    await Promise.resolve();
    expect(getRuntimeConfigSnapshot()?.gateway?.auth).toBeUndefined();
    expect(loadFreshConfig).not.toHaveBeenCalled();

    if (!releaseRefresh) {
      throw new Error("Expected runtime snapshot refresh release callback to be initialized");
    }
    releaseRefresh();
    await writePromise;

    expect(notifyCommittedWrite).toHaveBeenCalledTimes(1);
  });

  it("notifies registered write listeners with committed runtime snapshots", () => {
    const seen: Array<{ configPath: string; runtimeConfig: OpenClawConfig }> = [];
    const unsubscribe = registerRuntimeConfigWriteListener((event) => {
      seen.push({
        configPath: event.configPath,
        runtimeConfig: event.runtimeConfig,
      });
    });

    try {
      notifyRuntimeConfigWriteListeners({
        configPath: "/tmp/openclaw.json",
        sourceConfig: { gateway: { port: 18789 } },
        runtimeConfig: { gateway: { port: 19003 } },
        persistedHash: "abc123",
        revision: 1,
        fingerprint: "runtime-fingerprint",
        sourceFingerprint: "source-fingerprint",
        writtenAtMs: 1,
      });
    } finally {
      unsubscribe();
    }

    expect(seen).toEqual([
      {
        configPath: "/tmp/openclaw.json",
        runtimeConfig: { gateway: { port: 19003 } },
      },
    ]);
  });

  it("scopes managed write ownership by path and reference count", () => {
    const releaseA = registerManagedRuntimeConfigWriteOwner("/tmp/a.json");
    const releaseA2 = registerManagedRuntimeConfigWriteOwner("/tmp/a.json");
    const releaseB = registerManagedRuntimeConfigWriteOwner("/tmp/b.json");

    expect(hasManagedRuntimeConfigWriteOwner("/tmp/a.json")).toBe(true);
    expect(hasManagedRuntimeConfigWriteOwner("/tmp/b.json")).toBe(true);
    releaseA();
    expect(hasManagedRuntimeConfigWriteOwner("/tmp/a.json")).toBe(true);
    releaseA2();
    releaseA2();
    expect(hasManagedRuntimeConfigWriteOwner("/tmp/a.json")).toBe(false);
    expect(hasManagedRuntimeConfigWriteOwner("/tmp/b.json")).toBe(true);
    releaseB();
  });

  it("keeps prepared candidates scoped to each managed owner", async () => {
    const runtimeConfigA: OpenClawConfig = { gateway: { port: 19001 } };
    const runtimeConfigB: OpenClawConfig = { gateway: { port: 19002 } };
    const candidateA = { runtimeConfig: runtimeConfigA, compareConfig: {} };
    const candidateB = { runtimeConfig: runtimeConfigB, compareConfig: {} };
    const releaseA = registerManagedRuntimeConfigWriteOwner(
      "/tmp/scoped.json",
      async () => candidateA,
    );
    const releaseB = registerManagedRuntimeConfigWriteOwner(
      "/tmp/scoped.json",
      async () => candidateB,
    );

    try {
      const prepared = await preflightManagedRuntimeConfigWrite("/tmp/scoped.json", {});
      expect(prepared.get(releaseA.ownerId)).toBe(candidateA);
      expect(prepared.get(releaseB.ownerId)).toBe(candidateB);
    } finally {
      releaseA();
      releaseB();
    }
  });

  it("defers raw runtime activation to a managed write owner", async () => {
    const activeConfig: OpenClawConfig = { gateway: { port: 18789 } };
    setRuntimeConfigSnapshot(activeConfig);
    const notifyCommittedWrite = vi.fn();
    const refresh = vi.fn(async () => true);
    const loadFreshConfig = vi.fn(() => ({ gateway: { port: 19001 } }));
    setRuntimeConfigSnapshotRefreshHandler({ refresh });

    await finalizeRuntimeSnapshotWrite({
      nextSourceConfig: { gateway: { port: 19001 } },
      hadRuntimeSnapshot: true,
      hadBothSnapshots: false,
      loadFreshConfig,
      notifyCommittedWrite,
      deferRuntimeActivation: true,
      formatRefreshError: (error) => String(error),
      createRefreshError: (detail, cause) => new Error(detail, { cause }),
    });

    expect(getRuntimeConfigSnapshot()).toBe(activeConfig);
    expect(refresh).not.toHaveBeenCalled();
    expect(loadFreshConfig).not.toHaveBeenCalled();
    expect(notifyCommittedWrite).toHaveBeenCalledOnce();
  });
});
