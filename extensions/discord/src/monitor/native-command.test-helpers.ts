import { ChannelType } from "discord-api-types/v10";
import { vi } from "vitest";

export type MockCommandInteraction = {
  user: { id: string; username: string; globalName: string };
  channel: { type: ChannelType; id: string; parentId?: string | null };
  guild: { id: string; name?: string } | null;
  rawData: { id: string; member: { roles: string[] } };
  options: {
    getString: ReturnType<typeof vi.fn>;
    getNumber: ReturnType<typeof vi.fn>;
    getBoolean: ReturnType<typeof vi.fn>;
  };
  defer: ReturnType<typeof vi.fn>;
  reply: ReturnType<typeof vi.fn>;
  followUp: ReturnType<typeof vi.fn>;
  client: object;
};

type CreateMockCommandInteractionParams = {
  userId?: string;
  username?: string;
  globalName?: string;
  channelType?: ChannelType;
  channelId?: string;
  threadParentId?: string | null;
  guildId?: string | null;
  guildName?: string;
  interactionId?: string;
};

export function createMockCommandInteraction(
  params: CreateMockCommandInteractionParams = {},
): MockCommandInteraction {
  const guildId = params.guildId;
  const guild =
    guildId === null || guildId === undefined ? null : { id: guildId, name: params.guildName };
  return {
    user: {
      id: params.userId ?? "owner",
      username: params.username ?? "tester",
      globalName: params.globalName ?? "Tester",
    },
    channel: {
      type: params.channelType ?? ChannelType.DM,
      id: params.channelId ?? "dm-1",
      parentId: params.threadParentId,
    },
    guild,
    rawData: {
      id: params.interactionId ?? "interaction-1",
      member: { roles: [] },
    },
    options: {
      getString: vi.fn().mockReturnValue(null),
      getNumber: vi.fn().mockReturnValue(null),
      getBoolean: vi.fn().mockReturnValue(null),
    },
    defer: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue({ ok: true }),
    followUp: vi.fn().mockResolvedValue({ ok: true }),
    client: {},
  };
}
