import type { Client } from "../internal/discord.js";
import { resolveDiscordOwnerAccess } from "../monitor/allow-list.js";
import { formatDiscordUserTag } from "../monitor/format.js";

const SPEAKER_CONTEXT_CACHE_TTL_MS = 60_000;

type VoiceSpeakerIdentity = {
  id: string;
  label: string;
  name?: string;
  tag?: string;
  memberRoleIds: string[];
};

type VoiceSpeakerContext = Omit<VoiceSpeakerIdentity, "memberRoleIds"> & {
  senderIsOwner: boolean;
};

export class DiscordVoiceSpeakerContextResolver {
  private readonly cache = new Map<
    string,
    VoiceSpeakerContext & {
      expiresAt: number;
    }
  >();

  constructor(
    private readonly params: {
      client: Client;
      ownerAllowFrom?: string[];
    },
  ) {}

  async resolveContext(guildId: string, userId: string): Promise<VoiceSpeakerContext> {
    const cached = this.getCachedContext(guildId, userId);
    if (cached) {
      return cached;
    }
    const identity = await this.resolveIdentity(guildId, userId);
    const context = {
      id: identity.id,
      label: identity.label,
      name: identity.name,
      tag: identity.tag,
      senderIsOwner: this.resolveIsOwner(identity),
    };
    this.setCachedContext(guildId, userId, context);
    return context;
  }

  async resolveIdentity(guildId: string, userId: string): Promise<VoiceSpeakerIdentity> {
    try {
      const member = await this.params.client.fetchMember(guildId, userId);
      const username = member.user?.username ?? undefined;
      return {
        id: userId,
        label: member.nickname ?? member.user?.globalName ?? username ?? userId,
        name: username,
        tag: member.user ? formatDiscordUserTag(member.user) : undefined,
        memberRoleIds: Array.isArray(member.roles)
          ? member.roles
              .map((role) =>
                typeof role === "string" ? role : typeof role?.id === "string" ? role.id : "",
              )
              .filter(Boolean)
          : [],
      };
    } catch {
      try {
        const user = await this.params.client.fetchUser(userId);
        const username = user.username ?? undefined;
        return {
          id: userId,
          label: user.globalName ?? username ?? userId,
          name: username,
          tag: formatDiscordUserTag(user),
          memberRoleIds: [],
        };
      } catch {
        return { id: userId, label: userId, memberRoleIds: [] };
      }
    }
  }

  private resolveIsOwner(identity: Pick<VoiceSpeakerIdentity, "id" | "name" | "tag">): boolean {
    return resolveDiscordOwnerAccess({
      allowFrom: this.params.ownerAllowFrom,
      sender: {
        id: identity.id,
        name: identity.name,
        tag: identity.tag,
      },
      allowNameMatching: false,
    }).ownerAllowed;
  }

  private resolveCacheKey(guildId: string, userId: string): string {
    return `${guildId}:${userId}`;
  }

  private getCachedContext(guildId: string, userId: string): VoiceSpeakerContext | undefined {
    const key = this.resolveCacheKey(guildId, userId);
    const cached = this.cache.get(key);
    if (!cached) {
      return undefined;
    }
    if (cached.expiresAt <= Date.now()) {
      this.cache.delete(key);
      return undefined;
    }
    return {
      id: cached.id,
      label: cached.label,
      name: cached.name,
      tag: cached.tag,
      senderIsOwner: cached.senderIsOwner,
    };
  }

  private setCachedContext(guildId: string, userId: string, context: VoiceSpeakerContext): void {
    const key = this.resolveCacheKey(guildId, userId);
    this.cache.set(key, {
      ...context,
      expiresAt: Date.now() + SPEAKER_CONTEXT_CACHE_TTL_MS,
    });
  }
}
