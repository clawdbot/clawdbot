import { describe, expect, it, vi } from "vitest";
import { resolveSlackUserAllowlist } from "./resolve-users.js";

describe("resolveSlackUserAllowlist", () => {
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

    expect(res[0]).toMatchObject({
      resolved: true,
      id: "U2",
      name: "Person",
      email: "person@example.com",
      isBot: false,
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
