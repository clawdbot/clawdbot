import { describe, expect, it } from "vitest";
import { buildGoogleLiveUrl } from "./chat/realtime-talk-google-live.ts";
import type { RealtimeTalkJsonPcmWebSocketSessionResult } from "./chat/realtime-talk-shared.ts";

function createSession(
  websocketUrl: string,
  clientSecret = "auth_tokens/browser-session",
): RealtimeTalkJsonPcmWebSocketSessionResult {
  return {
    provider: "google",
    transport: "json-pcm-websocket",
    protocol: "google-live-bidi",
    clientSecret,
    websocketUrl,
    audio: {
      inputEncoding: "pcm16",
      inputSampleRateHz: 16000,
      outputEncoding: "pcm16",
      outputSampleRateHz: 24000,
    },
  };
}

describe("Google Live realtime Talk URL", () => {
  it("only preserves the allowlisted Google Live endpoint and appends the ephemeral token", () => {
    const url = buildGoogleLiveUrl(
      createSession(
        "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained?ignored=1",
      ),
    );

    expect(url).toBe(
      "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained?access_token=auth_tokens%2Fbrowser-session",
    );
  });

  it("rejects attacker-controlled Google Live WebSocket URLs", () => {
    expect(() =>
      buildGoogleLiveUrl(createSession("ws://generativelanguage.googleapis.com/ws/google.ai")),
    ).toThrow("wss://");
    expect(() =>
      buildGoogleLiveUrl(
        createSession(
          "wss://attacker.test/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained",
        ),
      ),
    ).toThrow("Untrusted Google Live WebSocket host");
    expect(() =>
      buildGoogleLiveUrl(createSession("wss://generativelanguage.googleapis.com/evil")),
    ).toThrow("Untrusted Google Live WebSocket path");
  });
});
