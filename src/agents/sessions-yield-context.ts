/** Builds the hidden session context shared by yielding agent runtimes. */
export function buildSessionsYieldContextMessage(message: string) {
  return {
    customType: "openclaw.sessions_yield",
    content: `${message}\n\n[Context: The previous turn ended intentionally via sessions_yield while waiting for a follow-up event.]`,
    display: false,
    details: { source: "sessions_yield", message },
  };
}
