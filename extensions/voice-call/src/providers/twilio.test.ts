import { describe, expect, it, vi } from "vitest";
import type { WebhookContext } from "../types.js";
import { TwilioProvider } from "./twilio.js";
import { TwilioApiError } from "./twilio/api.js";

const STREAM_URL = "wss://example.ngrok.app/voice/stream";

function createProvider(): TwilioProvider {
  return new TwilioProvider(
    { accountSid: "AC123", authToken: "secret" },
    { publicUrl: "https://example.ngrok.app", streamPath: "/voice/stream" },
  );
}

function createContext(rawBody: string, query?: WebhookContext["query"]): WebhookContext {
  return {
    headers: {},
    rawBody,
    url: "https://example.ngrok.app/voice/twilio",
    method: "POST",
    query,
  };
}

function expectStreamingTwiml(body: string) {
  expect(body).toContain(STREAM_URL);
  expect(body).toContain('<Parameter name="token" value="');
  expect(body).toContain("<Connect>");
}

function expectQueueTwiml(body: string) {
  expect(body).toContain("Please hold while we connect you.");
  expect(body).toContain("<Enqueue");
  expect(body).toContain("hold-queue");
}

function requireResponseBody(body: string | undefined): string {
  if (!body) {
    throw new Error("Twilio provider did not return a response body");
  }
  return body;
}

function requireEvent<T>(event: T | undefined, message: string): T {
  if (!event) {
    throw new Error(message);
  }
  return event;
}

type TwilioApiRequest = (
  endpoint: string,
  params: Record<string, string | string[]>,
  options?: { allowNotFound?: boolean },
) => Promise<unknown>;

function createApiRequestMock(impl?: TwilioApiRequest) {
  return vi.fn<TwilioApiRequest>(impl ?? (async () => ({})));
}

function requireApiRequestCall(
  apiRequest: ReturnType<typeof createApiRequestMock>,
  index = 0,
): Parameters<TwilioApiRequest> {
  const call = apiRequest.mock.calls[index];
  if (!call) {
    throw new Error(`expected Twilio API request call ${index}`);
  }
  return call;
}

function expectApiRequestEndpoint(
  apiRequest: ReturnType<typeof createApiRequestMock>,
  index: number,
  endpoint: string,
): void {
  const [actualEndpoint] = requireApiRequestCall(apiRequest, index);
  expect(actualEndpoint).toBe(endpoint);
}

function createTwilioCallStateRaceError(): TwilioApiError {
  return new TwilioApiError(
    400,
    JSON.stringify({
      code: 21220,
      message: "Call is not in-progress. Cannot redirect.",
    }),
  );
}

function configureTelephonyTwiMlFallback(params: { providerCallId: string; streamSid?: string }) {
  const provider = createProvider();
  const apiRequest = createApiRequestMock();
  (
    provider as unknown as {
      apiRequest: TwilioApiRequest;
    }
  ).apiRequest = apiRequest;
  (
    provider as unknown as {
      callWebhookUrls: Map<string, string>;
    }
  ).callWebhookUrls.set(params.providerCallId, "https://example.ngrok.app/voice/twilio");
  if (params.streamSid) {
    provider.registerCallStream(params.providerCallId, params.streamSid);
  }
  return { provider, apiRequest };
}

describe("TwilioProvider", () => {
  it("sends direct initial TwiML for notify-mode outbound calls", async () => {
    const provider = createProvider();
    const apiRequest = createApiRequestMock(async () => ({ sid: "CA123", status: "queued" }));
    (
      provider as unknown as {
        apiRequest: TwilioApiRequest;
      }
    ).apiRequest = apiRequest;

    const result = await provider.initiateCall({
      callId: "call-1",
      from: "+14155550100",
      to: "+14155550123",
      webhookUrl: "https://example.ngrok.app/voice/webhook",
      inlineTwiml: "<Response><Say>Hello</Say></Response>",
    });

    expect(result).toEqual({ providerCallId: "CA123", status: "queued" });
    expect(apiRequest).toHaveBeenCalledTimes(1);
    const [endpoint, params] = requireApiRequestCall(apiRequest);
    expect(endpoint).toBe("/Calls.json");
    expect(params.To).toBe("+14155550123");
    expect(params.From).toBe("+14155550100");
    expect(params.Twiml).toBe("<Response><Say>Hello</Say></Response>");
    expect(params.StatusCallback).toBe(
      "https://example.ngrok.app/voice/webhook?callId=call-1&type=status",
    );
    expect(params.StatusCallbackEvent).toEqual(["initiated", "ringing", "answered", "completed"]);
    expect(params).not.toHaveProperty("Url");
  });

  it("uses the webhook URL for conversation outbound calls", async () => {
    const provider = createProvider();
    const apiRequest = createApiRequestMock(async () => ({ sid: "CA123", status: "queued" }));
    (
      provider as unknown as {
        apiRequest: TwilioApiRequest;
      }
    ).apiRequest = apiRequest;

    await provider.initiateCall({
      callId: "call-1",
      from: "+14155550100",
      to: "+14155550123",
      webhookUrl: "https://example.ngrok.app/voice/webhook",
    });

    expect(apiRequest).toHaveBeenCalledTimes(1);
    const [endpoint, params] = requireApiRequestCall(apiRequest);
    expect(endpoint).toBe("/Calls.json");
    expect(params.Url).toBe("https://example.ngrok.app/voice/webhook?callId=call-1");
    expect(params.StatusCallback).toBe(
      "https://example.ngrok.app/voice/webhook?callId=call-1&type=status",
    );
    expect(params).not.toHaveProperty("Twiml");
  });

  it("returns streaming TwiML for outbound conversation calls before in-progress", () => {
    const provider = createProvider();
    const ctx = createContext("CallStatus=initiated&Direction=outbound-api&CallSid=CA123", {
      callId: "call-1",
    });

    const result = provider.parseWebhookEvent(ctx);

    expectStreamingTwiml(requireResponseBody(result.providerResponseBody));
  });

  it("serves pre-connect TwiML once before outbound streaming starts", async () => {
    const provider = createProvider();
    (
      provider as unknown as {
        apiRequest: TwilioApiRequest;
      }
    ).apiRequest = vi.fn<TwilioApiRequest>(async () => ({
      sid: "CA999",
      status: "queued",
    }));
    const preConnectTwiml = '<Response><Play digits="ww123456#" /></Response>';

    await provider.initiateCall({
      callId: "call-1",
      from: "+15550000001",
      to: "+15550000002",
      webhookUrl: "https://example.ngrok.app/voice/twilio",
      preConnectTwiml,
    });

    const first = provider.parseWebhookEvent(
      createContext("CallStatus=initiated&Direction=outbound-api&CallSid=CA999", {
        callId: "call-1",
      }),
    );
    expect(requireResponseBody(first.providerResponseBody)).toBe(preConnectTwiml);

    const second = provider.parseWebhookEvent(
      createContext("CallStatus=initiated&Direction=outbound-api&CallSid=CA999", {
        callId: "call-1",
      }),
    );
    expectStreamingTwiml(requireResponseBody(second.providerResponseBody));
  });

  it("returns empty TwiML for status callbacks", () => {
    const provider = createProvider();
    const ctx = createContext("CallStatus=ringing&Direction=outbound-api", {
      callId: "call-1",
      type: "status",
    });

    const result = provider.parseWebhookEvent(ctx);

    expect(result.providerResponseBody).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
    );
  });

  it("returns streaming TwiML for inbound calls", () => {
    const provider = createProvider();
    const ctx = createContext("CallStatus=ringing&Direction=inbound&CallSid=CA456");

    const result = provider.parseWebhookEvent(ctx);

    expectStreamingTwiml(requireResponseBody(result.providerResponseBody));
  });

  it("returns queue TwiML for second inbound call when first call is active", () => {
    const provider = createProvider();
    const firstInbound = createContext("CallStatus=ringing&Direction=inbound&CallSid=CA111");
    const secondInbound = createContext("CallStatus=ringing&Direction=inbound&CallSid=CA222");

    const firstResult = provider.parseWebhookEvent(firstInbound);
    const secondResult = provider.parseWebhookEvent(secondInbound);

    expectStreamingTwiml(requireResponseBody(firstResult.providerResponseBody));
    expectQueueTwiml(requireResponseBody(secondResult.providerResponseBody));
  });

  it("connects next inbound call after unregisterCallStream cleanup", () => {
    const provider = createProvider();
    const firstInbound = createContext("CallStatus=ringing&Direction=inbound&CallSid=CA311");
    const secondInbound = createContext("CallStatus=ringing&Direction=inbound&CallSid=CA322");

    provider.parseWebhookEvent(firstInbound);
    provider.unregisterCallStream("CA311");
    const secondResult = provider.parseWebhookEvent(secondInbound);

    const secondBody = requireResponseBody(secondResult.providerResponseBody);
    expectStreamingTwiml(secondBody);
    expect(secondBody).not.toContain("hold-queue");
  });

  it("cleans up active inbound call on completed status callback", () => {
    const provider = createProvider();
    const firstInbound = createContext("CallStatus=ringing&Direction=inbound&CallSid=CA411");
    const completed = createContext("CallStatus=completed&Direction=inbound&CallSid=CA411", {
      type: "status",
    });
    const nextInbound = createContext("CallStatus=ringing&Direction=inbound&CallSid=CA422");

    provider.parseWebhookEvent(firstInbound);
    provider.parseWebhookEvent(completed);
    const nextResult = provider.parseWebhookEvent(nextInbound);

    const nextBody = requireResponseBody(nextResult.providerResponseBody);
    expectStreamingTwiml(nextBody);
    expect(nextBody).not.toContain("hold-queue");
  });

  it("cleans up active inbound call on canceled status callback", () => {
    const provider = createProvider();
    const firstInbound = createContext("CallStatus=ringing&Direction=inbound&CallSid=CA511");
    const canceled = createContext("CallStatus=canceled&Direction=inbound&CallSid=CA511", {
      type: "status",
    });
    const nextInbound = createContext("CallStatus=ringing&Direction=inbound&CallSid=CA522");

    provider.parseWebhookEvent(firstInbound);
    provider.parseWebhookEvent(canceled);
    const nextResult = provider.parseWebhookEvent(nextInbound);

    const nextBody = requireResponseBody(nextResult.providerResponseBody);
    expectStreamingTwiml(nextBody);
    expect(nextBody).not.toContain("hold-queue");
  });

  it("QUEUE_TWIML references /voice/hold-music waitUrl", () => {
    const provider = createProvider();
    const firstInbound = createContext("CallStatus=ringing&Direction=inbound&CallSid=CA611");
    const secondInbound = createContext("CallStatus=ringing&Direction=inbound&CallSid=CA622");

    provider.parseWebhookEvent(firstInbound);
    const result = provider.parseWebhookEvent(secondInbound);

    expect(requireResponseBody(result.providerResponseBody)).toContain(
      'waitUrl="/voice/hold-music"',
    );
  });

  it("uses a stable fallback dedupeKey for identical request payloads", () => {
    const provider = createProvider();
    const rawBody = "CallSid=CA789&Direction=inbound&SpeechResult=hello";
    const ctxA = {
      ...createContext(rawBody, { callId: "call-1", turnToken: "turn-1" }),
      headers: { "i-twilio-idempotency-token": "idem-123" },
    };
    const ctxB = {
      ...createContext(rawBody, { callId: "call-1", turnToken: "turn-1" }),
      headers: { "i-twilio-idempotency-token": "idem-123" },
    };

    const eventA = provider.parseWebhookEvent(ctxA).events[0];
    const eventB = provider.parseWebhookEvent(ctxB).events[0];

    const first = requireEvent(eventA, "expected first fallback Twilio event");
    const second = requireEvent(eventB, "expected second fallback Twilio event");
    expect(first.id).not.toBe(second.id);
    expect(first.dedupeKey).toContain("twilio:fallback:");
    expect(first.dedupeKey).toBe(second.dedupeKey);
  });

  it("uses verified request key for dedupe and ignores idempotency header changes", () => {
    const provider = createProvider();
    const rawBody = "CallSid=CA790&Direction=inbound&SpeechResult=hello";
    const ctxA = {
      ...createContext(rawBody, { callId: "call-1", turnToken: "turn-1" }),
      headers: { "i-twilio-idempotency-token": "idem-a" },
    };
    const ctxB = {
      ...createContext(rawBody, { callId: "call-1", turnToken: "turn-1" }),
      headers: { "i-twilio-idempotency-token": "idem-b" },
    };

    const eventA = provider.parseWebhookEvent(ctxA, { verifiedRequestKey: "twilio:req:abc" })
      .events[0];
    const eventB = provider.parseWebhookEvent(ctxB, { verifiedRequestKey: "twilio:req:abc" })
      .events[0];

    expect(requireEvent(eventA, "expected verified first Twilio event").dedupeKey).toBe(
      "twilio:req:abc",
    );
    expect(requireEvent(eventB, "expected verified second Twilio event").dedupeKey).toBe(
      "twilio:req:abc",
    );
  });

  it("keeps turnToken from query on speech events", () => {
    const provider = createProvider();
    const ctx = createContext("CallSid=CA222&Direction=inbound&SpeechResult=hello", {
      callId: "call-2",
      turnToken: "turn-xyz",
    });

    const event = provider.parseWebhookEvent(ctx).events[0];
    const parsed = requireEvent(event, "expected speech event from Twilio webhook");
    expect(parsed.type).toBe("call.speech");
    expect(parsed.turnToken).toBe("turn-xyz");
  });

  it("fails when an active stream exists but telephony TTS is unavailable", async () => {
    const { provider, apiRequest } = configureTelephonyTwiMlFallback({
      providerCallId: "CA-stream",
      streamSid: "MZ-stream",
    });

    await expect(
      provider.playTts({
        callId: "call-stream",
        providerCallId: "CA-stream",
        text: "Hello stream",
      }),
    ).rejects.toThrow("refusing TwiML fallback");
    expect(apiRequest).not.toHaveBeenCalled();
  });

  it("falls back to TwiML when no active stream exists and telephony TTS is unavailable", async () => {
    const { provider, apiRequest } = configureTelephonyTwiMlFallback({
      providerCallId: "CA-nostream",
    });

    await expect(
      provider.playTts({
        callId: "call-nostream",
        providerCallId: "CA-nostream",
        text: "Hello TwiML",
      }),
    ).resolves.toBeUndefined();
    expect(apiRequest).toHaveBeenCalledTimes(1);
    const [endpoint, params] = requireApiRequestCall(apiRequest) as [string, { Twiml?: string }];
    expect(endpoint).toBe("/Calls/CA-nostream.json");
    expect(params.Twiml).toContain("<Say");
  });

  it("retries TwiML fallback when Twilio briefly rejects a live-call update as not in progress", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { provider, apiRequest } = configureTelephonyTwiMlFallback({
        providerCallId: "CA-race-play",
      });
      apiRequest.mockRejectedValueOnce(createTwilioCallStateRaceError()).mockResolvedValueOnce({});

      const playback = provider.playTts({
        callId: "call-race-play",
        providerCallId: "CA-race-play",
        text: "Hello after race",
      });
      await Promise.resolve();
      expect(apiRequest).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(250);
      await expect(playback).resolves.toBeUndefined();

      expect(apiRequest).toHaveBeenCalledTimes(2);
      expectApiRequestEndpoint(apiRequest, 0, "/Calls/CA-race-play.json");
      expectApiRequestEndpoint(apiRequest, 1, "/Calls/CA-race-play.json");
      expect(warn).toHaveBeenCalledWith(
        "[voice-call] Twilio playTts update hit call state race (21220); retrying in 250ms",
      );
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("sends DTMF by updating the call and redirecting back to the webhook", async () => {
    const { provider, apiRequest } = configureTelephonyTwiMlFallback({
      providerCallId: "CA-dtmf",
    });

    await expect(
      provider.sendDtmf({
        callId: "call-dtmf",
        providerCallId: "CA-dtmf",
        digits: "ww123#",
      }),
    ).resolves.toBeUndefined();

    expect(apiRequest).toHaveBeenCalledTimes(1);
    const [endpoint, params] = requireApiRequestCall(apiRequest) as [string, { Twiml?: string }];
    expect(endpoint).toBe("/Calls/CA-dtmf.json");
    expect(params.Twiml).toContain('<Play digits="ww123#"');
    expect(params.Twiml).toContain("<Redirect");
    expect(params.Twiml).toContain("https://example.ngrok.app/voice/twilio");
  });

  it("retries startListening when Twilio briefly rejects a live-call update as not in progress", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { provider, apiRequest } = configureTelephonyTwiMlFallback({
        providerCallId: "CA-race-listen",
      });
      apiRequest.mockRejectedValueOnce(createTwilioCallStateRaceError()).mockResolvedValueOnce({});

      const listening = provider.startListening({
        callId: "call-race-listen",
        providerCallId: "CA-race-listen",
      });
      await Promise.resolve();
      expect(apiRequest).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(250);
      await expect(listening).resolves.toBeUndefined();

      expect(apiRequest).toHaveBeenCalledTimes(2);
      expectApiRequestEndpoint(apiRequest, 0, "/Calls/CA-race-listen.json");
      expectApiRequestEndpoint(apiRequest, 1, "/Calls/CA-race-listen.json");
      expect(warn).toHaveBeenCalledWith(
        "[voice-call] Twilio startListening update hit call state race (21220); retrying in 250ms",
      );
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("ignores stale stream unregister requests that do not match current stream SID", () => {
    const provider = createProvider();
    provider.registerCallStream("CA-reconnect", "MZ-new");

    provider.unregisterCallStream("CA-reconnect", "MZ-old");
    expect(provider.hasRegisteredStream("CA-reconnect")).toBe(true);

    provider.unregisterCallStream("CA-reconnect", "MZ-new");
    expect(provider.hasRegisteredStream("CA-reconnect")).toBe(false);
  });

  it("times out telephony synthesis in stream mode and does not send completion mark", async () => {
    vi.useFakeTimers();
    try {
      const provider = createProvider();
      provider.registerCallStream("CA-timeout", "MZ-timeout");

      const sendAudio = vi.fn();
      const sendMark = vi.fn();
      const mediaStreamHandler = {
        queueTts: async (
          _streamSid: string,
          playFn: (signal: AbortSignal) => Promise<void>,
        ): Promise<void> => {
          await playFn(new AbortController().signal);
        },
        sendAudio,
        sendMark,
      };

      provider.setMediaStreamHandler(mediaStreamHandler as never);
      provider.setTTSProvider({
        synthesisTimeoutMs: 5000,
        synthesizeForTelephony: async () => await new Promise<Buffer>(() => {}),
      });

      const playExpectation = expect(
        provider.playTts({
          callId: "call-timeout",
          providerCallId: "CA-timeout",
          text: "Timeout me",
        }),
      ).rejects.toThrow("Telephony TTS synthesis timed out after 5000ms");
      await vi.advanceTimersByTimeAsync(5_100);
      await playExpectation;
      expect(sendAudio).toHaveBeenCalled();
      expect(sendMark).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails stream playback when all audio sends and completion mark are dropped", async () => {
    const provider = createProvider();
    provider.registerCallStream("CA-dropped", "MZ-dropped");

    const sendAudio = vi.fn(() => ({ sent: false }));
    const sendMark = vi.fn(() => ({ sent: false }));
    const mediaStreamHandler = {
      queueTts: async (
        _streamSid: string,
        playFn: (signal: AbortSignal) => Promise<void>,
      ): Promise<void> => {
        await playFn(new AbortController().signal);
      },
      sendAudio,
      sendMark,
    };

    provider.setMediaStreamHandler(mediaStreamHandler as never);
    provider.setTTSProvider({
      synthesisTimeoutMs: 5000,
      synthesizeForTelephony: async () => Buffer.alloc(320),
    });

    await expect(
      provider.playTts({
        callId: "call-dropped",
        providerCallId: "CA-dropped",
        text: "Dropped audio",
      }),
    ).rejects.toThrow("Telephony stream playback failed");
    expect(sendAudio).toHaveBeenCalled();
    expect(sendMark).toHaveBeenCalledTimes(1);
  });

  it("fails stream playback when telephony synthesis returns empty audio", async () => {
    const provider = createProvider();
    provider.registerCallStream("CA-empty", "MZ-empty");

    const sendAudio = vi.fn();
    const sendMark = vi.fn();
    const mediaStreamHandler = {
      queueTts: async (
        _streamSid: string,
        playFn: (signal: AbortSignal) => Promise<void>,
      ): Promise<void> => {
        await playFn(new AbortController().signal);
      },
      sendAudio,
      sendMark,
    };

    provider.setMediaStreamHandler(mediaStreamHandler as never);
    provider.setTTSProvider({
      synthesisTimeoutMs: 5000,
      synthesizeForTelephony: async () => Buffer.alloc(0),
    });

    await expect(
      provider.playTts({
        callId: "call-empty",
        providerCallId: "CA-empty",
        text: "Empty audio",
      }),
    ).rejects.toThrow("Telephony TTS produced no audio");
    expect(sendAudio).toHaveBeenCalled();
    expect(sendMark).not.toHaveBeenCalled();
  });
});
