import { Routes } from "discord-api-types/v10";
import { describe, expect, it, vi } from "vitest";
import { sendTyping } from "./typing.js";

describe("sendTyping", () => {
  it("uses the direct Discord typing REST endpoint", async () => {
    const rest = {
      post: vi.fn(async () => {}),
    };

    await sendTyping({
      // @ts-expect-error test stub only needs rest.post
      rest,
      channelId: "12345",
    });

    expect(rest.post).toHaveBeenCalledTimes(1);
    expect(rest.post).toHaveBeenCalledWith(Routes.channelTyping("12345"));
  });

  it("times out when the typing endpoint hangs", async () => {
    vi.useFakeTimers();
    try {
      const rest = {
        post: vi.fn(() => new Promise(() => {})),
      };

      const promise = sendTyping({
        // @ts-expect-error test stub only needs rest.post
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
