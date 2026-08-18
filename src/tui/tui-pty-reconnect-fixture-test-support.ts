// Injects reconnect terminal outcomes into the generated real-runTui PTY backend.
export const TUI_PTY_RECONNECT_FIXTURE = {
  variables: `
      const disconnectReason = process.env.OPENCLAW_TUI_PTY_DISCONNECT_REASON;
      const reconnectOutcome = process.env.OPENCLAW_TUI_PTY_RECONNECT_OUTCOME;
      let disconnectPending = disconnectReason === undefined
        ? 0
        : Number(process.env.OPENCLAW_TUI_PTY_DISCONNECT_COUNT ?? 1);
      let reconnectHistoryReady = false;
      let reconnectRunId = "run-reconnect-fixture";
  `,
  disconnect: `
        emitDisconnect() {
          if (disconnectPending <= 0 || disconnectReason === undefined) return;
          disconnectPending -= 1;
          reconnectHistoryReady = true;
          record("disconnect");
          this.onDisconnected?.(disconnectReason);
          setTimeout(() => this.onConnected?.(), 50);
        }
  `,
  sendChat: `
          if (reconnectOutcome && opts.message === "reconnect terminal proof") {
            reconnectRunId = runId;
            queueMicrotask(() => this.onEvent?.({
              event: "chat",
              payload: {
                runId,
                sessionKey: opts.sessionKey,
                state: "delta",
                message: { role: "assistant", content: "PTY_RECONNECT_PARTIAL" },
              },
            }));
            if (reconnectOutcome === "interrupted" || reconnectOutcome === "failed") {
              setTimeout(() => this.onEvent?.({
                event: "chat",
                payload: {
                  runId,
                  sessionKey: opts.sessionKey,
                  state: "final",
                  message: { role: "assistant", content: "PTY_LATE_RECONNECT_FINAL" },
                },
              }), 400);
            }
            return { runId };
          }
  `,
  loadHistory: `
          if (reconnectHistoryReady && reconnectOutcome) {
            const sessionInfo = {
              ...sessionEntry(sessionKey),
              ...(reconnectOutcome === "interrupted"
                ? { status: "killed", abortedLastRun: true }
                : reconnectOutcome === "failed"
                  ? { status: "failed", lastRunError: "fixture provider failed" }
                  : { status: reconnectOutcome === "completed" ? "done" : "running" }),
            };
            return {
              sessionInfo,
              messages: reconnectOutcome === "completed"
                ? [{ role: "assistant", content: "PTY_RECONNECT_COMPLETED" }]
                : [],
              ...(reconnectOutcome === "active"
                ? { inFlightRun: { runId: reconnectRunId, text: "PTY_RECONNECT_PARTIAL" } }
                : {}),
            };
          }
  `,
} as const;
