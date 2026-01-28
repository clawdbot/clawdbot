import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ClawdbotConfig } from "../config/config.js";
import { normalizeDiscordMessagingTarget } from "../channels/plugins/normalize/discord.js";
import { listDiscordDirectoryPeersLive } from "./directory-live.js";
import { parseDiscordTarget, resolveDiscordChannelId, resolveDiscordTarget } from "./targets.js";

vi.mock("./directory-live.js", () => ({
  listDiscordDirectoryPeersLive: vi.fn(),
}));

describe("parseDiscordTarget", () => {
  it("parses user mention and prefixes", () => {
    expect(parseDiscordTarget("<@123>")).toMatchObject({
      kind: "user",
      id: "123",
      normalized: "user:123",
    });
    expect(parseDiscordTarget("<@!456>")).toMatchObject({
      kind: "user",
      id: "456",
      normalized: "user:456",
    });
    expect(parseDiscordTarget("user:789")).toMatchObject({
      kind: "user",
      id: "789",
      normalized: "user:789",
    });
    expect(parseDiscordTarget("discord:987")).toMatchObject({
      kind: "user",
      id: "987",
      normalized: "user:987",
    });
  });

  it("parses channel targets", () => {
    expect(parseDiscordTarget("channel:555")).toMatchObject({
      kind: "channel",
      id: "555",
      normalized: "channel:555",
    });
    expect(parseDiscordTarget("general")).toMatchObject({
      kind: "channel",
      id: "general",
      normalized: "channel:general",
    });
  });

  it("rejects ambiguous numeric ids without a default kind", () => {
    expect(() => parseDiscordTarget("123")).toThrow(/Ambiguous Discord recipient/);
  });

  it("accepts numeric ids when a default kind is provided", () => {
    expect(parseDiscordTarget("123", { defaultKind: "channel" })).toMatchObject({
      kind: "channel",
      id: "123",
      normalized: "channel:123",
    });
  });

  it("rejects non-numeric @ mentions", () => {
    expect(() => parseDiscordTarget("@bob")).toThrow(/Discord DMs require a user id/);
  });
});

describe("resolveDiscordChannelId", () => {
  it("strips channel: prefix and accepts raw ids", () => {
    expect(resolveDiscordChannelId("channel:123")).toBe("123");
    expect(resolveDiscordChannelId("123")).toBe("123");
  });

  it("rejects user targets", () => {
    expect(() => resolveDiscordChannelId("user:123")).toThrow(/channel id is required/i);
  });
});

describe("resolveDiscordTarget", () => {
  const cfg = { channels: { discord: {} } } as ClawdbotConfig;
  const listPeers = vi.mocked(listDiscordDirectoryPeersLive);

  beforeEach(() => {
    listPeers.mockReset();
  });

  it("returns a resolved user for usernames", async () => {
    listPeers.mockResolvedValueOnce([{ kind: "user", id: "user:999", name: "Jane" } as const]);

    await expect(
      resolveDiscordTarget("jane", { cfg, accountId: "default" }),
    ).resolves.toMatchObject({ kind: "user", id: "999", normalized: "user:999" });
  });

  it("falls back to parsing when lookup misses", async () => {
    listPeers.mockResolvedValueOnce([]);
    await expect(
      resolveDiscordTarget("general", { cfg, accountId: "default" }),
    ).resolves.toMatchObject({ kind: "channel", id: "general" });
  });

  it("does not call directory lookup for explicit user ids", async () => {
    listPeers.mockResolvedValueOnce([]);
    await expect(
      resolveDiscordTarget("user:123", { cfg, accountId: "default" }),
    ).resolves.toMatchObject({ kind: "user", id: "123" });
    expect(listPeers).not.toHaveBeenCalled();
  });
});

describe("normalizeDiscordMessagingTarget", () => {
  it("defaults raw numeric ids to channels", () => {
    expect(normalizeDiscordMessagingTarget("123")).toBe("channel:123");
  });
});
