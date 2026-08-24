/** Tests target-registry data built from the current runtime snapshot. */
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "../plugins/test-helpers/fs-fixtures.js";

const tempDirs: string[] = [];

const metadataMocks = vi.hoisted(() => ({
  listBundledPluginMetadata: vi.fn(),
  resolvePluginMetadataSnapshot: vi.fn<
    (params?: { config?: { plugins?: { load?: { paths?: string[] } } } }) => {
      plugins: never[];
    }
  >(() => ({ plugins: [] })),
}));

vi.mock("../plugins/bundled-plugin-metadata.js", () => ({
  listBundledPluginMetadata: metadataMocks.listBundledPluginMetadata,
}));

vi.mock("../plugins/plugin-metadata-snapshot.js", () => ({
  resolvePluginMetadataSnapshot: metadataMocks.resolvePluginMetadataSnapshot,
}));

function writeChannelContract(params: {
  channelId: string;
  pluginId: string;
  targetId: string;
  ownership: "channelConfigs" | "channels";
}) {
  const rootDir = makeTrackedTempDir("openclaw-target-registry-channel", tempDirs);
  fs.writeFileSync(
    path.join(rootDir, "secret-contract-api.cjs"),
    `module.exports = { secretTargetRegistryEntries: [${JSON.stringify({
      id: params.targetId,
      targetType: params.targetId,
      configFile: "openclaw.json",
      pathPattern: params.targetId,
      secretShape: "secret_input",
      expectedResolvedValue: "string",
      includeInPlan: true,
      includeInConfigure: true,
      includeInAudit: true,
    })}] };`,
    "utf8",
  );
  return {
    id: params.pluginId,
    origin: "config",
    channels: params.ownership === "channels" ? [params.channelId] : [],
    channelConfigs: params.ownership === "channelConfigs" ? { [params.channelId]: {} } : {},
    rootDir,
  };
}

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

  afterEach(() => {
    cleanupTrackedTempDirs(tempDirs);
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

  it("keeps official external channel secret targets without installed plugin metadata", async () => {
    const { getSecretTargetRegistry } = await import("./target-registry-data.js");

    const ids = getSecretTargetRegistry().map((entry) => entry.id);

    expect(ids).toContain("channels.qqbot.clientSecret");
    expect(ids).toContain("channels.qqbot.accounts.*.clientSecret");
  });

  it("builds config-scoped registries independently instead of reusing the singleton", async () => {
    metadataMocks.resolvePluginMetadataSnapshot.mockImplementation(
      (params?: { config?: { plugins?: { load?: { paths?: string[] } } } }) => {
        const pluginId = params?.config?.plugins?.load?.paths?.[0] ?? "missing";
        return {
          plugins: [
            {
              id: pluginId,
              origin: "config",
              channels: [],
              configContracts: {
                secretInputs: { paths: [{ path: "credentials.token" }] },
              },
            },
          ],
        } as never;
      },
    );
    const { getSecretTargetRegistry } = await import("./target-registry-data.js");
    const firstConfig = { plugins: { load: { paths: ["first-plugin"] }, entries: {} } };
    const secondConfig = { plugins: { load: { paths: ["second-plugin"] }, entries: {} } };

    const firstIds = getSecretTargetRegistry({ config: firstConfig, env: {} }).map(
      (entry) => entry.id,
    );
    const secondIds = getSecretTargetRegistry({ config: secondConfig, env: {} }).map(
      (entry) => entry.id,
    );

    expect(firstIds).toContain("plugins.entries.first-plugin.config.credentials.token");
    expect(firstIds).not.toContain("plugins.entries.second-plugin.config.credentials.token");
    expect(secondIds).toContain("plugins.entries.second-plugin.config.credentials.token");
    expect(secondIds).not.toContain("plugins.entries.first-plugin.config.credentials.token");
  });

  it("loads channel contracts from every supported ownership field", async () => {
    const records = [
      writeChannelContract({
        channelId: "custom",
        pluginId: "custom-primary",
        targetId: "channels.custom.primaryToken",
        ownership: "channels",
      }),
      writeChannelContract({
        channelId: "custom",
        pluginId: "custom-secondary",
        targetId: "channels.custom.secondaryToken",
        ownership: "channelConfigs",
      }),
    ];
    metadataMocks.resolvePluginMetadataSnapshot.mockReturnValue({ plugins: records } as never);
    const { getSecretTargetRegistry } = await import("./target-registry-data.js");

    const ids = getSecretTargetRegistry({
      config: { plugins: { load: { paths: records.map((record) => record.rootDir) } } },
      env: {},
    }).map((entry) => entry.id);

    expect(ids).toEqual(
      expect.arrayContaining(["channels.custom.primaryToken", "channels.custom.secondaryToken"]),
    );
  });
});
