import { describe, expect, it } from "vitest";
import { selectAttachments } from "./attachments.js";
import type { MediaAttachment } from "./types.js";

describe("media-understanding selectAttachments guards", () => {
  it("returns no selections when attachments is undefined", () => {
    expect(
      selectAttachments({
        capability: "image",
        attachments: undefined as unknown as MediaAttachment[],
        policy: { prefer: "path" },
      }),
    ).toStrictEqual([]);
  });

  it("returns no selections when attachments is not an array", () => {
    expect(
      selectAttachments({
        capability: "audio",
        attachments: { malformed: true } as unknown as MediaAttachment[],
        policy: { prefer: "url" },
      }),
    ).toStrictEqual([]);
  });

  it("returns no selections for malformed attachment entries", () => {
    expect(
      selectAttachments({
        capability: "audio",
        attachments: [
          null,
          { index: 1, path: 123 },
          { index: 2, url: true },
          { index: 3, mime: { nope: true } },
        ] as unknown as MediaAttachment[],
        policy: { prefer: "path" },
      }),
    ).toStrictEqual([]);
  });
});
