import { describe, expect, it } from "vitest";
import { readQaScenarioPack } from "../../scenario-catalog.js";
import { listTelegramQaScenarios, resolveTelegramQaScenarioIds } from "./scenario-selection.js";

describe("Telegram QA profiles", () => {
  it.each(["mock-openai", "live-frontier"] as const)(
    "keeps the default %s command on flow scenarios",
    (providerMode) => {
      const scenarioIds = resolveTelegramQaScenarioIds({ providerMode });

      expect(scenarioIds).toContain("channel-canary");
      expect(scenarioIds).toContain("telegram-other-bot-command-gating");
      expect(scenarioIds).not.toContain("telegram-startup-getme-live");
      expect(() =>
        resolveTelegramQaScenarioIds({
          providerMode,
          scenarioIds: ["telegram-startup-getme-live"],
        }),
      ).toThrow("execution.kind=flow");
    },
  );

  it("derives provider-specific release membership from taxonomy", () => {
    const live = resolveTelegramQaScenarioIds({ providerMode: "live-frontier" });
    const mock = resolveTelegramQaScenarioIds({ providerMode: "mock-openai" });

    expect(mock).toHaveLength(19);
    expect(live).not.toContain("telegram-long-final-reuses-preview");
    expect(mock).toContain("telegram-long-final-reuses-preview");
    expect(mock).not.toContain("telegram-assistant-transcript-role-boundary");
    expect(mock).not.toContain("telegram-startup-getme-live");
  });

  it("selects every taxonomy-owned executable Telegram scenario through all", () => {
    const scenarioIds = resolveTelegramQaScenarioIds({
      providerMode: "mock-openai",
      profile: "all",
    });

    expect(scenarioIds).toContain("channel-message-flows");
    expect(scenarioIds).not.toContain("native-command-session-target");
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
    ).toThrow("execution.kind=flow");
    expect(
      resolveTelegramQaScenarioIds({
        profile: "release",
        providerMode: "mock-openai",
        scenarioIds: ["channel-canary"],
      }),
    ).toEqual(["channel-canary"]);
  });

  it("selects the native queue-validation regression as an explicit live scenario", () => {
    expect(
      resolveTelegramQaScenarioIds({
        profile: "release",
        providerMode: "live-frontier",
        scenarioIds: ["telegram-queue-invalid-mode"],
      }),
    ).toEqual(["telegram-queue-invalid-mode"]);
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
    const scenarios = listTelegramQaScenarios({ providerMode: "mock-openai" });
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
    expect(scenarios.map(({ id }) => id)).not.toContain("telegram-startup-getme-live");
    expect(scenarioById.get("telegram-startup-getme-live")?.execution.kind).toBe("script");
  });
});
