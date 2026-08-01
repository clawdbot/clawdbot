import { describe, expect, it } from "vitest";
import { resolveQaLiveTurnTimeoutMs } from "./live-timeout.js";
import { readQaScenarioById } from "./scenario-catalog.js";
import { requireFlowScenario } from "./scenario-catalog.test-utils.js";

describe("live subagent scenario timeouts", () => {
  it.each([
    {
      id: "issue-109025-completion-policy-live",
      savedEvidence: "expectedFinalMarker",
    },
    {
      id: "issue-109025-sender-policy-live",
      savedEvidence: "childRow",
    },
  ])("uses the model-aware completion timeout for $id", ({ id, savedEvidence }) => {
    const scenario = requireFlowScenario(readQaScenarioById(id));
    const completionWait = scenario.execution.flow?.steps
      .flatMap((step) => step.actions)
      .find(
        (action) =>
          typeof action === "object" &&
          action !== null &&
          "call" in action &&
          action.call === "waitForCondition" &&
          "saveAs" in action &&
          action.saveAs === savedEvidence,
      );

    expect(scenario.execution.config?.requiredProviderMode).toBe("live-frontier");
    expect(scenario.execution.retryCount).toBe(0);
    expect(completionWait).toMatchObject({
      call: "waitForCondition",
      saveAs: savedEvidence,
      args: [expect.any(Object), { expr: "liveTurnTimeoutMs(env, 60000)" }, 250],
    });
  });

  it("applies the GPT-5 live floor without extending the mock fallback", () => {
    expect(
      resolveQaLiveTurnTimeoutMs(
        {
          providerMode: "live-frontier",
          primaryModel: "openai/gpt-5.4",
          alternateModel: "openai/gpt-5.4",
        },
        60_000,
      ),
    ).toBe(360_000);
    expect(
      resolveQaLiveTurnTimeoutMs(
        {
          providerMode: "mock-openai",
          primaryModel: "mock-openai/gpt-5.6-luna",
          alternateModel: "mock-openai/gpt-5.6-luna",
        },
        60_000,
      ),
    ).toBe(60_000);
  });
});
