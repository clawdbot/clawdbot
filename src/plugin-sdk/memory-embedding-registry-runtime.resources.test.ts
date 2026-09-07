import { expect, it } from "vitest";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  createPluginRegistryResourceOwner,
  drainPluginRegistryResourceDisposals,
  registerPluginRegistryResourceDisposer,
} from "../plugins/registry-resources.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import {
  listMemoryEmbeddingProviders,
  listRegisteredMemoryEmbeddingProviderAdapters,
  listRegisteredMemoryEmbeddingProviderIds,
} from "./memory-core-host-embedding-registry.js";
import { listRegisteredMemoryEmbeddingProviderAdapters as listEngineAdapters } from "./memory-core-host-engine-embeddings.js";

function createRegisteredAdapterFixture() {
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE models (name TEXT); INSERT INTO models VALUES ('retained-model')");
  const registry = createEmptyPluginRegistry();
  const adapter = {
    id: "retained-memory-adapter",
    normalizeModel: () => String(db.prepare("SELECT name FROM models").get()?.name),
    create: async () => ({ provider: null }),
  };
  registry.embeddingProviders.push({
    pluginId: adapter.id,
    source: "synthetic-fixture",
    provider: adapter,
  });
  const owner = createPluginRegistryResourceOwner(registry, "scoped");
  let disposals = 0;
  registerPluginRegistryResourceDisposer(registry, adapter.id, {
    id: "native-embedding-database",
    dispose: () => {
      disposals += 1;
      db.close();
    },
  });
  return {
    db,
    registry,
    owner,
    adapter,
    disposals: () => disposals,
    async close() {
      owner.release();
      await drainGlobalSingletonLifecycleState("restart");
      await drainPluginRegistryResourceDisposals();
      if (db.isOpen) {
        db.close();
      }
    },
  };
}

it.each([
  ["registered memory adapters", listRegisteredMemoryEmbeddingProviderAdapters],
  ["embedding engine adapters", listEngineAdapters],
  ["memory runtime adapters", listMemoryEmbeddingProviders],
] as const)(
  "retains native resources returned by legacy %s until host shutdown",
  async (_name, list) => {
    const fixture = createRegisteredAdapterFixture();
    const { db, registry, owner, adapter } = fixture;
    try {
      const returned = withPluginRuntimeRegistryScope(registry, () =>
        list().find((entry) => entry.id === adapter.id),
      );
      expect(returned?.id).toBe(adapter.id);
      owner.release();
      await drainPluginRegistryResourceDisposals();
      expect(db.isOpen).toBe(true);
      expect(returned?.normalizeModel?.({ config: {}, model: "input" })).toBe("retained-model");
      await drainGlobalSingletonLifecycleState("restart");
      expect(db.isOpen).toBe(false);
      expect(fixture.disposals()).toBe(1);
    } finally {
      await fixture.close();
    }
  },
);

it("copies diagnostic provider ids without retaining the legacy SDK host", async () => {
  const fixture = createRegisteredAdapterFixture();
  const { db, registry, owner, adapter } = fixture;
  try {
    const ids = withPluginRuntimeRegistryScope(registry, listRegisteredMemoryEmbeddingProviderIds);
    owner.release();
    await drainPluginRegistryResourceDisposals();
    expect(db.isOpen).toBe(false);
    expect(fixture.disposals()).toBe(1);
    expect(ids).toContain(adapter.id);
  } finally {
    await fixture.close();
  }
});
