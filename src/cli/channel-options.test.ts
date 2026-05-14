import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __testing, formatCliChannelOptions, resolveCliChannelOptions } from "./channel-options.js";
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

  it("uses precomputed startup metadata when available", () => {
    readFileSyncMock.mockReturnValue(
      JSON.stringify({ channelOptions: ["cached", "quietchat", "cached"] }),
    );

    expect(resolveCliChannelOptions()).toEqual(["cached", "quietchat"]);
    expect(formatCliChannelOptions(["all"])).toBe("all|cached|quietchat");
  });

  it("falls back to generic channel text when metadata is missing", () => {
    readFileSyncMock.mockImplementation(() => {
      throw new Error("ENOENT");
    });

    expect(resolveCliChannelOptions()).toEqual([]);
    expect(formatCliChannelOptions()).toBe("channel");
    expect(formatCliChannelOptions(["all"])).toBe("all");
  });

  it("ignores external catalog env during CLI bootstrap", () => {
    process.env.OPENCLAW_PLUGIN_CATALOG_PATHS = "/tmp/plugins-catalog.json";
    readFileSyncMock.mockReturnValue(JSON.stringify({ channelOptions: ["cached", "quietchat"] }));

    expect(resolveCliChannelOptions()).toEqual(["cached", "quietchat"]);
  });
});
