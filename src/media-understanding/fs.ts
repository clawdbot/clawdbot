// Small file-system helpers for optional media attachment paths.
import { pathExists } from "../infra/fs-safe.js";

/** Safely checks optional media file paths without throwing on empty input. */
export async function fileExists(filePath?: string | null): Promise<boolean> {
  return filePath ? await pathExists(filePath) : false;
}
