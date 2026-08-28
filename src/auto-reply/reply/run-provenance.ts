import type { DiagnosticRunFireReason } from "../../infra/diagnostic-events.js";
import type { GetReplyOptions } from "../types.js";

// Continuation work/delegate wakes are heartbeat-like for hooks and model
// overrides, but must not flip `isHeartbeat` because admission treats that as
// skippable background work under active-run pressure. `subagent-return` (an
// ordinary inter-session subagent completion) is also a system-injected wake,
// so it stays heartbeat-like here even though it is NOT a mid-chain continuation
// wake at the chain-budget reset gate (see get-reply-run `isContinuationWake`).
export function isContinuationHeartbeatEquivalent(
  continuationTrigger:
    | Pick<GetReplyOptions, "continuationTrigger">["continuationTrigger"]
    | undefined,
): boolean {
  return (
    continuationTrigger === "work-wake" ||
    continuationTrigger === "delegate-return" ||
    continuationTrigger === "subagent-return"
  );
}

export function resolveReplyHookTrigger(
  opts?: Pick<GetReplyOptions, "continuationTrigger" | "isHeartbeat">,
): "heartbeat" | "user" {
  return opts?.isHeartbeat === true || isContinuationHeartbeatEquivalent(opts?.continuationTrigger)
    ? "heartbeat"
    : "user";
}

export function resolveReplyRunFireReason(params: {
  opts?: Pick<GetReplyOptions, "continuationTrigger" | "isHeartbeat">;
  drainsContinuationDelegateQueue?: boolean;
}): DiagnosticRunFireReason {
  if (
    params.drainsContinuationDelegateQueue === true ||
    params.opts?.continuationTrigger === "delegate-return" ||
    params.opts?.continuationTrigger === "subagent-return"
  ) {
    return "continuation-chain";
  }
  if (params.opts?.continuationTrigger === "work-wake" || params.opts?.isHeartbeat === true) {
    return "timer";
  }
  return "external-trigger";
}
