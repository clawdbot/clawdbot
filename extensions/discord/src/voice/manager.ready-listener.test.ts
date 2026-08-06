// Discord tests cover manager.ready listener plugin behavior.
import { describe, expect, it, vi } from "vitest";
import { GatewayDispatchEvents } from "../internal/discord.js";
import {
  DiscordVoiceGuildCreateListener,
  DiscordVoiceReadyListener,
  DiscordVoiceResumedListener,
  DiscordVoiceStateUpdateListener,
} from "./manager.js";

describe("DiscordVoiceReadyListener", () => {
  it("starts auto-join without blocking the ready listener", async () => {
    let resolveJoin: (() => void) | undefined;
    const autoJoin = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveJoin = resolve;
        }),
    );
    const listener = new DiscordVoiceReadyListener({
      autoJoin,
    } as unknown as ConstructorParameters<typeof DiscordVoiceReadyListener>[0]);

    const result = listener.handle({} as never, {} as never);

    await expect(result).resolves.toBeUndefined();
    expect(autoJoin).toHaveBeenCalledTimes(1);

    resolveJoin?.();
  });

  it("starts auto-join after Discord gateway resumes", async () => {
    const autoJoin = vi.fn(async () => {});
    const listener = new DiscordVoiceResumedListener({
      autoJoin,
    } as unknown as ConstructorParameters<typeof DiscordVoiceResumedListener>[0]);

    await expect(listener.handle({} as never, {} as never)).resolves.toBeUndefined();

    expect(listener.type).toBe(GatewayDispatchEvents.Resumed);
    expect(autoJoin).toHaveBeenCalledTimes(1);
  });

  it("refreshes active voice rosters after an available guild snapshot", async () => {
    const refreshGuildRoster = vi.fn();
    const listener = new DiscordVoiceGuildCreateListener({
      refreshGuildRoster,
    } as unknown as ConstructorParameters<typeof DiscordVoiceGuildCreateListener>[0]);

    await expect(
      listener.handle({ id: "g1", unavailable: false } as never, {} as never),
    ).resolves.toBeUndefined();

    expect(listener.type).toBe(GatewayDispatchEvents.GuildCreate);
    expect(refreshGuildRoster).toHaveBeenCalledWith("g1");
  });

  it("ignores unavailable guild snapshots", async () => {
    const refreshGuildRoster = vi.fn();
    const listener = new DiscordVoiceGuildCreateListener({
      refreshGuildRoster,
    } as unknown as ConstructorParameters<typeof DiscordVoiceGuildCreateListener>[0]);

    await expect(
      listener.handle({ id: "g1", unavailable: true } as never, {} as never),
    ).resolves.toBeUndefined();

    expect(refreshGuildRoster).not.toHaveBeenCalled();
  });

  it("forwards bot voice state updates to the voice manager", async () => {
    const handleVoiceStateUpdate = vi.fn(async () => {});
    const listener = new DiscordVoiceStateUpdateListener({
      handleVoiceStateUpdate,
    } as unknown as ConstructorParameters<typeof DiscordVoiceStateUpdateListener>[0]);
    const payload = { guild_id: "g1", user_id: "bot", channel_id: "1001" };
    const previous = { guild_id: "g1", user_id: "bot", channel_id: "1000" };
    const client = {
      getPlugin: vi.fn(() => ({
        takeVoiceStateTransition: vi.fn(() => ({ current: payload, previous })),
      })),
    };

    await expect(listener.handle(payload as never, client as never)).resolves.toBeUndefined();

    expect(listener.type).toBe(GatewayDispatchEvents.VoiceStateUpdate);
    expect(handleVoiceStateUpdate).toHaveBeenCalledWith(payload, previous);
  });
});
