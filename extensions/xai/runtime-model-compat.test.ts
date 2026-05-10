import { describe, expect, it } from "vitest";
import { applyXaiRuntimeModelCompat } from "./runtime-model-compat.js";

describe("xai runtime model compat", () => {
  it("maps OpenClaw thinking levels to xAI efforts for reasoning-capable models", () => {
    const model = applyXaiRuntimeModelCompat({
      id: "grok-4.3",
      provider: "xai",
      reasoning: true,
    });

    expect(model.thinkingLevelMap).toEqual({
      off: null,
      minimal: "low",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "high",
    });
  });

  it("suppresses reasoning efforts for non-reasoning models", () => {
    const model = applyXaiRuntimeModelCompat({
      id: "grok-4-fast-non-reasoning",
      provider: "xai",
      reasoning: false,
    });

    expect(model.thinkingLevelMap).toEqual({
      off: null,
      minimal: null,
      low: null,
      medium: null,
      high: null,
      xhigh: null,
    });
  });
});
