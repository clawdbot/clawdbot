import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import type { AgentRunRequest } from "../server-methods/agent-request-types.js";
import { prepareAgentRunUserTurn } from "./agent-run-user-turn.js";
import type { AgentTurnContext } from "./types.js";

const mocks = vi.hoisted(() => ({
  loadSessionEntry: vi.fn(),
  persistSessionTranscriptTurn: vi.fn(),
}));

vi.mock("../session-utils.js", async () => {
  const actual = await vi.importActual<typeof import("../session-utils.js")>("../session-utils.js");
  return { ...actual, loadSessionEntry: mocks.loadSessionEntry };
});

vi.mock("../../config/sessions/session-accessor.js", async () => {
  const actual = await vi.importActual<typeof import("../../config/sessions/session-accessor.js")>(
    "../../config/sessions/session-accessor.js",
  );
  return { ...actual, persistSessionTranscriptTurn: mocks.persistSessionTranscriptTurn };
});

describe("prepareAgentRunUserTurn", () => {
  beforeEach(() => {
    mocks.loadSessionEntry.mockReset();
    mocks.persistSessionTranscriptTurn.mockReset().mockImplementation(async (scope, options) => {
      const message = options.messages[0]?.message;
      return {
        appendedCount: 1,
        messages: [
          {
            appended: true,
            messageId: "stale-user-turn",
            message,
            anchor: {
              agentId: scope.agentId ?? "main",
              sessionId: scope.sessionId,
              sessionKey: scope.sessionKey,
              storePath: scope.storePath,
              generation: "test-generation",
              entryId: "stale-user-turn",
              rawSeq: 1,
              effectiveParentId: null,
              activeMessagePosition: 0,
            },
          },
        ],
        sessionEntry: scope.sessionEntry,
      };
    });
  });

  it("fails closed when the admitted session entry disappeared before transcript persistence", async () => {
    const sessionKey = "agent:main:main";
    const admittedSessionId = "admitted-session";
    const sessionEntry: SessionEntry = {
      sessionId: admittedSessionId,
      updatedAt: 1,
    };
    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      storePath: "/tmp/sessions.json",
      canonicalKey: sessionKey,
      entry: undefined,
      store: {},
    });

    await expect(
      prepareAgentRunUserTurn({
        assertCurrent: () => {},
        request: {
          message: "must not reach the stale session",
          idempotencyKey: "disappeared-session-run",
        } as AgentRunRequest,
        cfg: {},
        sessionEntry,
        resolvedSessionKey: sessionKey,
        admittedSessionId,
        activeSessionAgentId: "main",
        suppressVisibleSessionEffects: false,
        requestedPromptPersistenceSuppression: false,
        canUseInternalRuntimeHandoff: false,
        message: "must not reach the stale session",
        effectiveTranscriptInputText: "must not reach the stale session",
        images: [],
        offloadedRefs: [],
        runId: "disappeared-session-run",
        client: null,
        context: {
          logGateway: { warn: vi.fn() },
        } as unknown as AgentTurnContext,
      }),
    ).rejects.toThrow("agent turn was not durably admitted");
    expect(mocks.persistSessionTranscriptTurn).not.toHaveBeenCalled();
  });
});
