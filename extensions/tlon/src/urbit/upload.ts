/**
 * Upload an image from a URL to Tlon storage.
 */
import { bufferToBlobPart } from "openclaw/plugin-sdk/blob-runtime";
import { MAX_IMAGE_BYTES, readRemoteMediaBuffer } from "openclaw/plugin-sdk/media-runtime";
import { TLON_MEDIA_FETCH_TIMEOUTS } from "../media-fetch-timeouts.js";
import { uploadFile } from "../tlon-api.js";

/**
 * Fetch an image from a URL and upload it to Tlon storage.
 * Falls back to the original URL on error, but only after a bounded download when a cap is set.
 *
 * Note: configureClient must be called before using this function.
 */
export async function uploadImageFromUrl(imageUrl: string, maxBytes?: number): Promise<string> {
  let sourceSizeVerified = false;
  try {
    // Validate URL is http/https before fetching
    const url = new URL(imageUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("Tlon image URL must use HTTP or HTTPS");
    }

    const fetched = await readRemoteMediaBuffer({
      url: imageUrl,
      maxBytes: Math.min(maxBytes ?? MAX_IMAGE_BYTES, MAX_IMAGE_BYTES),
      ...TLON_MEDIA_FETCH_TIMEOUTS,
      ssrfPolicy: undefined,
      requestInit: { method: "GET" },
    });
    sourceSizeVerified = true;

    const contentType = fetched.contentType || "image/png";
    const blob = new Blob([bufferToBlobPart(fetched.buffer)], { type: contentType });

    // Extract filename from URL or use a default
    const urlPath = new URL(imageUrl).pathname;
    const fileName = urlPath.split("/").pop() || `upload-${Date.now()}.png`;

    // Upload to Tlon storage
    const result = await uploadFile({
      blob,
      fileName,
      contentType,
    });

    return result.url;
  } catch (err) {
    // Preserve link fallback only when it cannot bypass an operator's byte cap.
    if (maxBytes !== undefined && !sourceSizeVerified) {
      throw err;
    }
    console.warn(`[tlon] Failed to upload image, using original URL: ${String(err)}`);
    return imageUrl;
  }
}
