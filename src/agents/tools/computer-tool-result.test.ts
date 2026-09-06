import { describe, expect, it } from "vitest";
import { getImageMetadata } from "../../media/image-ops.js";
import { createSolidPngBuffer } from "../../plugin-sdk/test-helpers/image-fixtures.js";
import { projectScreenshotResult } from "./computer-tool-result.js";

describe("computer screenshot dimensions", () => {
  it.each([
    [1024, 768, 1200, 1024, 768, true],
    [1080, 1920, 1280, 720, 1280, true],
    [1200, 1243, 1200, 1158, 1200, true],
    [1, 3, 1, 1, 1, true],
    [32, 16, 1200, 32, 16, false],
  ] as const)(
    "reports %dx%d at cap %d as the delivered %dx%d image",
    async (width, height, referenceWidth, deliveredWidth, deliveredHeight, reportsDimensions) => {
      const { result } = await projectScreenshotResult({
        capture: {
          base64: createSolidPngBuffer(width, height, { r: 70, g: 125, b: 180 }).toString("base64"),
          mimeType: "image/png",
          displayFrameId: "display-frame",
          ...(reportsDimensions ? { width, height } : {}),
        },
        target: { nodeId: "desktop-node", screenIndex: 0 },
        action: "screenshot",
        noteLines: [],
        referenceWidth,
      });
      const image = result.content.find((block) => block.type === "image");
      if (!image) {
        throw new Error("The screenshot image is missing");
      }
      const metadata = await getImageMetadata(Buffer.from(image.data, "base64"));
      expect(metadata).toMatchObject({ width: deliveredWidth, height: deliveredHeight });
      expect(result.details).toMatchObject({
        width: deliveredWidth,
        height: deliveredHeight,
        refWidth: referenceWidth,
      });
      expect(result.content).toContainEqual({
        type: "text",
        text: expect.stringContaining(`screenshot ${deliveredWidth}x${deliveredHeight}`),
      });
    },
  );
});
