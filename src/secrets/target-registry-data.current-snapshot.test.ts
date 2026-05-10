import { beforeEach, describe, expect, it, vi } from "vitest";

const metadataMocks = vi.hoisted(() => ({
  getCurrentPluginMetadataSnapshot: vi.fn(() => undefined),
  loadPluginMetadataSnapshot: vi.fn(() => ({ plugins: [] })),
}));

vi.mock("../plugins/current-plugin-metadata-snapshot.js", () => ({
  getCurrentPluginMetadataSnapshot: metadataMocks.getCurrentPluginMetadataSnapshot,
}));

vi.mock("../plugins/plugin-metadata-snapshot.js", () => ({
  loadPluginMetadataSnapshot: metadataMocks.loadPluginMetadataSnapshot,
}));

describe("getSecretTargetRegistry metadata reuse", () => {
  beforeEach(() => {
    vi.resetModules();
    metadataMocks.getCurrentPluginMetadataSnapshot.mockClear();
    metadataMocks.getCurrentPluginMetadataSnapshot.mockReturnValue(undefined);
    metadataMocks.loadPluginMetadataSnapshot.mockClear();
    metadataMocks.loadPluginMetadataSnapshot.mockReturnValue({ plugins: [] });
  });

  it("does not request workspace-scoped current metadata for the configless global cache", async () => {
    const { getSecretTargetRegistry } = await import("./target-registry-data.js");

    getSecretTargetRegistry();

    expect(metadataMocks.getCurrentPluginMetadataSnapshot).toHaveBeenCalledWith({
      config: {},
      env: process.env,
    });
    const calls = metadataMocks.getCurrentPluginMetadataSnapshot.mock.calls as unknown as Array<
      [{ allowWorkspaceScopedSnapshot?: boolean }]
    >;
    for (const [call] of calls) {
      expect(call.allowWorkspaceScopedSnapshot).not.toBe(true);
    }
    expect(metadataMocks.loadPluginMetadataSnapshot).toHaveBeenCalledWith({
      config: {},
      env: process.env,
    });
  });
});
