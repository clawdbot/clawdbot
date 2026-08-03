import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentHarness } from "../harness/types.js";
import { makeAttemptResult, makeCompactionSuccess } from "./run.overflow-compaction.fixture.js";
import {
  mockedCompactDirect,
  mockedGetApiKeyForModel,
  mockedResolveAuthProfileOrder,
  mockedRunEmbeddedAttempt,
  overflowBaseRunParams,
  resetSharedRunIntegrationHarnessMocks,
} from "./run.overflow-compaction.harness.js";
import { loadSharedRunIntegrationHarness } from "./run.shared-integration-harness.test-support.js";

let runEmbeddedAgent: typeof import("./run.js").runEmbeddedAgent;

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
  beforeAll(async () => {
    runEmbeddedAgent = await loadSharedRunIntegrationHarness();
  });

  beforeEach(() => {
    resetSharedRunIntegrationHarnessMocks();
  });

  it("adopts a compacted transcript and retries with the complete runtime context", async () => {
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(
        makeAttemptResult({
          timedOut: true,
          lastAssistant: { usage: { input: 160_000 } } as never,
        }),
      )
      .mockResolvedValueOnce(
        makeAttemptResult({
          promptError: null,
          sessionIdUsed: "timeout-rotated-session",
          sessionFileUsed: "/tmp/timeout-rotated-session.json",
        }),
      );
    mockedCompactDirect.mockResolvedValueOnce(
      makeCompactionSuccess({
        summary: "compacted for timeout",
        tokensBefore: 160_000,
        tokensAfter: 60_000,
        sessionId: "timeout-rotated-session",
        sessionFile: "/tmp/timeout-rotated-session.json",
      }),
    );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      messageChannel: "slack",
      currentThreadTs: "thread-1",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(mockedRunEmbeddedAttempt.mock.calls[1]?.[0]).toMatchObject({
      sessionId: "timeout-rotated-session",
      sessionFile: "/tmp/timeout-rotated-session.json",
    });
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
  });

  it("leaves timeout recovery to a forced unlocked Codex compaction owner", async () => {
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
      ...overflowBaseRunParams,
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

    const result = await runEmbeddedAgent(overflowBaseRunParams);

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

    const result = await runEmbeddedAgent(overflowBaseRunParams);

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(mockedCompactDirect).not.toHaveBeenCalled();
    expect(result.payloads?.[0]?.isError).not.toBe(true);
  });
});
