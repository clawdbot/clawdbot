import { describe, expect, it } from "vitest";
import {
  LIVE_TRANSPORT_BASELINE_STANDARD_SCENARIO_IDS,
  collectLiveTransportStandardScenarioCoverage,
  findMissingLiveTransportStandardScenarios,
  selectLiveTransportScenarios,
} from "./live-transport-scenarios.js";

describe("live transport scenario helpers", () => {
  it("keeps the repo-wide baseline contract ordered", () => {
    expect(LIVE_TRANSPORT_BASELINE_STANDARD_SCENARIO_IDS).toEqual([
      "canary",
      "mention-gating",
      "allowlist-block",
      "top-level-reply-shape",
      "restart-resume",
    ]);
  });

  it("selects requested scenarios and reports unknown ids with the lane label", () => {
    const definitions = [
      { id: "alpha", timeoutMs: 1_000, title: "alpha" },
      { id: "beta", timeoutMs: 1_000, title: "beta" },
    ] as const;

    expect(
      selectLiveTransportScenarios({
        ids: ["beta"],
        laneLabel: "Demo",
        scenarios: definitions,
      }),
    ).toEqual([definitions[1]]);

    expect(() =>
      selectLiveTransportScenarios({
        ids: ["alpha", "missing"],
        laneLabel: "Demo",
        scenarios: definitions,
      }),
    ).toThrow("unknown Demo QA scenario id(s): missing");
  });

  it("dedupes always-on and scenario-backed standard coverage", () => {
    const covered = collectLiveTransportStandardScenarioCoverage({
      alwaysOnStandardScenarioIds: ["canary"],
      scenarios: [
        {
          id: "scenario-1",
          standardId: "mention-gating",
          timeoutMs: 1_000,
          title: "mention",
        },
        {
          id: "scenario-2",
          standardId: "mention-gating",
          timeoutMs: 1_000,
          title: "mention again",
        },
        {
          id: "scenario-3",
          standardId: "restart-resume",
          timeoutMs: 1_000,
          title: "restart",
        },
      ],
    });

    expect(covered).toEqual(["canary", "mention-gating", "restart-resume"]);
    expect(
      findMissingLiveTransportStandardScenarios({
        coveredStandardScenarioIds: covered,
        expectedStandardScenarioIds: LIVE_TRANSPORT_BASELINE_STANDARD_SCENARIO_IDS,
      }),
    ).toEqual(["allowlist-block", "top-level-reply-shape"]);
  });
});
