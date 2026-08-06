import { type GatewayPresenceUpdate, PresenceUpdateStatus } from "discord-api-types/v10";
import { describe, expect, it } from "vitest";
import {
  DISCORD_PRESENCE_GREETING_COOLDOWN_MS,
  resolveDiscordOnlinePresenceEvent,
} from "./presence-events.js";

function presence(
  status: "online" | "idle" | "dnd" | "offline",
  overrides: Partial<GatewayPresenceUpdate["user"]> = {},
): GatewayPresenceUpdate {
  const statuses = {
    online: PresenceUpdateStatus.Online,
    idle: PresenceUpdateStatus.Idle,
    dnd: PresenceUpdateStatus.DoNotDisturb,
    offline: PresenceUpdateStatus.Offline,
  } as const;
  return {
    guild_id: "guild-1",
    status: statuses[status],
    activities: [],
    client_status: {},
    user: { id: "user-1", username: "Alice", ...overrides },
  };
}

const config = { channelId: "channel-1" };

describe("resolveDiscordOnlinePresenceEvent", () => {
  it("emits for an observed offline-to-online human transition", () => {
    const result = resolveDiscordOnlinePresenceEvent({
      config,
      data: presence("online", { global_name: "Alice Example" }),
      availabilityKind: "observed-offline",
      botUserId: "bot-1",
      nowMs: 1_000,
    });

    expect(result).toMatchObject({ channelId: "channel-1", userId: "user-1" });
    expect(result?.text).toContain('user_id="user-1"');
    expect(result?.text).not.toContain("Alice Example");
    expect(result?.text).toContain("retrieve relevant memory and wiki context");
    expect(result?.text).toContain("after being observed offline");
  });

  it("does not overstate prior status for first-seen members", () => {
    const result = resolveDiscordOnlinePresenceEvent({
      config,
      data: presence("online"),
      availabilityKind: "first-seen-after-snapshot",
      nowMs: 1_000,
    });

    expect(result?.text).toContain("may have come online or joined after the snapshot");
    expect(result?.text).toContain("do not claim an exact prior status");
  });

  it("suppresses unchanged online states", () => {
    expect(
      resolveDiscordOnlinePresenceEvent({
        config,
        data: presence("online"),
        availabilityKind: null,
        nowMs: 1_000,
      }),
    ).toBeNull();
    expect(
      resolveDiscordOnlinePresenceEvent({
        config,
        data: presence("idle"),
        availabilityKind: null,
        nowMs: 1_000,
      }),
    ).toBeNull();
  });

  it("requires the caller to classify an availability transition", () => {
    expect(
      resolveDiscordOnlinePresenceEvent({
        config,
        data: presence("online"),
        availabilityKind: null,
        nowMs: 1_000,
      }),
    ).toBeNull();
  });

  it("honors immutable user allowlists, bot exclusion, and cooldown", () => {
    const base = {
      data: presence("online"),
      availabilityKind: "observed-offline" as const,
      nowMs: DISCORD_PRESENCE_GREETING_COOLDOWN_MS,
    };
    expect(
      resolveDiscordOnlinePresenceEvent({ ...base, config: { ...config, users: ["other"] } }),
    ).toBeNull();
    expect(
      resolveDiscordOnlinePresenceEvent({ ...base, config: { ...config, users: [] } }),
    ).toBeNull();
    expect(
      resolveDiscordOnlinePresenceEvent({
        ...base,
        config,
        data: presence("online", { bot: true }),
      }),
    ).toBeNull();
    expect(
      resolveDiscordOnlinePresenceEvent({
        ...base,
        config,
        lastEmittedAtMs: 1,
      }),
    ).toBeNull();
  });
});
