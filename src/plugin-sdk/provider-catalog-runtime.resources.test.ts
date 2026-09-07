import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  createPluginRegistryResourceOwner,
  drainPluginRegistryResourceDisposals,
  getPluginRegistryResourceScope,
  registerPluginRegistryResourceDisposer,
} from "../plugins/registry-resources.js";
import type { ProviderPlugin } from "../plugins/types.js";
import { createDeferredCore } from "../shared/deferred.js";

const acquire = vi.hoisted(() => vi.fn());
vi.mock("../plugins/providers.runtime.js", () => ({
  acquirePluginProvidersCore: acquire,
  isPluginProvidersLoadInFlight: () => false,
}));
vi.mock("../plugins/provider-runtime.js", () => ({
  augmentModelCatalogWithProviderPlugins: vi.fn(),
}));

import { acquirePluginProviders } from "./provider-catalog-runtime.js";

it("runs provider callbacks in the acquired scope and joins them before release", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE proof (value TEXT); INSERT INTO proof VALUES ('synthetic')");
  const registry = createEmptyPluginRegistry();
  const construction = createPluginRegistryResourceOwner(registry, "scoped");
  registerPluginRegistryResourceDisposer(registry, "fixture", {
    id: "sqlite",
    dispose: () => db.close(),
  });
  const provider: ProviderPlugin = {
    id: "fixture",
    label: "Fixture",
    auth: [],
    resolveConfigApiKey: () => {
      expect(getPluginRegistryResourceScope()).toBeDefined();
      return String(db.prepare("SELECT value FROM proof").get()?.value);
    },
  };
  acquire.mockReturnValueOnce({ registry, providers: [provider], release: construction.release });
  const handle = acquirePluginProviders({});
  expect(Object.keys(handle).toSorted()).toEqual(["providers", "release", "run"]);
  const finish = createDeferredCore();
  const pending = handle.run(async () => {
    await finish.promise;
    return handle.providers[0]?.resolveConfigApiKey?.({ provider: "fixture", env: {} });
  });
  handle.release();
  try {
    expect(db.isOpen).toBe(true);
    expect(() => handle.run(() => undefined)).toThrow("lease has been released");
    finish.resolve();
    await expect(pending).resolves.toBe("synthetic");
  } finally {
    finish.resolve();
    await Promise.allSettled([pending]);
    handle.release();
    await drainPluginRegistryResourceDisposals();
  }
  expect(db.isOpen).toBe(false);
});
