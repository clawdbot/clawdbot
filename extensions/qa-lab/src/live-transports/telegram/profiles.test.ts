import { describe, expect, it } from "vitest";
import { listQaScenariosForExecutionProfile } from "../../scenario-catalog.js";
import { listTelegramQaScenarios, resolveTelegramQaScenarioIds } from "./profiles.js";

describe("Telegram QA profiles", () => {
  it("keeps release focused and adds the scripted long-final check for mock runs", () => {
    const live = resolveTelegramQaScenarioIds({ providerMode: "live-frontier" });
    const mock = resolveTelegramQaScenarioIds({ providerMode: "mock-openai" });

    expect(live).toContain("telegram-other-bot-command-gating");
    expect(live).not.toContain("telegram-long-final-reuses-preview");
    expect(mock).toEqual([...live, "telegram-long-final-reuses-preview"]);
  });

  it("selects every migrated Telegram scenario through all", () => {
    expect(resolveTelegramQaScenarioIds({ providerMode: "mock-openai", profile: "all" })).toEqual(
      listQaScenariosForExecutionProfile("telegram:all").map((scenario) => scenario.id),
    );
  });

  it("lets explicit scenarios override profile selection", () => {
    expect(
      resolveTelegramQaScenarioIds({
        profile: "release",
        providerMode: "live-frontier",
        scenarioIds: ["thread-follow-up"],
      }),
    ).toEqual(["thread-follow-up"]);
  });

  it("rejects unknown profiles and leaves explicit scenario validation to the suite catalog", () => {
    expect(() =>
      resolveTelegramQaScenarioIds({ providerMode: "live-frontier", profile: "transport" }),
    ).toThrow('Unknown QA Lab Telegram profile "transport"');
    expect(
      resolveTelegramQaScenarioIds({
        providerMode: "live-frontier",
        scenarioIds: ["channel-chat-baseline"],
      }),
    ).toEqual(["channel-chat-baseline"]);
  });

  it("lists the YAML catalog with provider-specific release defaults", () => {
    const scenarios = listTelegramQaScenarios("mock-openai");

    expect(scenarios.map(({ id }) => id).toSorted()).toEqual(
      listQaScenariosForExecutionProfile("telegram:all")
        .map((scenario) => scenario.id)
        .toSorted(),
    );
    expect(
      scenarios.find(({ id }) => id === "telegram-long-final-reuses-preview")?.defaultEnabled,
    ).toBe(true);
    expect(
      scenarios.find(({ id }) => id === "telegram-long-final-three-chunks")?.defaultEnabled,
    ).toBe(false);
  });
});
