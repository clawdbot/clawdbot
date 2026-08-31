import { describe, expect, it } from "vitest";
import { readQaScenarioById, readQaScenarioPack } from "./scenario-catalog.js";

describe("QA Control UI browser scenario catalog", () => {
  const coverageId = "control-ui.gateway-hosted-ui-control";

  it("loads the screenshot and unread-body cancellation as a native Playwright scenario", () => {
    const scenario = readQaScenarioById("control-ui-browser-screenshot-body-cancel");

    expect(scenario.execution.kind).toBe("playwright");
    if (scenario.execution.kind !== "playwright") {
      throw new Error(`expected Playwright scenario, got ${scenario.execution.kind}`);
    }
    expect(scenario.execution.path).toBe("ui/src/e2e/browser-screenshot-body-cancel.e2e.test.ts");
    expect(scenario.execution.testNamePattern).toBe(
      "keeps the status error visible and cancels the unread media body",
    );
    expect(scenario.execution.flow).toBeUndefined();
    expect(scenario.coverage?.primary).not.toContain(coverageId);
    expect(scenario.coverage?.secondary).toContain(coverageId);
  });

  it("reserves primary hosted Control UI coverage for the real Gateway flow", () => {
    const primaryOwnerIds = readQaScenarioPack()
      .scenarios.filter((scenario) => scenario.coverage?.primary.includes(coverageId))
      .map((scenario) => scenario.id);

    expect(primaryOwnerIds).toStrictEqual(["control-ui-qa-channel-image-roundtrip"]);

    const hostedScenario = readQaScenarioById("control-ui-qa-channel-image-roundtrip");

    expect(hostedScenario.execution).toMatchObject({ kind: "flow", channel: "qa-channel" });
    expect(hostedScenario.coverage?.primary).toContain(coverageId);
  });
});
