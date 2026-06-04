/**
 * Module-level session-utils mocks for deleted-agent guard tests.
 */
import { vi } from "vitest";

const deletedAgentSessionMocks = vi.hoisted(() => ({
  loadSessionEntry: vi.fn(),
  resolveDeletedAgentIdFromSessionKey: vi.fn(),
}));

vi.mock("../session-utils.js", async () => {
  const actual = await vi.importActual<typeof import("../session-utils.js")>("../session-utils.js");
  return {
    ...actual,
    loadSessionEntry: deletedAgentSessionMocks.loadSessionEntry,
    resolveDeletedAgentIdFromSessionKey:
      deletedAgentSessionMocks.resolveDeletedAgentIdFromSessionKey,
  };
});

/** Resets mocked deleted-agent session lookups between tests. */
export function resetDeletedAgentSessionMocks(): void {
  deletedAgentSessionMocks.loadSessionEntry.mockReset();
  deletedAgentSessionMocks.resolveDeletedAgentIdFromSessionKey.mockReset();
}

/** Stubs a session that resolves to an agent id no longer present in config. */
export function mockDeletedAgentSession(orphanKey = "agent:deleted-agent:main"): string {
  deletedAgentSessionMocks.loadSessionEntry.mockReturnValue({
    cfg: {},
    canonicalKey: orphanKey,
    storePath: "/tmp/sessions.json",
    entry: { sessionId: "sess-orphan" },
  });
  deletedAgentSessionMocks.resolveDeletedAgentIdFromSessionKey.mockReturnValue("deleted-agent");
  return orphanKey;
}
