/**
 * Tests for MediaStreamHandler - WebSocket audio streaming.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

import type { MediaStreamConfig } from "./media-stream.js";
import { MediaStreamHandler } from "./media-stream.js";
import type {
  OpenAIRealtimeSTTProvider,
  RealtimeSTTSession,
} from "./providers/stt-openai-realtime.js";

// Mock WebSocket
vi.mock("ws", () => {
  class MockWebSocket {
    readyState = 1; // OPEN
    send = vi.fn();
    close = vi.fn();
    on = vi.fn();
    emit = vi.fn();
    static OPEN = 1;
    static CLOSED = 3;
  }

  class MockWebSocketServer {
    on = vi.fn();
    handleUpgrade = vi.fn();
    emit = vi.fn();
  }

  return {
    WebSocket: MockWebSocket,
    WebSocketServer: MockWebSocketServer,
  };
});

describe("MediaStreamHandler", () => {
  let handler: MediaStreamHandler;
  let mockSttSession: RealtimeSTTSession;
  let mockSttProvider: OpenAIRealtimeSTTProvider;
  let config: MediaStreamConfig;

  beforeEach(() => {
    mockSttSession = {
      sendAudio: vi.fn(),
      connect: vi.fn().mockResolvedValue(undefined),
      close: vi.fn(),
      onPartial: vi.fn(),
      onTranscript: vi.fn(),
    } as unknown as RealtimeSTTSession;

    mockSttProvider = {
      createSession: vi.fn().mockReturnValue(mockSttSession),
    } as unknown as OpenAIRealtimeSTTProvider;

    config = {
      sttProvider: mockSttProvider,
      onTranscript: vi.fn(),
      onPartialTranscript: vi.fn(),
      onConnect: vi.fn(),
      onDisconnect: vi.fn(),
    };

    handler = new MediaStreamHandler(config);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("constructor", () => {
    it("creates handler with config", () => {
      expect(handler).toBeDefined();
    });
  });

  describe("sendAudio", () => {
    it("sends audio as base64 encoded media event", () => {
      const mockWs = {
        readyState: WebSocket.OPEN,
        send: vi.fn(),
      } as unknown as WebSocket;

      // Access private sessions map to add a test session
      const sessions = (
        handler as unknown as { sessions: Map<string, unknown> }
      ).sessions;
      sessions.set("stream-123", {
        callId: "call-456",
        streamSid: "stream-123",
        ws: mockWs,
        sttSession: mockSttSession,
      });

      const audioBuffer = Buffer.from([0x01, 0x02, 0x03, 0x04]);
      handler.sendAudio("stream-123", audioBuffer);

      expect(mockWs.send).toHaveBeenCalledWith(
        JSON.stringify({
          event: "media",
          streamSid: "stream-123",
          media: { payload: audioBuffer.toString("base64") },
        }),
      );
    });

    it("does nothing when session not found", () => {
      const audioBuffer = Buffer.from([0x01, 0x02, 0x03]);
      // Should not throw
      expect(() => handler.sendAudio("nonexistent", audioBuffer)).not.toThrow();
    });

    it("does nothing when WebSocket is closed", () => {
      const mockWs = {
        readyState: 3, // CLOSED
        send: vi.fn(),
      } as unknown as WebSocket;

      const sessions = (
        handler as unknown as { sessions: Map<string, unknown> }
      ).sessions;
      sessions.set("stream-123", {
        callId: "call-456",
        streamSid: "stream-123",
        ws: mockWs,
        sttSession: mockSttSession,
      });

      handler.sendAudio("stream-123", Buffer.from([0x01]));

      expect(mockWs.send).not.toHaveBeenCalled();
    });
  });

  describe("sendMark", () => {
    it("sends mark event", () => {
      const mockWs = {
        readyState: WebSocket.OPEN,
        send: vi.fn(),
      } as unknown as WebSocket;

      const sessions = (
        handler as unknown as { sessions: Map<string, unknown> }
      ).sessions;
      sessions.set("stream-123", {
        callId: "call-456",
        streamSid: "stream-123",
        ws: mockWs,
        sttSession: mockSttSession,
      });

      handler.sendMark("stream-123", "audio-end");

      expect(mockWs.send).toHaveBeenCalledWith(
        JSON.stringify({
          event: "mark",
          streamSid: "stream-123",
          mark: { name: "audio-end" },
        }),
      );
    });
  });

  describe("clearAudio", () => {
    it("sends clear event", () => {
      const mockWs = {
        readyState: WebSocket.OPEN,
        send: vi.fn(),
      } as unknown as WebSocket;

      const sessions = (
        handler as unknown as { sessions: Map<string, unknown> }
      ).sessions;
      sessions.set("stream-123", {
        callId: "call-456",
        streamSid: "stream-123",
        ws: mockWs,
        sttSession: mockSttSession,
      });

      handler.clearAudio("stream-123");

      expect(mockWs.send).toHaveBeenCalledWith(
        JSON.stringify({
          event: "clear",
          streamSid: "stream-123",
        }),
      );
    });
  });

  describe("getSessionByCallId", () => {
    it("finds session by call ID", () => {
      const mockWs = { readyState: WebSocket.OPEN } as unknown as WebSocket;

      const sessions = (
        handler as unknown as { sessions: Map<string, unknown> }
      ).sessions;
      sessions.set("stream-123", {
        callId: "call-456",
        streamSid: "stream-123",
        ws: mockWs,
        sttSession: mockSttSession,
      });

      const found = handler.getSessionByCallId("call-456");

      expect(found).toBeDefined();
      expect(found?.streamSid).toBe("stream-123");
    });

    it("returns undefined when not found", () => {
      const found = handler.getSessionByCallId("nonexistent");

      expect(found).toBeUndefined();
    });
  });

  describe("closeAll", () => {
    it("closes all sessions", () => {
      const mockWs1 = {
        readyState: WebSocket.OPEN,
        close: vi.fn(),
      } as unknown as WebSocket;
      const mockWs2 = {
        readyState: WebSocket.OPEN,
        close: vi.fn(),
      } as unknown as WebSocket;

      const mockSession1 = {
        sendAudio: vi.fn(),
        close: vi.fn(),
      } as unknown as RealtimeSTTSession;
      const mockSession2 = {
        sendAudio: vi.fn(),
        close: vi.fn(),
      } as unknown as RealtimeSTTSession;

      const sessions = (
        handler as unknown as { sessions: Map<string, unknown> }
      ).sessions;
      sessions.set("stream-1", {
        callId: "call-1",
        streamSid: "stream-1",
        ws: mockWs1,
        sttSession: mockSession1,
      });
      sessions.set("stream-2", {
        callId: "call-2",
        streamSid: "stream-2",
        ws: mockWs2,
        sttSession: mockSession2,
      });

      handler.closeAll();

      expect(mockSession1.close).toHaveBeenCalled();
      expect(mockSession2.close).toHaveBeenCalled();
      expect(mockWs1.close).toHaveBeenCalled();
      expect(mockWs2.close).toHaveBeenCalled();
      expect(sessions.size).toBe(0);
    });
  });

  describe("handleUpgrade", () => {
    it("creates WebSocketServer on first upgrade", () => {
      const mockRequest = { url: "/voice/stream" };
      const mockSocket = {};
      const mockHead = Buffer.alloc(0);

      handler.handleUpgrade(
        mockRequest as never,
        mockSocket as never,
        mockHead,
      );

      // Should have created WSS (checked via internal state)
      const wss = (handler as unknown as { wss: unknown }).wss;
      expect(wss).toBeDefined();
    });
  });
});
