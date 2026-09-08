// Whatsapp plugin module implements image preview behavior.
import type { AnyMessageContent } from "baileys";
import { getImageMetadata, resizeToJpeg } from "openclaw/plugin-sdk/media-runtime";

const WHATSAPP_IMAGE_THUMBNAIL_SIDE = 32;
const WHATSAPP_IMAGE_THUMBNAIL_QUALITY = 50;

export async function addWhatsAppImagePreviewFields<T extends AnyMessageContent>(
  content: T,
): Promise<T> {
  if (!("image" in content) || !Buffer.isBuffer(content.image)) {
    return content;
  }

  const image = content.image;
  const hasDimensions = typeof content.width === "number" && typeof content.height === "number";
  const hasThumbnail = typeof content.jpegThumbnail === "string";
  if (hasDimensions && hasThumbnail) {
    return content;
  }

  const metadata = hasDimensions ? null : await getImageMetadata(image).catch(() => null);
  // Baileys treats undefined as a request to generate a thumbnail. Empty base64
  // keeps a failed preview optional without invoking another image processor.
  const jpegThumbnail = hasThumbnail
    ? content.jpegThumbnail
    : await resizeToJpeg({
        buffer: image,
        maxSide: WHATSAPP_IMAGE_THUMBNAIL_SIDE,
        quality: WHATSAPP_IMAGE_THUMBNAIL_QUALITY,
        withoutEnlargement: true,
      })
        .then((thumbnail) => thumbnail.toString("base64"))
        .catch(() => "");

  return {
    ...content,
    ...(metadata ? { width: metadata.width, height: metadata.height } : {}),
    jpegThumbnail,
  };
}
