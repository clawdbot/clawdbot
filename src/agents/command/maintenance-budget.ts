import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { createAbortError } from "../../infra/abort-signal.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("agents/agent-command");

export function createCommandMaintenanceBudget(
  startedAt: number,
  timeoutMs: number,
  parent?: AbortSignal,
) {
  const controller = new AbortController();
  const deadline = timeoutMs === MAX_TIMER_TIMEOUT_MS ? undefined : startedAt + timeoutMs;
  const expire = () => {
    if (!controller.signal.aborted) {
      controller.abort(createAbortError("Post-turn maintenance reached the command deadline"));
      log.debug("Post-turn maintenance stopped at the command deadline.");
    }
  };
  const remainingMs = () => {
    const remaining = controller.signal.aborted
      ? 0
      : deadline === undefined
        ? timeoutMs
        : Math.max(0, deadline - Date.now());
    if (remaining === 0) {
      expire();
    }
    return remaining;
  };
  const remaining = remainingMs();
  const timer = deadline !== undefined && remaining > 0 ? setTimeout(expire, remaining) : undefined;
  timer?.unref();
  return {
    signal: parent ? AbortSignal.any([parent, controller.signal]) : controller.signal,
    remainingMs,
    dispose: () => clearTimeout(timer),
  };
}
