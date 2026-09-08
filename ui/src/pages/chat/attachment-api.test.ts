import { expect, it } from "vitest";
import { buildChatApiAttachments } from "./attachment-api.ts";

it.each([
  { mediaType: "text/plain;charset=utf-8", mimeType: "text/plain", type: "file" },
  {
    mediaType: "text/plain;charset=utf-8;name=notes%20copy.txt",
    mimeType: "text/plain",
    type: "file",
  },
  { mediaType: "image/png;name=preview.png", mimeType: "image/png", type: "image" },
])(
  "converts parameterized $mediaType data URLs into chat attachments",
  ({ mediaType, mimeType, type }) => {
    expect(
      buildChatApiAttachments([
        {
          id: "parameterized-attachment",
          dataUrl: `data:${mediaType};base64,bm90ZXM=`,
          mimeType,
          fileName: "attachment",
        },
      ]),
    ).toEqual([{ type, mimeType, fileName: "attachment", content: "bm90ZXM=" }]);
  },
);
