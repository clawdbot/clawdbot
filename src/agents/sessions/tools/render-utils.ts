import * as os from "node:os";
import { getCapabilities, getImageDimensions, imageFallback } from "@earendil-works/pi-tui";
import type { ImageContent, TextContent } from "../../../llm/types.js";
import type { Theme } from "../../modes/interactive/theme/theme.js";
import { stripAnsi } from "../../utils/ansi.js";
import { sanitizeBinaryOutput } from "../../utils/shell.js";

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

export function str(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (value == null) {
    return "";
  }
  return null;
}

export function replaceTabs(text: string): string {
  return text.replace(/\t/g, "   ");
}

export function normalizeDisplayText(text: string): string {
  return text.replace(/\r/g, "");
}

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

export type ToolRenderResultLike<TDetails> = {
  content: (TextContent | ImageContent)[];
  details: TDetails;
};

export function invalidArgText(theme: Pick<Theme, "fg">): string {
  return theme.fg("error", "[invalid arg]");
}
