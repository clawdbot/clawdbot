import { readCodexCliCredentialsCached } from "openclaw/plugin-sdk/provider-auth";
import { describe, expect, it } from "vitest";
import { resolveCodexAuthIdentity } from "./openai-chatgpt-auth-identity.js";
import { OpenAIQuicksilverGatewayBridge } from "./realtime-quicksilver-gateway-bridge.js";
import { resolveOpenAIChatGptSubscriptionAuth } from "./realtime-quicksilver-session.js";
import type { OpenAIQuicksilverAuth } from "./realtime-quicksilver-wire.js";

const LIVE_ENABLED =
  process.env.OPENCLAW_LIVE_TEST === "1" && process.env.OPENCLAW_LIVE_GPT_LIVE === "1";
const describeLive = LIVE_ENABLED ? describe : describe.skip;
const LIVE_TIMEOUT_MS = 60_000;

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
    credential.accountId ?? resolveCodexAuthIdentity({ accessToken: credential.access }).accountId;
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
        voice: "marin",
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
});
