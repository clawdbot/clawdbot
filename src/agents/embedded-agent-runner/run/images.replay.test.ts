import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createSolidPngBuffer } from "../../../../test/helpers/image-fixtures.js";
import { buildInboundMediaNoteProjection } from "../../../auto-reply/media-note.js";
import {
  attachRuntimePromptMediaFacts,
  readRuntimePromptImageOrder,
  readRuntimePromptMediaFacts,
} from "../../../media/media-facts.js";
import {
  finalizeRuntimePromptImages,
  readRuntimePromptImageFactIndexes,
} from "../../../media/runtime-prompt-image-provenance.js";
import { buildPersistedUserTurnMessage } from "../../../sessions/user-turn-transcript.js";
import { captureEnv, setTestEnvValue } from "../../../test-utils/env.js";
import type { AgentMessage } from "../../runtime/index.js";
import {
  detectAndLoadPromptImages,
  detectImageReferences,
  hydratePromptMediaMessages,
} from "./images.js";

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAsTAAALEwEAmpwYAAAADUlEQVR4nGP4////KwAJ5gPoxLp9owAAAABJRU5ErkJggg==";

describe("structured prompt media replay", () => {
  it("keeps per-slot provenance when the same image object is reused", () => {
    const sharedImage = { type: "image" as const, data: TINY_PNG_BASE64, mimeType: "image/png" };
    const { images } = finalizeRuntimePromptImages([
      { image: sharedImage, factIndex: 0 },
      { image: sharedImage, factIndex: 1 },
    ]);

    expect(readRuntimePromptImageFactIndexes(images)).toEqual([0, 1]);
  });

  it("retains the runtime fact carrier when queued hydration fails", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-runtime-failure-"));
    const media = [{ path: path.join(workspaceDir, "missing.png"), contentType: "image/png" }];
    const message = attachRuntimePromptMediaFacts(
      { role: "user" as const, content: "missing attachment" },
      media,
      ["offloaded"],
    ) as unknown as AgentMessage;
    const runtimeMedia = readRuntimePromptMediaFacts(message);

    try {
      const result = await hydratePromptMediaMessages([message], {
        workspaceDir,
        model: { input: ["text", "image"] },
        workspaceOnly: true,
      });
      expect(readRuntimePromptMediaFacts(result[0] as AgentMessage)).toEqual(runtimeMedia);
      expect(readRuntimePromptImageOrder(result[0] as AgentMessage)).toEqual(["offloaded"]);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("does not fail a described remote-only fact with no local identity", async () => {
    const media = buildInboundMediaNoteProjection({
      media: [{ url: "https://example.com/described.png", contentType: "image/png" }],
      MediaUnderstanding: [
        {
          kind: "image.description",
          attachmentIndex: 0,
          text: "already described",
          provider: "test",
        },
      ],
    }).media;

    const result = await detectAndLoadPromptImages({
      prompt: "already described",
      media,
      workspaceDir: "/tmp",
      model: { input: ["text", "image"] },
    });

    expect(result.failedMediaCount).toBe(0);
    expect(result.detectedRefs).toEqual([]);
    expect(result.images).toEqual([]);
  });

  it("reports a fact-owned image dropped during sanitization", async () => {
    const result = await detectAndLoadPromptImages({
      prompt: "inspect it",
      media: [{ path: "/tmp/already-materialized.png", contentType: "image/png" }],
      workspaceDir: "/tmp",
      model: { input: ["text", "image"] },
      existingImages: [{ type: "image", data: "%%%", mimeType: "image/png" }],
      existingImageFactIndexes: [0],
      imageOrder: ["inline"],
    });

    expect(result.failedMediaCount).toBe(1);
    expect(result.images).toEqual([]);
  });

  it("preserves persisted facts when replay hydration fails", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-replay-failure-"));
    const missingPath = path.join(workspaceDir, "missing.png");
    const message = {
      role: "user" as const,
      content: "missing attachment",
      MediaPath: missingPath,
      MediaPaths: [missingPath],
      MediaType: "image/png",
      MediaTypes: ["image/png"],
    } as unknown as AgentMessage;

    try {
      const result = await hydratePromptMediaMessages([message], {
        workspaceDir,
        model: { input: ["text", "image"] },
        workspaceOnly: true,
      });
      const replayed = result[0] as unknown as Record<string, unknown>;
      expect(replayed.MediaPaths).toEqual([missingPath]);
      expect(replayed.content).toEqual([{ type: "text", text: "missing attachment" }]);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("detects bracketed explicit paths but not textual claim-check tickets", () => {
    expect(detectImageReferences("inspect [source /tmp/photo.png]")).toEqual([
      { raw: "/tmp/photo.png", type: "path", resolved: "/tmp/photo.png" },
    ]);
    expect(detectImageReferences("[media attached: media://inbound/legacy.png]")).toEqual([]);
    expect(detectImageReferences("[media attached: /tmp/legacy.png (image/png)]")).toEqual([]);
    expect(detectImageReferences("[Image: source: /tmp/legacy.png]")).toEqual([]);
  });

  it("dedupes the rendered alias of a private macOS path", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    try {
      const result = await detectAndLoadPromptImages({
        prompt: "[media attached: /var/tmp/aliased.png (image/png)]",
        media: [{ path: "/private/var/tmp/aliased.png", contentType: "image/png" }],
        workspaceDir: "/tmp",
        model: { input: ["text", "image"] },
      });

      expect(result.detectedRefs).toEqual([
        {
          raw: "/private/var/tmp/aliased.png",
          resolved: "/private/var/tmp/aliased.png",
          type: "path",
        },
      ]);
      expect(result.skippedCount).toBe(1);
    } finally {
      platformSpy.mockRestore();
    }
  });

  it("keeps private-var and var paths distinct away from Darwin", () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    try {
      expect(
        detectImageReferences("compare /private/var/tmp/a.png and /var/tmp/a.png"),
      ).toHaveLength(2);
    } finally {
      platformSpy.mockRestore();
    }
  });

  it("expands a home-relative path carried by a media fact", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-fact-home-"));
    const imagePath = path.join(homeDir, "Pictures", "photo.png");
    await fs.mkdir(path.dirname(imagePath), { recursive: true });
    await fs.writeFile(imagePath, Buffer.from(TINY_PNG_BASE64, "base64"));
    const envSnapshot = captureEnv(["HOME"]);
    setTestEnvValue("HOME", homeDir);
    try {
      const result = await detectAndLoadPromptImages({
        prompt: "describe it",
        media: [{ path: "~/Pictures/photo.png", contentType: "image/png" }],
        workspaceDir: "/tmp",
        model: { input: ["text", "image"] },
        localRoots: [homeDir],
      });
      expect(result.images).toHaveLength(1);
    } finally {
      envSnapshot.restore();
      await fs.rm(homeDir, { recursive: true, force: true });
    }
  });

  it("keeps same-spelled relative refs from different workspaces distinct", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-relative-roots-"));
    const stagedDir = path.join(rootDir, "staged");
    const currentDir = path.join(rootDir, "current");
    await fs.mkdir(stagedDir, { recursive: true });
    await fs.mkdir(currentDir, { recursive: true });
    await fs.writeFile(path.join(stagedDir, "photo.png"), Buffer.from(TINY_PNG_BASE64, "base64"));
    await fs.writeFile(
      path.join(currentDir, "photo.png"),
      createSolidPngBuffer(1, 1, { r: 0, g: 0, b: 255 }),
    );

    try {
      const result = await detectAndLoadPromptImages({
        prompt: "compare ./photo.png",
        media: [{ path: "./photo.png", contentType: "image/png", workspaceDir: stagedDir }],
        workspaceDir: currentDir,
        model: { input: ["text", "image"] },
        localRoots: [stagedDir, currentDir],
      });
      expect(result.loadedCount).toBe(2);
      expect(result.images).toHaveLength(2);
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });

  it("does not duplicate an already-materialized offloaded slot", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-materialized-offload-"));
    const imagePath = path.join(workspaceDir, "offloaded.png");
    await fs.writeFile(imagePath, Buffer.from(TINY_PNG_BASE64, "base64"));
    const image = { type: "image" as const, data: TINY_PNG_BASE64, mimeType: "image/png" };
    const persisted = buildPersistedUserTurnMessage({
      text: "already materialized",
      media: [{ path: imagePath, contentType: "image/png" }],
      mediaImageLayout: { slots: [{ kind: "offloaded", factIndex: 0 }] },
    }) as unknown as AgentMessage;

    try {
      const first = await hydratePromptMediaMessages([persisted], {
        workspaceDir,
        model: { input: ["text", "image"] },
        workspaceOnly: true,
      });
      const serialized = JSON.stringify(first[0]);
      const restored = JSON.parse(serialized) as AgentMessage;
      await fs.rm(imagePath);
      const replay = await hydratePromptMediaMessages([restored], {
        workspaceDir,
        model: { input: ["text", "image"] },
        workspaceOnly: true,
      });
      expect((replay[0] as unknown as { content?: unknown }).content).toEqual([
        { type: "text", text: "already materialized" },
        image,
      ]);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("prefers persisted fact-index layout when runtime order is also present", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-layout-authority-"));
    const describedPath = path.join(workspaceDir, "described.png");
    const inlinePath = path.join(workspaceDir, "inline.png");
    const offloadedPath = path.join(workspaceDir, "offloaded.png");
    const offloadedBuffer = createSolidPngBuffer(1, 1, { r: 0, g: 0, b: 255 });
    await fs.writeFile(describedPath, createSolidPngBuffer(1, 1, { r: 255, g: 0, b: 0 }));
    await fs.writeFile(inlinePath, Buffer.from(TINY_PNG_BASE64, "base64"));
    await fs.writeFile(offloadedPath, offloadedBuffer);
    const inlineImage = { type: "image" as const, data: TINY_PNG_BASE64, mimeType: "image/png" };
    const media = [
      { path: describedPath, contentType: "image/png" },
      { path: inlinePath, contentType: "image/png" },
      { path: offloadedPath, contentType: "image/png" },
    ];
    const persisted = buildPersistedUserTurnMessage({
      text: "compare",
      media,
      mediaImageLayout: {
        slots: [
          { kind: "inline", factIndex: 1 },
          { kind: "offloaded", factIndex: 2 },
        ],
        suppressedFactIndexes: [0],
      },
    });
    const message = attachRuntimePromptMediaFacts(
      {
        ...persisted,
        content: [{ type: "text" as const, text: "compare" }, inlineImage],
      } as AgentMessage,
      media,
      ["inline", "offloaded"],
    );

    try {
      const first = await hydratePromptMediaMessages([message], {
        workspaceDir,
        model: { input: ["text", "image"] },
        workspaceOnly: true,
      });
      const firstContent = (first[0] as unknown as { content?: unknown[] }).content;
      expect(firstContent).toEqual([
        { type: "text", text: "compare" },
        inlineImage,
        { type: "image", data: offloadedBuffer.toString("base64"), mimeType: "image/png" },
      ]);

      const serialized = JSON.stringify(first[0]);
      await fs.rm(describedPath);
      await fs.rm(inlinePath);
      await fs.rm(offloadedPath);
      const replay = await hydratePromptMediaMessages([JSON.parse(serialized) as AgentMessage], {
        workspaceDir,
        model: { input: ["text", "image"] },
        workspaceOnly: true,
      });
      expect((replay[0] as unknown as { content?: unknown[] }).content).toEqual(firstContent);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("retries an offloaded fact even when an unrelated explicit image exists", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-offload-retry-"));
    const explicitImage = {
      type: "image" as const,
      data: TINY_PNG_BASE64,
      mimeType: "image/png",
    };
    try {
      const result = await detectAndLoadPromptImages({
        prompt: "retry missing attachment",
        media: [{ path: path.join(workspaceDir, "missing.png"), contentType: "image/png" }],
        mediaImageLayout: {
          slots: [{ kind: "offloaded", factIndex: 0 }],
          suppressedFactIndexes: [],
        },
        workspaceDir,
        model: { input: ["text", "image"] },
        existingImages: [explicitImage],
        existingImageFactIndexes: [null],
        workspaceOnly: true,
      });
      expect(result.failedMediaCount).toBe(1);
      expect(result.images).toEqual([explicitImage]);
      expect(result.imageFactIndexes).toEqual([null]);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("does not assign a partial offloaded fact to an existing inline image", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-partial-facts-"));
    const offloadedPath = path.join(workspaceDir, "offloaded.png");
    const offloadedBuffer = createSolidPngBuffer(1, 1, { r: 0, g: 0, b: 255 });
    await fs.writeFile(offloadedPath, offloadedBuffer);
    const inlineImage = { type: "image" as const, data: TINY_PNG_BASE64, mimeType: "image/png" };

    try {
      const result = await detectAndLoadPromptImages({
        prompt: "compare",
        media: [{ path: offloadedPath, contentType: "image/png" }],
        workspaceDir,
        model: { input: ["text", "image"] },
        existingImages: [inlineImage],
        imageOrder: ["inline", "offloaded"],
        workspaceOnly: true,
      });
      expect(result.failedMediaCount).toBe(0);
      expect(result.loadedCount).toBe(1);
      expect(result.images).toEqual([
        inlineImage,
        { type: "image", data: offloadedBuffer.toString("base64"), mimeType: "image/png" },
      ]);
      expect(result.imageFactIndexes).toEqual([null, 0]);
      expect(readRuntimePromptImageFactIndexes(result.images)).toEqual([null, 0]);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("preserves fact order for partial hydration without persisted layout", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-partial-order-"));
    const firstPath = path.join(workspaceDir, "first.png");
    const secondPath = path.join(workspaceDir, "second.png");
    const thirdPath = path.join(workspaceDir, "third.png");
    const secondBuffer = createSolidPngBuffer(1, 1, { r: 0, g: 255, b: 0 });
    const thirdBuffer = createSolidPngBuffer(1, 1, { r: 0, g: 0, b: 255 });
    await fs.writeFile(thirdPath, thirdBuffer);
    const firstImage = { type: "image" as const, data: TINY_PNG_BASE64, mimeType: "image/png" };
    const secondImage = {
      type: "image" as const,
      data: secondBuffer.toString("base64"),
      mimeType: "image/png",
    };

    try {
      const result = await detectAndLoadPromptImages({
        prompt: "compare",
        media: [
          { path: firstPath, contentType: "image/png" },
          { path: secondPath, contentType: "image/png" },
          { path: thirdPath, contentType: "image/png" },
        ],
        workspaceDir,
        model: { input: ["text", "image"] },
        existingImages: [firstImage, secondImage],
        existingImageFactIndexes: [0, 1],
        imageOrder: ["offloaded", "inline", "offloaded"],
        workspaceOnly: true,
      });

      expect(result.failedMediaCount).toBe(0);
      expect(result.images).toEqual([
        firstImage,
        secondImage,
        { type: "image", data: thirdBuffer.toString("base64"), mimeType: "image/png" },
      ]);
      expect(result.imageFactIndexes).toEqual([0, 1, 2]);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("uses an unowned block for an inline slot when exact provenance is unavailable", async () => {
    const inlineImage = { type: "image" as const, data: TINY_PNG_BASE64, mimeType: "image/png" };
    const offloadedImage = {
      type: "image" as const,
      data: createSolidPngBuffer(1, 1, { r: 0, g: 255, b: 0 }).toString("base64"),
      mimeType: "image/png",
    };

    const result = await detectAndLoadPromptImages({
      prompt: "compare",
      media: [{ kind: "document" }, { kind: "image" }, { kind: "image" }],
      mediaImageLayout: {
        slots: [
          { kind: "inline", factIndex: 1 },
          { kind: "offloaded", factIndex: 2 },
        ],
        suppressedFactIndexes: [],
      },
      workspaceDir: "/tmp",
      model: { input: ["text", "image"] },
      existingImages: [inlineImage, offloadedImage],
      existingImageFactIndexes: [null, 2],
    });

    expect(result.failedMediaCount).toBe(0);
    expect(result.images).toEqual([inlineImage, offloadedImage]);
    expect(result.imageFactIndexes).toEqual([null, 2]);
  });

  it("uses explicit inline layout ownership for sanitization failures", async () => {
    const result = await detectAndLoadPromptImages({
      prompt: "inspect",
      media: [{ kind: "image" }, { kind: "image" }],
      mediaImageLayout: {
        slots: [{ kind: "inline", factIndex: 1 }],
        suppressedFactIndexes: [0],
      },
      workspaceDir: "/tmp",
      model: { input: ["text", "image"] },
      existingImages: [{ type: "image", data: "%%%", mimeType: "image/png" }],
    });

    expect(result.failedMediaCount).toBe(1);
    expect(result.images).toEqual([]);
  });

  it("reports a missing unsuppressed inline layout slot", async () => {
    const result = await detectAndLoadPromptImages({
      prompt: "inspect",
      media: [{ kind: "image" }],
      mediaImageLayout: {
        slots: [{ kind: "inline", factIndex: 0 }],
        suppressedFactIndexes: [],
      },
      workspaceDir: "/tmp",
      model: { input: ["text", "image"] },
    });

    expect(result.failedMediaCount).toBe(1);
    expect(result.images).toEqual([]);
  });

  it("pairs an identity-less legacy fact with its existing inline block", async () => {
    const inlineImage = { type: "image" as const, data: TINY_PNG_BASE64, mimeType: "image/png" };
    const message = {
      role: "user" as const,
      content: [{ type: "text" as const, text: "legacy identity-less" }, inlineImage],
      media: [{ kind: "image" }],
    } as unknown as AgentMessage;

    const result = await hydratePromptMediaMessages([message], {
      workspaceDir: "/tmp",
      model: { input: ["text", "image"] },
    });

    expect((result[0] as unknown as { content?: unknown[] }).content).toEqual([
      { type: "text", text: "legacy identity-less" },
      inlineImage,
    ]);
  });

  it("does not pair an unresolved remote legacy fact with an existing inline block", async () => {
    const inlineImage = { type: "image" as const, data: TINY_PNG_BASE64, mimeType: "image/png" };
    const message = {
      role: "user" as const,
      content: [{ type: "text" as const, text: "remote identity" }, inlineImage],
      media: [{ kind: "image", url: "https://example.test/remote.png" }],
    } as unknown as AgentMessage;

    const result = await hydratePromptMediaMessages([message], {
      workspaceDir: "/tmp",
      model: { input: ["text", "image"] },
    });
    const meta = (result[0] as unknown as Record<string, unknown>)["__openclaw"] as
      | Record<string, unknown>
      | undefined;

    expect(meta?.mediaImageBlockFactIndexes).toEqual([null]);
    expect((result[0] as unknown as { content?: unknown[] }).content).toEqual([
      { type: "text", text: "remote identity" },
      inlineImage,
    ]);
  });

  it("hydrates an identity-bearing legacy fact beside an unowned inline block", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-legacy-inline-"));
    const imagePath = path.join(workspaceDir, "inline.png");
    await fs.writeFile(imagePath, Buffer.from(TINY_PNG_BASE64, "base64"));
    const inlineImage = { type: "image" as const, data: TINY_PNG_BASE64, mimeType: "image/png" };
    const message = {
      role: "user" as const,
      content: [{ type: "text" as const, text: "legacy" }, inlineImage],
      MediaPath: imagePath,
      MediaPaths: [imagePath],
      MediaType: "image/png",
      MediaTypes: ["image/png"],
    } as unknown as AgentMessage;

    try {
      const result = await hydratePromptMediaMessages([message], {
        workspaceDir,
        model: { input: ["text", "image"] },
        workspaceOnly: true,
      });
      expect((result[0] as unknown as { content?: unknown }).content).toEqual([
        { type: "text", text: "legacy" },
        { type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" },
        inlineImage,
      ]);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("keeps identity-bearing legacy facts ahead of an unowned inline block", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-legacy-order-"));
    const existingPath = path.join(workspaceDir, "existing.png");
    const hydratedPath = path.join(workspaceDir, "hydrated.png");
    const hydratedBuffer = createSolidPngBuffer(1, 1, { r: 0, g: 255, b: 0 });
    await fs.writeFile(existingPath, Buffer.from(TINY_PNG_BASE64, "base64"));
    await fs.writeFile(hydratedPath, hydratedBuffer);
    const existingImage = {
      type: "image" as const,
      data: TINY_PNG_BASE64,
      mimeType: "image/png",
    };
    const message = {
      role: "user" as const,
      content: [{ type: "text" as const, text: "legacy order" }, existingImage],
      MediaPath: existingPath,
      MediaPaths: [existingPath, hydratedPath],
      MediaType: "image/png",
      MediaTypes: ["image/png", "image/png"],
    } as unknown as AgentMessage;

    try {
      const result = await hydratePromptMediaMessages([message], {
        workspaceDir,
        model: { input: ["text", "image"] },
        workspaceOnly: true,
      });
      expect((result[0] as unknown as { content?: unknown[] }).content).toEqual([
        { type: "text", text: "legacy order" },
        { type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" },
        { type: "image", data: hydratedBuffer.toString("base64"), mimeType: "image/png" },
        existingImage,
      ]);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("dedupes the local path alias of a claim-check fact", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-image-alias-"));
    const workspaceDir = path.join(stateDir, "workspace");
    const inboundDir = path.join(stateDir, "media", "inbound");
    const mediaId = "aliased.png";
    const imagePath = path.join(inboundDir, mediaId);
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(inboundDir, { recursive: true });
    await fs.writeFile(imagePath, Buffer.from(TINY_PNG_BASE64, "base64"));
    const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);

    try {
      const result = await detectAndLoadPromptImages({
        prompt: `[media attached: ${imagePath} (image/png)]`,
        media: [{ path: imagePath, url: `media://inbound/${mediaId}`, contentType: "image/png" }],
        workspaceDir,
        model: { input: ["text", "image"] },
      });

      expect(result.loadedCount).toBe(1);
      expect(result.images).toHaveLength(1);
      expect(result.detectedRefs).toEqual([
        {
          raw: `media://inbound/${mediaId}`,
          resolved: `media://inbound/${mediaId}`,
          type: "media-uri",
        },
      ]);
    } finally {
      envSnapshot.restore();
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("keeps described image facts suppressed across serialize and restore", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-replay-suppressed-"));
    const imagePath = path.join(workspaceDir, "described.png");
    await fs.writeFile(imagePath, Buffer.from(TINY_PNG_BASE64, "base64"));
    const serialized = JSON.stringify(
      buildPersistedUserTurnMessage({
        text: "description already present",
        media: [
          { path: imagePath, contentType: "image/png", hydrationSuppressed: true },
          { kind: "sticker", hydrationSuppressed: true },
        ],
      }),
    );
    const restored = JSON.parse(serialized) as AgentMessage;
    const meta = (restored as unknown as Record<string, unknown>)["__openclaw"] as
      | Record<string, unknown>
      | undefined;
    const persistedMedia = meta?.media as
      | Array<{ path?: string; contentType?: string; hydrationSuppressed?: boolean }>
      | undefined;

    try {
      expect(persistedMedia).toEqual([
        expect.objectContaining({
          path: imagePath,
          contentType: "image/png",
          hydrationSuppressed: true,
        }),
        expect.objectContaining({ kind: "sticker", hydrationSuppressed: true }),
      ]);
      const replayHydration = await detectAndLoadPromptImages({
        prompt: "description already present",
        media: persistedMedia,
        workspaceDir,
        model: { input: ["text", "image"] },
        workspaceOnly: true,
      });
      expect(replayHydration.failedMediaCount).toBe(0);
      expect(replayHydration.images).toEqual([]);

      const result = await hydratePromptMediaMessages([restored], {
        workspaceDir,
        model: { input: ["text", "image"] },
        workspaceOnly: true,
      });
      expect((result[0] as unknown as { content?: unknown }).content).toEqual([
        { type: "text", text: "description already present" },
      ]);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });
});
