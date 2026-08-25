/** Covers reading a record's channel replacement preference by canonical channel id. */
import { describe, expect, it } from "vitest";
import { resolveManifestChannelPreferOverIds } from "./manifest-channel-preference.js";
import type { PluginManifestRecord } from "./manifest-registry.js";

describe("resolveManifestChannelPreferOverIds", () => {
  it("reads a channel-config declaration written under the canonical id", () => {
    const record = {
      id: "modern",
      channelConfigs: { clickclack: { preferOver: ["legacy"] } },
    } as unknown as PluginManifestRecord;

    expect(resolveManifestChannelPreferOverIds(record, "clickclack")).toEqual(["legacy"]);
  });

  // Codex review P1 on #123209: callers canonicalize the channel id before asking, so a descriptor
  // written under any other spelling of the same channel was missed and the replacement edge was
  // silently dropped.
  it("reads a declaration written under a non-canonical spelling", () => {
    const record = {
      id: "modern",
      channelConfigs: { Clickclack: { preferOver: ["legacy"] } },
    } as unknown as PluginManifestRecord;

    expect(resolveManifestChannelPreferOverIds(record, "clickclack")).toEqual(["legacy"]);
  });

  it("reads catalog metadata written under a non-canonical spelling", () => {
    const record = {
      id: "modern",
      channelCatalogMeta: { id: "Clickclack", preferOver: ["legacy"] },
    } as unknown as PluginManifestRecord;

    expect(resolveManifestChannelPreferOverIds(record, "clickclack")).toEqual(["legacy"]);
  });

  // Codex review P2 on #128904: a custom channel id is unknown to `normalizeChatChannelId`, so the
  // fallback returned it unchanged while runtime lookup and the cede comparator both fold its case.
  // A manifest claiming `acmechat` while declaring `channelConfigs.AcmeChat` names one serving
  // channel, and keeping the two spellings distinct dropped the replacement edge, leaving ownership
  // decided by registration order.
  it("reads a custom-channel declaration written under a different case", () => {
    const record = {
      id: "modern",
      channelConfigs: { AcmeChat: { preferOver: ["legacy"] } },
    } as unknown as PluginManifestRecord;

    expect(resolveManifestChannelPreferOverIds(record, "acmechat")).toEqual(["legacy"]);
  });

  it("reads custom-channel catalog metadata written under a different case", () => {
    const record = {
      id: "modern",
      channelCatalogMeta: { id: "AcmeChat", preferOver: ["legacy"] },
    } as unknown as PluginManifestRecord;

    expect(resolveManifestChannelPreferOverIds(record, "acmechat")).toEqual(["legacy"]);
  });

  it("still refuses catalog metadata for a different channel", () => {
    const record = {
      id: "modern",
      channelCatalogMeta: { id: "otherchat", preferOver: ["legacy"] },
    } as unknown as PluginManifestRecord;

    expect(resolveManifestChannelPreferOverIds(record, "clickclack")).toEqual([]);
  });
});
