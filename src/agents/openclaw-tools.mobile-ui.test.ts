import { describe, expect, it } from "vitest";
import { createOpenClawTools } from "./openclaw-tools.js";

function mobileUiTool(modelHasVision?: boolean) {
  return createOpenClawTools({ modelHasVision }).find((tool) => tool.name === "mobile_ui");
}

describe("mobile UI tool registration", () => {
  it("registers the tool for non-embedded runs independent of model vision", () => {
    expect(mobileUiTool(false)).toBeDefined();
    expect(mobileUiTool(true)).toBeDefined();
    expect(mobileUiTool()).toBeDefined();
  });

  it("keeps one-action-at-a-time execution explicit", () => {
    expect(mobileUiTool()?.executionMode).toBe("sequential");
  });
});
