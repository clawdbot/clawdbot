import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyEmbeddedAttemptSessionIdentity } from "./attempt-session-identity.js";
import { buildContextEngineCompactionSessionTarget } from "./session-bootstrap.js";
import { createEmbeddedRunSessionPromptState } from "./session-prompt-state.js";

const sessionAccessorMocks = vi.hoisted(() => ({
  listSessionEntries: vi.fn(() => []),
  loadSessionEntry: vi.fn(),
}));

vi.mock("../../../config/sessions/session-accessor.js", () => sessionAccessorMocks);

beforeEach(() => {
  sessionAccessorMocks.listSessionEntries.mockReset().mockReturnValue([]);
  sessionAccessorMocks.loadSessionEntry.mockReset();
});

describe("buildContextEngineCompactionSessionTarget", () => {
  it("leaves the key absent when a marker has no stored mapping", () => {
    expect(
      buildContextEngineCompactionSessionTarget({
        sessionFile: "sqlite:main:marker-session:/tmp/sessions.json",
        sessionId: "stale-outer-session",
      }),
    ).toEqual({
      agentId: "main",
      sessionId: "marker-session",
      storePath: "/tmp/sessions.json",
    });
  });

  it("uses the configured default agent without inventing a session key", () => {
    expect(
      buildContextEngineCompactionSessionTarget({
        config: {
          agents: { list: [{ id: "main" }, { id: "worker", default: true }] },
          session: { store: "/tmp/{agentId}/sessions.json" },
        },
        sessionFile: "compat-session",
        sessionId: "compat-session",
      }),
    ).toEqual({
      agentId: "worker",
      sessionId: "compat-session",
      storePath: "/tmp/worker/sessions.json",
    });
  });

  it("preserves an adopted session id without inventing a session key", () => {
    expect(
      buildContextEngineCompactionSessionTarget({
        sessionFile: "",
        sessionId: "previous-session",
        sessionTarget: {
          agentId: "main",
          sessionId: "adopted-session",
          storePath: "/tmp/sessions.json",
        },
      }),
    ).toEqual({
      agentId: "main",
      sessionId: "adopted-session",
      storePath: "/tmp/sessions.json",
    });
  });
});

describe("createEmbeddedRunSessionPromptState", () => {
  it("keeps the admitted writer fence private across context-engine target adoption", () => {
    const state = createEmbeddedRunSessionPromptState({
      runParams: {
        agentId: "main",
        prompt: "hello",
        runId: "run-b",
        sessionFile: "agent:main:main",
        sessionId: "session-before",
        sessionKey: "agent:main:main",
        sessionTarget: {
          agentId: "main",
          expectedLifecycleRevision: "revision-a",
          expectedWriterRunId: "run-b",
          sessionId: "session-before",
          sessionKey: "agent:main:main",
          storePath: "/tmp/sessions.json",
        },
        timeoutMs: 30_000,
        workspaceDir: "/tmp",
      } as never,
      lifecycleGeneration: "generation-a",
      resolvedSessionKey: "agent:main:main",
      sessionAgentId: "main",
    });

    state.sessionTarget = {
      agentId: "main",
      sessionId: "session-after",
      sessionKey: "agent:main:main",
      storePath: "/tmp/sessions.json",
    };

    expect(state.sessionTarget).not.toHaveProperty("expectedWriterRunId");
    expect(state.sessionWriterFence).toEqual({
      expectedLifecycleRevision: "revision-a",
      expectedWriterRunId: "run-b",
    });
  });
});

function promptState(storePath = "/tmp/sessions.json") {
  return {
    sessionId: "session-before",
    sessionFile: "agent:main:main",
    sessionTarget: {
      agentId: "main",
      sessionId: "session-before",
      sessionKey: "agent:main:main",
      storePath,
    },
    adoptSessionId: vi.fn(),
  };
}

describe("applyEmbeddedAttemptSessionIdentity", () => {
  it("rejects a legacy successor file that cannot map to SQLite", () => {
    const state = promptState();

    expect(() =>
      applyEmbeddedAttemptSessionIdentity({
        sessionPromptState: state,
        sessionIdUsed: "session-after",
        sessionFileUsed: "/tmp/session-after.jsonl",
      }),
    ).toThrow("successor files are unsupported");
    expect(state.adoptSessionId).not.toHaveBeenCalled();
    expect(state.sessionTarget).toMatchObject({ sessionId: "session-before" });
  });

  it("resolves a legacy SQLite marker successor", () => {
    const state = promptState();

    applyEmbeddedAttemptSessionIdentity({
      sessionPromptState: state,
      sessionIdUsed: "session-after",
      sessionFileUsed: "sqlite:main:session-after:/tmp/sessions.json",
    });

    expect(state.sessionTarget).toMatchObject({
      agentId: "main",
      sessionId: "session-after",
      sessionKey: "agent:main:main",
      storePath: "/tmp/sessions.json",
    });
  });

  it("rebinds a legacy SQLite marker successor over the retained active entry", () => {
    sessionAccessorMocks.loadSessionEntry.mockReturnValue({
      sessionId: "session-before",
      updatedAt: 1,
    });
    const state = promptState();

    applyEmbeddedAttemptSessionIdentity({
      sessionPromptState: state,
      sessionIdUsed: "session-after",
      sessionFileUsed: "sqlite:main:session-after:/tmp/sessions.json",
    });

    expect(state.sessionTarget).toEqual({
      agentId: "main",
      sessionId: "session-after",
      sessionKey: "agent:main:main",
      storePath: "/tmp/sessions.json",
    });
  });

  it("rejects a legacy marker successor already mapped to another key", () => {
    sessionAccessorMocks.loadSessionEntry.mockReturnValue({
      sessionId: "session-before",
      updatedAt: 1,
    });
    sessionAccessorMocks.listSessionEntries.mockReturnValue([
      {
        sessionKey: "agent:main:other",
        entry: { sessionId: "session-after", updatedAt: 2 },
      },
    ] as never);
    const state = promptState();

    expect(() =>
      applyEmbeddedAttemptSessionIdentity({
        sessionPromptState: state,
        sessionIdUsed: "session-after",
        sessionFileUsed: "sqlite:main:session-after:/tmp/sessions.json",
      }),
    ).toThrow("successor target changed the active session binding");
  });

  it("rejects a legacy SQLite marker outside the active store", () => {
    const state = promptState();

    expect(() =>
      applyEmbeddedAttemptSessionIdentity({
        sessionPromptState: state,
        sessionIdUsed: "session-after",
        sessionFileUsed: "sqlite:main:session-after:/tmp/other-sessions.json",
      }),
    ).toThrow("successor target changed the active session binding");
  });

  it.each(["sqlite:other:session-after:/tmp/sessions.json", "agent:other:main"])(
    "rejects a cross-agent legacy successor identity: %s",
    (sessionFileUsed) => {
      const state = promptState();

      expect(() =>
        applyEmbeddedAttemptSessionIdentity({
          sessionPromptState: state,
          sessionIdUsed: "session-after",
          sessionFileUsed,
        }),
      ).toThrow(/successor (identity is inconsistent|files are unsupported)/u);
    },
  );

  it("retargets an id-only successor without discarding its SQLite identity", () => {
    const state = promptState();

    applyEmbeddedAttemptSessionIdentity({
      sessionPromptState: state,
      sessionIdUsed: "session-after",
    });

    expect(state.sessionTarget).toMatchObject({ sessionId: "session-after" });
  });

  it("refreshes a legacy marker for an id-only successor", () => {
    const state = promptState();
    state.sessionFile = "sqlite:main:session-before:/tmp/sessions.json";

    applyEmbeddedAttemptSessionIdentity({
      sessionPromptState: state,
      sessionIdUsed: "session-after",
    });

    expect(state.sessionFile).toBe("sqlite:main:session-after:/tmp/sessions.json");
    expect(state.sessionTarget).toMatchObject({ sessionId: "session-after" });
  });
});
