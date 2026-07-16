import { describe, expect, it } from "vitest";
import { telegramQaCliRegistration } from "./cli.js";
import { TELEGRAM_QA_ALL_SCENARIO_IDS } from "./profiles.js";

describe("Telegram QA CLI registration", () => {
  it("keeps the generic live baseline outside command profile selection", () => {
    expect(telegramQaCliRegistration.adapterFactory?.scenarioIds).toEqual([
      "channel-chat-baseline",
      ...TELEGRAM_QA_ALL_SCENARIO_IDS,
    ]);
    expect(TELEGRAM_QA_ALL_SCENARIO_IDS).not.toContain("channel-chat-baseline");
  });
});
