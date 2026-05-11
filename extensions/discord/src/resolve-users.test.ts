import { withFetchPreconnect } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { resolveDiscordUserAllowlist } from "./resolve-users.js";
import { jsonResponse, urlToString } from "./test-http-helpers.js";

type DiscordAllowlistResult = Awaited<ReturnType<typeof resolveDiscordUserAllowlist>>[number];

function expectResolvedUser(
  result: DiscordAllowlistResult | undefined,
  expected: { id: string; input?: string; name?: string },
) {
  if (!result) {
    throw new Error("expected Discord allowlist result");
  }
  expect(result.resolved).toBe(true);
  expect(result.id).toBe(expected.id);
  if (expected.input !== undefined) {
    expect(result.input).toBe(expected.input);
  }
  if (expected.name !== undefined) {
    expect(result.name).toBe(expected.name);
  }
}

function expectUnresolvedUser(result: DiscordAllowlistResult | undefined) {
  if (!result) {
    throw new Error("expected Discord allowlist result");
  }
  expect(result.resolved).toBe(false);
}

function createGuildListProbeFetcher() {
  let guildsCalled = false;
  const fetcher = withFetchPreconnect(async (input: RequestInfo | URL) => {
    const url = urlToString(input);
    if (url.endsWith("/users/@me/guilds")) {
      guildsCalled = true;
      return jsonResponse([]);
    }
    return new Response("not found", { status: 404 });
  });
  return {
    fetcher,
    wasGuildsCalled: () => guildsCalled,
  };
}

function createGuildsForbiddenFetcher() {
  return withFetchPreconnect(async (input: RequestInfo | URL) => {
    const url = urlToString(input);
    if (url.endsWith("/users/@me/guilds")) {
      throw new Error("Forbidden: Missing Access");
    }
    return new Response("not found", { status: 404 });
  });
}

describe("resolveDiscordUserAllowlist", () => {
  it("resolves plain user ids without calling listGuilds", async () => {
    const { fetcher, wasGuildsCalled } = createGuildListProbeFetcher();

    const results = await resolveDiscordUserAllowlist({
      token: "test",
      entries: ["123456789012345678"],
      fetcher,
    });

    expect(results).toEqual([
      {
        input: "123456789012345678",
        resolved: true,
        id: "123456789012345678",
      },
    ]);
    expect(wasGuildsCalled()).toBe(false);
  });

  it("resolves mention-format ids without calling listGuilds", async () => {
    const { fetcher, wasGuildsCalled } = createGuildListProbeFetcher();

    const results = await resolveDiscordUserAllowlist({
      token: "test",
      entries: ["<@!123456789012345678>"],
      fetcher,
    });

    expect(results).toEqual([
      {
        input: "<@!123456789012345678>",
        resolved: true,
        id: "123456789012345678",
      },
    ]);
    expect(wasGuildsCalled()).toBe(false);
  });

  it("resolves prefixed ids (user:, discord:) without calling listGuilds", async () => {
    const { fetcher, wasGuildsCalled } = createGuildListProbeFetcher();

    const results = await resolveDiscordUserAllowlist({
      token: "test",
      entries: ["user:111", "discord:222"],
      fetcher,
    });

    expect(results).toHaveLength(2);
    expectResolvedUser(results[0], { id: "111" });
    expectResolvedUser(results[1], { id: "222" });
    expect(wasGuildsCalled()).toBe(false);
  });

  it("resolves user ids even when listGuilds would fail", async () => {
    const fetcher = createGuildsForbiddenFetcher();

    // Before the fix, this would throw because listGuilds() was called eagerly
    const results = await resolveDiscordUserAllowlist({
      token: "test",
      entries: ["994979735488692324"],
      fetcher,
    });

    expect(results).toEqual([
      {
        input: "994979735488692324",
        resolved: true,
        id: "994979735488692324",
      },
    ]);
  });

  it("calls listGuilds lazily when resolving usernames", async () => {
    let guildsCalled = false;
    const fetcher = withFetchPreconnect(async (input: RequestInfo | URL) => {
      const url = urlToString(input);
      if (url.endsWith("/users/@me/guilds")) {
        guildsCalled = true;
        return jsonResponse([{ id: "g1", name: "Test Guild" }]);
      }
      if (url.includes("/guilds/g1/members/search")) {
        return jsonResponse([
          {
            user: { id: "u1", username: "alice", bot: false },
            nick: null,
          },
        ]);
      }
      return new Response("not found", { status: 404 });
    });

    const results = await resolveDiscordUserAllowlist({
      token: "test",
      entries: ["alice"],
      fetcher,
    });

    expect(guildsCalled).toBe(true);
    expect(results).toHaveLength(1);
    expectResolvedUser(results[0], { input: "alice", id: "u1", name: "alice" });
  });

  it("fetches guilds only once for multiple username entries", async () => {
    let guildsCallCount = 0;
    const fetcher = withFetchPreconnect(async (input: RequestInfo | URL) => {
      const url = urlToString(input);
      if (url.endsWith("/users/@me/guilds")) {
        guildsCallCount++;
        return jsonResponse([{ id: "g1", name: "Test Guild" }]);
      }
      if (url.includes("/guilds/g1/members/search")) {
        const params = new URL(url).searchParams;
        const query = params.get("query") ?? "";
        return jsonResponse([
          {
            user: { id: `u-${query}`, username: query, bot: false },
            nick: null,
          },
        ]);
      }
      return new Response("not found", { status: 404 });
    });

    const results = await resolveDiscordUserAllowlist({
      token: "test",
      entries: ["alice", "bob"],
      fetcher,
    });

    expect(guildsCallCount).toBe(1);
    expect(results).toHaveLength(2);
    expectResolvedUser(results[0], { id: "u-alice" });
    expectResolvedUser(results[1], { id: "u-bob" });
  });

  it("handles mixed ids and usernames — ids resolve even if guilds fail", async () => {
    const fetcher = createGuildsForbiddenFetcher();

    // IDs should succeed, username should fail (listGuilds throws)
    await expect(
      resolveDiscordUserAllowlist({
        token: "test",
        entries: ["123456789012345678", "alice"],
        fetcher,
      }),
    ).rejects.toThrow("Forbidden");

    // But if we only pass IDs, it should work fine
    const results = await resolveDiscordUserAllowlist({
      token: "test",
      entries: ["123456789012345678", "<@999>"],
      fetcher,
    });

    expect(results).toHaveLength(2);
    expectResolvedUser(results[0], { id: "123456789012345678" });
    expectResolvedUser(results[1], { id: "999" });
  });

  it("returns unresolved for empty/blank entries", async () => {
    const fetcher = withFetchPreconnect(async () => {
      return new Response("not found", { status: 404 });
    });

    const results = await resolveDiscordUserAllowlist({
      token: "test",
      entries: ["", "  "],
      fetcher,
    });

    expect(results).toHaveLength(2);
    expectUnresolvedUser(results[0]);
    expectUnresolvedUser(results[1]);
  });

  it("returns all unresolved when token is empty", async () => {
    const results = await resolveDiscordUserAllowlist({
      token: "",
      entries: ["123456789012345678", "alice"],
    });

    expect(results).toHaveLength(2);
    expect(results.map((result) => result.resolved)).toEqual([false, false]);
  });
});
