import { describe, expect, it } from "vitest";
import { volcengineTTS } from "./tts.js";

const seedSpeechApiKey =
  process.env.VOLCENGINE_TTS_API_KEY ?? process.env.BYTEPLUS_SEED_SPEECH_API_KEY;
const hasVolcengineTtsCredentials = Boolean(
  seedSpeechApiKey || (process.env.VOLCENGINE_TTS_APPID && process.env.VOLCENGINE_TTS_TOKEN),
);
const describeLive =
  process.env.OPENCLAW_LIVE_TEST === "1" && hasVolcengineTtsCredentials ? describe : describe.skip;

describeLive("Volcengine TTS live", () => {
  it("synthesizes mp3 audio with .profile credentials", async () => {
    const audio = await volcengineTTS({
      text: "OpenClaw live test.",
      apiKey: seedSpeechApiKey,
      appId: process.env.VOLCENGINE_TTS_APPID,
      token: process.env.VOLCENGINE_TTS_TOKEN,
      voice: process.env.VOLCENGINE_TTS_VOICE,
      cluster: process.env.VOLCENGINE_TTS_CLUSTER,
      resourceId: process.env.VOLCENGINE_TTS_RESOURCE_ID,
      appKey: process.env.VOLCENGINE_TTS_APP_KEY,
      baseUrl: process.env.VOLCENGINE_TTS_BASE_URL,
      encoding: "mp3",
      timeoutMs: 30_000,
    });

    expect(audio.length).toBeGreaterThan(128);
  });
});
