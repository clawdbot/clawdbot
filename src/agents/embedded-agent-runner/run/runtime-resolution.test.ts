import { describe, expect, it } from "vitest";
import {
  resolveInitialThinkLevel,
  resolveRequestStreamTransportOverrides,
} from "./runtime-resolution.js";

describe("resolveRequestStreamTransportOverrides", () => {
  it("marks non-empty request stream parameters for OpenClaw routing", () => {
    expect(resolveRequestStreamTransportOverrides({ maxTokens: 64 })).toBe("present");
  });

  it("keeps an empty request stream parameter record on the implicit runtime route", () => {
    expect(resolveRequestStreamTransportOverrides({})).toBeUndefined();
  });
});

describe("resolveInitialThinkLevel", () => {
  it("preserves logical Ultra until the provider runtime boundary", () => {
    expect(
      resolveInitialThinkLevel({
        requested: "ultra",
        config: {},
        provider: "openai",
        modelId: "gpt-5.5",
        model: { reasoning: true },
      }),
    ).toBe("ultra");
  });
});
