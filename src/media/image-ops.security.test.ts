import { afterEach, describe, expect, it, vi } from "vitest";
import { createPngBufferWithDimensions } from "./test-helpers.js";

const { loadBundledPluginPublicArtifactModuleSyncMock, resolveSystemBinMock, runExecMock } =
  vi.hoisted(() => ({
    loadBundledPluginPublicArtifactModuleSyncMock: vi.fn(),
    resolveSystemBinMock: vi.fn(),
    runExecMock: vi.fn(),
  }));

vi.mock("../plugins/public-surface-loader.js", () => ({
  loadBundledPluginPublicArtifactModuleSync: loadBundledPluginPublicArtifactModuleSyncMock,
}));

vi.mock("../infra/resolve-system-bin.js", () => ({
  resolveSystemBin: resolveSystemBinMock,
}));

vi.mock("../process/exec.js", () => ({
  runExec: runExecMock,
}));

import { getImageMetadata, resizeToJpeg } from "./image-ops.js";

describe("image ops external backend security", () => {
  const previousBackend = process.env.OPENCLAW_IMAGE_BACKEND;

  afterEach(() => {
    if (previousBackend === undefined) {
      delete process.env.OPENCLAW_IMAGE_BACKEND;
    } else {
      process.env.OPENCLAW_IMAGE_BACKEND = previousBackend;
    }
    loadBundledPluginPublicArtifactModuleSyncMock.mockReset();
    resolveSystemBinMock.mockReset();
    runExecMock.mockReset();
  });

  it("does not use external metadata tools for unrecognized image bytes", async () => {
    process.env.OPENCLAW_IMAGE_BACKEND = "imagemagick";
    resolveSystemBinMock.mockReturnValue("/usr/bin/magick");

    const svgWithExternalReference = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><image href="http://127.0.0.1:9/probe.png" width="1" height="1"/></svg>',
    );

    await expect(getImageMetadata(svgWithExternalReference)).resolves.toBeNull();

    expect(runExecMock).not.toHaveBeenCalled();
    expect(loadBundledPluginPublicArtifactModuleSyncMock).not.toHaveBeenCalled();
  });

  it("stops backend fallback after a real processing error", async () => {
    delete process.env.OPENCLAW_IMAGE_BACKEND;
    resolveSystemBinMock.mockReturnValue("/usr/bin/magick");
    loadBundledPluginPublicArtifactModuleSyncMock.mockReturnValue({
      createMediaAttachmentImageOps: () => ({
        getImageMetadata: vi.fn(),
        normalizeExifOrientation: vi.fn(),
        resizeToJpeg: vi.fn(async () => {
          throw new Error("corrupt image payload");
        }),
        convertHeicToJpeg: vi.fn(),
        hasAlphaChannel: vi.fn(),
        resizeToPng: vi.fn(),
      }),
    });

    await expect(
      resizeToJpeg({
        buffer: createPngBufferWithDimensions({ width: 1, height: 1 }),
        maxSide: 1,
        quality: 80,
      }),
    ).rejects.toThrow(/corrupt image payload/);

    expect(runExecMock).not.toHaveBeenCalled();
  });
});
