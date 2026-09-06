// Discord tests cover speaker context plugin behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Client } from "../internal/discord.js";
import { resolveDiscordVoiceAccess } from "./owner-access.js";
import { DiscordVoiceSpeakerContextResolver } from "./speaker-context.js";

function createClient(fetchMember: ReturnType<typeof vi.fn>): Client {
  return {
    fetchMember,
    fetchUser: vi.fn(),
  } as unknown as Client;
}

describe("DiscordVoiceSpeakerContextResolver", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    { owner: "123456789012345678", senderIsOwner: true },
    { owner: "discord:123456789012345678", senderIsOwner: true },
    { owner: "user:123456789012345678", senderIsOwner: true },
    { owner: "pk:123456789012345678", senderIsOwner: true },
    { owner: "<@123456789012345678>", senderIsOwner: true },
    { owner: "<@!123456789012345678>", senderIsOwner: true },
    { owner: "discord:user:123456789012345678", senderIsOwner: false },
    { owner: "slack:123456789012345678", senderIsOwner: false },
    { owner: "discord:*", senderIsOwner: false },
    { owner: "user:*", senderIsOwner: false },
    { owner: "pk:*", senderIsOwner: false },
  ])("preserves owner target authority for voice: $owner", async ({ owner, senderIsOwner }) => {
    const id = "123456789012345678";
    const fetchMember = vi.fn().mockResolvedValue({ user: { id, username: "ada" } });
    const access = resolveDiscordVoiceAccess({
      cfg: { commands: { ownerAllowFrom: [owner] } },
      discordConfig: {},
      accountId: "default",
    });
    const resolver = new DiscordVoiceSpeakerContextResolver({
      client: createClient(fetchMember),
      ownerAllowFrom: access.ownerAllowFrom,
    });

    await expect(resolver.resolveContext("g1", id)).resolves.toMatchObject({ senderIsOwner });
  });

  it("reuses cached speaker context for repeated speaker lookups", async () => {
    const fetchMember = vi.fn().mockResolvedValue({
      nickname: "Ada",
      roles: [],
      user: { id: "u1", username: "ada", globalName: "Ada" },
    });
    const resolver = new DiscordVoiceSpeakerContextResolver({
      client: createClient(fetchMember),
    });

    await expect(resolver.resolveContext("g1", "u1")).resolves.toMatchObject({ label: "Ada" });
    await expect(resolver.resolveContext("g1", "u1")).resolves.toMatchObject({ label: "Ada" });

    expect(fetchMember).toHaveBeenCalledTimes(1);
  });

  it("does not cache speaker context when the cache expiry would exceed Date range", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(8_640_000_000_000_000));
    const fetchMember = vi
      .fn()
      .mockResolvedValueOnce({
        nickname: "Ada",
        roles: [],
        user: { id: "u1", username: "ada", globalName: "Ada" },
      })
      .mockResolvedValueOnce({
        nickname: "Grace",
        roles: [],
        user: { id: "u1", username: "grace", globalName: "Grace" },
      });
    const resolver = new DiscordVoiceSpeakerContextResolver({
      client: createClient(fetchMember),
    });

    await expect(resolver.resolveContext("g1", "u1")).resolves.toMatchObject({ label: "Ada" });
    await expect(resolver.resolveContext("g1", "u1")).resolves.toMatchObject({ label: "Grace" });

    expect(fetchMember).toHaveBeenCalledTimes(2);
  });
});
