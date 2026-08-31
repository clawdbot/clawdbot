// Exercise the file API with real cache, filesystem, root policy, and MIME detection.
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { DEFAULT_MAX_BYTES } from "./defaults.constants.js";
import { prepareImageDescriptionInput } from "./runtime.js";

vi.mock("./runner.js", async () => {
  return {
    ...(await import("./runner.attachments.js")),
    buildProviderRegistry: vi.fn(),
    runCapability: vi.fn(),
  };
});

vi.mock("./provider-registry.js", () => ({
  buildMediaUnderstandingRegistry: vi.fn(),
  getMediaUnderstandingProvider: vi.fn(),
  normalizeMediaProviderId: vi.fn(),
}));
vi.mock("./image-runtime.js", () => ({ describeImageWithModel: vi.fn() }));

describe("local image preparation", () => {
  it("rejects oversized local images before provider preparation", async () => {
    await withTestDir({ prefix: "openclaw-image-input-limit-" }, async (base) => {
      const filePath = path.join(base, "oversized.png");
      await fs.writeFile(filePath, Buffer.alloc(DEFAULT_MAX_BYTES.image + 1));
      await expect(
        prepareImageDescriptionInput({ filePath, cfg: {} }).then(() => "accepted"),
      ).rejects.toMatchObject({
        reason: "maxBytes",
      });
    });
  });

  it.skipIf(process.platform === "win32")("keeps rejecting local image symlinks", async () => {
    await withTestDir({ prefix: "openclaw-image-input-roots-" }, async (base) => {
      const allowed = path.join(base, "allowed");
      const outside = path.join(base, "outside.png");
      const filePath = path.join(allowed, "linked.png");
      await fs.mkdir(allowed);
      await fs.writeFile(outside, "outside");
      await fs.symlink(outside, filePath);
      await expect(prepareImageDescriptionInput({ filePath, cfg: {} })).rejects.toThrow();
    });
  });

  it("accepts an explicitly supplied local image and classifies its bytes", async () => {
    await withTestDir({ prefix: "openclaw-image-input-local-" }, async (base) => {
      const buffer = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=",
        "base64",
      );
      const filePath = path.join(base, "photo.jpg");
      await fs.writeFile(filePath, buffer);
      await expect(
        prepareImageDescriptionInput({ filePath, mime: "application/pdf", cfg: {} }),
      ).resolves.toEqual({ buffer, fileName: "photo.jpg", mime: "image/png" });
    });
  });
});
