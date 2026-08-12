import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";

const mocks = vi.hoisted(() => ({
  resolvePluginMetadataSnapshot: vi.fn(),
  resolveConfigWidePluginManifestRegistry: vi.fn(),
}));

vi.mock("../plugins/plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/plugin-metadata-snapshot.js")>()),
  resolvePluginMetadataSnapshot: mocks.resolvePluginMetadataSnapshot,
}));

vi.mock("./io.plugin-metadata.js", () => ({
  resolveConfigWidePluginManifestRegistry: mocks.resolveConfigWidePluginManifestRegistry,
}));

const { resolveReadOnlyChannelPluginsForConfig } = await import("../channels/plugins/read-only.js");
const { createConfigIoContext } = await import("./io.context.js");

function manifestRecord(params: {
  id: string;
  source: string;
  channels?: string[];
}): PluginManifestRecord {
  return {
    id: params.id,
    name: params.id,
    description: "test plugin",
    version: "1.0.0",
    source: params.source,
    origin: "workspace",
    channels: params.channels ?? [],
  } as PluginManifestRecord;
}

describe("config IO plugin metadata snapshots", () => {
  beforeEach(() => {
    mocks.resolvePluginMetadataSnapshot.mockReset();
    mocks.resolveConfigWidePluginManifestRegistry.mockReset();
  });

  it("feeds merged workspace plugins to snapshot-backed read-only discovery", () => {
    const primary = manifestRecord({ id: "primary", source: "/srv/ops/primary" });
    const secondary = manifestRecord({
      id: "research-chat-plugin",
      source: "/srv/research/research-chat-plugin",
      channels: ["research-chat"],
    });
    const primaryRegistry = { plugins: [primary], diagnostics: [] };
    const mergedRegistry = { plugins: [primary, secondary], diagnostics: [] };
    mocks.resolvePluginMetadataSnapshot.mockReturnValue({
      plugins: primaryRegistry.plugins,
      manifestRegistry: primaryRegistry,
    } as unknown as PluginMetadataSnapshot);
    mocks.resolveConfigWidePluginManifestRegistry.mockReturnValue(mergedRegistry);
    const cfg = {
      agents: {
        ownership: "explicit" as const,
        entries: {
          ops: { workspace: "/srv/ops" },
          research: { workspace: "/srv/research" },
        },
      },
      channels: { "research-chat": { enabled: true } },
      plugins: {
        allow: ["research-chat-plugin"],
        entries: { "research-chat-plugin": { enabled: true } },
      },
    };
    const context = createConfigIoContext({ env: {}, observe: false });
    const loader = context.createValidationPluginMetadataSnapshotLoader({
      effectiveConfigRaw: cfg,
      env: {},
    });
    loader.load(cfg);
    const snapshot = loader.getSnapshot();

    expect(snapshot?.plugins).toEqual(mergedRegistry.plugins);
    expect(snapshot?.byPluginId.get("research-chat-plugin")).toBe(secondary);
    expect(loader.getSnapshot()).toBe(snapshot);
    expect(
      resolveReadOnlyChannelPluginsForConfig(cfg, {
        env: {},
        metadataSnapshot: snapshot,
      }).plugins.map((plugin) => plugin.id),
    ).toContain("research-chat");
  });
});
