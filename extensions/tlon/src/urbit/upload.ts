/**
 * Upload an image from a URL to Tlon storage.
 */
import { MAX_IMAGE_BYTES, readRemoteMediaBuffer } from "openclaw/plugin-sdk/media-runtime";
import { TLON_MEDIA_FETCH_TIMEOUTS } from "../media-fetch-timeouts.js";
import { uploadFile } from "../tlon-api.js";

/**
 * Fetch an image from a URL and upload it to Tlon storage.
 * Returns the uploaded URL, or falls back to the original URL on error.
 *
 * Note: configureClient must be called before using this function.
 */
export async function uploadImageFromUrl(imageUrl: string): Promise<string> {
  try {
    // Validate URL is http/https before fetching
    const url = new URL(imageUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      console.warn(`[tlon] Rejected non-http(s) URL: ${imageUrl}`);
      return imageUrl;
    }

    const fetched = await readRemoteMediaBuffer({
      url: imageUrl,
      maxBytes: MAX_IMAGE_BYTES,
      ...TLON_MEDIA_FETCH_TIMEOUTS,
      ssrfPolicy: undefined,
      requestInit: { method: "GET" },
    });

    const contentType = fetched.contentType || "image/png";
    const blob = new Blob([new Uint8Array(fetched.buffer)], { type: contentType });

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
    console.warn(`[tlon] Failed to upload image, using original URL: ${String(err)}`);
    return imageUrl;
  }
}
