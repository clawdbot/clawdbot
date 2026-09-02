import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { readRuntimeImageHistory } from "@openclaw/media-core";
import { describe, expect, it } from "vitest";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { buildInboundMediaNoteProjection } from "../media-note.js";
import type { RuntimeMsgContext } from "../templating.js";
import { resolveAgentTurnAttachments } from "./agent-turn-attachments.js";
import { resolveCurrentTurnImages } from "./current-turn-images.js";
import {
  buildPersistedMediaImageLayout,
  suppressUnresolvedPromptMedia,
} from "./get-reply-run-helpers.js";
import type { RecentInboundHistoryImage } from "./history-media.js";

// Distinct, complete 1x1 RGB PNGs keep byte identity observable through the real cache.
const HISTORY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
  "base64",
);
const CURRENT_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC",
  "base64",
);

function imageHash(image: { data: string }): string {
  return createHash("sha256").update(Buffer.from(image.data, "base64")).digest("hex");
}

async function createImageHistory(base: string) {
  const historyPath = path.join(base, "history.png");
  const currentPath = path.join(base, "current.png");
  const missingPath = path.join(base, "missing.png");
  const documentPath = path.join(base, "current.txt");
  await Promise.all([
    fs.writeFile(historyPath, HISTORY_PNG),
    fs.writeFile(currentPath, CURRENT_PNG),
    fs.writeFile(documentPath, "A current document without image content."),
  ]);
  const now = 1_800_000_000_000;
  const ctx: RuntimeMsgContext = {
    Body: "What was in the retained photo?",
    Timestamp: now,
    InboundHistory: [
      {
        sender: "Ada",
        body: "A retained photo.",
        timestamp: now - 1_000,
        messageId: "history-image",
        media: [{ path: historyPath, contentType: "image/png", kind: "image" }],
      },
    ],
  };
  const historyImage: RecentInboundHistoryImage = {
    path: historyPath,
    contentType: "image/png",
    kind: "image",
    sender: "Ada",
    sentAtMs: now - 1_000,
    messagePosition: 1,
    messageCount: 1,
    messageId: "history-image",
  };
  return { ctx, currentPath, missingPath, documentPath, historyImage };
}

describe("current-turn and shared attachment history agreement", () => {
  it.each([
    { current: "missing", expected: "history" },
    { current: "readable", expected: "current" },
    { current: "described", expected: "none" },
    { current: "document", expected: "none" },
  ] as const)(
    "selects $expected for a $current current attachment",
    async ({ current, expected }) => {
      await withTestDir({ prefix: "openclaw-turn-history-agreement-" }, async (base) => {
        const fixture = await createImageHistory(base);
        const currentPath =
          current === "missing"
            ? fixture.missingPath
            : current === "document"
              ? fixture.documentPath
              : fixture.currentPath;
        const ctx: RuntimeMsgContext = {
          ...fixture.ctx,
          media: [
            {
              path: currentPath,
              contentType: current === "document" ? "text/plain" : "image/png",
              kind: current === "document" ? "document" : "image",
              workspaceDir: base,
            },
          ],
          ...(current === "described"
            ? {
                MediaUnderstanding: [
                  {
                    kind: "image.description" as const,
                    attachmentIndex: 0,
                    provider: "fixture",
                    text: "A blue pixel.",
                  },
                ],
              }
            : {}),
        };
        if (current === "missing") {
          await expect(fs.stat(currentPath)).rejects.toMatchObject({ code: "ENOENT" });
        }

        const shared = await resolveAgentTurnAttachments({ ctx, cfg: {} });
        const native = await resolveCurrentTurnImages({ ctx, cfg: {} });
        const expectedBytes =
          expected === "none" ? [] : [expected === "history" ? HISTORY_PNG : CURRENT_PNG];
        const expectedHashes = expectedBytes.map((bytes) =>
          createHash("sha256").update(bytes).digest("hex"),
        );
        const expectedHistory = expected === "history" ? [fixture.historyImage] : [];
        const expectedOrigins = expectedBytes.map(() =>
          expected === "history"
            ? {
                key: `history-image\0${fixture.historyImage.path}`,
                sourceText: `from Ada, message history-image, sent at ${new Date(fixture.historyImage.sentAtMs).toISOString()}, message 1 of 1 in available history`,
              }
            : undefined,
        );

        expect(shared.attachments.map(imageHash)).toEqual(expectedHashes);
        expect(shared.attachments.map((image) => image.mediaType)).toEqual(
          expectedBytes.map(() => "image/png"),
        );
        expect(shared.recentHistoryImages).toEqual(expectedHistory);
        expect(shared.attachments.map(readRuntimeImageHistory)).toEqual(expectedOrigins);
        expect(native.unresolvedSourceIndexes ?? []).toEqual(current === "missing" ? [0] : []);
        expect(native.images?.map(imageHash) ?? []).toEqual(expectedHashes);
        expect(native.images?.map(({ type, mimeType }) => ({ type, mimeType })) ?? []).toEqual(
          expectedBytes.map(() => ({ type: "image", mimeType: "image/png" })),
        );
        expect(native.imageOrder ?? []).toEqual(expectedBytes.map(() => "inline"));
        expect(native.images?.map(readRuntimeImageHistory) ?? []).toEqual(expectedOrigins);

        if (current === "missing") {
          const projection = buildInboundMediaNoteProjection(ctx);
          const media = suppressUnresolvedPromptMedia({
            promptMedia: projection.media,
            inboundMediaIndexes: projection.mediaIndexes ?? [],
            unresolvedSourceIndexes: new Set(native.unresolvedSourceIndexes),
          });
          expect(media).toEqual([{ ...projection.media[0], hydrationSuppressed: true }]);
          expect(
            buildPersistedMediaImageLayout({
              ctx,
              media,
              ctxMediaCount: media.length,
              imageOrder: native.imageOrder,
              imageSourceIndexes: native.imageSourceIndexes,
            }),
          ).toEqual({ slots: [{ kind: "inline" }], suppressedFactIndexes: [0] });
        }
      });
    },
  );

  it.each(["supplied", "extracted"] as const)(
    "keeps a %s image ahead of retained history after a current read fails",
    async (source) => {
      await withTestDir({ prefix: "openclaw-turn-prepared-history-" }, async (base) => {
        const fixture = await createImageHistory(base);
        const ctx: RuntimeMsgContext = {
          ...fixture.ctx,
          media: [
            { path: fixture.missingPath, contentType: "image/png", workspaceDir: base },
            ...(source === "extracted"
              ? [
                  {
                    path: path.join(base, "prepared.pdf"),
                    contentType: "application/pdf",
                    workspaceDir: base,
                  },
                ]
              : []),
          ],
        };
        const preparedImage = {
          type: "image" as const,
          data: CURRENT_PNG.toString("base64"),
          mimeType: "image/png",
        };
        const shared = await resolveAgentTurnAttachments({ ctx, cfg: {} });
        expect(shared.attachments.map(imageHash)).toEqual([
          createHash("sha256").update(HISTORY_PNG).digest("hex"),
        ]);

        const native = await resolveCurrentTurnImages({
          ctx,
          cfg: {},
          ...(source === "supplied"
            ? { images: [preparedImage], imageOrder: ["inline" as const] }
            : { extractedFileImages: [{ ...preparedImage, attachmentIndex: 1 }] }),
        });

        expect(native.images).toEqual([preparedImage]);
        expect(native.imageOrder).toEqual(["inline"]);
        expect(native.imageSourceIndexes).toEqual([source === "extracted" ? 1 : undefined]);
        expect(native.images?.map(readRuntimeImageHistory)).toEqual([undefined]);
        expect(native.unresolvedSourceIndexes).toEqual([0]);
      });
    },
  );
});
