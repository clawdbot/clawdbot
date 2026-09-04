import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  OpenAIQuicksilverPendingAudio,
  OPENAI_QUICKSILVER_RELAY_FRAME_BYTES,
} from "./realtime-quicksilver-audio-buffer.js";
import { OpenAIQuicksilverGatewayBridge } from "./realtime-quicksilver-gateway-bridge.js";
import {
  OpenAIQuicksilverAudioPeer,
  type OpenAIQuicksilverAudioPeerCallbacks,
  type OpenAIQuicksilverAudioPeerContract,
} from "./realtime-quicksilver-peer.runtime.js";
import {
  releaseOpenAIQuicksilverSession,
  reserveOpenAIQuicksilverSession,
} from "./realtime-quicksilver-session-limit.js";
import {
  connectOpenAIQuicksilverSideband,
  type OpenAIQuicksilverSocketFactory,
} from "./realtime-quicksilver-sideband.js";
import {
  createCallResponse,
  emitSideband,
  FakeSocket,
  parseSent,
} from "./realtime-quicksilver.test-helpers.js";

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

type TestableGatewayBridge = {
  pendingAudio: OpenAIQuicksilverPendingAudio;
};

function readPendingAudio(pending: OpenAIQuicksilverPendingAudio): Buffer {
  const length = pending.length;
  const audio = Buffer.alloc(length);
  const readBytes = pending.readInto(audio);
  if (readBytes !== length) {
    throw new Error(`Expected to read ${length} pending audio bytes, got ${readBytes}`);
  }
  return audio;
}

async function createInboundAudioHarness(params?: { onRtpPacket?: () => void }) {
  const { RtpHeader, RtpPacket } = await import("werift");
  const onAudio = vi.fn();
  const onError = vi.fn();
  const peer = await OpenAIQuicksilverAudioPeer.create({
    callbacks: { onAudio, onError, onRtpPacket: params?.onRtpPacket },
    iceServers: [],
  });
  const testPeer = peer as unknown as TestableAudioPeer;
  const decodeOrder: Array<number | "plc"> = [];
  const decode = vi.spyOn(testPeer.state.decoder, "decode").mockImplementation((packet) => {
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
        'const { RTCPeerConnection, useOPUS } = await import("werift"); const peer = new RTCPeerConnection({ codecs: { audio: [useOPUS({ payloadType: 111 })], video: [] }, iceServers: [] }); peer.addTransceiver("audio", { direction: "sendrecv" }); const offer = await peer.createOffer(); await peer.setLocalDescription(offer); const sdp = peer.localDescription?.sdp ?? ""; if (!sdp.includes("a=sendrecv") || !sdp.includes("OPUS/48000/2")) throw new Error("invalid offer"); await peer.close();',
      ],
      { cwd: process.cwd(), encoding: "utf8", timeout: 30_000 },
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

describe("GPT-Live gateway relay bridge", () => {
  function createPendingPeerBridge(params?: {
    onClose?: (reason: "completed" | "error") => void;
    onError?: (error: Error) => void;
  }) {
    let resolvePeer: ((peer: OpenAIQuicksilverAudioPeerContract) => void) | undefined;
    let rejectPeer: ((error: Error) => void) | undefined;
    let peerCallbacks: OpenAIQuicksilverAudioPeerCallbacks | undefined;
    const peerPromise = new Promise<OpenAIQuicksilverAudioPeerContract>((resolve, reject) => {
      resolvePeer = resolve;
      rejectPeer = reject;
    });
    const peer = {
      createOffer: vi.fn(async () => "v=offer\r\n"),
      applyAnswer: vi.fn(async () => undefined),
      adoptPendingAudio: vi.fn(),
      sendAudio: vi.fn(),
      close: vi.fn(),
    } satisfies OpenAIQuicksilverAudioPeerContract;
    const onClose = vi.fn();
    const bridge = new OpenAIQuicksilverGatewayBridge({
      providerConfig: {},
      model: "gpt-live-1-codex",
      voice: "marin",
      audioFormat: { encoding: "pcm16", sampleRateHz: 24_000, channels: 1 },
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
      onClose: params?.onClose ?? onClose,
      onError: params?.onError,
      runAgentConsult: vi.fn(async () => ({ text: "done" })),
      logger: { debug: vi.fn(), warn: vi.fn() },
      resolveAuth: vi.fn(async () => ({
        type: "oauth" as const,
        token: "oauth-token",
        accountId: "account-1",
      })),
      createPeer: vi.fn((callbacks) => {
        peerCallbacks = callbacks;
        return peerPromise;
      }),
      fetchImpl: vi.fn(async () => createCallResponse("v=answer\r\n", "rtc_pending_audio")),
      webSocketFactory: () => new FakeSocket(),
    });
    const connection = bridge.connect();
    return {
      bridge,
      connection,
      onClose,
      peer,
      rejectPeer: (error: Error) => rejectPeer?.(error),
      resolvePeer: () => resolvePeer?.(peer),
      triggerPeerError: (error: Error) => peerCallbacks?.onError(error),
    };
  }

  it("preserves caller-owned microphone frames while the media peer is starting", async () => {
    const { bridge, connection, peer, resolvePeer } = createPendingPeerBridge();
    const testBridge = bridge as unknown as TestableGatewayBridge;
    try {
      expect(bridge.connect()).toBe(connection);
      const source = Buffer.from([0x7f, 0x41]);
      bridge.sendAudio(source);
      source.fill(0);
      bridge.sendAudio(Buffer.from([0x22, 0x23]));
      const pendingAudio = testBridge.pendingAudio;

      resolvePeer();
      await connection;

      expect(peer.adoptPendingAudio).toHaveBeenCalledOnce();
      expect(peer.adoptPendingAudio).toHaveBeenCalledWith(pendingAudio);
      expect(testBridge.pendingAudio).not.toBe(pendingAudio);
      expect(testBridge.pendingAudio).toHaveLength(0);
      expect(readPendingAudio(pendingAudio)).toEqual(Buffer.from([0x7f, 0x41, 0x22, 0x23]));
      bridge.sendAudio(Buffer.from([0x30, 0x31]));
      expect(peer.sendAudio).toHaveBeenCalledOnce();
      expect(peer.sendAudio).toHaveBeenCalledWith(Buffer.from([0x30, 0x31]));
    } finally {
      bridge.close();
    }
  });

  it("discards queued microphone audio when closed before the media peer resolves", async () => {
    const { bridge, connection, onClose, peer, resolvePeer } = createPendingPeerBridge();
    const testBridge = bridge as unknown as TestableGatewayBridge;
    bridge.sendAudio(Buffer.from([0x41, 0x42]));
    bridge.close();
    bridge.close();

    expect(testBridge.pendingAudio).toHaveLength(0);
    expect(onClose).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledWith("completed");
    resolvePeer();

    await expect(connection).rejects.toThrow("GPT-Live gateway relay bridge closed");
    await vi.waitFor(() => expect(peer.close).toHaveBeenCalledOnce());
    expect(peer.sendAudio).not.toHaveBeenCalled();
    bridge.sendAudio(Buffer.from([0x43, 0x44]));
    expect(peer.sendAudio).not.toHaveBeenCalled();
  });

  it("discards queued microphone audio when media peer creation fails", async () => {
    const { bridge, connection, peer, rejectPeer } = createPendingPeerBridge();
    const pendingAudioState = bridge as unknown as {
      pendingAudio: OpenAIQuicksilverPendingAudio;
    };
    bridge.sendAudio(Buffer.from([0x41, 0x42]));
    rejectPeer(new Error("media peer unavailable"));

    await expect(connection).rejects.toThrow("media peer unavailable");
    expect(pendingAudioState.pendingAudio).toHaveLength(0);
    bridge.sendAudio(Buffer.from([0x43, 0x44]));
    expect(pendingAudioState.pendingAudio).toHaveLength(0);
    expect(peer.sendAudio).not.toHaveBeenCalled();
  });

  it("keeps error precedence when onError reentrantly closes the bridge", async () => {
    const onClose = vi.fn();
    const bridgeRef: { current?: OpenAIQuicksilverGatewayBridge } = {};
    const harness = createPendingPeerBridge({
      onClose,
      onError: () => bridgeRef.current?.close(),
    });
    bridgeRef.current = harness.bridge;
    const connectionRejected = expect(harness.connection).rejects.toThrow(
      "GPT-Live gateway relay bridge closed",
    );

    harness.triggerPeerError(new Error("media peer failed"));

    expect(onClose).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledWith("error");
    await connectionRejected;
  });

  it("releases queued audio and rejects a late peer when onError throws", async () => {
    const callbackError = new Error("error callback failed");
    const onClose = vi.fn();
    const harness = createPendingPeerBridge({
      onClose,
      onError: () => {
        throw callbackError;
      },
    });
    const testBridge = harness.bridge as unknown as TestableGatewayBridge;
    harness.bridge.sendAudio(Buffer.from([0x41, 0x42]));
    const connectionRejected = expect(harness.connection).rejects.toThrow(
      "GPT-Live gateway relay bridge closed",
    );

    expect(() => harness.triggerPeerError(new Error("media peer failed"))).toThrow(callbackError);
    const retainedAudioBytes = testBridge.pendingAudio.length;
    const closeReason = onClose.mock.calls[0]?.[0];
    harness.bridge.close();
    harness.resolvePeer();

    await connectionRejected;
    await vi.waitFor(() => expect(harness.peer.close).toHaveBeenCalledOnce());
    expect(retainedAudioBytes).toBe(0);
    expect(closeReason).toBe("error");
    expect(harness.peer.sendAudio).not.toHaveBeenCalled();
  });

  it("closes a sideband that opens in the abort handoff", async () => {
    const controller = new AbortController();
    const socket = new FakeSocket("manual");
    const connection = connectOpenAIQuicksilverSideband({
      auth: { type: "api-key", token: "platform-key" },
      createSocket: () => socket,
      requestIds: {
        realtimeSessionId: "realtime-session",
        sessionId: "session",
        threadId: "thread",
      },
      signal: controller.signal,
      url: "wss://api.openai.com/v1/live/rtc_test",
    });
    socket.readyState = 1;
    socket.emit("open");
    controller.abort(new Error("sideband startup stopped"));

    await expect(connection).rejects.toThrow("sideband startup stopped");
    expect(socket.closed).toBe(true);
  });

  it("bounds sideband frames and aggregate pre-open buffering", async () => {
    const controller = new AbortController();
    const socket = new FakeSocket("manual");
    let socketOptions: Parameters<OpenAIQuicksilverSocketFactory>[1] | undefined;
    socket.once("close", () => controller.abort(new Error("sideband overflow observed")));
    const connection = connectOpenAIQuicksilverSideband({
      auth: { type: "api-key", token: "platform-key" },
      createSocket: (_url, options) => {
        socketOptions = options;
        return socket;
      },
      requestIds: {
        realtimeSessionId: "realtime-session",
        sessionId: "session",
        threadId: "thread",
      },
      signal: controller.signal,
      url: "wss://api.openai.com/v1/live/rtc_test",
    });

    expect(socketOptions?.maxPayload).toBe(16 * 1024 * 1024);
    socket.emit("message", Buffer.alloc(512 * 1024), false);
    socket.emit("message", Buffer.alloc(512 * 1024), false);
    socket.emit("message", Buffer.from([0]), false);

    await expect(connection).rejects.toThrow("sideband overflow observed");
    expect(socket.closeCode).toBe(1009);
    expect(socket.closeReason).toBe("sideband startup buffer exceeded");
  });

  it("bounds peer creation and closes a peer that resolves after the deadline", async () => {
    let resolvePeer: ((peer: OpenAIQuicksilverAudioPeerContract) => void) | undefined;
    const peerPromise = new Promise<OpenAIQuicksilverAudioPeerContract>((resolve) => {
      resolvePeer = resolve;
    });
    const closePeer = vi.fn();
    const bridge = new OpenAIQuicksilverGatewayBridge({
      providerConfig: {},
      model: "gpt-live-1-codex",
      voice: "marin",
      audioFormat: { encoding: "pcm16", sampleRateHz: 24_000, channels: 1 },
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
      runAgentConsult: vi.fn(async () => ({ text: "done" })),
      logger: { debug: vi.fn(), warn: vi.fn() },
      resolveAuth: vi.fn(async () => ({
        type: "oauth" as const,
        token: "oauth-token",
        accountId: "account-1",
      })),
      createPeer: vi.fn(() => peerPromise),
      connectTimeoutMs: 5,
    });

    await expect(bridge.connect()).rejects.toMatchObject({ name: "TimeoutError" });
    const reservationOwners = Array.from({ length: 8 }, () => ({}));
    try {
      for (const owner of reservationOwners) {
        expect(() => reserveOpenAIQuicksilverSession(owner)).not.toThrow();
      }
    } finally {
      for (const owner of reservationOwners) {
        releaseOpenAIQuicksilverSession(owner);
      }
    }
    resolvePeer?.({
      createOffer: vi.fn(async () => "v=offer\r\n"),
      applyAnswer: vi.fn(async () => undefined),
      adoptPendingAudio: vi.fn(),
      sendAudio: vi.fn(),
      close: closePeer,
    });
    await vi.waitFor(() => expect(closePeer).toHaveBeenCalledOnce());
  });

  it("signals, delegates through the injected runner, drops sideband audio, and tears down", async () => {
    let socket: FakeSocket | undefined;
    const applyAnswer = vi.fn(async () => undefined);
    const closePeer = vi.fn();
    const createOffer = vi.fn(async () => "v=offer\r\n");
    const adoptPendingAudio = vi.fn();
    const peer: OpenAIQuicksilverAudioPeerContract = {
      createOffer,
      applyAnswer,
      adoptPendingAudio,
      sendAudio: vi.fn(),
      close: closePeer,
    };
    const runAgentConsult = vi.fn(async () => ({ text: "Delegated result" }));
    const handleDelegationInput = vi.fn((text: string): "control" | "consult" =>
      text === "Status?" ? "control" : "consult",
    );
    const onAudio = vi.fn();
    const onClearAudio = vi.fn();
    const onEvent = vi.fn();
    const onReady = vi.fn();
    const onClose = vi.fn();
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      createCallResponse("v=answer\r\n", "rtc_bridge"),
    );
    const bridge = new OpenAIQuicksilverGatewayBridge({
      providerConfig: {},
      model: "gpt-live-1-codex",
      voice: "marin",
      instructions: "Speak briefly.",
      audioFormat: { encoding: "pcm16", sampleRateHz: 24_000, channels: 1 },
      onAudio,
      onClearAudio,
      onEvent,
      onReady,
      onClose,
      handleDelegationInput,
      runAgentConsult,
      logger: { debug: vi.fn(), warn: vi.fn() },
      resolveAuth: vi.fn(async () => ({
        type: "oauth" as const,
        token: "oauth-token",
        accountId: "account-1",
      })),
      createPeer: vi.fn(async () => peer),
      fetchImpl,
      webSocketFactory: () => {
        socket = new FakeSocket();
        return socket;
      },
    });

    await bridge.connect();
    if (!socket) {
      throw new Error("expected sideband socket");
    }
    const connectedSocket = socket;
    const body = fetchImpl.mock.calls[0]?.[1]?.body;
    if (typeof body !== "string") {
      throw new Error("Expected initial call JSON");
    }
    expect(JSON.parse(body).session.delegation).toEqual({ type: "client", ack_filler: false });
    expect(JSON.parse(body).session.instructions).toContain("Wait for the host control result");
    expect(createOffer).toHaveBeenCalledOnce();
    expect(applyAnswer).toHaveBeenCalledWith("v=answer\r\n");
    expect(adoptPendingAudio).not.toHaveBeenCalled();
    emitSideband(connectedSocket, {
      type: "session.started",
      session: { id: "rtc_bridge", expires_at: Math.floor(Date.now() / 1000) + 60 },
    });
    expect(onReady).toHaveBeenCalledOnce();
    bridge.sendUserMessage("Ready for the next task");
    expect(parseSent(connectedSocket)).toEqual([
      {
        type: "session.context.append",
        channel: "speakable",
        content: [{ type: "input_text", text: "Ready for the next task" }],
      },
    ]);

    emitSideband(connectedSocket, { type: "output_audio.delta", delta: "ignored-media-copy" });
    expect(onEvent).toHaveBeenCalledWith({ direction: "server", type: "output_audio.delta" });
    expect(onAudio).not.toHaveBeenCalled();

    emitSideband(connectedSocket, { type: "output_audio_buffer.cleared" });
    expect(onClearAudio).toHaveBeenCalledWith("barge-in");

    emitSideband(connectedSocket, {
      type: "delegation.created",
      item: {
        type: "delegation",
        target: "client",
        id: "status-control",
        content: [{ type: "input_text", text: "Status?" }],
      },
    });
    expect(handleDelegationInput).toHaveBeenCalledExactlyOnceWith("Status?", expect.any(Function));
    expect(runAgentConsult).not.toHaveBeenCalled();
    expect(connectedSocket.sent).toHaveLength(1);

    emitSideband(connectedSocket, {
      type: "delegation.created",
      item: {
        type: "delegation",
        target: "client",
        id: "delegation-1",
        content: [{ type: "input_text", text: "Check the lights" }],
      },
    });
    await vi.waitFor(() => expect(runAgentConsult).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(parseSent(connectedSocket)).toContainEqual({
        type: "delegation.context.append",
        delegation_item_id: "delegation-1",
        channel: "speakable",
        content: [{ type: "input_text", text: "Delegated result" }],
      }),
    );
    expect(
      parseSent(connectedSocket).filter((event) => event.type === "session.context.append"),
    ).toHaveLength(2);
    expect(connectedSocket.sent[1]).toContain("I’ll check that request.");

    bridge.close();
    expect(closePeer).toHaveBeenCalledOnce();
    expect(connectedSocket.closed).toBe(true);
    expect(onClose).toHaveBeenCalledWith("completed");
  });

  it("treats a normal upstream sideband close as completion", async () => {
    let socket: FakeSocket | undefined;
    const onClose = vi.fn();
    const onError = vi.fn();
    const bridge = new OpenAIQuicksilverGatewayBridge({
      providerConfig: {},
      model: "gpt-live-1-codex",
      voice: "marin",
      audioFormat: { encoding: "pcm16", sampleRateHz: 24_000, channels: 1 },
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
      onClose,
      onError,
      runAgentConsult: vi.fn(async () => ({ text: "done" })),
      logger: { debug: vi.fn(), warn: vi.fn() },
      resolveAuth: vi.fn(async () => ({
        type: "oauth" as const,
        token: "oauth-token",
        accountId: "account-1",
      })),
      createPeer: vi.fn(async () => ({
        createOffer: vi.fn(async () => "v=offer\r\n"),
        applyAnswer: vi.fn(async () => undefined),
        adoptPendingAudio: vi.fn(),
        sendAudio: vi.fn(),
        close: vi.fn(),
      })),
      fetchImpl: vi.fn(async () => createCallResponse("v=answer\r\n", "rtc_close")),
      webSocketFactory: () => {
        socket = new FakeSocket();
        return socket;
      },
    });

    await bridge.connect();
    if (!socket) {
      throw new Error("expected sideband socket");
    }
    socket.close(1000, "complete");
    expect(onError).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledWith("completed");
  });
});
