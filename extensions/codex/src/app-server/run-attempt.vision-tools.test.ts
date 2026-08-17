// Codex tests cover run attempt.vision tools plugin behavior.
import { describe, expect, it } from "vitest";
import { filterCodexVisionTools } from "./vision-tools.js";

describe("Codex dynamic tool filtering", () => {
  it.each([
    { modelHasVision: true, nativeImageInspectionEnabled: true },
    { modelHasVision: true, nativeImageInspectionEnabled: false },
    { modelHasVision: false, nativeImageInspectionEnabled: true },
    { modelHasVision: false, nativeImageInspectionEnabled: false },
  ])(
    "exposes exactly one view_image loader for vision=$modelHasVision native=$nativeImageInspectionEnabled",
    ({ modelHasVision, nativeImageInspectionEnabled }) => {
      const nativeOwnsViewImage = modelHasVision && nativeImageInspectionEnabled;
      const filteredTools = filterCodexVisionTools([{ name: "view_image" }, { name: "read" }], {
        modelHasVision,
        nativeImageInspectionEnabled,
      });
      const loaderNames = [
        ...(nativeOwnsViewImage ? ["view_image"] : []),
        ...filteredTools.map((tool) => tool.name).filter((name) => name === "view_image"),
      ];

      expect(loaderNames).toEqual(["view_image"]);
      expect(filteredTools.map((tool) => tool.name)).not.toContain("image");
      expect(filteredTools.map((tool) => tool.name)).toContain("read");
    },
  );
});
