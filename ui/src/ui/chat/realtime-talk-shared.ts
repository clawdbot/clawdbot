import {
  buildRealtimeVoiceAgentConsultChatMessage,
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
} from "../../../../src/realtime-voice/agent-consult-tool.js";
import type { GatewayBrowserClient, GatewayEventFrame } from "../gateway.ts";
import { generateUUID } from "../uuid.ts";

export type RealtimeTalkStatus = "idle" | "connecting" | "listening" | "thinking" | "error";

export type RealtimeTalkCallbacks = {
  onStatus?: (status: RealtimeTalkStatus, detail?: string) => void;
  onTranscript?: (entry: { role: "user" | "assistant"; text: string; final: boolean }) => void;
};

export type RealtimeTalkAudioContract = {
  inputEncoding: "pcm16" | "g711_ulaw";
  inputSampleRateHz: number;
  outputEncoding: "pcm16" | "g711_ulaw";
  outputSampleRateHz: number;
};

export type RealtimeTalkWebRtcSdpSessionResult = {
  provider: string;
  transport?: "webrtc-sdp";
  clientSecret: string;
  offerUrl?: string;
  offerHeaders?: Record<string, string>;
  model?: string;
  voice?: string;
  expiresAt?: number;
};

export type RealtimeTalkJsonPcmWebSocketSessionResult = {
  provider: string;
  transport: "json-pcm-websocket";
  protocol: string;
  clientSecret: string;
  websocketUrl: string;
  audio: RealtimeTalkAudioContract;
  initialMessage?: unknown;
  model?: string;
  voice?: string;
  expiresAt?: number;
};

export type RealtimeTalkGatewayRelaySessionResult = {
  provider: string;
  transport: "gateway-relay";
  relaySessionId: string;
  audio: RealtimeTalkAudioContract;
  model?: string;
  voice?: string;
  expiresAt?: number;
};

export type RealtimeTalkManagedRoomSessionResult = {
  provider: string;
  transport: "managed-room";
  roomUrl: string;
  token?: string;
  model?: string;
  voice?: string;
  expiresAt?: number;
};

export type RealtimeTalkSessionResult =
  | RealtimeTalkWebRtcSdpSessionResult
  | RealtimeTalkJsonPcmWebSocketSessionResult
  | RealtimeTalkGatewayRelaySessionResult
  | RealtimeTalkManagedRoomSessionResult;

export type RealtimeTalkTransport = {
  start(): Promise<void>;
  stop(): void;
};

export type RealtimeTalkTransportContext = {
  client: GatewayBrowserClient;
  sessionKey: string;
  callbacks: RealtimeTalkCallbacks;
};

type ChatPayload = {
  runId?: string;
  state?: string;
  errorMessage?: string;
  message?: unknown;
};

function extractTextFromMessage(message: unknown): string {
  if (!message || typeof message !== "object") {
    return "";
  }
  const record = message as Record<string, unknown>;
  if (typeof record.text === "string") {
    return record.text;
  }
  const content = Array.isArray(record.content) ? record.content : [];
  const parts = content
    .map((block) => {
      if (!block || typeof block !== "object") {
        return "";
      }
      const entry = block as Record<string, unknown>;
      return entry.type === "text" && typeof entry.text === "string" ? entry.text : "";
    })
    .filter(Boolean);
  return parts.join("\n\n").trim();
}

function waitForChatResult(params: {
  client: GatewayBrowserClient;
  runId: string;
  timeoutMs: number;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      unsubscribe();
      reject(new Error("OpenClaw tool call timed out"));
    }, params.timeoutMs);
    const unsubscribe = params.client.addEventListener((evt: GatewayEventFrame) => {
      if (evt.event !== "chat") {
        return;
      }
      const payload = evt.payload as ChatPayload | undefined;
      if (!payload || payload.runId !== params.runId) {
        return;
      }
      if (payload.state === "final") {
        window.clearTimeout(timer);
        unsubscribe();
        resolve(extractTextFromMessage(payload.message) || "OpenClaw finished with no text.");
      } else if (payload.state === "error") {
        window.clearTimeout(timer);
        unsubscribe();
        reject(new Error(payload.errorMessage ?? "OpenClaw tool call failed"));
      }
    });
  });
}

export async function submitRealtimeTalkConsult(params: {
  ctx: RealtimeTalkTransportContext;
  args: unknown;
  submit: (callId: string, result: unknown) => void;
  callId: string;
}): Promise<void> {
  const { ctx, callId, submit } = params;
  ctx.callbacks.onStatus?.("thinking");
  let question = "";
  try {
    const args =
      typeof params.args === "string" ? JSON.parse(params.args || "{}") : (params.args ?? {});
    question = buildRealtimeVoiceAgentConsultChatMessage(args);
  } catch {}
  if (!question) {
    submit(callId, {
      error: `${REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME} requires a question`,
    });
    ctx.callbacks.onStatus?.("listening");
    return;
  }
  try {
    const idempotencyKey = generateUUID();
    const response = await ctx.client.request<{ runId?: string }>("chat.send", {
      sessionKey: ctx.sessionKey,
      message: question,
      idempotencyKey,
    });
    const result = await waitForChatResult({
      client: ctx.client,
      runId: response.runId ?? idempotencyKey,
      timeoutMs: 120_000,
    });
    submit(callId, { result });
  } catch (error) {
    submit(callId, {
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    ctx.callbacks.onStatus?.("listening");
  }
}

export { REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME };
