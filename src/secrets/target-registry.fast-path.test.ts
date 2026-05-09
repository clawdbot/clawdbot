import { beforeEach, describe, expect, it, vi } from "vitest";

const { loadPluginManifestRegistryMock } = vi.hoisted(() => ({
  loadPluginManifestRegistryMock: vi.fn(() => {
    throw new Error("manifest registry should stay off the explicit channel target fast path");
  }),
}));

const { loadBundledPluginPublicArtifactModuleSyncMock } = vi.hoisted(() => ({
  loadBundledPluginPublicArtifactModuleSyncMock: vi.fn(
    ({ artifactBasename, dirName }: { artifactBasename: string; dirName: string }) => {
      if (dirName === "googlechat" && artifactBasename === "secret-contract-api.js") {
        return {
          secretTargetRegistryEntries: [
            {
              id: "channels.googlechat.serviceAccount",
              targetType: "channels.googlechat.serviceAccount",
              configFile: "openclaw.json",
              pathPattern: "channels.googlechat.serviceAccount",
              refPathPattern: "channels.googlechat.serviceAccountRef",
              secretShape: "sibling_ref",
              expectedResolvedValue: "string",
              includeInPlan: true,
              includeInConfigure: true,
              includeInAudit: true,
            },
          ],
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

import { resolveConfigSecretTargetByPath } from "./target-registry.js";

describe("secret target registry fast path", () => {
  beforeEach(() => {
    loadPluginManifestRegistryMock.mockClear();
    loadBundledPluginPublicArtifactModuleSyncMock.mockClear();
  });

  it("resolves bundled channel targets by explicit channel id without manifest scans", () => {
    const target = resolveConfigSecretTargetByPath(["channels", "googlechat", "serviceAccount"]);

    if (!target) {
      throw new Error("expected googlechat service account target");
    }
    expect(target.entry.id).toBe("channels.googlechat.serviceAccount");
    expect(target.refPathSegments).toEqual(["channels", "googlechat", "serviceAccountRef"]);
    expect(loadBundledPluginPublicArtifactModuleSyncMock).toHaveBeenCalledWith({
      dirName: "googlechat",
      artifactBasename: "secret-contract-api.js",
    });
    expect(loadPluginManifestRegistryMock).not.toHaveBeenCalled();
  });
});
