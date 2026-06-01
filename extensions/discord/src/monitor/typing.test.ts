import { Routes } from "discord-api-types/v10";
import { describe, expect, it, vi } from "vitest";
import { RequestClient } from "../internal/discord.js";
import { sendTyping } from "./typing.js";

describe("sendTyping", () => {
  it("uses the direct Discord typing REST endpoint", async () => {
    const rest = new RequestClient("test-token");
    const post = vi.spyOn(rest, "post").mockResolvedValue(undefined);

    await sendTyping({
      rest,
      channelId: "12345",
    });

    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith(Routes.channelTyping("12345"));
  });

  it("times out when the typing endpoint hangs", async () => {
    vi.useFakeTimers();
    try {
      const rest = new RequestClient("test-token");
      vi.spyOn(rest, "post").mockReturnValue(new Promise(() => {}));

      const promise = sendTyping({
        rest,
        channelId: "12345",
      });
      const rejection = expect(promise).rejects.toThrow("discord typing start timed out");

      await vi.advanceTimersByTimeAsync(5_000);

      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });
});
