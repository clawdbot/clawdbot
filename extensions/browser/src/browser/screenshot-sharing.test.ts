import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  normalizeBrowserScreenshot: vi.fn(),
  saveMediaBuffer: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({ readFile: mocks.readFile }));
vi.mock("./screenshot.js", () => ({
  DEFAULT_BROWSER_SCREENSHOT_MAX_BYTES: 5 * 1024 * 1024,
  DEFAULT_BROWSER_SCREENSHOT_MAX_SIDE: 2000,
  normalizeBrowserScreenshot: mocks.normalizeBrowserScreenshot,
}));
vi.mock("openclaw/plugin-sdk/media-store", () => ({
  saveMediaBuffer: mocks.saveMediaBuffer,
}));

import { stageBrowserScreenshotForSharing } from "./screenshot-sharing.js";

afterEach(() => {
  vi.clearAllMocks();
});

describe("stageBrowserScreenshotForSharing", () => {
  it("stages a bounded copy in the outbound media store", async () => {
    const sourcePath = "/state/media/browser/private-shot.png";
    const source = Buffer.from("private screenshot");
    const normalized = Buffer.from("bounded screenshot");
    mocks.readFile.mockResolvedValue(source);
    mocks.normalizeBrowserScreenshot.mockResolvedValue({
      buffer: normalized,
      contentType: "image/jpeg",
    });
    mocks.saveMediaBuffer.mockResolvedValue({
      path: "/state/media/outbound/share.jpg",
    });

    await expect(stageBrowserScreenshotForSharing(sourcePath, 1200)).resolves.toBe(
      "/state/media/outbound/share.jpg",
    );
    expect(mocks.readFile).toHaveBeenCalledWith(sourcePath);
    expect(mocks.normalizeBrowserScreenshot).toHaveBeenCalledWith(source, {
      maxSide: 1200,
      maxBytes: 5 * 1024 * 1024,
    });
    expect(mocks.saveMediaBuffer).toHaveBeenCalledWith(
      normalized,
      "image/jpeg",
      "outbound",
      5 * 1024 * 1024,
      "private-shot.png",
    );
  });
});
