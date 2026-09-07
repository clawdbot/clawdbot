// Media-understanding attachment facade tests cover automatic-understanding exclusions.
import { describe, expect, it } from "vitest";
import type { MsgContext } from "../auto-reply/templating.js";
import { normalizeMediaAttachments } from "./runner.attachments.js";

describe("normalizeMediaAttachments", () => {
  it("skips a cached sticker while preserving supplemental media indexes", () => {
    const ctx: MsgContext = {
      media: [
        { path: "/tmp/cached-sticker.webp", contentType: "image/webp" },
        { path: "/tmp/replied-audio.ogg", contentType: "audio/ogg" },
      ],
      StickerMediaIncluded: true,
      SkipStickerMediaUnderstanding: true,
    };

    expect(normalizeMediaAttachments(ctx)).toEqual([
      {
        path: "/tmp/replied-audio.ogg",
        url: undefined,
        mime: "audio/ogg",
        kind: "audio",
        index: 1,
        alreadyTranscribed: false,
      },
    ]);
  });

  it.each(["image", "sticker", "document"] as const)(
    "preserves the authoritative %s kind at the private runner facade",
    (kind) => {
      expect(normalizeMediaAttachments({ media: [{ path: "/tmp/upload.bin", kind }] })).toEqual([
        {
          path: "/tmp/upload.bin",
          url: undefined,
          mime: undefined,
          kind,
          index: 0,
          alreadyTranscribed: false,
        },
      ]);
    },
  );

  it("preserves an explicitly declared staging root without inventing empty optional fields", () => {
    expect(
      normalizeMediaAttachments({
        media: [{ path: "/tmp/staged/photo.png", workspaceDir: "/tmp/staged" }],
      }),
    ).toEqual([
      {
        path: "/tmp/staged/photo.png",
        url: undefined,
        mime: undefined,
        workspaceDir: "/tmp/staged",
        index: 0,
        alreadyTranscribed: false,
      },
    ]);
  });
});
