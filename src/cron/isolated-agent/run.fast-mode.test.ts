// Fast mode tests cover isolated cron run behavior in fast execution mode.
import { describe, expect, it } from "vitest";
import { makeIsolatedAgentJobFixture, makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./run.suite-helpers.js";
import {
  loadRunCronIsolatedAgentTurn,
  makeCronSession,
  callGatewayMock,
  dispatchCronDeliveryMock,
  retireSessionMcpRuntimeMock,
  resolveCronDeliveryPlanMock,
  resolveFastModeStateMock,
  resolveCronSessionMock,
  runEmbeddedAgentMock,
  runWithModelFallbackMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

const OPENAI_GPT4_MODEL = "openai/gpt-4";
const EXPECTED_OPENAI_MODEL = "gpt-5.4";

function mockSuccessfulModelFallback() {
  runWithModelFallbackMock.mockImplementation(async ({ provider, model, run }) => {
    await run(provider, model);
    return {
      result: {
        payloads: [{ text: "ok" }],
        meta: { agentMeta: {} },
      },
      provider,
      model,
      attempts: [],
    };
  });
}

function requireFirstMockCall<T>(mock: { mock: { calls: T[][] } }, label: string): T[] {
  const call = mock.mock.calls[0];
  if (!call) {
    throw new Error(`expected ${label} call`);
  }
  return call;
}

async function runFastModeCase(params: {
  configFastMode: boolean | "auto";
  configFastAutoOnSeconds?: number;
  expectedFastMode: boolean | "auto";
  expectedFastModeAutoOnSeconds?: number;
  expectedCleanupBundleMcpOnRunEnd?: boolean;
  expectedRetiredSessionId?: string;
  message: string;
  previousSessionId?: string;
  sessionId?: string;
  sessionFastMode?: boolean | "auto";
  sessionTarget?: string;
}) {
  const baseSession = makeCronSession();
  resolveCronSessionMock.mockReturnValue(
    makeCronSession({
      ...baseSession,
      ...(params.previousSessionId ? { previousSessionId: params.previousSessionId } : {}),
      sessionEntry: {
        ...baseSession.sessionEntry,
        ...(params.sessionId ? { sessionId: params.sessionId } : {}),
        ...(params.sessionFastMode === undefined ? {} : { fastMode: params.sessionFastMode }),
      },
    }),
  );
  mockSuccessfulModelFallback();
  resolveFastModeStateMock.mockImplementation(({ cfg, sessionEntry }) => {
    const sessionFastMode = sessionEntry?.fastMode;
    if (typeof sessionFastMode === "boolean" || sessionFastMode === "auto") {
      return {
        mode: sessionFastMode,
        enabled: sessionFastMode === "auto" ? true : sessionFastMode,
        source: "session",
        fastAutoOnSeconds: params.configFastAutoOnSeconds ?? 60,
      };
    }
    const mode = cfg.agents?.defaults?.models?.[OPENAI_GPT4_MODEL]?.params?.fastMode;
    return {
      mode,
      enabled: mode === "auto" ? true : Boolean(mode),
      source: "config",
      fastAutoOnSeconds: params.configFastAutoOnSeconds ?? 60,
    };
  });

  const result = await runCronIsolatedAgentTurn(
    makeIsolatedAgentParamsFixture({
      cfg: {
        agents: {
          defaults: {
            models: {
              [OPENAI_GPT4_MODEL]: {
                params: {
                  fastMode: params.configFastMode,
                  ...(params.configFastAutoOnSeconds === undefined
                    ? {}
                    : { fastAutoOnSeconds: params.configFastAutoOnSeconds }),
                },
              },
            },
          },
        },
      },
      job: makeIsolatedAgentJobFixture({
        sessionTarget: params.sessionTarget ?? "isolated",
        payload: {
          kind: "agentTurn",
          message: params.message,
          model: OPENAI_GPT4_MODEL,
        },
      }),
    }),
  );

  expect(result.status).toBe("ok");
  expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
  const [embeddedRunParams] = requireFirstMockCall(runEmbeddedAgentMock, "embedded run");
  expect(embeddedRunParams.provider).toBe("openai");
  expect(embeddedRunParams.model).toBe(EXPECTED_OPENAI_MODEL);
  expect(embeddedRunParams.fastMode).toBe(params.expectedFastMode);
  expect(embeddedRunParams.fastModeAutoOnSeconds).toBe(params.expectedFastModeAutoOnSeconds ?? 60);
  expect(embeddedRunParams.cleanupBundleMcpOnRunEnd).toBe(
    params.expectedCleanupBundleMcpOnRunEnd ?? true,
  );
  expect(embeddedRunParams.allowGatewaySubagentBinding).toBe(true);
  const isIsolated = (params.sessionTarget ?? "isolated") === "isolated";
  if (params.expectedRetiredSessionId) {
    expect(retireSessionMcpRuntimeMock).toHaveBeenCalledOnce();
    const [retireParams] = requireFirstMockCall(
      retireSessionMcpRuntimeMock,
      "retire session mcp runtime",
    );
    expect(retireParams.sessionId).toBe(params.expectedRetiredSessionId);
    expect(retireParams.reason).toBe("cron-session-rollover");
    return;
  }
  if (isIsolated) {
    // disposeCronRunContext now retires MCP for isolated sessions
    expect(retireSessionMcpRuntimeMock).toHaveBeenCalledOnce();
    const [disposeRetireParams] = requireFirstMockCall(
      retireSessionMcpRuntimeMock,
      "dispose retire session mcp runtime",
    );
    expect(disposeRetireParams.reason).toBe("isolated-cron-dispose");
  } else {
    expect(retireSessionMcpRuntimeMock).not.toHaveBeenCalled();
  }
}

describe("runCronIsolatedAgentTurn — fast mode", () => {
  setupRunCronIsolatedAgentTurnSuite({ fast: true });

  it("deletes the run-scoped cron session after delivery-none deleteAfterRun jobs", async () => {
    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        job: makeIsolatedAgentJobFixture({
          deleteAfterRun: true,
          delivery: { mode: "none" },
          payload: { kind: "agentTurn", message: "cleanup me", model: OPENAI_GPT4_MODEL },
        }),
      }),
    );

    expect(result.status).toBe("ok");
    expect(callGatewayMock).toHaveBeenCalledWith({
      method: "sessions.delete",
      params: {
        key: "agent:default:cron:test",
        deleteTranscript: true,
        emitLifecycleHooks: false,
        expectedSessionId: "test-session-id",
        expectedLifecycleRevision: "test-lifecycle-revision",
        expectedSessionUpdatedAt: 0,
      },
      timeoutMs: 10_000,
    });
  });

  it("does not repeat deleteAfterRun cleanup after dispatch already handled it", async () => {
    resolveCronDeliveryPlanMock.mockReturnValue({
      requested: true,
      mode: "announce",
      channel: "messagechat",
      to: "test-target",
    });
    dispatchCronDeliveryMock.mockImplementationOnce(
      ({ deliveryPayloads, summary, outputText, synthesizedText }) => ({
        delivered: true,
        deliveryAttempted: true,
        cronRunSessionCleanupAttempted: true,
        summary,
        outputText,
        synthesizedText,
        deliveryPayloads,
      }),
    );

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        job: makeIsolatedAgentJobFixture({
          deleteAfterRun: true,
          delivery: { mode: "announce", channel: "messagechat", to: "test-target" },
          payload: { kind: "agentTurn", message: "cleanup once", model: OPENAI_GPT4_MODEL },
        }),
      }),
    );

    expect(result.status).toBe("ok");
    expect(dispatchCronDeliveryMock).toHaveBeenCalledOnce();
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("passes config-driven fast mode into embedded cron runs", async () => {
    await runFastModeCase({
      configFastMode: true,
      expectedFastMode: true,
      message: "test fast mode",
    });
  });

  it("passes config-driven fast auto cutoff into embedded cron runs", async () => {
    await runFastModeCase({
      configFastMode: "auto",
      configFastAutoOnSeconds: 30,
      expectedFastMode: "auto",
      expectedFastModeAutoOnSeconds: 30,
      message: "test fast auto mode",
    });
  });

  it("honors session fastMode=false over config fastMode=true", async () => {
    await runFastModeCase({
      configFastMode: true,
      expectedFastMode: false,
      message: "test fast mode override",
      sessionFastMode: false,
    });
  });

  it("honors session fastMode=true over config fastMode=false", async () => {
    await runFastModeCase({
      configFastMode: false,
      expectedFastMode: true,
      message: "test fast mode session override",
      sessionFastMode: true,
    });
  });

  it("preserves bundled MCP runtime state for persistent cron session targets", async () => {
    await runFastModeCase({
      configFastMode: true,
      expectedFastMode: true,
      expectedCleanupBundleMcpOnRunEnd: false,
      message: "test persistent cron session",
      sessionTarget: "session:agent:main:main:thread:9999",
    });
  });

  it("retires the previous bundled MCP runtime when a persistent cron session rolls over", async () => {
    await runFastModeCase({
      configFastMode: true,
      expectedFastMode: true,
      expectedCleanupBundleMcpOnRunEnd: false,
      expectedRetiredSessionId: "stale-session-id",
      message: "test persistent cron session rollover",
      previousSessionId: "stale-session-id",
      sessionId: "rotated-session-id",
      sessionTarget: "session:agent:main:main:thread:9999",
    });
  });
});
