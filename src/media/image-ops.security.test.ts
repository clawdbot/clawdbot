import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPngBufferWithDimensions } from "./test-helpers.js";

const { createRastermillMock, resolveSystemBinMock } = vi.hoisted(() => ({
  createRastermillMock: vi.fn(),
  resolveSystemBinMock: vi.fn(),
}));

vi.mock("rastermill", async (importOriginal) => {
  const actual = await importOriginal<typeof import("rastermill")>();
  return {
    ...actual,
    createRastermill: createRastermillMock,
  };
});

vi.mock("../infra/resolve-system-bin.js", () => ({
  resolveSystemBin: resolveSystemBinMock,
}));

import { getImageMetadata, resizeToJpeg } from "./image-ops.js";

describe("image ops external backend security", () => {
  const previousBackend = process.env.OPENCLAW_IMAGE_BACKEND;

  beforeEach(async () => {
    const actual = await vi.importActual<typeof import("rastermill")>("rastermill");
    createRastermillMock.mockImplementation(actual.createRastermill);
  });

  afterEach(() => {
    if (previousBackend === undefined) {
      delete process.env.OPENCLAW_IMAGE_BACKEND;
    } else {
      process.env.OPENCLAW_IMAGE_BACKEND = previousBackend;
    }
    createRastermillMock.mockReset();
    resolveSystemBinMock.mockReset();
  });

  it("does not use external metadata tools for unrecognized image bytes", async () => {
    process.env.OPENCLAW_IMAGE_BACKEND = "imagemagick";
    resolveSystemBinMock.mockReturnValue("/usr/bin/magick");

    const svgWithExternalReference = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><image href="http://127.0.0.1:9/probe.png" width="1" height="1"/></svg>',
    );

    await expect(getImageMetadata(svgWithExternalReference)).resolves.toBeNull();

    expect(resolveSystemBinMock).not.toHaveBeenCalled();
  });

  it("propagates Rastermill processing errors without OpenClaw-side backend fallback", async () => {
    delete process.env.OPENCLAW_IMAGE_BACKEND;
    resolveSystemBinMock.mockReturnValue("/usr/bin/magick");
    createRastermillMock.mockReturnValue({
      encode: vi.fn(async () => {
        throw new Error("corrupt image payload");
      }),
    });

    await expect(
      resizeToJpeg({
        buffer: createPngBufferWithDimensions({ width: 1, height: 1 }),
        maxSide: 1,
        quality: 80,
      }),
    ).rejects.toThrow(/corrupt image payload/);

    expect(resolveSystemBinMock).not.toHaveBeenCalled();
  });
});
