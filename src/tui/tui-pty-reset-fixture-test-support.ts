// Generated fake-backend reset behavior for real PTY lifecycle proof.
export const TUI_PTY_RESET_FIXTURE = {
  methods: `
  async resetSession(key: string, reason?: "new" | "reset") {
    record("resetSession", { key, reason });
    const releasePath = process.env.OPENCLAW_TUI_PTY_RESET_RELEASE_PATH;
    if (releasePath) {
      while (!existsSync(releasePath)) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      return {
        ok: true,
        key,
        entry: {
          ...sessionEntry(key),
          displayName: "Reset session after",
          sessionId: "reset-session-after",
        },
      };
    }
    return {};
  }
`,
  options: `
    submitBurstWindowMs: (() => {
      const value = Number(process.env.OPENCLAW_TUI_PTY_SUBMIT_BURST_WINDOW_MS ?? 0);
      return value > 0 ? value : undefined;
    })(),
    onSubmitBurstCaptured: (value) => record("submitBurstCaptured", { value }),
`,
};
