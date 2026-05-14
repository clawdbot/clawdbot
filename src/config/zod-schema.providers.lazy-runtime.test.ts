import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { beforeEach, describe, expect, it, vi } from "vitest";

const loadPluginMetadataSnapshotMock = vi.hoisted(() => vi.fn());
const collectBundledChannelConfigsMock = vi.hoisted(() => vi.fn());

describe("ChannelsSchema bundled runtime loading", () => {
  beforeEach(() => {
    loadPluginMetadataSnapshotMock.mockClear();
    collectBundledChannelConfigsMock.mockClear();
    vi.doMock("../plugins/plugin-metadata-snapshot.js", () => ({
      loadPluginMetadataSnapshot: loadPluginMetadataSnapshotMock,
    }));
    vi.doMock("../plugins/bundled-channel-config-metadata.js", () => ({
      collectBundledChannelConfigs: collectBundledChannelConfigsMock,
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
        botLoopProtection: {
          maxEventsPerWindow: 4,
          windowSeconds: 90,
          cooldownSeconds: 30,
        },
      },
      modelByChannel: {
        telegram: {
          primary: "gpt-5.4",
        },
      },
    });

    expect(parsed?.defaults?.groupPolicy).toBe("open");
    expect(parsed?.defaults?.botLoopProtection?.maxEventsPerWindow).toBe(4);
    expect(loadPluginMetadataSnapshotMock).not.toHaveBeenCalled();
    expect(collectBundledChannelConfigsMock).not.toHaveBeenCalled();
  });

  it("does not discover bundled channel runtime metadata during raw schema parsing", async () => {
    const runtime = await importFreshModule<typeof import("./zod-schema.providers.js")>(
      import.meta.url,
      "./zod-schema.providers.js?scope=channels-plugin-owned",
    );

    runtime.ChannelsSchema.parse({
      discord: {},
    });

    expect(loadPluginMetadataSnapshotMock).not.toHaveBeenCalled();
    expect(collectBundledChannelConfigsMock).not.toHaveBeenCalled();
  });
});
