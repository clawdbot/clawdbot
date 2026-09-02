/** Test mocks for export-command session path and store helpers. */
import type { vi } from "vitest";
import type { SessionEntry } from "../../config/sessions/types.js";

type ViLike = Pick<typeof vi, "fn">;

/** Creates hoist-safe mocks used by export command tests. */
export function createExportCommandSessionMocks(viInstance: ViLike) {
  return {
    resolveDefaultSessionStorePathMock: viInstance.fn(() => "/tmp/target-store/sessions.json"),
    resolveSessionFilePathMock: viInstance.fn(() => "/tmp/target-store/session.jsonl"),
    resolveSessionFilePathOptionsMock: viInstance.fn(
      (params: { agentId: string; storePath: string }) => params,
    ),
    loadSessionStoreMock: viInstance.fn(
      (_storePath?: string): Record<string, SessionEntry> => ({
        "agent:target:session": {
          sessionId: "session-1",
          updatedAt: 1,
        },
      }),
    ),
  };
}
