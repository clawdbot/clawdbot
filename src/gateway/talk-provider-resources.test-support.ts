import { DatabaseSync } from "node:sqlite";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  PluginRegistryResourceScope,
  createPluginRegistryResourceOwner,
  drainPluginRegistryResourceDisposals,
  registerPluginRegistryResourceDisposer,
} from "../plugins/registry-resources.js";

export function createTalkProviderResourceFixture(options?: { disposalError?: Error }) {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE calls (name TEXT)");
  const registry = createEmptyPluginRegistry();
  const construction = createPluginRegistryResourceOwner(registry, "scoped");
  registerPluginRegistryResourceDisposer(registry, "talk-resource-fixture", {
    id: "native-provider-database",
    dispose: () => {
      db.close();
      if (options?.disposalError) {
        throw options.disposalError;
      }
    },
  });
  const resources = new PluginRegistryResourceScope();
  resources.retain(registry);
  return {
    db,
    resources,
    releaseConstruction: () => construction.release(),
    async dispose() {
      construction.release();
      resources.release();
      await drainPluginRegistryResourceDisposals();
      if (db.isOpen) {
        db.close();
      }
    },
  };
}
