import {
  createRealtimeVoiceSessionHarness,
  type RealtimeVoiceBridgeCallbacks,
  type RealtimeVoiceBridgeSession,
  type TalkEvent,
} from "openclaw/plugin-sdk/realtime-voice";
import { vi } from "vitest";
import { createVoiceCaptureState } from "./capture-state.js";
import { DiscordRealtimePlayback } from "./realtime-playback.js";
import { DiscordRealtimePlayer } from "./realtime-player.js";
import { createVoiceReceiveRecoveryState } from "./receive-recovery.js";
import { loadDiscordVoiceSdk } from "./sdk-runtime.js";
import type { VoiceSessionEntry } from "./session.js";

export function createRealtimePlaybackFixture(onTalkEvent?: (event: TalkEvent) => void) {
  const voiceSdk = loadDiscordVoiceSdk();
  const player = voiceSdk.createAudioPlayer({
    behaviors: { noSubscriber: voiceSdk.NoSubscriberBehavior.Play, maxMissedFrames: 100 },
  });
  // A signalling-only connection supplies the session shape without opening Discord sockets.
  const connection = new voiceSdk.VoiceConnection(
    {
      guildId: "guild",
      channelId: "voice",
      group: "playback-integration",
      selfDeaf: true,
      selfMute: false,
    },
    { adapterCreator: () => ({ sendPayload: () => true, destroy: () => {} }) },
  );
  const entry: VoiceSessionEntry = {
    generation: 1,
    autoJoinWhenOccupied: false,
    sessionLifecycle: { status: "active" },
    guildId: "guild",
    channelId: "voice",
    sessionChannelId: "voice",
    voiceSessionKey: "agent:main:discord:voice",
    route: {
      agentId: "main",
      channel: "discord",
      accountId: "default",
      sessionKey: "agent:main:discord:voice",
      mainSessionKey: "agent:main:main",
      lastRoutePolicy: "session",
      matchedBy: "default",
    },
    connection,
    player,
    playbackQueue: Promise.resolve(),
    processingQueue: Promise.resolve(),
    audioInputBudget: { enabled: false },
    ttsStreamFallbackWarned: false,
    capture: createVoiceCaptureState(),
    realtimeLifecycle: { status: "inactive", generation: 0 },
    receiveRecovery: createVoiceReceiveRecoveryState(),
    stop: vi.fn(),
  };
  const roomPlayer = new DiscordRealtimePlayer(player);
  const lanes: Array<{ playback: DiscordRealtimePlayback<unknown>; close: () => void }> = [];
  const createLane = (interruption: "decline" | "clear" | "unsupported" = "decline") => {
    let closed = false;
    let bridge: RealtimeVoiceBridgeSession | null = null;
    let callbacks!: RealtimeVoiceBridgeCallbacks;
    const harness = createRealtimeVoiceSessionHarness({
      onTalkEvent,
      talk: {
        sessionId: entry.voiceSessionKey,
        mode: "realtime",
        transport: "gateway-relay",
        brain: "agent-consult",
      },
      talkPayloads: {
        turnStarted: () => ({}),
        turnEnded: () => ({}),
        inputAudioDelta: () => ({}),
        outputAudioStarted: () => ({}),
        outputAudioDelta: () => ({}),
        outputAudioDone: () => ({}),
      },
    });
    const cancel = vi.spyOn(harness, "handleBargeIn");
    const onTerminalError = vi.fn();
    const stopTerminally = vi.fn();
    const sendUserMessage = vi.fn();
    const acknowledgeMark = vi.fn();
    const playback = new DiscordRealtimePlayback({
      bridge: () => bridge,
      bridgeReady: () => true,
      buildSpeakExactMessage: (text) => text,
      entry,
      player: roomPlayer,
      harness,
      markProviderGenerationObserved: () => {},
      mode: "agent-proxy",
      onTerminalError,
      providerId: () => "openai",
      realtimeConfig: () => undefined,
      stopTerminally,
      stopped: () => closed,
      wakeNameRequired: () => false,
    });
    bridge = harness.createBridge({
      provider: {
        id: "synthetic",
        label: "Synthetic",
        isConfigured: () => true,
        createBridge: (events) => {
          callbacks = events;
          return {
            connect: async () => {},
            close: () => {},
            sendAudio: () => {},
            sendUserMessage,
            setMediaTimestamp: () => {},
            acknowledgeMark,
            submitToolResult: () => {},
            isConnected: () => true,
            ...(interruption === "unsupported"
              ? {}
              : { handleBargeIn: () => interruption === "clear" && events.onClearAudio() }),
          };
        },
      },
      providerConfig: {},
      audioSink: {
        sendAudio: (audio, metadata) => playback.sendOutputAudio(audio, metadata),
        sendMark: (markName, acknowledge) =>
          acknowledge ? playback.sendOutputMark(acknowledge) : bridge?.acknowledgeMark(markName),
        getPlaybackState: () => playback.getPlaybackState(),
        clearAudio: () => harness.flushOutput(() => playback.clearOutputAudio("provider-clear")),
      },
      onResponseDone: (outcome) => playback.handleResponseDone(outcome),
      onEvent: (event) => {
        if (event.direction === "server" && event.type === "response.created") {
          playback.beginResponse();
        }
      },
    });
    const lane = {
      playback,
      harness,
      callbacks,
      cancel,
      onTerminalError,
      stopTerminally,
      sendUserMessage,
      acknowledgeMark,
      close() {
        closed = true;
        playback.close();
        harness.close();
        bridge?.close();
        cancel.mockRestore();
      },
    };
    lanes.push(lane);
    return lane;
  };
  const firstLane = createLane();
  const stop = vi.spyOn(player, "stop");
  const onPlayerError = vi.fn();
  player.on("error", onPlayerError);

  return {
    voiceSdk,
    player,
    ...firstLane,
    createLane,
    roomPlayer,
    stop,
    onPlayerError,
    close() {
      roomPlayer.close();
      for (const lane of lanes) {
        lane.close();
      }
      connection.destroy();
      player.off("error", onPlayerError);
      stop.mockRestore();
    },
  };
}
