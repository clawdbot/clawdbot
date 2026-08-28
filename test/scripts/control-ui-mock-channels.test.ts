import { describe, expect, it } from "vitest";
import { buildChannelWizardMocks } from "../../scripts/control-ui-mock-channels.ts";

describe("buildChannelWizardMocks", () => {
  it("starts a selected channel without showing the generic Telegram-first picker", () => {
    const mocks = buildChannelWizardMocks();
    const slack = mocks.start.cases.find(
      (candidate) => candidate.match.channel === "slack",
    )?.response;

    expect(slack).toMatchObject({
      step: {
        id: "mock-wizard-step-slack",
        type: "note",
        message: "Continue to configure Slack.",
      },
    });
  });
});
