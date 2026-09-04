// Raster image adapter tests cover image operation integration with RasterMill.
import type { ImageProbe } from "rastermill";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTinyJpegBuffer } from "../../test/helpers/image-fixtures.js";

function jpegWithDimensions(width: number, height: number): Buffer {
  const buffer = createTinyJpegBuffer();
  const startOfFrame = buffer.indexOf(Buffer.from([0xff, 0xc0]));
  expect(startOfFrame).toBeGreaterThanOrEqual(0);
  buffer.writeUInt16BE(height, startOfFrame + 5);
  buffer.writeUInt16BE(width, startOfFrame + 7);
  return buffer;
}

describe("image ops Rastermill adapter", () => {
  describe("cold processor initialization", () => {
    beforeEach(() => {
      vi.resetModules();
    });

    afterEach(() => {
      vi.doUnmock("rastermill");
      vi.doUnmock("@silvia-odwyer/photon-node");
      vi.doUnmock("../infra/resolve-system-bin.js");
      vi.doUnmock("../agents/image-compression-policy.js");
      vi.resetModules();
    });

    it("does not load Photon for Rastermill-backed operations", async () => {
      const actualRastermill = await vi.importActual<typeof import("rastermill")>("rastermill");
      const encode = vi.fn(async () => ({ data: Buffer.from("jpeg") }));
      const photonModuleFactory = vi.fn(() => {
        throw new Error("Photon loaded eagerly");
      });

      vi.doMock("@silvia-odwyer/photon-node", photonModuleFactory);
      vi.doMock("rastermill", () => ({
        ...actualRastermill,
        createRastermill: vi.fn(() => ({ encode })),
        readImageMetadataFromHeader: vi.fn(() => ({ width: 1, height: 1 })),
        readImageProbeFromHeader: vi.fn(() => ({ width: 1, height: 1, format: "jpeg" })),
      }));

      const { resizeToJpeg } = await import("./image-ops.js");

      await expect(
        resizeToJpeg({ buffer: Buffer.from("input"), maxSide: 1, quality: 80 }),
      ).resolves.toEqual(Buffer.from("jpeg"));
      expect(photonModuleFactory).not.toHaveBeenCalled();
    });

    it("configures Rastermill with OpenClaw limits, temp root, and command resolution", async () => {
      const actualRastermill = await vi.importActual<typeof import("rastermill")>("rastermill");
      const encode = vi.fn(async () => ({ data: Buffer.from("jpeg") }));
      const createRastermill = vi.fn((_options: unknown) => ({ encode }));
      const resolveSystemBin = vi.fn(() => "/usr/bin/tool");

      vi.doMock("rastermill", () => ({
        ...actualRastermill,
        createRastermill,
        readImageMetadataFromHeader: vi.fn(() => ({ width: 1, height: 1 })),
        readImageProbeFromHeader: vi.fn(() => ({ width: 1, height: 1, format: "png" })),
      }));
      vi.doMock("../infra/resolve-system-bin.js", () => ({
        resolveSystemBin,
      }));

      const { resizeToJpeg, MAX_IMAGE_INPUT_PIXELS } = await import("./image-ops.js");

      await expect(
        resizeToJpeg({ buffer: Buffer.from("input"), maxSide: 1, quality: 80 }),
      ).resolves.toEqual(Buffer.from("jpeg"));

      expect(createRastermill).toHaveBeenCalledWith({
        execution: "auto",
        limits: {
          inputPixels: MAX_IMAGE_INPUT_PIXELS,
          outputPixels: MAX_IMAGE_INPUT_PIXELS,
        },
        temp: expect.objectContaining({
          prefix: "openclaw-img-",
        }),
        commandResolver: expect.any(Function),
      });
      const options = createRastermill.mock.calls[0]?.[0] as {
        commandResolver: (command: string) => string | null;
        env?: unknown;
      };
      expect(options.env).toBeUndefined();
      expect(options.commandResolver("powershell")).toBe("/usr/bin/tool");
      expect(resolveSystemBin).toHaveBeenLastCalledWith("powershell", { trust: "strict" });
    });

    it("allows a bounded larger source only for explicit downscale processors", async () => {
      const actualRastermill = await vi.importActual<typeof import("rastermill")>("rastermill");
      const createRastermill = vi.fn(() => ({ encode: vi.fn() }));
      vi.doMock("rastermill", () => ({
        ...actualRastermill,
        createRastermill,
        readImageMetadataFromHeader: vi.fn(),
        readImageProbeFromHeader: vi.fn(),
      }));

      const { MAX_IMAGE_INPUT_PIXELS } = await import("./image-ops.js");
      const { createImageProcessorWithPixelLimits } = await import("./image-processor.js");
      createImageProcessorWithPixelLimits({
        inputPixels: 40_000_000,
        outputPixels: MAX_IMAGE_INPUT_PIXELS,
      });

      expect(createRastermill).toHaveBeenCalledWith(
        expect.objectContaining({
          limits: {
            inputPixels: 40_000_000,
            outputPixels: MAX_IMAGE_INPUT_PIXELS,
          },
        }),
      );
    });

    it("scopes the larger source admission to media understanding", async () => {
      const actualRastermill = await vi.importActual<typeof import("rastermill")>("rastermill");
      const encode = vi.fn(async () => ({
        data: Buffer.from("jpeg"),
        bytes: 4,
        base64Bytes: 8,
        width: 1,
        height: 1,
        format: "jpeg" as const,
        mimeType: "image/jpeg" as const,
        metadata: "stripped" as const,
        resized: true,
        chosen: { format: "jpeg" as const, maxSide: 1, quality: 80 },
      }));
      const createRastermill = vi.fn(() => ({ encode }));
      vi.doMock("rastermill", () => ({
        ...actualRastermill,
        createRastermill,
        readImageMetadataFromHeader: vi.fn(() => ({ width: 2, height: 2 })),
        readImageProbeFromHeader: vi.fn(() => ({
          width: 2,
          height: 2,
          format: "png",
          hasAlpha: false,
          orientation: null,
          bytes: 32,
        })),
      }));

      const { MAX_IMAGE_INPUT_PIXELS } = await import("./image-ops.js");
      const { optimizeImageBufferForWebMedia } = await import("./web-media.js");
      await optimizeImageBufferForWebMedia({
        buffer: Buffer.alloc(32),
        contentType: "image/png",
        maxBytes: 16,
      });

      expect(createRastermill).toHaveBeenLastCalledWith(
        expect.objectContaining({
          limits: {
            inputPixels: MAX_IMAGE_INPUT_PIXELS,
            outputPixels: MAX_IMAGE_INPUT_PIXELS,
          },
        }),
      );

      createRastermill.mockClear();
      vi.doMock("../agents/image-compression-policy.js", () => ({
        resolveImageCompressionModelPolicy: vi.fn(async () => ({ maxSidePx: 1 })),
      }));
      const { optimizeImageDescriptionInput } =
        await import("../media-understanding/image-input-normalize.js");
      await optimizeImageDescriptionInput({
        buffer: Buffer.alloc(32),
        mime: "image/png",
        maxBytes: 16,
        provider: "vision-plugin",
        model: "vision-v1",
      });

      expect(createRastermill).toHaveBeenLastCalledWith(
        expect.objectContaining({
          limits: {
            inputPixels: 40_000_000,
            outputPixels: MAX_IMAGE_INPUT_PIXELS,
          },
        }),
      );
    });

    it("admits phone-sized JPEG headers only to the bounded downscale path", async () => {
      const { createImageProcessor, MAX_IMAGE_INPUT_PIXELS } = await import("./image-ops.js");
      const { createImageProcessorWithPixelLimits } = await import("./image-processor.js");
      const phonePhoto = jpegWithDimensions(4536, 8064);
      const createDownscaleProcessor = () =>
        createImageProcessorWithPixelLimits({
          inputPixels: 40_000_000,
          outputPixels: MAX_IMAGE_INPUT_PIXELS,
        });

      await expect(createImageProcessor().probe(phonePhoto)).resolves.toBeNull();
      await expect(createDownscaleProcessor().probe(phonePhoto)).resolves.toMatchObject({
        width: 4536,
        height: 8064,
      });
      await expect(
        createDownscaleProcessor().probe(jpegWithDimensions(8000, 5001)),
      ).resolves.toBeNull();
    });

    it("exposes Rastermill unavailable errors through the SDK alias", async () => {
      const actualRastermill = await vi.importActual<typeof import("rastermill")>("rastermill");
      const unavailableError = new actualRastermill.RastermillUnavailableError(
        "encode",
        "Image processor unavailable",
        [new Error("missing backend")],
      );
      const createRastermill = vi.fn(() => ({
        encode: vi.fn(async () => {
          throw unavailableError;
        }),
      }));

      vi.doMock("rastermill", () => ({
        ...actualRastermill,
        createRastermill,
        readImageMetadataFromHeader: vi.fn(() => ({ width: 1, height: 1 })),
        readImageProbeFromHeader: vi.fn(() => ({ width: 1, height: 1, format: "png" })),
      }));

      const { isImageProcessorUnavailableError, resizeToJpeg } = await import("./image-ops.js");

      await expect(
        resizeToJpeg({ buffer: Buffer.from("input"), maxSide: 1, quality: 80 }).then(
          () => false,
          (error: unknown) => isImageProcessorUnavailableError(error),
        ),
      ).resolves.toBe(true);
    });
  });

  describe("display metadata", () => {
    const probe = vi.fn<() => Promise<ImageProbe | null>>();
    const readProbe = vi.fn<() => ImageProbe | null>();
    let imageOps: typeof import("./image-ops.js");

    beforeAll(async () => {
      vi.resetModules();
      const actualRastermill = await vi.importActual<typeof import("rastermill")>("rastermill");
      vi.doMock("rastermill", () => ({
        ...actualRastermill,
        createRastermill: vi.fn(() => ({ probe })),
        readImageProbeFromHeader: readProbe,
      }));
      imageOps = await import("./image-ops.js");
    });

    beforeEach(() => {
      probe.mockReset();
      readProbe.mockReset();
    });

    afterAll(() => {
      vi.doUnmock("rastermill");
      vi.resetModules();
    });

    it.each([
      { orientation: null, expected: { width: 640, height: 480 } },
      { orientation: 1, expected: { width: 640, height: 480 } },
      { orientation: 4, expected: { width: 640, height: 480 } },
      { orientation: 5, expected: { width: 480, height: 640 } },
      { orientation: 6, expected: { width: 480, height: 640 } },
      { orientation: 7, expected: { width: 480, height: 640 } },
      { orientation: 8, expected: { width: 480, height: 640 } },
    ] as const)(
      "reports display dimensions for EXIF orientation $orientation",
      async (testCase) => {
        const imageProbe = {
          width: 640,
          height: 480,
          format: "jpeg" as const,
          hasAlpha: false,
          orientation: testCase.orientation,
          bytes: 24,
        };
        probe.mockResolvedValue(imageProbe);
        readProbe.mockReturnValue(imageProbe);
        const image = Buffer.from("image");

        expect(imageOps.readImageMetadataFromHeader(image)).toEqual(testCase.expected);
        await expect(imageOps.getImageMetadata(image)).resolves.toEqual(testCase.expected);
        expect(imageOps.readImageProbeFromHeader(image)).toEqual(imageProbe);
      },
    );
  });
});
