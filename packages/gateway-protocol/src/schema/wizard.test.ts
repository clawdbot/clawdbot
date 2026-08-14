import { Compile } from "typebox/compile";
import { describe, expect, it } from "vitest";
import { WizardNextResultSchema } from "./wizard.js";

describe("WizardNextResultSchema", () => {
  const validate = Compile(WizardNextResultSchema);

  it("accepts an exact prepared model on a terminal result", () => {
    expect(
      validate.Check({
        done: true,
        status: "done",
        preparedModelRef: "ollama/qwen3:0.6b",
      }),
    ).toBe(true);
  });

  it("rejects an empty prepared model reference", () => {
    expect(validate.Check({ done: true, status: "done", preparedModelRef: "" })).toBe(false);
  });
});
