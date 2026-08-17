// Channel option tests cover channel command option parsing and config resolution.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { formatCliChannelOptions, resolveCliChannelOptions } from "./channel-options.js";

const readCliStartupMetadata = vi.hoisted(() => vi.fn());

vi.mock("./startup-metadata.js", () => ({ readCliStartupMetadata }));

describe("resolveCliChannelOptions", () => {
  beforeEach(() => {
    readCliStartupMetadata.mockReset();
  });

  it("uses precomputed startup metadata when available", () => {
    readCliStartupMetadata.mockReturnValue({
      channelOptions: ["cached", "", false, "quietchat", "cached"],
    });

    expect(resolveCliChannelOptions()).toEqual(["cached", "quietchat"]);
    expect(formatCliChannelOptions(["all"])).toBe("all|cached|quietchat");
  });

  it("falls back to generic channel text when metadata is missing", () => {
    readCliStartupMetadata.mockReturnValue(null);

    expect(resolveCliChannelOptions()).toEqual([]);
    expect(formatCliChannelOptions()).toBe("channel");
    expect(formatCliChannelOptions(["all"])).toBe("all");
  });
});
