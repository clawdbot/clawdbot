import { beforeEach, describe, expect, it, vi } from "vitest";

const { loadPluginManifestRegistryMock } = vi.hoisted(() => ({
  loadPluginManifestRegistryMock: vi.fn(() => {
    throw new Error("manifest registry should stay off the explicit bundled channel fast path");
  }),
}));
const { loadBundledPluginPublicArtifactModuleSyncMock } = vi.hoisted(() => ({
  loadBundledPluginPublicArtifactModuleSyncMock: vi.fn(
    ({ artifactBasename, dirName }: { artifactBasename: string; dirName: string }) => {
      if (dirName === "bluebubbles" && artifactBasename === "secret-contract-api.js") {
        return {
          collectRuntimeConfigAssignments: () => undefined,
          secretTargetRegistryEntries: [
            {
              id: "channels.bluebubbles.accounts.*.password",
              type: "channel",
              path: "channels.bluebubbles.accounts.*.password",
            },
          ],
        };
      }
      if (dirName === "whatsapp" && artifactBasename === "security-contract-api.js") {
        return {
          unsupportedSecretRefSurfacePatterns: ["channels.whatsapp.creds.json"],
          collectUnsupportedSecretRefConfigCandidates: () => [],
        };
      }
      throw new Error(
        `Unable to resolve bundled plugin public surface ${dirName}/${artifactBasename}`,
      );
    },
  ),
}));

vi.mock("../plugins/manifest-registry.js", () => ({
  loadPluginManifestRegistry: loadPluginManifestRegistryMock,
}));

vi.mock("../plugins/public-surface-loader.js", () => ({
  loadBundledPluginPublicArtifactModuleSync: loadBundledPluginPublicArtifactModuleSyncMock,
}));

import {
  loadBundledChannelSecretContractApi,
  loadBundledChannelSecurityContractApi,
} from "./channel-contract-api.js";

describe("channel contract api explicit fast path", () => {
  beforeEach(() => {
    loadPluginManifestRegistryMock.mockClear();
  });

  it("resolves bundled channel secret contracts by explicit channel id without manifest scans", () => {
    const api = loadBundledChannelSecretContractApi("bluebubbles");

    expect(api?.collectRuntimeConfigAssignments).toBeTypeOf("function");
    expect(loadBundledPluginPublicArtifactModuleSyncMock).toHaveBeenCalledWith({
      dirName: "bluebubbles",
      artifactBasename: "secret-contract-api.js",
    });
    expect(api?.secretTargetRegistryEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "channels.bluebubbles.accounts.*.password",
        }),
      ]),
    );
    expect(loadPluginManifestRegistryMock).not.toHaveBeenCalled();
  });

  it("resolves bundled channel security contracts by explicit channel id without manifest scans", () => {
    const api = loadBundledChannelSecurityContractApi("whatsapp");

    expect(api?.unsupportedSecretRefSurfacePatterns).toEqual(
      expect.arrayContaining(["channels.whatsapp.creds.json"]),
    );
    expect(api?.collectUnsupportedSecretRefConfigCandidates).toBeTypeOf("function");
    expect(loadBundledPluginPublicArtifactModuleSyncMock).toHaveBeenCalledWith({
      dirName: "whatsapp",
      artifactBasename: "security-contract-api.js",
    });
    expect(loadPluginManifestRegistryMock).not.toHaveBeenCalled();
  });
});
