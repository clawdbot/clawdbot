// QA Lab tests cover canonical profile scheduling evidence.
import { describe, expect, it } from "vitest";
import { qaProfileEvidencePlan } from "./profile-evidence-plan.js";
import { readQaScenarioById } from "./scenario-catalog.js";
import { expandQaScenarioExecutionCells, type QaScenarioExecutionCell } from "./scenario-lane.js";

describe("QA profile evidence plan", () => {
  const portable = readQaScenarioById("thread-isolation");
  const native = readQaScenarioById("control-ui-chat-flow-playwright");
  const excluded = readQaScenarioById("matrix-room-block-streaming");

  function buildPlan(observedCells: QaScenarioExecutionCell[]) {
    return qaProfileEvidencePlan.build({
      profile: "all",
      membershipScenarios: [excluded, native, portable],
      selectedScenarios: [portable, native],
      excludedScenarios: [{ scenario: excluded, reasons: ["providerMode=mock-openai"] }],
      expectedCells: expandQaScenarioExecutionCells({
        scenarios: [portable, native],
        channelDriver: "live",
        supportsChannel: (channel) => channel === "matrix" || channel === "slack",
        expandChannels: true,
      }),
      observedCells,
    });
  }

  it("records a deterministic membership partition and exact execution cells", () => {
    const plan = buildPlan([
      { scenarioId: native.id, executionKind: "playwright", channel: null },
      { scenarioId: portable.id, executionKind: "flow", channel: "slack" },
    ]);

    expect(plan.counts).toEqual({
      membership: 3,
      selected: 2,
      excluded: 1,
      expectedCells: 3,
      observedCells: 2,
      missingCells: 1,
    });
    expect(plan.expectedCells).toEqual([
      { scenarioId: native.id, executionKind: "playwright", channel: null },
      { scenarioId: portable.id, executionKind: "flow", channel: "matrix" },
      { scenarioId: portable.id, executionKind: "flow", channel: "slack" },
    ]);
    expect(plan.missingCells).toEqual([
      { scenarioId: portable.id, executionKind: "flow", channel: "matrix" },
    ]);
    expect(() => qaProfileEvidencePlan.attest(plan, true)).toThrow(
      "successful QA profile evidence is missing 1 expected execution cell",
    );
  });

  it("accepts complete plans and rejects unexpected or non-canonical cells", () => {
    const complete = buildPlan([
      { scenarioId: portable.id, executionKind: "flow", channel: "slack" },
      { scenarioId: portable.id, executionKind: "flow", channel: "matrix" },
      { scenarioId: native.id, executionKind: "playwright", channel: null },
    ]);
    expect(qaProfileEvidencePlan.attest(complete, true).plan).toEqual(complete);

    expect(() =>
      buildPlan([
        ...complete.observedCells,
        { scenarioId: portable.id, executionKind: "flow", channel: "telegram" },
      ]),
    ).toThrow("unexpected execution cells invalidate evidence");
    expect(
      qaProfileEvidencePlan.schema.safeParse({
        ...complete,
        expectedCells: complete.expectedCells.toReversed(),
      }).success,
    ).toBe(false);
  });

  it("normalizes object key order before workflow hashing", () => {
    const plan = buildPlan([
      { scenarioId: native.id, executionKind: "playwright", channel: null },
      { scenarioId: portable.id, executionKind: "flow", channel: "matrix" },
      { scenarioId: portable.id, executionKind: "flow", channel: "slack" },
    ]);
    const reordered = Object.fromEntries(Object.entries(plan).toReversed());

    expect(qaProfileEvidencePlan.attest(reordered, true)).toEqual(
      qaProfileEvidencePlan.attest(plan, true),
    );
  });
});
