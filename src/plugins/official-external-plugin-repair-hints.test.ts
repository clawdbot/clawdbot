// Covers repair hints for official external plugin installs.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveExternalPluginRuntimeDependencyRepairHint,
  resolveMissingOfficialExternalChannelPluginRepairHint,
  resolveMissingOfficialExternalChannelPluginRepairHints,
} from "./official-external-plugin-repair-hints.js";

const mocks = vi.hoisted(() => ({
  resolveConfiguredChannelPresencePolicy: vi.fn(),
}));

vi.mock("./channel-plugin-ids.js", () => ({
  resolveConfiguredChannelPresencePolicy: (params: unknown) =>
    mocks.resolveConfiguredChannelPresencePolicy(params),
}));

describe("resolveMissingOfficialExternalChannelPluginRepairHint", () => {
  beforeEach(() => {
    mocks.resolveConfiguredChannelPresencePolicy.mockReset();
  });

  it("returns an install hint when a configured official external channel has no owner", () => {
    mocks.resolveConfiguredChannelPresencePolicy.mockReturnValue([
      {
        channelId: "feishu",
        sources: ["explicit-config"],
        effective: false,
        pluginIds: [],
        blockedReasons: ["no-channel-owner"],
      },
    ]);

    expect(
      resolveMissingOfficialExternalChannelPluginRepairHint({
        config: { channels: { feishu: { appId: "cli_xxx" } } },
        channelId: "feishu",
      }),
    ).toEqual({
      pluginId: "feishu",
      channelId: "feishu",
      label: "Feishu",
      installSpec: "@openclaw/feishu",
      installCommand: "openclaw plugins install @openclaw/feishu",
      doctorFixCommand: "openclaw doctor --fix",
      repairHint:
        "Install the official external plugin with: openclaw plugins install @openclaw/feishu, or run: openclaw doctor --fix.",
    });
  });

  it("resolves multiple channel hints with one presence-policy pass", () => {
    mocks.resolveConfiguredChannelPresencePolicy.mockReturnValue([
      {
        channelId: "feishu",
        sources: ["explicit-config"],
        effective: false,
        pluginIds: [],
        blockedReasons: ["no-channel-owner"],
      },
      {
        channelId: "whatsapp",
        sources: ["explicit-config"],
        effective: false,
        pluginIds: [],
        blockedReasons: ["no-channel-owner"],
      },
    ]);

    expect(
      resolveMissingOfficialExternalChannelPluginRepairHints({
        config: { channels: { feishu: {}, whatsapp: {} } },
        channelIds: ["feishu", "whatsapp"],
      }).map((hint) => hint.channelId),
    ).toEqual(["feishu", "whatsapp"]);
    expect(mocks.resolveConfiguredChannelPresencePolicy).toHaveBeenCalledTimes(1);
  });

  it("skips presence policy when no channel ids need repair hints", () => {
    expect(
      resolveMissingOfficialExternalChannelPluginRepairHints({
        config: {},
        channelIds: [],
      }),
    ).toEqual([]);
    expect(mocks.resolveConfiguredChannelPresencePolicy).not.toHaveBeenCalled();
  });

  it("prefers the npm install hint for externalized WhatsApp", () => {
    mocks.resolveConfiguredChannelPresencePolicy.mockReturnValue([
      {
        channelId: "whatsapp",
        sources: ["explicit-config"],
        effective: false,
        pluginIds: [],
        blockedReasons: ["no-channel-owner"],
      },
    ]);

    expect(
      resolveMissingOfficialExternalChannelPluginRepairHint({
        config: { channels: { whatsapp: { enabled: true } } },
        channelId: "whatsapp",
      }),
    ).toMatchObject({
      pluginId: "whatsapp",
      channelId: "whatsapp",
      label: "WhatsApp",
      installSpec: "@openclaw/whatsapp",
      installCommand: "openclaw plugins install @openclaw/whatsapp",
    });
  });

  it("does not return install hints for policy-blocked official external channel owners", () => {
    mocks.resolveConfiguredChannelPresencePolicy.mockReturnValue([
      {
        channelId: "whatsapp",
        sources: ["explicit-config"],
        effective: false,
        pluginIds: [],
        blockedReasons: ["not-in-allowlist"],
      },
    ]);

    expect(
      resolveMissingOfficialExternalChannelPluginRepairHint({
        config: { channels: { whatsapp: { enabled: true } } },
        channelId: "whatsapp",
      }),
    ).toBeNull();
  });

  it("does not return install hints for active official external channel owners", () => {
    mocks.resolveConfiguredChannelPresencePolicy.mockReturnValue([
      {
        channelId: "whatsapp",
        sources: ["explicit-config"],
        effective: true,
        pluginIds: ["whatsapp"],
        blockedReasons: [],
      },
    ]);

    expect(
      resolveMissingOfficialExternalChannelPluginRepairHint({
        config: { channels: { whatsapp: { enabled: true } } },
        channelId: "whatsapp",
      }),
    ).toBeNull();
  });
});

describe("resolveExternalPluginRuntimeDependencyRepairHint", () => {
  it.each([
    {
      name: "names the official install command for the package that owns the id",
      candidate: { pluginId: "discord", packageName: "@openclaw/discord" },
      expected: "openclaw plugins install @openclaw/discord",
    },
    {
      name: "withholds the official install command from a foreign package reusing the id",
      candidate: {
        pluginId: "discord",
        packageName: "@example/discord-fork",
        packageBuild: { bundledDist: false },
      },
      expected: "reinstall or update the plugin package",
    },
  ])("$name", ({ candidate, expected }) => {
    const hint = resolveExternalPluginRuntimeDependencyRepairHint(candidate);
    expect(hint).toContain("runtime dependencies are missing");
    expect(hint).toContain(expected);
  });

  it("stays silent for plugins shipped inside the root package", () => {
    expect(
      resolveExternalPluginRuntimeDependencyRepairHint({
        pluginId: "telegram",
        packageName: "@openclaw/telegram",
      }),
    ).toBeUndefined();
  });
});
