/** Tests that configured-only secret target lookup avoids broad manifest rediscovery. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { loadPluginManifestRegistryMock } = vi.hoisted(() => ({
  loadPluginManifestRegistryMock: vi.fn(() => {
    throw new Error("manifest registry should stay off configured-only target fast paths");
  }),
}));

const { getSecretTargetRegistryMock } = vi.hoisted(() => ({
  getSecretTargetRegistryMock: vi.fn(),
}));

const { loadBundledPublicArtifactMock } = vi.hoisted(() => ({
  loadBundledPublicArtifactMock: vi.fn(
    ({ artifactCandidates, dirName }: { artifactCandidates: string[]; dirName: string }) => {
      if (dirName === "googlechat" && artifactCandidates[0] === "secret-contract-api.js") {
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
      if (dirName === "telegram" && artifactCandidates[0] === "secret-contract-api.js") {
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
      return null;
    },
  ),
}));

vi.mock("../plugins/manifest-registry.js", () => ({
  loadPluginManifestRegistryCore: loadPluginManifestRegistryMock,
}));

vi.mock("../plugins/public-surface-loader.js", () => ({
  loadBundledPluginPublicArtifactModuleFromCandidatesSync: loadBundledPublicArtifactMock,
}));

vi.mock("./target-registry-data.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./target-registry-data.js")>();
  const channelTarget = (id: string) => ({
    id,
    targetType: id,
    configFile: "openclaw.json" as const,
    pathPattern: id,
    secretShape: "secret_input" as const,
    expectedResolvedValue: "string" as const,
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
  });
  getSecretTargetRegistryMock.mockImplementation(
    (params?: { config?: { plugins?: { load?: { paths?: string[] } } } }) => {
      const loadPath = params?.config?.plugins?.load?.paths?.[0];
      const channelEntries =
        loadPath === "/plugins/custom-next"
          ? [channelTarget("channels.customNext.token")]
          : [
              channelTarget("channels.qqbot.clientSecret"),
              channelTarget("channels.custom.primaryToken"),
              channelTarget("channels.custom.secondaryToken"),
            ];
      return [...actual.getCoreSecretTargetRegistry(), ...channelEntries];
    },
  );
  return { ...actual, getSecretTargetRegistry: getSecretTargetRegistryMock };
});

import {
  discoverConfigSecretTargets,
  discoverConfigSecretTargetsByIds,
  resolveConfigSecretTargetByPath,
  resolvePlanTargetAgainstRegistry,
} from "./target-registry.js";

describe("secret target registry fast path", () => {
  beforeEach(() => {
    loadPluginManifestRegistryMock.mockClear();
    loadBundledPublicArtifactMock.mockClear();
    getSecretTargetRegistryMock.mockClear();
  });

  it("resolves bundled channel targets by explicit channel id without manifest scans", () => {
    const target = resolveConfigSecretTargetByPath(["channels", "googlechat", "serviceAccount"]);

    if (!target) {
      throw new Error("expected googlechat service account target");
    }
    expect(target.entry.id).toBe("channels.googlechat.serviceAccount");
    expect(target.refPathSegments).toBeUndefined();
    expect(loadBundledPublicArtifactMock).toHaveBeenCalledWith({
      dirName: "googlechat",
      artifactCandidates: ["secret-contract-api.js"],
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
    expect(loadBundledPublicArtifactMock).not.toHaveBeenCalled();
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

  it("discovers all core and configured channel targets without loading plugin metadata", () => {
    const targets = discoverConfigSecretTargets({
      gateway: { auth: { token: "gateway-token" } },
      channels: { telegram: { botToken: "telegram-token" } },
    });

    const targetIds = targets.map((target) => target.entry.id);
    expect(targetIds).toEqual(
      expect.arrayContaining(["gateway.auth.token", "channels.telegram.botToken"]),
    );
    expect(targetIds.some((targetId) => targetId.startsWith("plugins.entries."))).toBe(false);
    expect(loadPluginManifestRegistryMock).not.toHaveBeenCalled();
  });

  it("uses the complete registry for configured external and custom channels", () => {
    const env = { HOME: "/audit-home" };
    const config = {
      plugins: { load: { paths: ["/plugins/custom"] }, entries: {} },
      channels: {
        qqbot: { clientSecret: "qqbot-secret" },
        custom: {
          primaryToken: "primary-secret",
          secondaryToken: "secondary-secret",
        },
      },
    };
    const targets = discoverConfigSecretTargets(config, { env });

    expect(targets.map((target) => target.entry.id)).toEqual(
      expect.arrayContaining([
        "channels.qqbot.clientSecret",
        "channels.custom.primaryToken",
        "channels.custom.secondaryToken",
      ]),
    );
    expect(getSecretTargetRegistryMock).toHaveBeenLastCalledWith({ config, env });

    const nextConfig = {
      plugins: { load: { paths: ["/plugins/custom-next"] }, entries: {} },
      channels: { customNext: { token: "next-secret" } },
    };
    const nextTargets = discoverConfigSecretTargets(nextConfig, { env });
    expect(nextTargets.map((target) => target.entry.id)).toContain("channels.customNext.token");
    expect(getSecretTargetRegistryMock).toHaveBeenLastCalledWith({ config: nextConfig, env });
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
