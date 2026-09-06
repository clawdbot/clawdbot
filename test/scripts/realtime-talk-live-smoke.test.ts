import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { RealtimeVoiceBridgeCreateRequest } from "../../src/talk/provider-types.js";

const backend = vi.hoisted(() => ({ onFirstAudio: () => {} }));

const browser = vi.hoisted(() => ({
  close: vi.fn(async () => {}),
  contextClose: vi.fn(async () => {}),
  evaluate: vi.fn(async () => ({
    answerHasAudio: true,
    remoteDescriptionApplied: true,
    connectionState: "failed",
    transcriptMarker: false,
    responseDone: false,
    outputAudioBytes: 0,
    outputAudioEnergy: 0,
    outputAudioSamplesDuration: 0,
    outputAudioSpeechDuration: 0,
    outputAudioPeakRms: 0,
  })),
}));

vi.mock("playwright", () => ({
  chromium: {
    launch: async () => ({
      close: browser.close,
      newContext: async () => ({
        close: browser.contextClose,
        newPage: async () => ({ evaluate: browser.evaluate }),
      }),
    }),
  },
}));

vi.mock("../../extensions/openai/realtime-voice-provider.ts", () => ({
  buildOpenAIRealtimeVoiceProvider: () => ({
    createBridge: (options: RealtimeVoiceBridgeCreateRequest) => {
      const onFirstAudio = backend.onFirstAudio;
      let responded = false;
      return {
        connect: async () => {},
        isConnected: () => true,
        close: () => {},
        sendAudio: () => {
          if (responded) {
            return;
          }
          responded = true;
          onFirstAudio();
          options.onAudio(Buffer.alloc(1024));
          options.onTranscript?.("user", "glacier", true);
          options.onTranscript?.("assistant", "glacier", true);
          options.onEvent?.({ direction: "server", type: "response.done" });
        },
      };
    },
  }),
}));

vi.mock("../../extensions/openai/speech-provider.ts", () => ({
  buildOpenAISpeechProvider: () => ({
    synthesizeTelephony: async () => ({
      audioBuffer: Buffer.alloc(2),
      outputFormat: "pcm",
      sampleRate: 24_000,
    }),
  }),
}));

const originalArgv = process.argv;
const originalExitCode = process.exitCode;

afterEach(() => {
  vi.useRealTimers();
  backend.onFirstAudio = () => {};
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it.each([
  {
    name: "failed browser media",
    connectionState: "failed",
    outputAudioEnergy: 0.002,
    speechSeconds: 0.2,
    transcriptMarker: true,
    ok: false,
  },
  {
    name: "silent browser audio",
    connectionState: "connected",
    outputAudioEnergy: 0,
    speechSeconds: 0,
    transcriptMarker: true,
    ok: false,
  },
  {
    name: "comfort noise despite a completed transcript",
    connectionState: "connected",
    outputAudioEnergy: 2.2539e-8,
    speechSeconds: 0,
    transcriptMarker: true,
    ok: false,
  },
  {
    name: "audio too brief to establish speech",
    connectionState: "connected",
    outputAudioEnergy: 0.002,
    speechSeconds: 0.02,
    transcriptMarker: true,
    ok: false,
  },
  {
    name: "unrelated browser audio",
    connectionState: "connected",
    outputAudioEnergy: 0.002,
    speechSeconds: 0.2,
    transcriptMarker: false,
    ok: false,
  },
  {
    name: "completed browser speech",
    connectionState: "connected",
    outputAudioEnergy: 0.002,
    speechSeconds: 0.2,
    transcriptMarker: true,
    ok: true,
  },
])(
  "reports $name through the smoke command",
  async ({ connectionState, outputAudioEnergy, speechSeconds, transcriptMarker, ok }) => {
    vi.resetModules();
    vi.clearAllMocks();
    browser.evaluate.mockResolvedValue({
      answerHasAudio: true,
      remoteDescriptionApplied: true,
      connectionState,
      transcriptMarker,
      responseDone: true,
      outputAudioBytes: 1024,
      outputAudioEnergy,
      outputAudioSamplesDuration: 0.5,
      outputAudioSpeechDuration: speechSeconds,
      outputAudioPeakRms: Math.sqrt(outputAudioEnergy / 0.5),
    });
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    vi.stubEnv("OPENCLAW_REALTIME_OPENAI_MODEL", "gpt-realtime-2.1");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ value: "test-client-secret" })),
    );
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    process.argv = [
      process.execPath,
      path.resolve("scripts/dev/realtime-talk-live-smoke.ts"),
      "--openai-only",
    ];
    process.exitCode = undefined;

    const firstAudio = new Promise<void>((resolve) => {
      backend.onFirstAudio = () => resolve();
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const command = import("../../scripts/dev/realtime-talk-live-smoke.ts");
    // Let imports reach streaming before advancing the pacing and close-observation timers.
    await Promise.race([
      firstAudio,
      command.then(() => {
        throw new Error("Smoke command completed before sending backend audio");
      }),
    ]);
    await vi.runAllTimersAsync();
    await command;
    expect(vi.getTimerCount()).toBe(0);

    expect(output).toHaveBeenCalledWith("openai-backend-bridge: ok", expect.any(Object));
    expect(output).toHaveBeenCalledWith("openai-backend-audio-roundtrip: ok", expect.any(Object));
    expect(output).toHaveBeenCalledWith(
      `openai-webrtc-browser: ${ok ? "ok" : "failed"}`,
      expect.objectContaining({ protocol: "ga-realtime" }),
    );
    expect(process.exitCode).toBe(ok ? undefined : 1);
    expect(browser.contextClose).toHaveBeenCalledOnce();
    expect(browser.close).toHaveBeenCalledOnce();
  },
);
