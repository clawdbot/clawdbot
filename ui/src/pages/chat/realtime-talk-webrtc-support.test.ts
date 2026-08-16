// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { RealtimeTalkWebRtcOfferExchange } from "./realtime-talk-webrtc-support.ts";

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
