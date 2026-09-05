import { Compile } from "typebox/compile";
import { describe, expect, it } from "vitest";
import { WizardNextResultSchema } from "./wizard.js";

describe("WizardNextResultSchema", () => {
  const validate = Compile(WizardNextResultSchema);

  it.each([
    { preparedModelRef: "ollama/qwen3:0.6b" },
    { modelActivation: { modelRef: "openai/gpt-5.6-luna" } },
    { modelActivation: { modelRef: "openai/gpt-5.6-luna", gatewayRestartRequired: true } },
  ])("accepts an exact model outcome on a terminal result (%j)", (outcome) => {
    expect(
      validate.Check({
        done: true,
        status: "done",
        ...outcome,
      }),
    ).toBe(true);
  });

  it.each([
    { preparedModelRef: "" },
    { modelActivation: { modelRef: "" } },
    { modelActivation: { modelRef: "openai/gpt-5.6-luna", gatewayRestartRequired: false } },
    { modelActivation: { modelRef: "openai/gpt-5.6-luna", gatewayRestartRequired: "true" } },
    { modelActivation: { modelRef: "openai/gpt-5.6-luna", apiKey: "not-a-wire-field" } },
  ])("rejects malformed model outcomes (%j)", (outcome) => {
    expect(validate.Check({ done: true, status: "done", ...outcome })).toBe(false);
  });
});
