import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BundledPluginMetadata } from "../plugins/bundled-plugin-metadata.js";
import type { PluginManifestChannelConfig } from "../plugins/manifest.js";

const listBundledPluginMetadataMock = vi.hoisted(() =>
  vi.fn<(options?: unknown) => readonly BundledPluginMetadata[]>(() => []),
);
const collectBundledChannelConfigsMock = vi.hoisted(() =>
  vi.fn<(params: unknown) => Record<string, PluginManifestChannelConfig> | undefined>(
    () => undefined,
  ),
);

describe("ChannelsSchema bundled runtime loading", () => {
  beforeEach(() => {
    listBundledPluginMetadataMock.mockClear();
    collectBundledChannelConfigsMock.mockClear();
    vi.doMock("../plugins/bundled-plugin-metadata.js", () => ({
      listBundledPluginMetadata: (options?: unknown) => listBundledPluginMetadataMock(options),
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
    expect(listBundledPluginMetadataMock).not.toHaveBeenCalledWith(
      expect.objectContaining({
        includeChannelConfigs: true,
      }),
    );
  });

  it("loads bundled channel runtime discovery only when plugin-owned channel config is present", async () => {
    listBundledPluginMetadataMock.mockReturnValueOnce([
      {
        dirName: "discord",
        manifest: {
          channels: ["discord"],
          channelConfigs: {
            discord: {
              runtime: {
                safeParse: (value: unknown) => ({ success: true, data: value }),
              },
            },
          },
        },
      } as unknown as BundledPluginMetadata,
    ]);

    const runtime = await importFreshModule<typeof import("./zod-schema.providers.js")>(
      import.meta.url,
      "./zod-schema.providers.js?scope=channels-plugin-owned",
    );

    runtime.ChannelsSchema.parse({
      discord: {},
    });

    expect(listBundledPluginMetadataMock.mock.calls).toContainEqual([
      expect.objectContaining({
        includeChannelConfigs: false,
        includeSyntheticChannelConfigs: false,
      }),
    ]);
    expect(collectBundledChannelConfigsMock).not.toHaveBeenCalled();
  });

  it("loads a single plugin-owned runtime surface when the manifest omits runtime metadata", async () => {
    listBundledPluginMetadataMock.mockReturnValueOnce([
      {
        dirName: "discord",
        manifest: {
          channels: ["discord"],
        },
      } as unknown as BundledPluginMetadata,
    ]);
    collectBundledChannelConfigsMock.mockReturnValueOnce({
      discord: {
        schema: {},
        runtime: {
          safeParse: (value: unknown) => ({ success: true, data: value }),
        },
      },
    });

    const runtime = await importFreshModule<typeof import("./zod-schema.providers.js")>(
      import.meta.url,
      "./zod-schema.providers.js?scope=channels-plugin-owned-targeted-runtime",
    );

    runtime.ChannelsSchema.parse({
      discord: {},
    });

    expect(listBundledPluginMetadataMock.mock.calls).toContainEqual([
      expect.objectContaining({
        includeChannelConfigs: false,
        includeSyntheticChannelConfigs: false,
      }),
    ]);
    expect(collectBundledChannelConfigsMock).toHaveBeenCalledTimes(1);
  });
});
