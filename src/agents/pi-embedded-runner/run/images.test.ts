import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createHostSandboxFsBridge } from "../../test-helpers/host-sandbox-fs-bridge.js";
import { createUnsafeMountedSandbox } from "../../test-helpers/unsafe-mounted-sandbox.js";
import {
  detectAndLoadPromptImages,
  detectImageReferences,
  loadImageFromRef,
  mergePromptAttachmentImages,
  modelSupportsImages,
  splitPromptAndAttachmentRefs,
} from "./images.js";

function expectNoPromptImages(result: { detectedRefs: unknown[]; images: unknown[] }) {
  expect(result.detectedRefs).toHaveLength(0);
  expect(result.images).toHaveLength(0);
}

function expectNoImageReferences(prompt: string) {
  const refs = detectImageReferences(prompt);
  expect(refs).toHaveLength(0);
}

function expectImageReferenceCount(prompt: string, count: number) {
  const refs = detectImageReferences(prompt);
  expect(refs).toHaveLength(count);
  return refs;
}

function expectSingleImageReference(prompt: string) {
  const refs = expectImageReferenceCount(prompt, 1);
  return refs[0];
}

describe("detectImageReferences", () => {
  it("detects absolute file paths with common extensions", () => {
    const ref = expectSingleImageReference(
      "Check this image /path/to/screenshot.png and tell me what you see",
    );

    expect(ref).toEqual({
      raw: "/path/to/screenshot.png",
      type: "path",
      resolved: "/path/to/screenshot.png",
    });
  });

  it("detects relative paths starting with ./", () => {
    const ref = expectSingleImageReference("Look at ./images/photo.jpg");

    expect(ref?.raw).toBe("./images/photo.jpg");
    expect(ref?.type).toBe("path");
  });

  it("detects relative paths starting with ../", () => {
    const ref = expectSingleImageReference("The file is at ../screenshots/test.jpeg");

    expect(ref?.raw).toBe("../screenshots/test.jpeg");
    expect(ref?.type).toBe("path");
  });

  it("detects home directory paths starting with ~/", () => {
    const ref = expectSingleImageReference("My photo is at ~/Pictures/vacation.png");

    expect(ref?.raw).toBe("~/Pictures/vacation.png");
    expect(ref?.type).toBe("path");
    // Resolved path should expand ~
    expect(ref?.resolved?.startsWith("~")).toBe(false);
  });

  it("detects multiple image references in a prompt", () => {
    const refs = expectImageReferenceCount(
      `
      Compare these two images:
      1. /home/user/photo1.png
      2. https://mysite.com/photo2.jpg
    `,
      1,
    );

    expect(refs.some((r) => r.type === "path")).toBe(true);
  });

  it("does not leak parser state between calls", () => {
    expectSingleImageReference("[media attached: /tmp/first.png (image/png)]");
    expectSingleImageReference("[Image: source: /tmp/second.jpg]");
    expectSingleImageReference("See file:///tmp/third.webp");
    expectSingleImageReference("See ./fourth.jpeg");
  });

  it("handles various image extensions", () => {
    const extensions = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "tiff", "heic"];
    for (const ext of extensions) {
      const prompt = `Image: /test/image.${ext}`;
      const refs = detectImageReferences(prompt);
      expect(refs.length).toBeGreaterThanOrEqual(1);
      expect(refs[0]?.raw).toContain(`.${ext}`);
    }
  });

  it("deduplicates repeated image references", () => {
    expectImageReferenceCount("Look at /path/image.png and also /path/image.png again", 1);
  });

  it("dedupe casing follows host filesystem conventions", () => {
    if (process.platform === "win32") {
      expectImageReferenceCount("Look at /tmp/Image.png and /tmp/image.png", 1);
      return;
    }
    expectImageReferenceCount("Look at /tmp/Image.png and /tmp/image.png", 2);
  });

  it("returns empty array when no images found", () => {
    expectNoImageReferences("Just some text without any image references");
  });

  it("ignores non-image file extensions", () => {
    expectNoImageReferences("Check /path/to/document.pdf and /code/file.ts");
  });

  it("handles paths inside quotes (without spaces)", () => {
    const ref = expectSingleImageReference('The file is at "/path/to/image.png"');

    expect(ref?.raw).toBe("/path/to/image.png");
  });

  it("handles paths in parentheses", () => {
    const ref = expectSingleImageReference("See the image (./screenshot.png) for details");

    expect(ref?.raw).toBe("./screenshot.png");
  });

  it("detects [Image: source: ...] format from messaging systems", () => {
    const ref = expectSingleImageReference(`What does this image show?
[Image: source: /Users/tyleryust/Library/Messages/Attachments/IMG_0043.jpeg]`);

    expect(ref?.raw).toBe("/Users/tyleryust/Library/Messages/Attachments/IMG_0043.jpeg");
    expect(ref?.type).toBe("path");
  });

  it("handles complex message attachment paths", () => {
    const ref = expectSingleImageReference(
      "[Image: source: /Users/tyleryust/Library/Messages/Attachments/23/03/AA4726EA-DB27-4269-BA56-1436936CC134/5E3E286A-F585-4E5E-9043-5BC2AFAFD81BIMG_0043.jpeg]",
    );

    expect(ref?.resolved).toContain("IMG_0043.jpeg");
  });

  it("detects multiple images in [media attached: ...] format", () => {
    // Multi-file format uses separate brackets on separate lines
    const refs = expectImageReferenceCount(
      `[media attached: 2 files]
[media attached 1/2: /Users/tyleryust/.openclaw/media/IMG_6430.jpeg (image/jpeg)]
[media attached 2/2: /Users/tyleryust/.openclaw/media/IMG_6431.jpeg (image/jpeg)]
what about these images?`,
      2,
    );

    expect(refs[0]?.resolved).toContain("IMG_6430.jpeg");
    expect(refs[1]?.resolved).toContain("IMG_6431.jpeg");
  });

  it("does not double-count path and url in same bracket", () => {
    // Single file with URL (| separates path from url, not multiple files)
    const ref = expectSingleImageReference(
      "[media attached: /cache/IMG_6430.jpeg (image/jpeg) | /cache/IMG_6430.jpeg]",
    );

    expect(ref?.resolved).toContain("IMG_6430.jpeg");
  });

  it("ignores remote URLs entirely (local-only)", () => {
    const refs = expectImageReferenceCount(
      `To send an image: MEDIA:https://example.com/image.jpg
Here is my actual image: /path/to/real.png
Also https://cdn.mysite.com/img.jpg`,
      1,
    );

    expect(refs[0]?.raw).toBe("/path/to/real.png");
  });

  it("handles single file format with URL (no index)", () => {
    const ref =
      expectSingleImageReference(`[media attached: /cache/photo.jpeg (image/jpeg) | https://example.com/url]
what is this?`);

    expect(ref?.resolved).toContain("photo.jpeg");
  });

  it("handles paths with spaces in filename", () => {
    // URL after | is https, not a local path, so only the local path should be detected
    const ref =
      expectSingleImageReference(`[media attached: /Users/test/.openclaw/media/ChatGPT Image Apr 21, 2025.png (image/png) | https://example.com/same.png]
what is this?`);

    // Only 1 ref - the local path (example.com URLs are skipped)
    expect(ref?.resolved).toContain("ChatGPT Image Apr 21, 2025.png");
  });

  it("ignores remote-host file URLs", () => {
    expectNoImageReferences("See file://attacker/share/evil.png");
  });

  it("ignores Windows network paths from attachment-style references", () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");

    try {
      expectNoImageReferences(
        "[media attached: \\\\attacker\\share\\photo.png (image/png)] what is this?",
      );
    } finally {
      platformSpy.mockRestore();
    }
  });
});

describe("modelSupportsImages", () => {
  it("returns true when model input includes image", () => {
    const model = { input: ["text", "image"] };
    expect(modelSupportsImages(model)).toBe(true);
  });

  it("returns false when model input does not include image", () => {
    const model = { input: ["text"] };
    expect(modelSupportsImages(model)).toBe(false);
  });

  it("returns false when model input is undefined", () => {
    const model = {};
    expect(modelSupportsImages(model)).toBe(false);
  });

  it("returns false when model input is empty", () => {
    const model = { input: [] };
    expect(modelSupportsImages(model)).toBe(false);
  });
});

describe("loadImageFromRef", () => {
  it("allows sandbox-validated host paths outside default media roots", async () => {
    const homeDir = os.homedir();
    await fs.mkdir(homeDir, { recursive: true });
    const sandboxParent = await fs.mkdtemp(path.join(homeDir, "openclaw-sandbox-image-"));
    try {
      const sandboxRoot = path.join(sandboxParent, "sandbox");
      await fs.mkdir(sandboxRoot, { recursive: true });
      const imagePath = path.join(sandboxRoot, "photo.png");
      const pngB64 =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/woAAn8B9FD5fHAAAAAASUVORK5CYII=";
      await fs.writeFile(imagePath, Buffer.from(pngB64, "base64"));

      const image = await loadImageFromRef(
        {
          raw: "./photo.png",
          type: "path",
          resolved: "./photo.png",
        },
        sandboxRoot,
        {
          sandbox: {
            root: sandboxRoot,
            bridge: createHostSandboxFsBridge(sandboxRoot),
          },
        },
      );

      expect(image).not.toBeNull();
      expect(image?.type).toBe("image");
      expect(image?.data.length).toBeGreaterThan(0);
    } finally {
      await fs.rm(sandboxParent, { recursive: true, force: true });
    }
  });
});

describe("detectAndLoadPromptImages", () => {
  it("returns no images for non-vision models even when existing images are provided", async () => {
    const result = await detectAndLoadPromptImages({
      prompt: "ignore",
      workspaceDir: "/tmp",
      model: { input: ["text"] },
      existingImages: [{ type: "image", data: "abc", mimeType: "image/png" }],
    });

    expectNoPromptImages(result);
  });

  it("returns no detected refs when prompt has no image references", async () => {
    const result = await detectAndLoadPromptImages({
      prompt: "no images here",
      workspaceDir: "/tmp",
      model: { input: ["text", "image"] },
    });

    expectNoPromptImages(result);
  });

  it("preserves attachment order when offloaded refs and inline images are mixed", async () => {
    const merged = mergePromptAttachmentImages({
      imageOrder: ["offloaded", "inline"],
      existingImages: [{ type: "image", data: "small-b", mimeType: "image/png" }],
      offloadedImages: [{ type: "image", data: "large-a", mimeType: "image/jpeg" }],
    });

    expect(merged).toEqual([
      { type: "image", data: "large-a", mimeType: "image/jpeg" },
      { type: "image", data: "small-b", mimeType: "image/png" },
    ]);
  });

  it("classifies trailing offloaded refs separately from prompt refs", () => {
    const prompt =
      "compare [media attached: media://inbound/prompt-ref.png] and ./prompt-b.png\n[media attached: media://inbound/att-b.png]";
    const refs = detectImageReferences(prompt);

    const split = splitPromptAndAttachmentRefs({
      prompt,
      refs,
      imageOrder: ["inline", "offloaded"],
    });

    expect(split.promptRefs).toEqual([
      {
        raw: "media://inbound/prompt-ref.png",
        type: "media-uri",
        resolved: "media://inbound/prompt-ref.png",
      },
      { raw: "./prompt-b.png", type: "path", resolved: "./prompt-b.png" },
    ]);
    expect(split.attachmentRefs).toEqual([
      {
        raw: "media://inbound/att-b.png",
        type: "media-uri",
        resolved: "media://inbound/att-b.png",
      },
    ]);
  });

  it("blocks prompt image refs outside workspace when sandbox workspaceOnly is enabled", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-native-image-sandbox-"));
    const sandboxRoot = path.join(stateDir, "sandbox");
    const agentRoot = path.join(stateDir, "agent");
    await fs.mkdir(sandboxRoot, { recursive: true });
    await fs.mkdir(agentRoot, { recursive: true });
    const pngB64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/woAAn8B9FD5fHAAAAAASUVORK5CYII=";
    await fs.writeFile(path.join(agentRoot, "secret.png"), Buffer.from(pngB64, "base64"));
    const sandbox = createUnsafeMountedSandbox({ sandboxRoot, agentRoot });
    const bridge = sandbox.fsBridge;
    if (!bridge) {
      throw new Error("sandbox fs bridge missing");
    }

    try {
      const result = await detectAndLoadPromptImages({
        prompt: "Inspect /agent/secret.png",
        workspaceDir: sandboxRoot,
        model: { input: ["text", "image"] },
        workspaceOnly: true,
        sandbox: { root: sandbox.workspaceDir, bridge },
      });

      expect(result.detectedRefs).toHaveLength(1);
      expect(result.loadedCount).toBe(0);
      expect(result.skippedCount).toBe(1);
      expect(result.images).toHaveLength(0);
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });
});
