// Plugin state runtime tests cover runtime-backed plugin state storage.
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveStateDir } from "../config/paths.js";
import type { PluginRecord } from "../plugins/registry-types.js";
import { createPluginRegistry } from "../plugins/registry.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resetPluginBlobStoreForTests, type OpenBlobStoreOptions } from "./plugin-blob-store.js";
import { resetPluginStateStoreForTests } from "./plugin-state-store.js";

function createPluginRecord(
  id: string,
  origin: PluginRecord["origin"] = "bundled",
  opts: { trustedOfficialInstall?: boolean } = {},
): PluginRecord {
  return {
    id,
    name: id,
    source: `/plugins/${id}/index.ts`,
    origin,
    trustedOfficialInstall: opts.trustedOfficialInstall,
    enabled: true,
    status: "loaded",
    toolNames: [],
    hookNames: [],
    channelIds: [],
    cliBackendIds: [],
    providerIds: [],
    embeddingProviderIds: [],
    speechProviderIds: [],
    realtimeTranscriptionProviderIds: [],
    realtimeVoiceProviderIds: [],
    mediaUnderstandingProviderIds: [],
    transcriptSourceProviderIds: [],
    imageGenerationProviderIds: [],
    videoGenerationProviderIds: [],
    musicGenerationProviderIds: [],
    webFetchProviderIds: [],
    webSearchProviderIds: [],
    migrationProviderIds: [],
    memoryEmbeddingProviderIds: [],
    agentHarnessIds: [],
    cliCommands: [],
    services: [],
    gatewayDiscoveryServiceIds: [],
    commands: [],
    httpRoutes: 0,
    hookCount: 0,
    configSchema: false,
  } as PluginRecord;
}

function createTestPluginRegistry() {
  return createPluginRegistry({
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    runtime: {
      state: {
        resolveStateDir,
        openBlobStore: () => {
          throw new Error("registry plugin runtime proxy should bind openBlobStore");
        },
        openKeyedStore: () => {
          throw new Error("registry plugin runtime proxy should bind openKeyedStore");
        },
        openSyncKeyedStore: () => {
          throw new Error("registry plugin runtime proxy should bind openSyncKeyedStore");
        },
        withLease: async () => {
          throw new Error("registry plugin runtime proxy should bind withLease");
        },
      },
    } as unknown as PluginRuntime,
  });
}

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  resetPluginBlobStoreForTests();
  resetPluginStateStoreForTests();
});

describe("plugin runtime state proxy", () => {
  it("binds openKeyedStore to the bundled plugin id and keeps resolveStateDir", async () => {
    await withOpenClawTestState({ label: "plugin-state-runtime" }, async (state) => {
      const registry = createTestPluginRegistry();
      const record = createPluginRecord("discord", "bundled");
      registry.registry.plugins.push(record);
      const api = registry.createApi(record, { config: {} });

      expect(api.runtime.state.resolveStateDir()).toBe(state.stateDir);
      const store = api.runtime.state.openKeyedStore<{ plugin: string }>({
        namespace: "runtime",
        maxEntries: 10,
      });
      await expect(store.registerIfAbsent("k", { plugin: "discord" })).resolves.toBe(true);
      await expect(store.registerIfAbsent("k", { plugin: "duplicate" })).resolves.toBe(false);

      const telegram = createPluginRecord("telegram", "bundled");
      registry.registry.plugins.push(telegram);
      const telegramApi = registry.createApi(telegram, { config: {} });
      const telegramStore = telegramApi.runtime.state.openKeyedStore<{ plugin: string }>({
        namespace: "runtime",
        maxEntries: 10,
      });
      await expect(telegramStore.lookup("k")).resolves.toBeUndefined();
      await expect(store.lookup("k")).resolves.toEqual({ plugin: "discord" });

      const syncStore = api.runtime.state.openSyncKeyedStore<{ plugin: string }>({
        namespace: "sync-runtime",
        maxEntries: 10,
      });
      expect(syncStore.registerIfAbsent("k", { plugin: "discord" })).toBe(true);
      expect(syncStore.lookup("k")).toEqual({ plugin: "discord" });
    });
  });

  it("allows trusted official global plugins to use keyed state", async () => {
    await withOpenClawTestState({ label: "plugin-state-trusted-global" }, async () => {
      const registry = createTestPluginRegistry();
      const record = createPluginRecord("slack", "global", { trustedOfficialInstall: true });
      registry.registry.plugins.push(record);
      const api = registry.createApi(record, { config: {} });

      const store = api.runtime.state.openKeyedStore<{ plugin: string }>({
        namespace: "runtime",
        maxEntries: 10,
      });
      await expect(store.register("thread", { plugin: "slack" })).resolves.toBeUndefined();
      await expect(store.lookup("thread")).resolves.toEqual({ plugin: "slack" });
    });
  });

  it("binds SQLite leases to trusted plugin identity and database scope", async () => {
    await withOpenClawTestState({ label: "plugin-lease-runtime" }, async (state) => {
      const registry = createTestPluginRegistry();
      const bundled = createPluginRecord("memory-core", "bundled");
      registry.registry.plugins.push(bundled);
      const bundledApi = registry.createApi(bundled, { config: {} });

      await bundledApi.runtime.state.withLease(
        {
          namespace: "qmd",
          key: "embed",
          database: { scope: "shared" },
          leaseMs: 1_000,
          waitMs: 0,
        },
        async ({ signal }) => {
          expect(signal.aborted).toBe(false);
          expect(
            openOpenClawStateDatabase({ env: state.env })
              .db.prepare("SELECT scope, lease_key FROM state_leases")
              .get(),
          ).toEqual({ scope: "plugin:memory-core:qmd", lease_key: "embed" });
        },
      );

      const official = createPluginRecord("memory-official", "global", {
        trustedOfficialInstall: true,
      });
      registry.registry.plugins.push(official);
      const officialApi = registry.createApi(official, { config: {} });
      await officialApi.runtime.state.withLease(
        {
          namespace: "qmd",
          key: "write",
          database: { scope: "agent", agentId: "main" },
          leaseMs: 1_000,
          waitMs: 0,
        },
        async () => {
          expect(
            openOpenClawAgentDatabase({ agentId: "main", env: state.env })
              .db.prepare("SELECT scope, lease_key FROM state_leases")
              .get(),
          ).toEqual({ scope: "plugin:memory-official:qmd", lease_key: "write" });
        },
      );
    });
  });

  it("binds blob stores to the trusted plugin id", async () => {
    await withOpenClawTestState({ label: "plugin-blob-runtime" }, async () => {
      const registry = createTestPluginRegistry();
      const record = createPluginRecord("diffs", "global", { trustedOfficialInstall: true });
      registry.registry.plugins.push(record);
      const api = registry.createApi(record, { config: {} });

      const store = api.runtime.state.openBlobStore<{ kind: string }>({
        namespace: "runtime",
        maxEntries: 10,
        maxBytesPerEntry: 1024,
        maxBytesPerNamespace: 4096,
      });
      await expect(
        store.registerIfAbsent("viewer", new Uint8Array([1, 2, 3]), { kind: "viewer" }),
      ).resolves.toBe(true);
      await expect(store.lookup("viewer")).resolves.toMatchObject({
        key: "viewer",
        metadata: { kind: "viewer" },
        sizeBytes: 3,
      });

      const otherRecord = createPluginRecord("other", "bundled");
      registry.registry.plugins.push(otherRecord);
      const otherStore = registry
        .createApi(otherRecord, { config: {} })
        .runtime.state.openBlobStore<{ kind: string }>({
          namespace: "runtime",
          maxEntries: 10,
          maxBytesPerEntry: 1024,
          maxBytesPerNamespace: 4096,
        });
      await expect(otherStore.lookup("viewer")).resolves.toBeUndefined();
    });
  });

  it("ignores plugin-supplied state directory overrides", async () => {
    await withOpenClawTestState({ label: "plugin-blob-runtime-env" }, async (state) => {
      const registry = createTestPluginRegistry();
      const record = createPluginRecord("diffs", "global", { trustedOfficialInstall: true });
      registry.registry.plugins.push(record);
      const api = registry.createApi(record, { config: {} });
      const redirectedEnv = {
        ...state.env,
        OPENCLAW_STATE_DIR: `${state.stateDir}-redirected`,
      };

      const store = api.runtime.state.openBlobStore<{ kind: string }>({
        namespace: "runtime-env",
        maxEntries: 10,
        maxBytesPerEntry: 1024,
        maxBytesPerNamespace: 4096,
        env: redirectedEnv,
      } as OpenBlobStoreOptions & { env: NodeJS.ProcessEnv });
      await store.register("viewer", new Uint8Array([1]), { kind: "viewer" });

      resetPluginBlobStoreForTests();
      const { db } = openOpenClawStateDatabase({ env: state.env });
      expect(
        db
          .prepare(
            `SELECT COUNT(*) AS count FROM plugin_blob_entries
             WHERE plugin_id = ? AND namespace = ? AND entry_key = ?`,
          )
          .get("diffs", "runtime-env", "viewer"),
      ).toEqual({ count: 1 });
    });
  });

  it("rejects external plugins in this release", () => {
    const registry = createTestPluginRegistry();
    const record = createPluginRecord("external-plugin", "workspace");
    registry.registry.plugins.push(record);
    const api = registry.createApi(record, { config: {} });

    expect(() =>
      api.runtime.state.openKeyedStore({ namespace: "runtime", maxEntries: 10 }),
    ).toThrow("openKeyedStore is only available for trusted plugins");
    expect(() =>
      api.runtime.state.openSyncKeyedStore({ namespace: "runtime", maxEntries: 10 }),
    ).toThrow("openKeyedStore is only available for trusted plugins");
    expect(() =>
      api.runtime.state.openBlobStore({
        namespace: "runtime",
        maxEntries: 10,
        maxBytesPerEntry: 1024,
        maxBytesPerNamespace: 4096,
      }),
    ).toThrow("openBlobStore is only available for trusted plugins");
    expect(() =>
      api.runtime.state.withLease(
        {
          namespace: "runtime",
          key: "writer",
          database: { scope: "shared" },
          leaseMs: 1_000,
          waitMs: 0,
        },
        async () => undefined,
      ),
    ).toThrow("withLease is only available for trusted plugins");
  });

  it("rejects untrusted global plugins", () => {
    const registry = createTestPluginRegistry();
    const record = createPluginRecord("diffs", "global");
    registry.registry.plugins.push(record);
    const api = registry.createApi(record, { config: {} });

    expect(() =>
      api.runtime.state.openKeyedStore({ namespace: "runtime", maxEntries: 10 }),
    ).toThrow("openKeyedStore is only available for trusted plugins");
    expect(() =>
      api.runtime.state.openBlobStore({
        namespace: "runtime",
        maxEntries: 10,
        maxBytesPerEntry: 1024,
        maxBytesPerNamespace: 4096,
      }),
    ).toThrow("openBlobStore is only available for trusted plugins");
    expect(() =>
      api.runtime.state.withLease(
        {
          namespace: "runtime",
          key: "writer",
          database: { scope: "shared" },
          leaseMs: 1_000,
          waitMs: 0,
        },
        async () => undefined,
      ),
    ).toThrow("withLease is only available for trusted plugins");
  });
});
