import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { estimateBase64DecodedBytesMock } = vi.hoisted(() => ({
  estimateBase64DecodedBytesMock: vi.fn(),
}));

vi.mock("@openclaw/media-core/base64", () => ({
  estimateBase64DecodedBytes: estimateBase64DecodedBytesMock,
}));

import { configureAiTransportHost } from "../host.js";
import {
  createAnthropicInlineImageBudget,
  normalizeAnthropicInlineContent,
} from "./anthropic-inline-images.js";

describe("Anthropic inline image request budget", () => {
  beforeEach(() => {
    estimateBase64DecodedBytesMock.mockReset();
    configureAiTransportHost({
      normalizeAnthropicInlineContentBlocks: async (content) => [...content],
    });
  });

  afterEach(() => {
    configureAiTransportHost({});
  });

  it("accounts for normalized images across separate payload-builder calls", async () => {
    estimateBase64DecodedBytesMock.mockReturnValue(16 * 1024 * 1024);
    const budget = createAnthropicInlineImageBudget();
    const content = [{ type: "image" as const, data: "image", mimeType: "image/jpeg" }];

    for (let index = 0; index < 4; index += 1) {
      await expect(normalizeAnthropicInlineContent(content, budget)).resolves.toEqual(content);
    }
    await expect(normalizeAnthropicInlineContent(content, budget)).rejects.toThrow(
      "64 MB aggregate decoded safety limit",
    );
  });

  it("rejects oversized output from an embedding host", async () => {
    estimateBase64DecodedBytesMock.mockReturnValueOnce(1).mockReturnValueOnce(64 * 1024 * 1024 + 1);
    await expect(
      normalizeAnthropicInlineContent(
        [{ type: "image", data: "image", mimeType: "image/jpeg" }],
        createAnthropicInlineImageBudget(),
      ),
    ).rejects.toThrow("64 MB aggregate decoded safety limit");
  });

  it("normalizes image batches incrementally", async () => {
    estimateBase64DecodedBytesMock.mockReturnValue(1);
    const batchSizes: number[] = [];
    configureAiTransportHost({
      normalizeAnthropicInlineContentBlocks: async (content) => {
        batchSizes.push(content.length);
        return [...content];
      },
    });

    await normalizeAnthropicInlineContent(
      [
        { type: "image", data: "first", mimeType: "image/jpeg" },
        { type: "text", text: "between" },
        { type: "image", data: "second", mimeType: "image/png" },
      ],
      createAnthropicInlineImageBudget(),
    );

    expect(batchSizes).toEqual([1, 1]);
  });
});
