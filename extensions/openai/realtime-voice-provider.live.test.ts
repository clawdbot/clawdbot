// OpenAI tests cover the native realtime voice bridge against the live API.
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  createRealtimeVoiceSessionHarness,
  type RealtimeVoiceResponseOutcome,
} from "openclaw/plugin-sdk/realtime-voice";
import { withTimeout } from "openclaw/plugin-sdk/text-utility-runtime";
import { describe, expect, it } from "vitest";
import { buildOpenAIRealtimeVoiceProvider } from "./realtime-voice-provider.js";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY?.trim() ?? "";
const LIVE_ENABLED = OPENAI_API_KEY.length > 0 && process.env.OPENCLAW_LIVE_TEST === "1";
const describeLive = LIVE_ENABLED ? describe : describe.skip;

describeLive("OpenAI realtime voice lifecycle live", () => {
  it("speaks again after a rejected manual response on the same connection", async () => {
    const rejected = createDeferred<void>();
    const completed = createDeferred<void>();
    const outcomes: RealtimeVoiceResponseOutcome[] = [];
    const transcripts: string[] = [];
    const errors: string[] = [];
    let audioBytes = 0;
    const harness = createRealtimeVoiceSessionHarness({
      talk: {
        sessionId: "live-response-rejection",
        mode: "realtime",
        transport: "gateway-relay",
        brain: "agent-consult",
        provider: "openai",
      },
      talkPayloads: {
        turnStarted: () => ({}),
        turnEnded: (reason) => ({ reason }),
        inputAudioDelta: (audio) => ({ byteLength: audio.byteLength }),
        outputAudioStarted: () => ({}),
        outputAudioDelta: (audio) => ({ byteLength: audio.byteLength }),
        outputAudioDone: (reason) => ({ reason }),
      },
    });
    const session = harness.createBridge({
      provider: buildOpenAIRealtimeVoiceProvider(),
      providerConfig: { apiKey: OPENAI_API_KEY, model: "gpt-realtime-2.1", voice: "marin" },
      instructions: "Only say the exact verification phrase requested by the user.",
      autoRespondToAudio: false,
      audioSink: {
        sendAudio: (audio) => {
          audioBytes += audio.byteLength;
        },
      },
      onTranscript: (role, text, isFinal) => {
        if (role === "assistant" && isFinal) {
          transcripts.push(text);
        }
      },
      onError: (error) => {
        errors.push(error.message);
        rejected.resolve();
      },
      onResponseDone: (outcome) => {
        outcomes.push(outcome);
        if (outcome.status === "failed") {
          session.sendUserMessage("Say exactly: Voice recovery verified.");
        } else if (outcome.status === "completed") {
          completed.resolve();
        }
      },
    });

    try {
      await session.connect();
      session.bridge.sendUserMessage?.("Run the unavailable verification tool.", {
        toolChoice: { type: "function", name: "unavailable_verification_tool" },
      });
      await withTimeout(rejected.promise, 20_000, {
        message: "Expected response.create rejection",
      });
      expect(outcomes).toMatchObject([{ status: "failed" }]);
      await withTimeout(completed.promise, 30_000, {
        message: "Expected recovered spoken response",
      });
      expect(outcomes.map((outcome) => outcome.status)).toEqual(["failed", "completed"]);
      expect(errors).toHaveLength(1);
      expect(audioBytes).toBeGreaterThan(0);
      expect(transcripts.join(" ")).toMatch(/voice recovery verified/i);
      expect(session.bridge.isConnected()).toBe(true);
    } finally {
      session.close();
      harness.close();
    }
  }, 60_000);

  it("reuses a bridge after a terminal close", async () => {
    let closeCount = 0;
    let readyCount = 0;
    const errors: Error[] = [];
    const bridge = buildOpenAIRealtimeVoiceProvider().createBridge({
      providerConfig: {
        apiKey: OPENAI_API_KEY,
        model: "gpt-realtime-2.1",
        voice: "marin",
      },
      instructions: "Keep this lifecycle verification session silent.",
      autoRespondToAudio: false,
      onAudio: () => {},
      onClearAudio: () => {},
      onClose: () => {
        closeCount += 1;
      },
      onError: (error) => {
        errors.push(error);
      },
      onReady: () => {
        readyCount += 1;
      },
    });

    try {
      await bridge.connect();
      expect(bridge.isConnected()).toBe(true);
      bridge.close();

      await bridge.connect();
      expect(bridge.isConnected()).toBe(true);
    } finally {
      bridge.close();
    }

    expect(errors).toEqual([]);
    expect(readyCount).toBe(2);
    expect(closeCount).toBe(2);
  }, 60_000);
});
