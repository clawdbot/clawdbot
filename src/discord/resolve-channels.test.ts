import { describe, expect, it } from "vitest";

import { resolveDiscordChannelAllowlist } from "./resolve-channels.js";

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200 });
}

describe("resolveDiscordChannelAllowlist", () => {
  it("resolves guild/channel by name", async () => {
    const fetcher = async (url: string) => {
      if (url.endsWith("/users/@me/guilds")) {
        return jsonResponse([{ id: "g1", name: "My Guild" }]);
      }
      if (url.endsWith("/guilds/g1/channels")) {
        return jsonResponse([
          { id: "c1", name: "general", guild_id: "g1", type: 0 },
          { id: "c2", name: "random", guild_id: "g1", type: 0 },
        ]);
      }
      return new Response("not found", { status: 404 });
    };

    const res = await resolveDiscordChannelAllowlist({
      token: "test",
      entries: ["My Guild/general"],
      fetcher,
    });

    expect(res[0]?.resolved).toBe(true);
    expect(res[0]?.guildId).toBe("g1");
    expect(res[0]?.channelId).toBe("c1");
  });

  it("resolves channel id to guild", async () => {
    const fetcher = async (url: string) => {
      if (url.endsWith("/users/@me/guilds")) {
        return jsonResponse([{ id: "g1", name: "Guild One" }]);
      }
      if (url.endsWith("/channels/123")) {
        return jsonResponse({ id: "123", name: "general", guild_id: "g1", type: 0 });
      }
      return new Response("not found", { status: 404 });
    };

    const res = await resolveDiscordChannelAllowlist({
      token: "test",
      entries: ["123"],
      fetcher,
    });

    expect(res[0]?.resolved).toBe(true);
    expect(res[0]?.guildId).toBe("g1");
    expect(res[0]?.channelId).toBe("123");
  });
});
