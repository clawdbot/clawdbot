import type { WebClient } from "@slack/web-api";
import { describe, expect, it, vi } from "vitest";
import { reactSlackMessage, removeOwnSlackReactions, removeSlackReaction } from "./actions.js";

function createClient() {
  return {
    auth: {
      test: vi.fn(async () => ({ user_id: "UBOT" })),
    },
    reactions: {
      add: vi.fn(async () => ({})),
      get: vi.fn(async () => ({
        message: {
          reactions: [],
        },
      })),
      remove: vi.fn(async () => ({})),
    },
  } as unknown as WebClient & {
    auth: {
      test: ReturnType<typeof vi.fn>;
    };
    reactions: {
      add: ReturnType<typeof vi.fn>;
      get: ReturnType<typeof vi.fn>;
      remove: ReturnType<typeof vi.fn>;
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

    let error: unknown;
    try {
      await reactSlackMessage("C1", "123.456", "not-an-emoji", {
        client,
        token: "xoxb-test",
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("An API error occurred: invalid_name");
    expect((error as { data?: unknown }).data).toEqual({
      ok: false,
      error: "invalid_name",
    });
  });
});

describe("removeSlackReaction", () => {
  it("treats no_reaction as idempotent success", async () => {
    const client = createClient();
    client.reactions.remove.mockRejectedValueOnce(slackPlatformError("no_reaction"));

    await expect(
      removeSlackReaction("C1", "123.456", ":white_check_mark:", {
        client,
        token: "xoxb-test",
      }),
    ).resolves.toBeUndefined();

    expect(client.reactions.remove).toHaveBeenCalledWith({
      channel: "C1",
      timestamp: "123.456",
      name: "white_check_mark",
    });
  });

  it("propagates unrelated reaction remove errors", async () => {
    const client = createClient();
    client.reactions.remove.mockRejectedValueOnce(slackPlatformError("invalid_name"));

    let error: unknown;
    try {
      await removeSlackReaction("C1", "123.456", "not-an-emoji", {
        client,
        token: "xoxb-test",
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("An API error occurred: invalid_name");
    expect((error as { data?: unknown }).data).toEqual({
      ok: false,
      error: "invalid_name",
    });
  });
});

describe("removeOwnSlackReactions", () => {
  it("removes own reactions through the idempotent remove helper", async () => {
    const client = createClient();
    client.reactions.get.mockResolvedValueOnce({
      message: {
        reactions: [
          { name: "thumbsup", users: ["UBOT", "U1"] },
          { name: "eyes", users: ["U2", "UBOT"] },
          { name: "wave", users: ["U2"] },
        ],
      },
    });
    client.reactions.remove
      .mockRejectedValueOnce(slackPlatformError("no_reaction"))
      .mockResolvedValueOnce({});

    await expect(
      removeOwnSlackReactions("C1", "123.456", {
        client,
        token: "xoxb-test",
      }),
    ).resolves.toEqual(["thumbsup", "eyes"]);

    expect(client.reactions.remove).toHaveBeenCalledTimes(2);
    expect(client.reactions.remove).toHaveBeenNthCalledWith(1, {
      channel: "C1",
      timestamp: "123.456",
      name: "thumbsup",
    });
    expect(client.reactions.remove).toHaveBeenNthCalledWith(2, {
      channel: "C1",
      timestamp: "123.456",
      name: "eyes",
    });
  });
});
