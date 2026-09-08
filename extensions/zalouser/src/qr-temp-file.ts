// Zalouser plugin module implements qr temp file behavior.
import fsp from "node:fs/promises";
import path from "node:path";
import { sanitizeInlineImageDataUrl } from "openclaw/plugin-sdk/inline-image-data-url-runtime";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";

const PNG_DATA_URL_PREFIX = "data:image/png;base64,";

export async function writeQrDataUrlToTempFile(
  qrDataUrl: string,
  profile: string,
): Promise<string | null> {
  const normalized = sanitizeInlineImageDataUrl(qrDataUrl.trim());
  if (!normalized?.startsWith(PNG_DATA_URL_PREFIX)) {
    return null;
  }
  const png = Buffer.from(normalized.slice(PNG_DATA_URL_PREFIX.length), "base64");
  const safeProfile = profile.replace(/[^a-zA-Z0-9_-]+/g, "-") || "default";
  // The stable private-root name lets QR refreshes overwrite instead of accumulating temp files.
  const filePath = path.join(
    resolvePreferredOpenClawTmpDir(),
    `openclaw-zalouser-qr-${safeProfile}.png`,
  );
  await fsp.writeFile(filePath, png, { mode: 0o600 });
  await fsp.chmod(filePath, 0o600);
  return filePath;
}
