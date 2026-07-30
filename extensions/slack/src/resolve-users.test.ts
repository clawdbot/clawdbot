// Slack tests cover resolve users plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveSlackUserAllowlist } from "./resolve-users.js";

const slackClientMocks = vi.hoisted(() => ({
  createSlackLookupClient: vi.fn(),
  usersList: vi.fn(),
}));

vi.mock("./client.js", () => ({
  createSlackLookupClient: slackClientMocks.createSlackLookupClient,
}));

describe("resolveSlackUserAllowlist", () => {
  beforeEach(() => {
    slackClientMocks.usersList.mockReset();
    slackClientMocks.createSlackLookupClient.mockReset().mockReturnValue({
      users: { list: slackClientMocks.usersList },
    });
  });

  it("uses the bounded lookup client when no client is injected", async () => {
    const fixture = "lookup-fixture";
    slackClientMocks.usersList.mockResolvedValue({ members: [] });

    await resolveSlackUserAllowlist({
      token: fixture,
      entries: ["@missing-user"],
    });

    expect(slackClientMocks.createSlackLookupClient).toHaveBeenCalledOnce();
    expect(slackClientMocks.createSlackLookupClient).toHaveBeenCalledWith(fixture);
    expect(slackClientMocks.usersList).toHaveBeenCalledOnce();
  });

  it("resolves by email and prefers active human users", async () => {
    const client = {
      users: {
        list: vi.fn().mockResolvedValue({
          members: [
            {
              id: "U1",
              name: "bot-user",
              is_bot: true,
              deleted: false,
              profile: { email: "person@example.com" },
            },
            {
              id: "U2",
              name: "person",
              is_bot: false,
              deleted: false,
              profile: { email: "person@example.com", display_name: "Person" },
            },
          ],
        }),
      },
    };

    const res = await resolveSlackUserAllowlist({
      token: "xoxb-test",
      entries: ["person@example.com"],
      client: client as never,
    });

    expect(res[0]).toEqual({
      deleted: false,
      email: "person@example.com",
      id: "U2",
      input: "person@example.com",
      isBot: false,
      name: "Person",
      note: "multiple matches; chose best",
      resolved: true,
    });
  });

  it("keeps unresolved users", async () => {
    const client = {
      users: {
        list: vi.fn().mockResolvedValue({ members: [] }),
      },
    };

    const res = await resolveSlackUserAllowlist({
      token: "xoxb-test",
      entries: ["@missing-user"],
      client: client as never,
    });

    expect(res[0]).toEqual({ input: "@missing-user", resolved: false });
  });
});
