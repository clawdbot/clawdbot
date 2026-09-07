import { describe, expect, it, vi } from "vitest";
import { openAIRealtimeHost } from "./realtime-host.js";
import {
  type OpenAIQuicksilverPendingAudio,
  OPENAI_QUICKSILVER_RELAY_FRAME_BYTES,
} from "./realtime-quicksilver-audio-buffer.js";
import { OpenAIQuicksilverGatewayBridge } from "./realtime-quicksilver-gateway-bridge.js";
import {
  OpenAIQuicksilverAudioPeer,
  type OpenAIQuicksilverAudioPeerContract,
} from "./realtime-quicksilver-peer.runtime.js";
import { createCallResponse, FakeSocket } from "./realtime-quicksilver.test-helpers.js";

const MAX_PENDING_RELAY_FRAMES = 250;
const MAX_PENDING_AUDIO_BYTES = OPENAI_QUICKSILVER_RELAY_FRAME_BYTES * MAX_PENDING_RELAY_FRAMES;

type TestableAudioPeer = {
  pendingAudio: OpenAIQuicksilverPendingAudio;
  sequenceNumber: number;
  timestamp: number;
  takeNextRelayFrame(): Buffer;
  state: {
    peer: {
      connectionStateChange: {
        execute(state: "connected"): void;
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

describe("GPT-Live gateway microphone audio pipeline", () => {
  it("retains the newest five seconds through delayed peer adoption and the RTP pump", async () => {
    vi.useFakeTimers();
    let peerCallbacks:
      | Parameters<typeof OpenAIQuicksilverAudioPeer.create>[0]["callbacks"]
      | undefined;
    let resolvePeer: ((peer: OpenAIQuicksilverAudioPeerContract) => void) | undefined;
    const peerPromise = new Promise<OpenAIQuicksilverAudioPeerContract>((resolve) => {
      resolvePeer = resolve;
    });
    const onError = vi.fn();
    const bridge = new OpenAIQuicksilverGatewayBridge(
      {
        providerConfig: {},
        model: "gpt-live-test-canary",
        voice: "marin",
        audioFormat: { encoding: "pcm16", sampleRateHz: 24_000, channels: 1 },
        onAudio: vi.fn(),
        onClearAudio: vi.fn(),
        onError,
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
      },
      openAIRealtimeHost,
    );
    const connection = bridge.connect();
    const source = Buffer.alloc(256 * OPENAI_QUICKSILVER_RELAY_FRAME_BYTES);
    for (let frame = 0; frame < 256; frame += 1) {
      const frameBuffer = source.subarray(
        frame * OPENAI_QUICKSILVER_RELAY_FRAME_BYTES,
        (frame + 1) * OPENAI_QUICKSILVER_RELAY_FRAME_BYTES,
      );
      for (let sample = 0; sample < frameBuffer.length; sample += 2) {
        frameBuffer.writeUInt16LE(frame + 1, sample);
      }
    }
    for (let offset = 0; offset < source.length; offset += 8_192) {
      const callerBuffer = Buffer.from(source.subarray(offset, offset + 8_192));
      bridge.sendAudio(callerBuffer);
      callerBuffer.fill(0xff);
      await vi.advanceTimersByTimeAsync(171);
    }
    const testBridge = bridge as unknown as TestableGatewayBridge;
    expect(testBridge.pendingAudio).toHaveLength(MAX_PENDING_AUDIO_BYTES);
    const bridgePendingAudio = testBridge.pendingAudio;
    if (!peerCallbacks) {
      throw new Error("expected the bridge to start peer creation");
    }
    const peer = await OpenAIQuicksilverAudioPeer.create({
      callbacks: peerCallbacks,
      iceServers: [],
    });
    vi.spyOn(peer, "createOffer").mockResolvedValue("v=offer\r\n");
    vi.spyOn(peer, "applyAnswer").mockResolvedValue();
    const testPeer = peer as unknown as TestableAudioPeer;
    const sendRtp = vi
      .spyOn(testPeer.state.transceiver.sender, "sendRtp")
      .mockResolvedValue(undefined);
    const emittedFrames: Buffer[] = [];
    const takeNextRelayFrame = testPeer.takeNextRelayFrame.bind(testPeer);
    vi.spyOn(testPeer, "takeNextRelayFrame").mockImplementation(() => {
      const frame = takeNextRelayFrame();
      emittedFrames.push(frame);
      return frame;
    });
    const initialSequenceNumber = testPeer.sequenceNumber;
    const initialTimestamp = testPeer.timestamp;
    const copy = vi.spyOn(Buffer.prototype, "copy");
    try {
      try {
        resolvePeer?.(peer);
        await connection;

        expect(copy).not.toHaveBeenCalled();
        expect(testPeer.pendingAudio).toBe(bridgePendingAudio);
        expect(testPeer.pendingAudio).toHaveLength(MAX_PENDING_AUDIO_BYTES);
        expect(testBridge.pendingAudio).not.toBe(bridgePendingAudio);
        expect(testBridge.pendingAudio).toHaveLength(0);
      } finally {
        copy.mockRestore();
      }

      testPeer.state.peer.connectionStateChange.execute("connected");
      await vi.advanceTimersByTimeAsync(4_980);

      expect(testPeer.pendingAudio).toHaveLength(0);
      expect(emittedFrames).toHaveLength(MAX_PENDING_RELAY_FRAMES);
      expect(emittedFrames.map((frame) => frame.readUInt16LE(0))).toEqual(
        Array.from({ length: MAX_PENDING_RELAY_FRAMES }, (_, index) => index + 7),
      );
      expect(sendRtp).toHaveBeenCalledTimes(MAX_PENDING_RELAY_FRAMES);
      const packets = sendRtp.mock.calls.map(
        ([packet]) =>
          packet as {
            header: { payloadType: number; sequenceNumber: number; timestamp: number };
            payload: Buffer;
          },
      );
      expect(packets.every((packet) => packet.header.payloadType === 111)).toBe(true);
      expect(packets.every((packet) => packet.payload.length > 0)).toBe(true);
      expect(packets.at(-1)?.header.sequenceNumber).toBe(
        (initialSequenceNumber + MAX_PENDING_RELAY_FRAMES - 1) & 0xffff,
      );
      expect(packets.at(-1)?.header.timestamp).toBe(
        (initialTimestamp + (MAX_PENDING_RELAY_FRAMES - 1) * 960) >>> 0,
      );
      expect(onError).not.toHaveBeenCalled();
    } finally {
      bridge.close();
      vi.useRealTimers();
    }
  });
});
