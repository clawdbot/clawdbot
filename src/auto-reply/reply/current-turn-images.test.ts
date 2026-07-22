// Tests current-turn native image hydration from inbound media paths.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withTempDir } from "../../test-helpers/temp-dir.js";
import { deleteTestEnvValue, setTestEnvValue } from "../../test-utils/env.js";
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
      });
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
          MediaPaths: [imagePath, path.join(base, "scan.pdf")],
          MediaTypes: ["image/png", "application/pdf"],
          MediaWorkspaceDir: base,
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
          MediaPaths: [path.join(base, "scan.pdf"), imagePath],
          MediaTypes: ["application/pdf", "image/png"],
          MediaWorkspaceDir: base,
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
