import { request, type IncomingMessage } from "node:http";
import type { RealtimeTranscriptionProviderPlugin } from "openclaw/plugin-sdk/realtime-transcription";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  VoiceCallConfigSchema,
  type VoiceCallConfig,
  type VoiceCallConfigInput,
} from "./config.js";
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

const createConfig = (overrides: VoiceCallConfigInput = {}): VoiceCallConfig => {
  const base = VoiceCallConfigSchema.parse({});
  base.serve.port = 0;

  const merged = {
    ...base,
    ...overrides,
    serve: {
      ...base.serve,
      ...overrides.serve,
    },
    realtime: {
      ...base.realtime,
      ...overrides.realtime,
      tools: overrides.realtime?.tools ?? base.realtime.tools,
      fastContext: {
        ...base.realtime.fastContext,
        ...overrides.realtime?.fastContext,
        sources: overrides.realtime?.fastContext?.sources ?? base.realtime.fastContext.sources,
      },
      agentContext: {
        ...base.realtime.agentContext,
        ...overrides.realtime?.agentContext,
        files: overrides.realtime?.agentContext?.files ?? base.realtime.agentContext.files,
      },
      providers: overrides.realtime?.providers ?? base.realtime.providers,
    },
  };
  const parsed = VoiceCallConfigSchema.parse({
    ...merged,
    serve: { ...merged.serve, port: merged.serve.port === 0 ? 1 : merged.serve.port },
  });
  parsed.serve.port = merged.serve.port;
  return parsed;
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

function requireFirstMockCall(calls: readonly unknown[][], label: string): unknown[] {
  const call = calls.at(0);
  if (!call) {
    throw new Error(`expected ${label} call`);
  }
  return call;
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
      expect(mocks.getRealtimeTranscriptionProvider).not.toHaveBeenCalled();
      expect(mocks.listRealtimeTranscriptionProviders).toHaveBeenCalledWith(null);
      const mediaStreamHandler = server.getMediaStreamHandler();
      if (!mediaStreamHandler) {
        throw new Error("expected media stream handler");
      }
      expect(mediaStreamHandler.handleUpgrade).toBeTypeOf("function");
      expect(mediaStreamHandler.sendAudio).toBeTypeOf("function");
      expect(mediaStreamHandler.closeAll).toBeTypeOf("function");
    } finally {
      await server.stop();
    }
  });

  it("records media stream Talk events on the active call metadata", async () => {
    const call = createCall(Date.now());
    const manager = {
      getActiveCalls: () => [call],
      getCallByProviderCallId: (providerCallId: string) =>
        providerCallId === "provider-call-1" ? call : undefined,
      endCall: vi.fn(async () => ({ success: true })),
      processEvent: vi.fn(),
      speakInitialMessage: vi.fn(async () => {}),
    } as unknown as CallManager;
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

    const server = new VoiceCallWebhookServer(config, manager, provider);
    try {
      await server.start();
      const mediaHandler = server.getMediaStreamHandler() as unknown as {
        config: {
          onTalkEvent?: NonNullable<import("./media-stream.js").MediaStreamConfig["onTalkEvent"]>;
        };
      };
      mediaHandler.config.onTalkEvent?.("provider-call-1", "MZ-talk", {
        id: "voice-call:provider-call-1:MZ-talk:1",
        type: "transcript.done",
        sessionId: "voice-call:provider-call-1:MZ-talk",
        turnId: "MZ-talk:turn:1",
        seq: 1,
        timestamp: "2026-05-05T06:00:00.000Z",
        mode: "stt-tts",
        transport: "gateway-relay",
        brain: "agent-consult",
        provider: "openai",
        final: true,
        payload: { text: "hello", role: "user" },
      });

      expect(call.metadata?.lastTalkEventAt).toBe("2026-05-05T06:00:00.000Z");
      expect(call.metadata?.lastTalkEventType).toBe("transcript.done");
      expect(call.metadata?.recentTalkEvents).toEqual([
        {
          at: "2026-05-05T06:00:00.000Z",
          type: "transcript.done",
          sessionId: "voice-call:provider-call-1:MZ-talk",
          turnId: "MZ-talk:turn:1",
        },
      ]);
    } finally {
      await server.stop();
    }
  });
});

describe("VoiceCallWebhookServer media stream client IP resolution", () => {
  type MediaStreamRequestDouble = {
    headers: Record<string, string>;
    socket: { remoteAddress?: string };
  };

  const resolveMediaStreamClientIp = (
    configOverrides: Partial<VoiceCallConfig>,
    requestOverrides: Partial<MediaStreamRequestDouble> = {},
  ): string | undefined => {
    const { manager } = createManager([]);
    const server = new VoiceCallWebhookServer(
      createConfig(configOverrides),
      manager,
      createTwilioStreamingProvider(),
    );
    const request = {
      headers: {},
      socket: { remoteAddress: "127.0.0.1" },
      ...requestOverrides,
    };

    return (
      server as unknown as {
        resolveMediaStreamClientIp: (request: MediaStreamRequestDouble) => string | undefined;
      }
    ).resolveMediaStreamClientIp(request as never);
  };

  it("uses forwarded IPs only when forwarding trust is explicitly enabled", () => {
    const ip = resolveMediaStreamClientIp(
      {
        webhookSecurity: {
          allowedHosts: [],
          trustForwardingHeaders: true,
          trustedProxyIPs: ["127.0.0.1"],
        },
      },
      {
        headers: {
          "x-forwarded-for": "198.51.100.10, 203.0.113.10",
        },
      },
    );

    expect(ip).toBe("203.0.113.10");
  });

  it("does not trust forwarded IPs when only allowedHosts is configured", () => {
    const ip = resolveMediaStreamClientIp(
      {
        webhookSecurity: {
          allowedHosts: ["voice.example.com"],
          trustForwardingHeaders: false,
          trustedProxyIPs: ["127.0.0.1"],
        },
      },
      {
        headers: {
          "x-forwarded-for": "198.51.100.10",
          "x-real-ip": "198.51.100.11",
        },
      },
    );

    expect(ip).toBe("127.0.0.1");
  });

  it("ignores spoofed forwarded IPs from untrusted remotes", () => {
    const ip = resolveMediaStreamClientIp(
      {
        webhookSecurity: {
          allowedHosts: [],
          trustForwardingHeaders: true,
          trustedProxyIPs: ["203.0.113.10"],
        },
      },
      {
        headers: {
          "x-forwarded-for": "198.51.100.10",
        },
        socket: { remoteAddress: "127.0.0.1" },
      },
    );

    expect(ip).toBe("127.0.0.1");
  });

  it("walks the forwarded chain from the right to support trusted multi-proxy deployments", () => {
    const ip = resolveMediaStreamClientIp(
      {
        webhookSecurity: {
          allowedHosts: [],
          trustForwardingHeaders: true,
          trustedProxyIPs: ["127.0.0.1", "203.0.113.10"],
        },
      },
      {
        headers: {
          "x-forwarded-for": "198.51.100.10, 203.0.113.10",
        },
      },
    );

    expect(ip).toBe("198.51.100.10");
  });

  it("ignores forwarded IPs when no trusted proxy is configured", () => {
    const ip = resolveMediaStreamClientIp(
      {
        webhookSecurity: {
          allowedHosts: [],
          trustForwardingHeaders: true,
          trustedProxyIPs: [],
        },
      },
      {
        headers: {
          "x-forwarded-for": "198.51.100.10",
          "x-real-ip": "198.51.100.11",
        },
        socket: { remoteAddress: "127.0.0.1" },
      },
    );

    expect(ip).toBe("127.0.0.1");
  });

  it("matches trusted proxies when the remote uses an IPv4-mapped form", () => {
    const ip = resolveMediaStreamClientIp(
      {
        webhookSecurity: {
          allowedHosts: [],
          trustForwardingHeaders: true,
          trustedProxyIPs: ["127.0.0.1", "203.0.113.10"],
        },
      },
      {
        headers: {
          "x-forwarded-for": "198.51.100.10, 203.0.113.10",
        },
        socket: { remoteAddress: "::ffff:127.0.0.1" },
      },
    );

    expect(ip).toBe("198.51.100.10");
  });
});

async function runStaleCallReaperCase(params: {
  callAgeMs: number;
  staleCallReaperSeconds: number;
  advanceMs: number;
  callOverrides?: Partial<CallRecord>;
}) {
  const now = new Date("2026-02-16T00:00:00Z");
  vi.setSystemTime(now);

  const call = { ...createCall(now.getTime() - params.callAgeMs), ...params.callOverrides };
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

  it("does not reap calls that reached the answered state", async () => {
    const { endCall } = await runStaleCallReaperCase({
      callAgeMs: 120_000,
      staleCallReaperSeconds: 60,
      advanceMs: 30_000,
      callOverrides: {
        state: "answered",
        answeredAt: new Date("2026-02-15T23:58:30Z").getTime(),
      },
    });
    expect(endCall).not.toHaveBeenCalled();
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
      inboundPolicy: "open",
      realtime: {
        enabled: true,
        streamPath: "/voice/stream/realtime",
        instructions: "Be helpful.",
        toolPolicy: "safe-read-only",
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

  it.each(["outbound-api", "outbound-dial"] as const)(
    "returns realtime TwiML for %s twilio TwiML fetches",
    async (direction) => {
      const parseWebhookEvent = vi.fn(() => ({ events: [], statusCode: 200 }));
      const buildTwiMLPayload = vi.fn(() => ({
        statusCode: 200,
        headers: { "Content-Type": "text/xml" },
        body: '<Response><Connect><Stream url="wss://example.test/voice/stream/realtime/token" /></Connect></Response>',
      }));
      const twilioProvider: VoiceCallProvider = {
        ...provider,
        name: "twilio",
        verifyWebhook: () => ({ ok: true, verifiedRequestKey: "twilio:req:rt-outbound" }),
        parseWebhookEvent,
      };
      const { manager, processEvent } = createManager([]);
      const config = createConfig({
        provider: "twilio",
        inboundPolicy: "disabled",
        realtime: {
          enabled: true,
          streamPath: "/voice/stream/realtime",
          instructions: "Be helpful.",
          toolPolicy: "safe-read-only",
          tools: [],
          providers: {},
        },
      });
      const server = new VoiceCallWebhookServer(config, manager, twilioProvider);
      server.setRealtimeHandler({
        buildTwiMLPayload,
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
          `CallSid=CA123&Direction=${direction}&CallStatus=in-progress&From=%2B15550001111&To=%2B15550002222`,
          { "x-twilio-signature": "sig" },
        );

        expect(response.status).toBe(200);
        expect(await response.text()).toContain("<Connect><Stream");
        expect(buildTwiMLPayload).toHaveBeenCalledTimes(1);
        expect(parseWebhookEvent).not.toHaveBeenCalled();
        expect(processEvent).not.toHaveBeenCalled();
      } finally {
        await server.stop();
      }
    },
  );

  it("serves initial provider TwiML before the realtime shortcut", async () => {
    const parseWebhookEvent = vi.fn(() => ({ events: [], statusCode: 200 }));
    const consumeInitialTwiML = vi.fn(
      () =>
        '<Response><Play digits="ww123456#" /><Redirect method="POST">https://example.test</Redirect></Response>',
    );
    const buildTwiMLPayload = vi.fn(() => ({
      statusCode: 200,
      headers: { "Content-Type": "text/xml" },
      body: '<Response><Connect><Stream url="wss://example.test/voice/stream/realtime/token" /></Connect></Response>',
    }));
    const twilioProvider: VoiceCallProvider = {
      ...provider,
      name: "twilio",
      verifyWebhook: () => ({ ok: true, verifiedRequestKey: "twilio:req:rt-stored" }),
      parseWebhookEvent,
      consumeInitialTwiML,
    };
    const { manager, processEvent } = createManager([]);
    const config = createConfig({
      provider: "twilio",
      inboundPolicy: "disabled",
      realtime: {
        enabled: true,
        streamPath: "/voice/stream/realtime",
        instructions: "Be helpful.",
        toolPolicy: "safe-read-only",
        tools: [],
        providers: {},
      },
    });
    const server = new VoiceCallWebhookServer(config, manager, twilioProvider);
    server.setRealtimeHandler({
      buildTwiMLPayload,
      getStreamPathPattern: () => "/voice/stream/realtime",
      handleWebSocketUpgrade: () => {},
      registerToolHandler: () => {},
      setPublicUrl: () => {},
    } as unknown as RealtimeCallHandler);

    try {
      const baseUrl = await server.start();
      const requestUrl = requireBoundRequestUrl(server, baseUrl);
      requestUrl.searchParams.set("callId", "call-1");
      const response = await fetch(requestUrl.toString(), {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-twilio-signature": "sig",
        },
        body: "CallSid=CA123&Direction=outbound-api&CallStatus=in-progress&From=%2B15550001111&To=%2B15550002222",
      });

      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain('<Play digits="ww123456#"');
      expect(consumeInitialTwiML).toHaveBeenCalledTimes(1);
      expect(buildTwiMLPayload).not.toHaveBeenCalled();
      expect(parseWebhookEvent).not.toHaveBeenCalled();
      expect(processEvent).not.toHaveBeenCalled();
    } finally {
      await server.stop();
    }
  });

  it("rejects non-allowlisted inbound realtime calls before creating a stream token", async () => {
    const buildTwiMLPayload = vi.fn(() => ({
      statusCode: 200,
      headers: { "Content-Type": "text/xml" },
      body: '<Response><Connect><Stream url="wss://example.test/voice/stream/realtime/token" /></Connect></Response>',
    }));
    const twilioProvider: VoiceCallProvider = {
      ...provider,
      name: "twilio",
      verifyWebhook: () => ({ ok: true, verifiedRequestKey: "twilio:req:rt-deny" }),
    };
    const { manager } = createManager([]);
    const config = createConfig({
      provider: "twilio",
      inboundPolicy: "allowlist",
      allowFrom: ["+15550001111"],
      realtime: {
        enabled: true,
        streamPath: "/voice/stream/realtime",
        instructions: "Be helpful.",
        toolPolicy: "safe-read-only",
        tools: [],
        providers: {},
      },
    });
    const server = new VoiceCallWebhookServer(config, manager, twilioProvider);
    server.setRealtimeHandler({
      buildTwiMLPayload,
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
        "CallSid=CA123&Direction=inbound&CallStatus=ringing&From=%2B15550002222",
        { "x-twilio-signature": "sig" },
      );
      const body = await response.text();

      expect(response.status).toBe(200);
      expect(body).toContain("<Reject");
      expect(buildTwiMLPayload).not.toHaveBeenCalled();
    } finally {
      await server.stop();
    }
  });

  it("creates a realtime stream only for allowlisted inbound callers", async () => {
    const buildTwiMLPayload = vi.fn(() => ({
      statusCode: 200,
      headers: { "Content-Type": "text/xml" },
      body: '<Response><Connect><Stream url="wss://example.test/voice/stream/realtime/token" /></Connect></Response>',
    }));
    const twilioProvider: VoiceCallProvider = {
      ...provider,
      name: "twilio",
      verifyWebhook: () => ({ ok: true, verifiedRequestKey: "twilio:req:rt-allow" }),
    };
    const { manager } = createManager([]);
    const config = createConfig({
      provider: "twilio",
      inboundPolicy: "allowlist",
      allowFrom: ["+15550002222"],
      realtime: {
        enabled: true,
        streamPath: "/voice/stream/realtime",
        instructions: "Be helpful.",
        toolPolicy: "safe-read-only",
        tools: [],
        providers: {},
      },
    });
    const server = new VoiceCallWebhookServer(config, manager, twilioProvider);
    server.setRealtimeHandler({
      buildTwiMLPayload,
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
        "CallSid=CA123&Direction=inbound&CallStatus=ringing&From=%2B15550002222",
        { "x-twilio-signature": "sig" },
      );
      const body = await response.text();

      expect(response.status).toBe(200);
      expect(body).toContain("<Connect><Stream");
      expect(buildTwiMLPayload).toHaveBeenCalledTimes(1);
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
      const parseOptions = requireFirstMockCall(parseWebhookEvent.mock.calls, "webhook parse")[1];
      if (!parseOptions) {
        throw new Error("webhook server did not pass verified parse options");
      }
      expect(parseOptions).toEqual({
        verifiedRequestKey: "verified:req:123",
      });
      expect(processEvent).toHaveBeenCalledTimes(1);
      const firstEvent = requireFirstMockCall(processEvent.mock.calls, "processed event")[0] as
        | NormalizedEvent
        | undefined;
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
    let releaseReads: (() => void) | undefined;
    let unblockReadBodies: (() => void) | undefined;
    const enteredEightReads = new Promise<void>((resolve) => {
      releaseReads = resolve;
    });
    const unblockReads = new Promise<void>((resolve) => {
      unblockReadBodies = resolve;
    });
    if (!releaseReads || !unblockReadBodies) {
      throw new Error("Expected webhook read gates to be initialized");
    }
    const releaseEnteredReads = releaseReads;
    const unblockStartedReads = unblockReadBodies;
    const readBodySpy = vi.spyOn(
      server as unknown as {
        readBody: (req: unknown, maxBytes: number, timeoutMs?: number) => Promise<string>;
      },
      "readBody",
    );
    readBodySpy.mockImplementation(async () => {
      enteredReads += 1;
      if (enteredReads === 8) {
        releaseEnteredReads();
      }
      if (enteredReads <= 8) {
        await unblockReads;
      }
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

      unblockStartedReads();

      const settled = await Promise.all(inFlightRequests);
      expect(settled.map((response) => response.status)).toEqual(Array(8).fill(200));
    } finally {
      unblockStartedReads();
      readBodySpy.mockRestore();
      await server.stop();
    }
  });

  it("limits missing remote addresses with a shared fallback bucket", async () => {
    const twilioProvider: VoiceCallProvider = {
      ...provider,
      name: "twilio",
      verifyWebhook: () => ({ ok: true, verifiedRequestKey: "twilio:req:test" }),
    };
    const { manager } = createManager([]);
    const config = createConfig({ provider: "twilio" });
    const server = new VoiceCallWebhookServer(config, manager, twilioProvider);
    const runWebhookPipeline = (
      server as unknown as {
        runWebhookPipeline: (
          req: IncomingMessage,
          webhookPath: string,
        ) => Promise<{ statusCode: number; body: string }>;
      }
    ).runWebhookPipeline.bind(server);

    let enteredReads = 0;
    let releaseReads: (() => void) | undefined;
    let unblockReadBodies: (() => void) | undefined;
    const enteredEightReads = new Promise<void>((resolve) => {
      releaseReads = resolve;
    });
    const unblockReads = new Promise<void>((resolve) => {
      unblockReadBodies = resolve;
    });
    if (!releaseReads || !unblockReadBodies) {
      throw new Error("Expected webhook read gates to be initialized");
    }
    const releaseEnteredReads = releaseReads;
    const unblockStartedReads = unblockReadBodies;
    const readBodySpy = vi.spyOn(
      server as unknown as {
        readBody: (req: unknown, maxBytes: number, timeoutMs?: number) => Promise<string>;
      },
      "readBody",
    );
    readBodySpy.mockImplementation(async () => {
      enteredReads += 1;
      if (enteredReads === 8) {
        releaseEnteredReads();
      }
      await unblockReads;
      return "CallSid=CA123&SpeechResult=hello";
    });

    const makeRequestWithoutRemoteAddress = () =>
      ({
        method: "POST",
        url: "/voice/webhook",
        headers: { "x-twilio-signature": "sig" },
        socket: { remoteAddress: undefined },
      }) as unknown as IncomingMessage;

    try {
      const inFlightRequests = Array.from({ length: 8 }, () =>
        runWebhookPipeline(makeRequestWithoutRemoteAddress(), "/voice/webhook"),
      );
      await enteredEightReads;

      const rejected = await runWebhookPipeline(
        makeRequestWithoutRemoteAddress(),
        "/voice/webhook",
      );
      expect(rejected.statusCode).toBe(429);
      expect(rejected.body).toBe("Too Many Requests");
      expect(readBodySpy).toHaveBeenCalledTimes(8);

      unblockStartedReads();

      const settled = await Promise.all(inFlightRequests);
      expect(settled.map((response) => response.statusCode)).toEqual(Array(8).fill(200));
    } finally {
      unblockStartedReads();
      readBodySpy.mockRestore();
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

  it("supports concurrent start() calls without double-binding the port", async () => {
    const { manager } = createManager([]);
    const config = createConfig({ serve: { port: 0, bind: "127.0.0.1", path: "/voice/webhook" } });
    const server = new VoiceCallWebhookServer(config, manager, provider);

    try {
      const [firstUrl, secondUrl] = await Promise.all([server.start(), server.start()]);

      expectWebhookUrl(firstUrl, "/voice/webhook");
      expect(secondUrl).toBe(firstUrl);
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

    await expect(server.stop()).resolves.toBeUndefined();
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

    let currentStreamSid: string | null = "MZ-old";
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
        onTranscriptionReady?: (providerCallId: string, streamSid: string) => void;
      };
    };
    if (!mediaHandler) {
      throw new Error("expected webhook server to expose a media stream handler");
    }

    mediaHandler.config.onDisconnect?.("CA-stream-1", "MZ-old");
    await vi.advanceTimersByTimeAsync(1_000);
    mediaHandler.config.onConnect?.("CA-stream-1", "MZ-new");
    await vi.advanceTimersByTimeAsync(2_100);
    expect(endCall).not.toHaveBeenCalled();
    expect(speakInitialMessage).not.toHaveBeenCalled();

    mediaHandler.config.onTranscriptionReady?.("CA-stream-1", "MZ-new");
    expect(speakInitialMessage).toHaveBeenCalledTimes(1);
    expect(speakInitialMessage).toHaveBeenCalledWith("CA-stream-1");

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
      const [calledCallId, calledTranscript] = requireFirstMockCall(
        handleInboundResponse.mock.calls,
        "inbound response",
      ) as [string | undefined, string | undefined];
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
    const processEvent = vi.fn();
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
        handleInboundResponse: (callId: string, transcript: string) => Promise<void>;
      }
    ).handleInboundResponse = handleInboundResponse;

    try {
      const media = getMediaCallbacks(server);
      media.config.onSpeechStart?.("CA-inbound");
      media.config.onTranscript?.("CA-inbound", "hello");
      expect(clearTtsQueue).toHaveBeenCalledTimes(2);
      expect(processEvent).toHaveBeenCalledTimes(1);
      const event = requireFirstMockCall(processEvent.mock.calls, "inbound processed event")[0] as
        | NormalizedEvent
        | undefined;
      expect(event?.type).toBe("call.speech");
      if (event?.type !== "call.speech") {
        throw new Error("expected media transcript callback to emit a speech event");
      }
      expect(event.callId).toBe("call-inbound");
      expect(event.providerCallId).toBe("CA-inbound");
      expect(event.transcript).toBe("hello");
      expect(event.isFinal).toBe(true);
      expect(handleInboundResponse).toHaveBeenCalledWith("call-inbound", "hello");
    } finally {
      await server.stop();
    }
  });
});
