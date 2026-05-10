import { beforeEach, describe, expect, it, vi } from "vitest";

const { loadPluginManifestRegistryMock } = vi.hoisted(() => ({
  loadPluginManifestRegistryMock: vi.fn(() => {
    throw new Error("manifest registry should stay off the explicit bundled channel fast path");
  }),
}));
const { loadBundledPluginPublicArtifactModuleSyncMock } = vi.hoisted(() => ({
  loadBundledPluginPublicArtifactModuleSyncMock: vi.fn(
    ({ artifactBasename, dirName }: { artifactBasename: string; dirName: string }) => {
      if (dirName === "discord" && artifactBasename === "secret-contract-api.js") {
        return {
          collectRuntimeConfigAssignments: () => undefined,
          secretTargetRegistryEntries: [
            {
              id: "channels.discord.accounts.*.token",
              type: "channel",
              path: "channels.discord.accounts.*.token",
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
    const api = loadBundledChannelSecretContractApi("discord");

    expect(api?.collectRuntimeConfigAssignments).toBeTypeOf("function");
    expect(loadBundledPluginPublicArtifactModuleSyncMock).toHaveBeenCalledWith({
      dirName: "discord",
      artifactBasename: "secret-contract-api.js",
    });
    const tokenEntry = api?.secretTargetRegistryEntries?.find(
      (entry) => entry.id === "channels.discord.accounts.*.token",
    );
    expect(tokenEntry?.id).toBe("channels.discord.accounts.*.token");
    expect(loadPluginManifestRegistryMock).not.toHaveBeenCalled();
  });

  it("resolves bundled channel security contracts by explicit channel id without manifest scans", () => {
    const api = loadBundledChannelSecurityContractApi("whatsapp");

    expect(api?.unsupportedSecretRefSurfacePatterns).toContain("channels.whatsapp.creds.json");
    expect(api?.collectUnsupportedSecretRefConfigCandidates).toBeTypeOf("function");
    expect(loadBundledPluginPublicArtifactModuleSyncMock).toHaveBeenCalledWith({
      dirName: "whatsapp",
      artifactBasename: "security-contract-api.js",
    });
    expect(loadPluginManifestRegistryMock).not.toHaveBeenCalled();
  });
});
