import { afterEach, describe, expect, it, vi } from "vitest";
import { createSolidPngBuffer } from "../../test/helpers/image-fixtures.js";
import type { OpenClawConfig } from "../config/types.js";
import { ImageOptimizationLimitError } from "../media/image-optimization-error.js";
import { readImageMetadataFromHeader } from "../media/media-services.js";
import type { ImageCompressionModelPolicy } from "../media/web-media.js";

const mocks = vi.hoisted(() => ({
  resolveImageCompressionModelPolicy: vi.fn(
    async (): Promise<ImageCompressionModelPolicy> => ({
      maxSidePx: 32,
      preferredSidePx: 32,
    }),
  ),
}));

vi.mock("../agents/image-compression-policy.js", () => ({
  resolveImageCompressionModelPolicy: mocks.resolveImageCompressionModelPolicy,
}));

import { optimizeImageDescriptionInput } from "./image-input-normalize.js";

afterEach(() => {
  mocks.resolveImageCompressionModelPolicy.mockClear();
});

describe("image description input optimization", () => {
  it("downscales recognized images to the selected model policy", async () => {
    const result = await optimizeImageDescriptionInput({
      buffer: createSolidPngBuffer(64, 48, { r: 24, g: 96, b: 208 }),
      fileName: "phone.png",
      mime: "image/png",
      cfg: {} as OpenClawConfig,
      provider: "vision-plugin",
      model: "vision-v1",
      agentDir: "/tmp/agent",
      maxBytes: 1024 * 1024,
    });

    expect(mocks.resolveImageCompressionModelPolicy).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "vision-plugin", model: "vision-v1" }),
    );
    expect(result.mime).toBe("image/jpeg");
    expect(result.fileName).toBe("phone.jpg");
    expect(result.buffer).not.toEqual(createSolidPngBuffer(64, 48, { r: 24, g: 96, b: 208 }));
    expect(readImageMetadataFromHeader(result.buffer)).toEqual({ width: 32, height: 24 });
  });

  it("preserves provider-owned unknown formats while enforcing the effective byte cap", async () => {
    const buffer = Buffer.from("custom-provider-image");
    await expect(
      optimizeImageDescriptionInput({
        buffer,
        mime: "image/x-custom",
        provider: "vision-plugin",
        model: "vision-v1",
        maxBytes: buffer.length,
      }),
    ).resolves.toEqual({ buffer, fileName: undefined, mime: "image/x-custom" });

    mocks.resolveImageCompressionModelPolicy.mockResolvedValueOnce({ maxBytes: buffer.length - 1 });
    await expect(
      optimizeImageDescriptionInput({
        buffer,
        mime: "image/x-custom",
        provider: "vision-plugin",
        model: "vision-v1",
        maxBytes: buffer.length,
      }),
    ).rejects.toMatchObject({
      name: ImageOptimizationLimitError.name,
      maxBytes: buffer.length - 1,
    });
    expect(mocks.resolveImageCompressionModelPolicy).toHaveBeenCalledTimes(2);
  });
});
