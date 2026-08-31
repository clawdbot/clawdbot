// Whatsapp plugin module implements image preview behavior.
import type { AnyMessageContent } from "baileys";
import { getImageMetadata, resizeToJpeg } from "openclaw/plugin-sdk/media-runtime";

const WHATSAPP_IMAGE_THUMBNAIL_SIDE = 32;
const WHATSAPP_IMAGE_THUMBNAIL_QUALITY = 50;

type ImagePreviewContent = AnyMessageContent & {
  image?: unknown;
  jpegThumbnail?: unknown;
  width?: unknown;
  height?: unknown;
};

export async function addWhatsAppImagePreviewFields<T extends AnyMessageContent>(
  content: T,
): Promise<T> {
  const image = (content as ImagePreviewContent).image;
  if (!Buffer.isBuffer(image)) {
    return content;
  }

  const current = content as ImagePreviewContent;
  const hasDimensions = typeof current.width === "number" && typeof current.height === "number";
  const hasThumbnail = typeof current.jpegThumbnail === "string";
  if (hasDimensions && hasThumbnail) {
    return content;
  }

  const metadata = hasDimensions ? null : await getImageMetadata(image).catch(() => null);
  if (!hasDimensions && !metadata) {
    return content;
  }

  const thumbnail = hasThumbnail
    ? null
    : await resizeToJpeg({
        buffer: image,
        maxSide: WHATSAPP_IMAGE_THUMBNAIL_SIDE,
        quality: WHATSAPP_IMAGE_THUMBNAIL_QUALITY,
        withoutEnlargement: true,
      }).catch(() => null);

  return {
    ...content,
    ...(metadata ? { width: metadata.width, height: metadata.height } : {}),
    ...(thumbnail ? { jpegThumbnail: thumbnail.toString("base64") } : {}),
  };
}
