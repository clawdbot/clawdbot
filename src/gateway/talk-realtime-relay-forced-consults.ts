import { randomUUID } from "node:crypto";
import {
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  buildRealtimeVoiceAgentConsultWorkingResponse,
} from "../talk/agent-consult-tool.js";
import { buildRealtimeVoiceAgentCancelProviderResult } from "../talk/agent-run-control-shared.js";
import type { RealtimeVoiceAgentControlResult } from "../talk/agent-run-control.js";
import { readSpeakableRealtimeVoiceToolResult } from "../talk/consult-question.js";
import type { RealtimeVoiceForcedConsultHandle } from "../talk/forced-consult-coordinator.js";
import type { RealtimeVoiceToolResultOptions } from "../talk/provider-types.js";
import {
  broadcastToolResultToOwner,
  clearRelayAgentToolCall,
  completeAfterToolResultSubmissions,
  submitFinalProviderToolResult,
  suppressedToolResultOptions,
  trackAgentFinalToolResult,
  trackPendingWorkingToolResult,
} from "./talk-realtime-relay-provider-results.js";
import {
  broadcastToOwner,
  ensureRelayTurn,
  noFallbackRelayOutputFlush,
  relaySessions,
  type ForcedTerminalProviderResult,
  type RelayAgentControlProviderSubmission,
  type RelaySession,
} from "./talk-realtime-relay-state.js";

const FORCED_CONSULT_FALLBACK_DELAY_MS = 200;
const FORCED_CONSULT_RESULT_MAX_CHARS = 1_800;

function isWorkingToolResult(result: unknown): boolean {
  return (
    Boolean(result) &&
    typeof result === "object" &&
    !Array.isArray(result) &&
    (result as Record<string, unknown>).status === "working"
  );
}

function buildForcedConsultCheckingPrompt(): string {
  return [
    "Briefly tell the person that you are checking with OpenClaw.",
    "Do not answer the request yet. Wait for the OpenClaw result before giving the actual answer.",
  ].join(" ");
}

function buildForcedConsultSpeechPrompt(text: string): string {
  return [
    "OpenClaw finished checking. Speak this result naturally and concisely.",
    "Do not mention tool calls, JSON, or internal routing.",
    "",
    text,
  ].join("\n");
}

export function buildAlreadyDeliveredToolResult(): Record<string, string> {
  return {
    status: "already_delivered",
    message: "OpenClaw already delivered this consult result internally. Do not repeat it.",
  };
}

export function cancelForcedConsults(session: RelaySession): void {
  for (const handle of session.harness.forcedConsults.handles()) {
    session.harness.forcedConsults.markCancelled(handle);
  }
}

export function submitRelayAgentControlProviderResults(
  session: RelaySession,
  result: RealtimeVoiceAgentControlResult,
  turnId: string,
): RelayAgentControlProviderSubmission | undefined {
  if (result.mode !== "cancel" || !result.ok || !result.providerResult) {
    return undefined;
  }
  const providerResult = result.providerResult;
  const epoch = session.toolResultEpoch;
  const callIds = [...session.activeAgentToolCalls.keys()];
  const activeCallIds = callIds.filter((callId) => !session.pendingFinalToolResults.has(callId));
  const submissions: Array<void | Promise<void>> = callIds
    .map((callId) => session.pendingFinalToolResults.get(callId))
    .filter((pending): pending is Promise<void> => pending !== undefined);
  const toolResultOptions = suppressedToolResultOptions(session);
  let providerResponseStarted = toolResultOptions === undefined && submissions.length > 0;
  const finalizeAgentCall = (callId: string, forcedConsult?: RealtimeVoiceForcedConsultHandle) => {
    if (session.toolResultEpoch !== epoch) {
      return;
    }
    if (forcedConsult) {
      session.harness.forcedConsults.markCancelled(forcedConsult);
    }
    broadcastToolResultToOwner(session, {
      callId,
      turnId,
      result: providerResult,
      final: true,
    });
    clearRelayAgentToolCall(session, callId);
    session.completedAgentToolCalls.add(callId);
  };
  for (const callId of activeCallIds) {
    const forcedConsult = session.harness.forcedConsults
      .handles()
      .find((handle) => handle.id === callId);
    if (forcedConsult) {
      const nativeCallIds = session.harness.forcedConsults.nativeCallIds(forcedConsult);
      providerResponseStarted ||= toolResultOptions === undefined && nativeCallIds.length > 0;
      const terminal: ForcedTerminalProviderResult = {
        result: providerResult,
        options: toolResultOptions,
        turnId,
        epoch,
      };
      session.forcedTerminalProviderResults.set(callId, terminal);
      const clearTerminal = () => {
        if (session.forcedTerminalProviderResults.get(callId) === terminal) {
          session.forcedTerminalProviderResults.delete(callId);
        }
      };
      const drained = drainForcedTerminalProviderResultsAfterPending(
        session,
        forcedConsult,
        terminal,
      );
      const completed = completeAfterToolResultSubmissions(session, [drained], () => {
        clearTerminal();
        finalizeAgentCall(callId, forcedConsult);
      });
      const tracked = trackAgentFinalToolResult(session, callId, completed?.finally(clearTerminal));
      submissions.push(tracked);
      continue;
    }
    providerResponseStarted ||= toolResultOptions === undefined;
    const submitted = submitFinalProviderToolResult({
      session,
      callId,
      result: providerResult,
      options: toolResultOptions,
      onAccepted: () => finalizeAgentCall(callId),
    });
    submissions.push(trackAgentFinalToolResult(session, callId, submitted));
  }
  const completion = completeAfterToolResultSubmissions(session, submissions, () => {});
  return {
    ...(completion ? { completion } : {}),
    providerResponseStarted,
  };
}

export function scheduleForcedAgentConsult(
  session: RelaySession | undefined,
  question: string,
): void {
  if (!session || !question.trim()) {
    return;
  }
  if (session.harness.forcedConsults.hasRecentNativeConsult(question)) {
    return;
  }
  session.harness.forcedConsults.clearPending();
  const handle = session.harness.forcedConsults.prepare(question);
  if (!handle) {
    return;
  }
  session.harness.forcedConsults.schedule(handle, FORCED_CONSULT_FALLBACK_DELAY_MS, () => {
    if (!relaySessions.has(session.id)) {
      return;
    }
    const turnId = ensureRelayTurn(session);
    const callId = handle.id;
    const itemId = `forced-consult-item-${randomUUID()}`;
    session.harness.forcedConsults.markStarted(handle);
    session.harness.handleBargeIn(
      { audioPlaybackActive: true, force: true },
      noFallbackRelayOutputFlush,
    );
    broadcastToOwner(session.context, session.connId, {
      relaySessionId: session.id,
      type: "toolCall",
      itemId,
      callId,
      name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
      forced: true,
      args: {
        question: handle.question,
        context:
          "The realtime provider produced a final user transcript without invoking openclaw_agent_consult, so OpenClaw is forcing the consult for realtime Talk.",
        responseStyle: "Reply in a concise spoken tone.",
      },
      talkEvent: session.harness.talk.emit({
        type: "tool.call",
        itemId,
        callId,
        turnId,
        payload: {
          name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
          args: { question: handle.question },
          forced: true,
        },
      }),
    });
  });
}

export function submitForcedConsultProviderResult(
  session: RelaySession,
  callId: string,
  result: unknown,
  options: RealtimeVoiceToolResultOptions | undefined,
): void | Promise<void> {
  return submitFinalProviderToolResult({
    session,
    callId,
    result,
    options,
  });
}

function drainForcedTerminalProviderResults(
  session: RelaySession,
  handle: RealtimeVoiceForcedConsultHandle,
  terminal: ForcedTerminalProviderResult,
): void | Promise<void> {
  if (session.forcedTerminalProviderResults.get(handle.id) !== terminal) {
    return;
  }
  const submissions = session.harness.forcedConsults
    .nativeCallIds(handle)
    .map((callId) =>
      submitForcedConsultProviderResult(session, callId, terminal.result, terminal.options),
    );
  const pending = submissions.filter(
    (submission): submission is Promise<void> => submission !== undefined,
  );
  if (pending.length > 0) {
    return Promise.all(pending).then(() =>
      drainForcedTerminalProviderResults(session, handle, terminal),
    );
  }
  const hasUnsubmittedCall = session.harness.forcedConsults
    .nativeCallIds(handle)
    .some((callId) => !session.completedProviderToolResults.has(callId));
  if (hasUnsubmittedCall) {
    return drainForcedTerminalProviderResults(session, handle, terminal);
  }
}

function drainForcedTerminalProviderResultsAfterPending(
  session: RelaySession,
  handle: RealtimeVoiceForcedConsultHandle,
  terminal: ForcedTerminalProviderResult,
): void | Promise<void> {
  const pending = session.harness.forcedConsults
    .nativeCallIds(handle)
    .map((callId) => session.pendingProviderToolResults.get(callId))
    .filter((submission): submission is Promise<void> => submission !== undefined);
  if (pending.length === 0) {
    return drainForcedTerminalProviderResults(session, handle, terminal);
  }
  return Promise.allSettled(pending).then(() =>
    drainForcedTerminalProviderResults(session, handle, terminal),
  );
}

export function submitRealtimeAgentConsultWorkingResponse(
  session: RelaySession,
  callId: string,
  turnId = ensureRelayTurn(session),
): void | Promise<void> {
  if (!session.bridge.bridge.supportsToolResultContinuation) {
    return;
  }
  const epoch = session.toolResultEpoch;
  const submission = session.bridge.submitToolResult(
    callId,
    buildRealtimeVoiceAgentConsultWorkingResponse("person"),
    { willContinue: true },
  );
  const completion = completeAfterToolResultSubmissions(session, [submission], () => {
    if (session.toolResultEpoch !== epoch) {
      return;
    }
    broadcastToOwner(session.context, session.connId, {
      relaySessionId: session.id,
      type: "toolResult",
      callId,
      talkEvent: session.harness.talk.emit({
        type: "tool.progress",
        callId,
        turnId,
        payload: { name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME, status: "working" },
      }),
    });
  });
  return trackPendingWorkingToolResult(session, callId, completion);
}

export function submitForcedTalkRealtimeRelayToolResult(
  session: RelaySession,
  forcedConsult: RealtimeVoiceForcedConsultHandle,
  params: {
    callId: string;
    result: unknown;
    options?: RealtimeVoiceToolResultOptions;
  },
): void | Promise<void> {
  const cancelled = session.harness.forcedConsults.isCancelled(forcedConsult);
  const turnId = cancelled
    ? (session.cancelledAgentToolCalls.get(params.callId) ?? session.harness.talk.activeTurnId)
    : ensureRelayTurn(session);
  if (!turnId) {
    throw new Error("Cancelled realtime consult is missing its original turn");
  }
  if (cancelled) {
    const providerResult = buildRealtimeVoiceAgentCancelProviderResult(
      "OpenClaw cancelled this consult before completion. Do not restart it.",
    );
    const terminal: ForcedTerminalProviderResult = {
      result: providerResult,
      options: suppressedToolResultOptions(session),
      turnId,
      epoch: session.toolResultEpoch,
    };
    session.forcedTerminalProviderResults.set(forcedConsult.id, terminal);
    const clearTerminal = () => {
      if (session.forcedTerminalProviderResults.get(forcedConsult.id) === terminal) {
        session.forcedTerminalProviderResults.delete(forcedConsult.id);
      }
    };
    const drained = drainForcedTerminalProviderResultsAfterPending(
      session,
      forcedConsult,
      terminal,
    );
    const completion = completeAfterToolResultSubmissions(session, [drained], () => {
      clearTerminal();
      if (session.toolResultEpoch !== terminal.epoch) {
        return;
      }
      session.harness.forcedConsults.markCancelled(forcedConsult);
      clearRelayAgentToolCall(session, params.callId);
      session.cancelledAgentToolCalls.delete(params.callId);
      session.completedAgentToolCalls.add(params.callId);
      broadcastToolResultToOwner(session, {
        callId: params.callId,
        turnId,
        result: providerResult,
        forced: true,
        final: true,
      });
    });
    return trackAgentFinalToolResult(session, params.callId, completion?.finally(clearTerminal));
  }
  const final = params.options?.willContinue !== true;
  if (!final) {
    if (isWorkingToolResult(params.result)) {
      session.bridge.sendUserMessage(buildForcedConsultCheckingPrompt());
    }
    broadcastToolResultToOwner(session, {
      callId: params.callId,
      turnId,
      result: params.result,
      forced: true,
      final: false,
    });
    return;
  }
  const text = readSpeakableRealtimeVoiceToolResult(params.result, {
    maxChars: FORCED_CONSULT_RESULT_MAX_CHARS,
  });
  const providerOptions = suppressedToolResultOptions(session);
  const providerResult = providerOptions ? buildAlreadyDeliveredToolResult() : params.result;
  const terminal: ForcedTerminalProviderResult = {
    result: providerResult,
    options: providerOptions,
    turnId,
    epoch: session.toolResultEpoch,
  };
  session.forcedTerminalProviderResults.set(forcedConsult.id, terminal);
  const submission = drainForcedTerminalProviderResults(session, forcedConsult, terminal);
  const clearTerminal = () => {
    if (session.forcedTerminalProviderResults.get(forcedConsult.id) === terminal) {
      session.forcedTerminalProviderResults.delete(forcedConsult.id);
    }
  };
  const completion = completeAfterToolResultSubmissions(session, [submission], () => {
    clearTerminal();
    if (session.toolResultEpoch !== terminal.epoch) {
      return;
    }
    session.harness.forcedConsults.markDelivered(forcedConsult);
    clearRelayAgentToolCall(session, params.callId);
    session.completedAgentToolCalls.add(params.callId);
    const hasNativeCalls = session.harness.forcedConsults.nativeCallIds(forcedConsult).length > 0;
    if (text && (!hasNativeCalls || providerOptions)) {
      session.bridge.sendUserMessage(buildForcedConsultSpeechPrompt(text));
    }
    broadcastToolResultToOwner(session, {
      callId: params.callId,
      turnId,
      result: params.result,
      forced: true,
      final: true,
    });
  });
  const trackedCompletion = completion?.finally(clearTerminal);
  return trackAgentFinalToolResult(session, params.callId, trackedCompletion);
}
