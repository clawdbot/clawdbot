import { vi } from "vitest";
import { ChannelType } from "../internal/discord.js";
import { createVoiceCaptureState } from "./capture-state.js";
import { createVoiceReceiveRecoveryState } from "./receive-recovery.js";

export type MockCallSource = {
  mock: { calls: ArrayLike<ReadonlyArray<unknown>> };
};

type TestRealtimeSpeakerTurn = {
  close: () => void;
  sendInputAudio: (audio: Buffer) => void;
};

export type TestRealtimeSessionEntry = {
  capture: Omit<ReturnType<typeof createVoiceCaptureState>, "activeCaptureStreams"> & {
    activeCaptureStreams: Map<string, { generation: number; stream: unknown }>;
  };
  guildName?: string;
  pendingRealtime?: unknown;
  player: {
    on: ReturnType<typeof vi.fn>;
    play: ReturnType<typeof vi.fn>;
    state: { status: string };
    stop: ReturnType<typeof vi.fn>;
  };
  processingQueue: Promise<void>;
  realtime?: {
    beginSpeakerTurn: (
      context: { extraSystemPrompt?: string; senderIsOwner: boolean; speakerLabel: string },
      userId: string,
    ) => TestRealtimeSpeakerTurn;
  };
  receiveRecovery: ReturnType<typeof createVoiceReceiveRecoveryState>;
  route?: { agentId?: string; sessionKey?: string };
  stop: () => void;
  transcripts?: { onUtterance?: (...args: unknown[]) => unknown; sessionId: string };
  voiceSessionKey: string;
};

export type TestRealtimeBridgeParams = {
  audioSink?: { sendAudio: (audio: Buffer) => void };
  autoRespondToAudio?: boolean;
  cfg?: unknown;
  instructions?: string;
  interruptResponseOnInputAudio?: boolean;
  onEvent?: (event: { detail?: string; direction: "server"; type: string }) => void;
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
    rest: { get: vi.fn() },
    fetchChannel: vi.fn(
      async (channelId: string): Promise<VoiceChannelInfo | null> =>
        createVoiceChannelInfo(channelId),
    ),
    fetchGuild: vi.fn(async (guildId: string) => ({ id: guildId, name: "Guild One" })),
    getPlugin: vi.fn((_id?: string): unknown => ({
      getGatewayAdapterCreator: vi.fn(() => vi.fn()),
      getGateway: vi.fn(() => ({ updateVoiceState: updateVoiceStateMock })),
    })),
    fetchMember: vi.fn(),
    fetchUser: vi.fn(),
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
        getGatewayAdapterCreator: vi.fn(() => vi.fn()),
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
  return { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
}
