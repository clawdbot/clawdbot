// Whatsapp plugin module resolves the WA Web version used for the socket handshake.
import { fetchLatestBaileysVersion, fetchLatestWaWebVersion } from "./session.runtime.js";

/**
 * WhatsApp rejects handshakes from stale WA Web versions with a 405, so ask
 * web.whatsapp.com for the live version and only fall back to the pinned
 * Baileys version list when the live lookup fails.
 */
export async function resolveWaSocketVersion(logger: {
  warn: (obj: unknown, msg?: string) => void;
}): Promise<Awaited<ReturnType<typeof fetchLatestBaileysVersion>>["version"]> {
  try {
    const live = await fetchLatestWaWebVersion({});
    if (live.isLatest) {
      return live.version;
    }
    logger.warn(
      { error: (live as { error?: { message?: string } }).error?.message },
      "live WA Web version lookup failed; falling back to pinned Baileys version",
    );
  } catch (err) {
    logger.warn(
      { error: String(err) },
      "live WA Web version lookup failed; falling back to pinned Baileys version",
    );
  }
  const pinned = await fetchLatestBaileysVersion();
  return pinned.version;
}
