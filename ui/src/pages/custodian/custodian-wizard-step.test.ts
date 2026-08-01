import { describe, expect, it } from "vitest";
import type { WizardStep } from "../../api/types.ts";
import { custodianWizardReply, initialCustodianWizardValue } from "./custodian-wizard-step.ts";

const options = [
  { label: "Discord", value: "discord" },
  { label: "Slack", value: "slack" },
  { label: "Twitch", value: "twitch" },
];

function step(patch: Partial<WizardStep>): WizardStep {
  return { id: "step", type: "select", options, ...patch };
}

describe("Custodian rich wizard answers", () => {
  it("uses stable option indexes for select and multiselect replies", () => {
    expect(custodianWizardReply(step({}), "twitch")).toEqual({
      message: "3",
      display: "Twitch",
    });
    expect(custodianWizardReply(step({ type: "multiselect" }), ["discord", "twitch"])).toEqual({
      message: "1,3",
      display: "Discord, Twitch",
    });
    expect(custodianWizardReply(step({ type: "multiselect" }), [])).toEqual({
      message: "none",
      display: "none",
    });
  });

  it("serializes confirm, text, and continue controls", () => {
    expect(custodianWizardReply(step({ type: "confirm" }), true)).toEqual({
      message: "yes",
      display: "Yes",
    });
    expect(custodianWizardReply(step({ type: "text" }), "secret")).toEqual({
      message: "secret",
      display: "secret",
    });
    expect(custodianWizardReply(step({ type: "action" }), undefined, false)).toEqual({
      message: "continue",
      display: "Continue",
    });
  });

  it("copies multiselect defaults and rejects values outside the step", () => {
    const initialValue = ["discord"];
    const value = initialCustodianWizardValue(
      step({ type: "multiselect", initialValue }),
    ) as unknown[];
    value.push("twitch");

    expect(initialValue).toEqual(["discord"]);
    expect(custodianWizardReply(step({}), "unknown")).toBeNull();
    expect(custodianWizardReply(step({ type: "multiselect" }), ["unknown"])).toBeNull();
  });
});
