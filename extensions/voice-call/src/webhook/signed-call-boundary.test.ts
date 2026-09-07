// This boundary proof uses the real CallManager, TwilioProvider, VoiceCallWebhookServer,
// RealtimeCallHandler, HTTP server, and WebSocket upgrade path. Its only behavioral test
// doubles are the external RealtimeVoiceProviderPlugin and its RealtimeVoiceBridge; manager
// spies are call-through observers, and persistence uses the production SQLite state store.
import crypto from "node:crypto";
import { createPluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-store-runtime";
import { closeOpenClawStateDatabaseForTest } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type {
  RealtimeVoiceBridge,
  RealtimeVoiceProviderPlugin,
} from "openclaw/plugin-sdk/realtime-voice";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { VoiceCallConfigSchema } from "../config.js";
import { CallManager } from "../manager.js";
import { TwilioProvider } from "../providers/twilio.js";
import { setVoiceCallStateRuntime, type VoiceCallStateRuntime } from "../runtime-state.js";
import { VoiceCallWebhookServer } from "../webhook.js";
import { connectWs, waitForClose } from "../websocket-test-support.js";
import { RealtimeCallHandler } from "./realtime-handler.js";

const MATCHING_CALL_SID = "CA22222222222222222222222222222222";
const MISMATCHED_CALL_SID = "CA33333333333333333333333333333333";
const MISMATCH_SESSION_CALL_SID = "CA77777777777777777777777777777777";
const ACCOUNT_SID = "AC11111111111111111111111111111111";
const MATCHING_STREAM_SID = "MZ44444444444444444444444444444444";
const MISMATCHED_STREAM_SID = "MZ55555555555555555555555555555555";
const MULAW_SILENCE = Buffer.alloc(160, 0xff).toString("base64");
const REDACTED_CALL_SID = "CA…redacted";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function installProductionStateStore(): void {
  const state = {
    resolveStateDir,
    openSyncKeyedStore: <T>(
      options: Parameters<VoiceCallStateRuntime["state"]["openSyncKeyedStore"]>[0],
    ) => createPluginStateSyncKeyedStore<T>("voice-call", options),
  } as VoiceCallStateRuntime["state"];
  setVoiceCallStateRuntime({ state });
}

function requireBoundRequestUrl(server: VoiceCallWebhookServer, baseUrl: string): URL {
  const address = (
    server as unknown as { server?: { address?: () => unknown } }
  ).server?.address?.();
  if (
    !address ||
    typeof address !== "object" ||
    !("port" in address) ||
    typeof address.port !== "number" ||
    !address.port
  ) {
    throw new Error("voice webhook server did not expose a bound port");
  }
  const requestUrl = new URL(baseUrl);
  requestUrl.port = String(address.port);
  return requestUrl;
}

async function postSignedTwilioWebhook(params: {
  server: VoiceCallWebhookServer;
  baseUrl: string;
  authToken: string;
  callSid?: string;
  attempt: "missing" | "blank" | "matching" | "mismatched";
}): Promise<{ response: Response; responseBody: string; streamUrl?: string }> {
  const url = requireBoundRequestUrl(params.server, params.baseUrl);
  // Fixtures follow Twilio's documented voice POST and Media Streams frames:
  // https://www.twilio.com/docs/voice/twiml#twilios-request-to-your-application and https://www.twilio.com/docs/voice/media-streams/websocket-messages
  const bodyParams = new URLSearchParams({
    AccountSid: ACCOUNT_SID,
    From: "+14155550100",
    To: "+14155550101",
    CallStatus: "ringing",
    ApiVersion: "2010-04-01",
    Direction: "inbound",
    ForwardedFrom: "+14155550102",
    CallerName: "Carrier Boundary",
    ParentCallSid: "CA66666666666666666666666666666666",
    FromCity: "SAN FRANCISCO",
    FromState: "CA",
    FromZip: "94105",
    FromCountry: "US",
    ToCity: "OAKLAND",
    ToState: "CA",
    ToZip: "94612",
    ToCountry: "US",
  });
  if (params.callSid !== undefined) {
    bodyParams.set("CallSid", params.callSid);
  }
  const body = bodyParams.toString();
  let signedMaterial = url.toString();
  for (const [key, value] of [...new URLSearchParams(body)].toSorted(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  )) {
    signedMaterial += key + value;
  }
  const signature = crypto
    .createHmac("sha1", params.authToken)
    .update(signedMaterial)
    .digest("base64");
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": signature,
    },
    body,
  });
  const responseBody = await response.text();
  const streamUrl = responseBody.match(/url="([^"]+)"/)?.[1];
  const outcome = streamUrl
    ? "one-time stream URL returned=<one-time-token>"
    : "rejected before stream issuance; pending sessions=0";
  console.info(
    `[boundary-proof] signed webhook POST CallSid=${params.callSid?.trim() ? REDACTED_CALL_SID : `<${params.attempt}>`} -> status=${response.status}; ${outcome}`,
  );
  return { response, responseBody, streamUrl };
}

function createExternalRealtimeProviderDouble() {
  const bridgeEntries: Array<() => void> = [];
  const sendAudio = vi.fn();
  const bridge: RealtimeVoiceBridge = {
    connect: async () => {},
    sendAudio,
    setMediaTimestamp: () => {},
    submitToolResult: () => {},
    acknowledgeMark: () => {},
    close: () => {},
    isConnected: () => true,
    triggerGreeting: () => {},
  };
  const createBridge = vi.fn<RealtimeVoiceProviderPlugin["createBridge"]>(() => {
    bridgeEntries.shift()?.();
    return bridge;
  });
  const provider: RealtimeVoiceProviderPlugin = {
    id: "openai",
    label: "OpenAI",
    isConfigured: () => true,
    createBridge,
  };
  return {
    createBridge,
    provider,
    sendAudio,
    waitForBridgeEntry: () =>
      new Promise<void>((resolve) => {
        bridgeEntries.push(resolve);
      }),
  };
}

function documentedTwilioStart(callSid: string, streamSid: string) {
  return {
    event: "start",
    sequenceNumber: "1",
    start: {
      accountSid: ACCOUNT_SID,
      streamSid,
      callSid,
      tracks: ["inbound"],
      customParameters: { proof: "signed-call-boundary" },
      mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 },
    },
    streamSid,
  };
}

function sendDocumentedTwilioMedia(ws: WebSocket, streamSid: string): void {
  for (let index = 0; index < 3; index += 1) {
    ws.send(
      JSON.stringify({
        event: "media",
        sequenceNumber: String(index + 2),
        media: {
          track: "inbound",
          chunk: String(index + 1),
          timestamp: String(index * 20),
          payload: MULAW_SILENCE,
        },
        streamSid,
      }),
    );
  }
}

function sendDocumentedTwilioStop(ws: WebSocket, callSid: string, streamSid: string): void {
  ws.send(
    JSON.stringify({
      event: "stop",
      sequenceNumber: "5",
      stop: { accountSid: ACCOUNT_SID, callSid },
      streamSid,
    }),
  );
}

async function connectSignedStream(streamUrl: string): Promise<WebSocket> {
  const ws = await connectWs(streamUrl.replace(/^wss:/, "ws:"));
  console.info(
    "[boundary-proof] WebSocket upgrade accepted; one-time stream token=<one-time-token>",
  );
  return ws;
}

async function createSignedBoundaryHarness() {
  installProductionStateStore();
  const storePath = tempDirs.make("openclaw-signed-call-boundary-");
  const authToken = "signed-realtime-boundary-token";
  const twilioProvider = new TwilioProvider({ accountSid: ACCOUNT_SID, authToken });
  const config = VoiceCallConfigSchema.parse({
    provider: "twilio",
    inboundPolicy: "open",
    twilio: { accountSid: ACCOUNT_SID, authToken },
    serve: { port: 1 },
    realtime: {
      enabled: true,
      streamPath: "/voice/stream/realtime",
      instructions: "Be helpful.",
      toolPolicy: "safe-read-only",
      tools: [],
      providers: {},
    },
  });
  config.serve.port = 0;
  const manager = new CallManager(config, storePath);
  const processEvent = vi.spyOn(manager, "processEvent");
  const lookupCall = vi.spyOn(manager, "getCallByProviderCallId");
  const {
    createBridge,
    provider: realtimeProvider,
    sendAudio,
    waitForBridgeEntry,
  } = createExternalRealtimeProviderDouble();
  const server = new VoiceCallWebhookServer(
    config,
    manager,
    twilioProvider,
    undefined,
    undefined,
    undefined,
    {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
  );
  const realtimeHandler = new RealtimeCallHandler(
    config.realtime,
    manager,
    (call) => ({
      agentId: call.agentId ?? "main",
      instructions: "Be helpful.",
      provider: realtimeProvider,
      providerConfig: { apiKey: "test-key" },
    }),
    config.serve.path,
    server.getStreamDisconnectLifecycle(),
  );
  server.setRealtimeHandler(realtimeHandler);
  const sockets = new Set<WebSocket>();
  const baseUrl = await server.start();
  twilioProvider.setPublicUrl(requireBoundRequestUrl(server, baseUrl).toString());

  return {
    authToken,
    baseUrl,
    createBridge,
    lookupCall,
    processEvent,
    sendAudio,
    realtimeHandler,
    server,
    sockets,
    waitForBridgeEntry,
    close: async () => {
      for (const socket of sockets) {
        socket.terminate();
      }
      await server.stop();
      for (const call of manager.getActiveCalls()) {
        manager.processEvent({
          id: `boundary-cleanup-${call.callId}`,
          type: "call.ended",
          callId: call.callId,
          providerCallId: call.providerCallId,
          timestamp: Date.now(),
          reason: "completed",
        });
      }
      closeOpenClawStateDatabaseForTest();
    },
  };
}

function pendingStreamSessionCount(handler: RealtimeCallHandler): number {
  return (handler as unknown as { pendingStreamTokens: ReadonlyMap<string, unknown> })
    .pendingStreamTokens.size;
}

it.each([
  ["missing", undefined],
  ["blank", "   "],
] as const)(
  "rejects a signed Twilio webhook with a %s CallSid before stream issuance",
  async (attempt, callSid) => {
    const harness = await createSignedBoundaryHarness();

    try {
      const result = await postSignedTwilioWebhook({
        server: harness.server,
        baseUrl: harness.baseUrl,
        authToken: harness.authToken,
        callSid,
        attempt,
      });

      expect(result.response.status).toBe(200);
      expect(result.responseBody).toContain('<Reject reason="rejected" />');
      expect(result.responseBody).not.toContain("<Stream");
      expect(result.streamUrl).toBeUndefined();
      expect(pendingStreamSessionCount(harness.realtimeHandler)).toBe(0);
      expect(harness.lookupCall).not.toHaveBeenCalled();
      expect(harness.processEvent).not.toHaveBeenCalled();
      expect(harness.createBridge).not.toHaveBeenCalled();
    } finally {
      await harness.close();
    }
  },
);

it("binds signed Twilio calls before entering realtime lookup and bridge setup", async () => {
  const harness = await createSignedBoundaryHarness();
  const {
    authToken,
    baseUrl,
    createBridge,
    lookupCall,
    processEvent,
    sendAudio,
    server,
    sockets,
    waitForBridgeEntry,
  } = harness;

  try {
    const matching = await postSignedTwilioWebhook({
      server,
      baseUrl,
      authToken,
      callSid: MATCHING_CALL_SID,
      attempt: "matching",
    });
    expect(matching.response.status).toBe(200);
    if (!matching.streamUrl) {
      throw new Error("matching signed Twilio webhook did not return a realtime stream URL");
    }
    const matchingWs = await connectSignedStream(matching.streamUrl);
    sockets.add(matchingWs);
    const matchingClose = waitForClose(matchingWs);
    const matchingBridgeEntry = waitForBridgeEntry();
    matchingWs.send(JSON.stringify({ event: "connected", protocol: "Call", version: "1.0.0" }));
    matchingWs.send(JSON.stringify(documentedTwilioStart(MATCHING_CALL_SID, MATCHING_STREAM_SID)));
    const prematureClose = await Promise.race([
      matchingBridgeEntry.then(() => null),
      matchingClose,
    ]);
    if (prematureClose) {
      throw new Error(
        `matching signed CallSid closed before bridge entry: code=${prematureClose.code} reason="${prematureClose.reason}"`,
      );
    }
    expect(processEvent).toHaveBeenCalledTimes(2);
    expect(lookupCall).toHaveBeenCalledOnce();
    sendDocumentedTwilioMedia(matchingWs, MATCHING_STREAM_SID);
    await vi.waitFor(() => expect(sendAudio).toHaveBeenCalledTimes(3));
    sendDocumentedTwilioStop(matchingWs, MATCHING_CALL_SID, MATCHING_STREAM_SID);
    console.info(
      `[boundary-proof] start frame sent CallSid=${REDACTED_CALL_SID} -> entry reached; lookup=${lookupCall.mock.calls.length} event=${processEvent.mock.calls.length} bridge=${createBridge.mock.calls.length}`,
    );

    matchingWs.close();
    await matchingClose;
    sockets.delete(matchingWs);
    processEvent.mockClear();
    lookupCall.mockClear();
    createBridge.mockClear();

    console.info("[boundary-proof] new session");
    const mismatched = await postSignedTwilioWebhook({
      server,
      baseUrl,
      authToken,
      callSid: MISMATCH_SESSION_CALL_SID,
      attempt: "mismatched",
    });
    expect(mismatched.response.status).toBe(200);
    if (!mismatched.streamUrl) {
      throw new Error("mismatched signed Twilio webhook did not return a realtime stream URL");
    }
    const mismatchedWs = await connectSignedStream(mismatched.streamUrl);
    sockets.add(mismatchedWs);
    const mismatchedClose = waitForClose(mismatchedWs);
    const mismatchedBridgeEntry = waitForBridgeEntry();
    mismatchedWs.send(JSON.stringify({ event: "connected", protocol: "Call", version: "1.0.0" }));
    mismatchedWs.send(
      JSON.stringify(documentedTwilioStart(MISMATCHED_CALL_SID, MISMATCHED_STREAM_SID)),
    );
    const mismatchOutcome = await Promise.race([
      mismatchedClose.then((close) => ({ kind: "close", close }) as const),
      mismatchedBridgeEntry.then(() => ({ kind: "bridge" }) as const),
    ]);
    if (mismatchOutcome.kind === "bridge") {
      throw new Error("mismatched signed CallSid reached bridge entry instead of closing");
    }
    const { close } = mismatchOutcome;
    sockets.delete(mismatchedWs);

    expect(close).toEqual({
      code: 1008,
      reason: "Call identity does not match stream session",
    });
    expect(lookupCall).not.toHaveBeenCalled();
    expect(processEvent).not.toHaveBeenCalled();
    expect(createBridge).not.toHaveBeenCalled();
    console.info(
      `[boundary-proof] start frame sent CallSid=${REDACTED_CALL_SID} -> close code=${close.code} reason="${close.reason}"; lookup=${lookupCall.mock.calls.length} event=${processEvent.mock.calls.length} bridge=${createBridge.mock.calls.length}`,
    );
  } finally {
    await harness.close();
  }
});
