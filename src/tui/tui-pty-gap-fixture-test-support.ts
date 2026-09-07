// Keep gap-only test behavior out of the shared, size-bounded PTY fixture.
export const TUI_PTY_GAP_HISTORY_FIXTURE_SCRIPT = `
      let gapHistorySessionKey: string | null = null;

      function beginGapHistoryRecovery(
        backend: Pick<TuiBackend, "onEvent" | "onGap">,
        runId: string,
        sessionKey: string,
      ) {
        gapHistorySessionKey = sessionKey;
        setTimeout(() => {
          backend.onEvent?.({
            event: "agent",
            payload: {
              runId,
              sessionKey,
              stream: "lifecycle",
              data: { phase: "start" },
            },
          });
          backend.onGap?.({ expected: 4, received: 5 });
        }, 0);
        return { runId };
      }

      function loadGapHistory(sessionKey: string) {
        if (gapHistorySessionKey !== sessionKey) {
          return undefined;
        }
        gapHistorySessionKey = null;
        record("gapHistoryRecovered", { sessionKey });
        return {
          sessionInfo: sessionEntry(sessionKey),
          messages: [
            { role: "user", content: "history gap proof" },
            { role: "assistant", content: "PTY_GAP_RECOVERED" },
          ],
        };
      }
`;
