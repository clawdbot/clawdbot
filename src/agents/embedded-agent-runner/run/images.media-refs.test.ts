import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { normalizeMediaFacts, resolveMediaFacts } from "../../../media/media-facts.js";
import { captureEnv, setTestEnvValue } from "../../../test-utils/env.js";
import { createHostSandboxFsBridge } from "../../test-helpers/host-sandbox-fs-bridge.js";
import { detectAndLoadPromptImages, hasHydratableMediaImages } from "./images.js";

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAsTAAALEwEAmpwYAAAADUlEQVR4nGP4////KwAJ5gPoxLp9owAAAABJRU5ErkJggg==";

describe("fact-carried image references", () => {
  it("counts only facts that will hydrate an image attachment", () => {
    expect(hasHydratableMediaImages([{ path: "/tmp/photo.png", kind: "image" }])).toBe(true);
    // Legacy transcript projections persist bare kinds as the media type.
    expect(hasHydratableMediaImages([{ path: "/tmp/photo.png", contentType: "image" }])).toBe(true);
    expect(hasHydratableMediaImages([{ path: "/tmp/anim.webp", contentType: "sticker" }])).toBe(
      true,
    );
    expect(hasHydratableMediaImages([{ kind: "image" }])).toBe(false);
    expect(
      hasHydratableMediaImages([{ url: "https://example.test/remote.png", kind: "image" }]),
    ).toBe(false);
    expect(
      hasHydratableMediaImages([{ path: "https://example.test/remote.png", kind: "image" }]),
    ).toBe(false);
    expect(hasHydratableMediaImages([])).toBe(false);
    expect(hasHydratableMediaImages(undefined)).toBe(false);
    for (const contentType of ["audio", "video", "document"]) {
      expect(hasHydratableMediaImages([{ path: "/tmp/photo.png", contentType }])).toBe(false);
    }
  });

  it("retains described-image suppression across fact copy boundaries", async () => {
    const normalized = normalizeMediaFacts([
      {
        path: "/tmp/described.png",
        contentType: "image/png",
        hydrationSuppressed: true,
      },
    ]);
    const reprojected = resolveMediaFacts({
      media: normalized,
      MediaPaths: ["/tmp/stale.png"],
      MediaTypes: ["application/octet-stream"],
    });

    expect(reprojected).toEqual([
      expect.objectContaining({
        path: "/tmp/described.png",
        contentType: "image/png",
        kind: "image",
        hydrationSuppressed: true,
      }),
    ]);
    const result = await detectAndLoadPromptImages({
      prompt: "already described",
      media: reprojected,
      workspaceDir: "/tmp",
      model: { input: ["text", "image"] },
    });
    expect(result.failedMediaCount).toBe(0);
    expect(result.images).toEqual([]);
  });

  it("pairs identity-less facts with existing inline images when order metadata is absent", async () => {
    const existingImage = { type: "image" as const, data: TINY_PNG_BASE64, mimeType: "image/png" };
    const result = await detectAndLoadPromptImages({
      prompt: "look",
      media: [{ kind: "image", contentType: "image/png" }],
      workspaceDir: "/tmp",
      model: { input: ["text", "image"] },
      existingImages: [existingImage],
    });

    expect(result.failedMediaCount).toBe(0);
    expect(result.images).toEqual([existingImage]);
  });

  it("loads an explicit ref matching a fact sliced into an inline slot", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-inline-explicit-ref-"));
    const imagePath = path.join(workspaceDir, "photo.png");
    await fs.writeFile(imagePath, Buffer.from(TINY_PNG_BASE64, "base64"));
    const inlineImage = { type: "image" as const, data: TINY_PNG_BASE64, mimeType: "image/png" };

    try {
      const result = await detectAndLoadPromptImages({
        prompt: `compare ${imagePath}`,
        media: [{ path: imagePath, contentType: "image/png" }],
        workspaceDir,
        model: { input: ["text", "image"] },
        existingImages: [inlineImage],
        imageOrder: ["inline"],
        workspaceOnly: true,
      });

      expect(result.loadedCount).toBe(1);
      expect(result.failedMediaCount).toBe(0);
      expect(result.images).toEqual([
        inlineImage,
        { type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" },
      ]);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("keeps identity-bearing refs when image order metadata has more inline slots", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-partial-inline-order-"));
    const imagePath = path.join(workspaceDir, "offloaded.png");
    await fs.writeFile(imagePath, Buffer.from(TINY_PNG_BASE64, "base64"));
    const firstInline = { type: "image" as const, data: TINY_PNG_BASE64, mimeType: "image/png" };
    const secondInline = { ...firstInline };

    try {
      const result = await detectAndLoadPromptImages({
        prompt: "compare",
        media: [{ path: imagePath, contentType: "image/png" }],
        workspaceDir,
        model: { input: ["text", "image"] },
        existingImages: [firstInline, secondInline],
        imageOrder: ["inline", "inline"],
        workspaceOnly: true,
      });

      expect(result.loadedCount).toBe(1);
      expect(result.failedMediaCount).toBe(0);
      expect(result.images).toEqual([
        firstInline,
        secondInline,
        { type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" },
      ]);
      expect(result.imageFactIndexes).toEqual([null, null, 0]);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("fails an exact inline slot whose image block is missing", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-missing-inline-"));
    const imagePath = path.join(workspaceDir, "stale.png");
    await fs.writeFile(imagePath, Buffer.from(TINY_PNG_BASE64, "base64"));

    try {
      const result = await detectAndLoadPromptImages({
        prompt: "inspect",
        media: [{ path: imagePath, contentType: "image/png" }],
        workspaceDir,
        model: { input: ["text", "image"] },
        imageOrder: ["inline"],
        workspaceOnly: true,
      });

      expect(result.loadedCount).toBe(0);
      expect(result.failedMediaCount).toBe(1);
      expect(result.images).toEqual([]);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("hydrates a fact whose only local identity is a file URL", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-image-file-url-"));
    const imagePath = path.join(workspaceDir, "photo.png");
    await fs.writeFile(imagePath, Buffer.from(TINY_PNG_BASE64, "base64"));

    try {
      const result = await detectAndLoadPromptImages({
        prompt: "",
        media: [{ path: pathToFileURL(imagePath).href, contentType: "image/png" }],
        workspaceDir,
        model: { input: ["text", "image"] },
        workspaceOnly: true,
      });
      expect(result.images).toEqual([
        { type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" },
      ]);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

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
      const result = await detectAndLoadPromptImages({
        prompt: "",
        media: [{ url: `media://inbound/${mediaId}`, contentType: "image/png" }],
        workspaceDir,
        model: { input: ["text", "image"] },
        workspaceOnly: true,
      });
      const image = result.images[0];

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
      const result = await detectAndLoadPromptImages({
        prompt: "",
        media: [{ url: `media://inbound/${mediaId}`, contentType: "image/png" }],
        model: { input: ["text", "image"] },
        workspaceDir: sandboxRoot,
        workspaceOnly: true,
        sandbox: {
          root: sandboxRoot,
          bridge: createHostSandboxFsBridge(sandboxRoot),
        },
      });
      const image = result.images[0];

      expect(image?.type).toBe("image");
      expect(image?.mimeType).toBe("image/png");
      expect(image?.data).toBe(TINY_PNG_BASE64);
    } finally {
      await fs.rm(sandboxRoot, { recursive: true, force: true });
    }
  });

  it.each([
    ["traversal", "media://inbound/../secret.png"],
    ["encoded traversal", "media://inbound/%2e%2e%2fsecret.png"],
    ["null byte", "media://inbound/secret%00.png"],
  ])("rejects %s claim-check facts", async (_label: string, mediaUrl: string) => {
    const result = await detectAndLoadPromptImages({
      prompt: "legacy ticket is carried structurally",
      media: [{ url: mediaUrl, contentType: "image/png" }],
      workspaceDir: "/tmp",
      model: { input: ["text", "image"] },
    });

    expect(result.loadedCount).toBe(0);
    expect(result.skippedCount).toBe(1);
    expect(result.images).toHaveLength(0);
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

      const result = await detectAndLoadPromptImages({
        prompt: "",
        media: [{ path: "./photo.png", contentType: "image/png" }],
        model: { input: ["text", "image"] },
        workspaceDir: sandboxRoot,
        sandbox: {
          root: sandboxRoot,
          bridge: createHostSandboxFsBridge(sandboxRoot),
        },
      });
      const image = result.images[0];

      expect(image?.type).toBe("image");
      expect(image?.mimeType).toBe("image/png");
      expect(image?.data).toBe(TINY_PNG_BASE64);
    } finally {
      await fs.rm(sandboxParent, { recursive: true, force: true });
    }
  });
});
