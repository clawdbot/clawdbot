// Prompt image tests cover local reference parsing, sandbox-aware loading, and
// attachment ordering for embedded runs that send images to vision models.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { resolvePreferredOpenClawTmpDir } from "../../../infra/tmp-openclaw-dir.js";
import { captureEnv, setTestEnvValue } from "../../../test-utils/env.js";
import { createHostSandboxFsBridge } from "../../test-helpers/host-sandbox-fs-bridge.js";
import { createUnsafeMountedSandbox } from "../../test-helpers/unsafe-mounted-sandbox.js";
import { detectAndLoadPromptImages, detectImageReferences, loadImageFromRef } from "./images.js";

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAsTAAALEwEAmpwYAAAADUlEQVR4nGP4////KwAJ5gPoxLp9owAAAABJRU5ErkJggg==";
const TINY_GIF_BUFFER = Buffer.from([
  71, 73, 70, 56, 57, 97, 1, 0, 1, 0, 128, 0, 0, 0, 0, 0, 255, 255, 255, 33, 249, 4, 1, 0, 0, 0, 0,
  44, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 68, 1, 0, 59,
]);

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
  // Most parser cases should find exactly one local image ref; this helper
  // keeps failures about over-detection obvious.
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

    expect(ref).toStrictEqual({
      raw: "./images/photo.jpg",
      type: "path",
      resolved: "./images/photo.jpg",
    });
  });

  it("detects relative paths starting with ../", () => {
    const ref = expectSingleImageReference("The file is at ../screenshots/test.jpeg");

    expect(ref).toStrictEqual({
      raw: "../screenshots/test.jpeg",
      type: "path",
      resolved: "../screenshots/test.jpeg",
    });
  });

  it("detects home directory paths starting with ~/", () => {
    const ref = expectSingleImageReference("My photo is at ~/Pictures/vacation.png");

    expect(ref).toStrictEqual({
      raw: "~/Pictures/vacation.png",
      type: "path",
      resolved: path.join(process.env.HOME ?? os.homedir(), "Pictures/vacation.png"),
    });
  });

  it("ignores OpenClaw CLI image cache paths from prior prompt transcripts", () => {
    // Cache paths from generated tool reminders are replay artifacts, not new
    // user attachments to hydrate again.
    const refs = detectImageReferences(
      [
        '<system-reminder>Called the Read tool with {"file_path":"/Users/ada/.openclaw/workspace/.openclaw-cli-images/stale.png"}</system-reminder>',
        "Compare it with /Users/ada/Pictures/current.png",
      ].join("\n"),
    );

    expect(refs).toStrictEqual([
      {
        raw: "/Users/ada/Pictures/current.png",
        type: "path",
        resolved: "/Users/ada/Pictures/current.png",
      },
    ]);
  });

  it("ignores temporary OpenClaw CLI image cache paths", () => {
    expectNoImageReferences(
      `Prior turn wrote ${path.join(resolvePreferredOpenClawTmpDir(), "openclaw-cli-images", "stale.jpg")}`,
    );
    expectNoImageReferences(
      `[media attached: ${path.join(resolvePreferredOpenClawTmpDir(), "openclaw-cli-images", "stale.jpg")} (image/jpeg)]`,
    );
    expectNoImageReferences(
      `Prior turn wrote ${path.join(os.tmpdir(), "openclaw", "openclaw-cli-images", "stale.jpg")}`,
    );
    expectNoImageReferences(
      `Prior turn wrote ${path.join(os.tmpdir(), "openclaw-501", "openclaw-cli-images", "stale.jpg")}`,
    );
  });

  it("ignores file URLs into the OpenClaw CLI image cache", () => {
    const stalePath = path.join(os.tmpdir(), "openclaw", "openclaw-cli-images", "stale.png");

    expectNoImageReferences(`Prior turn wrote ${pathToFileURL(stalePath).href}`);
  });

  it("detects normal user image paths in similarly named directories", () => {
    expect(detectImageReferences("/workspace/openclaw-cli-images/current.png")).toStrictEqual([
      {
        raw: "/workspace/openclaw-cli-images/current.png",
        type: "path",
        resolved: "/workspace/openclaw-cli-images/current.png",
      },
    ]);
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

    expect(refs).toStrictEqual([
      {
        raw: "/home/user/photo1.png",
        type: "path",
        resolved: "/home/user/photo1.png",
      },
    ]);
  });

  it("does not leak parser state between calls", () => {
    expect(detectImageReferences("[media attached: /tmp/first.png (image/png)]")).toStrictEqual([
      { raw: "/tmp/first.png", type: "path", resolved: "/tmp/first.png" },
    ]);
    expect(detectImageReferences("[Image: source: /tmp/second.jpg]")).toStrictEqual([
      { raw: "/tmp/second.jpg", type: "path", resolved: "/tmp/second.jpg" },
    ]);
    const thirdPath = path.join(os.tmpdir(), "third.webp");
    const thirdUrl = pathToFileURL(thirdPath).href;
    expect(detectImageReferences(`See ${thirdUrl}`)).toStrictEqual([
      { raw: thirdUrl, type: "path", resolved: thirdPath },
    ]);
    expect(detectImageReferences("See ./fourth.jpeg")).toStrictEqual([
      { raw: "./fourth.jpeg", type: "path", resolved: "./fourth.jpeg" },
    ]);
  });

  it("handles various image extensions", () => {
    const extensions = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "tiff", "heic"];
    for (const ext of extensions) {
      const prompt = `Image: /test/image.${ext}`;
      const refs = detectImageReferences(prompt);
      expect(refs).toStrictEqual([
        {
          raw: `/test/image.${ext}`,
          type: "path",
          resolved: `/test/image.${ext}`,
        },
      ]);
    }
  });

  it("deduplicates repeated image references", () => {
    expect(
      detectImageReferences("Look at /path/image.png and also /path/image.png again"),
    ).toStrictEqual([
      {
        raw: "/path/image.png",
        type: "path",
        resolved: "/path/image.png",
      },
    ]);
  });

  it("dedupe casing follows host filesystem conventions", () => {
    // Windows resolves these as the same path, while POSIX hosts preserve both
    // candidates because case can identify different files.
    const prompt = "Look at /tmp/Image.png and /tmp/image.png";
    if (process.platform === "win32") {
      expect(detectImageReferences(prompt)).toStrictEqual([
        {
          raw: "/tmp/Image.png",
          type: "path",
          resolved: "/tmp/Image.png",
        },
      ]);
      return;
    }
    expect(detectImageReferences(prompt)).toStrictEqual([
      {
        raw: "/tmp/Image.png",
        type: "path",
        resolved: "/tmp/Image.png",
      },
      {
        raw: "/tmp/image.png",
        type: "path",
        resolved: "/tmp/image.png",
      },
    ]);
  });

  it("returns empty array when no images found", () => {
    expectNoImageReferences("Just some text without any image references");
  });

  it("ignores non-image file extensions", () => {
    expectNoImageReferences("Check /path/to/document.pdf and /code/file.ts");
  });

  it("handles paths inside quotes (without spaces)", () => {
    const ref = expectSingleImageReference('The file is at "/path/to/image.png"');

    expect(ref).toStrictEqual({
      raw: "/path/to/image.png",
      type: "path",
      resolved: "/path/to/image.png",
    });
  });

  it("handles paths in parentheses", () => {
    const ref = expectSingleImageReference("See the image (./screenshot.png) for details");

    expect(ref).toStrictEqual({
      raw: "./screenshot.png",
      type: "path",
      resolved: "./screenshot.png",
    });
  });

  it("detects Windows drive image paths in plain prompts", () => {
    const ref = expectSingleImageReference(
      String.raw`Look at C:\Users\Ada\Pictures\screenshot.png`,
    );

    expect(ref).toStrictEqual({
      raw: String.raw`C:\Users\Ada\Pictures\screenshot.png`,
      type: "path",
      resolved: String.raw`C:\Users\Ada\Pictures\screenshot.png`,
    });
  });

  it("detects [Image: source: ...] format from messaging systems", () => {
    const ref = expectSingleImageReference(`What does this image show?
[Image: source: /Users/tyleryust/Library/Messages/Attachments/IMG_0043.jpeg]`);

    expect(ref).toStrictEqual({
      raw: "/Users/tyleryust/Library/Messages/Attachments/IMG_0043.jpeg",
      type: "path",
      resolved: "/Users/tyleryust/Library/Messages/Attachments/IMG_0043.jpeg",
    });
  });

  it("handles complex message attachment paths", () => {
    const ref = expectSingleImageReference(
      "[Image: source: /Users/tyleryust/Library/Messages/Attachments/23/03/AA4726EA-DB27-4269-BA56-1436936CC134/5E3E286A-F585-4E5E-9043-5BC2AFAFD81BIMG_0043.jpeg]",
    );

    expect(ref).toStrictEqual({
      raw: "/Users/tyleryust/Library/Messages/Attachments/23/03/AA4726EA-DB27-4269-BA56-1436936CC134/5E3E286A-F585-4E5E-9043-5BC2AFAFD81BIMG_0043.jpeg",
      type: "path",
      resolved:
        "/Users/tyleryust/Library/Messages/Attachments/23/03/AA4726EA-DB27-4269-BA56-1436936CC134/5E3E286A-F585-4E5E-9043-5BC2AFAFD81BIMG_0043.jpeg",
    });
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

    expect(refs).toStrictEqual([
      {
        raw: "/Users/tyleryust/.openclaw/media/IMG_6430.jpeg",
        type: "path",
        resolved: "/Users/tyleryust/.openclaw/media/IMG_6430.jpeg",
      },
      {
        raw: "/Users/tyleryust/.openclaw/media/IMG_6431.jpeg",
        type: "path",
        resolved: "/Users/tyleryust/.openclaw/media/IMG_6431.jpeg",
      },
    ]);
  });

  it("does not double-count path and url in same bracket", () => {
    // Single file with URL (| separates path from url, not multiple files)
    const ref = expectSingleImageReference(
      "[media attached: /cache/IMG_6430.jpeg (image/jpeg) | /cache/IMG_6430.jpeg]",
    );

    expect(ref).toStrictEqual({
      raw: "/cache/IMG_6430.jpeg",
      type: "path",
      resolved: "/cache/IMG_6430.jpeg",
    });
  });

  it("ignores remote URLs entirely (local-only)", () => {
    const refs = expectImageReferenceCount(
      `To send an image: MEDIA:https://example.com/image.jpg
Here is my actual image: /path/to/real.png
Also https://cdn.mysite.com/img.jpg`,
      1,
    );

    expect(refs).toStrictEqual([
      {
        raw: "/path/to/real.png",
        type: "path",
        resolved: "/path/to/real.png",
      },
    ]);
  });

  it("handles single file format with URL (no index)", () => {
    const ref =
      expectSingleImageReference(`[media attached: /cache/photo.jpeg (image/jpeg) | https://example.com/url]
what is this?`);

    expect(ref).toStrictEqual({
      raw: "/cache/photo.jpeg",
      type: "path",
      resolved: "/cache/photo.jpeg",
    });
  });

  it("handles paths with spaces in filename", () => {
    // URL after | is https, not a local path, so only the local path should be detected
    const ref =
      expectSingleImageReference(`[media attached: /Users/test/.openclaw/media/ChatGPT Image Apr 21, 2025.png (image/png) | https://example.com/same.png]
what is this?`);

    expect(ref).toStrictEqual({
      raw: "/Users/test/.openclaw/media/ChatGPT Image Apr 21, 2025.png",
      type: "path",
      resolved: "/Users/test/.openclaw/media/ChatGPT Image Apr 21, 2025.png",
    });
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

describe("loadImageFromRef", () => {
  it("hydrates managed inbound media URIs before workspace path resolution", async () => {
    // Managed media URIs are canonical inbound attachment handles and should
    // work even when workspaceOnly would reject ordinary outside paths.
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-native-image-uri-"));
    const workspaceDir = path.join(stateDir, "workspace-agent");
    const inboundDir = path.join(stateDir, "media", "inbound");
    const mediaId = "telegram-photo.png";
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(inboundDir, { recursive: true });
    await fs.writeFile(path.join(inboundDir, mediaId), Buffer.from(TINY_PNG_BASE64, "base64"));
    const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);

    try {
      const image = await loadImageFromRef(
        {
          raw: `media://inbound/${mediaId}`,
          type: "media-uri",
          resolved: `media://inbound/${mediaId}`,
        },
        workspaceDir,
        { workspaceOnly: true },
      );

      expect(image?.type).toBe("image");
      expect(image?.mimeType).toBe("image/png");
      expect(image?.data).toBe(TINY_PNG_BASE64);
    } finally {
      envSnapshot.restore();
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("hydrates sandbox-staged inbound media URIs", async () => {
    const sandboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-native-image-sbx-uri-"));
    const inboundDir = path.join(sandboxRoot, "media", "inbound");
    const mediaId = "telegram-photo.png";
    await fs.mkdir(inboundDir, { recursive: true });
    await fs.writeFile(path.join(inboundDir, mediaId), Buffer.from(TINY_PNG_BASE64, "base64"));

    try {
      const image = await loadImageFromRef(
        {
          raw: `media://inbound/${mediaId}`,
          type: "media-uri",
          resolved: `media://inbound/${mediaId}`,
        },
        sandboxRoot,
        {
          workspaceOnly: true,
          sandbox: {
            root: sandboxRoot,
            bridge: createHostSandboxFsBridge(sandboxRoot),
          },
        },
      );

      expect(image?.type).toBe("image");
      expect(image?.mimeType).toBe("image/png");
      expect(image?.data).toBe(TINY_PNG_BASE64);
    } finally {
      await fs.rm(sandboxRoot, { recursive: true, force: true });
    }
  });

  it("allows sandbox-validated host paths outside default media roots", async () => {
    const homeDir = os.homedir();
    await fs.mkdir(homeDir, { recursive: true });
    const sandboxParent = await fs.mkdtemp(path.join(homeDir, "openclaw-sandbox-image-"));
    try {
      const sandboxRoot = path.join(sandboxParent, "sandbox");
      await fs.mkdir(sandboxRoot, { recursive: true });
      const imagePath = path.join(sandboxRoot, "photo.png");
      const pngB64 = TINY_PNG_BASE64;
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

      expect(image?.type).toBe("image");
      expect(image?.mimeType).toBe("image/png");
      expect(image?.data).toBe(TINY_PNG_BASE64);
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

  it("sanitizes existing images even when prompt has no image references", async () => {
    const result = await detectAndLoadPromptImages({
      prompt: "describe the attached image",
      workspaceDir: "/tmp",
      model: { input: ["text", "image"] },
      existingImages: [{ type: "image", data: "not-valid-base64", mimeType: "image/png" }],
    });

    expect(result.images).toHaveLength(0);
    expect(result.detectedRefs).toHaveLength(0);
  });

  it("skips generated media-note refs already supplied inline", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-native-image-dedupe-"));
    const imagePath = path.join(stateDir, "photo.png");
    const pngB64 = TINY_PNG_BASE64;
    await fs.writeFile(imagePath, Buffer.from(pngB64, "base64"));

    try {
      const result = await detectAndLoadPromptImages({
        prompt: "[media attached: ./photo.png (image/png)]\ndescribe it",
        workspaceDir: stateDir,
        model: { input: ["text", "image"] },
        existingImages: [{ type: "image", data: pngB64, mimeType: "image/png" }],
        imageOrder: ["inline"],
        workspaceOnly: true,
      });

      expect(result.detectedRefs).toHaveLength(1);
      expect(result.loadedCount).toBe(0);
      expect(result.skippedCount).toBe(0);
      expect(result.images).toEqual([{ type: "image", data: pngB64, mimeType: "image/png" }]);
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("keeps distinct inline attachments with identical bytes", async () => {
    const pngB64 = TINY_PNG_BASE64;
    const image = { type: "image" as const, data: pngB64, mimeType: "image/png" };

    const result = await detectAndLoadPromptImages({
      prompt: "compare these attachments",
      workspaceDir: "/tmp",
      model: { input: ["text", "image"] },
      existingImages: [image, image],
      imageOrder: ["inline", "inline"],
      workspaceOnly: true,
    });

    expect(result.images).toEqual([image, image]);
  });

  it("classifies prompt and attachment refs while preserving mixed attachment order", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-native-image-order-"));
    const inboundDir = path.join(stateDir, "media", "inbound");
    await fs.mkdir(inboundDir, { recursive: true });
    await fs.writeFile(path.join(inboundDir, "att-b.gif"), TINY_GIF_BUFFER);
    await fs.writeFile(
      path.join(inboundDir, "prompt-ref.png"),
      Buffer.from(TINY_PNG_BASE64, "base64"),
    );
    await fs.writeFile(path.join(stateDir, "prompt-b.png"), Buffer.from(TINY_PNG_BASE64, "base64"));
    const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    const prompt =
      "compare [media attached: media://inbound/prompt-ref.png] and ./prompt-b.png\n[media attached: media://inbound/att-b.gif]";

    try {
      const result = await detectAndLoadPromptImages({
        prompt,
        workspaceDir: stateDir,
        model: { input: ["text", "image"] },
        existingImages: [{ type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" }],
        imageOrder: ["offloaded", "inline"],
        workspaceOnly: true,
      });

      expect(result.detectedRefs).toEqual([
        {
          raw: "media://inbound/prompt-ref.png",
          type: "media-uri",
          resolved: "media://inbound/prompt-ref.png",
        },
        {
          raw: "media://inbound/att-b.gif",
          type: "media-uri",
          resolved: "media://inbound/att-b.gif",
        },
        { raw: "./prompt-b.png", type: "path", resolved: "./prompt-b.png" },
      ]);
      expect(result.loadedCount).toBe(3);
      expect(result.images).toEqual([
        { type: "image", data: TINY_GIF_BUFFER.toString("base64"), mimeType: "image/gif" },
        { type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" },
        { type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" },
        { type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" },
      ]);
    } finally {
      envSnapshot.restore();
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("blocks prompt image refs outside workspace when sandbox workspaceOnly is enabled", async () => {
    // Sandbox workspaceOnly uses the bridge to validate mounted paths; ordinary
    // prompt refs outside the workspace are detected but intentionally skipped.
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-native-image-sandbox-"));
    const sandboxRoot = path.join(stateDir, "sandbox");
    const agentRoot = path.join(stateDir, "agent");
    await fs.mkdir(sandboxRoot, { recursive: true });
    await fs.mkdir(agentRoot, { recursive: true });
    const pngB64 = TINY_PNG_BASE64;
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

  it("loads managed inbound absolute paths when workspaceOnly is enabled", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-native-image-managed-"));
    const workspaceDir = path.join(stateDir, "workspace-agent");
    const inboundDir = path.join(stateDir, "media", "inbound");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(inboundDir, { recursive: true });
    const imagePath = path.join(inboundDir, "signal-replay.png");
    const pngB64 = TINY_PNG_BASE64;
    await fs.writeFile(imagePath, Buffer.from(pngB64, "base64"));
    const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);

    try {
      const result = await detectAndLoadPromptImages({
        prompt: `Inspect ${imagePath}`,
        workspaceDir,
        model: { input: ["text", "image"] },
        workspaceOnly: true,
      });

      expect(result.detectedRefs).toHaveLength(1);
      expect(result.loadedCount).toBe(1);
      expect(result.skippedCount).toBe(0);
      expect(result.images).toHaveLength(1);
    } finally {
      envSnapshot.restore();
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });
});
