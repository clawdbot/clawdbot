import { describe, expect, it } from "vitest";
import { readQaScenarioPack } from "../../scenario-catalog.js";
import { listTelegramQaScenarios, resolveTelegramQaScenarioIds } from "./scenario-selection.js";

describe("Telegram QA profiles", () => {
  it("derives release membership from taxonomy and provider eligibility", () => {
    const live = resolveTelegramQaScenarioIds({ providerMode: "live-frontier" });
    const mock = resolveTelegramQaScenarioIds({ providerMode: "mock-openai" });

    expect(live).toContain("telegram-other-bot-command-gating");
    expect(live).not.toContain("telegram-long-final-reuses-preview");
    expect(mock).toContain("telegram-long-final-reuses-preview");
    expect(mock).toContain("telegram-assistant-transcript-role-boundary");
    expect(mock).not.toContain("telegram-startup-getme-live");
  });

  it("selects every taxonomy-owned executable Telegram scenario through all", () => {
    const scenarioIds = resolveTelegramQaScenarioIds({
      providerMode: "mock-openai",
      profile: "all",
    });

    expect(scenarioIds).toContain("channel-message-flows");
    expect(scenarioIds).toContain("native-command-session-target");
  });

  it("lets explicit scenarios override profile selection", () => {
    expect(
      resolveTelegramQaScenarioIds({
        profile: "release",
        providerMode: "live-frontier",
        scenarioIds: ["telegram-help-command"],
      }),
    ).toEqual(["telegram-help-command"]);
    expect(() =>
      resolveTelegramQaScenarioIds({
        profile: "release",
        providerMode: "live-frontier",
        scenarioIds: ["telegram-startup-getme-live"],
      }),
    ).toThrow("Telegram QA flow runner cannot execute non-flow scenario(s)");
  });

  it("rejects unknown profiles and channel-ineligible explicit scenarios", () => {
    expect(() =>
      resolveTelegramQaScenarioIds({ providerMode: "live-frontier", profile: "transport" }),
    ).toThrow("QA run profile must be one of");
    expect(() =>
      resolveTelegramQaScenarioIds({
        providerMode: "live-frontier",
        scenarioIds: ["channel-chat-baseline"],
      }),
    ).toThrow("cannot run ineligible scenario(s)");
  });

  it("lists catalog-eligible scenarios with provider-specific release defaults", () => {
    const scenarios = listTelegramQaScenarios("mock-openai");
    const defaultIds = new Set(resolveTelegramQaScenarioIds({ providerMode: "mock-openai" }));
    const scenarioById = new Map(
      readQaScenarioPack().scenarios.map((scenario) => [scenario.id, scenario] as const),
    );

    expect(
      new Set(scenarios.filter(({ defaultEnabled }) => defaultEnabled).map(({ id }) => id)),
    ).toEqual(defaultIds);
    expect(scenarios.every(({ id }) => scenarioById.get(id)?.execution.kind === "flow")).toBe(true);
    expect(
      scenarios.find(({ id }) => id === "telegram-long-final-reuses-preview")?.defaultEnabled,
    ).toBe(true);
    expect(
      scenarios.find(({ id }) => id === "telegram-long-final-three-chunks")?.defaultEnabled,
    ).toBe(true);
    expect(scenarios.some(({ id }) => id === "telegram-startup-getme-live")).toBe(false);
    expect(scenarioById.get("telegram-startup-getme-live")?.execution.kind).toBe("script");
  });
});
