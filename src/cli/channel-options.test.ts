import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __testing, resolveCliChannelOptions } from "./channel-options.js";
import { __testing as startupMetadataTesting } from "./startup-metadata.js";

const readFileSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  const base = ("default" in actual ? actual.default : actual) as Record<string, unknown>;
  return {
    ...actual,
    default: {
      ...base,
      readFileSync: readFileSyncMock,
    },
    readFileSync: readFileSyncMock,
  };
});

vi.mock("../channels/ids.js", () => ({
  CHAT_CHANNEL_ORDER: ["quietchat", "forum"],
}));

describe("resolveCliChannelOptions", () => {
  beforeEach(() => {
    __testing.resetPrecomputedChannelOptionsForTests();
    startupMetadataTesting.clearStartupMetadataCache();
    vi.clearAllMocks();
  });

  afterEach(() => {
    __testing.resetPrecomputedChannelOptionsForTests();
    delete process.env.OPENCLAW_PLUGIN_CATALOG_PATHS;
  });

  it("uses precomputed startup metadata when available", async () => {
    readFileSyncMock.mockReturnValue(
      JSON.stringify({ channelOptions: ["cached", "quietchat", "cached"] }),
    );

    expect(resolveCliChannelOptions()).toEqual(["cached", "quietchat"]);
  });

  it("falls back to core channel order when metadata is missing", async () => {
    readFileSyncMock.mockImplementation(() => {
      throw new Error("ENOENT");
    });

    expect(resolveCliChannelOptions()).toEqual(["quietchat", "forum"]);
  });

  it("ignores external catalog env during CLI bootstrap", async () => {
    process.env.OPENCLAW_PLUGIN_CATALOG_PATHS = "/tmp/plugins-catalog.json";
    readFileSyncMock.mockReturnValue(JSON.stringify({ channelOptions: ["cached", "quietchat"] }));

    expect(resolveCliChannelOptions()).toEqual(["cached", "quietchat"]);
  });
});
