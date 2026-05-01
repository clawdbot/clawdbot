import { describe, expect, it, vi } from "vitest";
import { GatewayDispatchEvents } from "../internal/discord.js";
import { DiscordVoiceReadyListener, DiscordVoiceResumedListener } from "./manager.js";

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
});
