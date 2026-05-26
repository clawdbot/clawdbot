import { afterEach, describe, expect, it, vi } from "vitest";
import { encodePngRgba } from "./png-encode.js";

function rgbaPng(alpha: number): Buffer {
  return encodePngRgba(Buffer.from([0x20, 0x80, 0xe0, alpha]), 1, 1);
}

describe("image ops Rastermill adapter", () => {
  afterEach(() => {
    vi.doUnmock("rastermill");
    vi.resetModules();
  });

  it("falls back to decoding PNG pixels when header alpha is unknown", async () => {
    const encode = vi.fn(async () => ({
      data: rgbaPng(64),
      format: "png",
      width: 1,
      height: 1,
      bytes: 11,
    }));

    vi.doMock("rastermill", () => ({
      RastermillUnavailableError: class RastermillUnavailableError extends Error {},
      createRastermill: () => ({
        probe: vi.fn(async () => ({
          orientation: null,
          width: 1,
          height: 1,
          hasAlpha: null,
          format: "gif",
        })),
        encode,
      }),
      isRastermillUnavailableError: () => false,
      readImageMetadataFromHeader: vi.fn(() => ({ width: 1, height: 1 })),
      readImageProbeFromHeader: vi.fn(() => ({
        width: 1,
        height: 1,
        format: "gif",
        hasAlpha: null,
        orientation: null,
      })),
    }));

    const { hasAlphaChannel } = await import("./image-ops.js");

    await expect(hasAlphaChannel(Buffer.from("maybe-alpha"))).resolves.toBe(true);
    expect(encode).toHaveBeenCalledWith(Buffer.from("maybe-alpha"), {
      format: "png",
      autoOrient: false,
    });
  });

  it("does not report opaque decoded fallback PNG pixels as transparent", async () => {
    vi.doMock("rastermill", () => ({
      RastermillUnavailableError: class RastermillUnavailableError extends Error {},
      createRastermill: () => ({
        probe: vi.fn(async () => ({
          orientation: null,
          width: 1,
          height: 1,
          hasAlpha: null,
          format: "gif",
        })),
        encode: vi.fn(async () => ({
          data: rgbaPng(255),
          format: "png",
          width: 1,
          height: 1,
          bytes: 70,
        })),
      }),
      isRastermillUnavailableError: () => false,
      readImageMetadataFromHeader: vi.fn(() => ({ width: 1, height: 1 })),
      readImageProbeFromHeader: vi.fn(() => ({
        width: 1,
        height: 1,
        format: "gif",
        hasAlpha: null,
        orientation: null,
      })),
    }));

    const { hasAlphaChannel } = await import("./image-ops.js");

    await expect(hasAlphaChannel(Buffer.from("opaque-maybe-alpha"))).resolves.toBe(false);
  });

  it("uses Photon only for header-valid Photon-owned inputs unless a backend is forced", async () => {
    const createRastermill = vi.fn(() => ({
      encode: vi.fn(async () => {
        throw new Error("cannot decode corrupt payload");
      }),
    }));

    vi.doMock("rastermill", () => ({
      RastermillUnavailableError: class RastermillUnavailableError extends Error {},
      createRastermill,
      isRastermillUnavailableError: () => false,
      readImageMetadataFromHeader: vi.fn(() => ({ width: 1, height: 1 })),
      readImageProbeFromHeader: vi.fn(() => ({
        width: 1,
        height: 1,
        format: "png",
        hasAlpha: true,
        orientation: null,
      })),
    }));

    const { resizeToJpeg } = await import("./image-ops.js");

    await expect(
      resizeToJpeg({ buffer: Buffer.from("corrupt-png"), maxSide: 1, quality: 80 }),
    ).rejects.toThrow("cannot decode corrupt payload");
    expect(createRastermill).toHaveBeenCalledWith(expect.objectContaining({ backend: "photon" }));
  });
});
