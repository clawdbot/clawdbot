// Synthetic reported destinations for the existing real TUI fixture.
export const TUI_PTY_FALLBACK_FIXTURE = {
  variables: `
    let fallbackFooterRun: { runId: string; sessionKey: string; step: number } | null = null;
  `,
  sendChat: `
    if (opts.message === "fallback footer proof") {
      fallbackFooterRun = { runId, sessionKey: opts.sessionKey, step: 0 };
      this.onEvent?.({
        event: "chat",
        payload: {
          runId, sessionKey: opts.sessionKey, seq: 1, state: "delta",
          message: { role: "assistant", content: [{ type: "text", text: "FALLBACK_RUN_ACTIVE" }] },
        },
      });
      return { runId };
    }
  `,
  getGatewayStatus: `
    if (fallbackFooterRun) {
      const step = ++fallbackFooterRun.step;
      const payload = {
        runId: step === 1 ? "foreign-run" : fallbackFooterRun.runId,
        sessionKey: fallbackFooterRun.sessionKey,
        stream: "lifecycle", seq: step + 1,
        data: {
          phase: "fallback_step", fallbackStepFinalOutcome: "next_fallback",
          fallbackStepToModel: step === 2 ? "malformed" : "anthropic/claude-sonnet-4",
        },
      };
      record("fallbackEvent", payload);
      this.onEvent?.({ event: "agent", payload });
      record("fallbackSelection", { step, model: currentModel });
      return "FALLBACK_EVENT_DELIVERED_" + step;
    }
  `,
};
