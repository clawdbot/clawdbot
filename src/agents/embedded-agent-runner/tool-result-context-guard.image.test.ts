// Real native image results must retain a bounded, truthful visual context.
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { encodePngRgba, fillPixel } from "../../media/png-encode.js";
import type { AgentMessage } from "../runtime/index.js";
import { castAgentMessage } from "../test-helpers/agent-message-fixtures.js";
import { createImageTool } from "../tools/image-tool.js";
import {
  createMessageCharEstimateCache,
  estimateMessageCharsCached,
  TOOL_RESULT_CHARS_PER_TOKEN_ESTIMATE,
} from "./tool-result-char-estimator.js";
import { installToolResultContextGuard } from "./tool-result-context-guard.js";

type ContentBlock = { type: string; text?: string; data?: string; mimeType?: string };

function createRequiredImageTool() {
  const config: OpenClawConfig = {
    agents: { defaults: { imageMaxDimensionPx: 32 } },
  };
  return expectDefined(
    createImageTool({
      config,
      agentDir: join(tmpdir(), "openclaw-native-image-context-test"),
      modelHasVision: true,
    }),
    "native-vision image tool is available",
  );
}

function makeDistinctImageRef(index: number): string {
  const width = 64;
  const pixels = Buffer.alloc(width * width * 4);
  for (let y = 0; y < width; y += 1) {
    for (let x = 0; x < width; x += 1) {
      fillPixel(pixels, x, y, width, (index + 1) * 17, x * 3, y * 3);
    }
  }
  return `data:image/png;base64,${encodePngRgba(pixels, width, width).toString("base64")}`;
}

async function executeNativeImageTool(imageCount: number): Promise<AgentMessage> {
  const result = await createRequiredImageTool().execute("native-image-context", {
    images: Array.from({ length: imageCount }, (_, index) => makeDistinctImageRef(index)),
  });
  const content = result.content as ContentBlock[];
  expect(content[0]?.text).toBe(
    `Loaded ${imageCount} image${imageCount === 1 ? "" : "s"} into private model context for inspection; not displayed, attached, or sent to the user.`,
  );
  expect(content.filter((block) => block.type === "image")).toHaveLength(imageCount);
  expect(content.filter((block) => block.type === "image")).toEqual(
    expect.arrayContaining([expect.objectContaining({ mimeType: "image/jpeg" })]),
  );
  expect(result.details).toMatchObject({ transport: "native", media: { outbound: false } });
  return castAgentMessage({
    role: "toolResult",
    toolCallId: "native-image-context",
    toolName: "image",
    isError: false,
    timestamp: 0,
    ...result,
  });
}

async function projectForContext(
  source: AgentMessage,
  contextWindowTokens: number,
): Promise<AgentMessage> {
  const agent: {
    transformContext?: (messages: AgentMessage[], signal: AbortSignal) => Promise<AgentMessage[]>;
  } = {};
  installToolResultContextGuard({ agent, contextWindowTokens });
  const transformed = await expectDefined(agent.transformContext, "installed context guard")(
    [source],
    new AbortController().signal,
  );
  return expectDefined(transformed[0], "guarded native image result");
}

function blocksOf(message: AgentMessage): ContentBlock[] {
  return (message as { content: ContentBlock[] }).content;
}

function expectWithinExistingCap(message: AgentMessage, contextWindowTokens: number): void {
  const existingCap = Math.max(
    1_024,
    Math.floor(contextWindowTokens * TOOL_RESULT_CHARS_PER_TOKEN_ESTIMATE * 0.5),
  );
  expect(estimateMessageCharsCached(message, createMessageCharEstimateCache())).toBeLessThanOrEqual(
    existingCap,
  );
}

describe("native image tool result context projection", () => {
  it.each([
    { contextWindowTokens: 8_000, loadedImages: 1, visibleImages: 0 },
    { contextWindowTokens: 32_000, loadedImages: 3, visibleImages: 1 },
    { contextWindowTokens: 128_000, loadedImages: 9, visibleImages: 7 },
  ])(
    "preserves a fitting sanitized image prefix in a $contextWindowTokens-token window",
    async ({ contextWindowTokens, loadedImages, visibleImages }) => {
      const source = await executeNativeImageTool(loadedImages);
      const originalSnapshot = structuredClone(source);
      const projected = await projectForContext(source, contextWindowTokens);
      const sourceImages = blocksOf(source).filter((block) => block.type === "image");
      const projectedImages = blocksOf(projected).filter((block) => block.type === "image");
      const projectedText = blocksOf(projected)
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");

      expect(projectedImages).toEqual(sourceImages.slice(0, visibleImages));
      expect(projectedText).toMatch(
        new RegExp(
          `${loadedImages - visibleImages} images? .*omitted|omitted.*${loadedImages - visibleImages} images?`,
          "i",
        ),
      );
      expect(projectedText).toMatch(/context/i);
      if (visibleImages === 0) {
        expect(projectedText).toMatch(
          /no images? (?:fit|included|available)|images? (?:could not|cannot) (?:fit|be included)/i,
        );
      }
      expectWithinExistingCap(projected, contextWindowTokens);
      expect(source).toEqual(originalSnapshot);
      expect((source as { details?: unknown }).details).toMatchObject({
        media: { outbound: false },
      });
      expect(projected).not.toHaveProperty("details");
    },
  );

  it("leaves sanitized native images and private details untouched when all blocks fit", async () => {
    const source = await executeNativeImageTool(2);
    const projected = await projectForContext(source, 32_768);

    expect(projected).toBe(source);
    expect(blocksOf(projected).filter((block) => block.type === "image")).toHaveLength(2);
    expect((projected as { details?: unknown }).details).toEqual(
      (source as { details?: unknown }).details,
    );
    expectWithinExistingCap(projected, 32_768);
  });

  it("preserves mixed text, unknown blocks, CJK content, image order, and original privacy", async () => {
    const native = await executeNativeImageTool(3);
    const nativeBlocks = blocksOf(native);
    const unknown = { type: "custom", value: { label: "bounded metadata" } };
    const cjk = { type: "text", text: "画像の順序を維持する 🖼️" };
    const source = castAgentMessage({
      ...native,
      toolName: "read",
      content: [nativeBlocks[0], nativeBlocks[1], unknown, cjk, nativeBlocks[2], nativeBlocks[3]],
      details: { media: { outbound: false }, privateReference: "private-fixture-reference" },
    });
    const projected = await projectForContext(source, 32_000);
    const content = blocksOf(projected);

    expect(content.filter((block) => block.type === "image")).toEqual([nativeBlocks[1]]);
    expect(content.map((block) => block.type)).toEqual(["text", "image", "custom", "text", "text"]);
    expect(content).toContain(unknown);
    expect(content).toContain(cjk);
    expect(content.at(-1)?.text).toMatch(/2 images? .*omitted|omitted.*2 images?/i);
    expectWithinExistingCap(projected, 32_000);
    expect(projected).not.toHaveProperty("details");
    expect(JSON.stringify(blocksOf(projected))).not.toContain("private-fixture-reference");
    expect(
      (source as { details?: { media?: { outbound?: boolean } } }).details?.media?.outbound,
    ).toBe(false);
  });

  it.each([1, 2])(
    "retains a fitting image when oversized CJK text accompanies %i sanitized images",
    async (loadedImages) => {
      const native = await executeNativeImageTool(loadedImages);
      const nativeBlocks = blocksOf(native);
      const source = castAgentMessage({
        ...native,
        content: [{ type: "text", text: "画像🖼️".repeat(8_000) }, ...nativeBlocks.slice(1)],
      });
      const projected = await projectForContext(source, 32_000);
      const content = blocksOf(projected);

      expect(content.filter((block) => block.type === "image")).toEqual([nativeBlocks[1]]);
      expect(content[0]?.text).toContain("画像");
      const boundedText = expectDefined(content[0]?.text, "bounded image context text");
      expect(Buffer.from(boundedText, "utf8").toString("utf8")).toBe(boundedText);
      expectWithinExistingCap(projected, 32_000);
      if (loadedImages === 1) {
        expect(content.some((block) => block.text?.includes("0 images"))).toBe(false);
      } else {
        expect(content.some((block) => block.text?.includes("1 image omitted"))).toBe(true);
      }
      expect(blocksOf(source).filter((block) => block.type === "image")).toHaveLength(loadedImages);
    },
  );

  it("keeps a fitting image without letting oversized text starve a later text block", async () => {
    const native = await executeNativeImageTool(2);
    const nativeBlocks = blocksOf(native);
    const trailingText = { type: "text", text: "retain the image description" };
    const source = castAgentMessage({
      ...native,
      content: [
        { type: "text", text: "画像🖼️".repeat(8_000) },
        nativeBlocks[1],
        trailingText,
        nativeBlocks[2],
      ],
    });
    const projected = await projectForContext(source, 32_000);
    const content = blocksOf(projected);

    expect(content.filter((block) => block.type === "image")).toEqual([nativeBlocks[1]]);
    const boundedText = expectDefined(content[0]?.text, "bounded multi-block image context text");
    expect(Buffer.from(boundedText, "utf8").toString("utf8")).toBe(boundedText);
    expect(content).toContainEqual(trailingText);
    expect(content.at(-1)?.text).toContain("1 image omitted");
    expectWithinExistingCap(projected, 32_000);
  });
});
