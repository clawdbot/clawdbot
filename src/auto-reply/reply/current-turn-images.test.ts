// Tests current-turn native image hydration from inbound media paths.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { deleteTestEnvValue, setTestEnvValue } from "../../test-utils/env.js";
import type { MsgContext } from "../templating.js";
import { resolveAgentTurnAttachments } from "./agent-turn-attachments.js";
import { resolveCurrentTurnImages } from "./current-turn-images.js";

vi.mock("./agent-turn-attachments.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./agent-turn-attachments.js")>();
  return {
    ...actual,
    resolveAgentTurnAttachments: vi.fn(actual.resolveAgentTurnAttachments),
  };
});

const originalStateDirEnv = process.env.OPENCLAW_STATE_DIR;
const PNG_IMAGE_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=",
  "base64",
);
const JPEG_IMAGE_BYTES = Buffer.from("ffd8ffe000104a46494600010100000100010000ffd9", "hex");
const PDF_BYTES = Buffer.from("%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n");
const ZIP_BYTES = Buffer.from("504b0506000000000000000000000000000000000000", "hex");

function createDescribedImageContext(describedIndexes: number[]): MsgContext {
  return {
    Body: "[Image]\nDescription:\na tiny dot image",
    media: ["first", "second"].map((name) => ({
      path: `/tmp/${name}.png`,
      contentType: "image/png",
    })),
    MediaUnderstanding: describedIndexes.map((attachmentIndex) => ({
      kind: "image.description" as const,
      attachmentIndex,
      provider: "openai",
      model: "gpt-4o",
      text: "a tiny dot image",
    })),
  };
}

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
    await withTestDir({ prefix: "openclaw-current-turn-images-" }, async (base) => {
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
      });
    });
  });

  it.each([
    {
      name: "generic Telegram image bytes under a .bin path",
      fileName: "upload.bin",
      contentType: "application/octet-stream",
      kind: "image" as const,
      imageBytes: PNG_IMAGE_BYTES,
      expectedMime: "image/png",
    },
    {
      name: "an extensionless image without transport MIME",
      fileName: "upload",
      contentType: undefined,
      kind: "image" as const,
      imageBytes: JPEG_IMAGE_BYTES,
      expectedMime: "image/jpeg",
    },
    {
      name: "a sticker with generic transport MIME",
      fileName: "sticker.bin",
      contentType: "application/octet-stream",
      kind: "sticker" as const,
      imageBytes: PNG_IMAGE_BYTES,
      expectedMime: "image/png",
    },
    {
      name: "an opaque image identified by separate filename metadata",
      fileName: "opaque",
      originalFileName: "photo.png",
      contentType: "application/octet-stream",
      kind: undefined,
      imageBytes: PNG_IMAGE_BYTES,
      expectedMime: "image/png",
    },
  ])("hydrates $name using the verified byte MIME", async (testCase) => {
    await withTestDir({ prefix: "openclaw-current-turn-canonical-kind-" }, async (base) => {
      const imagePath = path.join(base, testCase.fileName);
      await fs.writeFile(imagePath, testCase.imageBytes);

      const result = await resolveCurrentTurnImages({
        ctx: {
          Body: "describe this image",
          media: [
            {
              path: imagePath,
              ...("originalFileName" in testCase ? { fileName: testCase.originalFileName } : {}),
              contentType: testCase.contentType,
              kind: testCase.kind,
              workspaceDir: base,
            },
          ],
        } satisfies MsgContext,
        cfg: {} as OpenClawConfig,
      });

      expect(result).toEqual({
        images: [
          {
            type: "image",
            data: testCase.imageBytes.toString("base64"),
            mimeType: testCase.expectedMime,
          },
        ],
        imageOrder: ["inline"],
      });
    });
  });

  it.each([undefined, "application/pdf", "application/octet-stream", "image/png"] as const)(
    "never hydrates valid image bytes when the authoritative document MIME is %s",
    async (contentType) => {
      await withTestDir({ prefix: "openclaw-current-turn-document-image-" }, async (base) => {
        const documentPath = path.join(base, "report.png");
        await fs.writeFile(documentPath, PNG_IMAGE_BYTES);

        const result = await resolveCurrentTurnImages({
          ctx: {
            Body: "summarize this document",
            media: [{ path: documentPath, contentType, kind: "document", workspaceDir: base }],
          } satisfies MsgContext,
          cfg: {} as OpenClawConfig,
        });

        expect(result.images).toBeUndefined();
      });
    },
  );

  it.each([undefined, "application/octet-stream", "binary/octet-stream"] as const)(
    "hydrates unknown-kind filename images when MIME %s has no concrete category",
    async (contentType) => {
      await withTestDir({ prefix: "openclaw-current-turn-unknown-image-" }, async (base) => {
        const imagePath = path.join(base, "upload.png");
        await fs.writeFile(imagePath, PNG_IMAGE_BYTES);

        const result = await resolveCurrentTurnImages({
          ctx: {
            Body: "describe this upload",
            media: [{ path: imagePath, contentType, kind: "unknown", workspaceDir: base }],
          } satisfies MsgContext,
          cfg: {} as OpenClawConfig,
        });

        expect(result.images).toEqual([
          {
            type: "image",
            data: PNG_IMAGE_BYTES.toString("base64"),
            mimeType: "image/png",
          },
        ]);
      });
    },
  );

  it.each(["application/pdf", "application/zip", "text/plain"] as const)(
    "never hydrates valid PNG bytes when unknown-kind MIME %s declares a document",
    async (contentType) => {
      await withTestDir({ prefix: "openclaw-current-turn-unknown-document-" }, async (base) => {
        const documentPath = path.join(base, "report.png");
        await fs.writeFile(documentPath, PNG_IMAGE_BYTES);

        const result = await resolveCurrentTurnImages({
          ctx: {
            Body: "summarize this upload",
            media: [{ path: documentPath, contentType, kind: "unknown", workspaceDir: base }],
          } satisfies MsgContext,
          cfg: {} as OpenClawConfig,
        });

        expect(result.images).toBeUndefined();
      });
    },
  );

  it.each([
    { name: "PDF", bytes: PDF_BYTES },
    { name: "ZIP", bytes: ZIP_BYTES },
  ])("rejects $name bytes despite a spoofed image kind, MIME, and filename", async (testCase) => {
    await withTestDir({ prefix: "openclaw-current-turn-spoofed-image-" }, async (base) => {
      const imagePath = path.join(base, "spoofed.png");
      await fs.writeFile(imagePath, testCase.bytes);

      const result = await resolveCurrentTurnImages({
        ctx: {
          Body: "describe this image",
          media: [
            {
              path: imagePath,
              contentType: "image/png",
              kind: "image",
              workspaceDir: base,
            },
          ],
        } satisfies MsgContext,
        cfg: {} as OpenClawConfig,
      });

      expect(result.images).toBeUndefined();
    });
  });

  it("hydrates AVIF attachments when transport metadata only declares generic bytes", async () => {
    await withTestDir({ prefix: "openclaw-current-turn-avif-" }, async (base) => {
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
    await withTestDir({ prefix: "openclaw-current-turn-staged-image-" }, async (base) => {
      const stagingRoot = path.join(base, "media", "inbound", "staged");
      const imagePath = path.join(stagingRoot, "photo.png");
      const imageBytes = Buffer.from("host-staged-image");
      await fs.mkdir(path.dirname(imagePath), { recursive: true });
      await fs.writeFile(imagePath, imageBytes);
      const sharedContext = {
        Body: "caption",
        media: [{ path: imagePath, contentType: "image/png" }],
      } satisfies MsgContext;

      const prepared = await resolveCurrentTurnImages({
        ctx: {
          ...sharedContext,
          media: [{ path: imagePath, contentType: "image/png", workspaceDir: stagingRoot }],
        },
        cfg: {} as OpenClawConfig,
      });
      const runner = await resolveCurrentTurnImages({
        ctx: sharedContext,
        cfg: {} as OpenClawConfig,
        images: prepared.images,
        imageOrder: prepared.imageOrder,
      });

      expect(prepared.images).toHaveLength(1);
      expect(Buffer.from(prepared.images?.[0]?.data ?? "", "base64")).toEqual(imageBytes);
      expect(runner.images).toEqual(prepared.images);
    });
  });

  it("does not let a staging root expose sibling workspace images", async () => {
    await withTestDir({ prefix: "openclaw-current-turn-staged-image-" }, async (base) => {
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

  it("does not rehydrate current image facts already described in the prompt", async () => {
    vi.mocked(resolveAgentTurnAttachments).mockClear();

    const result = await resolveCurrentTurnImages({
      ctx: createDescribedImageContext([0, 1]),
      cfg: {} as OpenClawConfig,
    });

    expect(result).toEqual({});
    expect(resolveAgentTurnAttachments).not.toHaveBeenCalled();
  });

  it("hands a room's kept image to a text-only turn with its provenance", async () => {
    await withTestDir({ prefix: "openclaw-history-image-" }, async (base) => {
      const now = Date.now();
      const stateDir = path.join(base, "state");
      const relativePath = "media/inbound/kept.png";
      const imagePath = path.join(stateDir, relativePath);
      await fs.mkdir(path.dirname(imagePath), { recursive: true });
      await fs.writeFile(imagePath, PNG_IMAGE_BYTES);
      setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
      const ctx: MsgContext = {
        Body: "what was in that photo?",
        Timestamp: new Date(now).toISOString(),
        InboundHistory: [
          {
            sender: "Ada",
            body: "<image>",
            timestamp: now - 1000,
            messageId: "m-kept",
            media: [
              { path: imagePath, contentType: "image/png", kind: "image", messageId: "m-kept" },
            ],
          },
        ],
      } as unknown as MsgContext;

      const result = await resolveCurrentTurnImages({ ctx, cfg: {} as OpenClawConfig });

      expect(result.images).toEqual([
        expect.objectContaining({ type: "image", mimeType: "image/png" }),
      ]);
      expect(result.historyImageNotes).toContain("Recent image 1 from Ada");
      expect(result.historyImageNotes).toContain("attached as media");
    });
  });

  it("keeps a text-only turn off the media runtime when the room kept nothing", async () => {
    const ctx: MsgContext = { Body: "hello" } as unknown as MsgContext;
    vi.mocked(resolveAgentTurnAttachments).mockClear();

    const result = await resolveCurrentTurnImages({ ctx, cfg: {} as OpenClawConfig });

    expect(vi.mocked(resolveAgentTurnAttachments)).not.toHaveBeenCalled();
    expect(result.images).toBeUndefined();
    expect(result.historyImageNotes).toBeUndefined();
  });

  it("hydrates only current image facts missing prompt descriptions", async () => {
    const imageData = Buffer.from("second image").toString("base64");
    vi.mocked(resolveAgentTurnAttachments).mockResolvedValueOnce({
      attachments: [{ data: imageData, mediaType: "image/png" }],
      attachmentIndexes: [1],
      recentHistoryImages: [],
    });

    const result = await resolveCurrentTurnImages({
      ctx: createDescribedImageContext([0]),
      cfg: {} as OpenClawConfig,
    });

    expect(resolveAgentTurnAttachments).toHaveBeenCalledWith({
      ctx: createDescribedImageContext([0]),
      cfg: {},
      includeRecentHistoryImages: false,
      includeAttachmentIndexes: true,
    });
    expect(result.images).toEqual([{ type: "image", data: imageData, mimeType: "image/png" }]);
    expect(result.imageOrder).toEqual(["inline"]);
    expect(result.imageSourceIndexes).toEqual([1]);
  });

  it("appends extracted PDF page images without dropping current image attachments", async () => {
    await withTestDir({ prefix: "openclaw-current-turn-pdf-images-" }, async (base) => {
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
    await withTestDir({ prefix: "openclaw-current-turn-pdf-order-" }, async (base) => {
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

  it("retains undescribed native images when a described sibling and missing sibling coexist", async () => {
    await withTestDir({ prefix: "openclaw-current-turn-partial-" }, async (base) => {
      const imagePath = path.join(base, "present.png");
      const imageBytes = Buffer.from("present-image");
      await fs.writeFile(imagePath, imageBytes);

      const result = await resolveCurrentTurnImages({
        ctx: {
          Body: "compare these images",
          media: [
            {
              path: path.join(base, "described.png"),
              contentType: "image/png",
              workspaceDir: base,
            },
            { path: imagePath, contentType: "image/png", workspaceDir: base },
            {
              path: path.join(base, "missing.png"),
              contentType: "image/png",
              workspaceDir: base,
            },
          ],
          MediaUnderstanding: [
            {
              kind: "image.description",
              attachmentIndex: 0,
              provider: "imageModel",
              text: "an already described image",
            },
          ],
        } satisfies MsgContext,
        cfg: {} as OpenClawConfig,
      });

      expect(result.images).toEqual([
        {
          type: "image",
          data: imageBytes.toString("base64"),
          mimeType: "image/png",
        },
      ]);
      expect(result.imageOrder).toEqual(["inline"]);
      expect(result.imageSourceIndexes).toEqual([1]);
      expect(result.unresolvedSourceIndexes).toEqual([2]);
    });
  });

  it("proceeds without native images when current media resolution throws", async () => {
    vi.mocked(resolveAgentTurnAttachments).mockRejectedValueOnce(new Error("boom"));
    await withTestDir({ prefix: "openclaw-current-turn-throw-" }, async (base) => {
      const imagePath = path.join(base, "present.png");
      await fs.writeFile(imagePath, "present-image");

      const result = await resolveCurrentTurnImages({
        ctx: {
          Body: "describe this image",
          media: [{ path: imagePath, contentType: "image/png", workspaceDir: base }],
        } satisfies MsgContext,
        cfg: {} as OpenClawConfig,
      });

      expect(result.images).toBeUndefined();
      expect(result.imageOrder).toBeUndefined();
      expect(result.imageSourceIndexes).toBeUndefined();
      expect(result.unresolvedSourceIndexes).toEqual([0]);
    });
  });
});
