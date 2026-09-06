import fs from "node:fs/promises";
import { PassThrough } from "node:stream";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { DiscordVoiceTestHarness } from "./voice-test-harness.test-support.js";

export function createDiscordRecordingFixture({
  expect,
  vi,
  createClient,
  createManager,
  getSessionEntry,
  getSessionConnection,
  handleSpeakingStart,
  decodeOpusStreamChunksMock,
  transcribeAudioFileMock,
  configureVoiceStateGateway,
}: DiscordVoiceTestHarness) {
  return async function fixture(
    mode: "agent-proxy" | "bidi" | "stt-tts" = "agent-proxy",
    occupied = false,
    cfg: OpenClawConfig = {},
    roleGated = false,
  ) {
    const client = createClient();
    client.fetchMember.mockImplementation(async (_guildId, userId) => ({
      nickname: userId === "100000000000000001" ? "Owner" : "Guest",
      roles: [],
      user: { id: userId },
    }));
    const states = [
      {
        user_id: "100000000000000001",
        channel_id: "1001",
        member: { user: { id: "100000000000000001", bot: false } },
      },
    ];
    if (occupied) {
      configureVoiceStateGateway(client, () => states);
    }
    const manager = createManager(
      {
        groupPolicy: "open",
        guilds: {
          g1: {
            channels: {
              "1001": roleGated
                ? { roles: ["role:200000000000000001"] }
                : { users: ["100000000000000001"] },
            },
          },
        },
        voice: {
          enabled: true,
          mode,
          realtime: { provider: "openai", requireWakeName: true },
          ...(occupied
            ? { autoJoin: [{ guildId: "g1", channelId: "1001", whenOccupied: true }] }
            : {}),
        },
      },
      client,
      { ...cfg, commands: { ownerAllowFrom: ["discord:100000000000000001"] } },
    );
    if (occupied) {
      await manager.autoJoin();
    } else {
      await manager.join({ guildId: "g1", channelId: "1001" });
    }
    const entry = getSessionEntry(manager);
    const conversations = vi.spyOn(entry.conversations, "enqueue");
    const streams = new Map<string, PassThrough>();
    getSessionConnection(entry).receiver.subscribe.mockImplementation((userId: string) => {
      const stream = new PassThrough({ objectMode: true });
      streams.set(userId, stream);
      return stream;
    });
    decodeOpusStreamChunksMock.mockImplementation(async (stream, params) => {
      try {
        for await (const chunk of stream) {
          await params.onChunk(chunk, chunk);
        }
      } catch (error) {
        params.onError?.(error);
      }
    });
    transcribeAudioFileMock.mockImplementation(async ({ filePath }) => {
      const wav = await fs.readFile(filePath);
      return { text: `audio-${wav[44]}-${wav.length - 44}` };
    });
    const sink = vi.fn();
    const begin = (userId: string) => handleSpeakingStart(manager, entry, userId);
    const audio = async (userId: string, marker: number) => {
      const receiving = begin(userId);
      await vi.waitFor(() => expect(streams.has(userId)).toBe(true));
      streams.get(userId)!.end(Buffer.alloc(96_000, marker));
      await receiving;
      await entry.processingQueue;
      await Promise.all(conversations.mock.results.map((result) => result.value));
    };
    return { client, manager, entry, streams, sink, begin, audio, states, conversations };
  };
}
