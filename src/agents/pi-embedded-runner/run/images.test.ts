import { describe, expect, it } from "vitest";

import { detectAndLoadPromptImages, detectImageReferences, modelSupportsImages } from "./images.js";

describe("detectImageReferences", () => {
  it("detects absolute file paths with common extensions", () => {
    const prompt = "Check this image /path/to/screenshot.png and tell me what you see";
    const refs = detectImageReferences(prompt);

    expect(refs).toHaveLength(1);
    expect(refs[0]).toEqual({
      raw: "/path/to/screenshot.png",
      type: "path",
      resolved: "/path/to/screenshot.png",
    });
  });

  it("detects relative paths starting with ./", () => {
    const prompt = "Look at ./images/photo.jpg";
    const refs = detectImageReferences(prompt);

    expect(refs).toHaveLength(1);
    expect(refs[0]?.raw).toBe("./images/photo.jpg");
    expect(refs[0]?.type).toBe("path");
  });

  it("detects relative paths starting with ../", () => {
    const prompt = "The file is at ../screenshots/test.jpeg";
    const refs = detectImageReferences(prompt);

    expect(refs).toHaveLength(1);
    expect(refs[0]?.raw).toBe("../screenshots/test.jpeg");
    expect(refs[0]?.type).toBe("path");
  });

  it("detects home directory paths starting with ~/", () => {
    const prompt = "My photo is at ~/Pictures/vacation.png";
    const refs = detectImageReferences(prompt);

    expect(refs).toHaveLength(1);
    expect(refs[0]?.raw).toBe("~/Pictures/vacation.png");
    expect(refs[0]?.type).toBe("path");
    // Resolved path should expand ~
    expect(refs[0]?.resolved).not.toContain("~");
  });

  it("detects multiple image references in a prompt", () => {
    const prompt = `
      Compare these two images:
      1. /home/user/photo1.png
      2. https://mysite.com/photo2.jpg
    `;
    const refs = detectImageReferences(prompt);

    expect(refs).toHaveLength(1);
    expect(refs.some((r) => r.type === "path")).toBe(true);
    expect(refs.some((r) => r.type === "url")).toBe(false);
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
    const prompt = "Look at /path/image.png and also /path/image.png again";
    const refs = detectImageReferences(prompt);

    expect(refs).toHaveLength(1);
  });

  it("returns empty array when no images found", () => {
    const prompt = "Just some text without any image references";
    const refs = detectImageReferences(prompt);

    expect(refs).toHaveLength(0);
  });

  it("ignores non-image file extensions", () => {
    const prompt = "Check /path/to/document.pdf and /code/file.ts";
    const refs = detectImageReferences(prompt);

    expect(refs).toHaveLength(0);
  });

  it("handles paths inside quotes (without spaces)", () => {
    const prompt = 'The file is at "/path/to/image.png"';
    const refs = detectImageReferences(prompt);

    expect(refs).toHaveLength(1);
    expect(refs[0]?.raw).toBe("/path/to/image.png");
  });

  it("handles paths in parentheses", () => {
    const prompt = "See the image (./screenshot.png) for details";
    const refs = detectImageReferences(prompt);

    expect(refs).toHaveLength(1);
    expect(refs[0]?.raw).toBe("./screenshot.png");
  });

  it("detects [Image: source: ...] format from messaging systems", () => {
    const prompt = `What does this image show?
[Image: source: /Users/tyleryust/Library/Messages/Attachments/IMG_0043.jpeg]`;
    const refs = detectImageReferences(prompt);

    expect(refs).toHaveLength(1);
    expect(refs[0]?.raw).toBe("/Users/tyleryust/Library/Messages/Attachments/IMG_0043.jpeg");
    expect(refs[0]?.type).toBe("path");
  });

  it("handles complex message attachment paths", () => {
    const prompt = `[Image: source: /Users/tyleryust/Library/Messages/Attachments/23/03/AA4726EA-DB27-4269-BA56-1436936CC134/5E3E286A-F585-4E5E-9043-5BC2AFAFD81BIMG_0043.jpeg]`;
    const refs = detectImageReferences(prompt);

    expect(refs).toHaveLength(1);
    expect(refs[0]?.resolved).toContain("IMG_0043.jpeg");
  });

  it("detects multiple images in [media attached: ...] format", () => {
    // Multi-file format uses separate brackets on separate lines
    const prompt = `[media attached: 2 files]
[media attached 1/2: /Users/tyleryust/.clawdbot/media/IMG_6430.jpeg (image/jpeg)]
[media attached 2/2: /Users/tyleryust/.clawdbot/media/IMG_6431.jpeg (image/jpeg)]
what about these images?`;
    const refs = detectImageReferences(prompt);

    expect(refs).toHaveLength(2);
    expect(refs[0]?.resolved).toContain("IMG_6430.jpeg");
    expect(refs[1]?.resolved).toContain("IMG_6431.jpeg");
  });

  it("does not double-count path and url in same bracket", () => {
    // Single file with URL (| separates path from url, not multiple files)
    const prompt = `[media attached: /cache/IMG_6430.jpeg (image/jpeg) | /cache/IMG_6430.jpeg]`;
    const refs = detectImageReferences(prompt);

    expect(refs).toHaveLength(1);
    expect(refs[0]?.resolved).toContain("IMG_6430.jpeg");
  });

  it("ignores remote URLs entirely (local-only)", () => {
    const prompt = `To send an image: MEDIA:https://example.com/image.jpg
Here is my actual image: /path/to/real.png
Also https://cdn.mysite.com/img.jpg`;
    const refs = detectImageReferences(prompt);

    expect(refs).toHaveLength(1);
    expect(refs[0]?.raw).toBe("/path/to/real.png");
  });

  it("handles single file format with URL (no index)", () => {
    const prompt = `[media attached: /cache/photo.jpeg (image/jpeg) | https://example.com/url]
what is this?`;
    const refs = detectImageReferences(prompt);

    expect(refs).toHaveLength(1);
    expect(refs[0]?.resolved).toContain("photo.jpeg");
  });

  it("handles paths with spaces in filename", () => {
    // URL after | is https, not a local path, so only the local path should be detected
    const prompt = `[media attached: /Users/test/.clawdbot/media/ChatGPT Image Apr 21, 2025.png (image/png) | https://example.com/same.png]
what is this?`;
    const refs = detectImageReferences(prompt);

    // Only 1 ref - the local path (example.com URLs are skipped)
    expect(refs).toHaveLength(1);
    expect(refs[0]?.resolved).toContain("ChatGPT Image Apr 21, 2025.png");
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

describe("detectAndLoadPromptImages", () => {
  it("returns no images for non-vision models even when existing images are provided", async () => {
    const result = await detectAndLoadPromptImages({
      prompt: "ignore",
      workspaceDir: "/tmp",
      model: { input: ["text"] },
      existingImages: [{ type: "image", data: "abc", mimeType: "image/png" }],
    });

    expect(result.images).toHaveLength(0);
    expect(result.detectedRefs).toHaveLength(0);
  });

  it("skips history messages that already include image content", async () => {
    const result = await detectAndLoadPromptImages({
      prompt: "no images here",
      workspaceDir: "/tmp",
      model: { input: ["text", "image"] },
      historyMessages: [
        {
          role: "user",
          content: [
            { type: "text", text: "See /tmp/should-not-load.png" },
            { type: "image", data: "abc", mimeType: "image/png" },
          ],
        },
      ],
    });

    expect(result.detectedRefs).toHaveLength(0);
    expect(result.images).toHaveLength(0);
    expect(result.historyImagesByIndex.size).toBe(0);
  });
});
