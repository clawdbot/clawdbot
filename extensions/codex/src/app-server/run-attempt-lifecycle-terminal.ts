export function buildCodexLifecycleTerminalMeta(input: {
  aborted: boolean;
  timedOut: boolean;
  yielded?: boolean;
  abortStopReason?: string;
}) {
  if (input.timedOut || input.abortStopReason === "timeout") {
    return {
      aborted: true,
      status: "timed_out",
      stopReason: "timeout",
      timeoutPhase: "provider",
      providerStarted: true,
    } as const;
  }
  if (input.yielded && !input.aborted) {
    return {
      yielded: true,
      livenessState: "paused",
      stopReason: "end_turn",
    } as const;
  }
  return input.aborted
    ? ({ aborted: true, status: "cancelled", stopReason: "stop" } as const)
    : undefined;
}
