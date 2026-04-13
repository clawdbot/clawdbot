import { request } from "node:http";
import type { RealtimeTranscriptionProviderPlugin } from "openclaw/plugin-sdk/realtime-transcription";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceCallConfigSchema, type VoiceCallConfig } from "./config.js";
import type { CallManager } from "./manager.js";
import type { VoiceCallProvider } from "./providers/base.js";
import type { TwilioProvider } from "./providers/twilio.js";
import type { CallRecord, NormalizedEvent } from "./types.js";
import { VoiceCallWebhookServer } from "./webhook.js";
import type { RealtimeCallHandler } from "./webhook/realtime-handler.js";

const mocks = vi.hoisted(() => {
  const realtimeTranscriptionProvider: RealtimeTranscriptionProviderPlugin = {
    id: "openai",
    label: "OpenAI",
    aliases: ["openai-realtime"],
    isConfigured: () => true,
    resolveConfig: ({ rawConfig }) => rawConfig,
    createSession: () => ({
      connect: async () => {},
      sendAudio: () => {},
      close: () => {},
      isConnected: () => true,
    }),
  };

  return {
    getRealtimeTranscriptionProvider: vi.fn<(...args: unknown[]) => unknown>(
      () => realtimeTranscriptionProvider,
    ),
    listRealtimeTranscriptionProviders: vi.fn(() => [realtimeTranscriptionProvider]),
  };
});

vi.mock("./realtime-transcription.runtime.js", () => ({
  getRealtimeTranscriptionProvider: mocks.getRealtimeTranscriptionProvider,
  listRealtimeTranscriptionProviders: mocks.listRealtimeTranscriptionProviders,
}));

const provider: VoiceCallProvider = {
  name: "mock",
  verifyWebhook: () => ({ ok: true, verifiedRequestKey: "mock:req:base" }),
  parseWebhookEvent: () => ({ events: [] }),
  initiateCall: async () => ({ providerCallId: "provider-call", status: "initiated" }),
  hangupCall: async () => {},
  playTts: async () => {},
  startListening: async () => {},
  stopListening: async () => {},
  getCallStatus: async () => ({ status: "in-progress", isTerminal: false }),
};

type TwilioProviderTestDouble = VoiceCallProvider &
  Pick<
    TwilioProvider,
    | "isValidStreamToken"
    | "registerCallStream"
    | "unregisterCallStream"
    | "hasRegisteredStream"
    | "clearTtsQueue"
  >;

const createConfig = (overrides: Partial<VoiceCallConfig> = {}): VoiceCallConfig => {
  const base = VoiceCallConfigSchema.parse({});
  base.serve.port = 0;

  return {
    ...base,
    ...overrides,
    serve: {
      ...base.serve,
      ...overrides.serve,
    },
  };
};

const createCall = (startedAt: number): CallRecord => ({
  callId: "call-1",
  providerCallId: "provider-call-1",
  provider: "mock",
  direction: "outbound",
  state: "initiated",
  from: "+15550001234",
  to: "+15550005678",
  startedAt,
  transcript: [],
  processedEventIds: [],
});

const createManager = (calls: CallRecord[]) => {
  const endCall = vi.fn(async () => ({ success: true }));
  const processEvent = vi.fn();
  const manager = {
    getActiveCalls: () => calls,
    endCall,
    processEvent,
  } as unknown as CallManager;

  return { manager, endCall, processEvent };
};

function hasPort(value: unknown): value is { port: number | string } {
  if (!value || typeof value !== "object") {
    return false;
  }
  const maybeAddress = value as { port?: unknown };
  return typeof maybeAddress.port === "number" || typeof maybeAddress.port === "string";
}

function requireBoundRequestUrl(server: VoiceCallWebhookServer, baseUrl: string) {
  const address = (
    server as unknown as { server?: { address?: () => unknown } }
  ).server?.address?.();
  if (!hasPort(address) || !address.port) {
    throw new Error("voice webhook server did not expose a bound port");
  }
  const requestUrl = new URL(baseUrl);
  requestUrl.port = String(address.port);
  return requestUrl;
}

function expectWebhookUrl(url: string, expectedPath: string) {
  const parsed = new URL(url);
  expect(parsed.pathname).toBe(expectedPath);
  expect(parsed.port).not.toBe("");
  expect(parsed.port).not.toBe("0");
}

function createTwilioVerificationProvider(
  overrides: Partial<TwilioProviderTestDouble> = {},
): VoiceCallProvider {
  return {
    ...provider,
    name: "twilio",
    verifyWebhook: () => ({ ok: true, verifiedRequestKey: "twilio:req:test" }),
    ...overrides,
  };
}

function createTwilioStreamingProvider(
  overrides: Partial<TwilioProviderTestDouble> = {},
): TwilioProviderTestDouble {
  return {
    ...createTwilioVerificationProvider({
      parseWebhookEvent: () => ({ events: [] }),
      initiateCall: async () => ({ providerCallId: "provider-call", status: "initiated" as const }),
      hangupCall: async () => {},
      playTts: async () => {},
      startListening: async () => {},
      stopListening: async () => {},
      getCallStatus: async () => ({ status: "in-progress", isTerminal: false }),
    }),
    isValidStreamToken: () => true,
    registerCallStream: () => {},
    unregisterCallStream: () => {},
    hasRegisteredStream: () => true,
    clearTtsQueue: () => {},
    ...overrides,
  };
}

describe("VoiceCallWebhookServer realtime transcription provider selection", () => {
  it("auto-selects the first registered provider when streaming.provider is unset", async () => {
    const { manager } = createManager([]);
    const config = createConfig({
      streaming: {
        ...createConfig().streaming,
        enabled: true,
        providers: {
          openai: {
            apiKey: "sk-test", // pragma: allowlist secret
          },
        },
      },
    });
    const autoSelectedProvider: RealtimeTranscriptionProviderPlugin = {
      id: "openai",
      label: "OpenAI",
      autoSelectOrder: 5,
      isConfigured: () => true,
      resolveConfig: ({ rawConfig }) => rawConfig,
      createSession: () => ({
        connect: async () => {},
        sendAudio: () => {},
        close: () => {},
        isConnected: () => true,
      }),
    };
    mocks.getRealtimeTranscriptionProvider.mockReturnValueOnce(undefined);
    mocks.listRealtimeTranscriptionProviders.mockReturnValueOnce([autoSelectedProvider]);

    const server = new VoiceCallWebhookServer(config, manager, provider);
    try {
      await server.start();
      expect(mocks.getRealtimeTranscriptionProvider).toHaveBeenCalledWith(undefined, null);
      expect(mocks.listRealtimeTranscriptionProviders).toHaveBeenCalledWith(null);
      expect(server.getMediaStreamHandler()).toBeTruthy();
    } finally {
      await server.stop();
    }
  });
});

async function runStaleCallReaperCase(params: {
  callAgeMs: number;
  staleCallReaperSeconds: number;
  advanceMs: number;
}) {
  const now = new Date("2026-02-16T00:00:00Z");
  vi.setSystemTime(now);

  const call = createCall(now.getTime() - params.callAgeMs);
  const { manager, endCall } = createManager([call]);
  const config = createConfig({ staleCallReaperSeconds: params.staleCallReaperSeconds });
  const server = new VoiceCallWebhookServer(config, manager, provider);

  try {
    await server.start();
    await vi.advanceTimersByTimeAsync(params.advanceMs);
    return { call, endCall };
  } finally {
    await server.stop();
  }
}

async function postWebhookForm(server: VoiceCallWebhookServer, baseUrl: string, body: string) {
  const requestUrl = requireBoundRequestUrl(server, baseUrl);
  return await fetch(requestUrl.toString(), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
}

async function postWebhookFormWithHeaders(
  server: VoiceCallWebhookServer,
  baseUrl: string,
  body: string,
  headers: Record<string, string>,
) {
  const requestUrl = requireBoundRequestUrl(server, baseUrl);
  return await fetch(requestUrl.toString(), {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...headers,
    },
    body,
  });
}

async function postWebhookFormWithHeadersResult(
  server: VoiceCallWebhookServer,
  baseUrl: string,
  body: string,
  headers: Record<string, string>,
): Promise<
  | { kind: "response"; statusCode: number; body: string }
  | { kind: "error"; code: string | undefined }
> {
  const requestUrl = requireBoundRequestUrl(server, baseUrl);
  return await new Promise((resolve) => {
    const req = request(
      {
        hostname: requestUrl.hostname,
        port: requestUrl.port,
        path: requestUrl.pathname + requestUrl.search,
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          ...headers,
        },
      },
      (res) => {
        res.setEncoding("utf8");
        let responseBody = "";
        res.on("data", (chunk) => {
          responseBody += chunk;
        });
        res.on("end", () => {
          resolve({
            kind: "response",
            statusCode: res.statusCode ?? 0,
            body: responseBody,
          });
        });
      },
    );
    req.on("error", (error: NodeJS.ErrnoException) => {
      resolve({ kind: "error", code: error.code });
    });
    req.end(body);
  });
}

describe("VoiceCallWebhookServer stale call reaper", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("ends calls older than staleCallReaperSeconds", async () => {
    const { call, endCall } = await runStaleCallReaperCase({
      callAgeMs: 120_000,
      staleCallReaperSeconds: 60,
      advanceMs: 30_000,
    });
    expect(endCall).toHaveBeenCalledWith(call.callId);
  });

  it("skips calls that are younger than the threshold", async () => {
    const { endCall } = await runStaleCallReaperCase({
      callAgeMs: 10_000,
      staleCallReaperSeconds: 60,
      advanceMs: 30_000,
    });
    expect(endCall).not.toHaveBeenCalled();
  });

  it("does not run when staleCallReaperSeconds is disabled", async () => {
    const now = new Date("2026-02-16T00:00:00Z");
    vi.setSystemTime(now);

    const call = createCall(now.getTime() - 120_000);
    const { manager, endCall } = createManager([call]);
    const config = createConfig({ staleCallReaperSeconds: 0 });
    const server = new VoiceCallWebhookServer(config, manager, provider);

    try {
      await server.start();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(endCall).not.toHaveBeenCalled();
    } finally {
      await server.stop();
    }
  });
});

describe("VoiceCallWebhookServer path matching", () => {
  it("rejects lookalike webhook paths that only match by prefix", async () => {
    const verifyWebhook = vi.fn(() => ({ ok: true, verifiedRequestKey: "verified:req:prefix" }));
    const parseWebhookEvent = vi.fn(() => ({ events: [], statusCode: 200 }));
    const strictProvider: VoiceCallProvider = {
      ...provider,
      verifyWebhook,
      parseWebhookEvent,
    };
    const { manager } = createManager([]);
    const config = createConfig({ serve: { port: 0, bind: "127.0.0.1", path: "/voice/webhook" } });
    const server = new VoiceCallWebhookServer(config, manager, strictProvider);

    try {
      const baseUrl = await server.start();
      const requestUrl = requireBoundRequestUrl(server, baseUrl);
      requestUrl.pathname = "/voice/webhook-evil";

      const response = await fetch(requestUrl.toString(), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "CallSid=CA123&SpeechResult=hello",
      });

      expect(response.status).toBe(404);
      expect(verifyWebhook).not.toHaveBeenCalled();
      expect(parseWebhookEvent).not.toHaveBeenCalled();
    } finally {
      await server.stop();
    }
  });
});

describe("VoiceCallWebhookServer replay handling", () => {
  it("acknowledges replayed webhook requests and skips event side effects", async () => {
    const replayProvider: VoiceCallProvider = {
      ...provider,
      verifyWebhook: () => ({ ok: true, isReplay: true, verifiedRequestKey: "mock:req:replay" }),
      parseWebhookEvent: () => ({
        events: [
          {
            id: "evt-replay",
            dedupeKey: "stable-replay",
            type: "call.speech",
            callId: "call-1",
            providerCallId: "provider-call-1",
            timestamp: Date.now(),
            transcript: "hello",
            isFinal: true,
          },
        ],
        statusCode: 200,
      }),
    };
    const { manager, processEvent } = createManager([]);
    const config = createConfig({ serve: { port: 0, bind: "127.0.0.1", path: "/voice/webhook" } });
    const server = new VoiceCallWebhookServer(config, manager, replayProvider);

    try {
      const baseUrl = await server.start();
      const response = await postWebhookForm(server, baseUrl, "CallSid=CA123&SpeechResult=hello");

      expect(response.status).toBe(200);
      expect(processEvent).not.toHaveBeenCalled();
    } finally {
      await server.stop();
    }
  });

  it("returns realtime TwiML for replayed inbound twilio webhooks", async () => {
    const parseWebhookEvent = vi.fn(() => ({ events: [], statusCode: 200 }));
    const twilioProvider: VoiceCallProvider = {
      ...provider,
      name: "twilio",
      verifyWebhook: () => ({ ok: true, isReplay: true, verifiedRequestKey: "twilio:req:replay" }),
      parseWebhookEvent,
    };
    const { manager, processEvent } = createManager([]);
    const config = createConfig({
      provider: "twilio",
      inboundPolicy: "allowlist",
      realtime: {
        enabled: true,
        streamPath: "/voice/stream/realtime",
        tools: [],
        providers: {},
      },
    });
    const server = new VoiceCallWebhookServer(config, manager, twilioProvider);
    server.setRealtimeHandler({
      buildTwiMLPayload: () => ({
        statusCode: 200,
        headers: { "Content-Type": "text/xml" },
        body: '<Response><Connect><Stream url="wss://example.test/voice/stream/realtime/token" /></Connect></Response>',
      }),
      getStreamPathPattern: () => "/voice/stream/realtime",
      handleWebSocketUpgrade: () => {},
      registerToolHandler: () => {},
      setPublicUrl: () => {},
    } as unknown as RealtimeCallHandler);

    try {
      const baseUrl = await server.start();
      const response = await postWebhookFormWithHeaders(
        server,
        baseUrl,
        "CallSid=CA123&Direction=inbound&CallStatus=ringing",
        { "x-twilio-signature": "sig" },
      );

      expect(response.status).toBe(200);
      expect(await response.text()).toContain("<Connect><Stream");
      expect(parseWebhookEvent).not.toHaveBeenCalled();
      expect(processEvent).not.toHaveBeenCalled();
    } finally {
      await server.stop();
    }
  });

  it("passes verified request key from verifyWebhook into parseWebhookEvent", async () => {
    const parseWebhookEvent = vi.fn((_ctx: unknown, options?: { verifiedRequestKey?: string }) => ({
      events: [
        {
          id: "evt-verified",
          dedupeKey: options?.verifiedRequestKey,
          type: "call.speech" as const,
          callId: "call-1",
          providerCallId: "provider-call-1",
          timestamp: Date.now(),
          transcript: "hello",
          isFinal: true,
        },
      ],
      statusCode: 200,
    }));
    const verifiedProvider: VoiceCallProvider = {
      ...provider,
      verifyWebhook: () => ({ ok: true, verifiedRequestKey: "verified:req:123" }),
      parseWebhookEvent,
    };
    const { manager, processEvent } = createManager([]);
    const config = createConfig({ serve: { port: 0, bind: "127.0.0.1", path: "/voice/webhook" } });
    const server = new VoiceCallWebhookServer(config, manager, verifiedProvider);

    try {
      const baseUrl = await server.start();
      const response = await postWebhookForm(server, baseUrl, "CallSid=CA123&SpeechResult=hello");

      expect(response.status).toBe(200);
      expect(parseWebhookEvent).toHaveBeenCalledTimes(1);
      const parseOptions = parseWebhookEvent.mock.calls[0]?.[1];
      if (!parseOptions) {
        throw new Error("webhook server did not pass verified parse options");
      }
      expect(parseOptions).toEqual({
        verifiedRequestKey: "verified:req:123",
      });
      expect(processEvent).toHaveBeenCalledTimes(1);
      const firstEvent = processEvent.mock.calls[0]?.[0];
      if (!firstEvent) {
        throw new Error("webhook server did not forward the parsed event");
      }
      expect(firstEvent.dedupeKey).toBe("verified:req:123");
    } finally {
      await server.stop();
    }
  });

  it("rejects requests when verification succeeds without a request key", async () => {
    const parseWebhookEvent = vi.fn(() => ({ events: [], statusCode: 200 }));
    const badProvider: VoiceCallProvider = {
      ...provider,
      verifyWebhook: () => ({ ok: true }),
      parseWebhookEvent,
    };
    const { manager } = createManager([]);
    const config = createConfig({ serve: { port: 0, bind: "127.0.0.1", path: "/voice/webhook" } });
    const server = new VoiceCallWebhookServer(config, manager, badProvider);

    try {
      const baseUrl = await server.start();
      const response = await postWebhookForm(server, baseUrl, "CallSid=CA123&SpeechResult=hello");

      expect(response.status).toBe(401);
      expect(parseWebhookEvent).not.toHaveBeenCalled();
    } finally {
      await server.stop();
    }
  });
});

describe("VoiceCallWebhookServer pre-auth webhook guards", () => {
  it("rejects missing signature headers before reading the request body", async () => {
    const verifyWebhook = vi.fn(() => ({ ok: true, verifiedRequestKey: "twilio:req:test" }));
    const twilioProvider = createTwilioVerificationProvider({ verifyWebhook });
    const { manager } = createManager([]);
    const config = createConfig({ provider: "twilio" });
    const server = new VoiceCallWebhookServer(config, manager, twilioProvider);
    const readBodySpy = vi.spyOn(
      server as unknown as {
        readBody: (req: unknown, maxBytes: number, timeoutMs?: number) => Promise<string>;
      },
      "readBody",
    );

    try {
      const baseUrl = await server.start();
      const response = await postWebhookForm(server, baseUrl, "CallSid=CA123&SpeechResult=hello");

      expect(response.status).toBe(401);
      expect(await response.text()).toBe("Unauthorized");
      expect(readBodySpy).not.toHaveBeenCalled();
      expect(verifyWebhook).not.toHaveBeenCalled();
    } finally {
      readBodySpy.mockRestore();
      await server.stop();
    }
  });

  it("uses the shared pre-auth body cap before verification", async () => {
    const verifyWebhook = vi.fn(() => ({ ok: true, verifiedRequestKey: "twilio:req:test" }));
    const twilioProvider = createTwilioVerificationProvider({ verifyWebhook });
    const { manager } = createManager([]);
    const config = createConfig({ provider: "twilio" });
    const server = new VoiceCallWebhookServer(config, manager, twilioProvider);

    try {
      const baseUrl = await server.start();
      const responseOrError = await postWebhookFormWithHeadersResult(
        server,
        baseUrl,
        "CallSid=CA123&SpeechResult=".padEnd(70 * 1024, "a"),
        { "x-twilio-signature": "sig" },
      );

      if (responseOrError.kind === "response") {
        expect(responseOrError.statusCode).toBe(413);
        expect(responseOrError.body).toBe("Payload Too Large");
      } else {
        expect(responseOrError.code).toBeOneOf(["ECONNRESET", "EPIPE"]);
      }
      expect(verifyWebhook).not.toHaveBeenCalled();
    } finally {
      await server.stop();
    }
  });

  it("limits concurrent pre-auth requests per source IP", async () => {
    const twilioProvider: VoiceCallProvider = {
      ...provider,
      name: "twilio",
      verifyWebhook: () => ({ ok: true, verifiedRequestKey: "twilio:req:test" }),
    };
    const { manager } = createManager([]);
    const config = createConfig({ provider: "twilio" });
    const server = new VoiceCallWebhookServer(config, manager, twilioProvider);

    let enteredReads = 0;
    let releaseReads!: () => void;
    let unblockReadBodies!: () => void;
    const enteredEightReads = new Promise<void>((resolve) => {
      releaseReads = resolve;
    });
    const unblockReads = new Promise<void>((resolve) => {
      unblockReadBodies = resolve;
    });
    const readBodySpy = vi.spyOn(
      server as unknown as {
        readBody: (req: unknown, maxBytes: number, timeoutMs?: number) => Promise<string>;
      },
      "readBody",
    );
    readBodySpy.mockImplementation(async () => {
      enteredReads += 1;
      if (enteredReads === 8) {
        releaseReads();
      }
      await unblockReads;
      return "CallSid=CA123&SpeechResult=hello";
    });

    try {
      const baseUrl = await server.start();
      const headers = { "x-twilio-signature": "sig" };
      const inFlightRequests = Array.from({ length: 8 }, () =>
        postWebhookFormWithHeaders(server, baseUrl, "CallSid=CA123", headers),
      );
      await enteredEightReads;

      const rejected = await postWebhookFormWithHeaders(server, baseUrl, "CallSid=CA999", headers);
      expect(rejected.status).toBe(429);
      expect(await rejected.text()).toBe("Too Many Requests");

      unblockReadBodies();

      const settled = await Promise.all(inFlightRequests);
      expect(settled.every((response) => response.status === 200)).toBe(true);
    } finally {
      unblockReadBodies();
      readBodySpy.mockRestore();
      await server.stop();
    }
  });
});

describe("VoiceCallWebhookServer response normalization", () => {
  it("preserves explicit empty provider response bodies", async () => {
    const responseProvider: VoiceCallProvider = {
      ...provider,
      parseWebhookEvent: () => ({
        events: [],
        statusCode: 204,
        providerResponseBody: "",
      }),
    };
    const { manager } = createManager([]);
    const config = createConfig({ serve: { port: 0, bind: "127.0.0.1", path: "/voice/webhook" } });
    const server = new VoiceCallWebhookServer(config, manager, responseProvider);

    try {
      const baseUrl = await server.start();
      const response = await postWebhookForm(server, baseUrl, "CallSid=CA123&SpeechResult=hello");

      expect(response.status).toBe(204);
      expect(await response.text()).toBe("");
    } finally {
      await server.stop();
    }
  });
});

describe("VoiceCallWebhookServer start idempotency", () => {
  it("returns existing URL when start() is called twice without stop()", async () => {
    const { manager } = createManager([]);
    const config = createConfig({ serve: { port: 0, bind: "127.0.0.1", path: "/voice/webhook" } });
    const server = new VoiceCallWebhookServer(config, manager, provider);

    try {
      const firstUrl = await server.start();
      // Second call should return immediately without EADDRINUSE
      const secondUrl = await server.start();

      // Dynamic port allocations should resolve to a real listening port.
      expectWebhookUrl(firstUrl, "/voice/webhook");
      // Idempotent re-start should return the same already-bound URL.
      expect(secondUrl).toBe(firstUrl);
      expectWebhookUrl(secondUrl, "/voice/webhook");
    } finally {
      await server.stop();
    }
  });

  it("can start again after stop()", async () => {
    const { manager } = createManager([]);
    const config = createConfig({ serve: { port: 0, bind: "127.0.0.1", path: "/voice/webhook" } });
    const server = new VoiceCallWebhookServer(config, manager, provider);

    const firstUrl = await server.start();
    expectWebhookUrl(firstUrl, "/voice/webhook");
    await server.stop();

    // After stopping, a new start should succeed
    const secondUrl = await server.start();
    expectWebhookUrl(secondUrl, "/voice/webhook");
    await server.stop();
  });

  it("stop() is safe to call when server was never started", async () => {
    const { manager } = createManager([]);
    const config = createConfig();
    const server = new VoiceCallWebhookServer(config, manager, provider);

    // Should not throw
    await server.stop();
  });
});

describe("VoiceCallWebhookServer stream disconnect grace", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("ignores stale stream disconnects after reconnect and only hangs up on current stream disconnect", async () => {
    const call = createCall(Date.now() - 1_000);
    call.providerCallId = "CA-stream-1";

    const endCall = vi.fn(async () => ({ success: true }));
    const speakInitialMessage = vi.fn(async () => {});
    const getCallByProviderCallId = vi.fn((providerCallId: string) =>
      providerCallId === "CA-stream-1" ? call : undefined,
    );

    const manager = {
      getActiveCalls: () => [call],
      getCallByProviderCallId,
      endCall,
      speakInitialMessage,
      processEvent: vi.fn(),
    } as unknown as CallManager;

    let currentStreamSid: string | null = "MZ-new";
    const twilioProvider = createTwilioStreamingProvider({
      registerCallStream: (_callSid: string, streamSid: string) => {
        currentStreamSid = streamSid;
      },
      unregisterCallStream: (_callSid: string, streamSid?: string) => {
        if (!currentStreamSid) {
          return;
        }
        if (streamSid && currentStreamSid !== streamSid) {
          return;
        }
        currentStreamSid = null;
      },
      hasRegisteredStream: () => currentStreamSid !== null,
    });

    const config = createConfig({
      provider: "twilio",
      streaming: {
        ...createConfig().streaming,
        enabled: true,
        providers: {
          openai: {
            apiKey: "test-key", // pragma: allowlist secret
          },
        },
      },
    });
    const server = new VoiceCallWebhookServer(config, manager, twilioProvider);
    await server.start();

    const mediaHandler = server.getMediaStreamHandler() as unknown as {
      config: {
        onDisconnect?: (providerCallId: string, streamSid: string) => void;
        onConnect?: (providerCallId: string, streamSid: string) => void;
      };
    };
    if (!mediaHandler) {
      throw new Error("expected webhook server to expose a media stream handler");
    }

    mediaHandler.config.onConnect?.("CA-stream-1", "MZ-new");
    mediaHandler.config.onDisconnect?.("CA-stream-1", "MZ-old");
    await vi.advanceTimersByTimeAsync(2_100);
    expect(endCall).not.toHaveBeenCalled();

    mediaHandler.config.onDisconnect?.("CA-stream-1", "MZ-new");
    await vi.advanceTimersByTimeAsync(2_100);
    expect(endCall).toHaveBeenCalledTimes(1);
    expect(endCall).toHaveBeenCalledWith(call.callId);

    await server.stop();
  });
});

describe("VoiceCallWebhookServer barge-in suppression during initial message", () => {
  const createTwilioProvider = (
    clearTtsQueue: ReturnType<typeof vi.fn<TwilioProviderTestDouble["clearTtsQueue"]>>,
  ) =>
    createTwilioStreamingProvider({
      clearTtsQueue,
    });

  const getMediaCallbacks = (server: VoiceCallWebhookServer) =>
    server.getMediaStreamHandler() as unknown as {
      config: {
        onSpeechStart?: (providerCallId: string) => void;
        onTranscript?: (providerCallId: string, transcript: string) => void;
      };
    };

  it("suppresses barge-in clear while outbound conversation initial message is pending", async () => {
    const call = createCall(Date.now() - 1_000);
    call.callId = "call-barge";
    call.providerCallId = "CA-barge";
    call.direction = "outbound";
    call.state = "speaking";
    call.metadata = {
      mode: "conversation",
      initialMessage: "Hi, this is OpenClaw.",
    };

    const clearTtsQueue = vi.fn<TwilioProviderTestDouble["clearTtsQueue"]>();
    const processEvent = vi.fn((event: NormalizedEvent) => {
      if (event.type === "call.speech") {
        // Mirrors manager behavior: call.speech transitions to listening.
        call.state = "listening";
      }
    });
    const manager = {
      getActiveCalls: () => [call],
      getCallByProviderCallId: (providerCallId: string) =>
        providerCallId === call.providerCallId ? call : undefined,
      getCall: (callId: string) => (callId === call.callId ? call : undefined),
      endCall: vi.fn(async () => ({ success: true })),
      speakInitialMessage: vi.fn(async () => {}),
      processEvent,
    } as unknown as CallManager;

    const config = createConfig({
      provider: "twilio",
      streaming: {
        ...createConfig().streaming,
        enabled: true,
        providers: {
          openai: {
            apiKey: "test-key", // pragma: allowlist secret
          },
        },
      },
    });
    const server = new VoiceCallWebhookServer(config, manager, createTwilioProvider(clearTtsQueue));
    await server.start();
    const handleInboundResponse = vi.fn(async () => {});
    (
      server as unknown as {
        handleInboundResponse: (
          callId: string,
          transcript: string,
          timing?: unknown,
        ) => Promise<void>;
      }
    ).handleInboundResponse = handleInboundResponse;

    try {
      const media = getMediaCallbacks(server);
      media.config.onSpeechStart?.("CA-barge");
      media.config.onTranscript?.("CA-barge", "hello");
      media.config.onSpeechStart?.("CA-barge");
      media.config.onTranscript?.("CA-barge", "hello again");
      expect(clearTtsQueue).not.toHaveBeenCalled();
      expect(handleInboundResponse).not.toHaveBeenCalled();
      expect(processEvent).not.toHaveBeenCalled();

      if (call.metadata) {
        delete call.metadata.initialMessage;
      }
      call.state = "listening";

      media.config.onSpeechStart?.("CA-barge");
      media.config.onTranscript?.("CA-barge", "hello after greeting");
      expect(clearTtsQueue).toHaveBeenCalledTimes(2);
      expect(handleInboundResponse).toHaveBeenCalledTimes(1);
      expect(processEvent).toHaveBeenCalledTimes(1);
      const [calledCallId, calledTranscript] = (handleInboundResponse.mock.calls[0] ??
        []) as unknown as [string | undefined, string | undefined];
      expect(calledCallId).toBe(call.callId);
      expect(calledTranscript).toBe("hello after greeting");
    } finally {
      await server.stop();
    }
  });

  it("keeps barge-in clear enabled for inbound calls", async () => {
    const call = createCall(Date.now() - 1_000);
    call.callId = "call-inbound";
    call.providerCallId = "CA-inbound";
    call.direction = "inbound";
    call.metadata = {
      initialMessage: "Hello from inbound greeting.",
    };

    const clearTtsQueue = vi.fn<TwilioProviderTestDouble["clearTtsQueue"]>();
    const manager = {
      getActiveCalls: () => [call],
      getCallByProviderCallId: (providerCallId: string) =>
        providerCallId === call.providerCallId ? call : undefined,
      getCall: (callId: string) => (callId === call.callId ? call : undefined),
      endCall: vi.fn(async () => ({ success: true })),
      speakInitialMessage: vi.fn(async () => {}),
      processEvent: vi.fn(),
    } as unknown as CallManager;

    const config = createConfig({
      provider: "twilio",
      streaming: {
        ...createConfig().streaming,
        enabled: true,
        providers: {
          openai: {
            apiKey: "test-key", // pragma: allowlist secret
          },
        },
      },
    });
    const server = new VoiceCallWebhookServer(config, manager, createTwilioProvider(clearTtsQueue));
    await server.start();

    try {
      const media = getMediaCallbacks(server);
      media.config.onSpeechStart?.("CA-inbound");
      media.config.onTranscript?.("CA-inbound", "hello");
      expect(clearTtsQueue).toHaveBeenCalledTimes(2);
    } finally {
      await server.stop();
    }
  });
});
