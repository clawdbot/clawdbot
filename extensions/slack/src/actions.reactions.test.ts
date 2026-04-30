import type { WebClient } from "@slack/web-api";
import { describe, expect, it, vi } from "vitest";
import { reactSlackMessage } from "./actions.js";

function createClient() {
  return {
    reactions: {
      add: vi.fn(async () => ({})),
    },
  } as unknown as WebClient & {
    reactions: {
      add: ReturnType<typeof vi.fn>;
    };
  };
}

function slackPlatformError(error: string) {
  return Object.assign(new Error(`An API error occurred: ${error}`), {
    data: {
      ok: false,
      error,
    },
  });
}

describe("reactSlackMessage", () => {
  it("treats already_reacted as idempotent success", async () => {
    const client = createClient();
    client.reactions.add.mockRejectedValueOnce(slackPlatformError("already_reacted"));

    await expect(
      reactSlackMessage("C1", "123.456", ":white_check_mark:", {
        client,
        token: "xoxb-test",
      }),
    ).resolves.toBeUndefined();

    expect(client.reactions.add).toHaveBeenCalledWith({
      channel: "C1",
      timestamp: "123.456",
      name: "white_check_mark",
    });
  });

  it("propagates unrelated reaction add errors", async () => {
    const client = createClient();
    client.reactions.add.mockRejectedValueOnce(slackPlatformError("invalid_name"));

    await expect(
      reactSlackMessage("C1", "123.456", "not-an-emoji", {
        client,
        token: "xoxb-test",
      }),
    ).rejects.toMatchObject({
      data: {
        error: "invalid_name",
      },
    });
  });
});
