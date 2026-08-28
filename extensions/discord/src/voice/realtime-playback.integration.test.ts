import { once } from "node:events";
import { createRealtimeVoiceSessionHarness } from "openclaw/plugin-sdk/realtime-voice";
import { expect, it, vi } from "vitest";
import { createVoiceCaptureState } from "./capture-state.js";
import { DiscordRealtimePlayback } from "./realtime-playback.js";
import { createVoiceReceiveRecoveryState } from "./receive-recovery.js";
import { loadDiscordVoiceSdk } from "./sdk-runtime.js";
import type { VoiceSessionEntry } from "./session.js";

it("plays every frame of a burst through the real Opus encoder before releasing queued speech", async () => {
  const voiceSdk = loadDiscordVoiceSdk();
  const player = voiceSdk.createAudioPlayer({
    behaviors: { noSubscriber: voiceSdk.NoSubscriberBehavior.Play },
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
    ttsStreamFallbackWarned: false,
    capture: createVoiceCaptureState(),
    realtimeLifecycle: { status: "inactive", generation: 0 },
    receiveRecovery: createVoiceReceiveRecoveryState(),
    stop: vi.fn(),
  };
  const harness = createRealtimeVoiceSessionHarness({
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
  const stop = vi.spyOn(player, "stop");
  const onTerminalError = vi.fn();
  const onPlayerError = vi.fn();
  const stopTerminally = vi.fn();
  const playback = new DiscordRealtimePlayback({
    bridge: () => null,
    bridgeReady: () => true,
    buildSpeakExactMessage: (text) => text,
    entry,
    harness,
    markProviderGenerationObserved: () => {},
    mode: "agent-proxy",
    onTerminalError,
    providerId: () => "openai",
    realtimeConfig: () => undefined,
    stopTerminally,
    stopped: () => false,
    wakeNameRequired: () => false,
  });
  player.on("error", onPlayerError);
  playback.attachPlayer();

  try {
    playback.enqueueExactSpeechMessage("first answer");
    // Seventeen 400 ms provider chunks exceed the PCM stream's normal backpressure threshold.
    const pcm = Buffer.alloc(24_000 * 2 * 0.4);
    for (let sample = 0; sample < pcm.length / 2; sample += 1) {
      pcm.writeInt16LE(
        Math.round(8_000 * Math.sin((sample * 2 * Math.PI * 440) / 24_000)),
        sample * 2,
      );
    }
    for (let chunk = 0; chunk < 17; chunk += 1) {
      playback.sendOutputAudio(pcm);
    }
    playback.enqueueExactSpeechMessage("second answer");
    const state = player.state;
    if (state.status === voiceSdk.AudioPlayerStatus.Idle) {
      throw new Error("Discord discarded the burst before playback could drain");
    }
    const resource = state.resource;
    const stream = playback.currentOutputStream();
    if (!stream) {
      throw new Error("expected a live PCM stream");
    }
    const sourceClosed = once(stream, "close");

    playback.handleResponseDone({ status: "completed" });
    await sourceClosed;

    // PCM encoding can finish while the Discord resource still has audible frames to play.
    expect(player.state.status).not.toBe(voiceSdk.AudioPlayerStatus.Idle);
    expect(playback.retainedExactSpeechTexts()).toEqual(["first answer", "second answer"]);
    await voiceSdk.entersState(player, voiceSdk.AudioPlayerStatus.Idle, 12_000);

    // The real AudioResource counts source packets only, excluding its silence padding.
    expect(resource.playbackDuration).toBe(6_800);
    expect(playback.retainedExactSpeechTexts()).toEqual(["second answer"]);
    expect(playback.isOutputAudioActive()).toBe(false);
    expect(cancel).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    expect(stopTerminally).not.toHaveBeenCalled();
    expect(onTerminalError).not.toHaveBeenCalled();
    expect(onPlayerError).not.toHaveBeenCalled();
  } finally {
    playback.close();
    harness.close();
    connection.destroy();
    player.off("error", onPlayerError);
    cancel.mockRestore();
    stop.mockRestore();
  }
}, 15_000);
