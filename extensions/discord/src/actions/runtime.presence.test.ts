import type { ActionGate } from "openclaw/plugin-sdk/channel-actions";
// Discord tests cover runtime.presence plugin behavior.
import type { DiscordActionConfig, OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayPlugin } from "../internal/gateway.js";
import { clearGateways, registerGateway } from "../monitor/gateway-registry.js";
import { handleDiscordAction } from "./runtime.js";
import { handleDiscordPresenceAction } from "./runtime.presence.js";

const mockUpdatePresence = vi.fn();

function createMockGateway(connected = true): GatewayPlugin {
  return { isConnected: connected, updatePresence: mockUpdatePresence } as unknown as GatewayPlugin;
}

const presenceEnabled: ActionGate<DiscordActionConfig> = (key) => key === "presence";
const presenceDisabled: ActionGate<DiscordActionConfig> = () => false;
const defaultDiscordConfig = {
  channels: { discord: { token: "test-token", actions: { presence: true } } },
} as OpenClawConfig;

describe("handleDiscordPresenceAction", () => {
  async function setPresence(
    params: Record<string, unknown>,
    actionGate: ActionGate<DiscordActionConfig> = presenceEnabled,
  ) {
    return await handleDiscordPresenceAction(
      "setPresence",
      params,
      actionGate,
      defaultDiscordConfig,
    );
  }

  beforeEach(() => {
    mockUpdatePresence.mockClear();
    clearGateways();
    registerGateway("default", createMockGateway());
  });

  it("sets playing activity", async () => {
    const result = await handleDiscordPresenceAction(
      "setPresence",
      { activityType: "playing", activityName: "with fire", status: "online" },
      presenceEnabled,
      defaultDiscordConfig,
    );
    expect(mockUpdatePresence).toHaveBeenCalledWith({
      since: null,
      activities: [{ name: "with fire", type: 0 }],
      status: "online",
      afk: false,
    });
    const textBlock = result.content.find((block) => block.type === "text");
    const payload = JSON.parse(
      (textBlock as { type: "text"; text: string } | undefined)?.text ?? "{}",
    );
    expect(payload.ok).toBe(true);
    expect(payload.activities[0]).toEqual({ type: 0, name: "with fire" });
  });

  it.each([
    {
      name: "streaming activity with URL",
      params: {
        activityType: "streaming",
        activityName: "My Stream",
        activityUrl: "https://twitch.tv/example",
      },
      expectedActivities: [{ name: "My Stream", type: 1, url: "https://twitch.tv/example" }],
    },
    {
      name: "streaming activity without URL",
      params: { activityType: "streaming", activityName: "My Stream" },
      expectedActivities: [{ name: "My Stream", type: 1 }],
    },
    {
      name: "listening activity",
      params: { activityType: "listening", activityName: "Spotify" },
      expectedActivities: [{ name: "Spotify", type: 2 }],
    },
    {
      name: "watching activity",
      params: { activityType: "watching", activityName: "you" },
      expectedActivities: [{ name: "you", type: 3 }],
    },
    {
      name: "custom activity using state",
      params: { activityType: "custom", activityState: "Vibing" },
      expectedActivities: [{ name: "", type: 4, state: "Vibing" }],
    },
    {
      name: "activity with state",
      params: { activityType: "playing", activityName: "My Game", activityState: "In the lobby" },
      expectedActivities: [{ name: "My Game", type: 0, state: "In the lobby" }],
    },
    {
      name: "default empty activity name when only type provided",
      params: { activityType: "playing" },
      expectedActivities: [{ name: "", type: 0 }],
    },
  ])("sets $name", async ({ params, expectedActivities }) => {
    await setPresence(params);
    expect(mockUpdatePresence).toHaveBeenCalledWith({
      since: null,
      activities: expectedActivities,
      status: "online",
      afk: false,
    });
  });

  it("sets status-only without activity", async () => {
    await setPresence({ status: "idle" });
    expect(mockUpdatePresence).toHaveBeenCalledWith({
      since: null,
      activities: [],
      status: "idle",
      afk: false,
    });
  });

  it.each([
    { name: "invalid status", params: { status: "offline" }, expectedMessage: /Invalid status/ },
    {
      name: "invalid activity type",
      params: { activityType: "invalid" },
      expectedMessage: /Invalid activityType/,
    },
  ])("rejects $name", async ({ params, expectedMessage }) => {
    await expect(setPresence(params)).rejects.toThrow(expectedMessage);
  });

  it("defaults status to online", async () => {
    await setPresence({ activityType: "playing", activityName: "test" });
    expect(mockUpdatePresence).toHaveBeenCalledWith({
      since: null,
      activities: [{ name: "test", type: 0 }],
      status: "online",
      afk: false,
    });
  });

  it("respects presence gating", async () => {
    await expect(setPresence({ status: "online" }, presenceDisabled)).rejects.toThrow(/disabled/);
  });

  it("errors when gateway is not registered", async () => {
    clearGateways();
    await expect(setPresence({ status: "dnd" })).rejects.toThrow(/not available/);
  });

  it("errors when gateway is not connected", async () => {
    clearGateways();
    registerGateway("default", createMockGateway(false));
    await expect(setPresence({ status: "dnd" })).rejects.toThrow(/not connected/);
  });

  it.each([
    { name: "implicit default account", cfg: defaultDiscordConfig, accountId: "default" },
    {
      name: "configured named default account",
      cfg: {
        channels: {
          discord: {
            actions: { presence: true },
            defaultAccount: "ops",
            accounts: { ops: { token: "ops-token" } },
          },
        },
      } as OpenClawConfig,
      accountId: "ops",
    },
    {
      name: "explicit named account override",
      cfg: {
        channels: {
          discord: {
            token: "default-token",
            actions: { presence: true },
            accounts: { ops: { token: "ops-token" } },
          },
        },
      } as OpenClawConfig,
      accountId: "ops",
      requestedAccountId: "ops",
    },
  ])(
    "routes the full presence action to the $name",
    async ({ cfg, accountId, requestedAccountId }) => {
      const updatePresence = vi.fn();
      registerGateway(accountId, {
        isConnected: true,
        updatePresence,
      } as unknown as GatewayPlugin);

      await handleDiscordAction(
        {
          action: "setPresence",
          status: "idle",
          ...(requestedAccountId ? { accountId: requestedAccountId } : {}),
        },
        cfg,
      );

      expect(updatePresence).toHaveBeenCalledWith({
        since: null,
        activities: [],
        status: "idle",
        afk: false,
      });
    },
  );

  it("requires activityType when activityName is provided", async () => {
    await expect(setPresence({ activityName: "My Game" })).rejects.toThrow(
      /activityType is required/,
    );
  });

  it("rejects unknown presence actions", async () => {
    await expect(
      handleDiscordPresenceAction("unknownAction", {}, presenceEnabled, defaultDiscordConfig),
    ).rejects.toThrow(/Unknown presence action/);
  });
});
