/** A candidate that is not channel-configured must not carry a channel's replacement authority. */
import { describe, expect, it } from "vitest";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { shouldSkipPreferredPluginAutoEnable } from "./plugin-auto-enable.prefer-over.js";
import type { PluginAutoEnableCandidate } from "./plugin-auto-enable.types.js";

// Codex review P2 on #123209: `resolvePreferredOverIds` fell back to the plugin id when a candidate
// had no channel, which `candidateChannelId` documents must never be read as a channel claim. A
// plugin whose id matches a channel id then supplied that channel's preferOver from an unrelated
// provider candidate and disabled the target, with the channel never configured.
describe("preferOver authority by candidate kind", () => {
  const registry = {
    diagnostics: [],
    plugins: [
      {
        id: "clickclack",
        origin: "global",
        channels: ["clickclack"],
        channelConfigs: { clickclack: { schema: { type: "object" }, preferOver: ["legacy-chat"] } },
      },
      { id: "legacy-chat", origin: "bundled", channels: ["clickclack"] },
    ],
  } as unknown as PluginManifestRegistry;

  function skipsFallbackFor(entry: PluginAutoEnableCandidate) {
    return shouldSkipPreferredPluginAutoEnable({
      config: {} as never,
      entry: { pluginId: "legacy-chat", kind: "channel-configured", channelId: "clickclack" },
      configured: [entry],
      env: {},
      registry,
      preferOverCache: new Map(),
    });
  }

  it("honours the declaration from a channel-configured candidate", () => {
    expect(
      skipsFallbackFor({
        pluginId: "clickclack",
        kind: "channel-configured",
        channelId: "clickclack",
      }),
    ).toBe(true);
  });

  it("ignores it when the same plugin is only a provider candidate", () => {
    expect(
      skipsFallbackFor({
        pluginId: "clickclack",
        kind: "web-search-provider-selected",
      } as PluginAutoEnableCandidate),
    ).toBe(false);
  });
});
