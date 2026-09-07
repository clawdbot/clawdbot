import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  mockedBuildAgentRuntimePlan,
  mockedRunEmbeddedAttempt,
  createOverflowRunParams,
  resetSharedRunIntegrationHarnessMocks,
  useOpenAIPlatformAuthFixture,
} from "./run.overflow-compaction.harness.js";
import { loadSharedRunIntegrationHarness } from "./run.shared-integration-harness.test-support.js";

let state: OpenClawTestState;
let runEmbeddedAgent: Awaited<ReturnType<typeof loadSharedRunIntegrationHarness>>;

describe("runEmbeddedAgent retry-limit metadata", () => {
  beforeAll(async () => {
    runEmbeddedAgent = await loadSharedRunIntegrationHarness();
  });

  beforeEach(async () => {
    resetSharedRunIntegrationHarnessMocks();
    const { createOpenClawTestState } = await import("../../test-utils/openclaw-test-state.js");
    state = await createOpenClawTestState({ label: "run.retry-limit" });
    useOpenAIPlatformAuthFixture();
  });

  afterEach(async () => {
    await state?.cleanup();
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
      ...createOverflowRunParams(state),
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
