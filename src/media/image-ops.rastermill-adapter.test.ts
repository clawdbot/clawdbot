// Raster image adapter tests cover image operation integration with RasterMill.
import type { ImageProbe } from "rastermill";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

describe("image ops Rastermill adapter", () => {
  describe("cold processor initialization", () => {
    beforeEach(() => {
      vi.resetModules();
    });

    afterEach(() => {
      vi.doUnmock("rastermill");
      vi.doUnmock("@silvia-odwyer/photon-node");
      vi.doUnmock("../infra/resolve-system-bin.js");
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
