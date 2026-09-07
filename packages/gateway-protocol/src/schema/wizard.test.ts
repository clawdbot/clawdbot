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

  it.each(["auth", "rate_limit", "billing", "timeout", "format", "unavailable", "unknown"])(
    "accepts an owner-recorded pre-promotion rejection (%s)",
    (status) => {
      expect(
        validate.Check({
          done: true,
          status: "error",
          error: "The candidate did not pass its live test.",
          activationRejection: { disposition: "rejected-before-promotion", status },
        }),
      ).toBe(true);
    },
  );

  it.each([
    { disposition: "rejected-before-promotion", status: "ok" },
    { disposition: "rejected-before-promotion", status: "invented" },
    { disposition: "no-mutation", status: "auth" },
    { disposition: "rejected-before-promotion" },
    { status: "auth" },
    { disposition: "rejected-before-promotion", status: "auth", apiKey: "not-a-wire-field" },
  ])("rejects malformed activation rejection evidence (%j)", (activationRejection) => {
    expect(validate.Check({ done: true, status: "error", activationRejection })).toBe(false);
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
