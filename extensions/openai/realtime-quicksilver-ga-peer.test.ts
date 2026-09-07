import { describe, expect, it, vi } from "vitest";
import { RTCPeerConnection, RTCSessionDescription, useOPUS, type RTCDataChannel } from "werift";
import { OpenAIQuicksilverAudioPeer } from "./realtime-quicksilver-peer.runtime.js";

// werift-ice 0.2.2 defaults an empty server list to public STUN. Isolate the
// dependency boundary, not the production peer: keep real ICE/DTLS/SCTP and
// Opus but enumerate loopback only and disable its STUN client before gathering.
vi.mock("werift", async (importOriginal) => {
  const actual = await importOriginal<typeof import("werift")>();
  class LoopbackPeer extends actual.RTCPeerConnection {
    constructor(config: ConstructorParameters<typeof actual.RTCPeerConnection>[0]) {
      super({
        ...config,
        iceUseIpv4: false,
        iceUseIpv6: false,
        iceAdditionalHostAddresses: ["127.0.0.1"],
        iceInterfaceAddresses: { udp4: "127.0.0.1" },
      });
    }
    private isolateIce(): void {
      for (const transport of this.iceTransports) {
        transport.connection.stunServer = undefined;
      }
    }
    override async createOffer(...args: Parameters<RTCPeerConnection["createOffer"]>) {
      this.isolateIce();
      return super.createOffer(...args);
    }
    override async createAnswer() {
      this.isolateIce();
      return super.createAnswer();
    }
  }
  return { ...actual, RTCPeerConnection: LoopbackPeer };
});

describe("optional GA channel on the native PCM peer", () => {
  it("does not begin ICE gathering after closing during offer preparation", async () => {
    let resolve!: (offer: Awaited<ReturnType<RTCPeerConnection["createOffer"]>>) => void;
    const pending = new Promise<Awaited<ReturnType<RTCPeerConnection["createOffer"]>>>((done) => {
      resolve = done;
    });
    const createOffer = vi
      .spyOn(RTCPeerConnection.prototype, "createOffer")
      .mockReturnValueOnce(pending);
    const setLocalDescription = vi.spyOn(RTCPeerConnection.prototype, "setLocalDescription");
    const peer = await OpenAIQuicksilverAudioPeer.create({
      callbacks: { onAudio: vi.fn(), onError: vi.fn() },
      iceServers: [],
    });
    try {
      const offer = peer.createOffer();
      peer.close();
      resolve(new RTCSessionDescription("v=0\r\n", "offer"));
      await expect(offer).rejects.toThrow("closed");
      expect(setLocalDescription).not.toHaveBeenCalled();
      await expect(peer.applyAnswer("v=0\r\n")).rejects.toThrow("closed");
    } finally {
      peer.close();
      createOffer.mockRestore();
      setLocalDescription.mockRestore();
    }
  });

  it("leaves native offers audio-only", async () => {
    const peer = await OpenAIQuicksilverAudioPeer.create({
      iceServers: [],
      callbacks: { onAudio: vi.fn(), onError: vi.fn() },
    });
    try {
      const offer = await peer.createOffer();
      expect(offer).toContain("m=audio ");
      expect(offer.toLowerCase()).toContain("opus/48000/2");
      expect(offer).not.toContain("typ srflx");
      expect(offer).toContain("127.0.0.1");
      expect(offer).not.toContain("m=application ");
      expect(() => peer.sendControl("{}")).toThrow("not open");
    } finally {
      peer.close();
    }
  });

  it("negotiates the production ordered SCTP channel on localhost and closes it with media", async () => {
    const received = vi.fn();
    const onOpen = vi.fn();
    const onError = vi.fn();
    const peer = await OpenAIQuicksilverAudioPeer.create({
      iceServers: [],
      callbacks: { onAudio: vi.fn(), onError },
      gaDataChannel: { onOpen, onMessage: received },
    });
    const remote = new RTCPeerConnection({
      iceServers: [],
      codecs: { audio: [useOPUS({ payloadType: 111 })], video: [] },
    });
    let remoteChannel: RTCDataChannel | undefined;
    const sent = vi.fn();
    remote.onDataChannel.subscribe((channel) => {
      remoteChannel = channel;
      channel.onMessage.subscribe(sent);
    });
    try {
      const offer = await peer.createOffer();
      expect(offer).toContain("m=application ");
      await remote.setRemoteDescription({ type: "offer", sdp: offer });
      await remote.setLocalDescription(await remote.createAnswer());
      await peer.applyAnswer(remote.localDescription!.sdp);
      await vi.waitFor(() => expect(onOpen).toHaveBeenCalledOnce(), { timeout: 5_000 });
      expect(remoteChannel?.label).toBe("oai-events");
      expect(remoteChannel?.ordered).toBe(true);
      peer.sendControl('{"type":"response.create"}');
      await vi.waitFor(() => expect(sent).toHaveBeenCalledWith('{"type":"response.create"}'));
      remoteChannel!.send('{"type":"session.created"}');
      await vi.waitFor(() => expect(received).toHaveBeenCalledWith('{"type":"session.created"}'));
      peer.close();
      expect(peer.isControlOpen()).toBe(false);
      expect(() => peer.sendControl("{}")).toThrow("not open");
      expect(onError).not.toHaveBeenCalled();
    } finally {
      peer.close();
      await remote.close();
    }
  }, 15_000);
});
