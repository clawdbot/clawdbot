import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { OpenAIQuicksilverGatewayBridge } from "./realtime-quicksilver-gateway-bridge.js";
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
  const bridge = new OpenAIQuicksilverGatewayBridge({
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
    createPeer: vi.fn(async () => ({
      createOffer: vi.fn(async () => "v=offer\r\n"),
      applyAnswer: vi.fn(async () => undefined),
      adoptPendingAudio: vi.fn(),
      sendAudio: vi.fn(),
      close: vi.fn(),
    })),
    fetchImpl,
    webSocketFactory: () => {
      socket = new FakeSocket();
      return socket;
    },
  });
  return {
    bridge,
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
          message: "OpenAI GPT-Live sideband error: temporary voice failure",
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
        const init = harness.fetchImpl.mock.calls[0]?.[1];
        if (typeof init?.body !== "string") {
          throw new Error("Expected initial call multipart body");
        }
        const form = await new Response(init.body, { headers: init.headers }).formData();
        const session = form.get("session");
        if (typeof session !== "string") {
          throw new Error("Expected initial session JSON");
        }
        expect(JSON.parse(session).delegation).toEqual(
          classified ? { type: "client", ack_filler: false } : { type: "client" },
        );
        const socket = harness.getSocket();
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
