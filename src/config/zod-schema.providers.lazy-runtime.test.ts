import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import type { PluginManifestChannelConfig } from "../plugins/manifest.js";

const loadPluginManifestRegistryMock = vi.hoisted(() =>
  vi.fn<(options?: Record<string, unknown>) => PluginManifestRegistry>(() => ({
    plugins: [],
    diagnostics: [],
  })),
);
const collectBundledChannelConfigsMock = vi.hoisted(() =>
  vi.fn<(params: unknown) => Record<string, PluginManifestChannelConfig> | undefined>(
    () => undefined,
  ),
);

describe("ChannelsSchema bundled runtime loading", () => {
  beforeEach(() => {
    loadPluginManifestRegistryMock.mockClear();
    loadPluginManifestRegistryMock.mockReturnValue({
      plugins: [],
      diagnostics: [],
    });
    collectBundledChannelConfigsMock.mockClear();
    vi.doMock("../plugins/plugin-registry.js", () => ({
      loadPluginManifestRegistryForPluginRegistry: (options?: Record<string, unknown>) =>
        loadPluginManifestRegistryMock(options),
      loadPluginRegistrySnapshotWithMetadata: () => ({
        source: "derived",
        snapshot: { plugins: [] },
        diagnostics: [],
      }),
    }));
    vi.doMock("../plugins/plugin-metadata-snapshot.js", () => ({
      loadPluginMetadataSnapshot: (options?: Record<string, unknown>) => ({
        manifestRegistry: loadPluginManifestRegistryMock(options),
      }),
    }));
    vi.doMock("../plugins/bundled-channel-config-metadata.js", () => ({
      collectBundledChannelConfigs: (params: unknown) => collectBundledChannelConfigsMock(params),
    }));
  });

  it("skips bundled channel runtime discovery when only core channel keys are present", async () => {
    const runtime = await importFreshModule<typeof import("./zod-schema.providers.js")>(
      import.meta.url,
      "./zod-schema.providers.js?scope=channels-core-only",
    );

    const parsed = runtime.ChannelsSchema.parse({
      defaults: {
        groupPolicy: "open",
      },
      modelByChannel: {
        telegram: {
          primary: "gpt-5.4",
        },
      },
    });

    expect(parsed?.defaults?.groupPolicy).toBe("open");
    expect(loadPluginManifestRegistryMock).not.toHaveBeenCalledWith(
      expect.objectContaining({
        bundledChannelConfigCollector: expect.any(Function),
      }),
    );
  });

  it("loads bundled channel runtime discovery only when plugin-owned channel config is present", async () => {
    loadPluginManifestRegistryMock.mockReturnValueOnce({
      diagnostics: [],
      plugins: [
        {
          id: "discord",
          origin: "bundled",
          channels: ["discord"],
          channelConfigs: {
            discord: {
              runtime: {
                safeParse: (value: unknown) => ({ success: true, data: value }),
              },
            },
          },
        } as unknown as PluginManifestRegistry["plugins"][number],
      ],
    });

    const runtime = await importFreshModule<typeof import("./zod-schema.providers.js")>(
      import.meta.url,
      "./zod-schema.providers.js?scope=channels-plugin-owned",
    );

    runtime.ChannelsSchema.parse({
      discord: {},
    });

    expect(loadPluginManifestRegistryMock.mock.calls).toContainEqual([
      expect.objectContaining({
        config: {},
      }),
    ]);
    expect(collectBundledChannelConfigsMock).not.toHaveBeenCalled();
  });

  it("loads a single plugin-owned runtime surface when the manifest omits runtime metadata", async () => {
    collectBundledChannelConfigsMock.mockReturnValueOnce({
      discord: {
        schema: {},
        runtime: {
          safeParse: (value: unknown) => ({ success: true, data: value }),
        },
      },
    });
    loadPluginManifestRegistryMock.mockImplementationOnce(() => ({
      diagnostics: [],
      plugins: [
        {
          id: "discord",
          origin: "bundled",
          rootDir: "/repo/extensions/discord",
          channels: ["discord"],
          channelConfigs: {},
        } as unknown as PluginManifestRegistry["plugins"][number],
      ],
    }));

    const runtime = await importFreshModule<typeof import("./zod-schema.providers.js")>(
      import.meta.url,
      "./zod-schema.providers.js?scope=channels-plugin-owned-targeted-runtime",
    );

    runtime.ChannelsSchema.parse({
      discord: {},
    });

    expect(loadPluginManifestRegistryMock.mock.calls).toContainEqual([
      expect.objectContaining({
        config: {},
      }),
    ]);
    expect(collectBundledChannelConfigsMock).toHaveBeenCalledTimes(1);
    expect(collectBundledChannelConfigsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginDir: "/repo/extensions/discord",
        manifest: expect.objectContaining({
          id: "discord",
          channels: ["discord"],
        }),
      }),
    );
  });
});
