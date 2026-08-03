import { applyConstructFallbacks } from "./construct-fallbacks.js";
import type { FormatCapabilityProfile } from "./format-capabilities.js";
import type { MarkdownIR } from "./ir.js";

export type PlainRenderOptions = {
  linkStyle?: "label" | "label-and-url";
};

/** Projects Markdown IR to plain text, optionally applying channel capability fallbacks. */
export function renderMarkdownAsPlainText(
  ir: MarkdownIR,
  options: PlainRenderOptions = {},
  profile?: FormatCapabilityProfile,
): string {
  const effectiveProfile =
    profile && options.linkStyle === "label"
      ? { ...profile, constructs: { ...profile.constructs, linkLabel: "strip" as const } }
      : profile;
  const projected = effectiveProfile ? applyConstructFallbacks(ir, effectiveProfile) : ir;
  if ((options.linkStyle ?? "label-and-url") === "label" || projected.links.length === 0) {
    return projected.text;
  }
  let output = "";
  let cursor = 0;
  for (const link of [...projected.links].toSorted((a, b) => a.start - b.start)) {
    if (link.start < cursor) {
      continue;
    }
    output += projected.text.slice(cursor, link.end);
    const href = link.href.trim();
    const label = projected.text.slice(link.start, link.end).trim();
    const comparableHref = href.startsWith("mailto:") ? href.slice("mailto:".length) : href;
    if (href && label && label !== href && label !== comparableHref) {
      output += ` (${href})`;
    }
    cursor = link.end;
  }
  return output + projected.text.slice(cursor);
}
