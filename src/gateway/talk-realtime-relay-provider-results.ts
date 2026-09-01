import { buildRealtimeVoiceAgentCancelProviderResult } from "../talk/agent-run-control-shared.js";
import type { RealtimeVoiceToolResultOptions } from "../talk/provider-types.js";
import {
  broadcastToOwner,
  relaySessions,
  resolveRelayProviderToolCallId,
  type RelaySession,
} from "./talk-realtime-relay-state.js";

export function suppressedToolResultOptions(
  session: RelaySession,
): RealtimeVoiceToolResultOptions | undefined {
  return session.bridge.bridge.supportsToolResultSuppression === false
    ? undefined
    : { suppressResponse: true };
}

export function broadcastToolResultToOwner(
  session: RelaySession,
  params: {
    callId: string;
    turnId: string;
    result: unknown;
    final: boolean;
    forced?: boolean;
  },
): void {
  const payload =
    params.forced === true ? { result: params.result, forced: true } : { result: params.result };
  broadcastToOwner(session.context, session.connId, {
    relaySessionId: session.id,
    type: "toolResult",
    callId: params.callId,
    talkEvent: session.harness.talk.emit({
      type: "tool.result",
      callId: params.callId,
      turnId: params.turnId,
      payload,
      final: params.final,
    }),
  });
}

export function completeAfterToolResultSubmissions(
  session: RelaySession,
  submissions: Array<void | Promise<void>>,
  onAccepted: () => void,
): void | Promise<void> {
  const pending = submissions.filter(
    (submission): submission is Promise<void> => submission !== undefined,
  );
  const complete = () => {
    if (relaySessions.get(session.id) === session) {
      onAccepted();
    }
  };
  if (pending.length === 0) {
    complete();
    return;
  }
  return Promise.all(pending).then(complete);
}

function trackToolResultCompletion(
  pending: Map<string, Promise<void>>,
  callId: string,
  completion: void | Promise<void>,
): void | Promise<void> {
  if (!completion) {
    return;
  }
  const tracked = completion.finally(() => {
    // An older completion can settle after a newer replacement is stored.
    // Delete only the entry this completion still owns.
    if (pending.get(callId) === tracked) {
      pending.delete(callId);
    }
  });
  pending.set(callId, tracked);
  return tracked;
}

export function submitFinalProviderToolResult(params: {
  session: RelaySession;
  callId: string;
  result: unknown;
  options?: RealtimeVoiceToolResultOptions;
  onAccepted?: () => void;
}): void | Promise<void> {
  const epoch = params.session.toolResultEpoch;
  const providerCallId = resolveRelayProviderToolCallId(params.session, params.callId);
  if (params.session.toolCalls.isProviderCompleted(providerCallId)) {
    if (
      relaySessions.get(params.session.id) === params.session &&
      params.session.toolResultEpoch === epoch
    ) {
      params.onAccepted?.();
    }
    return;
  }
  const pending = params.session.pendingProviderToolResults.get(params.callId);
  if (pending) {
    return pending;
  }
  const submit = () =>
    params.session.bridge.submitToolResult(providerCallId, params.result, params.options);
  const working = params.session.pendingWorkingToolResults.get(params.callId);
  const submitAfterWorking = async () => {
    if (relaySessions.get(params.session.id) !== params.session) {
      return false;
    }
    if (params.session.toolResultEpoch !== epoch) {
      if (!params.session.toolCalls.hasCancelled(params.callId)) {
        return false;
      }
      // The browser already considers this final submitted while it waits behind
      // the provider's working-result acknowledgement. Finish the cancelled call
      // here so the provider is not left waiting for a terminal result.
      await params.session.bridge.submitToolResult(
        providerCallId,
        buildRealtimeVoiceAgentCancelProviderResult(
          "OpenClaw cancelled this consult before completion. Do not restart it.",
        ),
        suppressedToolResultOptions(params.session),
      );
      if (
        !params.session.toolCalls.markProviderCompleted([providerCallId]) ||
        !params.session.toolCalls.markAgentCompleted([params.callId])
      ) {
        return false;
      }
      params.session.toolCalls.deleteCancelled(params.callId);
      return false;
    }
    await submit();
    return true;
  };
  const submission = working ? working.then(submitAfterWorking, submitAfterWorking) : submit();
  const accept = () => {
    if (params.session.toolResultEpoch !== epoch) {
      return;
    }
    if (!params.session.toolCalls.markProviderCompleted([providerCallId])) {
      return;
    }
    if (relaySessions.get(params.session.id) === params.session) {
      params.onAccepted?.();
    }
  };
  if (!submission) {
    accept();
    return;
  }
  const completion = submission.then((submitted) => {
    if (submitted !== false) {
      accept();
    }
  });
  return trackToolResultCompletion(
    params.session.pendingProviderToolResults,
    params.callId,
    completion,
  );
}

export function trackAgentFinalToolResult(
  session: RelaySession,
  callId: string,
  completion: void | Promise<void>,
): void | Promise<void> {
  return trackToolResultCompletion(session.pendingFinalToolResults, callId, completion);
}

export function trackPendingWorkingToolResult(
  session: RelaySession,
  callId: string,
  completion: void | Promise<void>,
): void | Promise<void> {
  return trackToolResultCompletion(session.pendingWorkingToolResults, callId, completion);
}

export function clearRelayAgentToolCall(session: RelaySession, callId: string): void {
  const runId = session.activeAgentToolCalls.get(callId);
  session.activeAgentToolCalls.delete(callId);
  if (!runId) {
    return;
  }
  const runStillActive = [...session.activeAgentToolCalls.values()].includes(runId);
  if (!runStillActive) {
    session.activeAgentRuns.delete(runId);
  }
}
