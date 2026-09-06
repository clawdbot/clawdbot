import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import { PassThrough } from "node:stream";
import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-entry-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createPluginRuntimeStore, type PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import { discordPlugin } from "../../channel-plugin-api.js";
import { registerDiscordTranscriptSourceProvider } from "../../transcripts-source-api.js";
import type { Client } from "../internal/discord.js";
import * as audio from "./audio.js";
import * as sdkRuntime from "./sdk-runtime.js";
import type { VoiceSessionEntry } from "./session.js";
import {
  discordVoiceTranscriptsSourceProvider,
  setDiscordTranscriptsVoiceManager,
} from "./transcripts-source.js";
import { DiscordVoiceManager } from "./voice-runtime.js";

export const captureTarget = {
  accountId: "gateway-capture-fixture",
  guildId: "810000000000000001",
  channelId: "810000000000000002",
};
const speakerId = "810000000000000003";
const speakerLabel = "Synthetic speaker";
export const capturedText = "Synthetic capture continues after the initiating turn settles.";
export const lateText = "Synthetic late STT must not enter the stopped capture.";

/** Owns only external Discord/codec/STT edges; no routing, authorization or dispatch mocks. */
export function createDiscordGatewayCaptureFixture(params: {
  cfg: OpenClawConfig;
  test: { expect: typeof import("vitest").expect; vi: typeof import("vitest").vi };
}) {
  const { expect, vi } = params.test;
  const runtimeStore = createPluginRuntimeStore<PluginRuntime>({
    pluginId: "discord",
    errorMessage: "Discord runtime not initialized",
  });
  const previousRuntime = runtimeStore.tryGetRuntime();
  const sdk = sdkRuntime.loadDiscordVoiceSdk();
  const createTransport = () => {
    const speaking = Object.assign(new EventEmitter(), {
      // Speech predates readiness: there is deliberately no initial native start event.
      users: new Map([[speakerId, Date.now()]]),
    });
    const streams: PassThrough[] = [];
    const subscribe = vi.fn(() => {
      const stream = new PassThrough();
      streams.push(stream);
      return stream;
    });
    const player = Object.assign(new EventEmitter(), {
      state: { status: sdk.AudioPlayerStatus.Idle },
      stop: vi.fn(() => true),
      play: vi.fn(),
    });
    const connection = Object.assign(new EventEmitter(), {
      state: { status: sdk.VoiceConnectionStatus.Ready },
      receiver: { speaking, subscribe },
      subscribe: vi.fn(),
      destroy: vi.fn(() => {
        connection.state.status = sdk.VoiceConnectionStatus.Destroyed;
        connection.emit(sdk.VoiceConnectionStatus.Destroyed);
      }),
    });
    return { speaking, streams, subscribe, player, connection };
  };
  let transport = createTransport();
  const transports = [transport];
  const firstTransport = transport;
  // Canonical consumers retain initial spy bindings, so spies must outlive manager rotation.
  const sdkSpy = vi.spyOn(sdkRuntime, "loadDiscordVoiceSdk").mockReturnValue({
    ...sdk,
    getVoiceConnection: () => undefined,
    joinVoiceChannel: vi.fn(() => transport.connection),
    createAudioPlayer: vi.fn(() => transport.player),
    entersState: vi.fn(async (target) => target),
  } as unknown as ReturnType<typeof sdkRuntime.loadDiscordVoiceSdk>);
  const writeWav = audio.writeVoiceWavFile;
  const wavCleanups: Promise<void>[] = [];
  const wavSpy = vi.spyOn(audio, "writeVoiceWavFile").mockImplementation(async (pcm) => {
    const wav = await writeWav(pcm);
    const released = createDeferred<void>();
    wavCleanups.push(released.promise);
    return {
      ...wav,
      cleanup: async () => {
        try {
          await wav.cleanup();
        } finally {
          released.resolve();
        }
      },
    };
  });
  const decoding = new Set<Promise<void>>();
  const codecSpy = vi
    .spyOn(audio, "decodeOpusStreamChunks")
    .mockImplementation((input, options) => {
      const work = (async () => {
        for await (const packet of input) {
          // One synthetic packet is 20 ms of stereo PCM. Preserve packet identity for receipts.
          const pcm = Buffer.alloc(960 * 2 * 2);
          pcm.fill(packet[0]);
          await options.onChunk(pcm, packet);
        }
      })();
      decoding.add(work);
      void work.then(
        () => decoding.delete(work),
        () => decoding.delete(work),
      );
      return work;
    });
  const lateStt = createDeferred<void>();
  const wavPaths: string[] = [];
  let installedRuntime: PluginRuntime | undefined;
  let sttSpy: { mockRestore(): void } | undefined;
  const stt = vi.fn<PluginRuntime["mediaUnderstanding"]["transcribeAudioFile"]>(
    async ({ filePath, mime }) => {
      const wav = await fs.readFile(filePath);
      expect(mime).toBe("audio/wav");
      expect(wav.subarray(0, 4).toString()).toBe("RIFF");
      expect(wav.subarray(8, 12).toString()).toBe("WAVE");
      expect(wav.readUInt32LE(24)).toBe(48_000);
      expect(wav.readUInt16LE(22)).toBe(2);
      expect(wav.readUInt32LE(40)).toBe(wav.length - 44);
      expect(wav.subarray(44).equals(Buffer.alloc(960 * 2 * 2, wav[44]))).toBe(true);
      wavPaths.push(filePath);
      if (wav[44] === 2) {
        await lateStt.promise;
        return { text: lateText };
      }
      expect(wav[44]).toBe(1);
      return { text: capturedText };
    },
  );
  const client = {
    fetchChannel: async () => ({
      id: captureTarget.channelId,
      guildId: captureTarget.guildId,
      type: 2,
      name: "synthetic-capture",
    }),
    fetchGuild: async () => ({ id: captureTarget.guildId, name: "Synthetic guild" }),
    fetchMember: async () => ({
      nickname: speakerLabel,
      user: { id: speakerId, username: "synthetic-speaker", bot: false },
      roles: [],
    }),
    getPlugin: (id: string) =>
      id === "voice"
        ? { getGatewayAdapterCreator: () => () => ({ sendPayload: () => true, destroy() {} }) }
        : id === "gateway"
          ? {
              listVoiceChannelStates: () => [
                {
                  user_id: speakerId,
                  channel_id: captureTarget.channelId,
                  member: { nick: speakerLabel, user: { id: speakerId, bot: false } },
                },
              ],
            }
          : undefined,
  } as unknown as Client;
  function restoreRuntime() {
    // A different owner installed during teardown must never be overwritten or cleared.
    const currentRuntime = runtimeStore.tryGetRuntime();
    if (installedRuntime !== undefined && currentRuntime === installedRuntime) {
      if (previousRuntime) {
        runtimeStore.setRuntime(previousRuntime);
      } else {
        runtimeStore.clearRuntime();
      }
    }
  }
  function restore() {
    sttSpy?.mockRestore();
    codecSpy.mockRestore();
    wavSpy.mockRestore();
    sdkSpy.mockRestore();
  }
  const createManager = (cfg: OpenClawConfig) => {
    const createdManager = new DiscordVoiceManager({
      client,
      cfg,
      discordConfig: cfg.channels!.discord!.accounts![captureTarget.accountId]!,
      accountId: captureTarget.accountId,
      botUserId: "810000000000000004",
      runtime: {
        log() {},
        error() {},
        exit: () => {
          throw new Error("unexpected Discord exit");
        },
      },
    });
    setDiscordTranscriptsVoiceManager({
      accountId: captureTarget.accountId,
      manager: createdManager,
    });
    return createdManager;
  };
  let manager: DiscordVoiceManager;
  try {
    manager = createManager(params.cfg);
  } catch (error) {
    restore();
    throw error;
  }
  let entry: VoiceSessionEntry | undefined;
  const entries = new Set<VoiceSessionEntry>();

  async function drain() {
    await Promise.all(decoding);
    // The receiver removes packet listeners only after scheduling its final WAV/STT work.
    await expect
      .poll(() =>
        transports.every((ownedTransport) =>
          ownedTransport.streams.every((stream) => stream.listenerCount("data") === 0),
        ),
      )
      .toBe(true);
    await Promise.all(
      [...entries].flatMap((ownedEntry) => [ownedEntry.processingQueue, ownedEntry.playbackQueue]),
    );
    // Retired capture queues can release before their WAV owner finishes disposal.
    await Promise.all(wavCleanups);
  }

  async function closeCurrentManager() {
    const closingManager = manager;
    const currentEntry = closingManager["sessions"].get(captureTarget.guildId);
    if (currentEntry) {
      entries.add(currentEntry);
    }
    try {
      const captures = await discordVoiceTranscriptsSourceProvider.status!({
        providerId: "discord-voice",
        ...captureTarget,
      });
      for (const capture of captures) {
        if (capture.sessionId) {
          await discordVoiceTranscriptsSourceProvider.stop!({
            sessionId: capture.sessionId,
            source: { providerId: "discord-voice", ...captureTarget },
          });
        }
      }
    } finally {
      try {
        await closingManager.destroy();
      } finally {
        for (const ownedTransport of transports) {
          for (const stream of ownedTransport.streams) {
            stream.destroy();
          }
        }
        lateStt.resolve();
        try {
          await drain();
        } finally {
          setDiscordTranscriptsVoiceManager({
            accountId: captureTarget.accountId,
            manager: null,
            expectedManager: closingManager,
          });
        }
      }
    }
  }

  return {
    register(api: OpenClawPluginApi) {
      // Same probe-type erasure used by defineBundledChannelEntry at registration.
      api.registerChannel({ plugin: discordPlugin as ChannelPlugin });
      registerDiscordTranscriptSourceProvider(api);
    },
    bindPublishedRuntime() {
      expect(sttSpy).toBeUndefined();
      // Registration owns the runtime slot. Intercept only its external STT edge.
      installedRuntime = runtimeStore.getRuntime();
      const media = installedRuntime.mediaUnderstanding;
      sttSpy = vi.spyOn(media, "transcribeAudioFile").mockImplementation(stt);
    },
    async rotateManager(cfg: OpenClawConfig) {
      await closeCurrentManager();
      transport = createTransport();
      transports.push(transport);
      manager = createManager(cfg);
    },
    async expectReady() {
      expect(sttSpy).toBeDefined();
      expect(runtimeStore.getRuntime().mediaUnderstanding.transcribeAudioFile).toBe(sttSpy);
      await expect.poll(() => firstTransport.streams.length).toBe(1);
      // Observe the actual typed session; never construct or mutate a session substitute.
      entry = manager["sessions"].get(captureTarget.guildId);
      if (entry) {
        entries.add(entry);
      }
      expect(entry).toMatchObject({
        captureOnly: true,
        sessionLifecycle: { status: "active" },
        realtimeLifecycle: { status: "inactive", generation: 0 },
        route: { agentId: "main", accountId: captureTarget.accountId },
      });
      expect(entry?.transcripts?.isCurrent()).toBe(true);
      expect(firstTransport.subscribe).toHaveBeenCalledWith(speakerId, {
        end: { behavior: sdk.EndBehaviorType.Manual },
      });
      return { speakerId, speakerLabel, voiceSessionKey: entry!.voiceSessionKey };
    },
    async recordAfterTurn() {
      firstTransport.streams[0]!.end(Buffer.from([1]));
      await drain();
      expect(stt).toHaveBeenCalledTimes(1);
      await expect(fs.stat(wavPaths[0]!)).rejects.toMatchObject({ code: "ENOENT" });
    },
    async beginLateDelivery() {
      expect(runtimeStore.getRuntime().mediaUnderstanding.transcribeAudioFile).toBe(sttSpy);
      firstTransport.speaking.emit("start", speakerId);
      await expect.poll(() => firstTransport.streams.length).toBe(2);
      firstTransport.streams[1]!.end(Buffer.from([2]));
      await expect.poll(() => wavPaths.length).toBe(2);
    },
    async finishLateDelivery() {
      lateStt.resolve();
      await drain();
      expect(stt).toHaveBeenCalledTimes(2);
      expect(manager.status()).toEqual([]);
      expect(entry?.sessionLifecycle.status).toBe("stopped");
      expect(entry?.transcripts).toBeUndefined();
      expect(firstTransport.connection.state.status).toBe(sdk.VoiceConnectionStatus.Destroyed);
      expect(firstTransport.speaking.listenerCount("start")).toBe(0);
      expect(firstTransport.speaking.listenerCount("end")).toBe(0);
      expect(firstTransport.player.play).not.toHaveBeenCalled();
      expect(entry?.capture.size).toBe(0);
      for (const filePath of wavPaths) {
        await expect(fs.stat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
      }
    },
    close: closeCurrentManager,
    restore,
    restoreRuntime,
  };
}
