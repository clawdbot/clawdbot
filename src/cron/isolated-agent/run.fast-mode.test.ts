import { describe, expect, it } from "vitest";
import {
  makeIsolatedAgentTurnJob,
  makeIsolatedAgentTurnParams,
  setupRunCronIsolatedAgentTurnSuite,
} from "./run.suite-helpers.js";
import {
  loadRunCronIsolatedAgentTurn,
  makeCronSession,
  retireSessionMcpRuntimeMock,
  resolveFastModeStateMock,
  resolveCronSessionMock,
  runEmbeddedPiAgentMock,
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
        meta: { agentMeta: { usage: { input: 10, output: 20 } } },
      },
      provider,
      model,
      attempts: [],
    };
  });
}

async function runFastModeCase(params: {
  configFastMode: boolean;
  expectedFastMode: boolean;
  expectedCleanupBundleMcpOnRunEnd?: boolean;
  expectedRetiredSessionId?: string;
  message: string;
  previousSessionId?: string;
  sessionId?: string;
  sessionFastMode?: boolean;
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
    if (typeof sessionFastMode === "boolean") {
      return { enabled: sessionFastMode };
    }
    return {
      enabled: Boolean(cfg.agents?.defaults?.models?.[OPENAI_GPT4_MODEL]?.params?.fastMode),
    };
  });

  const result = await runCronIsolatedAgentTurn(
    makeIsolatedAgentTurnParams({
      cfg: {
        agents: {
          defaults: {
            models: {
              [OPENAI_GPT4_MODEL]: {
                params: {
                  fastMode: params.configFastMode,
                },
              },
            },
          },
        },
      },
      job: makeIsolatedAgentTurnJob({
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
  expect(runEmbeddedPiAgentMock).toHaveBeenCalledOnce();
  expect(runEmbeddedPiAgentMock.mock.calls[0][0]).toMatchObject({
    provider: "openai",
    model: EXPECTED_OPENAI_MODEL,
    fastMode: params.expectedFastMode,
    cleanupBundleMcpOnRunEnd: params.expectedCleanupBundleMcpOnRunEnd ?? true,
    allowGatewaySubagentBinding: true,
  });
  if (params.expectedRetiredSessionId) {
    expect(retireSessionMcpRuntimeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: params.expectedRetiredSessionId,
        reason: "cron-session-rollover",
      }),
    );
    return;
  }
  expect(retireSessionMcpRuntimeMock).not.toHaveBeenCalled();
}

describe("runCronIsolatedAgentTurn — fast mode", () => {
  setupRunCronIsolatedAgentTurnSuite();

  it("passes config-driven fast mode into embedded cron runs", async () => {
    await runFastModeCase({
      configFastMode: true,
      expectedFastMode: true,
      message: "test fast mode",
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
