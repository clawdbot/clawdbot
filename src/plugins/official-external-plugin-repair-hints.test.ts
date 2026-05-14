import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveMissingOfficialExternalChannelPluginRepairHint } from "./official-external-plugin-repair-hints.js";

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

  it("prefers the ClawHub install hint for externalized WhatsApp", () => {
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
      installSpec: "clawhub:@openclaw/whatsapp",
      installCommand: "openclaw plugins install clawhub:@openclaw/whatsapp",
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
