import { beforeEach, describe, expect, it, vi } from "vitest";
import { collectChannelDoctorCompatibilityMutations } from "./channel-doctor.js";

const mocks = vi.hoisted(() => ({
  getChannelPlugin: vi.fn(),
  getBundledChannelPlugin: vi.fn(),
  listChannelPlugins: vi.fn(),
  listBundledChannelPlugins: vi.fn(),
}));

vi.mock("../../../channels/plugins/registry.js", () => ({
  getChannelPlugin: (...args: Parameters<typeof mocks.getChannelPlugin>) =>
    mocks.getChannelPlugin(...args),
  listChannelPlugins: (...args: Parameters<typeof mocks.listChannelPlugins>) =>
    mocks.listChannelPlugins(...args),
}));

vi.mock("../../../channels/plugins/bundled.js", () => ({
  getBundledChannelPlugin: (...args: Parameters<typeof mocks.getBundledChannelPlugin>) =>
    mocks.getBundledChannelPlugin(...args),
  listBundledChannelPlugins: (...args: Parameters<typeof mocks.listBundledChannelPlugins>) =>
    mocks.listBundledChannelPlugins(...args),
}));

describe("channel doctor compatibility mutations", () => {
  beforeEach(() => {
    mocks.getChannelPlugin.mockReset();
    mocks.getBundledChannelPlugin.mockReset();
    mocks.listChannelPlugins.mockReset();
    mocks.listBundledChannelPlugins.mockReset();
    mocks.getChannelPlugin.mockReturnValue(undefined);
    mocks.getBundledChannelPlugin.mockReturnValue(undefined);
    mocks.listChannelPlugins.mockReturnValue([]);
    mocks.listBundledChannelPlugins.mockReturnValue([]);
  });

  it("skips plugin discovery when no channels are configured", () => {
    const result = collectChannelDoctorCompatibilityMutations({} as never);

    expect(result).toEqual([]);
    expect(mocks.listChannelPlugins).not.toHaveBeenCalled();
    expect(mocks.listBundledChannelPlugins).not.toHaveBeenCalled();
  });

  it("only evaluates configured channel ids", () => {
    const normalizeCompatibilityConfig = vi.fn(({ cfg }: { cfg: unknown }) => ({
      config: cfg,
      changes: ["matrix"],
    }));
    mocks.getBundledChannelPlugin.mockImplementation((id: string) =>
      id === "matrix"
        ? {
            id: "matrix",
            doctor: { normalizeCompatibilityConfig },
          }
        : undefined,
    );

    const cfg = {
      channels: {
        matrix: {
          enabled: true,
        },
      },
    };

    const result = collectChannelDoctorCompatibilityMutations(cfg as never);

    expect(result).toHaveLength(1);
    expect(normalizeCompatibilityConfig).toHaveBeenCalledTimes(1);
    expect(mocks.getChannelPlugin).toHaveBeenCalledWith("matrix");
    expect(mocks.getBundledChannelPlugin).toHaveBeenCalledWith("matrix");
    expect(mocks.getBundledChannelPlugin).not.toHaveBeenCalledWith("discord");
    expect(mocks.listBundledChannelPlugins).not.toHaveBeenCalled();
  });
});
