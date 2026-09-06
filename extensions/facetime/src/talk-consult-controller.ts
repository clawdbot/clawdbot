import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { PluginRuntime, RuntimeLogger } from "openclaw/plugin-sdk/plugin-runtime";
import {
  buildRealtimeVoiceAgentCancelProviderResult,
  buildRealtimeVoiceAgentConsultWorkingResponse,
  consultRealtimeVoiceAgent,
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  resolveRealtimeVoiceAgentConsultToolsAllow,
  type RealtimeVoiceBridgeSession,
  type RealtimeVoiceTranscriptEntry,
  type RealtimeVoiceToolCallEvent,
  type TalkEventInput,
} from "openclaw/plugin-sdk/realtime-voice";
import type { FaceTimeConfig } from "./config.js";
import {
  AGENT_CONSULT_MESSAGE_PROVIDER,
  CONSULT_SYSTEM_PROMPT,
  FACETIME_END_CALL_TOOL_NAME,
} from "./talk-driver-config.js";

type PendingAgentConsult = {
  callId: string;
  turnId: string;
  name: string;
  cancelRequested: boolean;
  backendSettled: boolean;
  generation: number;
  abortController: AbortController;
  runRegistration?: { runId: string; controller: AbortController };
};

export function createFaceTimeConsultController(params: {
  config: FaceTimeConfig;
  fullConfig: OpenClawConfig;
  runtime: PluginRuntime;
  logger: RuntimeLogger;
  consultAgentId: string;
  consultSessionKey: string;
  requesterSessionKey: string;
  normalizedCallUUID: string;
  senderId: string;
  senderIsOwner: true;
  transcript: RealtimeVoiceTranscriptEntry[];
  getBridge: () => RealtimeVoiceBridgeSession | undefined;
  getGeneration: () => number;
  isUnavailable: () => boolean;
  ensureTurn: () => string;
  remember: (input: TalkEventInput) => void;
  suspendMedia: (reason: string) => Promise<void>;
  reportFailure: (error: Error) => Promise<boolean>;
  close: (reason: string) => Promise<void>;
  onHangupRequested: () => Promise<void>;
}) {
  const pending = new Map<string, PendingAgentConsult>();
  let hangupRequested = false;

  const abortConsult = (consult: PendingAgentConsult) => {
    consult.abortController.abort(new Error("FaceTime agent consult superseded"));
    consult.runRegistration?.controller.abort(new Error("FaceTime agent consult run superseded"));
  };
  const abortForClose = () => {
    for (const consult of pending.values()) {
      consult.cancelRequested = true;
      pending.delete(consult.callId);
      abortConsult(consult);
    }
  };
  const cancelPending = () => {
    for (const consult of pending.values()) {
      if (consult.cancelRequested) {
        continue;
      }
      consult.cancelRequested = true;
      abortConsult(consult);
      const result = buildRealtimeVoiceAgentCancelProviderResult(
        "The caller continued speaking before this consult completed.",
      );
      void (async () => {
        try {
          const bridge = params.getBridge();
          if (!bridge) {
            throw new Error("Realtime bridge unavailable during agent consult cancellation");
          }
          const options =
            bridge.bridge.supportsToolResultSuppression === false
              ? undefined
              : { suppressResponse: true };
          await bridge.submitToolResult(consult.callId, result, options);
          if (pending.get(consult.callId) !== consult) {
            return;
          }
          pending.delete(consult.callId);
          params.remember({
            type: "tool.result",
            turnId: consult.turnId,
            callId: consult.callId,
            payload: { name: consult.name, result },
            final: true,
          });
        } catch (error) {
          if (pending.get(consult.callId) !== consult) {
            return;
          }
          pending.delete(consult.callId);
          const normalized = error instanceof Error ? error : new Error(String(error));
          params.remember({
            type: "tool.error",
            turnId: consult.turnId,
            callId: consult.callId,
            payload: { name: consult.name, error: formatErrorMessage(normalized) },
            final: true,
          });
          await params.suspendMedia("consult-cancel-failed");
          if (await params.reportFailure(normalized)) {
            await params.close("consult-cancel-failed");
          }
        }
      })();
    }
  };
  const submitHangupResult = async (event: RealtimeVoiceToolCallEvent) => {
    const bridge = params.getBridge();
    const callId = event.callId || event.itemId;
    const turnId = params.ensureTurn();
    const result = {
      status: "ending",
      message: "The current FaceTime call is ending. Do not speak another response.",
    };
    params.remember({
      type: "tool.call",
      turnId,
      itemId: event.itemId,
      callId,
      payload: { name: event.name, args: event.args },
    });
    try {
      const options =
        bridge?.bridge.supportsToolResultSuppression === false
          ? undefined
          : { suppressResponse: true };
      await bridge?.submitToolResult(callId, result, options);
      params.remember({
        type: "tool.result",
        turnId,
        callId,
        payload: { name: event.name, result },
        final: true,
      });
    } catch (error) {
      const message = formatErrorMessage(error);
      params.logger.debug?.(`[facetime] hangup tool result ignored: ${message}`);
      params.remember({
        type: "tool.error",
        turnId,
        callId,
        payload: { name: event.name, error: message },
        final: true,
      });
    }
  };
  const submitToolError = (event: RealtimeVoiceToolCallEvent, error: string) => {
    const callId = event.callId || event.itemId;
    params.remember({
      type: "tool.error",
      callId,
      payload: { name: event.name, error },
      final: true,
    });
    void params.getBridge()?.submitToolResult(callId, { error });
  };
  const handleToolCall = async (event: RealtimeVoiceToolCallEvent) => {
    if (params.isUnavailable()) {
      return;
    }
    const callId = event.callId || event.itemId;
    if (event.name === FACETIME_END_CALL_TOOL_NAME) {
      const shouldRequestHangup = !hangupRequested;
      hangupRequested = true;
      await submitHangupResult(event);
      if (shouldRequestHangup) {
        try {
          await params.onHangupRequested();
        } catch (error) {
          params.logger.warn?.(
            `[facetime] caller-requested hangup remains pending: ${formatErrorMessage(error)}`,
          );
        }
      }
      return;
    }
    if (event.name !== REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME) {
      submitToolError(event, `Tool "${event.name}" not available`);
      return;
    }
    const turnId = params.ensureTurn();
    const consult: PendingAgentConsult = {
      callId,
      turnId,
      name: event.name,
      cancelRequested: false,
      backendSettled: false,
      generation: params.getGeneration(),
      abortController: new AbortController(),
    };
    pending.set(callId, consult);
    params.remember({
      type: "tool.call",
      turnId,
      itemId: event.itemId,
      callId,
      payload: { name: event.name, args: event.args },
    });
    params.remember({
      type: "tool.progress",
      turnId,
      callId,
      payload: { name: event.name, status: "working" },
    });
    const bridge = params.getBridge();
    if (bridge?.bridge.supportsToolResultContinuation) {
      void bridge.submitToolResult(
        callId,
        buildRealtimeVoiceAgentConsultWorkingResponse("caller"),
        {
          willContinue: true,
        },
      );
    }
    void consultRealtimeVoiceAgent({
      cfg: params.fullConfig,
      agentRuntime: params.runtime.agent,
      logger: params.logger,
      agentId: params.consultAgentId,
      sessionKey: params.consultSessionKey,
      spawnedBy: params.requesterSessionKey,
      senderId: params.senderId,
      senderIsOwner: params.senderIsOwner,
      contextMode: "fork",
      messageProvider: AGENT_CONSULT_MESSAGE_PROVIDER,
      lane: `facetime:${params.normalizedCallUUID}`,
      runIdPrefix: `facetime:${params.normalizedCallUUID}`,
      args: event.args,
      transcript: params.transcript,
      surface: "a private FaceTime call",
      userLabel: "Caller",
      assistantLabel: "Assistant",
      questionSourceLabel: "caller",
      toolsAllow: resolveRealtimeVoiceAgentConsultToolsAllow(params.config.realtime.toolPolicy),
      extraSystemPrompt: CONSULT_SYSTEM_PROMPT,
      abortSignal: consult.abortController.signal,
      onRunStarted: ({ runId }) => {
        const registration = { runId, controller: new AbortController() };
        consult.runRegistration = registration;
        if (consult.cancelRequested || pending.get(callId) !== consult) {
          registration.controller.abort(new Error("FaceTime agent consult was already cancelled"));
        }
        return {
          abortSignal: registration.controller.signal,
          cleanup: () => {
            if (consult.runRegistration === registration) {
              consult.runRegistration = undefined;
            }
          },
        };
      },
    })
      .then((result) => {
        consult.backendSettled = true;
        if (
          pending.get(callId) !== consult ||
          consult.cancelRequested ||
          consult.generation !== params.getGeneration()
        ) {
          return;
        }
        pending.delete(callId);
        params.remember({
          type: "tool.result",
          turnId,
          callId,
          payload: { name: event.name, result },
          final: true,
        });
        void params.getBridge()?.submitToolResult(callId, result);
      })
      .catch((error: unknown) => {
        consult.backendSettled = true;
        if (
          pending.get(callId) !== consult ||
          consult.cancelRequested ||
          consult.generation !== params.getGeneration()
        ) {
          return;
        }
        pending.delete(callId);
        const message = formatErrorMessage(error);
        params.logger.warn?.(`[facetime] agent consult failed: ${message}`);
        params.remember({
          type: "tool.error",
          turnId,
          callId,
          payload: { name: event.name, error: message },
          final: true,
        });
        void params.getBridge()?.submitToolResult(callId, { error: message });
      });
  };
  return { abortForClose, cancelPending, handleToolCall };
}
