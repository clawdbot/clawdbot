import { beforeEach, describe, expect, it, vi } from "vitest";

const { resolveExecutionSelection, resolveProfileScenarios } = vi.hoisted(() => ({
  resolveExecutionSelection: vi.fn(),
  resolveProfileScenarios: vi.fn(),
}));

vi.mock("../../profile-planning.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../profile-planning.js")>();
  return {
    ...actual,
    resolveQaProfileScenarios: (...args: Parameters<typeof actual.resolveQaProfileScenarios>) => {
      resolveProfileScenarios(...args);
      return actual.resolveQaProfileScenarios(...args);
    },
    resolveQaRunProfileExecutionSelection: (
      ...args: Parameters<typeof actual.resolveQaRunProfileExecutionSelection>
    ) => {
      resolveExecutionSelection(...args);
      return actual.resolveQaRunProfileExecutionSelection(...args);
    },
  };
});

import { scenarioDeclaresQaChannel } from "../../profile-planning.js";
import { readQaScenarioPack } from "../../scenario-catalog.js";
import { resolveDiscordQaScenarioIds } from "../discord/scenario-selection.js";
import { resolveSlackQaScenarioIds } from "../slack/scenario-selection.js";
import {
  listTelegramQaScenarios,
  resolveTelegramQaScenarioIds,
} from "../telegram/scenario-selection.js";
import { resolveWhatsAppQaScenarioIds } from "../whatsapp/scenario-selection.js";
import {
  resolveCatalogLiveTransportQaScenarioIds,
  resolveLiveTransportQaScenarioIds,
} from "./scenario-selection.js";

const MOCK_LANE = {
  providerMode: "mock-openai" as const,
  primaryModel: "mock-openai/gpt-5.6-luna",
};

describe("live transport QA scenario selection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    {
      channelId: "matrix",
      select: (scenarioIds?: readonly string[]) =>
        resolveCatalogLiveTransportQaScenarioIds({
          ...MOCK_LANE,
          channelId: "matrix",
          scenarioIds,
        }),
    },
    {
      channelId: "telegram",
      select: (scenarioIds?: readonly string[]) =>
        resolveTelegramQaScenarioIds({ ...MOCK_LANE, scenarioIds }),
    },
    {
      channelId: "discord",
      select: (scenarioIds?: readonly string[]) =>
        resolveDiscordQaScenarioIds({ ...MOCK_LANE, scenarioIds }),
    },
    {
      channelId: "slack",
      select: (scenarioIds?: readonly string[]) =>
        resolveSlackQaScenarioIds({ ...MOCK_LANE, scenarioIds }),
    },
    {
      channelId: "whatsapp",
      select: (scenarioIds?: readonly string[]) =>
        resolveWhatsAppQaScenarioIds({ ...MOCK_LANE, scenarioIds }),
    },
  ] as const)(
    "keeps explicit and implicit singleton eligibility aligned for $channelId",
    ({ channelId, select }) => {
      const scenarioIds = select();
      const singletonScenarioIds = scenarioIds.slice(0, 1);
      const scenarioById = new Map(
        readQaScenarioPack().scenarios.map((scenario) => [scenario.id, scenario] as const),
      );

      expect(singletonScenarioIds).toHaveLength(1);
      expect(
        scenarioIds.every((scenarioId) => {
          const scenario = scenarioById.get(scenarioId);
          return (
            scenario?.execution.kind === "flow" && scenarioDeclaresQaChannel(scenario, channelId)
          );
        }),
      ).toBe(true);
      expect(select(singletonScenarioIds)).toEqual(singletonScenarioIds);
    },
  );

  it("uses the exact requested model for profile selection and listing", () => {
    const primaryModel = "openai/custom-selection-model";

    resolveLiveTransportQaScenarioIds({
      channelId: "telegram",
      primaryModel,
      providerMode: "mock-openai",
    });
    expect(resolveProfileScenarios).toHaveBeenLastCalledWith(
      expect.objectContaining({ executionKind: "flow", primaryModel }),
    );

    listTelegramQaScenarios({ primaryModel, providerMode: "mock-openai" });
    expect(resolveExecutionSelection).toHaveBeenLastCalledWith(
      expect.objectContaining({ executionKind: "flow", primaryModel }),
    );
  });

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
