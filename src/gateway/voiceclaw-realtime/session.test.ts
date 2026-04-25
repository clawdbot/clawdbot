import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ResolvedGatewayAuth } from "../auth.js";
import { resolveRealtimeSenderIsOwner, VoiceClawRealtimeSession } from "./session.js";
import type {
  VoiceClawRealtimeAdapter,
  VoiceClawServerEvent,
  VoiceClawSessionConfigEvent,
} from "./types.js";

describe("resolveRealtimeSenderIsOwner", () => {
  it("allows only owner-equivalent realtime brain auth", () => {
    expect(resolveRealtimeSenderIsOwner("token", false)).toBe(true);
    expect(resolveRealtimeSenderIsOwner("password", false)).toBe(true);
    expect(resolveRealtimeSenderIsOwner("none", true)).toBe(true);

    expect(resolveRealtimeSenderIsOwner("none", false)).toBe(false);
    expect(resolveRealtimeSenderIsOwner("trusted-proxy", false)).toBe(false);
    expect(resolveRealtimeSenderIsOwner("tailscale", false)).toBe(false);
    expect(resolveRealtimeSenderIsOwner("device-token", false)).toBe(false);
  });
});

class FakeWebSocket extends EventEmitter {
  readyState: WebSocket["readyState"] = WebSocket.OPEN;
  sent: unknown[] = [];
  closeCode: number | undefined;
  closeReason: string | undefined;

  send(payload: string): void {
    this.sent.push(JSON.parse(payload) as unknown);
  }

  close(code?: number, reason?: string | Buffer): void {
    this.closeCode = code;
    this.closeReason = typeof reason === "string" ? reason : reason?.toString("utf8");
    this.readyState = WebSocket.CLOSING;
    this.emit("close");
  }
}

function makeAdapter(): VoiceClawRealtimeAdapter {
  return {
    connect: vi.fn(),
    sendAudio: vi.fn(),
    commitAudio: vi.fn(),
    sendFrame: vi.fn(),
    createResponse: vi.fn(),
    cancelResponse: vi.fn(),
    beginAsyncToolCall: vi.fn(),
    finishAsyncToolCall: vi.fn(),
    sendToolResult: vi.fn(),
    injectContext: vi.fn(),
    getTranscript: vi.fn(() => [{ role: "user" as const, text: "hello" }]),
    disconnect: vi.fn(),
  };
}

describe("VoiceClawRealtimeSession lifecycle", () => {
  it("sends session summary before closing after terminal adapter errors", () => {
    const ws = new FakeWebSocket();
    const adapter = makeAdapter();
    const releasePreauthBudget = vi.fn();
    const session = new VoiceClawRealtimeSession({
      ws: ws as unknown as WebSocket,
      req: {} as IncomingMessage,
      auth: { mode: "none" } as ResolvedGatewayAuth,
      config: {} as OpenClawConfig,
      trustedProxies: [],
      allowRealIpFallback: false,
      releasePreauthBudget,
      adapterFactory: () => adapter,
    });
    const internals = session as unknown as {
      adapter: VoiceClawRealtimeAdapter;
      config: VoiceClawSessionConfigEvent;
      handleAdapterEvent(event: VoiceClawServerEvent): void;
    };
    internals.adapter = adapter;
    internals.config = { type: "session.config", brainAgent: "none" };

    internals.handleAdapterEvent({
      type: "error",
      message: "Gemini Live reconnect failed",
      code: 502,
    });

    expect(ws.sent).toEqual([
      { type: "error", message: "Gemini Live reconnect failed", code: 502 },
      {
        type: "session.ended",
        summary: "Real-time brain session ended.",
        durationSec: expect.any(Number),
        turnCount: 1,
      },
    ]);
    expect(ws.closeCode).toBe(1011);
    expect(ws.closeReason).toBe("upstream error");
    expect(adapter.disconnect).toHaveBeenCalledOnce();
    expect(releasePreauthBudget).toHaveBeenCalledOnce();
  });
});
