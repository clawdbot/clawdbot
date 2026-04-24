import { describe, expect, it } from "vitest";
import { filterToolsForVisionInputs } from "./vision-tools.js";

describe("Codex dynamic tool filtering", () => {
  it("drops the image tool when the model already has inbound vision input", () => {
    const toolNames = filterToolsForVisionInputs(
      [{ name: "image" }, { name: "read" }, { name: "write" }],
      {
        modelHasVision: true,
        hasInboundImages: true,
      },
    ).map((tool) => tool.name);

    expect(toolNames).toContain("read");
    expect(toolNames).toContain("write");
    expect(toolNames).not.toContain("image");
  });

  it("keeps the image tool unless both model vision and inbound images are present", () => {
    const tools = [{ name: "image" }, { name: "read" }];

    expect(
      filterToolsForVisionInputs(tools, {
        modelHasVision: false,
        hasInboundImages: true,
      }),
    ).toBe(tools);
    expect(
      filterToolsForVisionInputs(tools, {
        modelHasVision: true,
        hasInboundImages: false,
      }),
    ).toBe(tools);
  });
});
