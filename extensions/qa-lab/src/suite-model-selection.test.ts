// QA Lab tests cover suite model-pair resolution.
import { describe, expect, it } from "vitest";
import { resolveRequestedQaSuiteModels } from "./suite-model-selection.js";

describe("resolveRequestedQaSuiteModels", () => {
  it("derives Luna after an explicit Sol primary", () => {
    expect(
      resolveRequestedQaSuiteModels({
        providerMode: "live-frontier",
        primaryModel: "openai/gpt-5.6-sol",
        scenarios: [],
      }),
    ).toMatchObject({
      primaryModel: "openai/gpt-5.6-sol",
      alternateModel: "openai/gpt-5.6-luna",
    });
  });

  it("preserves an explicit alternate", () => {
    expect(
      resolveRequestedQaSuiteModels({
        providerMode: "live-frontier",
        primaryModel: "openai/gpt-5.6-luna",
        alternateModel: "openai/gpt-5.6-terra",
        scenarios: [],
      }),
    ).toMatchObject({
      primaryModel: "openai/gpt-5.6-luna",
      alternateModel: "openai/gpt-5.6-terra",
    });
  });
});
