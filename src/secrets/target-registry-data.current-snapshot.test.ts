/** Tests target-registry data built from the current runtime snapshot. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const metadataMocks = vi.hoisted(() => ({
  listBundledPluginMetadata: vi.fn(),
  resolvePluginMetadataSnapshot: vi.fn(() => ({ plugins: [] })),
}));

vi.mock("../plugins/bundled-plugin-metadata.js", () => ({
  listBundledPluginMetadata: metadataMocks.listBundledPluginMetadata,
}));

vi.mock("../plugins/plugin-metadata-snapshot.js", () => ({
  resolvePluginMetadataSnapshot: metadataMocks.resolvePluginMetadataSnapshot,
}));

describe("getSecretTargetRegistry metadata reuse", () => {
  beforeEach(() => {
    vi.resetModules();
    metadataMocks.listBundledPluginMetadata.mockReset();
    metadataMocks.listBundledPluginMetadata.mockImplementation(() => {
      throw new Error("source bundled metadata must not be scanned");
    });
    metadataMocks.resolvePluginMetadataSnapshot.mockClear();
    metadataMocks.resolvePluginMetadataSnapshot.mockReturnValue({ plugins: [] });
  });

  it("allows configless runtime targets to reuse the lifecycle workspace", async () => {
    const { getSecretTargetRegistry } = await import("./target-registry-data.js");

    getSecretTargetRegistry();

    expect(metadataMocks.resolvePluginMetadataSnapshot).toHaveBeenCalledWith({
      allowWorkspaceScopedCurrent: true,
      env: process.env,
    });
    const calls = metadataMocks.resolvePluginMetadataSnapshot.mock.calls as unknown as Array<
      [{ allowWorkspaceScopedCurrent?: boolean }]
    >;
    for (const [call] of calls) {
      expect(call.allowWorkspaceScopedCurrent).toBe(true);
    }
  });
  it("registers secret targets for installed-origin plugins (#104320)", async () => {
    // The Exa web providers moved from bundled origin to an installed plugin
    // package; the gateway's known-target registry must keep covering them.
    metadataMocks.resolvePluginMetadataSnapshot.mockReturnValue({
      plugins: [
        {
          id: "exa",
          origin: "global",
          channels: [],
          contracts: { webSearchProviders: ["exa"] },
          configUiHints: { "webSearch.apiKey": { sensitive: true } },
          configContracts: {
            secretInputs: { paths: [{ path: "webSearch.apiKey" }] },
          },
        },
      ],
    } as never);
    const { getSecretTargetRegistry } = await import("./target-registry-data.js");
    const { isKnownSecretTargetId } = await import("./target-registry-query.js");

    const ids = getSecretTargetRegistry().map((entry) => entry.id);

    expect(ids).toContain("plugins.entries.exa.config.webSearch.apiKey");
    expect(isKnownSecretTargetId("plugins.entries.exa.config.webSearch.apiKey")).toBe(true);
  });

  it("registers config contract targets only from the resolved snapshot", async () => {
    metadataMocks.resolvePluginMetadataSnapshot.mockReturnValue({
      plugins: [
        {
          id: "snapshot-plugin",
          origin: "config",
          channels: [],
          configContracts: {
            secretInputs: { paths: [{ path: "credentials.token" }] },
          },
        },
      ],
    } as never);
    const { getSecretTargetRegistry } = await import("./target-registry-data.js");

    const ids = getSecretTargetRegistry().map((entry) => entry.id);

    expect(ids).toContain("plugins.entries.snapshot-plugin.config.credentials.token");
    expect(metadataMocks.listBundledPluginMetadata).not.toHaveBeenCalled();
  });
});
