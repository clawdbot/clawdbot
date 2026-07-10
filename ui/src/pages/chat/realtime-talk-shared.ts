// Control UI chat module implements realtime talk shared behavior.
import { REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME } from "../../../../src/talk/agent-consult-tool.js";
import {
  buildRealtimeVoiceAgentCancelProviderResult,
  buildRealtimeVoiceAgentControlSpeechMessage,
  parseRealtimeVoiceAgentControlToolArgs,
  REALTIME_VOICE_AGENT_CONTROL_TOOL_NAME,
  shouldAutoControlRealtimeVoiceAgentText,
} from "../../../../src/talk/agent-run-control-shared.js";
import type { RealtimeVoiceAgentControlMode } from "../../../../src/talk/agent-run-control-shared.js";
import type { TalkEvent } from "../../../../src/talk/talk-events.js";
import type { GatewayBrowserClient, GatewayEventFrame } from "../../api/gateway.ts";

export type RealtimeTalkStatus = "idle" | "connecting" | "listening" | "thinking" | "error";
export type RealtimeTalkEvent = TalkEvent;

export type RealtimeTalkCallbacks = {
  onStatus?: (status: RealtimeTalkStatus, detail?: string) => void;
  onInputLevel?: (level: number) => void;
  onTranscript?: (entry: { role: "user" | "assistant"; text: string; final: boolean }) => void;
  onTalkEvent?: (event: RealtimeTalkEvent) => void;
};

type RealtimeTalkEventInput<TPayload = unknown> = {
  type: RealtimeTalkEvent["type"];
  payload?: TPayload;
  turnId?: string;
  captureId?: string;
  final?: boolean;
  callId?: string;
  itemId?: string;
  parentId?: string;
};

type RealtimeTalkAudioContract = {
  inputEncoding: "pcm16" | "g711_ulaw";
  inputSampleRateHz: number;
  outputEncoding: "pcm16" | "g711_ulaw";
  outputSampleRateHz: number;
};

export type RealtimeTalkWebRtcSdpSessionResult = {
  provider: string;
  transport: "webrtc";
  clientSecret: string;
  offerUrl?: string;
  offerHeaders?: Record<string, string>;
  model?: string;
  voice?: string;
  expiresAt?: number;
  consultThinkingLevel?: string;
  consultFastMode?: boolean;
};

export type RealtimeTalkJsonPcmWebSocketSessionResult = {
  provider: string;
  transport: "provider-websocket";
  protocol: string;
  clientSecret: string;
  websocketUrl: string;
  audio: RealtimeTalkAudioContract;
  initialMessage?: unknown;
  model?: string;
  voice?: string;
  expiresAt?: number;
  consultThinkingLevel?: string;
  consultFastMode?: boolean;
};

export type RealtimeTalkGatewayRelaySessionResult = {
  provider: string;
  transport: "gateway-relay";
  relaySessionId: string;
  audio: RealtimeTalkAudioContract;
  model?: string;
  voice?: string;
  expiresAt?: number;
  consultThinkingLevel?: string;
  consultFastMode?: boolean;
};

type RealtimeTalkManagedRoomSessionResult = {
  provider: string;
  transport: "managed-room";
  roomUrl: string;
  token?: string;
  model?: string;
  voice?: string;
  expiresAt?: number;
  consultThinkingLevel?: string;
  consultFastMode?: boolean;
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
  inputDeviceId?: string;
  consultThinkingLevel?: string;
  consultFastMode?: boolean;
};

export function createRealtimeTalkEventEmitter(
  ctx: RealtimeTalkTransportContext,
  session: RealtimeTalkSessionResult,
): (input: RealtimeTalkEventInput) => void {
  let seq = 0;
  let turnSeq = 0;
  let activeTurnId: string | undefined;
  const sessionId = resolveRealtimeTalkEventSessionId(ctx, session);
  return (input) => {
    if (!ctx.callbacks.onTalkEvent) {
      return;
    }
    const turnId = resolveRealtimeTalkTurnId(input);
    seq += 1;
    ctx.callbacks.onTalkEvent({
      id: `${sessionId}:${seq}`,
      type: input.type,
      sessionId,
      turnId,
      captureId: input.captureId,
      seq,
      timestamp: new Date().toISOString(),
      mode: "realtime",
      transport: session.transport,
      brain: "agent-consult",
      provider: session.provider,
      final: input.final,
      callId: input.callId,
      itemId: input.itemId,
      parentId: input.parentId,
      payload: input.payload ?? null,
    });
    if (
      input.type === "turn.ended" ||
      input.type === "turn.cancelled" ||
      input.type === "session.replaced" ||
      input.type === "session.closed"
    ) {
      activeTurnId = undefined;
    }
  };

  function resolveRealtimeTalkTurnId(input: RealtimeTalkEventInput): string | undefined {
    if (input.type === "turn.started") {
      activeTurnId = input.turnId ?? activeTurnId ?? `turn-${++turnSeq}`;
      return activeTurnId;
    }
    if (!isTurnScopedTalkEvent(input.type)) {
      return input.turnId;
    }
    activeTurnId = input.turnId ?? activeTurnId ?? `turn-${++turnSeq}`;
    return activeTurnId;
  }
}

function isTurnScopedTalkEvent(type: RealtimeTalkEvent["type"]): boolean {
  return (
    type === "turn.ended" ||
    type === "turn.cancelled" ||
    type.startsWith("input.audio.") ||
    type.startsWith("transcript.") ||
    type.startsWith("output.") ||
    type.startsWith("tool.")
  );
}

function resolveRealtimeTalkEventSessionId(
  ctx: RealtimeTalkTransportContext,
  session: RealtimeTalkSessionResult,
): string {
  const explicitSessionId = (session as { sessionId?: unknown }).sessionId;
  if (typeof explicitSessionId === "string" && explicitSessionId.trim()) {
    return explicitSessionId.trim();
  }
  if ("relaySessionId" in session && session.relaySessionId.trim()) {
    return session.relaySessionId;
  }
  return `${ctx.sessionKey}:${session.provider}:${session.transport}`;
}

type ChatPayload = {
  runId?: string;
  stream?: string;
  state?: string;
  errorMessage?: string;
  data?: unknown;
  message?: unknown;
};

type AgentWaitResult = {
  status?: string;
  error?: string;
  stopReason?: string;
  endedAt?: number;
  pendingError?: boolean;
  timeoutPhase?: string;
  providerStarted?: boolean;
  aborted?: boolean;
  livenessState?: string;
  yielded?: boolean;
};

const EMPTY_FINAL_FALLBACK_GRACE_MS = 500;

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

function getTerminalAgentWaitError(result: AgentWaitResult | undefined): Error | undefined {
  if (!result) {
    return undefined;
  }
  const message = result.error?.trim();
  if (result.status === "error") {
    return new Error(message || "OpenClaw tool call failed");
  }
  if (result.status !== "timeout" || result.pendingError) {
    return undefined;
  }
  const stopReason = result.stopReason?.trim();
  const timeoutPhase = result.timeoutPhase?.trim();
  const livenessState = result.livenessState?.trim();
  const hasTerminalTimeoutMetadata =
    result.endedAt !== undefined ||
    message !== undefined ||
    result.aborted === true ||
    (livenessState !== undefined && livenessState.length > 0) ||
    result.yielded === true ||
    (stopReason !== undefined && stopReason.length > 0) ||
    timeoutPhase === "preflight" ||
    timeoutPhase === "provider" ||
    timeoutPhase === "post_turn" ||
    result.providerStarted === true;
  if (hasTerminalTimeoutMetadata) {
    return new Error(message || "OpenClaw tool call timed out");
  }
  return undefined;
}

function waitForChatResult(params: {
  client: GatewayBrowserClient;
  runId: string;
  timeoutMs: number;
  emitTalkEvent?: (input: RealtimeTalkEventInput) => void;
  signal?: AbortSignal;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    if (params.signal?.aborted) {
      reject(new DOMException("OpenClaw tool call aborted", "AbortError"));
      return;
    }
    const timer = window.setTimeout(() => {
      settleReject(new Error("OpenClaw tool call timed out"));
    }, params.timeoutMs);
    let settled = false;
    let emptyFinalWaitStarted = false;
    let emptyFinalFallbackTimer: number | undefined;
    const onAbort = () => {
      settleReject(new DOMException("OpenClaw tool call aborted", "AbortError"));
    };
    params.signal?.addEventListener("abort", onAbort, { once: true });
    let unsubscribe: () => void = () => undefined;
    const settleResolve = (value: string) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(value);
    };
    const settleReject = (error: Error | DOMException) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };
    const waitForEmptyFinalFallback = () => {
      if (emptyFinalWaitStarted) {
        return;
      }
      emptyFinalWaitStarted = true;
      void params.client
        .request<AgentWaitResult>("agent.wait", {
          runId: params.runId,
          timeoutMs: params.timeoutMs,
        })
        .then((result) => {
          if (settled) {
            return;
          }
          const waitError = getTerminalAgentWaitError(result);
          if (waitError) {
            settleReject(waitError);
            return;
          }
          if (result?.status === "timeout") {
            return;
          }
          emptyFinalFallbackTimer = window.setTimeout(() => {
            settleResolve("OpenClaw finished with no text.");
          }, EMPTY_FINAL_FALLBACK_GRACE_MS);
        })
        .catch((error: unknown) => {
          settleReject(error instanceof Error ? error : new Error(String(error)));
        });
    };
    unsubscribe = params.client.addEventListener((evt: GatewayEventFrame) => {
      if (evt.event !== "chat") {
        return;
      }
      const payload = evt.payload as ChatPayload | undefined;
      if (!payload || payload.runId !== params.runId) {
        return;
      }
      emitRealtimeTalkAgentProgress(params.emitTalkEvent, payload);
      if (payload.state === "final") {
        const finalText = extractTextFromMessage(payload.message);
        if (finalText) {
          settleResolve(finalText);
          return;
        }
        waitForEmptyFinalFallback();
      } else if (payload.state === "aborted") {
        settleReject(
          new DOMException(payload.errorMessage ?? "OpenClaw tool call aborted", "AbortError"),
        );
      } else if (payload.state === "error") {
        settleReject(new Error(payload.errorMessage ?? "OpenClaw tool call failed"));
      }
    });
    function cleanup() {
      window.clearTimeout(timer);
      if (emptyFinalFallbackTimer !== undefined) {
        window.clearTimeout(emptyFinalFallbackTimer);
      }
      params.signal?.removeEventListener("abort", onAbort);
      unsubscribe();
    }
  });
}

function emitRealtimeTalkAgentProgress(
  emitTalkEvent: ((input: RealtimeTalkEventInput) => void) | undefined,
  payload: ChatPayload,
): void {
  if (!emitTalkEvent || payload.stream !== "tool") {
    return;
  }
  const data = payload.data && typeof payload.data === "object" ? payload.data : {};
  const record = data as Record<string, unknown>;
  const phase = typeof record.phase === "string" ? record.phase : undefined;
  const name = typeof record.name === "string" ? record.name : undefined;
  const toolCallId = typeof record.toolCallId === "string" ? record.toolCallId : undefined;
  emitTalkEvent({
    type: "tool.progress",
    callId: toolCallId,
    payload: {
      runId: payload.runId,
      ...(name ? { name } : {}),
      ...(phase ? { phase } : {}),
    },
  });
}

export async function steerRealtimeTalkActiveConsult(params: {
  ctx: RealtimeTalkTransportContext;
  text: string;
  mode?: RealtimeVoiceAgentControlMode;
  sessionId?: string;
  emitTalkEvent?: (input: RealtimeTalkEventInput) => void;
  onControlResult?: (result: unknown) => void;
  speakControlResult?: (message: string) => void;
  suppressSpeechForModes?: readonly RealtimeVoiceAgentControlMode[];
}): Promise<void> {
  const text = params.text.trim();
  if (!text) {
    return;
  }
  const request =
    params.sessionId && params.sessionId.trim()
      ? params.ctx.client.request("talk.session.steer", {
          sessionId: params.sessionId,
          sessionKey: params.ctx.sessionKey,
          text,
          ...(params.mode ? { mode: params.mode } : {}),
        })
      : params.ctx.client.request("talk.client.steer", {
          sessionKey: params.ctx.sessionKey,
          text,
          ...(params.mode ? { mode: params.mode } : {}),
        });
  try {
    const result = await request;
    params.onControlResult?.(result);
    maybeSpeakRealtimeTalkControlResult(
      result,
      params.speakControlResult,
      params.suppressSpeechForModes,
    );
    params.emitTalkEvent?.({
      type: "tool.progress",
      payload: {
        name: "openclaw_agent_control",
        result,
      },
      final:
        result && typeof result === "object" && "mode" in result
          ? result.mode === "status" || result.mode === "cancel"
          : undefined,
    });
  } catch (error) {
    params.emitTalkEvent?.({
      type: "tool.error",
      payload: { message: error instanceof Error ? error.message : String(error) },
      final: true,
    });
  }
}

export async function submitRealtimeTalkAgentControl(params: {
  ctx: RealtimeTalkTransportContext;
  args: unknown;
  submit: (callId: string, result: unknown) => void | Promise<void>;
  callId: string;
  sessionId?: string;
  emitTalkEvent?: (input: RealtimeTalkEventInput) => void;
}): Promise<void> {
  let result: unknown;
  let talkEvent: RealtimeTalkEventInput;
  try {
    const parsed = parseRealtimeVoiceAgentControlToolArgs(params.args);
    result =
      params.sessionId && params.sessionId.trim()
        ? await params.ctx.client.request("talk.session.steer", {
            sessionId: params.sessionId,
            sessionKey: params.ctx.sessionKey,
            text: parsed.text,
            mode: parsed.mode,
          })
        : await params.ctx.client.request("talk.client.steer", {
            sessionKey: params.ctx.sessionKey,
            text: parsed.text,
            mode: parsed.mode,
          });
    talkEvent = {
      type: "tool.progress",
      callId: params.callId,
      payload: {
        name: "openclaw_agent_control",
        result,
      },
      final:
        result && typeof result === "object" && "mode" in result
          ? result.mode === "status" || result.mode === "cancel"
          : undefined,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    talkEvent = {
      type: "tool.error",
      callId: params.callId,
      payload: { message },
      final: true,
    };
    result = { error: message };
  }
  await params.submit(params.callId, result);
  params.emitTalkEvent?.(talkEvent);
}

function maybeSpeakRealtimeTalkControlResult(
  result: unknown,
  speakControlResult: ((message: string) => void) | undefined,
  suppressSpeechForModes: readonly RealtimeVoiceAgentControlMode[] | undefined,
): void {
  if (!speakControlResult || !result || typeof result !== "object") {
    return;
  }
  const record = result as Record<string, unknown>;
  const mode =
    typeof record.mode === "string" ? (record.mode as RealtimeVoiceAgentControlMode) : undefined;
  if (mode && suppressSpeechForModes?.includes(mode)) {
    return;
  }
  const message = typeof record.message === "string" ? record.message.trim() : "";
  const shouldSpeak =
    (record.speak === true && record.suppress !== true) ||
    (record.ok === true && mode === "steer" && record.suppress === true);
  if (shouldSpeak && message) {
    speakControlResult(buildRealtimeVoiceAgentControlSpeechMessage(message));
  }
}

export async function submitRealtimeTalkConsult(params: {
  ctx: RealtimeTalkTransportContext;
  args: unknown;
  submit: (callId: string, result: unknown) => void | Promise<void>;
  callId: string;
  relaySessionId?: string;
  emitTalkEvent?: (input: RealtimeTalkEventInput) => void;
  submitAbortResult?: boolean;
  signal?: AbortSignal;
}): Promise<void> {
  const { ctx, callId, submit } = params;
  ctx.callbacks.onStatus?.("thinking");
  let runId: string | undefined;
  let aborted = false;
  let submitted = false;
  let submissionCompleted = false;
  const submitOnce = async (result: unknown): Promise<void> => {
    if (submitted) {
      return;
    }
    submitted = true;
    await submit(callId, result);
    submissionCompleted = true;
  };
  const submitAbortResult = async (): Promise<void> => {
    if (params.submitAbortResult !== false) {
      await submitOnce(buildRealtimeVoiceAgentCancelProviderResult());
    }
  };
  const abortRun = () => {
    aborted = true;
    if (runId) {
      void ctx.client.request("chat.abort", { sessionKey: ctx.sessionKey, runId });
    }
  };
  if (params.signal?.aborted) {
    await submitAbortResult();
    return;
  }
  params.signal?.addEventListener("abort", abortRun, { once: true });
  try {
    const args =
      typeof params.args === "string" ? JSON.parse(params.args || "{}") : (params.args ?? {});
    const response = await ctx.client.request<{ runId?: string; idempotencyKey?: string }>(
      "talk.client.toolCall",
      {
        sessionKey: ctx.sessionKey,
        callId,
        name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
        args,
        ...(params.relaySessionId ? { relaySessionId: params.relaySessionId } : {}),
      },
    );
    runId = response.runId ?? response.idempotencyKey;
    if (!runId) {
      throw new Error("OpenClaw realtime tool call did not return a run id");
    }
    if (params.signal?.aborted) {
      abortRun();
      await submitAbortResult();
      return;
    }
    const result = await waitForChatResult({
      client: ctx.client,
      runId,
      timeoutMs: 120_000,
      emitTalkEvent: params.emitTalkEvent,
      signal: params.signal,
    });
    await submitOnce({ result });
  } catch (error) {
    if (submitted) {
      throw error;
    }
    if (aborted || params.signal?.aborted || isAbortError(error)) {
      await submitAbortResult();
      return;
    }
    await submitOnce({
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    params.signal?.removeEventListener("abort", abortRun);
    if (submissionCompleted && !aborted && !params.signal?.aborted) {
      ctx.callbacks.onStatus?.("listening");
    }
  }
}

function isAbortError(error: unknown): boolean {
  return (
    typeof DOMException !== "undefined" &&
    error instanceof DOMException &&
    error.name === "AbortError"
  );
}

export {
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  REALTIME_VOICE_AGENT_CONTROL_TOOL_NAME,
  shouldAutoControlRealtimeVoiceAgentText,
};
