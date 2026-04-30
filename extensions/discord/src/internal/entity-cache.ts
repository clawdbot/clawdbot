import { GatewayDispatchEvents } from "discord-api-types/v10";
import { getChannel, getGuild, getGuildMember, getUser } from "./api.js";
import type { RequestClient } from "./rest.js";
import { Guild, GuildMember, User, channelFactory, type StructureClient } from "./structures.js";

type CacheEntry<T> = {
  expiresAt: number;
  value: T;
};

const DEFAULT_REST_CACHE_TTL_MS = 30_000;

export class DiscordEntityCache {
  private readonly entries = new Map<string, CacheEntry<unknown>>();

  constructor(
    private readonly params: {
      client: StructureClient;
      rest: RequestClient | (() => RequestClient);
      ttlMs?: number;
    },
  ) {}

  async fetchUser(id: string): Promise<User> {
    return await this.fetchCached(`user:${id}`, async () => {
      const raw = await getUser(this.rest, id);
      return new User(this.params.client, raw);
    });
  }

  async fetchChannel(id: string) {
    return await this.fetchCached(`channel:${id}`, async () => {
      const raw = await getChannel(this.rest, id);
      return channelFactory(this.params.client, raw);
    });
  }

  async fetchGuild(id: string): Promise<Guild> {
    return await this.fetchCached(`guild:${id}`, async () => {
      const raw = await getGuild(this.rest, id);
      return new Guild(this.params.client, raw);
    });
  }

  async fetchMember(guildId: string, userId: string): Promise<GuildMember> {
    return await this.fetchCached(`member:${guildId}:${userId}`, async () => {
      const raw = await getGuildMember(this.rest, guildId, userId);
      return new GuildMember(this.params.client, raw);
    });
  }

  invalidateForGatewayEvent(type: string, data: unknown): void {
    const raw = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
    const channelUpdate: string = GatewayDispatchEvents.ChannelUpdate;
    const channelDelete: string = GatewayDispatchEvents.ChannelDelete;
    const guildUpdate: string = GatewayDispatchEvents.GuildUpdate;
    const guildMemberUpdate: string = GatewayDispatchEvents.GuildMemberUpdate;
    if (type === channelUpdate || type === channelDelete) {
      this.deleteId("channel", raw.id);
    }
    if (type === guildUpdate) {
      this.deleteId("guild", raw.id);
    }
    if (type === guildMemberUpdate) {
      const guildId = raw.guild_id;
      const user = raw.user && typeof raw.user === "object" ? (raw.user as { id?: unknown }) : {};
      if (typeof guildId === "string" && typeof user.id === "string") {
        this.entries.delete(`member:${guildId}:${user.id}`);
        this.entries.delete(`user:${user.id}`);
      }
    }
  }

  private deleteId(prefix: string, id: unknown): void {
    if (typeof id === "string") {
      this.entries.delete(`${prefix}:${id}`);
    }
  }

  private async fetchCached<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
    const ttl = this.params.ttlMs ?? DEFAULT_REST_CACHE_TTL_MS;
    if (ttl > 0) {
      const cached = this.entries.get(key) as CacheEntry<T> | undefined;
      if (cached && cached.expiresAt > Date.now()) {
        return cached.value;
      }
    }
    const value = await fetcher();
    if (ttl > 0) {
      this.entries.set(key, { expiresAt: Date.now() + ttl, value });
    }
    return value;
  }

  private get rest(): RequestClient {
    return typeof this.params.rest === "function" ? this.params.rest() : this.params.rest;
  }
}
