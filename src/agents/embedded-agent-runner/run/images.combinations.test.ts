import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createSolidPngBuffer } from "../../../../test/helpers/image-fixtures.js";
import { detectAndLoadPromptImages } from "./images.js";

const HYDRATION_PARTS = ["inline", "offloaded", "suppressed", "explicit", "legacy"] as const;
type HydrationPart = (typeof HYDRATION_PARTS)[number];
type HydrationCombination = { name: string; parts: readonly HydrationPart[] };

function combinations<T>(values: readonly T[], size: number): T[][] {
  if (size === 0) {
    return [[]];
  }
  return values.flatMap((value, index) =>
    combinations(values.slice(index + 1), size - 1).map((tail) => [value].concat(tail)),
  );
}

const HYDRATION_COMBINATIONS: HydrationCombination[] = [2, 3].flatMap((size) =>
  combinations(HYDRATION_PARTS, size).map((parts) => ({
    name: parts.join(" + "),
    parts,
  })),
);

describe("hydration combination matrix", () => {
  it("attributes a suppressed-plus-inline sanitization failure to the inline fact", async () => {
    const result = await detectAndLoadPromptImages({
      prompt: "already described",
      media: [
        {
          path: "/tmp/described-missing.png",
          contentType: "image/png",
          hydrationSuppressed: true,
        },
        { path: "/tmp/inline.png", contentType: "image/png" },
      ],
      workspaceDir: "/tmp",
      model: { input: ["text", "image"] },
      existingImages: [{ type: "image", data: "%%%", mimeType: "image/png" }],
      imageOrder: ["inline"],
    });

    expect(result.images).toEqual([]);
    expect(result.imageFactIndexes).toEqual([]);
    expect(result.loadedCount).toBe(0);
    expect(result.failedMediaCount).toBe(1);
  });

  it.each(HYDRATION_COMBINATIONS)(
    "$name preserves materialization, order, and suppression invariants",
    async (testCase: HydrationCombination) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-hydration-matrix-"));
      const has = (part: HydrationPart) => testCase.parts.includes(part);
      const inlineBuffer = createSolidPngBuffer(1, 1, { r: 255, g: 0, b: 0 });
      const offloadedBuffer = createSolidPngBuffer(1, 1, { r: 0, g: 255, b: 0 });
      const explicitBuffer = createSolidPngBuffer(1, 1, { r: 0, g: 0, b: 255 });
      const inlinePath = path.join(root, "inline.png");
      const offloadedPath = path.join(root, "offloaded.png");
      const explicitPath = path.join(root, "explicit.png");
      const suppressedPath = path.join(root, "suppressed-missing.png");
      if (has("offloaded")) {
        await fs.writeFile(offloadedPath, offloadedBuffer);
      }
      if (has("explicit")) {
        await fs.writeFile(explicitPath, explicitBuffer);
      }

      const media: Array<{
        path: string;
        contentType: string;
        hydrationSuppressed?: boolean;
      }> = [];
      if (has("suppressed")) {
        media.push({
          path: suppressedPath,
          contentType: "image/png",
          hydrationSuppressed: true,
        });
      }
      const inlineFactIndex = has("inline") ? media.length : undefined;
      if (has("inline")) {
        media.push({ path: inlinePath, contentType: "image/png" });
      }
      const offloadedFactIndex = has("offloaded") ? media.length : undefined;
      if (has("offloaded")) {
        media.push({ path: offloadedPath, contentType: "image/png" });
      }

      const inlineImage = {
        type: "image" as const,
        data: inlineBuffer.toString("base64"),
        mimeType: "image/png",
      };
      const imageOrder = [
        ...(has("inline") ? (["inline"] as const) : []),
        ...(has("offloaded") ? (["offloaded"] as const) : []),
      ];
      const existingImages = has("inline") ? [inlineImage] : undefined;
      const existingImageFactIndexes =
        has("legacy") && inlineFactIndex !== undefined ? [inlineFactIndex] : undefined;

      try {
        const result = await detectAndLoadPromptImages({
          prompt: has("explicit") ? `inspect ${explicitPath}` : "inspect attachments",
          media,
          workspaceDir: root,
          model: { input: ["text", "image"] },
          existingImages,
          existingImageFactIndexes,
          imageOrder: has("legacy") ? undefined : imageOrder,
          workspaceOnly: true,
        });

        const expectedImages = [
          ...(has("inline") ? [inlineImage] : []),
          ...(has("offloaded")
            ? [
                {
                  type: "image" as const,
                  data: offloadedBuffer.toString("base64"),
                  mimeType: "image/png",
                },
              ]
            : []),
          ...(has("explicit")
            ? [
                {
                  type: "image" as const,
                  data: explicitBuffer.toString("base64"),
                  mimeType: "image/png",
                },
              ]
            : []),
        ];
        const expectedFactIndexes = [
          ...(inlineFactIndex === undefined ? [] : [inlineFactIndex]),
          ...(offloadedFactIndex === undefined ? [] : [offloadedFactIndex]),
          ...(has("explicit") ? [null] : []),
        ];
        const expectedLoadedCount = Number(has("offloaded")) + Number(has("explicit"));

        expect(result.images).toEqual(expectedImages);
        expect(result.imageFactIndexes).toEqual(expectedFactIndexes);
        expect(result.loadedCount).toBe(expectedLoadedCount);
        expect(result.failedMediaCount).toBe(0);
        expect(result.images).toHaveLength(
          Number(has("inline")) + Number(has("offloaded")) + Number(has("explicit")),
        );
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );
});
