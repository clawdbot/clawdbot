import { describe, expect, it } from "vitest";
import {
  makeIsolatedAgentTurnJob,
  makeIsolatedAgentTurnParams,
  setupRunCronIsolatedAgentTurnSuite,
} from "./run.suite-helpers.js";
import {
  isCliProviderMock,
  loadRunCronIsolatedAgentTurn,
  makeCronSession,
  mockRunCronFallbackPassthrough,
  resolveCronSessionMock,
  runCliAgentMock,
  runEmbeddedPiAgentMock,
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
  setupRunCronIsolatedAgentTurnSuite();

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
      makeIsolatedAgentTurnParams({
        sessionKey: "cron:daily-monitor",
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
    expect(runEmbeddedPiAgentMock).toHaveBeenCalledOnce();
    const runRequest = requireFirstMockArg(runEmbeddedPiAgentMock, "runEmbeddedPiAgentMock") as {
      sessionId?: string;
      sessionKey?: string;
    };
    expect(runRequest.sessionId).toBe("isolated-run-1");
    expect(runRequest.sessionKey).toBe("agent:default:cron:daily-monitor:run:isolated-run-1");
    expect(runRequest.sessionKey).not.toBe("agent:default:cron:daily-monitor");
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
      makeIsolatedAgentTurnParams({
        sessionKey: "project-alpha-monitor",
        job: makeIsolatedAgentTurnJob({
          sessionTarget: "session:project-alpha-monitor",
        }),
      }),
    );

    expect(result.status).toBe("ok");
    expect(result.sessionKey).toBe("agent:default:project-alpha-monitor");
    expect(runEmbeddedPiAgentMock).toHaveBeenCalledOnce();
    const runRequest = requireFirstMockArg(runEmbeddedPiAgentMock, "runEmbeddedPiAgentMock") as {
      sessionId?: string;
      sessionKey?: string;
    };
    expect(runRequest.sessionId).toBe("bound-run-1");
    expect(runRequest.sessionKey).toBe("agent:default:project-alpha-monitor");
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
      makeIsolatedAgentTurnParams({
        sessionKey: "cron:cli-monitor",
      }),
    );

    expect(result.status).toBe("ok");
    expect(result.sessionKey).toBe("agent:default:cron:cli-monitor:run:isolated-cli-run-1");
    expect(runCliAgentMock).toHaveBeenCalledOnce();
    const runRequest = requireFirstMockArg(runCliAgentMock, "runCliAgentMock") as {
      sessionId?: string;
      sessionKey?: string;
      senderIsOwner?: boolean;
    };
    expect(runRequest.sessionId).toBe("isolated-cli-run-1");
    expect(runRequest.sessionKey).toBe("agent:default:cron:cli-monitor:run:isolated-cli-run-1");
    expect(runRequest.sessionKey).not.toBe("agent:default:cron:cli-monitor");
    expect(runRequest.senderIsOwner).toBe(true);
  });

  it("runs externally sourced CLI hook turns without owner tool authority", async () => {
    isCliProviderMock.mockReturnValue(true);
    mockRunCronFallbackPassthrough();
    runCliAgentMock.mockResolvedValue({
      payloads: [{ text: "done" }],
      meta: { agentMeta: { usage: { input: 10, output: 20 } } },
    });

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentTurnParams({
        sessionKey: "hook:webhook:cli-monitor",
        job: makeIsolatedAgentTurnJob({
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
    const runRequest = requireFirstMockArg(runCliAgentMock, "runCliAgentMock") as {
      senderIsOwner?: boolean;
    };
    expect(runRequest.senderIsOwner).toBe(false);
  });
});
