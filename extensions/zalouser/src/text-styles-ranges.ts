import {
  projectOffset,
  type MarkdownIRWithBlockMetadata,
  type StructuralStyle,
  type TextEdit,
} from "./text-styles-shared.js";
import { TextStyle, type Style } from "./zca-constants.js";

export function collectStructuralStyles(
  ir: MarkdownIRWithBlockMetadata,
  offsets: number[],
  projectedText: string,
): StructuralStyle[] {
  const styles: StructuralStyle[] = ir.styles.flatMap((span) =>
    span.style === "heading_1"
      ? [
          {
            start: projectOffset(offsets, span.start),
            end: projectOffset(offsets, span.end),
            style: TextStyle.Big,
            priority: 1,
          },
        ]
      : [],
  );
  const items = [...(ir.listItems ?? [])].toSorted(
    (left, right) =>
      (left.start ?? 0) - (right.start ?? 0) || (left.depth ?? 0) - (right.depth ?? 0),
  );
  const listRanges: Array<{ start: number; end: number }> = [];
  const quoteBlocks = (ir.blocks ?? []).filter((block) => block.kind === "blockquote");

  for (const item of items) {
    const materializedRanges = (ir.blocks ?? []).flatMap((block) =>
      block.kind === "code_block" &&
      item.start !== undefined &&
      item.end !== undefined &&
      block.start >= item.start &&
      block.end <= item.end
        ? [{ start: block.start, end: block.end, preserveWhitespace: true }]
        : [],
    );
    const ownedRanges =
      item.contentStart !== undefined && item.contentEnd !== undefined
        ? subtractRanges(
            { start: item.contentStart, end: item.contentEnd },
            items
              .filter(
                (candidate) =>
                  candidate.start !== undefined &&
                  candidate.end !== undefined &&
                  (candidate.depth ?? 0) > (item.depth ?? 0) &&
                  candidate.end > item.contentStart! &&
                  candidate.start < item.contentEnd!,
              )
              .map((candidate) => ({ start: candidate.start!, end: candidate.end! })),
          ).map(({ start, end }) => ({ start, end, preserveWhitespace: false }))
        : materializedRanges;
    for (const ownedRange of ownedRanges) {
      let contentStart = ownedRange.start;
      let contentEnd = ownedRange.end;
      if (!ownedRange.preserveWhitespace) {
        while (contentStart < contentEnd && /[ \t\r\n]/u.test(ir.text[contentStart] ?? "")) {
          contentStart += 1;
        }
        while (contentEnd > contentStart && /[ \t\r\n]/u.test(ir.text[contentEnd - 1] ?? "")) {
          contentEnd -= 1;
        }
      }
      if (contentEnd <= contentStart) {
        continue;
      }
      const start = projectOffset(offsets, contentStart);
      const end = projectOffset(offsets, contentEnd);
      if (end <= start) {
        continue;
      }
      listRanges.push({ start, end });
      if (!item.task) {
        styles.push({
          start,
          end,
          style: item.kind === "ordered" ? TextStyle.OrderedList : TextStyle.UnorderedList,
          priority: 3,
        });
      }
      if (ownedRange.preserveWhitespace) {
        continue;
      }
      const quoteBoundaries = quoteBlocks.flatMap((block) => [block.start, block.end]);
      for (const line of splitRangeAtOffsets(
        { start: contentStart, end: contentEnd },
        quoteBoundaries,
        ir.text,
      )) {
        const quoteDepth = quoteBlocks.filter(
          (block) => block.start < line.end && block.end > line.start,
        ).length;
        const indentSize = Math.min(5, (item.depth ?? 0) + quoteDepth);
        if (indentSize === 0) {
          continue;
        }
        styles.push({
          start: projectOffset(offsets, line.start),
          end: projectOffset(offsets, line.end),
          style: TextStyle.Indent,
          indentSize,
          priority: 2,
        });
      }
    }
  }

  const codeRanges = (ir.blocks ?? [])
    .filter((block) => block.kind === "code_block")
    .map((block) => ({
      start: projectOffset(offsets, block.start),
      end: projectOffset(offsets, block.end),
    }));
  const quotedLines = new Map<string, StructuralStyle>();
  for (const block of quoteBlocks) {
    const start = projectOffset(offsets, block.start);
    const end = projectOffset(offsets, block.end);
    for (const line of splitLines({ start, end }, projectedText)) {
      if (
        [...listRanges, ...codeRanges].some(
          (range) => range.start < line.end && range.end > line.start,
        )
      ) {
        continue;
      }
      const key = `${line.start}:${line.end}`;
      const indentSize = Math.min(5, block.depth);
      const current = quotedLines.get(key);
      if (!current || (current.indentSize ?? 0) < indentSize) {
        quotedLines.set(key, {
          ...line,
          style: TextStyle.Indent,
          indentSize,
          priority: 2,
        });
      }
    }
  }
  styles.push(...quotedLines.values());
  return styles;
}

function splitRangeAtOffsets(
  range: { start: number; end: number },
  offsets: number[],
  text: string,
): Array<{ start: number; end: number }> {
  const boundaries = [
    range.start,
    ...offsets.filter((offset) => offset > range.start && offset < range.end),
    range.end,
  ].toSorted((left, right) => left - right);
  return boundaries.flatMap((start, index) => {
    const end = boundaries[index + 1];
    return end === undefined ? [] : splitLines({ start, end }, text);
  });
}

function subtractRanges(
  range: { start: number; end: number },
  exclusions: Array<{ start: number; end: number }>,
): Array<{ start: number; end: number }> {
  const result: Array<{ start: number; end: number }> = [];
  let cursor = range.start;
  for (const exclusion of exclusions.toSorted((left, right) => left.start - right.start)) {
    const start = Math.max(range.start, exclusion.start);
    const end = Math.min(range.end, exclusion.end);
    if (end <= cursor) {
      continue;
    }
    if (start > cursor) {
      result.push({ start: cursor, end: start });
    }
    cursor = end;
  }
  if (cursor < range.end) {
    result.push({ start: cursor, end: range.end });
  }
  return result;
}

function splitLines(
  range: { start: number; end: number },
  text: string,
): Array<{ start: number; end: number }> {
  const lines: Array<{ start: number; end: number }> = [];
  let start = range.start;
  while (start < range.end) {
    const newline = text.indexOf("\n", start);
    const end = newline === -1 ? range.end : Math.min(newline, range.end);
    if (end > start && text.slice(start, end).replace(/[ \t\r\n]/gu, "")) {
      lines.push({ start, end });
    }
    start = end + 1;
  }
  return lines;
}

export function applyTextEdits(
  text: string,
  inlineStyles: Style[],
  structuralStyles: StructuralStyle[],
  edits: TextEdit[],
): { text: string; styles: Style[] } {
  let output = "";
  let cursor = 0;
  for (const edit of edits) {
    output += text.slice(cursor, edit.start) + edit.text;
    cursor = edit.end;
  }
  output += text.slice(cursor);

  const ordered = [
    ...inlineStyles.map((style, sequence) => ({
      start: style.start,
      end: style.start + style.len,
      style: style.st,
      ...(style.st === TextStyle.Indent ? { indentSize: style.indentSize } : {}),
      priority: 0,
      sequence,
    })),
    ...structuralStyles.map((style, sequence) => Object.assign({}, style, { sequence })),
  ]
    .map((style) =>
      Object.assign(style, {
        start: mapEditedOffset(style.start, edits, false, style.priority > 0),
        end: mapEditedOffset(style.end, edits, true, style.priority > 0),
      }),
    )
    .flatMap((style) =>
      style.style === TextStyle.Indent ? splitStyledLines(style, output) : [style],
    )
    .filter((style) => style.end > style.start)
    .toSorted(
      (left, right) =>
        left.start - right.start ||
        left.priority - right.priority ||
        left.sequence - right.sequence,
    );
  for (const [editIndex, edit] of edits.entries()) {
    if ((!edit.indentSize && !edit.listStyle) || !edit.text) {
      continue;
    }
    const start = editedInsertionStart(edits, editIndex);
    const range = { start, end: start + edit.text.length };
    if (edit.indentSize) {
      ordered.push(
        ...splitStyledLines(
          {
            ...range,
            style: TextStyle.Indent,
            indentSize: edit.indentSize,
            priority: 2,
            sequence: structuralStyles.length + editIndex,
          },
          output,
        ),
      );
    }
    if (edit.listStyle) {
      ordered.push(
        ...splitStyledLines(
          {
            ...range,
            style: edit.listStyle,
            priority: 3,
            sequence: structuralStyles.length + editIndex,
          },
          output,
        ),
      );
    }
  }
  ordered.sort(
    (left, right) =>
      left.start - right.start || left.priority - right.priority || left.sequence - right.sequence,
  );

  const styles: Style[] = [];
  for (const style of ordered.map((orderedStyle) =>
    orderedStyle.style === TextStyle.Indent
      ? {
          start: orderedStyle.start,
          len: orderedStyle.end - orderedStyle.start,
          st: TextStyle.Indent,
          indentSize: orderedStyle.indentSize,
        }
      : {
          start: orderedStyle.start,
          len: orderedStyle.end - orderedStyle.start,
          st: orderedStyle.style,
        },
  )) {
    const previous = styles.at(-1);
    if (
      previous?.st === TextStyle.Indent &&
      style.st === TextStyle.Indent &&
      previous.start === style.start &&
      previous.len === style.len
    ) {
      previous.indentSize = Math.min(5, (previous.indentSize ?? 1) + (style.indentSize ?? 1));
    } else {
      styles.push(style as Style);
    }
  }
  return {
    text: output,
    styles,
  };
}

function editedInsertionStart(edits: TextEdit[], targetIndex: number): number {
  let delta = 0;
  for (let index = 0; index < targetIndex; index += 1) {
    const edit = edits[index];
    if (edit) {
      delta += edit.text.length - (edit.end - edit.start);
    }
  }
  return (edits[targetIndex]?.start ?? 0) + delta;
}

function splitStyledLines<T extends { start: number; end: number }>(style: T, text: string): T[] {
  const lines: T[] = [];
  let start = style.start;
  while (start < style.end) {
    const newline = text.indexOf("\n", start);
    const end = newline === -1 ? style.end : Math.min(newline, style.end);
    if (end > start) {
      lines.push({ ...style, start, end });
    }
    start = end + 1;
  }
  return lines;
}

function mapEditedOffset(
  offset: number,
  edits: TextEdit[],
  preferEnd: boolean,
  includeBoundaryInsertions = false,
): number {
  let delta = 0;
  for (const edit of edits) {
    if (edit.end < offset || (edit.end === offset && edit.start < edit.end)) {
      delta += edit.text.length - (edit.end - edit.start);
      continue;
    }
    if (edit.start > offset) {
      break;
    }
    if (edit.start === edit.end && offset === edit.start) {
      if ((!preferEnd && !includeBoundaryInsertions) || (preferEnd && includeBoundaryInsertions)) {
        delta += edit.text.length;
      }
      continue;
    }
    if (offset === edit.start) {
      return edit.start + delta;
    }
    if (offset < edit.end) {
      return edit.start + delta + (preferEnd ? edit.text.length : 0);
    }
    if (offset === edit.end) {
      return edit.start + delta + edit.text.length;
    }
  }
  return offset + delta;
}

export function restoreTrailingNewlines(
  text: string,
  source: string,
  ir: MarkdownIRWithBlockMetadata,
): string {
  const sourceLines = source.split("\n");
  let lastContentLine = sourceLines.length - 1;
  while (
    lastContentLine >= 0 &&
    !(ir.blocks ?? []).some(
      (block) =>
        block.kind === "code_block" &&
        lastContentLine >= (block.sourceStartLine ?? 0) &&
        lastContentLine < (block.sourceEndLine ?? 0),
    ) &&
    (/^[ \t]*$/u.test(sourceLines[lastContentLine] ?? "") ||
      /^(?: {0,3}>[ \t]?)+[ \t]*$/u.test(sourceLines[lastContentLine] ?? ""))
  ) {
    lastContentLine -= 1;
  }
  const trailingNewlines = sourceLines.length - 1 - Math.max(0, lastContentLine);
  const renderedTrailingNewlines = text.match(/\n*$/u)?.[0].length ?? 0;
  return `${text}${"\n".repeat(Math.max(0, trailingNewlines - renderedTrailingNewlines))}`;
}
