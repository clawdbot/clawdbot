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
        index: 1,
        alreadyTranscribed: false,
      },
    ]);
  });
});
