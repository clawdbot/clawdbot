// Plugin-shape coherence contract for bundled channel plugins.
//
// Catalog routing keys off plugin ids, docs surfaces render `meta.docsPath`,
// and capability flags gate feature discovery, so every bundled channel must
// keep identity metadata aligned with its catalog id and capability flags
// coherent with the adapters that implement them. Per-surface behavior checks
// live in the registry-backed shard suites; this suite pins the static shape.
//
// Capability rules verified against every bundled channel before pinning.
// Dropped for legitimate exceptions rather than special-casing:
// - threads=true does not imply a threading adapter (clickclack/tlon bind
//   threads through conversationBindings only).
// - nativeCommands=true does not imply a commands adapter (mattermost serves
//   slash commands through gateway HTTP routes).
// - blockStreaming=true does not imply a streaming adapter (coalesce tuning
//   is optional).
import { beforeAll, describe, expect, it } from "vitest";
import { listBundledPackageChannelMetadata } from "../../../plugins/bundled-package-channel-metadata.js";
import {
  getBundledChannelPluginAsync,
  listBundledChannelPluginIds,
} from "./test-helpers/bundled-channel-plugin-loader.js";

const CHAT_TYPES = new Set(["direct", "group", "channel", "thread"]);
const bundledChannelPluginIds = listBundledChannelPluginIds();
const packageMetadataById = new Map(
  listBundledPackageChannelMetadata().map((channel) => [channel.id, channel]),
);

describe("bundled channel plugin shape coherence", () => {
  const plugins = new Map<string, Awaited<ReturnType<typeof getBundledChannelPluginAsync>>>();

  beforeAll(async () => {
    for (const id of bundledChannelPluginIds) {
      plugins.set(id, await getBundledChannelPluginAsync(id));
    }
  });

  it("discovers bundled channel plugins from the catalog", () => {
    expect(bundledChannelPluginIds.length).toBeGreaterThan(0);
  });

  describe.each(bundledChannelPluginIds)("%s", (id) => {
    it("keeps plugin identity aligned with the catalog id", () => {
      const plugin = plugins.get(id);
      if (!plugin) {
        throw new Error(`Missing bundled channel plugin for ${id}`);
      }
      expect(plugin.id).toBe(id);
      expect(plugin.meta.id).toBe(id);
    });

    it("ships non-empty docs metadata", () => {
      const plugin = plugins.get(id);
      expect(plugin?.meta.docsPath.trim()).toBeTruthy();
    });

    it("keeps runtime and lazy setup metadata on the same channel-owned contract", () => {
      const plugin = plugins.get(id);
      const packageSetup = packageMetadataById.get(id)?.setup;
      if (!plugin?.setup && !plugin?.setupContract && !packageSetup) {
        return;
      }
      expect(plugin?.setupContract, `${id} must expose setupContract`).toBeDefined();
      expect(packageSetup, `${id} must expose package setup metadata`).toBeDefined();
      expect(plugin?.setupContract?.metadata).toEqual(packageSetup);
    });

    it("declares known chat types", () => {
      const chatTypes = plugins.get(id)?.capabilities.chatTypes ?? [];
      expect(chatTypes.length).toBeGreaterThan(0);
      expect(chatTypes.filter((chatType) => !CHAT_TYPES.has(chatType))).toEqual([]);
    });

    it("backs declared reactions with a message action surface", () => {
      const plugin = plugins.get(id);
      if (!plugin?.capabilities.reactions) {
        return;
      }
      // Reactions are delivered through the shared `message` tool, so a channel
      // declaring the capability without an actions adapter ships a dead flag.
      expect(plugin.actions).toBeDefined();
      expect(typeof plugin.actions?.describeMessageTool).toBe("function");
    });
  });
});
