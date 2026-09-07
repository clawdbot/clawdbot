import { expect, it } from "vitest";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { acquireEmbeddingProvider } from "./embedding-provider-runtime.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import {
  createPluginRegistryResourceOwner,
  drainPluginRegistryResourceDisposals,
  registerPluginRegistryResourceDisposer,
} from "./registry-resources.js";
import { withPluginRuntimeRegistryScope } from "./runtime/gateway-request-scope.js";

it("retains the request-scoped registered embedding adapter rather than the global registry", async () => {
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE models (name TEXT); INSERT INTO models VALUES ('scoped-model')");
  const registry = createEmptyPluginRegistry();
  registry.embeddingProviders.push({
    pluginId: "scoped-embeddings",
    source: "synthetic-fixture",
    provider: {
      id: "scoped-embeddings",
      normalizeModel: () => String(db.prepare("SELECT name FROM models").get()?.name),
      create: async () => ({ provider: null }),
    },
  });
  const owner = createPluginRegistryResourceOwner(registry, "scoped");
  registerPluginRegistryResourceDisposer(registry, "scoped-embeddings", {
    id: "native-embedding-database",
    dispose: () => db.close(),
  });
  let lease: ReturnType<typeof acquireEmbeddingProvider> | undefined;
  try {
    lease = withPluginRuntimeRegistryScope(registry, () =>
      acquireEmbeddingProvider("scoped-embeddings"),
    );
    owner.release();
    await drainPluginRegistryResourceDisposals();
    expect(db.isOpen).toBe(true);
    const provider = lease.provider;
    expect(lease.run(() => provider?.normalizeModel?.({ config: {}, model: "input" }))).toBe(
      "scoped-model",
    );
    lease.release();
    await drainPluginRegistryResourceDisposals();
    expect(db.isOpen).toBe(false);
    expect(() => lease!.run(() => undefined)).toThrow("released");
  } finally {
    lease?.release();
    owner.release();
    await drainPluginRegistryResourceDisposals();
  }
});
