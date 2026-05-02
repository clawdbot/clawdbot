import type { WebClient } from "@slack/web-api";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearSlackSubteamMentionCacheForTest,
  extractSlackSubteamMentionIds,
  isSlackSubteamMentionForBot,
} from "./subteam-mentions.js";

function createClient(users: string[]) {
  return {
    usergroups: {
      users: {
        list: vi.fn(async () => ({ ok: true, users })),
      },
    },
  } as unknown as WebClient & {
    usergroups: { users: { list: ReturnType<typeof vi.fn> } };
  };
}

describe("Slack subteam mentions", () => {
  beforeEach(() => {
    clearSlackSubteamMentionCacheForTest();
  });

  it("extracts unique user-group ids from Slack mention tokens", () => {
    expect(
      extractSlackSubteamMentionIds("<!subteam^S123|eng> <!subteam^s456> <!subteam^S123>"),
    ).toEqual(["S123", "S456"]);
  });

  it("matches when the bot user is a member of a mentioned user group", async () => {
    const client = createClient(["U_OTHER", "U_BOT"]);

    await expect(
      isSlackSubteamMentionForBot({
        client,
        text: "<!subteam^S123|eng> ping",
        botUserId: "u_bot",
        teamId: "T1",
        now: 1,
      }),
    ).resolves.toBe(true);

    expect(client.usergroups.users.list).toHaveBeenCalledWith({
      usergroup: "S123",
      team_id: "T1",
    });
  });

  it("fails closed and caches successful membership lookups", async () => {
    const client = createClient(["U_OTHER"]);

    await expect(
      isSlackSubteamMentionForBot({
        client,
        text: "<!subteam^S123> ping",
        botUserId: "U_BOT",
        now: 1,
      }),
    ).resolves.toBe(false);
    await expect(
      isSlackSubteamMentionForBot({
        client,
        text: "<!subteam^S123> ping again",
        botUserId: "U_BOT",
        now: 2,
      }),
    ).resolves.toBe(false);

    expect(client.usergroups.users.list).toHaveBeenCalledTimes(1);
  });

  it("fails closed when Slack rejects the user-group lookup", async () => {
    const log = vi.fn();
    const client = createClient([]);
    client.usergroups.users.list.mockRejectedValueOnce(new Error("missing_scope"));

    await expect(
      isSlackSubteamMentionForBot({
        client,
        text: "<!subteam^S123> ping",
        botUserId: "U_BOT",
        log,
      }),
    ).resolves.toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("missing_scope"));
  });
});
