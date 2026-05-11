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
    expect(resolveCronSessionMock.mock.calls[0]?.[0]?.forceNew).toBe(true);
    expect(resolveCronSessionMock.mock.calls[0]?.[0]?.sessionKey).toBe(
      "agent:default:cron:daily-monitor",
    );
    expect(runEmbeddedPiAgentMock).toHaveBeenCalledOnce();
    expect(runEmbeddedPiAgentMock.mock.calls[0]?.[0]?.sessionId).toBe("isolated-run-1");
    expect(runEmbeddedPiAgentMock.mock.calls[0]?.[0]?.sessionKey).toBe(
      "agent:default:cron:daily-monitor:run:isolated-run-1",
    );
    expect(runEmbeddedPiAgentMock.mock.calls[0]?.[0]?.sessionKey).not.toBe(
      "agent:default:cron:daily-monitor",
    );
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
    expect(runEmbeddedPiAgentMock.mock.calls[0]?.[0]?.sessionId).toBe("bound-run-1");
    expect(runEmbeddedPiAgentMock.mock.calls[0]?.[0]?.sessionKey).toBe(
      "agent:default:project-alpha-monitor",
    );
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
    expect(runCliAgentMock.mock.calls[0]?.[0]?.sessionId).toBe("isolated-cli-run-1");
    expect(runCliAgentMock.mock.calls[0]?.[0]?.sessionKey).toBe(
      "agent:default:cron:cli-monitor:run:isolated-cli-run-1",
    );
    expect(runCliAgentMock.mock.calls[0]?.[0]?.sessionKey).not.toBe(
      "agent:default:cron:cli-monitor",
    );
  });
});
