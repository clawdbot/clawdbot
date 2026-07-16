/**
 * Upload an image from a URL to Tlon storage.
 */
import { fetchWithSsrFGuard } from "../../runtime-api.js";
import { uploadFile } from "../tlon-api.js";
import { getDefaultSsrFPolicy } from "./context.js";

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

    // Fetch the image with SSRF protection
    // Use fetchWithSsrFGuard directly (not urbitFetch) to preserve the full URL path
    const { response, release } = await fetchWithSsrFGuard({
      url: imageUrl,
      init: { method: "GET" },
      policy: getDefaultSsrFPolicy(),
      auditContext: "tlon-upload-image",
    });

    try {
      if (!response.ok) {
        console.warn(`[tlon] Failed to fetch image from ${imageUrl}: ${response.status}`);
        return imageUrl;
      }

      const contentType = response.headers.get("content-type") || "image/png";
      const blob = await response.blob();

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
    } finally {
      await release();
    }
  } catch (err) {
    console.warn(`[tlon] Failed to upload image, using original URL: ${String(err)}`);
    return imageUrl;
  }
}
