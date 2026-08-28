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
}) {
  let socket: FakeSocket | undefined;
  const bridge = new OpenAIQuicksilverGatewayBridge({
    providerConfig: {},
    model: "gpt-live-1-boulder-alpha",
    voice: "marin",
    audioFormat: { encoding: "pcm16", sampleRateHz: 24_000, channels: 1 },
    onAudio: vi.fn(),
    onClearAudio: vi.fn(),
    runAgentConsult: params.runAgentConsult,
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
    fetchImpl: vi.fn(async () => createCallResponse("v=answer\r\n", "rtc_lifecycle")),
    webSocketFactory: () => {
      socket = new FakeSocket();
      return socket;
    },
  });
  return {
    bridge,
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

  it("detaches transport without aborting an accepted delegation", async () => {
    let consultSignal: AbortSignal | undefined;
    let resolveConsult!: (result: { text: string }) => void;
    const consultResult = new Promise<{ text: string }>((resolve) => {
      resolveConsult = resolve;
    });
    const runAgentConsult = vi.fn(async ({ signal }: { prompt: string; signal?: AbortSignal }) => {
      consultSignal = signal;
      return await consultResult;
    });
    const harness = createBridge({ runAgentConsult });

    await harness.bridge.connect();
    const socket = harness.getSocket();
    emitDelegation(socket, "delegation-detach", "Finish after disconnect");
    await vi.waitFor(() => expect(runAgentConsult).toHaveBeenCalledOnce());

    harness.bridge.close({ disposition: "detach" });
    expect(consultSignal?.aborted).toBe(false);
    resolveConsult({ text: "finished after detach" });
    await Promise.resolve();
    await Promise.resolve();
    expect(parseSent(socket).filter((event) => event.type === "delegation.context.append")).toEqual(
      [],
    );
  });
});
