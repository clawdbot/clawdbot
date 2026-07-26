/**
 * Interactive terminal diff renderer.
 *
 * Produces colored line and intra-line highlights for the Pi TUI review surfaces.
 */
import { diffWords } from "diff";
import { theme } from "../theme/theme.js";

/**
 * Parse diff line to extract prefix, line number, and content.
 * Format: "+123 content" or "-123 content" or " 123 content" or "     ..."
 */
function parseDiffLine(line: string): { prefix: string; lineNum: string; content: string } | null {
  const match = line.match(/^([+-\s])(\s*\d*)\s(.*)$/);
  if (!match) {
    return null;
  }
  const [, prefix, lineNum, content] = match;
  return prefix !== undefined && lineNum !== undefined && content !== undefined
    ? { prefix, lineNum, content }
    : null;
}

/**
 * Replace tabs with spaces for consistent rendering.
 */
function replaceTabs(text: string): string {
  return text.replace(/\t/g, "   ");
}

/**
 * Compute word-level diff and render with inverse on changed parts.
 * Uses diffWords which groups whitespace with adjacent words for cleaner highlighting.
 * Strips leading whitespace from inverse to avoid highlighting indentation.
 */
function renderIntraLineDiff(
  oldContent: string,
  newContent: string,
): { removedLine: string; addedLine: string } {
  let removedLine = "";
  let addedLine = "";
  const seen = { added: false, removed: false };

  for (const part of diffWords(oldContent, newContent)) {
    const kind = part.added ? "added" : part.removed ? "removed" : undefined;
    let value = part.value;
    if (kind) {
      const changed = seen[kind] ? value : value.trimStart();
      const leadingWhitespace = value.slice(0, value.length - changed.length);
      value = leadingWhitespace + (changed ? theme.inverse(changed) : "");
      seen[kind] = true;
    }
    if (!part.added) {
      removedLine += value;
    }
    if (!part.removed) {
      addedLine += value;
    }
  }

  return { removedLine, addedLine };
}

/**
 * Render a diff string with colored lines and intra-line change highlighting.
 * - Context lines: dim/gray
 * - Removed lines: red, with inverse on changed tokens
 * - Added lines: green, with inverse on changed tokens
 */
export function renderDiff(diffText: string): string {
  const lines = diffText.split("\n");
  const result: string[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines.at(i);
    if (line === undefined) {
      break;
    }
    const parsed = parseDiffLine(line);

    if (!parsed) {
      result.push(theme.fg("toolDiffContext", line));
      i++;
      continue;
    }

    if (parsed.prefix === "-") {
      // Collect consecutive removed lines
      const removedLines: { lineNum: string; content: string }[] = [];
      while (i < lines.length) {
        const currentLine = lines.at(i);
        const p = currentLine === undefined ? null : parseDiffLine(currentLine);
        if (!p || p.prefix !== "-") {
          break;
        }
        removedLines.push({ lineNum: p.lineNum, content: p.content });
        i++;
      }

      // Collect consecutive added lines
      const addedLines: { lineNum: string; content: string }[] = [];
      while (i < lines.length) {
        const currentLine = lines.at(i);
        const p = currentLine === undefined ? null : parseDiffLine(currentLine);
        if (!p || p.prefix !== "+") {
          break;
        }
        addedLines.push({ lineNum: p.lineNum, content: p.content });
        i++;
      }

      // Only do intra-line diffing when there's exactly one removed and one added line
      // (indicating a single line modification). Otherwise, show lines as-is.
      if (removedLines.length === 1 && addedLines.length === 1) {
        const removed = removedLines[0];
        const added = addedLines[0];
        if (!removed || !added) {
          continue;
        }

        const { removedLine, addedLine } = renderIntraLineDiff(
          replaceTabs(removed.content),
          replaceTabs(added.content),
        );

        result.push(theme.fg("toolDiffRemoved", `-${removed.lineNum} ${removedLine}`));
        result.push(theme.fg("toolDiffAdded", `+${added.lineNum} ${addedLine}`));
      } else {
        // Show all removed lines first, then all added lines
        for (const removed of removedLines) {
          result.push(
            theme.fg("toolDiffRemoved", `-${removed.lineNum} ${replaceTabs(removed.content)}`),
          );
        }
        for (const added of addedLines) {
          result.push(theme.fg("toolDiffAdded", `+${added.lineNum} ${replaceTabs(added.content)}`));
        }
      }
    } else if (parsed.prefix === "+") {
      // Standalone added line
      result.push(theme.fg("toolDiffAdded", `+${parsed.lineNum} ${replaceTabs(parsed.content)}`));
      i++;
    } else {
      // Context line
      result.push(theme.fg("toolDiffContext", ` ${parsed.lineNum} ${replaceTabs(parsed.content)}`));
      i++;
    }
  }

  return result.join("\n");
}
