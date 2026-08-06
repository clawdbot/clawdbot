import { readFile } from "node:fs/promises";
import path from "node:path";
import { saveMediaBuffer } from "openclaw/plugin-sdk/media-store";
import {
  DEFAULT_BROWSER_SCREENSHOT_MAX_BYTES,
  DEFAULT_BROWSER_SCREENSHOT_MAX_SIDE,
  normalizeBrowserScreenshot,
} from "./screenshot.js";

/** Stages a bounded screenshot copy in the sandbox-authorized outbound store. */
export async function stageBrowserScreenshotForSharing(
  filePath: string,
  maxDimensionPx?: number,
): Promise<string> {
  const source = await readFile(filePath);
  const normalized = await normalizeBrowserScreenshot(source, {
    maxSide: maxDimensionPx ?? DEFAULT_BROWSER_SCREENSHOT_MAX_SIDE,
    maxBytes: DEFAULT_BROWSER_SCREENSHOT_MAX_BYTES,
  });
  const saved = await saveMediaBuffer(
    normalized.buffer,
    normalized.contentType,
    "outbound",
    DEFAULT_BROWSER_SCREENSHOT_MAX_BYTES,
    path.basename(filePath),
  );
  return saved.path;
}
