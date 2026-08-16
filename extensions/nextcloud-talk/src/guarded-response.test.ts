import { describe, expect, it, vi } from "vitest";
import { releaseNextcloudTalkGuardedResponse } from "./guarded-response.js";

describe("releaseNextcloudTalkGuardedResponse", () => {
  it("cancels an unread body before releasing the guard", async () => {
    const events: string[] = [];
    const response = new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          events.push("cancel");
        },
      }),
    );

    await releaseNextcloudTalkGuardedResponse({
      response,
      release: async () => {
        events.push("release");
      },
    });

    expect(events).toEqual(["cancel", "release"]);
  });

  it("still releases when body cancellation fails", async () => {
    const response = new Response(new ReadableStream<Uint8Array>());
    vi.spyOn(response.body!, "cancel").mockRejectedValueOnce(new Error("cancel failed"));
    const release = vi.fn(async () => {});

    await expect(
      releaseNextcloudTalkGuardedResponse({ response, release }),
    ).resolves.toBeUndefined();
    expect(release).toHaveBeenCalledOnce();
  });

  it("does not cancel a body the caller already consumed", async () => {
    const response = new Response("done");
    const cancel = vi.spyOn(response.body!, "cancel");
    await response.text();
    const release = vi.fn(async () => {});

    await releaseNextcloudTalkGuardedResponse({ response, release });

    expect(cancel).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });
});
