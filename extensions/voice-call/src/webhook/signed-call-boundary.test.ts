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

const MATCHING_CALL_SID = "CA-signed-boundary";
const MISMATCHED_CALL_SID = "CA-other-boundary";
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
  const bodyParams = new URLSearchParams({
    Direction: "inbound",
    CallStatus: "ringing",
    BoundaryAttempt: params.attempt,
  });
  if (params.callSid !== undefined) {
    bodyParams.set("CallSid", params.callSid);
  }
  const body = bodyParams.toString();
  let signedMaterial = url.toString();
  for (const [key, value] of [...new URLSearchParams(body)].toSorted(([left], [right]) =>
    left.localeCompare(right),
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
  const bridge: RealtimeVoiceBridge = {
    connect: async () => {},
    sendAudio: () => {},
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
    waitForBridgeEntry: () =>
      new Promise<void>((resolve) => {
        bridgeEntries.push(resolve);
      }),
  };
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
  const twilioProvider = new TwilioProvider({ accountSid: "AC123", authToken });
  const config = VoiceCallConfigSchema.parse({
    provider: "twilio",
    inboundPolicy: "open",
    twilio: { accountSid: "AC123", authToken },
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
    matchingWs.send(
      JSON.stringify({
        event: "start",
        start: { streamSid: "MZ-matching-boundary", callSid: MATCHING_CALL_SID },
      }),
    );
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
      callSid: MATCHING_CALL_SID,
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
    mismatchedWs.send(
      JSON.stringify({
        event: "start",
        start: { streamSid: "MZ-mismatched-boundary", callSid: MISMATCHED_CALL_SID },
      }),
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
