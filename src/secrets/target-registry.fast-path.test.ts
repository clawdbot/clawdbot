/** Tests that explicit channel secret target lookup avoids broad manifest rediscovery. */
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
              secretShape: "secret_input",
              expectedResolvedValue: "string",
              includeInPlan: true,
              includeInConfigure: true,
              includeInAudit: true,
            },
          ],
        };
      }
      if (dirName === "telegram" && artifactBasename === "secret-contract-api.js") {
        return {
          secretTargetRegistryEntries: [
            {
              id: "channels.telegram.botToken",
              targetType: "channels.telegram.botToken",
              configFile: "openclaw.json",
              pathPattern: "channels.telegram.botToken",
              refPathPattern: "channels.telegram.botTokenRef",
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

import {
  discoverConfigSecretTargetsByIds,
  resolveConfigSecretTargetByPath,
  resolvePlanTargetAgainstRegistry,
} from "./target-registry.js";

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
    expect(target.refPathSegments).toBeUndefined();
    expect(loadBundledPluginPublicArtifactModuleSyncMock).toHaveBeenCalledWith({
      dirName: "googlechat",
      artifactBasename: "secret-contract-api.js",
    });
    expect(loadPluginManifestRegistryMock).not.toHaveBeenCalled();
  });

  it("discovers selected core config targets without loading plugin metadata", () => {
    const targets = discoverConfigSecretTargetsByIds(
      {
        gateway: { auth: { token: "test-token" } },
        channels: { telegram: { botToken: "ignored-token" } },
      },
      ["gateway.auth.token"],
    );

    expect(targets.map((target) => target.entry.id)).toEqual(["gateway.auth.token"]);
    expect(loadBundledPluginPublicArtifactModuleSyncMock).not.toHaveBeenCalled();
    expect(loadPluginManifestRegistryMock).not.toHaveBeenCalled();
  });

  it("discovers selected configured channel targets without loading plugin metadata", () => {
    const targets = discoverConfigSecretTargetsByIds(
      { channels: { telegram: { botToken: "test-token" } } },
      ["channels.telegram.botToken"],
    );

    expect(targets.map((target) => target.entry.id)).toContain("channels.telegram.botToken");
    expect(loadPluginManifestRegistryMock).not.toHaveBeenCalled();
  });

  it("resolves channel plan targets without loading plugin metadata", () => {
    const target = resolvePlanTargetAgainstRegistry({
      type: "channels.telegram.botToken",
      pathSegments: ["channels", "telegram", "botToken"],
    });

    expect(target?.entry.id).toBe("channels.telegram.botToken");
    expect(loadPluginManifestRegistryMock).not.toHaveBeenCalled();
  });

  it("resolves auth-profile plan targets without loading plugin metadata", () => {
    const target = resolvePlanTargetAgainstRegistry({
      type: "auth-profiles.api_key.key",
      pathSegments: ["profiles", "openai:default", "key"],
    });

    expect(target?.entry.id).toBe("auth-profiles.api_key.key");
    expect(loadPluginManifestRegistryMock).not.toHaveBeenCalled();
  });
});
