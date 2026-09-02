import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import type { AgentRunRequest } from "../server-methods/agent-request-types.js";
import { prepareAgentRunUserTurn } from "./agent-run-user-turn.js";
import type { AgentTurnContext } from "./types.js";

const mocks = vi.hoisted(() => ({
  loadSessionEntry: vi.fn(),
  persistSessionTranscriptTurn: vi.fn(),
  stageSessionPendingInput: vi.fn(),
  persistInboundImagesForTranscript: vi.fn(),
  deleteMediaBuffer: vi.fn(),
  persistedMessages: [] as unknown[],
  beforeTranscriptCommit: undefined as (() => void) | undefined,
}));

vi.mock("../chat-attachments.js", async () => {
  const actual =
    await vi.importActual<typeof import("../chat-attachments.js")>("../chat-attachments.js");
  return { ...actual, persistInboundImagesForTranscript: mocks.persistInboundImagesForTranscript };
});

vi.mock("../../media/store.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../media/store.js")>("../../media/store.js");
  return { ...actual, deleteMediaBuffer: mocks.deleteMediaBuffer };
});

vi.mock("../session-utils.js", async () => {
  const actual = await vi.importActual<typeof import("../session-utils.js")>("../session-utils.js");
  return { ...actual, loadSessionEntry: mocks.loadSessionEntry };
});

vi.mock("../../config/sessions/session-accessor.js", async () => {
  const actual = await vi.importActual<typeof import("../../config/sessions/session-accessor.js")>(
    "../../config/sessions/session-accessor.js",
  );
  return {
    ...actual,
    persistSessionTranscriptTurn: mocks.persistSessionTranscriptTurn,
    stageSessionPendingInput: mocks.stageSessionPendingInput,
  };
});

describe("prepareAgentRunUserTurn", () => {
  beforeEach(() => {
    mocks.loadSessionEntry.mockReset();
    mocks.persistInboundImagesForTranscript.mockReset().mockResolvedValue({ entries: [] });
    mocks.deleteMediaBuffer.mockReset().mockResolvedValue(undefined);
    mocks.persistedMessages.length = 0;
    mocks.beforeTranscriptCommit = undefined;
    mocks.stageSessionPendingInput.mockReset().mockImplementation(async (_scope, options) => {
      mocks.beforeTranscriptCommit?.();
      const message = options.prepareMessageAfterIdempotencyCheck
        ? options.prepareMessageAfterIdempotencyCheck(options.message)
        : options.message;
      if (!message) {
        return undefined;
      }
      mocks.persistedMessages.push(message);
      return {
        inputId: "pending-user-turn",
        message,
        run: <T>(operation: () => T) => operation(),
        finish: vi.fn(),
      };
    });
    mocks.persistSessionTranscriptTurn.mockReset().mockImplementation(async (scope, options) => {
      const pending = options.messages[0];
      const message = pending?.prepareMessageAfterIdempotencyCheck
        ? pending.prepareMessageAfterIdempotencyCheck(pending.message)
        : pending?.message;
      if (!message) {
        return { appendedCount: 0, messages: [], sessionEntry: scope.sessionEntry };
      }
      mocks.persistedMessages.push(message);
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

  it("does not append the user turn when delegated runtime authority closes at commit", async () => {
    const sessionKey = "agent:main:worker-child";
    const admittedSessionId = "worker-child-session";
    const sessionEntry: SessionEntry = { sessionId: admittedSessionId, updatedAt: 1 };
    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      storePath: "/tmp/sessions.json",
      canonicalKey: sessionKey,
      entry: sessionEntry,
      store: { [sessionKey]: sessionEntry },
    });
    let authorityActive = true;
    mocks.beforeTranscriptCommit = () => {
      authorityActive = false;
    };

    await expect(
      prepareAgentRunUserTurn({
        request: { message: "must not outlive the worker turn", idempotencyKey: "closed-run" },
        cfg: {},
        sessionEntry,
        resolvedSessionKey: sessionKey,
        admittedSessionId,
        activeSessionAgentId: "main",
        suppressVisibleSessionEffects: false,
        requestedPromptPersistenceSuppression: false,
        canUseInternalRuntimeHandoff: false,
        message: "must not outlive the worker turn",
        effectiveTranscriptInputText: "must not outlive the worker turn",
        images: [],
        offloadedRefs: [],
        runId: "closed-run",
        client: null,
        context: { logGateway: { warn: vi.fn() } } as unknown as AgentTurnContext,
        assertCurrent: () => {},
        assertRuntimeAuthorityCurrent: () => {
          if (!authorityActive) {
            throw new TypeError("agent runtime authority is no longer active");
          }
        },
      }),
    ).rejects.toThrow("agent runtime authority is no longer active");
    expect(mocks.persistedMessages).toEqual([]);
  });

  it("deletes persisted media when delegated runtime authority closes during persistence", async () => {
    let authorityActive = true;
    mocks.persistInboundImagesForTranscript.mockImplementationOnce(async () => {
      authorityActive = false;
      return { entries: [{ id: "revoked-media", fact: {} }] };
    });

    await expect(
      prepareAgentRunUserTurn({
        request: { message: "private image", idempotencyKey: "revoked-media-run" },
        cfg: {},
        sessionEntry: { sessionId: "revoked-media-session", updatedAt: 1 },
        resolvedSessionKey: "agent:main:worker-child",
        admittedSessionId: "revoked-media-session",
        activeSessionAgentId: "main",
        suppressVisibleSessionEffects: false,
        requestedPromptPersistenceSuppression: false,
        canUseInternalRuntimeHandoff: false,
        message: "private image",
        effectiveTranscriptInputText: "private image",
        images: [],
        offloadedRefs: [],
        runId: "revoked-media-run",
        client: null,
        context: { logGateway: { warn: vi.fn() } } as unknown as AgentTurnContext,
        assertCurrent: () => {},
        assertRuntimeAuthorityCurrent: () => {
          if (!authorityActive) {
            throw new TypeError("agent runtime authority is no longer active");
          }
        },
      }),
    ).rejects.toThrow("agent runtime authority is no longer active");
    expect(mocks.deleteMediaBuffer).toHaveBeenCalledWith("revoked-media", "inbound");
    expect(mocks.persistedMessages).toEqual([]);
  });
});
