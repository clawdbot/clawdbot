/**
 * Tests for TwilioProvider - Twilio Voice API integration.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TwilioConfig } from "../config.js";
import type { MediaStreamHandler } from "../media-stream.js";
import type { WebhookContext } from "../types.js";
import type { OpenAITTSProvider } from "./tts-openai.js";
import { TwilioProvider } from "./twilio.js";

// Mock fetch for API calls
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("TwilioProvider", () => {
  const validConfig: TwilioConfig = {
    accountSid: "AC123456789",
    authToken: "test-auth-token-abc123",
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("constructor", () => {
    it("creates provider with valid config", () => {
      const provider = new TwilioProvider(validConfig);
      expect(provider.name).toBe("twilio");
    });

    it("throws when accountSid is missing", () => {
      expect(() => new TwilioProvider({ authToken: "token" })).toThrow(
        "Twilio Account SID is required",
      );
    });

    it("throws when authToken is missing", () => {
      expect(() => new TwilioProvider({ accountSid: "AC123" })).toThrow(
        "Twilio Auth Token is required",
      );
    });

    it("sets publicUrl from options", () => {
      const provider = new TwilioProvider(validConfig, {
        publicUrl: "https://example.com/voice",
      });
      expect(provider.getPublicUrl()).toBe("https://example.com/voice");
    });
  });

  describe("public URL management", () => {
    it("setPublicUrl updates the URL", () => {
      const provider = new TwilioProvider(validConfig);
      expect(provider.getPublicUrl()).toBeNull();

      provider.setPublicUrl("https://tunnel.example.com");
      expect(provider.getPublicUrl()).toBe("https://tunnel.example.com");
    });
  });

  describe("TTS provider integration", () => {
    it("accepts OpenAI TTS provider", () => {
      const provider = new TwilioProvider(validConfig);
      const mockTtsProvider = {
        synthesize: vi.fn(),
        synthesizeForTwilio: vi.fn(),
      } as unknown as OpenAITTSProvider;

      // Should not throw
      expect(() => provider.setTTSProvider(mockTtsProvider)).not.toThrow();
    });
  });

  describe("media stream handler integration", () => {
    it("accepts media stream handler", () => {
      const provider = new TwilioProvider(validConfig);
      const mockHandler = {
        sendAudio: vi.fn(),
        sendMark: vi.fn(),
      } as unknown as MediaStreamHandler;

      expect(() => provider.setMediaStreamHandler(mockHandler)).not.toThrow();
    });
  });

  describe("stream registration", () => {
    let provider: TwilioProvider;

    beforeEach(() => {
      provider = new TwilioProvider(validConfig, {
        streamPath: "/voice/stream",
      });
    });

    it("registers call to stream mapping", () => {
      provider.registerCallStream("CA123", "MZ456");
      // The mapping is internal, but we can test playTts behavior
    });

    it("unregisters call stream", () => {
      provider.registerCallStream("CA123", "MZ456");
      provider.unregisterCallStream("CA123");
      // Stream should no longer be mapped
    });
  });

  describe("parseWebhookEvent", () => {
    let provider: TwilioProvider;

    beforeEach(() => {
      provider = new TwilioProvider(validConfig, { skipVerification: true });
    });

    it("parses call.initiated event", () => {
      const ctx: WebhookContext = {
        headers: {},
        rawBody: "CallSid=CA123&CallStatus=initiated&Direction=outbound-api",
        url: "https://example.com/voice",
        method: "POST",
      };

      const result = provider.parseWebhookEvent(ctx);

      expect(result.events).toHaveLength(1);
      expect(result.events[0].type).toBe("call.initiated");
      expect(result.events[0].providerCallId).toBe("CA123");
    });

    it("parses call.answered event (in-progress status)", () => {
      const ctx: WebhookContext = {
        headers: {},
        rawBody: "CallSid=CA456&CallStatus=in-progress&Direction=outbound-api",
        url: "https://example.com/voice",
        method: "POST",
      };

      const result = provider.parseWebhookEvent(ctx);

      expect(result.events).toHaveLength(1);
      expect(result.events[0].type).toBe("call.answered");
    });

    it("parses call.speech event from Gather", () => {
      const ctx: WebhookContext = {
        headers: {},
        rawBody:
          "CallSid=CA789&SpeechResult=Hello%20World&Confidence=0.95&Direction=outbound-api",
        url: "https://example.com/voice",
        method: "POST",
      };

      const result = provider.parseWebhookEvent(ctx);

      expect(result.events).toHaveLength(1);
      expect(result.events[0].type).toBe("call.speech");
      if (result.events[0].type === "call.speech") {
        expect(result.events[0].transcript).toBe("Hello World");
        expect(result.events[0].confidence).toBe(0.95);
        expect(result.events[0].isFinal).toBe(true);
      }
    });

    it("parses DTMF event", () => {
      const ctx: WebhookContext = {
        headers: {},
        rawBody: "CallSid=CA123&Digits=1234&Direction=outbound-api",
        url: "https://example.com/voice",
        method: "POST",
      };

      const result = provider.parseWebhookEvent(ctx);

      expect(result.events).toHaveLength(1);
      expect(result.events[0].type).toBe("call.dtmf");
      if (result.events[0].type === "call.dtmf") {
        expect(result.events[0].digits).toBe("1234");
      }
    });

    it("parses call.ended with different reasons", () => {
      const statuses = ["completed", "busy", "no-answer", "failed"];

      for (const status of statuses) {
        const ctx: WebhookContext = {
          headers: {},
          rawBody: `CallSid=CA123&CallStatus=${status}`,
          url: "https://example.com/voice",
          method: "POST",
        };

        const result = provider.parseWebhookEvent(ctx);

        expect(result.events).toHaveLength(1);
        expect(result.events[0].type).toBe("call.ended");
        if (result.events[0].type === "call.ended") {
          expect(result.events[0].reason).toBe(status);
        }
      }
    });

    it("maps canceled status to hangup-bot", () => {
      const ctx: WebhookContext = {
        headers: {},
        rawBody: "CallSid=CA123&CallStatus=canceled",
        url: "https://example.com/voice",
        method: "POST",
      };

      const result = provider.parseWebhookEvent(ctx);

      expect(result.events[0].type).toBe("call.ended");
      if (result.events[0].type === "call.ended") {
        expect(result.events[0].reason).toBe("hangup-bot");
      }
    });

    it("uses callId from query param if available", () => {
      const ctx: WebhookContext = {
        headers: {},
        rawBody: "CallSid=CA123&CallStatus=in-progress",
        url: "https://example.com/voice?callId=my-internal-id",
        method: "POST",
        query: { callId: "my-internal-id" },
      };

      const result = provider.parseWebhookEvent(ctx);

      expect(result.events[0].callId).toBe("my-internal-id");
      expect(result.events[0].providerCallId).toBe("CA123");
    });

    it("returns TwiML in response body", () => {
      const ctx: WebhookContext = {
        headers: {},
        rawBody: "CallSid=CA123&CallStatus=initiated",
        url: "https://example.com/voice",
        method: "POST",
      };

      const result = provider.parseWebhookEvent(ctx);

      expect(result.providerResponseHeaders?.["Content-Type"]).toBe(
        "application/xml",
      );
      expect(result.providerResponseBody).toContain("<?xml");
      expect(result.providerResponseBody).toContain("<Response>");
    });

    it("returns pause TwiML for inbound ringing", () => {
      const ctx: WebhookContext = {
        headers: {},
        rawBody: "CallSid=CA123&CallStatus=ringing&Direction=inbound",
        url: "https://example.com/voice",
        method: "POST",
      };

      const result = provider.parseWebhookEvent(ctx);

      expect(result.providerResponseBody).toContain("<Pause");
    });
  });

  describe("TwiML generation", () => {
    it("generates stream connect TwiML", () => {
      const provider = new TwilioProvider(validConfig, {
        publicUrl: "https://example.com",
        streamPath: "/voice/stream",
      });

      const twiml = provider.getStreamConnectXml(
        "wss://example.com/voice/stream",
      );

      expect(twiml).toContain("<?xml");
      expect(twiml).toContain("<Connect>");
      expect(twiml).toContain('<Stream url="wss://example.com/voice/stream"');
      expect(twiml).toContain("</Connect>");
    });

    it("escapes XML special characters in stream URL", () => {
      const provider = new TwilioProvider(validConfig);

      const twiml = provider.getStreamConnectXml(
        "wss://example.com?param=a&b=c",
      );

      expect(twiml).toContain("&amp;");
      expect(twiml).not.toContain("?param=a&b");
    });
  });

  describe("initiateCall", () => {
    it("calls Twilio API with correct params", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () =>
          Promise.resolve(JSON.stringify({ sid: "CA999", status: "queued" })),
      });

      const provider = new TwilioProvider(validConfig);

      const result = await provider.initiateCall({
        callId: "internal-123",
        from: "+15551234567",
        to: "+15559876543",
        webhookUrl: "https://example.com/voice",
      });

      expect(result.providerCallId).toBe("CA999");
      expect(result.status).toBe("queued");

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/Calls.json"),
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            Authorization: expect.stringContaining("Basic"),
            "Content-Type": "application/x-www-form-urlencoded",
          }),
        }),
      );
    });

    it("includes callId in webhook URL", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ sid: "CA123" })),
      });

      const provider = new TwilioProvider(validConfig);

      await provider.initiateCall({
        callId: "my-call-id",
        from: "+15551234567",
        to: "+15559876543",
        webhookUrl: "https://example.com/voice",
      });

      const body = mockFetch.mock.calls[0][1].body;
      expect(body.get("Url")).toContain("callId=my-call-id");
    });
  });

  describe("hangupCall", () => {
    it("updates call status to completed", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(""),
      });

      const provider = new TwilioProvider(validConfig);

      await provider.hangupCall({
        callId: "internal-123",
        providerCallId: "CA123",
        reason: "hangup-bot",
      });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/Calls/CA123.json"),
        expect.objectContaining({
          method: "POST",
        }),
      );

      const body = mockFetch.mock.calls[0][1].body;
      expect(body.get("Status")).toBe("completed");
    });

    it("handles 404 gracefully", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: () => Promise.resolve("Not Found"),
      });

      const provider = new TwilioProvider(validConfig);

      // Should not throw
      await expect(
        provider.hangupCall({
          callId: "internal-123",
          providerCallId: "CA-gone",
          reason: "hangup-bot",
        }),
      ).resolves.toBeUndefined();
    });
  });

  describe("playTts", () => {
    describe("TwiML fallback mode", () => {
      it("uses TwiML Say when no TTS provider configured", async () => {
        // First call to initiate and store webhook URL
        mockFetch.mockResolvedValueOnce({
          ok: true,
          text: () => Promise.resolve(JSON.stringify({ sid: "CA123" })),
        });
        // Second call for TTS
        mockFetch.mockResolvedValueOnce({
          ok: true,
          text: () => Promise.resolve(""),
        });

        const provider = new TwilioProvider(validConfig);

        await provider.initiateCall({
          callId: "test-call",
          from: "+15551234567",
          to: "+15559876543",
          webhookUrl: "https://example.com/voice",
        });

        await provider.playTts({
          callId: "test-call",
          providerCallId: "CA123",
          text: "Hello, how can I help?",
          voice: "onyx",
        });

        // Second call should be TTS
        const body = mockFetch.mock.calls[1][1].body;
        const twiml = body.get("Twiml");
        expect(twiml).toContain("<Say");
        expect(twiml).toContain("Hello, how can I help?");
      });

      it("escapes XML in speech text", async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          text: () => Promise.resolve(JSON.stringify({ sid: "CA123" })),
        });
        mockFetch.mockResolvedValueOnce({
          ok: true,
          text: () => Promise.resolve(""),
        });

        const provider = new TwilioProvider(validConfig);

        await provider.initiateCall({
          callId: "test-call",
          from: "+15551234567",
          to: "+15559876543",
          webhookUrl: "https://example.com/voice",
        });

        await provider.playTts({
          callId: "test-call",
          providerCallId: "CA123",
          text: "Is 5 < 10 & true?",
        });

        const body = mockFetch.mock.calls[1][1].body;
        const twiml = body.get("Twiml");
        expect(twiml).toContain("5 &lt; 10 &amp; true");
      });

      it("throws when webhook URL not found", async () => {
        const provider = new TwilioProvider(validConfig);

        await expect(
          provider.playTts({
            callId: "test-call",
            providerCallId: "CA-unknown",
            text: "Hello",
          }),
        ).rejects.toThrow("Missing webhook URL");
      });
    });

    describe("OpenAI TTS streaming mode", () => {
      it("uses media stream when TTS provider and handler available", async () => {
        const mockTtsProvider = {
          synthesizeForTwilio: vi.fn().mockResolvedValue(Buffer.alloc(320)), // 2 chunks
        } as unknown as OpenAITTSProvider;

        const mockHandler = {
          sendAudio: vi.fn(),
          sendMark: vi.fn(),
        } as unknown as MediaStreamHandler;

        const provider = new TwilioProvider(validConfig, {
          streamPath: "/voice/stream",
        });
        provider.setTTSProvider(mockTtsProvider);
        provider.setMediaStreamHandler(mockHandler);
        provider.registerCallStream("CA123", "MZ456");

        await provider.playTts({
          callId: "test-call",
          providerCallId: "CA123",
          text: "Hello via OpenAI!",
        });

        expect(mockTtsProvider.synthesizeForTwilio).toHaveBeenCalledWith(
          "Hello via OpenAI!",
        );
        expect(mockHandler.sendAudio).toHaveBeenCalled();
        expect(mockHandler.sendMark).toHaveBeenCalled();
      });

      it("falls back to TwiML when stream not registered", async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          text: () => Promise.resolve(JSON.stringify({ sid: "CA123" })),
        });
        mockFetch.mockResolvedValueOnce({
          ok: true,
          text: () => Promise.resolve(""),
        });

        const mockTtsProvider = {
          synthesizeForTwilio: vi.fn(),
        } as unknown as OpenAITTSProvider;

        const mockHandler = {
          sendAudio: vi.fn(),
          sendMark: vi.fn(),
        } as unknown as MediaStreamHandler;

        const provider = new TwilioProvider(validConfig);
        provider.setTTSProvider(mockTtsProvider);
        provider.setMediaStreamHandler(mockHandler);
        // No stream registered!

        await provider.initiateCall({
          callId: "test-call",
          from: "+15551234567",
          to: "+15559876543",
          webhookUrl: "https://example.com/voice",
        });

        await provider.playTts({
          callId: "test-call",
          providerCallId: "CA123",
          text: "Hello!",
        });

        // Should have fallen back to TwiML
        expect(mockTtsProvider.synthesizeForTwilio).not.toHaveBeenCalled();
        expect(mockFetch).toHaveBeenCalledTimes(2);
      });
    });
  });

  describe("startListening", () => {
    it("sends Gather TwiML", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ sid: "CA123" })),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(""),
      });

      const provider = new TwilioProvider(validConfig);

      await provider.initiateCall({
        callId: "test-call",
        from: "+15551234567",
        to: "+15559876543",
        webhookUrl: "https://example.com/voice",
      });

      await provider.startListening({
        callId: "test-call",
        providerCallId: "CA123",
        language: "es-ES",
      });

      const body = mockFetch.mock.calls[1][1].body;
      const twiml = body.get("Twiml");
      expect(twiml).toContain("<Gather");
      expect(twiml).toContain('input="speech"');
      expect(twiml).toContain('language="es-ES"');
    });
  });

  describe("stopListening", () => {
    it("is a no-op (Gather auto-ends)", async () => {
      const provider = new TwilioProvider(validConfig);

      // Should not throw and not call fetch
      await provider.stopListening({
        callId: "test-call",
        providerCallId: "CA123",
      });

      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe("webhook verification", () => {
    it("verifies webhook with auth token", () => {
      const provider = new TwilioProvider(validConfig);

      // Test that verification is called (actual verification is tested in webhook-security.test.ts)
      const ctx: WebhookContext = {
        headers: {
          "x-twilio-signature": "invalid-signature",
        },
        rawBody: "CallSid=CA123",
        url: "https://example.com/voice",
        method: "POST",
      };

      const result = provider.verifyWebhook(ctx);

      // Without valid signature, should fail
      expect(result.ok).toBe(false);
    });

    it("skips verification when configured", () => {
      const provider = new TwilioProvider(validConfig, {
        skipVerification: true,
      });

      const ctx: WebhookContext = {
        headers: {},
        rawBody: "CallSid=CA123",
        url: "https://example.com/voice",
        method: "POST",
      };

      const result = provider.verifyWebhook(ctx);

      expect(result.ok).toBe(true);
    });
  });
});
