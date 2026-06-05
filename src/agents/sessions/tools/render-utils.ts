/**
 * Rendering helpers for session tool output in the TUI.
 *
 * Normalizes paths/text/image fallbacks before tool results are styled or truncated.
 */
import * as os from "node:os";
import { getCapabilities, getImageDimensions, imageFallback } from "@earendil-works/pi-tui";
import type { ImageContent, TextContent } from "../../../llm/types.js";
import type { Theme } from "../../modes/interactive/theme/theme.js";
import { sanitizeBinaryOutput } from "../../shell-utils.js";
import { stripAnsi } from "../../utils/ansi.js";

/** Shortens paths under the current home directory for display. */
export function shortenPath(path: unknown): string {
  if (typeof path !== "string") {
    return "";
  }
  const home = os.homedir();
  if (path.startsWith(home)) {
    return `~${path.slice(home.length)}`;
  }
  return path;
}

/** Returns a display string for string/nullish values, or null for unsupported values. */
export function str(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (value == null) {
    return "";
  }
  return null;
}

/** Replaces tabs with stable spaces so terminal layout does not shift by tab stop. */
export function replaceTabs(text: string): string {
  return text.replace(/\t/g, "   ");
}

/** Normalizes raw terminal output before display. */
export function normalizeDisplayText(text: string): string {
  return text.replace(/\r/g, "");
}

/** Extracts text output and image placeholders from a tool result. */
export function getTextOutput(
  result:
    | { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> }
    | undefined,
  showImages: boolean,
): string {
  if (!result) {
    return "";
  }

  const textBlocks = result.content.filter((c) => c.type === "text");
  const imageBlocks = result.content.filter((c) => c.type === "image");

  let output = textBlocks
    .map((c) => sanitizeBinaryOutput(stripAnsi(c.text || "")).replace(/\r/g, ""))
    .join("\n");

  const caps = getCapabilities();
  if (imageBlocks.length > 0 && (!caps.images || !showImages)) {
    // When inline images are unavailable, preserve visible evidence that media was returned.
    const imageIndicators = imageBlocks
      .map((img) => {
        const mimeType = img.mimeType ?? "image/unknown";
        const dims =
          img.data && img.mimeType
            ? (getImageDimensions(img.data, img.mimeType) ?? undefined)
            : undefined;
        return imageFallback(mimeType, dims);
      })
      .join("\n");
    output = output ? `${output}\n${imageIndicators}` : imageIndicators;
  }

  return output;
}

/** Minimal shape shared by renderers that carry typed tool details. */
export type ToolRenderResultLike<TDetails> = {
  content: (TextContent | ImageContent)[];
  details: TDetails;
};

/** Formats the invalid-argument marker with the active theme. */
export function invalidArgText(theme: Pick<Theme, "fg">): string {
  return theme.fg("error", "[invalid arg]");
}
