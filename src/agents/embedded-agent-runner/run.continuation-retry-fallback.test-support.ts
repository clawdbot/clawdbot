import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetAgentEventsForTest } from "../../infra/agent-events.js";
import { expectRecordFields, mockCallArg } from "./run.continuation-fixture.test-support.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  mockedBuildEmbeddedRunPayloads,
  mockedCoerceToFailoverError,
  mockedCompactDirect,
  mockedDescribeFailoverError,
  mockedEnsureAuthProfileStoreWithoutExternalProfiles,
  mockedPickFallbackThinkingLevel,
  mockedResolveFailoverStatus,
  mockedRunEmbeddedAttempt,
  overflowBaseRunParams,
  resetRunOverflowCompactionHarnessMocks,
} from "./run.overflow-compaction.harness.js";
import { loadSharedRunIntegrationHarness } from "./run.shared-integration-harness.test-support.js";

let runEmbeddedAgent: typeof import("./run.js").runEmbeddedAgent;

describe("runEmbeddedAgent retry and fallback continuation", () => {
  beforeAll(async () => {
    runEmbeddedAgent = await loadSharedRunIntegrationHarness();
  });

  beforeEach(() => {
    resetAgentEventsForTest();
    resetRunOverflowCompactionHarnessMocks();
    mockedBuildEmbeddedRunPayloads.mockReturnValue([{ text: "ok" }]);
  });

  it("returns retry_limit when repeated retries never converge", async () => {
    mockedRunEmbeddedAttempt.mockClear();
    mockedCompactDirect.mockClear();
    mockedPickFallbackThinkingLevel.mockReset();
    mockedPickFallbackThinkingLevel.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockResolvedValue(
      makeAttemptResult({
        promptError: new Error("unsupported reasoning mode"),
      }),
    );
    mockedPickFallbackThinkingLevel.mockReturnValue("low");

    const result = await runEmbeddedAgent(overflowBaseRunParams);

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(32);
    expect(mockedCompactDirect).not.toHaveBeenCalled();
    expect(result.meta.error?.kind).toBe("retry_limit");
    expect(result.meta.livenessState).toBe("blocked");
    expect(result.payloads?.[0]?.isError).toBe(true);
  });

  it("terminates without replay after side effects invalidate the attempt", async () => {
    mockedRunEmbeddedAttempt.mockClear();
    mockedCompactDirect.mockClear();
    mockedPickFallbackThinkingLevel.mockReset();
    mockedPickFallbackThinkingLevel.mockReturnValue("low");
    mockedRunEmbeddedAttempt.mockResolvedValue(
      makeAttemptResult({
        promptError: new Error("unsupported reasoning mode"),
        replayMetadata: {
          hadPotentialSideEffects: true,
          replaySafe: false,
        },
      }),
    );

    const result = await runEmbeddedAgent(overflowBaseRunParams);

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(mockedCompactDirect).not.toHaveBeenCalled();
    expect(result.meta.error).toBeUndefined();
    expect(result.meta.replayInvalid).toBe(true);
    expect(result.meta.livenessState).toBe("working");
    expect(result.payloads).toEqual([{ text: "ok" }]);
  });

  it("normalizes abort-wrapped prompt errors before handing off to model fallback", async () => {
    const promptError = Object.assign(new Error("request aborted"), {
      name: "AbortError",
      cause: {
        error: {
          code: 429,
          message: "Resource has been exhausted (e.g. check quota).",
          status: "RESOURCE_EXHAUSTED",
        },
      },
    });
    const normalized = Object.assign(new Error("Resource has been exhausted (e.g. check quota)."), {
      name: "FailoverError",
      reason: "rate_limit",
      status: 429,
    });

    mockedRunEmbeddedAttempt.mockResolvedValue(makeAttemptResult({ promptError }));
    mockedEnsureAuthProfileStoreWithoutExternalProfiles.mockReturnValue({
      version: 1,
      profiles: {
        "test-profile": {
          provider: "anthropic",
          type: "oauth",
          access: "access",
          refresh: "refresh",
          expires: Date.now() + 60_000,
        },
      },
    });
    mockedCoerceToFailoverError.mockReturnValue(normalized);
    mockedDescribeFailoverError.mockImplementation((err: unknown) => ({
      message: err instanceof Error ? err.message : String(err),
      reason: err === normalized ? "rate_limit" : undefined,
      status: err === normalized ? 429 : undefined,
      code: undefined,
    }));
    mockedResolveFailoverStatus.mockReturnValue(429);

    await expect(
      runEmbeddedAgent({
        ...overflowBaseRunParams,
        config: {
          agents: {
            defaults: {
              model: {
                fallbacks: ["openai/gpt-5.2"],
              },
            },
          },
        },
      }),
    ).rejects.toBe(normalized);

    expect(mockCallArg(mockedCoerceToFailoverError)).toBe(promptError);
    expectRecordFields(mockCallArg(mockedCoerceToFailoverError, 0, 1), {
      provider: "anthropic",
      model: "test-model",
      profileId: "test-profile",
      authMode: "oauth",
    });
    expect(mockedResolveFailoverStatus).toHaveBeenCalledWith("rate_limit");
  });
});
