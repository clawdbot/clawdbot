import { describe, expect, it, vi } from "vitest";
import { DiscordVoiceReadyListener } from "./manager.js";

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
});
