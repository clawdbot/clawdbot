// Media temp file helpers create and clean up temporary media files.
import fs from "node:fs/promises";

/** Best-effort temp-file cleanup helper for optional paths from media conversion flows. */
export async function unlinkIfExists(filePath: string | null | undefined): Promise<void> {
  if (!filePath) {
    return;
  }
  try {
    await fs.unlink(filePath);
  } catch {
    // Best-effort cleanup for temp files.
  }
}
