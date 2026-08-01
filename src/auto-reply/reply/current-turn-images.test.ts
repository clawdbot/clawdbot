// Tests current-turn native image hydration from inbound media paths.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveProjectedImageSourceIndexes } from "../../media/image-source-indexes.js";
import { withTempDir } from "../../test-helpers/temp-dir.js";
import { deleteTestEnvValue, setTestEnvValue } from "../../test-utils/env.js";
import { buildInboundMediaNoteProjection } from "../media-note.js";
import type { MsgContext } from "../templating.js";
import { resolveCurrentTurnImages } from "./current-turn-images.js";

const originalStateDirEnv = process.env.OPENCLAW_STATE_DIR;

function restoreProcessState() {
  if (originalStateDirEnv === undefined) {
    deleteTestEnvValue("OPENCLAW_STATE_DIR");
  } else {
    setTestEnvValue("OPENCLAW_STATE_DIR", originalStateDirEnv);
  }
}

describe("resolveCurrentTurnImages", () => {
  afterEach(() => {
    restoreProcessState();
    vi.restoreAllMocks();
  });

  it("hydrates Telegram-style state-relative media into native prompt images", async () => {
    await withTempDir({ prefix: "openclaw-current-turn-images-" }, async (base) => {
      const stateDir = path.join(base, "state");
      const cwd = path.join(base, "cwd");
      const relativePath = "media/inbound/telegram.jpg";
      const attachmentPath = path.join(stateDir, relativePath);
      const imageBytes = Buffer.from("telegram-image");
      await fs.mkdir(path.dirname(attachmentPath), { recursive: true });
      await fs.mkdir(cwd, { recursive: true });
      await fs.writeFile(attachmentPath, imageBytes);
      setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
      vi.spyOn(process, "cwd").mockReturnValue(cwd);

      const result = await resolveCurrentTurnImages({
        ctx: {
          Body: "caption",
          media: [{ path: relativePath, contentType: "image/jpeg" }],
        } satisfies MsgContext,
        cfg: {} as OpenClawConfig,
      });

      expect(result).toStrictEqual({
        images: [
          {
            type: "image",
            data: imageBytes.toString("base64"),
            mimeType: "image/jpeg",
          },
        ],
        imageOrder: ["inline"],
        imageSourceIndexes: [0],
      });
    });
  });

  it("hydrates AVIF attachments when transport metadata only declares generic bytes", async () => {
    await withTempDir({ prefix: "openclaw-current-turn-avif-" }, async (base) => {
      const imagePath = path.join(base, "photo.avif");
      const imageBytes = Buffer.from("avif-image");
      await fs.writeFile(imagePath, imageBytes);

      const result = await resolveCurrentTurnImages({
        ctx: {
          Body: "caption",
          media: [{ path: imagePath, contentType: "application/octet-stream", workspaceDir: base }],
        } satisfies MsgContext,
        cfg: {} as OpenClawConfig,
      });

      expect(result.images).toEqual([
        {
          type: "image",
          data: imageBytes.toString("base64"),
          mimeType: "image/avif",
        },
      ]);
      expect(result.imageOrder).toEqual(["inline"]);
    });
  });

  it("does not duplicate a prepared host-staged image during runner hydration", async () => {
    await withTempDir({ prefix: "openclaw-current-turn-staged-image-" }, async (base) => {
      const stagingRoot = path.join(base, "media", "inbound", "staged");
      const imagePath = path.join(stagingRoot, "photo.png");
      const imageBytes = Buffer.from("host-staged-image");
      await fs.mkdir(path.dirname(imagePath), { recursive: true });
      await fs.writeFile(imagePath, imageBytes);
      const sharedContext = {
        Body: "caption",
        media: [{ path: imagePath, contentType: "image/png", workspaceDir: stagingRoot }],
      } satisfies MsgContext;

      const prepared = await resolveCurrentTurnImages({
        ctx: sharedContext,
        cfg: {} as OpenClawConfig,
      });
      const runner = await resolveCurrentTurnImages({
        ctx: sharedContext,
        cfg: {} as OpenClawConfig,
        images: prepared.images,
        imageOrder: prepared.imageOrder,
        imageSourceIndexes: prepared.imageSourceIndexes,
      });

      expect(prepared.images).toHaveLength(1);
      expect(Buffer.from(prepared.images?.[0]?.data ?? "", "base64")).toEqual(imageBytes);
      expect(runner.images).toEqual(prepared.images);
      expect(runner.imageOrder).toEqual(["inline"]);
      expect(runner.imageSourceIndexes).toEqual([0]);
    });
  });

  it("keeps direct-run image indexes in the original ctx media space", async () => {
    await withTempDir({ prefix: "openclaw-current-turn-projected-media-" }, async (base) => {
      const imagePath = path.join(base, "photo.png");
      const imageBytes = Buffer.from("projected-image");
      await fs.writeFile(imagePath, imageBytes);
      const ctx = {
        Body: "caption",
        media: [
          {
            path: path.join(base, "voice.ogg"),
            contentType: "audio/ogg",
            kind: "audio" as const,
            transcribed: true,
            workspaceDir: base,
          },
          { path: imagePath, contentType: "image/png", workspaceDir: base },
        ],
      } satisfies MsgContext;

      const prepared = await resolveCurrentTurnImages({
        ctx,
        cfg: {} as OpenClawConfig,
      });
      const projection = buildInboundMediaNoteProjection(ctx);
      const runner = await resolveCurrentTurnImages({
        ctx,
        cfg: {} as OpenClawConfig,
        images: prepared.images,
        imageOrder: prepared.imageOrder,
        imageSourceIndexes: prepared.imageSourceIndexes,
      });

      expect(prepared.imageSourceIndexes).toEqual([1]);
      expect(projection.mediaSourceIndexes).toEqual([1]);
      expect(runner.images).toEqual(prepared.images);
      expect(runner.imageOrder).toEqual(["inline"]);
      expect(runner.imageSourceIndexes).toEqual([1]);
    });
  });

  it("dedupes a second hydration in projected run-media space", async () => {
    await withTempDir({ prefix: "openclaw-current-turn-run-media-" }, async (base) => {
      const imagePath = path.join(base, "photo.png");
      await fs.writeFile(imagePath, "run-media-image");
      const inboundCtx = {
        Body: "caption",
        media: [
          {
            path: path.join(base, "voice.ogg"),
            contentType: "audio/ogg",
            kind: "audio" as const,
            transcribed: true,
            workspaceDir: base,
          },
          { path: imagePath, contentType: "image/png", workspaceDir: base },
        ],
      } satisfies MsgContext;

      const prepared = await resolveCurrentTurnImages({
        ctx: inboundCtx,
        cfg: {} as OpenClawConfig,
      });
      const projection = buildInboundMediaNoteProjection(inboundCtx);
      const projectedResult = resolveProjectedImageSourceIndexes({
        imageSourceMapping: prepared.imageSourceIndexes
          ? { indexes: prepared.imageSourceIndexes, space: "inbound-media" }
          : undefined,
        imageOrderLength: prepared.imageOrder?.length ?? 0,
        projectedMediaSourceIndexes: projection.mediaSourceIndexes,
        projectedMediaLength: projection.media.length,
      });
      expect(projectedResult.kind).toBe("mapped");
      const projectedIndexes =
        projectedResult.kind === "mapped" ? projectedResult.indexes : undefined;
      const runner = await resolveCurrentTurnImages({
        ctx: { ...inboundCtx, media: projection.media },
        cfg: {} as OpenClawConfig,
        images: prepared.images,
        imageOrder: prepared.imageOrder,
        imageSourceIndexes: projectedIndexes,
      });

      expect(projectedIndexes).toEqual([0]);
      expect(runner.images).toEqual(prepared.images);
      expect(runner.images).toHaveLength(1);
      expect(runner.imageOrder).toEqual(["inline"]);
      expect(runner.imageSourceIndexes).toEqual([0]);
    });
  });

  it("dedupes all images after collect merges them into run-media space", async () => {
    await withTempDir({ prefix: "openclaw-current-turn-collect-media-" }, async (base) => {
      const firstPath = path.join(base, "first.png");
      const secondPath = path.join(base, "second.png");
      await fs.writeFile(firstPath, "first-image");
      await fs.writeFile(secondPath, "second-image");
      const collectCtx = {
        Body: "compare",
        media: [
          { path: firstPath, contentType: "image/png", workspaceDir: base },
          { path: secondPath, contentType: "image/png", workspaceDir: base },
        ],
      } satisfies MsgContext;

      const prepared = await resolveCurrentTurnImages({
        ctx: collectCtx,
        cfg: {} as OpenClawConfig,
      });
      const runner = await resolveCurrentTurnImages({
        ctx: collectCtx,
        cfg: {} as OpenClawConfig,
        images: prepared.images,
        imageOrder: prepared.imageOrder,
        imageSourceIndexes: [0, 1],
      });

      expect(runner.images).toEqual(prepared.images);
      expect(runner.images).toHaveLength(2);
      expect(runner.imageOrder).toEqual(["inline", "inline"]);
      expect(runner.imageSourceIndexes).toEqual([0, 1]);
    });
  });

  it("does not hydrate image facts explicitly suppressed by media understanding", async () => {
    await withTempDir({ prefix: "openclaw-current-turn-suppressed-image-" }, async (base) => {
      const imagePath = path.join(base, "described.png");
      await fs.writeFile(imagePath, "already-described-image");

      const result = await resolveCurrentTurnImages({
        ctx: {
          Body: "caption",
          media: [
            {
              path: imagePath,
              contentType: "image/png",
              workspaceDir: base,
              hydrationSuppressed: true,
            },
          ],
        } satisfies MsgContext,
        cfg: {} as OpenClawConfig,
      });

      expect(result).toEqual({});
    });
  });

  it("does not let a staging root expose sibling workspace images", async () => {
    await withTempDir({ prefix: "openclaw-current-turn-staged-image-" }, async (base) => {
      const stagingRoot = path.join(base, "media", "inbound", "staged");
      const rejectedPath = path.join(base, "private.png");
      await fs.mkdir(stagingRoot, { recursive: true });
      await fs.writeFile(rejectedPath, "private-workspace-image");

      const result = await resolveCurrentTurnImages({
        ctx: {
          Body: "caption",
          media: [{ path: rejectedPath, contentType: "image/png", workspaceDir: stagingRoot }],
        } satisfies MsgContext,
        cfg: {} as OpenClawConfig,
      });

      expect(result.images).toBeUndefined();
    });
  });

  it("preserves the full order when only inline image payloads are present", async () => {
    const inlineImage = {
      type: "image" as const,
      data: Buffer.from("inline").toString("base64"),
      mimeType: "image/png",
    };

    const result = await resolveCurrentTurnImages({
      ctx: { Body: "compare these" } satisfies MsgContext,
      cfg: {} as OpenClawConfig,
      images: [inlineImage],
      imageOrder: ["offloaded", "inline", "offloaded"],
    });

    expect(result).toEqual({
      images: [inlineImage],
      imageOrder: ["offloaded", "inline", "offloaded"],
    });
  });

  it("preserves all-offloaded image order without inline payloads", async () => {
    const result = await resolveCurrentTurnImages({
      ctx: { Body: "compare these" } satisfies MsgContext,
      cfg: {} as OpenClawConfig,
      images: [],
      imageOrder: ["offloaded", "offloaded"],
    });

    expect(result).toEqual({
      imageOrder: ["offloaded", "offloaded"],
    });
  });

  it("preserves interleaved offloaded slots around inline image payloads", async () => {
    const inlineImages = ["first", "second"].map((data) => ({
      type: "image" as const,
      data: Buffer.from(data).toString("base64"),
      mimeType: "image/png",
    }));

    const result = await resolveCurrentTurnImages({
      ctx: { Body: "compare these" } satisfies MsgContext,
      cfg: {} as OpenClawConfig,
      images: inlineImages,
      imageOrder: ["inline", "offloaded", "inline"],
    });

    expect(result).toEqual({
      images: inlineImages,
      imageOrder: ["inline", "offloaded", "inline"],
    });
  });

  it("normalizes inconsistent image slot layouts without retry loops", async () => {
    const image = {
      type: "image" as const,
      data: Buffer.from("inline").toString("base64"),
      mimeType: "image/png",
    };

    await expect(
      resolveCurrentTurnImages({
        ctx: { Body: "compare" } satisfies MsgContext,
        cfg: {} as OpenClawConfig,
        images: [image],
        imageOrder: ["inline"],
        imageSourceIndexes: [0, 1],
      }),
    ).resolves.toEqual({
      images: [image],
      imageOrder: ["inline"],
      imageSourceMappingInvalid: true,
    });
    await expect(
      resolveCurrentTurnImages({
        ctx: { Body: "compare" } satisfies MsgContext,
        cfg: {} as OpenClawConfig,
        images: [image],
        imageOrder: ["offloaded"],
      }),
    ).resolves.toEqual({ images: [image], imageOrder: ["offloaded", "inline"] });
  });

  it("can assume invalid image sources were represented during second hydration", async () => {
    await withTempDir({ prefix: "openclaw-current-turn-invalid-source-" }, async (base) => {
      const imagePath = path.join(base, "photo.png");
      await fs.writeFile(imagePath, "source-image");

      const prepared = {
        type: "image" as const,
        data: Buffer.from("prepared").toString("base64"),
        mimeType: "image/png",
      };
      await expect(
        resolveCurrentTurnImages({
          ctx: {
            Body: "caption",
            media: [{ path: imagePath, contentType: "image/png", workspaceDir: base }],
          } satisfies MsgContext,
          cfg: {} as OpenClawConfig,
          images: [prepared],
          imageOrder: ["inline"],
          imageSourceIndexes: [1],
          invalidSourceMappingPolicy: "infer-inline",
        }),
      ).resolves.toEqual({
        images: [prepared],
        imageOrder: ["inline"],
        imageSourceIndexes: [0],
        imageSourceMappingInvalid: true,
      });
    });
  });

  it("hydrates available media during first hydration when source mapping is invalid", async () => {
    await withTempDir({ prefix: "openclaw-current-turn-invalid-source-hydrate-" }, async (base) => {
      const imagePath = path.join(base, "photo.png");
      await fs.writeFile(imagePath, "source-image");
      const prepared = {
        type: "image" as const,
        data: Buffer.from("prepared").toString("base64"),
        mimeType: "image/png",
      };

      const result = await resolveCurrentTurnImages({
        ctx: {
          Body: "caption",
          media: [{ path: imagePath, contentType: "image/png", workspaceDir: base }],
        } satisfies MsgContext,
        cfg: {} as OpenClawConfig,
        images: [prepared],
        imageOrder: ["inline"],
        imageSourceIndexes: [1],
        invalidSourceMappingPolicy: "hydrate",
      });

      expect(result.images).toHaveLength(2);
      expect(result.imageOrder).toEqual(["inline", "inline"]);
      expect(result.imageSourceIndexes).toEqual([undefined, 0]);
      expect(result.imageSourceMappingInvalid).toBe(true);
    });
  });

  it("does not infer invalid inline ownership from an already described attachment", async () => {
    await withTempDir({ prefix: "openclaw-current-turn-invalid-described-" }, async (base) => {
      const describedPath = path.join(base, "described.png");
      const undescribedPath = path.join(base, "undescribed.png");
      await fs.writeFile(describedPath, "described-image");
      await fs.writeFile(undescribedPath, "undescribed-image");
      const prepared = {
        type: "image" as const,
        data: Buffer.from("prepared").toString("base64"),
        mimeType: "image/png",
      };

      await expect(
        resolveCurrentTurnImages({
          ctx: {
            Body: "caption",
            media: [
              { path: describedPath, contentType: "image/png", workspaceDir: base },
              { path: undescribedPath, contentType: "image/png", workspaceDir: base },
            ],
            MediaUnderstanding: [
              {
                kind: "image.description",
                attachmentIndex: 0,
                provider: "openai",
                model: "test-vision",
                text: "already described",
              },
            ],
          } satisfies MsgContext,
          cfg: {} as OpenClawConfig,
          images: [prepared],
          imageOrder: ["inline"],
          sourceMappingInvalid: true,
          invalidSourceMappingPolicy: "infer-inline",
        }),
      ).resolves.toEqual({
        images: [prepared],
        imageOrder: ["inline"],
        imageSourceIndexes: [1],
        imageSourceMappingInvalid: true,
      });
    });
  });

  it("accepts a valid high source index after an empty media slot", async () => {
    await withTempDir({ prefix: "openclaw-current-turn-empty-slot-" }, async (base) => {
      const imagePath = path.join(base, "photo.png");
      await fs.writeFile(imagePath, "source-image");
      const prepared = {
        type: "image" as const,
        data: Buffer.from("prepared").toString("base64"),
        mimeType: "image/png",
      };

      await expect(
        resolveCurrentTurnImages({
          ctx: {
            Body: "caption",
            media: [{}, { path: imagePath, contentType: "image/png", workspaceDir: base }],
          } satisfies MsgContext,
          cfg: {} as OpenClawConfig,
          images: [prepared],
          imageOrder: ["inline"],
          imageSourceIndexes: [1],
        }),
      ).resolves.toEqual({
        images: [prepared],
        imageOrder: ["inline"],
        imageSourceIndexes: [1],
      });
    });
  });

  it("keeps unsourced slots stable while ordering source-backed images", async () => {
    await withTempDir({ prefix: "openclaw-current-turn-mixed-sources-" }, async (base) => {
      const imagePath = path.join(base, "photo.png");
      await fs.writeFile(imagePath, "current-image");
      const supplied = {
        type: "image" as const,
        data: Buffer.from("supplied-image").toString("base64"),
        mimeType: "image/png",
      };
      const extracted = {
        type: "image" as const,
        data: Buffer.from("extracted-image").toString("base64"),
        mimeType: "image/png",
        attachmentIndex: 1,
      };

      const result = await resolveCurrentTurnImages({
        ctx: {
          Body: "compare",
          media: [
            { path: imagePath, contentType: "image/png", workspaceDir: base },
            {
              path: path.join(base, "scan.pdf"),
              contentType: "application/pdf",
              workspaceDir: base,
            },
          ],
        } satisfies MsgContext,
        cfg: {} as OpenClawConfig,
        images: [supplied],
        extractedFileImages: [extracted],
      });

      expect(result.images?.map((image) => Buffer.from(image.data, "base64").toString())).toEqual([
        "supplied-image",
        "current-image",
        "extracted-image",
      ]);
      expect(result.imageSourceIndexes).toEqual([undefined, 0, 1]);
    });
  });

  it("appends extracted PDF page images without dropping current image attachments", async () => {
    await withTempDir({ prefix: "openclaw-current-turn-pdf-images-" }, async (base) => {
      const imagePath = path.join(base, "photo.png");
      const imageBytes = Buffer.from("current-photo");
      await fs.writeFile(imagePath, imageBytes);

      const pdfPage = {
        type: "image" as const,
        data: Buffer.from("pdf-page").toString("base64"),
        mimeType: "image/png",
        attachmentIndex: 1,
      };

      const result = await resolveCurrentTurnImages({
        ctx: {
          Body: "caption",
          media: [
            { path: imagePath, contentType: "image/png", workspaceDir: base },
            {
              path: path.join(base, "scan.pdf"),
              contentType: "application/pdf",
              workspaceDir: base,
            },
          ],
        } satisfies MsgContext,
        cfg: {} as OpenClawConfig,
        extractedFileImages: [pdfPage],
      });

      expect(result.images).toEqual([
        {
          type: "image",
          data: imageBytes.toString("base64"),
          mimeType: "image/png",
        },
        {
          type: "image",
          data: pdfPage.data,
          mimeType: "image/png",
        },
      ]);
      expect(result.imageOrder).toEqual(["inline", "inline"]);
    });
  });

  it("orders extracted PDF page images before later current image attachments", async () => {
    await withTempDir({ prefix: "openclaw-current-turn-pdf-order-" }, async (base) => {
      const imagePath = path.join(base, "photo.png");
      await fs.writeFile(imagePath, "current-photo");
      const pdfPage = {
        type: "image" as const,
        data: Buffer.from("pdf-page").toString("base64"),
        mimeType: "image/png",
        attachmentIndex: 0,
      };

      const result = await resolveCurrentTurnImages({
        ctx: {
          Body: "caption",
          media: [
            {
              path: path.join(base, "scan.pdf"),
              contentType: "application/pdf",
              workspaceDir: base,
            },
            { path: imagePath, contentType: "image/png", workspaceDir: base },
          ],
        } satisfies MsgContext,
        cfg: {} as OpenClawConfig,
        extractedFileImages: [pdfPage],
      });

      expect(result.images?.map((image) => Buffer.from(image.data, "base64").toString())).toEqual([
        "pdf-page",
        "current-photo",
      ]);
      expect(result.imageOrder).toEqual(["inline", "inline"]);
    });
  });
});
