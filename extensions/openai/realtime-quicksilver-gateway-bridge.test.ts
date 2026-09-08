import { describe, expect, it, vi } from "vitest";
import { openAIRealtimeHost } from "./realtime-host.js";
import { OpenAIQuicksilverPendingAudio } from "./realtime-quicksilver-audio-buffer.js";
import { OpenAIQuicksilverGatewayBridge } from "./realtime-quicksilver-gateway-bridge.js";
import type {
  OpenAIQuicksilverAudioPeerCallbacks,
  OpenAIQuicksilverAudioPeerContract,
} from "./realtime-quicksilver-peer.runtime.js";
import {
  releaseOpenAIQuicksilverSession,
  reserveOpenAIQuicksilverSession,
} from "./realtime-quicksilver-session-limit.js";
import {
  connectOpenAIQuicksilverSideband,
  type OpenAIQuicksilverSocketFactory,
} from "./realtime-quicksilver-sideband.js";
import { OPENAI_GPT_LIVE_MODELS } from "./realtime-quicksilver.js";
import {
  createCallResponse,
  emitSideband,
  FakeSocket,
  parseSent,
} from "./realtime-quicksilver.test-helpers.js";

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
    const createPeer = vi.fn((callbacks: OpenAIQuicksilverAudioPeerCallbacks) => {
      peerCallbacks = callbacks;
      return peerPromise;
    });
    const onClose = vi.fn();
    const logger = { debug: vi.fn(), warn: vi.fn() };
    const bridge = new OpenAIQuicksilverGatewayBridge(
      {
        providerConfig: {},
        model: "gpt-live-test-canary",
        voice: "marin",
        audioFormat: { encoding: "pcm16", sampleRateHz: 24_000, channels: 1 },
        onAudio: vi.fn(),
        onClearAudio: vi.fn(),
        onClose: params?.onClose ?? onClose,
        onError: params?.onError,
        runAgentConsult: vi.fn(async () => ({ text: "done" })),
        logger,
        resolveAuth: vi.fn(async () => ({
          type: "oauth" as const,
          token: "oauth-token",
          accountId: "account-1",
        })),
        createPeer,
        fetchImpl: vi.fn(async () => createCallResponse("v=answer\r\n", "rtc_pending_audio")),
        webSocketFactory: () => new FakeSocket(),
      },
      openAIRealtimeHost,
    );
    const connection = bridge.connect();
    return {
      bridge,
      connection,
      onClose,
      logger,
      peer,
      rejectPeer: (error: Error) => rejectPeer?.(error),
      resolvePeer: () => resolvePeer?.(peer),
      triggerPeerError: (error: Error) => peerCallbacks?.onError(error),
      triggerPeerMediaError: (error: Error) => peerCallbacks?.onMediaError?.(error),
      waitForPeerStart: async () => {
        await vi.waitFor(() => expect(createPeer).toHaveBeenCalledOnce());
      },
    };
  }

  it("preserves the call on media errors without logging raw error details", async () => {
    const harness = createPendingPeerBridge();
    try {
      await harness.waitForPeerStart();
      harness.resolvePeer();
      await harness.connection;
      harness.triggerPeerMediaError(new Error("synthetic-private-token"));
      expect(harness.bridge.isConnected()).toBe(true);
      expect(harness.onClose).not.toHaveBeenCalled();
      expect(harness.peer.close).not.toHaveBeenCalled();
      expect(harness.logger.debug).toHaveBeenCalledExactlyOnceWith(
        "GPT-Live WebRTC media packet dropped",
      );
      harness.triggerPeerError(new Error("terminal connection failure"));
      expect(harness.onClose).toHaveBeenCalledExactlyOnceWith("error");
      expect(harness.peer.close).toHaveBeenCalledOnce();
    } finally {
      harness.bridge.close();
    }
  });

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
    const { bridge, connection, onClose, peer, resolvePeer, waitForPeerStart } =
      createPendingPeerBridge();
    const testBridge = bridge as unknown as TestableGatewayBridge;
    await waitForPeerStart();
    bridge.sendAudio(Buffer.from([0x41, 0x42]));
    bridge.close();
    bridge.close();

    expect(testBridge.pendingAudio).toHaveLength(0);
    expect(onClose).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledWith("completed");
    resolvePeer();

    await expect(connection).rejects.toThrow("OpenAI GPT-Live gateway relay failed");
    await vi.waitFor(() => expect(peer.close).toHaveBeenCalledOnce());
    expect(peer.sendAudio).not.toHaveBeenCalled();
    bridge.sendAudio(Buffer.from([0x43, 0x44]));
    expect(peer.sendAudio).not.toHaveBeenCalled();
  });

  it("discards queued microphone audio when media peer creation fails", async () => {
    const { bridge, connection, peer, rejectPeer, waitForPeerStart } = createPendingPeerBridge();
    const pendingAudioState = bridge as unknown as {
      pendingAudio: OpenAIQuicksilverPendingAudio;
    };
    await waitForPeerStart();
    bridge.sendAudio(Buffer.from([0x41, 0x42]));
    rejectPeer(new Error("media peer unavailable"));

    await expect(connection).rejects.toThrow("OpenAI GPT-Live gateway relay failed");
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
    await harness.waitForPeerStart();
    const connectionRejected = expect(harness.connection).rejects.toThrow(
      "OpenAI GPT-Live gateway relay failed",
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
    await harness.waitForPeerStart();
    harness.bridge.sendAudio(Buffer.from([0x41, 0x42]));
    const connectionRejected = expect(harness.connection).rejects.toThrow(
      "OpenAI GPT-Live gateway relay failed",
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
    const connection = connectOpenAIQuicksilverSideband(
      {
        auth: { type: "api-key", token: "platform-key" },
        createSocket: () => socket,
        requestIds: {
          realtimeSessionId: "realtime-session",
          sessionId: "session",
          threadId: "thread",
        },
        signal: controller.signal,
        url: "wss://api.openai.com/v1/live/rtc_test",
      },
      openAIRealtimeHost,
    );
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
    const connection = connectOpenAIQuicksilverSideband(
      {
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
      },
      openAIRealtimeHost,
    );

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
    const bridge = new OpenAIQuicksilverGatewayBridge(
      {
        providerConfig: {},
        model: "gpt-live-test-canary",
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
      },
      openAIRealtimeHost,
    );

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

  it("uses released Platform WebRTC, delegates, drops sideband audio, and tears down", async () => {
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
    const bridge = new OpenAIQuicksilverGatewayBridge(
      {
        providerConfig: {},
        model: OPENAI_GPT_LIVE_MODELS[0],
        voice: "cove",
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
          type: "api-key" as const,
          token: "test-api-key",
        })),
        createPeer: vi.fn(async () => peer),
        fetchImpl,
        webSocketFactory: () => {
          socket = new FakeSocket();
          return socket;
        },
      },
      openAIRealtimeHost,
    );

    const connection = bridge.connect();
    await vi.waitFor(() => expect(socket).toBeDefined());
    if (!socket) {
      throw new Error("expected sideband socket");
    }
    const connectedSocket = socket;
    emitSideband(connectedSocket, {
      type: "session.started",
      session: { id: "rtc_bridge", expires_at: Math.floor(Date.now() / 1000) + 60 },
    });
    await connection;
    const body = fetchImpl.mock.calls[0]?.[1]?.body;
    if (typeof body !== "string") {
      throw new Error("Expected initial call body");
    }
    expect(fetchImpl.mock.calls[0]?.[1]?.headers).toMatchObject({
      "Content-Type": expect.stringMatching(/^multipart\/form-data; boundary=/),
    });
    expect(body).toContain('"delegation":{"type":"client","ack_filler":false}');
    expect(body).toContain("Wait for the host control result");
    expect(createOffer).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(applyAnswer).toHaveBeenCalledWith("v=answer\r\n");
    expect(adoptPendingAudio).not.toHaveBeenCalled();
    expect(parseSent(connectedSocket).some((event) => event.type === "session.update")).toBe(false);
    expect(onReady).toHaveBeenCalledOnce();
    bridge.sendUserMessage("Ready for the next task");
    expect(parseSent(connectedSocket)).toEqual([
      {
        type: "session.context.append",
        channel: "speakable",
        content: [{ type: "input_text", text: "Ready for the next task" }],
      },
    ]);

    emitSideband(connectedSocket, { type: "output_audio.delta", audio: "ignored-media-copy" });
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
    const bridge = new OpenAIQuicksilverGatewayBridge(
      {
        providerConfig: {},
        model: "gpt-live-test-canary",
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
      },
      openAIRealtimeHost,
    );

    await bridge.connect();
    if (!socket) {
      throw new Error("expected sideband socket");
    }
    socket.close(1000, "complete");
    expect(onError).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledWith("completed");
  });
});
