import { describe, expect, it } from "vitest";
import {
  buildWebProviderSnapshotCacheKey,
  mapRegistryProviders,
} from "./web-provider-resolution-shared.js";

describe("web-provider-resolution-shared", () => {
  it("distinguishes explicit empty plugin scopes in cache keys", () => {
    const unscoped = buildWebProviderSnapshotCacheKey({
      envKey: "demo",
    });
    const scopedEmpty = buildWebProviderSnapshotCacheKey({
      envKey: "demo",
      onlyPluginIds: [],
    });

    expect(scopedEmpty).not.toBe(unscoped);
  });

  it("treats explicit empty plugin scopes as scoped-empty when mapping providers", () => {
    const providers = mapRegistryProviders({
      entries: [
        {
          pluginId: "alpha",
          provider: { id: "alpha-provider" },
        },
        {
          pluginId: "beta",
          provider: { id: "beta-provider" },
        },
      ],
      onlyPluginIds: [],
      sortProviders: (values) => values,
    });

    expect(providers).toEqual([]);
  });
});
