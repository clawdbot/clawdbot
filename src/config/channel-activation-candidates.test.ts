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
});
