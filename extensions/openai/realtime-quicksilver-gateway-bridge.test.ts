import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { OpenAIQuicksilverGatewayBridge } from "./realtime-quicksilver-gateway-bridge.js";
import {
  OpenAIQuicksilverAudioPeer,
  type OpenAIQuicksilverAudioPeerContract,
} from "./realtime-quicksilver-peer.runtime.js";
import {
  releaseOpenAIQuicksilverSession,
  reserveOpenAIQuicksilverSession,
} from "./realtime-quicksilver-session-limit.js";
import { connectOpenAIQuicksilverSideband } from "./realtime-quicksilver-sideband.js";
import {
  createCallResponse,
  emitSideband,
  FakeSocket,
  parseSent,
} from "./realtime-quicksilver.test-helpers.js";

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
    vi.doMock("libopus-wasm", async (importOriginal) => {
      const actual = await importOriginal<typeof import("libopus-wasm")>();
      return {
        ...actual,
        createEncoder: vi.fn(async () => encoder),
        createDecoder: vi.fn(async () => {
          throw new Error("decoder init failed");
        }),
      };
    });
    vi.resetModules();
    const { RTCPeerConnection } = await import("werift");
    const closePeer = vi.spyOn(RTCPeerConnection.prototype, "close");
    try {
      const { OpenAIQuicksilverAudioPeer: ReloadedPeer } =
        await import("./realtime-quicksilver-peer.runtime.js");
      await expect(
        ReloadedPeer.create({
          callbacks: { onAudio: vi.fn(), onError: vi.fn() },
          iceServers: [],
        }),
      ).rejects.toThrow("decoder init failed");
      expect(encoder.free).toHaveBeenCalledOnce();
      expect(closePeer).toHaveBeenCalled();
    } finally {
      closePeer.mockRestore();
      vi.doUnmock("libopus-wasm");
      vi.resetModules();
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
    vi.doMock("libopus-wasm", async (importOriginal) => {
      const actual = await importOriginal<typeof import("libopus-wasm")>();
      return {
        ...actual,
        createEncoder: vi.fn(async () => encoder),
        createDecoder,
      };
    });
    vi.resetModules();
    const { RTCPeerConnection } = await import("werift");
    const closePeer = vi.spyOn(RTCPeerConnection.prototype, "close");
    const controller = new AbortController();
    try {
      const { OpenAIQuicksilverAudioPeer: ReloadedPeer } =
        await import("./realtime-quicksilver-peer.runtime.js");
      const creation = ReloadedPeer.create({
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
      vi.doUnmock("libopus-wasm");
      vi.resetModules();
    }
  });
});

describe("GPT-Live gateway relay bridge", () => {
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
    const peer: OpenAIQuicksilverAudioPeerContract = {
      createOffer,
      applyAnswer,
      sendAudio: vi.fn(),
      close: closePeer,
    };
    const runAgentConsult = vi.fn(async () => ({ text: "Delegated result" }));
    const onAudio = vi.fn();
    const onClearAudio = vi.fn();
    const onEvent = vi.fn();
    const onReady = vi.fn();
    const onClose = vi.fn();
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
      runAgentConsult,
      logger: { debug: vi.fn(), warn: vi.fn() },
      resolveAuth: vi.fn(async () => ({
        type: "oauth" as const,
        token: "oauth-token",
        accountId: "account-1",
      })),
      createPeer: vi.fn(async () => peer),
      fetchImpl: vi.fn(async () => createCallResponse("v=answer\r\n", "rtc_bridge")),
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
    expect(createOffer).toHaveBeenCalledOnce();
    expect(applyAnswer).toHaveBeenCalledWith("v=answer\r\n");
    emitSideband(connectedSocket, {
      type: "session.started",
      session: { id: "rtc_bridge", expires_at: Math.floor(Date.now() / 1000) + 60 },
    });
    expect(onReady).toHaveBeenCalledOnce();

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
