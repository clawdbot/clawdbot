import { describe, expect, it } from "vitest";
import { scenarioDeclaresQaChannel } from "../../profile-planning.js";
import { readQaScenarioPack } from "../../scenario-catalog.js";
import { resolveCatalogLiveTransportQaScenarioIds } from "./scenario-selection.js";

const MOCK_LANE = {
  providerMode: "mock-openai" as const,
  primaryModel: "mock-openai/gpt-5.6-luna",
};

describe("catalog live transport QA scenario selection", () => {
  it.each(["matrix", "telegram"] as const)(
    "selects declared %s scenarios and preserves an explicit subset",
    (channelId) => {
      const scenarioIds = resolveCatalogLiveTransportQaScenarioIds({
        ...MOCK_LANE,
        channelId,
      });
      const explicitScenarioIds = scenarioIds.slice(0, 2).toReversed();
      const scenarioById = new Map(
        readQaScenarioPack().scenarios.map((scenario) => [scenario.id, scenario] as const),
      );

      expect(scenarioIds.length).toBeGreaterThan(1);
      expect(
        scenarioIds.every((scenarioId) => {
          const scenario = scenarioById.get(scenarioId);
          return (
            scenario?.execution.kind === "flow" && scenarioDeclaresQaChannel(scenario, channelId)
          );
        }),
      ).toBe(true);
      expect(
        resolveCatalogLiveTransportQaScenarioIds({
          ...MOCK_LANE,
          channelId,
          scenarioIds: explicitScenarioIds,
        }),
      ).toEqual(explicitScenarioIds);
    },
  );

  it.each([
    { channelId: "matrix", scenarioId: "whatsapp-whoami-command", mismatch: "channel=whatsapp" },
    {
      channelId: "telegram",
      scenarioId: "anthropic-opus-api-key-smoke",
      mismatch: "provider=anthropic",
    },
  ] as const)(
    "rejects $scenarioId from the $channelId lane",
    ({ channelId, scenarioId, mismatch }) => {
      expect(() =>
        resolveCatalogLiveTransportQaScenarioIds({
          ...MOCK_LANE,
          channelId,
          scenarioIds: [scenarioId],
        }),
      ).toThrow(mismatch);
    },
  );

  it.each([
    { channelId: "matrix", scenarioId: "thread-follow-up" },
    { channelId: "telegram", scenarioId: "channel-message-flows" },
  ] as const)(
    "keeps $scenarioId eligible through both $channelId drivers",
    ({ channelId, scenarioId }) => {
      const selectForDriver = (channelDriver: "crabline" | "live") =>
        resolveCatalogLiveTransportQaScenarioIds({
          ...MOCK_LANE,
          channelId,
          channelDriver,
          scenarioIds: [scenarioId],
        });

      expect(selectForDriver("live")).toEqual([scenarioId]);
      expect(selectForDriver("crabline")).toEqual([scenarioId]);
    },
  );
});
