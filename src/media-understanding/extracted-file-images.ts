// Shared transient image payloads extracted from inbound file attachments.
import type { ImageContent } from "../llm/types.js";

export type ExtractedFileImage = ImageContent & {
  attachmentIndex: number;
};

export function stripExtractedFileImageMetadata(image: ExtractedFileImage): ImageContent {
  return {
    type: "image",
    data: image.data,
    mimeType: image.mimeType,
  };
}
