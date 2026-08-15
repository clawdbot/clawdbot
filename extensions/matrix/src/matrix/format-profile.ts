// Matrix helper module declares formatting capabilities and shared projections.
import type { MarkdownTableMode } from "openclaw/plugin-sdk/config-contracts";
import {
  convertMarkdownTables,
  FormatCapabilityProfile,
  renderMarkdownWithMarkers,
} from "openclaw/plugin-sdk/text-chunking";

export type MatrixSpoilerMarkers = { open: string; close: string; padding: string };
export type MatrixSpoilerProtection = { markdown: string; markers?: MatrixSpoilerMarkers };

export function createMatrixPrivateMarkers(
  markdown: string,
  exhaustedMessage: string,
): MatrixSpoilerMarkers {
  const used = new Set(Array.from(markdown, (character) => character.charCodeAt(0)));
  for (const match of markdown.matchAll(/&#(?:x([0-9a-f]+)|(\d+));/giu)) {
    const radix = match[1] ? 16 : 10;
    const value = Number.parseInt(match[1] ?? match[2] ?? "", radix);
    if (Number.isFinite(value) && value <= 0xffff) {
      used.add(value);
    }
  }
  const markers: string[] = [];
  for (let code = 0xe000; code <= 0xf8ff && markers.length < 3; code += 1) {
    if (!used.has(code)) {
      markers.push(String.fromCharCode(code));
    }
  }
  if (markers.length < 3) {
    throw new Error(exhaustedMessage);
  }
  return { open: markers[0] ?? "", close: markers[1] ?? "", padding: markers[2] ?? "" };
}

export const MATRIX_FORMAT_PROFILE = FormatCapabilityProfile.define({
  mechanism: "html",
  constructs: {
    taskList: "fallback",
    image: "fallback",
  },
  chunk: { limit: 4_000, unit: "chars" },
});

export function isMarkdownEscaped(markdown: string, index: number): boolean {
  let slashCount = 0;
  let cursor = index - 1;
  while (cursor >= 0 && markdown[cursor] === "\\") {
    slashCount += 1;
    cursor -= 1;
  }
  return slashCount % 2 === 1;
}

export function projectMatrixMarkdown(markdown: string): string {
  const normalized = (markdown ?? "").replace(/\r\n?/gu, "\n");
  return renderMarkdownWithMarkers(
    { text: normalized, styles: [], links: [] },
    { styleMarkers: {}, escapeText: (text) => text },
    MATRIX_FORMAT_PROFILE,
  );
}

export function renderMatrixMarkdownTables(markdown: string, mode: MarkdownTableMode): string {
  const useNativeTable =
    MATRIX_FORMAT_PROFILE.constructs.table === "native" && (mode === "off" || mode === "block");
  return useNativeTable ? markdown : convertMarkdownTables(markdown, mode);
}
