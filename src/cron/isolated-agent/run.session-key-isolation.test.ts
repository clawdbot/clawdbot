// Session key isolation tests cover separate keys for concurrent cron runs.
import { describe, expect, it } from "vitest";
import { makeIsolatedAgentJobFixture, makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./run.suite-helpers.js";
import {
  isCliProviderMock,
  loadSessionEntryMock,
  loadRunCronIsolatedAgentTurn,
  makeCronSession,
  makeCronSessionEntry,
  mockRunCronFallbackPassthrough,
  patchSessionEntryMock,
  resolveCronSessionMock,
  runCliAgentMock,
  runEmbeddedAgentMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

function requireFirstMockArg(mock: { mock: { calls: unknown[][] } }, label: string): unknown {
  const arg = mock.mock.calls[0]?.[0];
  if (arg === undefined) {
    throw new Error(`Expected ${label} to be called with a first argument`);
  }
  return arg;
}

describe("runCronIsolatedAgentTurn isolated session identity", () => {
  setupRunCronIsolatedAgentTurnSuite({ fast: true });

  it("uses a run-scoped key for embedded isolated cron execution", async () => {
    resolveCronSessionMock.mockReturnValue(
      makeCronSession({
        sessionEntry: {
          ...makeCronSession().sessionEntry,
          sessionId: "isolated-run-1",
        },
      }),
    );
    mockRunCronFallbackPassthrough();

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        sessionKey: "cron:daily-monitor",
        job: makeIsolatedAgentJobFixture({
          payload: {
            kind: "agentTurn",
            message: "test",
            lightContext: true,
          },
        }),
      }),
    );

    expect(result.status).toBe("ok");
    expect(result.sessionKey).toBe("agent:default:cron:daily-monitor:run:isolated-run-1");
    const sessionRequest = requireFirstMockArg(
      resolveCronSessionMock,
      "resolveCronSessionMock",
    ) as { forceNew?: boolean; sessionKey?: string };
    expect(sessionRequest.forceNew).toBe(true);
    expect(sessionRequest.sessionKey).toBe("agent:default:cron:daily-monitor");
    expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
    const runRequest = requireFirstMockArg(runEmbeddedAgentMock, "runEmbeddedAgentMock") as {
      sessionId?: string;
      sessionKey?: string;
      promptCacheKey?: string;
      bootstrapContextMode?: string;
      bootstrapContextRunKind?: string;
    };
    expect(runRequest.sessionId).toBe("isolated-run-1");
    expect(runRequest.sessionKey).toBe("agent:default:cron:daily-monitor:run:isolated-run-1");
    expect(runRequest.sessionKey).not.toBe("agent:default:cron:daily-monitor");
    expect(runRequest.promptCacheKey).toMatch(/^openclaw-cron-[a-f0-9]{32}$/u);
    expect(runRequest.promptCacheKey).not.toContain("isolated-run-1");
    expect(runRequest.promptCacheKey).not.toContain("daily-monitor");
    expect(runRequest.bootstrapContextMode).toBe("lightweight");
    expect(runRequest.bootstrapContextRunKind).toBe("cron");
    const embeddedRunOrder = runEmbeddedAgentMock.mock.invocationCallOrder[0];
    if (embeddedRunOrder === undefined) {
      throw new Error("Expected embedded cron execution order");
    }
    const requiredSessionKeys = [
      "agent:default:cron:daily-monitor",
      "agent:default:cron:daily-monitor:run:isolated-run-1",
    ];
    for (const sessionKey of requiredSessionKeys) {
      const persistIndex = patchSessionEntryMock.mock.calls.findIndex(
        ([scope]) => (scope as { sessionKey: string }).sessionKey === sessionKey,
      );
      expect(persistIndex).toBeGreaterThanOrEqual(0);
      const persistOrder = patchSessionEntryMock.mock.invocationCallOrder[persistIndex];
      if (persistOrder === undefined) {
        throw new Error(`Expected persistence order for ${sessionKey}`);
      }
      expect(persistOrder).toBeLessThan(embeddedRunOrder);
    }
  });

  it("keeps embedded isolated cron prompt-cache affinity stable across run sessions", async () => {
    resolveCronSessionMock
      .mockReturnValueOnce(
        makeCronSession({
          sessionEntry: {
            ...makeCronSession().sessionEntry,
            sessionId: "isolated-run-a",
          },
        }),
      )
      .mockReturnValueOnce(
        makeCronSession({
          sessionEntry: {
            ...makeCronSession().sessionEntry,
            sessionId: "isolated-run-b",
          },
        }),
      );
    mockRunCronFallbackPassthrough();

    const params = makeIsolatedAgentParamsFixture({
      sessionKey: "cron:daily-monitor",
      job: makeIsolatedAgentJobFixture({
        payload: {
          kind: "agentTurn",
          message: "test",
          lightContext: true,
        },
      }),
    });
    await runCronIsolatedAgentTurn(params);
    await runCronIsolatedAgentTurn(params);

    const requests = runEmbeddedAgentMock.mock.calls.map(
      ([arg]) =>
        arg as {
          sessionId?: string;
          sessionKey?: string;
          promptCacheKey?: string;
        },
    );
    expect(requests[0]?.sessionId).toBe("isolated-run-a");
    expect(requests[1]?.sessionId).toBe("isolated-run-b");
    expect(requests[0]?.sessionKey).not.toBe(requests[1]?.sessionKey);
    expect(requests[0]?.promptCacheKey).toBe(requests[1]?.promptCacheKey);
    expect(requests[0]?.promptCacheKey).toMatch(/^openclaw-cron-[a-f0-9]{32}$/u);
  });

  it("keeps explicit session-bound cron execution on the requested session key", async () => {
    resolveCronSessionMock.mockReturnValue(
      makeCronSession({
        sessionEntry: {
          ...makeCronSession().sessionEntry,
          sessionId: "bound-run-1",
        },
      }),
    );
    mockRunCronFallbackPassthrough();

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        sessionKey: "project-alpha-monitor",
        job: makeIsolatedAgentJobFixture({
          sessionTarget: "session:project-alpha-monitor",
        }),
      }),
    );

    expect(result.status).toBe("ok");
    expect(result.sessionKey).toBe("agent:default:project-alpha-monitor");
    expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
    const runRequest = requireFirstMockArg(runEmbeddedAgentMock, "runEmbeddedAgentMock") as {
      sessionId?: string;
      sessionKey?: string;
      promptCacheKey?: string;
      bootstrapContextMode?: string;
      bootstrapContextRunKind?: string;
    };
    expect(runRequest.sessionId).toBe("bound-run-1");
    expect(runRequest.sessionKey).toBe("agent:default:project-alpha-monitor");
    expect(runRequest.promptCacheKey).toBeUndefined();
    expect(runRequest.bootstrapContextMode).toBeUndefined();
    expect(runRequest.bootstrapContextRunKind).toBe("cron");
  });

  it.each([
    "harness:codex:supervision:native-thread",
    "agent:default:harness:codex:supervision:native-thread",
  ])("rejects detached execution for a missing reserved harness key %s", async (sessionKey) => {
    await expect(
      runCronIsolatedAgentTurn(
        makeIsolatedAgentParamsFixture({
          sessionKey,
          job: makeIsolatedAgentJobFixture({ sessionTarget: `session:${sessionKey}` }),
        }),
      ),
    ).rejects.toThrow(/reserved for agent harness-owned sessions/i);

    expect(resolveCronSessionMock).toHaveBeenCalledOnce();
    expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
  });

  it("continues a pre-existing unlocked harness-prefixed session as an ordinary session", async () => {
    const sessionKey = "agent:default:harness:legacy-notes";
    const legacyEntry = makeCronSessionEntry({
      agentHarnessId: "codex",
      sessionId: "legacy-session",
    });
    resolveCronSessionMock.mockReturnValue(
      makeCronSession({
        initialSessionEntry: legacyEntry,
        isNewSession: false,
        sessionEntry: { ...legacyEntry },
        store: { [sessionKey]: { ...legacyEntry } },
      }),
    );
    loadSessionEntryMock.mockReturnValue(legacyEntry);
    mockRunCronFallbackPassthrough();

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        sessionKey,
        job: makeIsolatedAgentJobFixture({ sessionTarget: `session:${sessionKey}` }),
      }),
    );

    expect(result.status).toBe("ok");
    expect(result.sessionKey).toBe(sessionKey);
    expect(resolveCronSessionMock).toHaveBeenCalledOnce();
    expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
  });

  it("rejects detached execution for an existing locked harness session", async () => {
    const sessionKey = "agent:default:harness:codex:supervision:native-thread";
    const protectedEntry = makeCronSessionEntry({
      agentHarnessId: "codex",
      modelSelectionLocked: true,
      sessionId: "native-session",
    });
    resolveCronSessionMock.mockReturnValue(
      makeCronSession({
        initialSessionEntry: protectedEntry,
        isNewSession: false,
        sessionEntry: protectedEntry,
        store: { [sessionKey]: protectedEntry },
      }),
    );

    await expect(
      runCronIsolatedAgentTurn(
        makeIsolatedAgentParamsFixture({
          sessionKey,
          job: makeIsolatedAgentJobFixture({ sessionTarget: `session:${sessionKey}` }),
        }),
      ),
    ).rejects.toThrow(/reserved for agent harness-owned sessions/i);

    expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
  });

  it("rejects detached execution for an existing locked ordinary session", async () => {
    const sessionKey = "agent:default:project-native-session";
    const protectedEntry = makeCronSessionEntry({
      agentHarnessId: "codex",
      modelSelectionLocked: true,
      sessionId: "native-session",
    });
    resolveCronSessionMock.mockReturnValue(
      makeCronSession({
        initialSessionEntry: protectedEntry,
        isNewSession: false,
        sessionEntry: protectedEntry,
        store: { [sessionKey]: protectedEntry },
      }),
    );

    await expect(
      runCronIsolatedAgentTurn(
        makeIsolatedAgentParamsFixture({
          sessionKey,
          job: makeIsolatedAgentJobFixture({ sessionTarget: `session:${sessionKey}` }),
        }),
      ),
    ).rejects.toThrow(/identity is locked and cannot be replaced or shared/i);

    expect(resolveCronSessionMock).toHaveBeenCalledOnce();
    expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
  });

  it("uses a run-scoped key for CLI isolated cron execution", async () => {
    isCliProviderMock.mockReturnValue(true);
    resolveCronSessionMock.mockReturnValue(
      makeCronSession({
        sessionEntry: {
          ...makeCronSession().sessionEntry,
          sessionId: "isolated-cli-run-1",
        },
      }),
    );
    mockRunCronFallbackPassthrough();
    runCliAgentMock.mockResolvedValue({
      payloads: [{ text: "done" }],
      meta: { agentMeta: { usage: { input: 10, output: 20 } } },
    });

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        sessionKey: "cron:cli-monitor",
        job: makeIsolatedAgentJobFixture({
          payload: {
            kind: "agentTurn",
            message: "test",
            lightContext: true,
          },
        }),
      }),
    );

    expect(result.status).toBe("ok");
    expect(result.sessionKey).toBe("agent:default:cron:cli-monitor:run:isolated-cli-run-1");
    expect(runCliAgentMock).toHaveBeenCalledOnce();
    const runRequest = requireFirstMockArg(runCliAgentMock, "runCliAgentMock") as {
      sessionId?: string;
      sessionKey?: string;
      promptCacheKey?: string;
      bootstrapContextMode?: string;
      bootstrapContextRunKind?: string;
      cleanupCliLiveSessionOnRunEnd?: boolean;
    };
    expect(runRequest.sessionId).toBe("isolated-cli-run-1");
    expect(runRequest.sessionKey).toBe("agent:default:cron:cli-monitor:run:isolated-cli-run-1");
    expect(runRequest.sessionKey).not.toBe("agent:default:cron:cli-monitor");
    expect(runRequest.promptCacheKey).toBeUndefined();
    expect(runRequest.bootstrapContextMode).toBe("lightweight");
    expect(runRequest.bootstrapContextRunKind).toBe("cron");
    expect(runRequest.cleanupCliLiveSessionOnRunEnd).toBe(true);
  });

  it("runs externally sourced CLI hook turns", async () => {
    isCliProviderMock.mockReturnValue(true);
    mockRunCronFallbackPassthrough();
    runCliAgentMock.mockResolvedValue({
      payloads: [{ text: "done" }],
      meta: { agentMeta: { usage: { input: 10, output: 20 } } },
    });

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        sessionKey: "hook:webhook:cli-monitor",
        job: makeIsolatedAgentJobFixture({
          payload: {
            kind: "agentTurn",
            message: "test",
            externalContentSource: "webhook",
          },
        }),
      }),
    );

    expect(result.status).toBe("ok");
    expect(runCliAgentMock).toHaveBeenCalledOnce();
  });
});
