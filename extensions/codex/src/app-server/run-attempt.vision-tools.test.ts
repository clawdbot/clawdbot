// Codex tests cover run attempt.vision tools plugin behavior.
import { describe, expect, it } from "vitest";
import { filterCodexVisionTools } from "./vision-tools.js";

describe("Codex dynamic tool filtering", () => {
  it("drops the image tool when native Codex image inspection is active", () => {
    const toolNames = filterCodexVisionTools(
      [{ name: "image" }, { name: "read" }, { name: "write" }],
      {
        modelHasVision: true,
        nativeImageInspectionEnabled: true,
      },
    ).map((tool) => tool.name);

    expect(toolNames).toContain("read");
    expect(toolNames).toContain("write");
    expect(toolNames).not.toContain("image");
  });

  it("keeps the image tool when the model lacks vision or native image inspection is disabled", () => {
    const tools = [{ name: "image" }, { name: "read" }];

    expect(
      filterCodexVisionTools(tools, {
        modelHasVision: false,
        nativeImageInspectionEnabled: true,
      }),
    ).toBe(tools);
    expect(
      filterCodexVisionTools(tools, {
        modelHasVision: true,
        nativeImageInspectionEnabled: false,
      }),
    ).toBe(tools);
  });
});
