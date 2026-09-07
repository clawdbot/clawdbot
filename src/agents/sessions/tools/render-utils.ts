/**
 * Rendering helpers for session tool output in the TUI.
 *
 * Normalizes paths/text/image fallbacks before tool results are styled or truncated.
 */
import * as os from "node:os";
import {
  type Component,
  getCapabilities,
  getImageDimensions,
  imageFallback,
  Text,
} from "@earendil-works/pi-tui";
import { shortenPathWithHome } from "../../../infra/home-display.js";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.js";
import type { Theme } from "../../modes/interactive/theme/theme.js";
import { sanitizeBinaryOutput } from "../../shell-utils.js";
import type { ToolRenderResultOptions } from "../extensions/types.js";
import { DEFAULT_MAX_BYTES, formatSize, type TruncationResult } from "./truncate.js";

/** Shortens paths under the current home directory for display. */
export function shortenPath(path: unknown): string {
  if (typeof path !== "string") {
    return "";
  }
  return shortenPathWithHome(path, { home: os.homedir(), prefix: "~" });
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

export function trimTrailingEmptyLines(lines: readonly string[]): string[] {
  return lines.slice(0, lines.findLastIndex((line) => line !== "") + 1);
}

export function reuseTextComponent(lastComponent: Component | undefined, content: string): Text {
  const text = (lastComponent as Text | undefined) ?? new Text("", 0, 0); // SAFETY: Render slots only reuse the component returned by this renderer.
  text.setText(content);
  return text;
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
    .map((c) => sanitizeBinaryOutput(c.text || "", { ansiMode: "compat" }).replace(/\r/g, ""))
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

/** Renders bounded text output with the shared TUI expansion hint. */
export function formatSessionToolOutput(
  result: { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> },
  options: ToolRenderResultOptions,
  theme: Pick<Theme, "fg">,
  showImages: boolean,
  collapsedLineLimit: number,
): string {
  const output = getTextOutput(result, showImages).trim();
  if (!output) {
    return "";
  }

  const lines = output.split("\n");
  const maxLines = options.expanded ? lines.length : collapsedLineLimit;
  const displayLines = lines.slice(0, maxLines);
  const remaining = lines.length - maxLines;
  let text = `\n${displayLines.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
  if (remaining > 0) {
    text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")})`;
  }
  return text;
}

export function appendSessionToolTruncationWarning(
  text: string,
  theme: Pick<Theme, "fg">,
  options: {
    limit?: { count: number; noun: string };
    truncation?: Pick<TruncationResult, "truncated" | "maxBytes">;
    additionalWarnings?: readonly string[];
  },
): string {
  const warnings: string[] = [];
  if (options.limit) {
    warnings.push(`${options.limit.count} ${options.limit.noun} limit`);
  }
  if (options.truncation?.truncated) {
    warnings.push(`${formatSize(options.truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit`);
  }
  warnings.push(...(options.additionalWarnings ?? []));
  if (warnings.length === 0) {
    return text;
  }
  return `${text}\n${theme.fg("warning", `[Truncated: ${warnings.join(", ")}]`)}`;
}

/** Formats the invalid-argument marker with the active theme. */
export function invalidArgText(theme: Pick<Theme, "fg">): string {
  return theme.fg("error", "[invalid arg]");
}
