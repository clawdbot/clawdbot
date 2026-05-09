import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../plugins/bundled-plugin-metadata.js", () => ({
  listBundledPluginMetadata: () => [
    {
      manifest: {
        channelConfigs: {
          msteams: {
            schema: { type: "object" },
            runtime: { configWrites: true },
          },
          whatsapp: {
            schema: { type: "object" },
          },
        },
      },
    },
  ],
}));

describe("bundled channel config runtime", () => {
  beforeEach(() => {
    vi.doUnmock("../channels/plugins/bundled.js");
    vi.doUnmock("../plugins/bundled-plugin-metadata.js");
  });

  function mockBundledPluginMetadata() {
    vi.doMock("../plugins/bundled-plugin-metadata.js", () => ({
      listBundledPluginMetadata: () => [
        {
          manifest: {
            channelConfigs: {
              msteams: { schema: { type: "object" }, runtime: {} },
              whatsapp: { schema: { type: "object" } },
            },
          },
        },
      ],
    }));
  }

  it("tolerates an unavailable bundled channel list during import", async () => {
    mockBundledPluginMetadata();
    vi.doMock("../channels/plugins/bundled.js", () => ({
      listBundledChannelPlugins: () => undefined,
    }));

    const runtimeModule = await importFreshModule<
      typeof import("../../test/helpers/config/bundled-channel-config-runtime.js")
    >(
      import.meta.url,
      "../../test/helpers/config/bundled-channel-config-runtime.js?scope=missing-bundled-list",
    );

    expect(runtimeModule.getBundledChannelConfigSchemaMap().get("msteams")).toMatchObject({
      schema: { type: "object" },
      runtime: {},
    });
    expect(runtimeModule.getBundledChannelRuntimeMap().get("msteams")).toStrictEqual({});
  });

  it("falls back to static channel schemas when bundled plugin access hits a TDZ-style ReferenceError", async () => {
    mockBundledPluginMetadata();
    vi.doMock("../channels/plugins/bundled.js", () => {
      return {
        listBundledChannelPlugins() {
          throw new ReferenceError("Cannot access 'bundledChannelPlugins' before initialization.");
        },
      };
    });

    const runtime = await importFreshModule<
      typeof import("../../test/helpers/config/bundled-channel-config-runtime.js")
    >(
      import.meta.url,
      "../../test/helpers/config/bundled-channel-config-runtime.js?scope=tdz-reference-error",
    );
    const configSchemaMap = runtime.getBundledChannelConfigSchemaMap();

    expect(configSchemaMap.has("msteams")).toBe(true);
    expect(configSchemaMap.has("whatsapp")).toBe(true);
  });
});
