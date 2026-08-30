import {
  readCodexCliCredentialsCached,
  resolveOpenAICodexAuthIdentity,
} from "openclaw/plugin-sdk/provider-auth";
import { describe, expect, it } from "vitest";
import type { OpenAIQuicksilverPendingAudio } from "./realtime-quicksilver-audio-buffer.js";
import { OpenAIQuicksilverGatewayBridge } from "./realtime-quicksilver-gateway-bridge.js";
import {
  OpenAIQuicksilverAudioPeer,
  type OpenAIQuicksilverAudioPeerContract,
} from "./realtime-quicksilver-peer.runtime.js";
import { resolveOpenAIChatGptSubscriptionAuth } from "./realtime-quicksilver-session.js";
import type { OpenAIQuicksilverAuth } from "./realtime-quicksilver-wire.js";
import { buildOpenAISpeechProvider } from "./speech-provider.js";

const LIVE_ENABLED =
  process.env.OPENCLAW_LIVE_TEST === "1" && process.env.OPENCLAW_LIVE_GPT_LIVE === "1";
const describeLive = LIVE_ENABLED ? describe : describe.skip;
const LIVE_TIMEOUT_MS = 60_000;
const MAX_PENDING_AUDIO_BYTES = 240_000;

type TestableGatewayBridge = {
  pendingAudio: OpenAIQuicksilverPendingAudio;
};

async function waitForLiveCondition(
  predicate: () => boolean,
  describeFailure: () => string,
  timeoutMs = 45_000,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
  }
  throw new Error(describeFailure());
}

async function resolveLiveOAuthProfile(): Promise<
  Extract<OpenAIQuicksilverAuth, { type: "oauth" }> | undefined
> {
  try {
    const profile = await resolveOpenAIChatGptSubscriptionAuth({});
    if (profile) {
      return profile;
    }
  } catch (error) {
    if (!(error instanceof Error) || error.name !== "AuthProfileMigrationRequiredError") {
      throw error;
    }
  }
  const credential = readCodexCliCredentialsCached({ allowKeychainPrompt: false, ttlMs: 0 });
  if (!credential) {
    return undefined;
  }
  const accountId =
    credential.accountId ?? resolveOpenAICodexAuthIdentity({ access: credential.access }).accountId;
  return accountId ? { type: "oauth", token: credential.access, accountId } : undefined;
}

describeLive("OpenAI GPT-Live gateway WebRTC peer", () => {
  it(
    "creates a real call, joins sideband, and receives audio",
    async ({ skip }) => {
      const auth = await resolveLiveOAuthProfile();
      if (!auth) {
        skip("No ChatGPT OAuth profile is available");
        return;
      }

      let ready!: () => void;
      let audioObserved!: (source: string) => void;
      let fail!: (error: Error) => void;
      const eventTypes: string[] = [];
      const readyResult = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const audioResult = new Promise<string>((resolve) => {
        audioObserved = resolve;
      });
      const failureResult = new Promise<never>((_resolve, reject) => {
        fail = (error) => reject(new Error(`${error.message}; events=${eventTypes.join(",")}`));
      });
      const bridge = new OpenAIQuicksilverGatewayBridge({
        providerConfig: {},
        model: "gpt-live-1-codex",
        voice: "spruce",
        instructions:
          "This is a live transport check. Immediately say: OpenClaw gateway relay test OK.",
        audioFormat: { encoding: "pcm16", sampleRateHz: 24_000, channels: 1 },
        onAudio: (audio) => {
          if (audio.length > 0) {
            audioObserved("decoded-pcm");
          }
        },
        onClearAudio: () => undefined,
        onEvent: (event) => eventTypes.push(event.type),
        onReady: ready,
        onError: fail,
        runAgentConsult: async () => ({ text: "The live transport check is complete." }),
        logger: { debug: () => undefined, warn: () => undefined },
        resolveAuth: async () => auth,
      });

      try {
        await bridge.connect();
        await expect(Promise.race([readyResult, failureResult])).resolves.toBeUndefined();
        await expect(Promise.race([audioResult, failureResult])).resolves.toBe("decoded-pcm");
      } finally {
        bridge.close();
      }
    },
    LIVE_TIMEOUT_MS,
  );

  it(
    "delivers microphone speech queued before the real media peer is adopted",
    async ({ skip }) => {
      const apiKey = process.env.OPENAI_API_KEY?.trim();
      if (!apiKey) {
        skip("No OpenAI Platform API key is available for the speech fixture");
        return;
      }

      const speechProvider = buildOpenAISpeechProvider();
      const synthesized = await speechProvider.synthesizeTelephony?.({
        text: "Please delegate the word glacier.",
        cfg: { plugins: { enabled: true } } as never,
        providerConfig: {
          apiKey,
          baseUrl: "https://api.openai.com/v1",
          model: "gpt-4o-mini-tts",
          voice: "alloy",
          speed: 1.4,
        },
        timeoutMs: 45_000,
      });
      if (!synthesized) {
        throw new Error("OpenAI speech provider did not return a telephony fixture");
      }
      expect(synthesized.outputFormat).toBe("pcm");
      expect(synthesized.sampleRate).toBe(24_000);
      const inputAudio = Buffer.concat([synthesized.audioBuffer, Buffer.alloc(24_000 * 2)]);
      expect(inputAudio.byteLength).toBeLessThanOrEqual(MAX_PENDING_AUDIO_BYTES);

      let releasePeerAdoption!: () => void;
      let peerCreated!: () => void;
      const peerAdoption = new Promise<void>((resolve) => {
        releasePeerAdoption = resolve;
      });
      const peerCreation = new Promise<void>((resolve) => {
        peerCreated = resolve;
      });
      const eventTypes: string[] = [];
      const finalUserTranscripts: string[] = [];
      const errors: Error[] = [];
      let closeNotifications = 0;
      let closed = false;
      let lateAudioBytes = 0;
      const bridge = new OpenAIQuicksilverGatewayBridge({
        providerConfig: {},
        model: "gpt-live-1-boulder-alpha",
        voice: "spruce",
        instructions: "Listen to the user. Do not speak or delegate.",
        audioFormat: { encoding: "pcm16", sampleRateHz: 24_000, channels: 1 },
        onAudio: (audio) => {
          if (closed) {
            lateAudioBytes += audio.length;
          }
        },
        onClearAudio: () => undefined,
        onEvent: (event) => eventTypes.push(event.type),
        onReady: () => undefined,
        onTranscript: (role, text, final) => {
          if (role === "user" && final) {
            finalUserTranscripts.push(text);
          }
        },
        onClose: () => {
          closeNotifications += 1;
        },
        onError: (error) => errors.push(error),
        runAgentConsult: async () => ({ text: "Unexpected delegation." }),
        logger: { debug: () => undefined, warn: () => undefined },
        resolveAuth: async () => ({ type: "api-key", token: apiKey }),
        createPeer: async (callbacks, signal): Promise<OpenAIQuicksilverAudioPeerContract> => {
          const peer = await OpenAIQuicksilverAudioPeer.create({ callbacks, signal });
          peerCreated();
          await peerAdoption;
          return peer;
        },
      });
      const testBridge = bridge as unknown as TestableGatewayBridge;

      try {
        const connection = bridge.connect();
        await Promise.race([
          peerCreation,
          connection.then(() => {
            throw new Error("Gateway bridge connected before the media peer adoption gate");
          }),
        ]);
        for (let offset = 0; offset < inputAudio.length; offset += 8_192) {
          bridge.sendAudio(Buffer.from(inputAudio.subarray(offset, offset + 8_192)));
        }
        const prePeerPendingBytes = testBridge.pendingAudio.length;
        expect(prePeerPendingBytes).toBe(inputAudio.length);

        releasePeerAdoption();
        await connection;
        await waitForLiveCondition(
          () => finalUserTranscripts.some((text) => text.toLowerCase().includes("glacier")),
          () =>
            `GPT-Live did not transcribe startup audio: transcripts=${finalUserTranscripts.length} errors=${errors.map((error) => error.message).join(";")}`,
          30_000,
        );

        const postAdoptionPendingBytes = testBridge.pendingAudio.length;
        expect(postAdoptionPendingBytes).toBe(0);
        expect(eventTypes).toContain("turn.done");
        expect(bridge.isConnected()).toBe(true);
        expect(errors).toStrictEqual([]);

        closed = true;
        bridge.close();
        bridge.close();
        await new Promise((resolve) => {
          setTimeout(resolve, 250);
        });

        expect(closeNotifications).toBe(1);
        expect(lateAudioBytes).toBe(0);
        expect(errors).toStrictEqual([]);
        console.log(
          JSON.stringify({
            proof: "gpt-live-gateway-pre-peer-transcription",
            prePeerPendingBytes,
            postAdoptionPendingBytes,
            userTranscriptMarker: true,
            closeNotifications,
            lateAudioBytes,
            errors: errors.length,
            result: "pass",
          }),
        );
      } finally {
        releasePeerAdoption();
        bridge.close();
      }
    },
    LIVE_TIMEOUT_MS,
  );
});
