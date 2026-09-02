import { MAX_TIMER_TIMEOUT_MS, resolveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import { TURN_TERMINAL_SETTLEMENT_TIMEOUT_MS } from "./attempt-timeouts.js";

export type CodexAttemptTimeout = {
  kind: "execution" | "settlement";
  elapsedMs: number;
  timeoutMs: number;
};

type Deadline = {
  kind: CodexAttemptTimeout["kind"];
  startedAtMs: number;
  timeoutMs: number;
};

export function createCodexAttemptDeadlineController(params: {
  startedAtMs: number;
  timeoutMs: number;
  signal: AbortSignal;
  onDeadlineChanged?: (
    deadline: { kind: "bounded"; deadlineAtMs: number } | { kind: "unlimited" },
  ) => void;
  onTimeout: (timeout: CodexAttemptTimeout) => void;
}) {
  let deadline: Deadline | { kind: "unlimited" } | { kind: "closed" } = { kind: "closed" };
  let timer: ReturnType<typeof setTimeout> | undefined;

  const armDeadline = (next: Deadline) => {
    clearTimeout(timer);
    deadline = next;
    const deadlineAtMs = next.startedAtMs + next.timeoutMs;
    params.onDeadlineChanged?.({ kind: "bounded", deadlineAtMs });
    timer = setTimeout(
      () => {
        if (deadline !== next || params.signal.aborted) {
          return;
        }
        deadline = { kind: "closed" };
        params.onTimeout({
          kind: next.kind,
          elapsedMs: Math.max(0, Date.now() - next.startedAtMs),
          timeoutMs: next.timeoutMs,
        });
      },
      resolveTimerTimeoutMs(Math.max(1, deadlineAtMs - Date.now()), 1),
    );
    timer.unref?.();
  };
  const dispose = () => {
    deadline = { kind: "closed" };
    clearTimeout(timer);
    params.signal.removeEventListener("abort", dispose);
  };
  if (!params.signal.aborted) {
    params.signal.addEventListener("abort", dispose, { once: true });
    if (params.timeoutMs >= MAX_TIMER_TIMEOUT_MS) {
      deadline = { kind: "unlimited" };
      params.onDeadlineChanged?.({ kind: "unlimited" });
    } else {
      armDeadline({
        kind: "execution",
        startedAtMs: params.startedAtMs,
        timeoutMs: params.timeoutMs,
      });
    }
  }

  return {
    ownsExecutionWait: () =>
      deadline.kind === "unlimited" ||
      (deadline.kind === "execution" && Date.now() < deadline.startedAtMs + deadline.timeoutMs),
    beginSettlement: (startedAtMs: number) => {
      if (deadline.kind === "closed" || deadline.kind === "settlement") {
        return;
      }
      // Native receipt or an explicit local terminal result ends execution, not
      // projection. The first boundary owns the absolute settlement deadline.
      armDeadline({
        kind: "settlement",
        startedAtMs,
        timeoutMs: TURN_TERMINAL_SETTLEMENT_TIMEOUT_MS,
      });
    },
    dispose,
  };
}
