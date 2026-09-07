import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { AgentHarness } from "../harness/types.js";
import { makeAttemptResult, makeCompactionSuccess } from "./run.overflow-compaction.fixture.js";
import {
  createOverflowRunParams,
  mockedBuildAgentRuntimePlan,
  mockedBuildEmbeddedRunPayloads,
  mockedCompactDirect,
  mockedGetApiKeyForModel,
  mockedResolveAuthProfileOrder,
  mockedRunEmbeddedAttempt,
  resetSharedRunIntegrationHarnessMocks,
} from "./run.overflow-compaction.harness.js";
import {
  createSharedRunIntegrationSession,
  loadSharedRunIntegrationHarness,
} from "./run.shared-integration-harness.test-support.js";
import {
  clearActiveEmbeddedRun,
  resolveEmbeddedRunAbandonment,
  markActiveEmbeddedRunAbandoned,
  setActiveEmbeddedRun,
} from "./runs.js";
import { createEmbeddedRunHandle, testing as runsTesting } from "./runs.test-support.js";

let runEmbeddedAgent: Awaited<ReturnType<typeof loadSharedRunIntegrationHarness>>;

type CompactParams = {
  sessionId?: string;
  tokenBudget?: number;
  force?: boolean;
  compactionTarget?: string;
  runtimeContext?: {
    trigger?: string;
    attempt?: number;
    maxAttempts?: number;
    messageChannel?: string;
    currentThreadTs?: string;
    authProfileId?: string;
  };
};

describe("runEmbeddedAgent timeout recovery composition", () => {
  let fixture: Pick<OpenClawTestState, "cleanup"> | undefined;

  beforeAll(async () => {
    runEmbeddedAgent = await loadSharedRunIntegrationHarness();
  });

  beforeEach(() => {
    resetSharedRunIntegrationHarnessMocks();
    runsTesting.resetActiveEmbeddedRuns();
  });

  afterEach(async () => {
    try {
      await fixture?.cleanup();
    } finally {
      fixture = undefined;
    }
  });

  it("adopts a compacted transcript and retries with a continuation prompt", async () => {
    const session = await createSharedRunIntegrationSession();
    fixture = session;
    const successor = {
      ...session.runParams.sessionTarget,
      sessionId: "timeout-rotated-session",
    };
    mockedBuildEmbeddedRunPayloads.mockReturnValue([{ text: "timeout recovery complete" }]);
    mockedRunEmbeddedAttempt
      .mockImplementationOnce(async (params) => {
        params.onUserMessagePersisted?.({
          role: "user",
          content: "hello",
          timestamp: 1,
        });
        return makeAttemptResult({
          timedOut: true,
          lastAssistant: { usage: { input: 160_000 } } as never,
        });
      })
      .mockResolvedValueOnce(
        makeAttemptResult({
          promptError: null,
          sessionIdUsed: successor.sessionId,
          sessionFileUsed: successor.sessionKey,
        }),
      );
    mockedCompactDirect.mockResolvedValueOnce(
      makeCompactionSuccess({
        summary: "compacted for timeout",
        tokensBefore: 160_000,
        tokensAfter: 60_000,
        sessionTarget: successor,
      }),
    );

    const result = await runEmbeddedAgent({
      ...session.runParams,
      messageChannel: "slack",
      currentThreadTs: "thread-1",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(mockedRunEmbeddedAttempt.mock.calls[1]?.[0]).toMatchObject({
      sessionId: successor.sessionId,
      sessionFile: successor.sessionKey,
      sessionTarget: successor,
    });
    expect(mockedRunEmbeddedAttempt.mock.calls[1]?.[0]?.prompt).toContain(
      "Continue the current task from the existing transcript",
    );
    expect(mockedRunEmbeddedAttempt.mock.calls[1]?.[0]?.prompt).not.toBe(session.runParams.prompt);
    const compactParams = mockedCompactDirect.mock.calls[0]?.[0] as CompactParams | undefined;
    expect(compactParams).toMatchObject({
      sessionId: "test-session",
      tokenBudget: 200_000,
      force: true,
      compactionTarget: "budget",
      runtimeContext: {
        trigger: "timeout_recovery",
        attempt: 1,
        maxAttempts: 2,
        messageChannel: "slack",
        currentThreadTs: "thread-1",
      },
    });
    expect(result.meta.agentMeta?.compactionTokensAfter).toBe(60_000);
    expect(result.payloads).toEqual([{ text: "timeout recovery complete" }]);
  });

  it("restores terminal abandonment when retry preparation fails before registration", async () => {
    const session = await createSharedRunIntegrationSession();
    fixture = session;
    const preparationError = new Error("next attempt preparation failed");
    mockedRunEmbeddedAttempt.mockImplementationOnce(async (params) => {
      const handle = createEmbeddedRunHandle({ runId: params.runId });
      setActiveEmbeddedRun(params.sessionId, handle, params.sessionKey, params.sessionFile);
      expect(
        markActiveEmbeddedRunAbandoned({
          sessionId: params.sessionId,
          handle,
          sessionKey: params.sessionKey,
          sessionFile: params.sessionFile,
          reason: "timeout",
        }),
      ).toBe(true);
      clearActiveEmbeddedRun(params.sessionId, handle, params.sessionKey, params.sessionFile);
      return makeAttemptResult({
        timedOut: true,
        lastAssistant: { usage: { input: 160_000 } } as never,
      });
    });
    mockedCompactDirect.mockResolvedValueOnce(
      makeCompactionSuccess({
        summary: "compacted before failed retry preparation",
        tokensBefore: 160_000,
        tokensAfter: 60_000,
      }),
    );
    const defaultBuildRuntimePlan = mockedBuildAgentRuntimePlan.getMockImplementation();
    expect(defaultBuildRuntimePlan).toBeDefined();
    let buildCalls = 0;
    mockedBuildAgentRuntimePlan.mockImplementation(() => {
      buildCalls += 1;
      if (buildCalls === 2) {
        throw preparationError;
      }
      return defaultBuildRuntimePlan!();
    });

    await expect(runEmbeddedAgent(session.runParams)).rejects.toBe(preparationError);

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledOnce();
    expect(mockedBuildAgentRuntimePlan).toHaveBeenCalledTimes(2);
    expect(
      resolveEmbeddedRunAbandonment({
        sessionId: session.runParams.sessionId,
        sessionKey: session.runParams.sessionKey,
      }),
    ).toBe("timeout");
  });

  it("leaves timeout recovery to a forced unlocked Codex compaction owner", async () => {
    const { createOpenClawTestState } = await import("../../test-utils/openclaw-test-state.js");
    const state = await createOpenClawTestState({ label: "run.timeout-triggered-compaction" });
    fixture = state;
    const { clearAgentHarnesses, registerAgentHarness } = await import("../harness/registry.js");
    const pluginRunAttempt = vi.fn<AgentHarness["runAttempt"]>(async () =>
      makeAttemptResult({
        timedOut: true,
        lastAssistant: { usage: { input: 150_000 } } as never,
      }),
    );
    const nativeCompact = vi.fn<NonNullable<AgentHarness["compact"]>>(async () => ({
      ok: true,
      compacted: false,
    }));
    clearAgentHarnesses();
    registerAgentHarness({
      id: "codex",
      label: "Codex",
      supports: (ctx) =>
        ctx.provider === "openai" ? { supported: true, priority: 100 } : { supported: false },
      authBootstrap: "harness",
      runAttempt: pluginRunAttempt,
      compact: nativeCompact,
    });

    const result = await runEmbeddedAgent({
      ...createOverflowRunParams(state),
      provider: "openai",
      model: "gpt-5.5",
      config: { agents: { defaults: { agentRuntime: { id: "codex" } } } },
      runId: "forced-unlocked-codex-timeout-owner",
    }).finally(clearAgentHarnesses);

    expect(pluginRunAttempt).toHaveBeenCalledOnce();
    expect(mockedCompactDirect).not.toHaveBeenCalled();
    expect(nativeCompact).not.toHaveBeenCalled();
    expect(result.payloads?.[0]?.text).toContain("timed out");
  });

  it("keeps the timeout compaction cap across auth-profile rotation", async () => {
    const session = await createSharedRunIntegrationSession();
    fixture = session;
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    mockedResolveAuthProfileOrder.mockReturnValue(["profile-a", "profile-b"]);
    mockedGetApiKeyForModel.mockImplementation(async ({ profileId } = {}) => ({
      apiKey: "fixture",
      profileId: profileId ?? "profile-a",
      source: "test",
      mode: "api-key",
    }));
    mockedRunEmbeddedAttempt.mockResolvedValue(
      makeAttemptResult({
        timedOut: true,
        aborted: true,
        lastAssistant: { usage: { input: 150_000 } } as never,
      }),
    );
    mockedCompactDirect.mockResolvedValue({
      ok: false,
      compacted: false,
      reason: "nothing to compact",
    });

    const result = await runEmbeddedAgent(session.runParams);

    expect(mockedCompactDirect).toHaveBeenCalledTimes(2);
    expect(
      mockedCompactDirect.mock.calls.map(
        ([params]) => (params as CompactParams).runtimeContext?.authProfileId,
      ),
    ).toEqual(["profile-a", "profile-b"]);
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(3);
    expect(result.payloads?.[0]?.text).toContain("timed out");
  });

  it("lets one silent idle timeout retry before the normal timeout surface", async () => {
    const { createOpenClawTestState } = await import("../../test-utils/openclaw-test-state.js");
    const state = await createOpenClawTestState({ label: "run.timeout-triggered-compaction" });
    fixture = state;
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(
        makeAttemptResult({
          timedOut: true,
          idleTimedOut: true,
          assistantTexts: [],
          lastAssistant: { usage: { input: 20_000 } } as never,
        }),
      )
      .mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    const result = await runEmbeddedAgent(createOverflowRunParams(state));

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(mockedCompactDirect).not.toHaveBeenCalled();
    expect(result.payloads?.[0]?.isError).not.toBe(true);
  });
});
