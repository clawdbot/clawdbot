import type { RealtimeVoiceToolCallEvent } from "../talk/provider-types.js";
import type { RealtimeVoiceSessionHarness } from "../talk/realtime-session-harness.js";
import type { RealtimeVoiceBridgeSession } from "../talk/session-runtime.js";
import type { TalkEventInput } from "../talk/talk-events.js";

type MeetingRealtimeToolContinuityCall = {
  session: RealtimeVoiceBridgeSession;
  event: RealtimeVoiceToolCallEvent;
  onTalkEvent: (event: TalkEventInput) => void;
};

const meetingRealtimeToolAbortSignals = new WeakMap<RealtimeVoiceBridgeSession, AbortSignal>();

export function readMeetingRealtimeToolAbortSignal(
  session: RealtimeVoiceBridgeSession,
): AbortSignal | undefined {
  return meetingRealtimeToolAbortSignals.get(session);
}

export function createMeetingRealtimeToolContinuity<
  TCall extends MeetingRealtimeToolContinuityCall,
>(handleToolCall: (call: TCall) => Promise<void>) {
  let epoch = 0;
  const activeControllers = new Set<AbortController>();

  // Reset invalidates provider submissions and Talk events together so late
  // async completions cannot leak into the replacement provider generation.
  const reset = (reason: string) => {
    epoch += 1;
    for (const controller of activeControllers) {
      controller.abort(reason);
    }
    activeControllers.clear();
  };

  const run = (params: {
    session: RealtimeVoiceBridgeSession;
    call: Omit<TCall, "session" | "onTalkEvent">;
    harness: Pick<RealtimeVoiceSessionHarness, "emit" | "ensureTurn">;
  }): Promise<void> => {
    const callEpoch = epoch;
    const controller = new AbortController();
    activeControllers.add(controller);
    const isActive = () => !controller.signal.aborted && callEpoch === epoch;
    const turnId = params.harness.ensureTurn();
    params.harness.emit({
      type: "tool.call",
      turnId,
      itemId: params.call.event.itemId,
      callId: params.call.event.callId,
      payload: { name: params.call.event.name, args: params.call.event.args },
    });
    const guardedSession = Object.create(params.session) as RealtimeVoiceBridgeSession;
    meetingRealtimeToolAbortSignals.set(guardedSession, controller.signal);
    guardedSession.submitToolResult = (callId, result, options) => {
      if (!isActive()) {
        return;
      }
      return params.session.submitToolResult(callId, result, options);
    };
    return handleToolCall({
      ...params.call,
      session: guardedSession,
      onTalkEvent: (event) => {
        if (isActive()) {
          params.harness.emit({ ...event, turnId: event.turnId ?? turnId });
        }
      },
    } as TCall)
      .catch((error: unknown) => {
        if (isActive()) {
          throw error;
        }
      })
      .finally(() => {
        meetingRealtimeToolAbortSignals.delete(guardedSession);
        activeControllers.delete(controller);
      });
  };

  return { reset, run };
}
