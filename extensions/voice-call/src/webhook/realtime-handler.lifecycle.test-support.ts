import type {
  RealtimeVoiceBridge,
  RealtimeVoiceProviderPlugin,
} from "openclaw/plugin-sdk/realtime-voice";
import { vi } from "vitest";
import type { VoiceCallRealtimeConfig } from "../config.js";
import type { CallManager } from "../manager.js";
import type { CallRecord, HangupCallInput } from "../types.js";
import { connectWs, startUpgradeWsServer } from "../websocket-test-support.js";
import { RealtimeCallHandler, type ResolveRealtimeCallRegistration } from "./realtime-handler.js";
import type { StreamDisconnectLifecycle } from "./stream-disconnect-grace.js";

export function createRealtimeConfig(): VoiceCallRealtimeConfig {
  return {
    enabled: true,
    streamPath: "/voice/stream/realtime",
    instructions: "Be helpful.",
    toolPolicy: "safe-read-only",
    consultPolicy: "auto",
    tools: [],
    fastContext: {
      enabled: false,
      timeoutMs: 800,
      maxResults: 3,
      sources: ["memory", "sessions"],
      fallbackToConsult: false,
    },
    agentContext: {
      enabled: false,
      maxChars: 6000,
      includeIdentity: true,
      includeWorkspaceFiles: true,
      files: ["SOUL.md", "IDENTITY.md", "USER.md"],
    },
    providers: {},
  };
}

export const noOpStreamDisconnectLifecycle: StreamDisconnectLifecycle = {
  connect: () => {},
  disconnect: () => {},
  retire: () => {},
};

export function createBridge(
  close: () => void,
  overrides: Partial<RealtimeVoiceBridge> = {},
): RealtimeVoiceBridge {
  return {
    connect: async () => {},
    sendAudio: () => {},
    setMediaTimestamp: () => {},
    submitToolResult: () => {},
    acknowledgeMark: () => {},
    close,
    isConnected: () => true,
    triggerGreeting: () => {},
    ...overrides,
  };
}

export function makeRealtimeProvider(
  createBridgeForCall: RealtimeVoiceProviderPlugin["createBridge"],
): RealtimeVoiceProviderPlugin {
  return {
    id: "openai",
    label: "OpenAI",
    isConfigured: () => true,
    createBridge: createBridgeForCall,
  };
}

export function makeCallRegistrationResolver(
  provider: RealtimeVoiceProviderPlugin,
): ResolveRealtimeCallRegistration {
  return (call) => ({
    agentId: call.agentId ?? "main",
    instructions: "Be helpful.",
    provider,
    providerConfig: { apiKey: "test-key" },
    releaseProviderResources() {},
    runWithProviderResources: (operation) => operation(),
  });
}

export function createCarrierLifecycleHarness(
  createBridgeForCall: RealtimeVoiceProviderPlugin["createBridge"],
  options: {
    endCall?: CallManager["endCall"];
    initialMessage?: string;
    resolveCallRegistration?: ResolveRealtimeCallRegistration;
    streamDisconnectLifecycle?: StreamDisconnectLifecycle;
  } = {},
) {
  const realtimeProvider = makeRealtimeProvider(createBridgeForCall);
  const call: CallRecord = {
    callId: "call-startup",
    providerCallId: "CA-startup",
    provider: "twilio",
    direction: "inbound",
    state: "ringing",
    from: "+15550001111",
    to: "+15550002222",
    startedAt: Date.now(),
    transcript: [],
    processedEventIds: [],
    ...(options.initialMessage ? { metadata: { initialMessage: options.initialMessage } } : {}),
  };
  const processEvent = vi.fn();
  const hangupCall = vi.fn(async (_input: HangupCallInput) => {});
  const endCall = vi.fn(
    options.endCall ??
      (async (callId: string, endOptions?: { reason?: "completed" | "error" | "timeout" }) => {
        const reason = endOptions?.reason ?? "hangup-bot";
        try {
          await hangupCall({ callId, providerCallId: call.providerCallId!, reason });
          processEvent({
            id: `manager-ended-${call.providerCallId}`,
            type: "call.ended",
            callId,
            providerCallId: call.providerCallId,
            timestamp: Date.now(),
            reason,
          });
          return { success: true };
        } catch (error) {
          return { success: false, error: error instanceof Error ? error.message : String(error) };
        }
      }),
  );
  const handler = new RealtimeCallHandler(
    createRealtimeConfig(),
    {
      processEvent,
      endCall,
      getCallByProviderCallId: vi.fn(() => call),
    } as unknown as CallManager,
    options.resolveCallRegistration ?? makeCallRegistrationResolver(realtimeProvider),
    "/voice/webhook",
    options.streamDisconnectLifecycle ?? noOpStreamDisconnectLifecycle,
  );
  return { call, endCall, handler, hangupCall, processEvent };
}

export async function connectCarrierStream(handler: RealtimeCallHandler) {
  const { streamUrl } = handler.issueStreamSession();
  const server = await startUpgradeWsServer({
    urlPath: new URL(streamUrl).pathname,
    onUpgrade: (request, socket, head) => {
      handler.handleWebSocketUpgrade(request, socket, head);
    },
  });
  return { server, ws: await connectWs(server.url) };
}
