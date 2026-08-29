import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  mockedBuildAgentRuntimePlan,
  mockedRunEmbeddedAttempt,
  overflowBaseRunParams,
  resetSharedRunIntegrationHarnessMocks,
  useOpenAIPlatformAuthFixture,
} from "./run.overflow-compaction.harness.js";
import { loadSharedRunIntegrationHarness } from "./run.shared-integration-harness.test-support.js";

let runEmbeddedAgent: Awaited<ReturnType<typeof loadSharedRunIntegrationHarness>>;

describe("runEmbeddedAgent retry-limit metadata", () => {
  beforeAll(async () => {
    runEmbeddedAgent = await loadSharedRunIntegrationHarness();
  });

  beforeEach(() => {
    resetSharedRunIntegrationHarnessMocks();
    useOpenAIPlatformAuthFixture();
  });

  it("reports the latest physical attempt after ordinary retry-budget exhaustion", async () => {
    let physicalAttempt = 0;
    mockedBuildAgentRuntimePlan.mockImplementation(() => {
      physicalAttempt += 1;
      const isLatestAttempt = physicalAttempt === 32;
      return {
        resolvedRef: { provider: "openai", modelId: "gpt-5.6-luna" },
        auth: {
          authProfileProviderForAuth: "openai",
          providerForAuth: "openai",
          credentialSource: isLatestAttempt
            ? {
                kind: "direct",
                evidence: "environment",
                authorization: "ambient",
              }
            : { kind: "profile" },
        },
        observability: {
          resolvedRef: "openai/gpt-5.6-luna",
          provider: "openai",
          modelId: "gpt-5.6-luna",
          harnessId: "codex",
        },
      } as never;
    });
    mockedRunEmbeddedAttempt.mockResolvedValue(
      makeAttemptResult({
        preflightRecovery: {
          route: "truncate_tool_results_only",
          source: "mid-turn",
          handled: true,
          truncatedCount: 0,
        },
      }),
    );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.6-luna",
      runId: "run-retry-limit-physical-attempt-meta",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(32);
    expect(result.meta.error?.kind).toBe("retry_limit");
    expect(result.meta.agentMeta).toMatchObject({
      provider: "openai",
      model: "gpt-5.6-luna",
      credentialSource: {
        kind: "direct",
        evidence: "environment",
        authorization: "ambient",
      },
    });
    expect(Object.keys(result.meta.agentMeta?.credentialSource ?? {}).toSorted()).toEqual([
      "authorization",
      "evidence",
      "kind",
    ]);
  });
});
