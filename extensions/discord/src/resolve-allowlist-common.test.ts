import { describe, expect, it } from "vitest";
import {
  buildDiscordUnresolvedResults,
  filterDiscordGuilds,
  findDiscordGuildByName,
  resolveDiscordAllowlistToken,
} from "./resolve-allowlist-common.js";

describe("resolve-allowlist-common", () => {
  const guilds = [
    { id: "1", name: "Main Guild", slug: "main-guild" },
    { id: "2", name: "Ops Guild", slug: "ops-guild" },
  ];

  it("resolves and filters guilds by id or name", () => {
    const mainGuild = findDiscordGuildByName(guilds, "Main Guild");
    if (!mainGuild) {
      throw new Error("expected Main Guild lookup result");
    }
    expect(mainGuild.id).toBe("1");
    expect(filterDiscordGuilds(guilds, { guildId: "2" })).toEqual([guilds[1]]);
    expect(filterDiscordGuilds(guilds, { guildName: "main-guild" })).toEqual([guilds[0]]);
  });

  it("builds unresolved result rows in input order", () => {
    const unresolved = buildDiscordUnresolvedResults(["a", "b"], (input) => ({
      input,
      resolved: false,
    }));
    expect(unresolved).toEqual([
      { input: "a", resolved: false },
      { input: "b", resolved: false },
    ]);
  });

  it("normalizes allowlist token values", () => {
    expect(resolveDiscordAllowlistToken(" discord-token ")).toBe("discord-token");
    expect(resolveDiscordAllowlistToken("")).toBeUndefined();
  });
});
