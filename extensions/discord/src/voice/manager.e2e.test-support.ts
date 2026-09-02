import type {
  RealtimeVoiceBridgeEvent,
  RealtimeVoiceBridgeCreateRequest,
  RealtimeVoiceResponseOutcome,
} from "openclaw/plugin-sdk/realtime-voice";
import { vi, type Mock } from "vitest";
import { ChannelType } from "../internal/discord.js";

export type MockCallSource = {
  mock: { calls: ArrayLike<ReadonlyArray<unknown>> };
};

export type TestRealtimeBridgeParams = {
  agentId?: string;
  audioSink: { sendAudio: (audio: Buffer) => void };
  autoRespondToAudio?: boolean;
  cfg?: unknown;
  instructions?: string;
  interruptResponseOnInputAudio?: boolean;
  onEvent?: (event: RealtimeVoiceBridgeEvent) => void;
  onClose?: RealtimeVoiceBridgeCreateRequest["onClose"];
  onReady?: () => void;
  onResponseDone?: (outcome: RealtimeVoiceResponseOutcome) => void;
  onToolCall?: (
    event: { args: unknown; callId: string; itemId: string; name: string },
    session: unknown,
  ) => Promise<void> | void;
  onTranscript?: (role: "user" | "assistant", text: string, isFinal: boolean) => void;
  tools?: Array<{ name: string }>;
};

export function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new Error(`expected ${label}`);
  }
  return value as Record<string, unknown>;
}

export function mockCall(source: MockCallSource, index: number, label: string) {
  const call = source.mock.calls[index];
  if (!call) {
    throw new Error(`expected mock call: ${label}`);
  }
  return call;
}

export function lastMockCall(source: MockCallSource, label: string) {
  const calls = Array.from(source.mock.calls);
  const call = calls[calls.length - 1];
  if (!call) {
    throw new Error(`expected mock call: ${label}`);
  }
  return call;
}

export function createDiscordVoiceTestHelpers(updateVoiceStateMock: ReturnType<typeof vi.fn>) {
  const createVoiceChannelInfo = (channelId: string, guildId = "g1", guildName = "Guild One") => ({
    id: channelId,
    guildId,
    guild: { id: guildId, name: guildName },
    type: ChannelType.GuildVoice,
  });
  type VoiceChannelInfo = ReturnType<typeof createVoiceChannelInfo>;

  const createClient = () => ({
    rest: { get: vi.fn() as Mock },
    fetchChannel: vi.fn(
      async (channelId: string): Promise<VoiceChannelInfo | null> =>
        createVoiceChannelInfo(channelId),
    ),
    fetchGuild: vi.fn(async (guildId: string) => ({ id: guildId, name: "Guild One" })),
    getPlugin: vi.fn((_id?: string): unknown => ({
      getGatewayAdapterCreator: vi.fn(() => vi.fn() as Mock),
      getGateway: vi.fn(() => ({ updateVoiceState: updateVoiceStateMock })),
    })),
    fetchMember: vi.fn() as Mock,
    fetchUser: vi.fn() as Mock,
  });

  const createClientWithMember = (
    id: string,
    globalName: string,
    discriminator: string,
    nickname = `${globalName} Nick`,
  ) => {
    const client = createClient();
    client.fetchMember.mockResolvedValue({
      nickname,
      roles: [],
      user: { id, username: globalName.toLowerCase(), globalName, discriminator },
    });
    return client;
  };

  const configureVoiceStateGateway = (
    client: ReturnType<typeof createClient>,
    listVoiceChannelStates: (...args: unknown[]) => unknown,
  ) => {
    client.getPlugin.mockImplementation((id?: string) => {
      if (id === "gateway") {
        return { listVoiceChannelStates: vi.fn(listVoiceChannelStates) };
      }
      return {
        getGatewayAdapterCreator: vi.fn(() => vi.fn() as Mock),
        getGateway: vi.fn(() => ({ updateVoiceState: updateVoiceStateMock })),
      };
    });
  };

  return { configureVoiceStateGateway, createClient, createClientWithMember };
}

export function createDefaultVoiceStates() {
  return [
    ["u-owner", "peter", "Peter"],
    ["u-friend", "sam", "Sam"],
    ["bot-user", "molty", "Molty"],
  ].map(([userId, username, name]) => ({
    guild_id: "g1",
    user_id: userId,
    channel_id: "1001",
    member: { nick: name, user: { id: userId, username, global_name: name } },
  }));
}

export function createVoiceTestRuntime() {
  return { log: vi.fn() as Mock, error: vi.fn() as Mock, exit: vi.fn() as Mock };
}
