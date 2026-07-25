import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildInboundMediaNoteProjection } from "../../../auto-reply/media-note.js";
import { readRuntimePromptImageFactIndexes } from "../../../media/runtime-prompt-image-provenance.js";
import { captureEnv, setTestEnvValue } from "../../../test-utils/env.js";
import { detectAndLoadPromptImages } from "./images.js";
import { preparePluginHarnessPromptImages } from "./plugin-harness-prompt-images.js";

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAsTAAALEwEAmpwYAAAADUlEQVR4nGP4////KwAJ5gPoxLp9owAAAABJRU5ErkJggg==";

describe("plugin harness prompt media", () => {
  it("does not hydrate marker or bare paths from recalled memory context", async () => {
    const recalledMemory = [
      "<relevant-memories>",
      "1. [fact] stale [media attached: /tmp/some.png] and /tmp/other.png",
      "</relevant-memories>",
    ].join("\n");

    await expect(
      preparePluginHarnessPromptImages({
        runParams: {
          agentId: "main",
          config: { agents: { defaults: { sandbox: { mode: "off" } } } },
          prompt: `${recalledMemory}\n\ncurrent question`,
          sessionId: "session-recalled-memory",
        },
        runtime: {
          model: { input: ["text", "image"] },
          sessionId: "session-recalled-memory",
          workspaceDir: "/tmp",
        },
        pluginHarnessOwnsTransport: true,
      } as unknown as Parameters<typeof preparePluginHarnessPromptImages>[0]),
    ).resolves.toEqual({ images: undefined, imageOrder: undefined, media: undefined });
  });

  it("hydrates plugin images and preserves serialized replay order with non-image facts", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-harness-media-"));
    const workspaceDir = path.join(stateDir, "workspace");
    const inboundDir = path.join(stateDir, "media", "inbound");
    const mediaId = "photo.png";
    const imagePath = path.join(inboundDir, mediaId);
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(inboundDir, { recursive: true });
    await fs.writeFile(imagePath, Buffer.from(TINY_PNG_BASE64, "base64"));
    const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    const documentFact = {
      path: path.join(workspaceDir, "misleading.png"),
      contentType: "application/pdf",
      kind: "document" as const,
    };
    const input = {
      runParams: {
        agentId: "main",
        config: { agents: { defaults: { sandbox: { mode: "off" } } } },
        imageOrder: ["offloaded"],
        media: [documentFact, { url: `media://inbound/${mediaId}`, contentType: "image/png" }],
        sessionId: "session-1",
        userTurnTranscriptRecorder: {
          message: {
            role: "user",
            content: "inspect",
            MediaPaths: [imagePath, documentFact.path],
            MediaTypes: ["image/png", "application/pdf"],
            __openclaw: {
              mediaImageLayout: { slots: [{ kind: "offloaded", factIndex: 0 }] },
            },
          },
        },
      },
      runtime: {
        model: { input: ["text", "image"] },
        sessionId: "session-1",
        workspaceDir,
      },
      pluginHarnessOwnsTransport: true,
    } as unknown as Parameters<typeof preparePluginHarnessPromptImages>[0];

    try {
      const result = await preparePluginHarnessPromptImages(input);

      expect(result.images).toEqual([
        { type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" },
      ]);
      expect(readRuntimePromptImageFactIndexes(result.images ?? [])).toEqual([0]);
      expect(result.imageOrder).toEqual(["inline"]);
      expect(result.media?.[0]).toMatchObject({ contentType: "image/png", kind: "image" });
      expect(result.media?.[0]).not.toHaveProperty("path");
      expect(result.media?.[0]).not.toHaveProperty("url");
      expect(result.media?.[1]).toMatchObject(documentFact);

      const serialized = JSON.stringify(result);
      const restored = JSON.parse(serialized) as typeof result;
      const replay = await detectAndLoadPromptImages({
        prompt: "",
        media: restored.media,
        workspaceDir,
        model: { input: ["text", "image"] },
        existingImages: restored.images,
        imageOrder: restored.imageOrder,
      });
      expect(replay.failedMediaCount).toBe(0);
      expect(replay.images).toEqual(result.images);
      expect(replay.imageFactIndexes).toEqual([0]);
    } finally {
      envSnapshot.restore();
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("surfaces a failed image hydration before plugin dispatch", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-harness-failed-media-"));
    try {
      await expect(
        preparePluginHarnessPromptImages({
          runParams: {
            agentId: "main",
            config: { agents: { defaults: { sandbox: { mode: "off" } } } },
            imageOrder: ["offloaded"],
            media: [{ path: path.join(workspaceDir, "missing.png"), contentType: "image/png" }],
            sessionId: "session-failed",
          },
          runtime: {
            model: { input: ["text", "image"] },
            sessionId: "session-failed",
            workspaceDir,
          },
          pluginHarnessOwnsTransport: true,
        } as unknown as Parameters<typeof preparePluginHarnessPromptImages>[0]),
      ).rejects.toThrow("failed to hydrate 1 structured image attachment");
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("surfaces an unsuppressed identity-less inline fact with no image block", async () => {
    await expect(
      preparePluginHarnessPromptImages({
        runParams: {
          agentId: "main",
          config: { agents: { defaults: { sandbox: { mode: "off" } } } },
          imageOrder: ["inline"],
          media: [{ kind: "image" }],
          sessionId: "session-missing-inline",
        },
        runtime: {
          model: { input: ["text", "image"] },
          sessionId: "session-missing-inline",
          workspaceDir: "/tmp",
        },
        pluginHarnessOwnsTransport: true,
      } as unknown as Parameters<typeof preparePluginHarnessPromptImages>[0]),
    ).rejects.toThrow("failed to hydrate 1 structured image attachment");
  });

  it("surfaces a fact-owned image dropped during host sanitization", async () => {
    await expect(
      preparePluginHarnessPromptImages({
        runParams: {
          agentId: "main",
          config: { agents: { defaults: { sandbox: { mode: "off" } } } },
          images: [{ type: "image", data: "%%%", mimeType: "image/png" }],
          imageOrder: ["inline"],
          media: [{ kind: "image" }],
          sessionId: "session-sanitize-failed",
        },
        runtime: {
          model: { input: ["text", "image"] },
          sessionId: "session-sanitize-failed",
          workspaceDir: "/tmp",
        },
        pluginHarnessOwnsTransport: true,
      } as unknown as Parameters<typeof preparePluginHarnessPromptImages>[0]),
    ).rejects.toThrow("failed to hydrate 1 structured image attachment");
  });

  it("surfaces inline sanitization failure when a preceding plugin image fact is suppressed", async () => {
    await expect(
      preparePluginHarnessPromptImages({
        runParams: {
          agentId: "main",
          config: { agents: { defaults: { sandbox: { mode: "off" } } } },
          images: [{ type: "image", data: "%%%", mimeType: "image/png" }],
          imageOrder: ["inline"],
          media: [
            {
              path: "/tmp/described-missing.png",
              contentType: "image/png",
              hydrationSuppressed: true,
            },
            { path: "/tmp/inline.png", contentType: "image/png" },
          ],
          sessionId: "session-suppressed-before-inline",
        },
        runtime: {
          model: { input: ["text", "image"] },
          sessionId: "session-suppressed-before-inline",
          workspaceDir: "/tmp",
        },
        pluginHarnessOwnsTransport: true,
      } as unknown as Parameters<typeof preparePluginHarnessPromptImages>[0]),
    ).rejects.toThrow("failed to hydrate 1 structured image attachment");
  });

  it("retains an intentionally non-hydrating remote-only image as a type-only fact", async () => {
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
    const result = await preparePluginHarnessPromptImages({
      runParams: {
        agentId: "main",
        config: { agents: { defaults: { sandbox: { mode: "off" } } } },
        media,
        sessionId: "session-described",
      },
      runtime: {
        model: { input: ["text", "image"] },
        sessionId: "session-described",
        workspaceDir: "/tmp",
      },
      pluginHarnessOwnsTransport: true,
    } as unknown as Parameters<typeof preparePluginHarnessPromptImages>[0]);

    expect(result.images).toEqual([]);
    expect(result.media?.[0]).toMatchObject({
      contentType: "image/png",
      kind: "image",
      hydrationSuppressed: true,
    });
    expect(result.media?.[0]).not.toHaveProperty("path");
    expect(result.media?.[0]).not.toHaveProperty("url");
  });

  it("retains layout-derived suppression after plugin host materialization", async () => {
    const inlineImage = { type: "image" as const, data: TINY_PNG_BASE64, mimeType: "image/png" };
    const result = await preparePluginHarnessPromptImages({
      runParams: {
        agentId: "main",
        config: { agents: { defaults: { sandbox: { mode: "off" } } } },
        images: [inlineImage],
        imageOrder: ["inline"],
        media: [
          { path: "/tmp/described.png", contentType: "image/png" },
          { path: "/tmp/inline.png", contentType: "image/png" },
        ],
        sessionId: "session-layout-suppressed",
        userTurnTranscriptRecorder: {
          message: {
            role: "user",
            content: "compare",
            MediaPaths: ["/tmp/described.png", "/tmp/inline.png"],
            MediaTypes: ["image/png", "image/png"],
            __openclaw: {
              mediaImageLayout: {
                slots: [{ kind: "inline", factIndex: 1 }],
                suppressedFactIndexes: [0],
              },
            },
          },
        },
      },
      runtime: {
        model: { input: ["text", "image"] },
        sessionId: "session-layout-suppressed",
        workspaceDir: "/tmp",
      },
      pluginHarnessOwnsTransport: true,
    } as unknown as Parameters<typeof preparePluginHarnessPromptImages>[0]);

    expect(result.images).toEqual([inlineImage]);
    expect(result.imageOrder).toEqual(["inline"]);
    expect(result.media?.[0]).toMatchObject({ kind: "image", hydrationSuppressed: true });
    expect(result.media?.[1]).toMatchObject({ kind: "image" });
    expect(result.media?.[1]).not.toHaveProperty("hydrationSuppressed");
  });

  it("keeps unsupported native images as aligned type-only facts", async () => {
    const media = [
      { path: "/tmp/photo.png", contentType: "image/png" },
      { path: "/tmp/inferred.png", kind: "unknown" as const },
    ];
    const result = await preparePluginHarnessPromptImages({
      runParams: {
        agentId: "main",
        config: { agents: { defaults: { sandbox: { mode: "off" } } } },
        media,
        sessionId: "session-text-only",
      },
      runtime: {
        model: { input: ["text"] },
        sessionId: "session-text-only",
        workspaceDir: "/tmp",
      },
      pluginHarnessOwnsTransport: true,
    } as unknown as Parameters<typeof preparePluginHarnessPromptImages>[0]);

    expect(result.images).toEqual([]);
    expect(result.media?.[0]).toMatchObject({ contentType: "image/png" });
    expect(result.media?.[0]).not.toHaveProperty("path");
    expect(result.media?.[1]).toMatchObject({ kind: "image" });
    expect(result.media?.[1]).not.toHaveProperty("path");
  });

  it("leaves facts untouched when the native harness owns transport", async () => {
    const media = [{ path: "/tmp/photo.png", contentType: "image/png" }];
    const result = await preparePluginHarnessPromptImages({
      runParams: { media },
      runtime: {},
      pluginHarnessOwnsTransport: false,
    } as unknown as Parameters<typeof preparePluginHarnessPromptImages>[0]);

    expect(result).toEqual({ images: undefined, imageOrder: undefined, media });
  });
});
