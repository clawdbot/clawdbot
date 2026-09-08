import { describe, expect, it } from "vitest";
import { buildChannelWizardMocks } from "../../scripts/control-ui-mock-channels.ts";

describe("buildChannelWizardMocks", () => {
  it("starts a selected channel without showing the generic Telegram-first picker", () => {
    const mocks = buildChannelWizardMocks();
    const slack = mocks.start.cases.find(
      (candidate) => "channel" in candidate.match && candidate.match.channel === "slack",
    )?.response;

    expect(slack).toMatchObject({
      step: {
        id: "mock-wizard-step-slack",
        type: "note",
        message: "Continue to configure Slack.",
      },
    });
  });

  it.each(["telegram", "slack", "signal", "imessage"])(
    "completes direct %s setup as the selected channel",
    (channel) => {
      const mocks = buildChannelWizardMocks();
      const completion = mocks.next.cases.find(
        (candidate) =>
          "match" in candidate && candidate.match?.answer.stepId === `mock-wizard-step-${channel}`,
      );

      expect(completion).toEqual({
        match: { answer: { stepId: `mock-wizard-step-${channel}`, value: null } },
        response: { done: true, status: "done", channels: [channel] },
      });
    },
  );
});
