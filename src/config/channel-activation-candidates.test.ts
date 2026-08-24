// Covers the per-channel candidate set activation selects from.
import { describe, expect, it } from "vitest";
import { collectPluginIdsForConfiguredChannel } from "./channel-activation-candidates.js";
import { makeIsolatedEnv, makeRegistry } from "./plugin-auto-enable.test-helpers.js";

describe("collectPluginIdsForConfiguredChannel", () => {
  it("matches a preferOver entry written as the claimant's legacy id", () => {
    const registry = makeRegistry([
      {
        id: "zz-fallback",
        channels: ["zzalpha"],
        legacyPluginIds: ["zz-old"],
      },
      {
        id: "zz-replacement",
        channels: ["zzalpha"],
        channelConfigs: {
          zzalpha: { schema: { type: "object" }, preferOver: ["zz-old"] },
        },
      },
    ]);

    // Both sides stay candidates so the preferOver filter can settle the channel. A raw membership
    // test drops the edge and returns the first claimant alone.
    expect(collectPluginIdsForConfiguredChannel("zzalpha", registry, makeIsolatedEnv())).toEqual([
      "zz-fallback",
      "zz-replacement",
    ]);
  });

  // A claimant may name its own legacy id in preferOver — a manifest carrying its rename forward —
  // and the resolver folds that spelling onto the claimant itself. Reading the self edge as a
  // contest narrowed the candidates to that claimant alone and dropped the registry-first
  // fallback, so a channel whose only "contested" claimant was explicitly disabled had no
  // candidate left. Both downstream readers already skip self edges
  // (`shouldSkipPreferredPluginAutoEnable`; the `channel-config-metadata.ts` fixpoint).
  it("ignores a preferOver entry that resolves to the claimant itself", () => {
    const registry = makeRegistry([
      { id: "zz-fallback", channels: ["zzalpha"] },
      {
        id: "zz-replacement",
        channels: ["zzalpha"],
        legacyPluginIds: ["zz-old"],
        channelConfigs: {
          zzalpha: { schema: { type: "object" }, preferOver: ["zz-old"] },
        },
      },
    ]);

    expect(collectPluginIdsForConfiguredChannel("zzalpha", registry, makeIsolatedEnv())).toEqual([
      "zz-fallback",
    ]);
  });
});
