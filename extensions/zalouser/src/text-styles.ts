import { randomUUID } from "node:crypto";
import { renderMarkdownWithAttributedRanges } from "openclaw/plugin-sdk/text-chunking";
import { collectBlockEdits } from "./text-styles-compile.js";
import { projectLocalTokens } from "./text-styles-inline.js";
import {
  applyTextEdits,
  collectStructuralStyles,
  restoreTrailingNewlines,
} from "./text-styles-ranges.js";
import { type TokenRegistry, ZALOUSER_STYLE_MAP } from "./text-styles-shared.js";
import {
  parseSharedIR,
  protectInlineSyntaxOutsideCode,
  restoreLeadingBlankLines,
  stripUnsupportedHeadingStyles,
} from "./text-styles-source.js";
import type { Style } from "./zca-constants.js";

export function parseZalouserTextStyles(input: string): { text: string; styles: Style[] } {
  const source = input.replace(/\r\n?/g, "\n");
  const registry: TokenRegistry = {
    nextId: 0,
    prefix: `<zalouser-${randomUUID()}-`,
    tokens: new Map(),
  };
  const sourceIR = parseSharedIR(source);
  const protectedSource = protectInlineSyntaxOutsideCode(source, sourceIR, registry);
  const ir = parseSharedIR(protectedSource);
  stripUnsupportedHeadingStyles(ir, sourceIR, source);
  const attributed = renderMarkdownWithAttributedRanges(ir, { styleMap: ZALOUSER_STYLE_MAP });
  const projected = projectLocalTokens(attributed, registry);
  const edits = collectBlockEdits(ir, sourceIR, projected.offsets, projected.text, source);
  const structuralStyles = collectStructuralStyles(ir, projected.offsets, projected.text);
  const compiled = applyTextEdits(projected.text, projected.styles, structuralStyles, edits);
  const withLeadingLines = restoreLeadingBlankLines(compiled, source);
  return {
    text: restoreTrailingNewlines(withLeadingLines.text, source, sourceIR),
    styles: withLeadingLines.styles,
  };
}
