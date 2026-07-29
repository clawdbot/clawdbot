// Zalouser plugin module implements qr temp file behavior.
import fsp from "node:fs/promises";
import path from "node:path";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";

export async function writeQrDataUrlToTempFile(
  qrDataUrl: string,
  profile: string,
): Promise<string | null> {
  const trimmed = qrDataUrl.trim();
  const match = trimmed.match(/^data:image\/png;base64,(.+)$/i);
  const base64 = (match?.[1] ?? "").trim();
  if (!base64) {
    return null;
  }
  const safeProfile = profile.replace(/[^a-zA-Z0-9_-]+/g, "-") || "default";
  // The stable private-root name lets QR refreshes overwrite instead of accumulating temp files.
  const filePath = path.join(
    resolvePreferredOpenClawTmpDir(),
    `openclaw-zalouser-qr-${safeProfile}.png`,
  );
  await fsp.writeFile(filePath, Buffer.from(base64, "base64"), { mode: 0o600 });
  await fsp.chmod(filePath, 0o600);
  return filePath;
}
