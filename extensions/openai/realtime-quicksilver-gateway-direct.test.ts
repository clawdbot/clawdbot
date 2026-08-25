import { describe, expect, it, vi } from "vitest";
import { openAIRealtimeHost } from "./realtime-host.js";
import { OpenAIQuicksilverGatewayBridge } from "./realtime-quicksilver-gateway-bridge.js";
import { emitSideband, FakeSocket, parseSent } from "./realtime-quicksilver.test-helpers.js";

describe("GPT-Live Gateway direct transport", () => {
  it("waits for provider readiness and bypasses WebRTC allocation", async () => {
    let socket: FakeSocket | undefined;
    const createPeer = vi.fn();
    const fetchImpl = vi.fn();
    const onAudio = vi.fn();
    const onClose = vi.fn();
    const onReady = vi.fn();
    const runAgentConsult = Object.assign(
      vi.fn(async () => ({ text: "Delegated result" })),
      { claimAppend: vi.fn(() => true) },
    );
    const bridge = new OpenAIQuicksilverGatewayBridge(
      {
        providerConfig: {},
        model: "gpt-live-test-canary",
        voice: "marin",
        instructions: "Speak briefly.",
        audioFormat: { encoding: "pcm16", sampleRateHz: 24_000, channels: 1 },
        onAudio,
        onClearAudio: vi.fn(),
        onClose,
        onReady,
        runAgentConsult,
        handleDelegationInput: () => "consult",
        logger: { debug: vi.fn(), warn: vi.fn() },
        resolveAuth: vi.fn(async () => ({
          type: "api-key" as const,
          token: "platform-key",
        })),
        createPeer,
        fetchImpl: fetchImpl as typeof fetch,
        webSocketFactory: () => {
          socket = new FakeSocket();
          return socket;
        },
      },
      openAIRealtimeHost,
    );

    try {
      const connection = bridge.connect();
      await vi.waitFor(() => expect(socket?.sent).toHaveLength(1));
      if (!socket) {
        throw new Error("expected direct socket");
      }
      const connectedSocket = socket;
      expect(parseSent(connectedSocket)[0]).toMatchObject({
        type: "session.update",
        session: {
          audio: { output: { voice: "marin" } },
          delegation: { type: "client", ack_filler: false },
        },
      });
      expect(JSON.stringify(parseSent(connectedSocket)[0])).toContain(
        "Wait for the host control result",
      );
      expect(onReady).not.toHaveBeenCalled();
      expect(createPeer).not.toHaveBeenCalled();
      expect(fetchImpl).not.toHaveBeenCalled();

      bridge.sendAudio(Buffer.from([0x01, 0x02]));
      vi.useFakeTimers();
      emitSideband(connectedSocket, {
        type: "session.started",
        session: {},
      });
      await connection;

      expect(onReady).toHaveBeenCalledOnce();
      expect(parseSent(connectedSocket)).toContainEqual({
        type: "input_audio.append",
        audio: "AQI=",
      });
      emitSideband(connectedSocket, {
        type: "output_audio.delta",
        audio: "AwQ=",
      });
      expect(onAudio).toHaveBeenCalledExactlyOnceWith(Buffer.from([0x03, 0x04]));

      emitSideband(connectedSocket, {
        type: "delegation.created",
        item: {
          type: "delegation",
          target: "client",
          id: "delegation-direct",
          content: [{ type: "input_text", text: "Check the lights" }],
        },
      });
      await vi.waitFor(() => expect(runAgentConsult).toHaveBeenCalledOnce());
      await vi.waitFor(() =>
        expect(
          parseSent(connectedSocket).filter((event) => event.type === "delegation.context.append"),
        ).toHaveLength(1),
      );
      await vi.advanceTimersByTimeAsync(30 * 60_000);
      expect(onClose).toHaveBeenCalledExactlyOnceWith("completed");
    } finally {
      vi.useRealTimers();
      bridge.close();
    }
  });

  it("rejects startup when onReady closes the bridge reentrantly", async () => {
    let socket: FakeSocket | undefined;
    const bridgeRef: { current?: OpenAIQuicksilverGatewayBridge } = {};
    const bridge = new OpenAIQuicksilverGatewayBridge(
      {
        providerConfig: {},
        model: "gpt-live-test-canary",
        voice: "marin",
        audioFormat: { encoding: "pcm16", sampleRateHz: 24_000, channels: 1 },
        onAudio: vi.fn(),
        onClearAudio: vi.fn(),
        onReady: () => bridgeRef.current?.close(),
        runAgentConsult: vi.fn(async () => ({ text: "Done" })),
        logger: { debug: vi.fn(), warn: vi.fn() },
        resolveAuth: vi.fn(async () => ({
          type: "api-key" as const,
          token: "platform-key",
        })),
        webSocketFactory: () => {
          socket = new FakeSocket();
          return socket;
        },
      },
      openAIRealtimeHost,
    );
    bridgeRef.current = bridge;

    const connection = bridge.connect();
    await vi.waitFor(() => expect(socket).toBeDefined());
    emitSideband(socket!, { type: "session.started", session: {} });

    await expect(connection).rejects.toThrow("OpenAI GPT-Live gateway relay failed");
    expect(bridge.isConnected()).toBe(false);
  });
});
