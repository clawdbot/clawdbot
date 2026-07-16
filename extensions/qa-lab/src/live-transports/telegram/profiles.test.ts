import { describe, expect, it } from "vitest";
import {
  listTelegramQaScenarios,
  resolveTelegramQaScenarioIds,
  TELEGRAM_QA_ALL_SCENARIO_IDS,
} from "./profiles.js";

describe("Telegram QA profiles", () => {
  it("keeps release focused and adds the scripted long-final check for mock runs", () => {
    const live = resolveTelegramQaScenarioIds({ providerMode: "live-frontier" });
    const mock = resolveTelegramQaScenarioIds({ providerMode: "mock-openai" });

    expect(live).toContain("telegram-other-bot-command-gating");
    expect(live).not.toContain("telegram-long-final-reuses-preview");
    expect(mock).toEqual([...live, "telegram-long-final-reuses-preview"]);
  });

  it("selects every migrated Telegram scenario through all", () => {
    expect(resolveTelegramQaScenarioIds({ providerMode: "mock-openai", profile: "all" })).toEqual([
      ...TELEGRAM_QA_ALL_SCENARIO_IDS,
    ]);
  });

  it("lets explicit scenarios override profile selection", () => {
    expect(
      resolveTelegramQaScenarioIds({
        profile: "all",
        providerMode: "live-frontier",
        scenarioIds: ["telegram-status-command"],
      }),
    ).toEqual(["telegram-status-command"]);
  });

  it("rejects unknown profiles and scenarios before gateway startup", () => {
    expect(() =>
      resolveTelegramQaScenarioIds({ providerMode: "live-frontier", profile: "transport" }),
    ).toThrow('Unknown QA Lab Telegram profile "transport"');
    expect(() =>
      resolveTelegramQaScenarioIds({
        providerMode: "live-frontier",
        scenarioIds: ["telegram-missing"],
      }),
    ).toThrow("unknown Telegram QA scenario id(s): telegram-missing");
  });

  it("lists the YAML catalog with provider-specific release defaults", () => {
    const scenarios = listTelegramQaScenarios("mock-openai");

    expect(scenarios.map(({ id }) => id).toSorted()).toEqual(
      [...TELEGRAM_QA_ALL_SCENARIO_IDS].toSorted(),
    );
    expect(
      scenarios.find(({ id }) => id === "telegram-long-final-reuses-preview")?.defaultEnabled,
    ).toBe(true);
    expect(
      scenarios.find(({ id }) => id === "telegram-long-final-three-chunks")?.defaultEnabled,
    ).toBe(false);
  });
});
