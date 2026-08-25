import { describe, expect, it } from "vitest";
import type { WizardStep } from "../../api/types.ts";
import { custodianWizardSubmission, initialCustodianWizardValue } from "./custodian-wizard-step.ts";

const options = [
  { label: "Discord", value: "discord" },
  { label: "Slack", value: "slack" },
  { label: "Twitch", value: "twitch" },
];

type InteractiveWizardStep = Exclude<WizardStep, { type: "qr" }>;

function step(patch: Partial<InteractiveWizardStep>): InteractiveWizardStep {
  return { id: "step", type: "select", options, ...patch };
}

describe("Custodian rich wizard answers", () => {
  it("preserves typed select and multiselect values", () => {
    expect(custodianWizardSubmission(step({}), "twitch")).toEqual({
      answer: { stepId: "step", value: "twitch" },
      display: "Twitch",
    });
    expect(custodianWizardSubmission(step({ type: "multiselect" }), ["discord", "twitch"])).toEqual(
      {
        answer: { stepId: "step", value: ["discord", "twitch"] },
        display: "Discord, Twitch",
      },
    );
    expect(custodianWizardSubmission(step({ type: "multiselect" }), [])).toEqual({
      answer: { stepId: "step", value: [] },
      display: "none",
    });
  });

  it("builds confirm, text, and continue submissions", () => {
    expect(custodianWizardSubmission(step({ type: "confirm" }), true)).toEqual({
      answer: { stepId: "step", value: true },
      display: "Yes",
    });
    expect(custodianWizardSubmission(step({ type: "text" }), "secret")).toEqual({
      answer: { stepId: "step", value: "secret" },
      display: "secret",
    });
    expect(custodianWizardSubmission(step({ type: "action" }), undefined)).toEqual({
      answer: { stepId: "step" },
      display: "Continue",
    });
    expect(
      custodianWizardSubmission(
        {
          id: "qr-step",
          type: "qr",
          qrDataUrl: "data:image/png;base64,aGVsbG8=",
          canCancel: true,
          executor: "gateway",
        },
        undefined,
      ),
    ).toBeNull();
  });

  it("copies multiselect defaults and rejects values outside the step", () => {
    const initialValue = ["discord"];
    const value = initialCustodianWizardValue(
      step({ type: "multiselect", initialValue }),
    ) as unknown[];
    value.push("twitch");

    expect(initialValue).toEqual(["discord"]);
    expect(custodianWizardSubmission(step({}), "unknown")).toBeNull();
    expect(custodianWizardSubmission(step({ type: "text" }), { secret: true })).toBeNull();
    expect(custodianWizardSubmission(step({ type: "multiselect" }), ["unknown"])).toBeNull();
  });
});
