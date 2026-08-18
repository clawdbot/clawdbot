// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RealtimeTalkWebRtcOfferExchange,
  realtimeTalkInputTranscriptionUpdate,
} from "./realtime-talk-webrtc-support.ts";

describe("RealtimeTalkWebRtcOfferExchange", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resolves relative offer routes against the connected Gateway", async () => {
    const fetchMock = vi.fn(async () => new Response("answer-sdp"));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const exchange = new RealtimeTalkWebRtcOfferExchange();

    await exchange.readAnswer({
      session: {
        provider: "openai",
        transport: "webrtc",
        clientSecret: "reservation-token",
        offerUrl: "/plugins/codex/realtime/calls",
      },
      offer: { type: "offer", sdp: "offer-sdp" },
      gatewayUrl: "wss://gateway.example.test/control?tenant=a",
      isCurrent: () => true,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://gateway.example.test/plugins/codex/realtime/calls",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer reservation-token",
        }),
      }),
    );
  });
});

describe("realtimeTalkInputTranscriptionUpdate", () => {
  it("requests transcription for a session created without it", () => {
    expect(
      realtimeTalkInputTranscriptionUpdate({
        type: "session.created",
        session: { audio: { input: { turn_detection: { type: "server_vad" } } } },
      }),
    ).toEqual({
      type: "session.update",
      session: {
        type: "realtime",
        audio: { input: { transcription: { model: "gpt-4o-mini-transcribe" } } },
      },
    });
  });

  it("leaves a session that already transcribes input alone", () => {
    expect(
      realtimeTalkInputTranscriptionUpdate({
        type: "session.created",
        session: { audio: { input: { transcription: { model: "whisper-1" } } } },
      }),
    ).toBeNull();
  });
});
