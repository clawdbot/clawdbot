// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebRtcSdpRealtimeTalkTransport } from "./chat/realtime-talk-webrtc.ts";

class FakeDataChannel extends EventTarget {
  readyState: RTCDataChannelState = "open";
  send = vi.fn();
  close = vi.fn(() => {
    this.readyState = "closed";
  });
}

class FakePeerConnection extends EventTarget {
  connectionState: RTCPeerConnectionState = "new";
  readonly channel = new FakeDataChannel();
  readonly addTrack = vi.fn();
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;

  createDataChannel(): RTCDataChannel {
    return this.channel as unknown as RTCDataChannel;
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: "offer", sdp: "offer-sdp" };
  }

  async setLocalDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.localDescription = description;
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDescription = description;
  }

  close(): void {
    this.connectionState = "closed";
  }
}

describe("WebRtcSdpRealtimeTalkTransport", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    const track = { stop: vi.fn() } as unknown as MediaStreamTrack;
    const stream = {
      getAudioTracks: () => [track],
      getTracks: () => [track],
    } as unknown as MediaStream;
    Object.defineProperty(globalThis.navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn(async () => stream),
      },
    });
    vi.stubGlobal("RTCPeerConnection", FakePeerConnection as unknown as typeof RTCPeerConnection);
  });

  it("sends provider offer headers with the WebRTC SDP request", async () => {
    const fetchMock = vi.fn(async () => new Response("answer-sdp"));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const transport = new WebRtcSdpRealtimeTalkTransport(
      {
        provider: "openai",
        transport: "webrtc-sdp",
        clientSecret: "client-secret-123",
        offerUrl: "https://api.openai.com/v1/realtime/calls",
        offerHeaders: {
          originator: "openclaw",
          version: "2026.3.22",
        },
      },
      {
        client: {} as never,
        sessionKey: "main",
        callbacks: {},
      },
    );

    await transport.start();

    expect(fetchMock).toHaveBeenCalledWith("https://api.openai.com/v1/realtime/calls", {
      method: "POST",
      body: "offer-sdp",
      headers: {
        originator: "openclaw",
        version: "2026.3.22",
        Authorization: "Bearer client-secret-123",
        "Content-Type": "application/sdp",
      },
    });
    transport.stop();
  });
});
