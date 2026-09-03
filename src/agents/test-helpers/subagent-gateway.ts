/**
 * Gateway mock helper for subagent-spawn tests that only require accepted RPC responses.
 */
/** Installs a gateway mock that accepts `agent` and `sessions.*` calls. */
export function installAcceptedSubagentGatewayMock(mock: {
  mockImplementation: (
    impl: (opts: { method?: string; params?: unknown }) => Promise<unknown>,
  ) => unknown;
}) {
  mock.mockImplementation(async ({ method, params }) => {
    if (method === "agent") {
      return { runId: "run-1" };
    }
    if (method === "chat.abort") {
      const runId =
        params && typeof params === "object" ? (params as { runId?: unknown }).runId : undefined;
      return { aborted: true, runIds: typeof runId === "string" ? [runId] : [] };
    }
    return method?.startsWith("sessions.") ? { ok: true } : {};
  });
}
