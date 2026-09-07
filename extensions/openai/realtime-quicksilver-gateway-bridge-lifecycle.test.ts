import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { openAIRealtimeHost } from "./realtime-host.js";
import { OpenAIQuicksilverGatewayBridge } from "./realtime-quicksilver-gateway-bridge.js";
import {
  OpenAIQuicksilverAudioPeer,
  type OpenAIQuicksilverAudioPeerCallbacks,
} from "./realtime-quicksilver-peer.runtime.js";
import {
  createCallResponse,
  emitSideband,
  FakeSocket,
  parseSent,
} from "./realtime-quicksilver.test-helpers.js";

function createBridge(params: {
  runAgentConsult: (request: { prompt: string; signal?: AbortSignal }) => Promise<{ text: string }>;
  onError?: (error: Error) => void;
  onTranscript?: (role: "user" | "assistant", text: string, done: boolean) => void;
  handleDelegationInput?: (text: string) => "control" | "consult";
}) {
  let socket: FakeSocket | undefined;
  const fetchImpl = vi.fn<typeof fetch>(async () =>
    createCallResponse("v=answer\r\n", "rtc_lifecycle"),
  );
  const createPeer = vi.fn(async () => ({
    createOffer: vi.fn(async () => "v=offer\r\n"),
    applyAnswer: vi.fn(async () => undefined),
    adoptPendingAudio: vi.fn(),
    sendAudio: vi.fn(),
    close: vi.fn(),
  }));
  const bridge = new OpenAIQuicksilverGatewayBridge(
    {
      providerConfig: {},
      model: "gpt-live-test",
      voice: "marin",
      audioFormat: { encoding: "pcm16", sampleRateHz: 24_000, channels: 1 },
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
      onError: params.onError,
      onTranscript: params.onTranscript,
      runAgentConsult: params.runAgentConsult,
      handleDelegationInput: params.handleDelegationInput,
      logger: { debug: vi.fn(), warn: vi.fn() },
      resolveAuth: vi.fn(async () => ({
        type: "api-key" as const,
        token: "platform-key",
      })),
      createPeer,
      fetchImpl,
      webSocketFactory: () => {
        socket = new FakeSocket();
        const send = socket.send.bind(socket);
        socket.send = (payload) => {
          send(payload);
          if ((JSON.parse(payload) as { type?: string }).type === "session.update") {
            queueMicrotask(() =>
              emitSideband(socket!, {
                type: "session.started",
                session: { expires_at: Math.floor(Date.now() / 1000) + 60 },
              }),
            );
          }
        };
        return socket;
      },
    },
    openAIRealtimeHost,
  );
  return {
    bridge,
    createPeer,
    fetchImpl,
    getSocket: () => {
      if (!socket) {
        throw new Error("expected sideband socket");
      }
      return socket;
    },
  };
}

function emitDelegation(socket: FakeSocket, id: string, text: string): void {
  emitSideband(socket, {
    type: "delegation.created",
    item: {
      type: "delegation",
      target: "client",
      id,
      content: [{ type: "input_text", text }],
    },
  });
}

describe("OpenAI Quicksilver gateway bridge lifecycle", () => {
  it("logs a dropped media packet without tearing down the call", async () => {
    let peerCallbacks: OpenAIQuicksilverAudioPeerCallbacks | undefined;
    const logger = { debug: vi.fn(), warn: vi.fn() };
    const onClose = vi.fn();
    const bridge = new OpenAIQuicksilverGatewayBridge(
      {
        providerConfig: {},
        model: "gpt-live-1-codex",
        voice: "marin",
        audioFormat: { encoding: "pcm16", sampleRateHz: 24_000, channels: 1 },
        onAudio: vi.fn(),
        onClearAudio: vi.fn(),
        onClose,
        runAgentConsult: vi.fn(async () => ({ text: "done" })),
        logger,
        resolveAuth: vi.fn(async () => ({
          type: "oauth" as const,
          token: "oauth-token",
          accountId: "account-1",
        })),
        createPeer: vi.fn(async (callbacks: OpenAIQuicksilverAudioPeerCallbacks) => {
          peerCallbacks = callbacks;
          return {
            createOffer: vi.fn(async () => "v=offer\r\n"),
            applyAnswer: vi.fn(async () => undefined),
            adoptPendingAudio: vi.fn(),
            sendAudio: vi.fn(),
            close: vi.fn(),
          };
        }),
        fetchImpl: vi.fn(async () => createCallResponse("v=answer\r\n", "rtc_media_error")),
        webSocketFactory: () => new FakeSocket(),
      },
      openAIRealtimeHost,
    );
    try {
      await bridge.connect();

      // A single undecodable/lost RTP packet is recoverable: log and continue.
      peerCallbacks?.onMediaError?.(
        new Error("OpenAI GPT-Live WebRTC media failed: bad RTP packet payload"),
      );

      expect(onClose).not.toHaveBeenCalled();
      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringContaining("GPT-Live WebRTC media packet dropped"),
      );
      expect(bridge.isConnected()).toBe(true);

      // A terminal peer error still tears the call down.
      peerCallbacks?.onError(new Error("GPT-Live WebRTC media connection disconnected"));
      expect(onClose).toHaveBeenCalledWith("error");
      expect(bridge.isConnected()).toBe(false);
    } finally {
      bridge.close();
    }
  });

  it("routes per-packet media failures to onMediaError instead of onError when provided", async () => {
    const { RtpHeader, RtpPacket } = await import("werift");
    const onError = vi.fn();
    const onMediaError = vi.fn();
    const peer = await OpenAIQuicksilverAudioPeer.create({
      callbacks: { onAudio: vi.fn(), onError, onMediaError },
      iceServers: [],
    });
    type TestableAudioPeer = {
      state: { decoder: { decode(packet: unknown): Int16Array } };
      handleInboundRtp(packet: unknown): void;
    };
    const testPeer = peer as unknown as TestableAudioPeer;
    vi.spyOn(testPeer.state.decoder, "decode").mockImplementation(() => new Int16Array(960 * 2));
    const packet = (sequenceNumber: number, ssrc: number) =>
      new RtpPacket(
        new RtpHeader({
          payloadType: 111,
          sequenceNumber,
          ssrc,
          timestamp: (sequenceNumber * 960) >>> 0,
        }),
        Buffer.from([sequenceNumber & 0xff]),
      );
    try {
      testPeer.handleInboundRtp(packet(10, 1));
      testPeer.handleInboundRtp(packet(200, 2));

      expect(onMediaError).toHaveBeenCalledWith(
        expect.objectContaining({ message: "GPT-Live WebRTC audio source changed unexpectedly" }),
      );
      expect(onError).not.toHaveBeenCalled();
    } finally {
      peer.close();
    }
  });

  it("reports recoverable provider errors to the relay while preserving its connection", async () => {
    const onError = vi.fn();
    const onTranscript = vi.fn();
    const harness = createBridge({
      runAgentConsult: vi.fn(async () => ({ text: "Done" })),
      onError,
      onTranscript,
    });
    try {
      await harness.bridge.connect();
      const socket = harness.getSocket();
      emitSideband(socket, { type: "error", error: { message: "temporary voice failure" } });
      emitSideband(socket, {
        type: "turn.done",
        turn: { role: "assistant", transcript: "Recovered" },
      });

      expect(onError).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          message: "OpenAI GPT-Live provider error",
        }),
      );
      expect(onTranscript).toHaveBeenCalledWith("assistant", "Recovered", true);
      expect(harness.bridge.isConnected()).toBe(true);
    } finally {
      harness.bridge.close();
    }
  });

  it("aborts an accepted delegation when the bridge closes normally", async () => {
    let consultSignal: AbortSignal | undefined;
    const runAgentConsult = vi.fn(async ({ signal }: { prompt: string; signal?: AbortSignal }) => {
      consultSignal = signal;
      await new Promise<void>((resolve) => {
        signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return { text: "must not be delivered" };
    });
    const harness = createBridge({ runAgentConsult });

    await harness.bridge.connect();
    const socket = harness.getSocket();
    emitDelegation(socket, "delegation-abort", "Cancel this on close");
    await vi.waitFor(() => expect(runAgentConsult).toHaveBeenCalledOnce());

    harness.bridge.close();
    expect(consultSignal?.aborted).toBe(true);
    await Promise.resolve();
    expect(parseSent(socket).filter((event) => event.type === "delegation.context.append")).toEqual(
      [],
    );
  });

  it.each([false, true])(
    "detaches transport without aborting an accepted delegation (classified=%s)",
    async (classified) => {
      let consultSignal: AbortSignal | undefined;
      let resolveConsult!: (result: { text: string }) => void;
      const consultResult = new Promise<{ text: string }>((resolve) => {
        resolveConsult = resolve;
      });
      const runAgentConsult = vi.fn(
        async ({ signal }: { prompt: string; signal?: AbortSignal }) => {
          consultSignal = signal;
          return await consultResult;
        },
      );
      const harness = createBridge({
        runAgentConsult,
        handleDelegationInput: classified ? () => "consult" : undefined,
      });

      try {
        await harness.bridge.connect();
        const socket = harness.getSocket();
        expect(parseSent(socket)[0]).toMatchObject({
          type: "session.update",
          session: { delegation: { type: "client", ack_filler: false } },
        });
        expect(harness.fetchImpl).not.toHaveBeenCalled();
        expect(harness.createPeer).not.toHaveBeenCalled();
        emitDelegation(socket, "delegation-detach", "Finish after disconnect");
        await vi.waitFor(() => expect(runAgentConsult).toHaveBeenCalledOnce());
        expect(
          parseSent(socket).filter((event) => event.type === "session.context.append"),
        ).toHaveLength(classified ? 1 : 0);

        harness.bridge.close({ disposition: "detach" });
        const sentAtClose = socket.sent.length;
        emitDelegation(socket, "late", "Do not acknowledge after detach");
        expect(consultSignal?.aborted).toBe(false);
        resolveConsult({ text: "finished after detach" });
        await nextEventLoopTurn();
        expect(
          parseSent(socket).filter((event) => event.type === "delegation.context.append"),
        ).toEqual([]);
        expect(socket.sent).toHaveLength(sentAtClose);
        expect(runAgentConsult).toHaveBeenCalledOnce();
      } finally {
        resolveConsult({ text: "Finished" });
        harness.bridge.close();
      }
    },
  );
});
