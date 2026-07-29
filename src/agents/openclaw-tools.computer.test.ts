import { describe, expect, it } from "vitest";
import { createOpenClawTools } from "./openclaw-tools.js";

function computerTool(modelHasVision?: boolean) {
  return createOpenClawTools({
    modelHasVision,
    config: { agents: { entries: { main: { default: true } } } },
  }).find((tool) => tool.name === "computer");
}

describe("computer tool vision gating", () => {
  it("omits desktop input for models that cannot see the reference frame", () => {
    expect(computerTool(false)).toBeUndefined();
  });

  it("keeps the tool when vision is supported or not yet resolved", () => {
    expect(computerTool(true)).toBeDefined();
    expect(computerTool()).toBeDefined();
  });

  it("keeps screenshot results on the direct model-visible tool surface", () => {
    expect(computerTool(true)?.catalogMode).toBe("direct-only");
  });
});
