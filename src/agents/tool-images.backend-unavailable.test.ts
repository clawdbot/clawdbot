// Tool image backend-unavailable tests cover safe pass-through when native
// image processing cannot load on constrained Linux/Termux platforms.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { backendUnavailableError, getImageMetadataMock, readImageMetadataFromHeaderMock } =
  vi.hoisted(() => ({
    backendUnavailableError: new Error("missing image backend"),
    getImageMetadataMock: vi.fn(),
    readImageMetadataFromHeaderMock: vi.fn(),
  }));

const PNG_BASE64 = "iVBORw0KGgo=";

async function importSanitizer() {
  vi.resetModules();
  vi.doMock("../media/media-services.js", () => ({
    IMAGE_REDUCE_QUALITY_STEPS: [85, 75],
    MAX_IMAGE_INPUT_PIXELS: 25_000_000,
    buildImageResizeSideGrid: () => [1200],
    getImageMetadata: getImageMetadataMock,
    isImageProcessorUnavailableError: (error: unknown) => error === backendUnavailableError,
    readImageMetadataFromHeader: readImageMetadataFromHeaderMock,
    resizeToJpeg: async () => {
      throw backendUnavailableError;
    },
  }));
  return await import("./tool-images.js");
}

describe("tool image sanitizer without native image backend", () => {
  beforeEach(() => {
    getImageMetadataMock.mockReset();
    readImageMetadataFromHeaderMock.mockReset();
  });

  it("keeps small header-verified images without probing the backend", async () => {
    readImageMetadataFromHeaderMock.mockReturnValueOnce({ width: 32, height: 24 });
    getImageMetadataMock.mockRejectedValueOnce(backendUnavailableError);
    const { sanitizeContentBlocksImages } = await importSanitizer();

    const out = await sanitizeContentBlocksImages(
      [{ type: "image" as const, data: PNG_BASE64, mimeType: "image/png" }],
      "test",
      { maxDimensionPx: 64, maxBytes: 1024 },
    );

    expect(out).toStrictEqual([{ type: "image", data: PNG_BASE64, mimeType: "image/png" }]);
    expect(getImageMetadataMock).not.toHaveBeenCalled();
  });

  it("drops images that need resizing when the backend is unavailable", async () => {
    readImageMetadataFromHeaderMock.mockReturnValueOnce({ width: 128, height: 24 });
    const { sanitizeContentBlocksImages } = await importSanitizer();

    const out = await sanitizeContentBlocksImages(
      [{ type: "image" as const, data: PNG_BASE64, mimeType: "image/png" }],
      "test",
      { maxDimensionPx: 64, maxBytes: 1024 },
    );

    expect(out).toStrictEqual([
      {
        type: "text",
        text: "[test] omitted image payload: Error: missing image backend",
      },
    ]);
  });

  it("does not pass through compressed images over the pixel cap", async () => {
    readImageMetadataFromHeaderMock.mockReturnValueOnce({ width: 6000, height: 6000 });
    const { sanitizeContentBlocksImages } = await importSanitizer();

    const out = await sanitizeContentBlocksImages(
      [{ type: "image" as const, data: PNG_BASE64, mimeType: "image/png" }],
      "test",
      { maxDimensionPx: 6000, maxBytes: 1024 },
    );

    expect(out).toStrictEqual([
      {
        type: "text",
        text: "[test] omitted image payload: Error: missing image backend",
      },
    ]);
  });
});
