/**
 * Gateway mock helper for subagent-spawn tests that only require accepted RPC responses.
 */
/** Installs a gateway mock that accepts `agent` and `sessions.*` calls. */
export function installAcceptedSubagentGatewayMock(mock: {
  mockImplementation: (
    impl: (opts: { method?: string; params?: unknown }) => Promise<unknown>,
  ) => unknown;
}) {
  mock.mockImplementation(async ({ method }) =>
    method === "agent" ? { runId: "run-1" } : method?.startsWith("sessions.") ? { ok: true } : {},
  );
}
