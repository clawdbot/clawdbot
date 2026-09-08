import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  OpenAIQuicksilverPendingAudio,
  OPENAI_QUICKSILVER_RELAY_FRAME_BYTES,
} from "./realtime-quicksilver-audio-buffer.js";
import { OpenAIQuicksilverAudioPeer } from "./realtime-quicksilver-peer.runtime.js";

type LibopusModule = typeof import("libopus-wasm");
type LibopusDecoder = Awaited<ReturnType<LibopusModule["createDecoder"]>>;
type LibopusEncoder = Awaited<ReturnType<LibopusModule["createEncoder"]>>;

const libopusFactoryOverrides = vi.hoisted(() => ({
  createDecoder: undefined as LibopusModule["createDecoder"] | undefined,
  createEncoder: undefined as LibopusModule["createEncoder"] | undefined,
}));

vi.mock("libopus-wasm", async (importOriginal) => {
  const actual = await importOriginal<LibopusModule>();
  return {
    ...actual,
    createDecoder: (...args: Parameters<LibopusModule["createDecoder"]>) =>
      (libopusFactoryOverrides.createDecoder ?? actual.createDecoder)(...args),
    createEncoder: (...args: Parameters<LibopusModule["createEncoder"]>) =>
      (libopusFactoryOverrides.createEncoder ?? actual.createEncoder)(...args),
  };
});

function createRelayTone(): Buffer {
  const pcm = Buffer.alloc(480 * 2);
  for (let index = 0; index < 480; index += 1) {
    pcm.writeInt16LE(
      Math.round(Math.sin((index / 24_000) * 2 * Math.PI * 440) * 12_000),
      index * 2,
    );
  }
  return pcm;
}

type TestableAudioPeer = {
  connected: boolean;
  handleInboundRtp(packet: unknown): void;
  mediaTimer: ReturnType<typeof setInterval> | undefined;
  pendingAudio: OpenAIQuicksilverPendingAudio;
  sequenceNumber: number;
  timestamp: number;
  sendNextAudioFrame(): void;
  takeNextRelayFrame(): Buffer;
  state: {
    decoder: {
      decode(packet: Uint8Array | null, options?: { maxFrameSize?: number }): Int16Array;
      decodePacketLoss(frameSize?: number): Int16Array;
    };
    encoder: {
      encode(pcm: Int16Array, options?: { frameSize?: number }): Uint8Array;
    };
    peer: {
      connectionStateChange: {
        execute(state: "closed" | "connected" | "disconnected"): void;
      };
    };
    transceiver: {
      sender: {
        sendRtp(packet: unknown): Promise<void>;
      };
    };
  };
};

async function createInboundAudioHarness(params?: {
  onRtpPacket?: () => void;
  onMediaError?: (error: Error) => void;
  decodeFailure?: { sequence: number; error: Error };
}) {
  const { RtpHeader, RtpPacket } = await import("werift");
  const onAudio = vi.fn();
  const onError = vi.fn();
  const peer = await OpenAIQuicksilverAudioPeer.create({
    callbacks: {
      onAudio,
      onError,
      onRtpPacket: params?.onRtpPacket,
      onMediaError: params?.onMediaError,
    },
    iceServers: [],
  });
  const testPeer = peer as unknown as TestableAudioPeer;
  const decodeOrder: Array<number | "plc"> = [];
  const decode = vi.spyOn(testPeer.state.decoder, "decode").mockImplementation((packet) => {
    if (params?.decodeFailure && packet?.[0] === params.decodeFailure.sequence) {
      throw params.decodeFailure.error;
    }
    decodeOrder.push(packet?.[0] ?? -1);
    return new Int16Array(960 * 2);
  });
  const decodePacketLoss = vi
    .spyOn(testPeer.state.decoder, "decodePacketLoss")
    .mockImplementation(() => {
      decodeOrder.push("plc");
      return new Int16Array(960 * 2);
    });
  const packet = (sequenceNumber: number, ssrc = 1) =>
    new RtpPacket(
      new RtpHeader({
        payloadType: 111,
        sequenceNumber,
        ssrc,
        timestamp: (sequenceNumber * 960) >>> 0,
      }),
      Buffer.from([sequenceNumber & 0xff]),
    );
  return { decode, decodeOrder, decodePacketLoss, onAudio, onError, packet, peer, testPeer };
}

describe("GPT-Live werift audio peer", () => {
  it("creates a full-candidate Opus sendrecv offer without a data channel", async () => {
    const peer = await OpenAIQuicksilverAudioPeer.create({
      callbacks: { onAudio: vi.fn(), onError: vi.fn() },
      iceServers: [],
    });
    try {
      const offer = await peer.createOffer();
      expect(offer).toMatch(/^m=audio .*UDP\/TLS\/RTP\/SAVPF 111$/m);
      expect(offer).toMatch(/^a=rtpmap:111 OPUS\/48000\/2$/im);
      expect(offer).toMatch(/^a=sendrecv$/m);
      expect(offer).toMatch(/^a=candidate:/m);
      expect(offer).toMatch(/^a=end-of-candidates$/m);
      expect(offer).not.toMatch(/^m=application /m);
    } finally {
      peer.close();
    }
  });

  it("rejects a second SSRC before it can share Opus decoder state", async () => {
    const { decodeOrder, decodePacketLoss, onError, packet, peer, testPeer } =
      await createInboundAudioHarness();
    try {
      testPeer.handleInboundRtp(packet(10, 1));
      testPeer.handleInboundRtp(packet(200, 2));

      expect(decodeOrder).toEqual([10]);
      expect(decodePacketLoss).not.toHaveBeenCalled();
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ message: "GPT-Live WebRTC audio source changed unexpectedly" }),
      );
    } finally {
      peer.close();
    }
  });

  it("fails closed on a large same-SSRC sequence discontinuity", async () => {
    const { decodeOrder, decodePacketLoss, onError, packet, peer, testPeer } =
      await createInboundAudioHarness();
    try {
      testPeer.handleInboundRtp(packet(40_000));
      testPeer.handleInboundRtp(packet(10_000));

      expect(decodeOrder).toEqual([40_000 & 0xff]);
      expect(decodePacketLoss).not.toHaveBeenCalled();
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "GPT-Live WebRTC RTP sequence changed unexpectedly",
        }),
      );
    } finally {
      peer.close();
    }
  });

  it("keeps raw Opus RTP payload framing and round-trips relay PCM", async () => {
    const [
      { Application, createDecoder, createEncoder },
      { RtpHeader, RtpPacket, dePacketizeRtpPackets },
    ] = await Promise.all([import("libopus-wasm"), import("werift")]);
    const encoder = await createEncoder({
      application: Application.Voip,
      channels: 2,
      sampleRate: 48_000,
      frameSize: 960,
    });
    const decoder = await createDecoder({ channels: 2, sampleRate: 48_000 });
    try {
      const packet = encoder.encode(OpenAIQuicksilverAudioPeer.convertRelayPcm(createRelayTone()), {
        frameSize: 960,
      });
      const rtp = new RtpPacket(
        new RtpHeader({ payloadType: 111, sequenceNumber: 7, timestamp: 960 }),
        Buffer.from(packet),
      );
      const depacketized = dePacketizeRtpPackets("opus", [rtp]).data;
      expect(depacketized).toEqual(Buffer.from(packet));
      const decoded = decoder.decode(depacketized, { maxFrameSize: 5_760 });
      const relayPcm = OpenAIQuicksilverAudioPeer.convertQuicksilverPcm(decoded);
      expect(relayPcm).toHaveLength(480 * 2);
      expect(
        Math.max(...Array.from({ length: 480 }, (_, i) => Math.abs(relayPcm.readInt16LE(i * 2)))),
      ).toBeGreaterThan(1_000);
    } finally {
      encoder.free();
      decoder.free();
    }
  });

  it("decodes reordered inbound RTP packets in sequence order", async () => {
    const { decodeOrder, onAudio, onError, packet, peer, testPeer } =
      await createInboundAudioHarness();
    try {
      testPeer.handleInboundRtp(packet(10));
      testPeer.handleInboundRtp(packet(12));
      expect(decodeOrder).toEqual([10]);
      testPeer.handleInboundRtp(packet(11));

      expect(decodeOrder).toEqual([10, 11, 12]);
      expect(onAudio).toHaveBeenCalledTimes(3);
      expect(onError).not.toHaveBeenCalled();
    } finally {
      peer.close();
    }
  });

  it("emits an Opus PLC frame for a dropped inbound RTP packet", async () => {
    const { decodeOrder, decodePacketLoss, onAudio, onError, packet, peer, testPeer } =
      await createInboundAudioHarness();
    try {
      for (const sequenceNumber of [20, 22, 23, 24, 25]) {
        testPeer.handleInboundRtp(packet(sequenceNumber));
      }

      expect(decodeOrder).toEqual([20, "plc", 22, 23, 24, 25]);
      expect(decodePacketLoss).toHaveBeenCalledWith(960);
      // The centered streaming filter retains seven 24 kHz samples of right-edge
      // context until the next packet instead of fabricating a boundary per packet.
      expect(Buffer.concat(onAudio.mock.calls.map(([audio]) => audio))).toHaveLength(
        (6 * 480 - 7) * 2,
      );
      expect(onError).not.toHaveBeenCalled();
    } finally {
      peer.close();
    }
  });

  it("flushes a short reordered tail after the 80 ms window", async () => {
    const { decodeOrder, onError, packet, peer, testPeer } = await createInboundAudioHarness();
    vi.useFakeTimers();
    try {
      for (const sequenceNumber of [40, 42, 43, 44]) {
        testPeer.handleInboundRtp(packet(sequenceNumber));
      }
      await vi.advanceTimersByTimeAsync(79);
      expect(decodeOrder).toEqual([40]);
      await vi.advanceTimersByTimeAsync(1);

      expect(decodeOrder).toEqual([40, "plc", 42, 43, 44]);
      expect(onError).not.toHaveBeenCalled();
    } finally {
      peer.close();
      vi.useRealTimers();
    }
  });

  it("discards inbound RTP packets that arrive beyond the reorder window", async () => {
    const { decode, onError, packet, peer, testPeer } = await createInboundAudioHarness();
    try {
      for (const sequenceNumber of [30, 32, 33, 34, 35]) {
        testPeer.handleInboundRtp(packet(sequenceNumber));
      }
      const decodedBeforeLatePacket = decode.mock.calls.length;
      testPeer.handleInboundRtp(packet(31));

      expect(decode).toHaveBeenCalledTimes(decodedBeforeLatePacket);
      expect(onError).not.toHaveBeenCalled();
    } finally {
      peer.close();
    }
  });

  it.each([
    { packets: [40, 42, 43, 44], malformed: 42, expected: [40, "plc", "plc", 43, 44] },
    { packets: [40, 42, 43, 41], malformed: 41, expected: [40, "plc", 42, 43] },
    { packets: [40, 42, 44], malformed: 42, expected: [40, "plc", "plc", "plc", 44] },
  ])("continues audio after malformed packet $malformed in $packets", async (scenario) => {
    const { OpusError, OpusErrorCode } = await import("libopus-wasm");
    const error = new OpusError(OpusErrorCode.InvalidPacket, "invalid packet", "decode");
    const onMediaError = vi.fn();
    const { decodeOrder, onAudio, onError, packet, peer, testPeer } =
      await createInboundAudioHarness({
        onMediaError,
        decodeFailure: { sequence: scenario.malformed, error },
      });
    vi.useFakeTimers();
    try {
      for (const sequence of scenario.packets) {
        testPeer.handleInboundRtp(packet(sequence));
      }
      await vi.advanceTimersByTimeAsync(160);
      expect(decodeOrder).toEqual(scenario.expected);
      expect(Buffer.concat(onAudio.mock.calls.map(([audio]) => audio))).toHaveLength(
        (scenario.expected.length * 480 - 7) * 2,
      );
      expect(onMediaError).toHaveBeenCalledExactlyOnceWith(error);
      expect(onError).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(160);
      expect(onAudio).toHaveBeenCalledTimes(scenario.expected.length);
    } finally {
      peer.close();
      vi.useRealTimers();
    }
  });

  it("keeps unusable decoder state fatal with media recovery enabled", async () => {
    const { OpusError, OpusErrorCode } = await import("libopus-wasm");
    const error = new OpusError(OpusErrorCode.InvalidState, "invalid decoder state", "decode");
    const onMediaError = vi.fn();
    const { onAudio, onError, packet, peer, testPeer } = await createInboundAudioHarness({
      onMediaError,
      decodeFailure: { sequence: 41, error },
    });
    try {
      testPeer.handleInboundRtp(packet(40));
      testPeer.handleInboundRtp(packet(41));
      expect(onError).toHaveBeenCalledExactlyOnceWith(error);
      expect(onMediaError).not.toHaveBeenCalled();
      expect(onAudio).toHaveBeenCalledOnce();
    } finally {
      peer.close();
    }
  });

  it("preserves fatal packet handling when onMediaError is absent", async () => {
    const { OpusError, OpusErrorCode } = await import("libopus-wasm");
    const error = new OpusError(OpusErrorCode.InvalidPacket, "invalid packet", "decode");
    const { onAudio, onError, packet, peer, testPeer } = await createInboundAudioHarness({
      decodeFailure: { sequence: 41, error },
    });
    try {
      testPeer.handleInboundRtp(packet(40));
      testPeer.handleInboundRtp(packet(41));
      expect(onError).toHaveBeenCalledExactlyOnceWith(error);
      expect(onAudio).toHaveBeenCalledOnce();
    } finally {
      peer.close();
    }
  });

  it("reports RTP activity callback failures through the peer error boundary", async () => {
    const activityError = new Error("activity callback failed");
    const onRtpPacket = vi.fn(() => {
      throw activityError;
    });
    const { decode, onError, packet, peer, testPeer } = await createInboundAudioHarness({
      onRtpPacket,
    });
    try {
      testPeer.handleInboundRtp(packet(50));

      expect(onRtpPacket).toHaveBeenCalledOnce();
      expect(decode).not.toHaveBeenCalled();
      expect(onError).toHaveBeenCalledWith(activityError);
    } finally {
      peer.close();
    }
  });

  it("consumes every audio tick while earlier RTP sends remain pending", async () => {
    const peer = await OpenAIQuicksilverAudioPeer.create({
      callbacks: { onAudio: vi.fn(), onError: vi.fn() },
      iceServers: [],
    });
    const testPeer = peer as unknown as TestableAudioPeer;
    const sendRtp = vi
      .spyOn(testPeer.state.transceiver.sender, "sendRtp")
      .mockImplementation(async () => await new Promise<void>(() => {}));
    const frames = [Buffer.alloc(480 * 2, 1), Buffer.alloc(480 * 2, 2), Buffer.alloc(480 * 2, 3)];
    const initialTimestamp = testPeer.timestamp;
    const initialSequenceNumber = testPeer.sequenceNumber;
    try {
      peer.sendAudio(Buffer.concat(frames));
      testPeer.connected = true;

      for (let index = 0; index < frames.length; index += 1) {
        testPeer.sendNextAudioFrame();
        expect(testPeer.pendingAudio).toHaveLength(
          (frames.length - index - 1) * OPENAI_QUICKSILVER_RELAY_FRAME_BYTES,
        );
      }

      expect(sendRtp).toHaveBeenCalledTimes(3);
      const packets = sendRtp.mock.calls.map(
        ([packet]) => packet as { header: { sequenceNumber: number; timestamp: number } },
      );
      expect(packets.map((packet) => packet.header.timestamp)).toEqual([
        initialTimestamp,
        (initialTimestamp + 960) >>> 0,
        (initialTimestamp + 1_920) >>> 0,
      ]);
      expect(packets.map((packet) => packet.header.sequenceNumber)).toEqual([
        initialSequenceNumber,
        (initialSequenceNumber + 1) & 0xffff,
        (initialSequenceNumber + 2) & 0xffff,
      ]);
    } finally {
      peer.close();
    }
  });

  it("recovers one send rejection and escalates consecutive failures", async () => {
    const onMediaError = vi.fn();
    const { onError, peer, testPeer } = await createInboundAudioHarness({ onMediaError });
    const first = new Error("first packet rejected");
    const second = new Error("second packet rejected");
    const terminal = new Error("transport remains unusable");
    const send = vi
      .spyOn(testPeer.state.transceiver.sender, "sendRtp")
      .mockRejectedValueOnce(first)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(second)
      .mockRejectedValueOnce(terminal);
    testPeer.connected = true;
    try {
      testPeer.sendNextAudioFrame();
      await Promise.resolve();
      expect(onMediaError).toHaveBeenCalledExactlyOnceWith(first);
      testPeer.sendNextAudioFrame();
      await Promise.resolve();
      testPeer.sendNextAudioFrame();
      await Promise.resolve();
      expect(onError).not.toHaveBeenCalled();
      expect(onMediaError).toHaveBeenLastCalledWith(second);
      testPeer.sendNextAudioFrame();
      await Promise.resolve();
      expect(onError).toHaveBeenCalledExactlyOnceWith(terminal);
      expect(onMediaError).toHaveBeenCalledTimes(2);
      expect(send).toHaveBeenCalledTimes(4);
    } finally {
      peer.close();
    }
  });

  it("retains only the newest five seconds and releases it on close", async () => {
    const peer = await OpenAIQuicksilverAudioPeer.create({
      callbacks: { onAudio: vi.fn(), onError: vi.fn() },
      iceServers: [],
    });
    const testPeer = peer as unknown as TestableAudioPeer;
    const maxPendingAudioBytes = OPENAI_QUICKSILVER_RELAY_FRAME_BYTES * 250;
    const source = Buffer.alloc(maxPendingAudioBytes + OPENAI_QUICKSILVER_RELAY_FRAME_BYTES);
    source.fill(0x11, 0, OPENAI_QUICKSILVER_RELAY_FRAME_BYTES);
    source.fill(0x22, OPENAI_QUICKSILVER_RELAY_FRAME_BYTES);
    const expectedTail = Buffer.from(source.subarray(OPENAI_QUICKSILVER_RELAY_FRAME_BYTES));

    peer.sendAudio(source);
    source.fill(0xff);
    expect(testPeer.pendingAudio).toHaveLength(expectedTail.length);
    expect(testPeer.takeNextRelayFrame()).toEqual(
      expectedTail.subarray(0, OPENAI_QUICKSILVER_RELAY_FRAME_BYTES),
    );

    peer.close();
    expect(testPeer.pendingAudio).toHaveLength(0);
    peer.sendAudio(Buffer.from([0x01, 0x02]));
    expect(testPeer.pendingAudio).toHaveLength(0);
  });

  it("rejects adoption over existing peer audio and clears adoption after close", async () => {
    const peer = await OpenAIQuicksilverAudioPeer.create({
      callbacks: { onAudio: vi.fn(), onError: vi.fn() },
      iceServers: [],
    });
    const testPeer = peer as unknown as TestableAudioPeer;
    const existing = Buffer.from([0x01, 0x02]);
    const rejected = new OpenAIQuicksilverPendingAudio();
    rejected.append(Buffer.from([0x03, 0x04]));
    try {
      peer.sendAudio(existing);
      expect(() => peer.adoptPendingAudio(rejected)).toThrow(
        "GPT-Live WebRTC peer already owns pending audio",
      );
      expect(rejected).toHaveLength(0);
      expect(testPeer.takeNextRelayFrame().subarray(0, existing.length)).toEqual(existing);

      peer.close();
      const afterClose = new OpenAIQuicksilverPendingAudio();
      afterClose.append(Buffer.from([0x05, 0x06]));
      peer.adoptPendingAudio(afterClose);
      expect(afterClose).toHaveLength(0);
    } finally {
      peer.close();
    }
  });

  it("consumes and zero-pads a sub-frame audio tail on the next tick", async () => {
    const peer = await OpenAIQuicksilverAudioPeer.create({
      callbacks: { onAudio: vi.fn(), onError: vi.fn() },
      iceServers: [],
    });
    const testPeer = peer as unknown as TestableAudioPeer;
    const tail = Buffer.alloc(200);
    tail.writeInt16LE(1_234, 0);
    tail.writeInt16LE(-2_345, 2);
    const takeNextRelayFrame = testPeer.takeNextRelayFrame.bind(testPeer);
    let producedFrame: Buffer | undefined;
    vi.spyOn(testPeer, "takeNextRelayFrame").mockImplementation(() => {
      producedFrame = takeNextRelayFrame();
      return producedFrame;
    });
    try {
      peer.sendAudio(tail);
      testPeer.connected = true;
      testPeer.sendNextAudioFrame();

      expect(testPeer.pendingAudio).toHaveLength(0);
      expect(producedFrame?.subarray(0, tail.length)).toEqual(tail);
      expect(producedFrame?.subarray(tail.length).every((byte) => byte === 0)).toBe(true);
    } finally {
      peer.close();
    }
  });

  it("clears the media pump when the first encoder tick synchronously closes the peer", async () => {
    const encodeError = new Error("encoder failed");
    const peerRef: { current?: OpenAIQuicksilverAudioPeer } = {};
    const onError = vi.fn((_error: Error) => peerRef.current?.close());
    const peer = await OpenAIQuicksilverAudioPeer.create({
      callbacks: { onAudio: vi.fn(), onError },
      iceServers: [],
    });
    peerRef.current = peer;
    const testPeer = peer as unknown as TestableAudioPeer;
    const encode = vi.spyOn(testPeer.state.encoder, "encode").mockImplementation(() => {
      throw encodeError;
    });
    vi.useFakeTimers();
    try {
      testPeer.state.peer.connectionStateChange.execute("connected");

      expect(encode).toHaveBeenCalledOnce();
      expect(onError).toHaveBeenCalledOnce();
      expect(onError).toHaveBeenCalledWith(encodeError);
      expect(testPeer.mediaTimer).toBeUndefined();

      await vi.advanceTimersByTimeAsync(100);

      expect(encode).toHaveBeenCalledOnce();
      expect(onError).toHaveBeenCalledOnce();
    } finally {
      peer.close();
      vi.useRealTimers();
    }
  });

  it.each(["disconnected", "closed"] as const)(
    "reports a terminal %s connection state",
    async (connectionState) => {
      const onError = vi.fn();
      const peer = await OpenAIQuicksilverAudioPeer.create({
        callbacks: { onAudio: vi.fn(), onError },
        iceServers: [],
      });
      try {
        (peer as unknown as TestableAudioPeer).state.peer.connectionStateChange.execute(
          connectionState,
        );
        expect(onError).toHaveBeenCalledOnce();
        expect(onError).toHaveBeenCalledWith(
          expect.objectContaining({
            message: `GPT-Live WebRTC media connection ${connectionState}`,
          }),
        );
      } finally {
        peer.close();
      }
    },
  );

  it("suppresses terminal state callbacks after local close", async () => {
    const onError = vi.fn();
    const peer = await OpenAIQuicksilverAudioPeer.create({
      callbacks: { onAudio: vi.fn(), onError },
      iceServers: [],
    });
    const connectionStateChange = (peer as unknown as TestableAudioPeer).state.peer
      .connectionStateChange;

    peer.close();
    connectionStateChange.execute("closed");

    expect(onError).not.toHaveBeenCalled();
  });

  it("constructs and offers under Bun without network access", ({ skip }) => {
    const version = spawnSync("bun", ["--version"], { encoding: "utf8" });
    if (version.error) {
      skip("Bun is not installed");
      return;
    }
    const result = spawnSync(
      "bun",
      [
        "--eval",
        `const { RTCPeerConnection, useOPUS } = await import("werift");
const peer = new RTCPeerConnection({ codecs: { audio: [useOPUS({ payloadType: 111 })], video: [] }, iceServers: [] });
try {
  peer.addTransceiver("audio", { direction: "sendrecv" });
  const offer = await peer.createOffer();
  const sdp = offer.sdp ?? "";
  if (!sdp.includes("a=sendrecv") || !sdp.includes("OPUS/48000/2")) throw new Error("invalid offer");
  if (peer.iceGatheringState !== "new") throw new Error("offer construction started ICE gathering");
} finally {
  await peer.close();
}`,
      ],
      { cwd: fileURLToPath(new URL(".", import.meta.url)), encoding: "utf8", timeout: 30_000 },
    );
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("releases the encoder and peer when decoder initialization fails", async () => {
    const encoder = { free: vi.fn() };
    libopusFactoryOverrides.createEncoder = async () => encoder as unknown as LibopusEncoder;
    libopusFactoryOverrides.createDecoder = async () => {
      throw new Error("decoder init failed");
    };
    const { RTCPeerConnection } = await import("werift");
    const closePeer = vi.spyOn(RTCPeerConnection.prototype, "close");
    try {
      await expect(
        OpenAIQuicksilverAudioPeer.create({
          callbacks: { onAudio: vi.fn(), onError: vi.fn() },
          iceServers: [],
        }),
      ).rejects.toThrow("decoder init failed");
      expect(encoder.free).toHaveBeenCalledOnce();
      expect(closePeer).toHaveBeenCalled();
    } finally {
      closePeer.mockRestore();
      libopusFactoryOverrides.createEncoder = undefined;
      libopusFactoryOverrides.createDecoder = undefined;
    }
  });

  it("releases partial peer resources when codec initialization is aborted", async () => {
    const encoder = { free: vi.fn() };
    const decoder = { free: vi.fn() };
    let resolveDecoder: ((value: typeof decoder) => void) | undefined;
    const createDecoder = vi.fn(
      async () =>
        await new Promise<typeof decoder>((resolve) => {
          resolveDecoder = resolve;
        }),
    );
    libopusFactoryOverrides.createEncoder = async () => encoder as unknown as LibopusEncoder;
    libopusFactoryOverrides.createDecoder = async () =>
      (await createDecoder()) as unknown as LibopusDecoder;
    const { RTCPeerConnection } = await import("werift");
    const closePeer = vi.spyOn(RTCPeerConnection.prototype, "close");
    const controller = new AbortController();
    try {
      const creation = OpenAIQuicksilverAudioPeer.create({
        callbacks: { onAudio: vi.fn(), onError: vi.fn() },
        iceServers: [],
        signal: controller.signal,
      });
      await vi.waitFor(() => expect(createDecoder).toHaveBeenCalledOnce());
      controller.abort(new Error("peer startup stopped"));
      await vi.waitFor(() => expect(closePeer).toHaveBeenCalled());
      expect(encoder.free).toHaveBeenCalledOnce();
      resolveDecoder?.(decoder);
      await expect(creation).rejects.toThrow("peer startup stopped");
      expect(decoder.free).toHaveBeenCalledOnce();
      expect(encoder.free).toHaveBeenCalledOnce();
    } finally {
      closePeer.mockRestore();
      libopusFactoryOverrides.createEncoder = undefined;
      libopusFactoryOverrides.createDecoder = undefined;
    }
  });
});
