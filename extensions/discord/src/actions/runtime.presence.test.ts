import type { GatewayPlugin } from "@buape/carbon/gateway";
import type { DiscordActionConfig } from "openclaw/plugin-sdk/config-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearGateways, registerGateway } from "../monitor/gateway-registry.js";
import type { ActionGate } from "../runtime-api.js";
import { handleDiscordPresenceAction } from "./runtime.presence.js";

const mockUpdatePresence = vi.fn();

function createMockGateway(connected = true): GatewayPlugin {
  return { isConnected: connected, updatePresence: mockUpdatePresence } as unknown as GatewayPlugin;
}

const presenceEnabled: ActionGate<DiscordActionConfig> = (key) => key === "presence";
const presenceDisabled: ActionGate<DiscordActionConfig> = () => false;

describe("handleDiscordPresenceAction", () => {
  async function setPresence(
    params: Record<string, unknown>,
    actionGate: ActionGate<DiscordActionConfig> = presenceEnabled,
  ) {
    return await handleDiscordPresenceAction("setPresence", params, actionGate);
  }

  beforeEach(() => {
    mockUpdatePresence.mockClear();
    clearGateways();
    registerGateway(undefined, createMockGateway());
  });

  it("sets playing activity", async () => {
    const result = await handleDiscordPresenceAction(
      "setPresence",
      { activityType: "playing", activityName: "with fire", status: "online" },
      presenceEnabled,
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
    expect(mockUpdatePresence).toHaveBeenCalledWith(expect.objectContaining({ status: "online" }));
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
    registerGateway(undefined, createMockGateway(false));
    await expect(setPresence({ status: "dnd" })).rejects.toThrow(/not connected/);
  });

  it("uses accountId to resolve gateway", async () => {
    const accountGateway = createMockGateway();
    registerGateway("my-account", accountGateway);
    await setPresence({ accountId: "my-account", activityType: "playing", activityName: "test" });
    expect(mockUpdatePresence).toHaveBeenCalled();
  });

  it("requires activityType when activityName is provided", async () => {
    await expect(setPresence({ activityName: "My Game" })).rejects.toThrow(
      /activityType is required/,
    );
  });

  it("rejects unknown presence actions", async () => {
    await expect(handleDiscordPresenceAction("unknownAction", {}, presenceEnabled)).rejects.toThrow(
      /Unknown presence action/,
    );
  });
});
