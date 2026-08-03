import {
  normalizeCodeBlockLeadingWhitespace,
  projectOffset,
  UNICODE_SEPARATOR_PATTERN,
  type MarkdownBlockMetadata,
  type MarkdownIRWithBlockMetadata,
  type TextEdit,
} from "./text-styles-shared.js";
import {
  sourceContainerPrefixLength,
  sourceContainerProjection,
  sourceListItemContent,
} from "./text-styles-source-spans.js";
import { sourceAtxIsMarkerOnly } from "./text-styles-source.js";
import { TextStyle } from "./zca-constants.js";

export function collectBlockEdits(
  ir: MarkdownIRWithBlockMetadata,
  sourceIR: MarkdownIRWithBlockMetadata,
  offsets: number[],
  projectedText: string,
  source: string,
): TextEdit[] {
  const edits: TextEdit[] = [];
  const sourceLines = source.split("\n");
  const sourceLineStarts = sourceLines.reduce<number[]>((starts, _line, index) => {
    starts.push(
      index === 0 ? 0 : (starts[index - 1] ?? 0) + (sourceLines[index - 1]?.length ?? 0) + 1,
    );
    return starts;
  }, []);
  for (const [itemIndex, item] of (ir.listItems ?? []).entries()) {
    if (!item.listMarker) {
      continue;
    }
    const nestedStarts = (ir.listItems ?? [])
      .filter(
        (candidate) =>
          candidate.parentListId === item.listId &&
          candidate.start !== undefined &&
          candidate.start < (item.contentStart ?? item.listMarker!.end),
      )
      .map((candidate) => candidate.start!);
    const nestedStart = nestedStarts.length > 0 ? Math.min(...nestedStarts) : item.listMarker.end;
    const materializedBlock = (ir.blocks ?? []).some(
      (block) =>
        block.kind !== "blockquote" &&
        item.start !== undefined &&
        item.end !== undefined &&
        block.start >= item.start &&
        block.end <= item.end,
    );
    const sourceItem = sourceIR.listItems?.[itemIndex];
    const sourceContent = sourceItem
      ? sourceListItemContent(source, sourceIR, sourceLineStarts, sourceLines, sourceItem)
      : "";
    const hasRenderedContent =
      item.contentStart !== undefined &&
      item.contentEnd !== undefined &&
      item.contentEnd > item.contentStart;
    const unicodeContent =
      !hasRenderedContent && !materializedBlock && UNICODE_SEPARATOR_PATTERN.test(sourceContent)
        ? sourceContent
        : "";
    const literalMarker =
      unicodeContent ||
      (!hasRenderedContent && !materializedBlock && sourceItem?.sourceMarker
        ? source.slice(sourceItem.sourceMarker.start, sourceItem.sourceMarker.end)
        : "");
    const markerQuoteDepth = (ir.blocks ?? [])
      .filter(
        (block) =>
          block.kind === "blockquote" &&
          item.start !== undefined &&
          item.end !== undefined &&
          block.start >= item.start &&
          block.end <= item.end,
      )
      .reduce((depth, block) => Math.max(depth, block.blockquoteDepth ?? 0), 0);
    const existingQuoteIndent = (ir.blocks ?? [])
      .filter(
        (block) =>
          block.kind === "blockquote" &&
          block.start < block.end &&
          item.start !== undefined &&
          item.end !== undefined &&
          block.start <= item.start &&
          block.end >= item.end,
      )
      .reduce((depth, block) => Math.max(depth, block.depth), 0);
    const markerIndent = Math.max(0, (item.depth ?? 0) + markerQuoteDepth - existingQuoteIndent);
    edits.push({
      start: projectOffset(offsets, item.start ?? item.listMarker.start),
      end: projectOffset(offsets, Math.max(item.listMarker.end, nestedStart)),
      text: literalMarker,
      ...(literalMarker && markerIndent > 0 ? { indentSize: Math.min(5, markerIndent) } : {}),
      ...(unicodeContent && !item.task
        ? {
            listStyle: item.kind === "ordered" ? TextStyle.OrderedList : TextStyle.UnorderedList,
          }
        : {}),
    });
  }
  for (const block of ir.blocks ?? []) {
    if (block.kind !== "code_block") {
      continue;
    }
    const start = projectOffset(offsets, block.start);
    const end = projectOffset(offsets, block.end);
    const sourceBlock = (sourceIR.blocks ?? []).find(
      (candidate) =>
        candidate.kind === "code_block" && candidate.sourceStartLine === block.sourceStartLine,
    );
    const normalized = normalizeCodeBlock(
      ir.text.slice(block.start, block.end),
      block.codeOrigin,
      !source.endsWith("\n") && block.sourceEndLine === sourceLines.length,
      sourceIR,
      sourceLines,
      sourceLineStarts,
      block.sourceStartLine,
      block.blockquoteDepth ?? 0,
    );
    const sourceHasNbsp = sourceLines
      .slice(
        (block.sourceStartLine ?? 0) + (block.codeOrigin === "fenced" ? 1 : 0),
        block.sourceEndLine ?? 0,
      )
      .some((line) => line.includes("\u00A0"));
    const listOwnsBlock =
      (Boolean(normalized.replace(/[ \t\r\n\u00A0]/gu, "")) || sourceHasNbsp) &&
      (ir.listItems ?? []).some(
        (item) =>
          item.contentStart !== undefined &&
          item.contentEnd !== undefined &&
          item.contentEnd > item.contentStart &&
          item.end !== undefined &&
          item.contentStart <= block.start &&
          item.end >= block.end,
      );
    edits.push({
      start,
      end,
      text:
        block.codeOrigin === "fenced" && block.codeClosed === false && sourceBlock
          ? renderUnclosedCodeBlock(
              sourceBlock,
              sourceIR,
              sourceLines,
              sourceLineStarts,
              normalized,
            )
          : normalized,
      ...(!listOwnsBlock &&
      ((block.codeOrigin === "fenced" && block.codeClosed === false) ||
        block.codeOrigin === "indented") &&
      block.depth > 1
        ? {
            indentSize: Math.min(
              5,
              (block.blockquoteDepth ?? 0) +
                Math.max(0, block.depth - 2 - (block.blockquoteDepth ?? 0)),
            ),
          }
        : {}),
    });
  }
  for (const block of ir.blocks ?? []) {
    const sourceBlock = (sourceIR.blocks ?? []).find(
      (candidate) =>
        candidate.kind === block.kind &&
        candidate.sourceStartLine === block.sourceStartLine &&
        candidate.depth === block.depth &&
        candidate.blockquoteDepth === block.blockquoteDepth,
    );
    if (!sourceBlock) {
      continue;
    }
    if (block.kind === "blockquote" && block.start === block.end) {
      const containsClosedCode = (sourceIR.blocks ?? []).some(
        (candidate) =>
          candidate.kind === "code_block" &&
          candidate.codeClosed === true &&
          (candidate.sourceStartLine ?? 0) >= (sourceBlock.sourceStartLine ?? 0) &&
          (candidate.sourceEndLine ?? 0) <= (sourceBlock.sourceEndLine ?? 0),
      );
      const hasNestedQuote = (sourceIR.blocks ?? []).some(
        (candidate) =>
          candidate.kind === "blockquote" &&
          candidate.sourceStartLine === sourceBlock.sourceStartLine &&
          (candidate.blockquoteDepth ?? 0) > (sourceBlock.blockquoteDepth ?? 0),
      );
      if (containsClosedCode || hasNestedQuote) {
        continue;
      }
      const content = sourceLines
        .slice(sourceBlock.sourceStartLine ?? 0, sourceBlock.sourceEndLine ?? 0)
        .map((line) => sourceContainerContent(line))
        .join("\n")
        .replace(/[ \t\r\n]+$/gu, "");
      if (content.replace(/[ \t\r\n]/gu, "")) {
        const position = projectOffset(offsets, block.start);
        edits.push({
          start: position,
          end: position,
          text: content,
          indentSize: Math.min(5, sourceBlock.blockquoteDepth ?? 1),
        });
      }
      continue;
    }
    if (
      sourceBlock.start === sourceBlock.end &&
      !(
        block.kind === "heading" &&
        (sourceBlock.headingOrigin === "setext" ||
          (sourceBlock.headingOrigin === "atx" &&
            (sourceBlock.headingLevel ?? 0) > 4 &&
            !sourceAtxIsMarkerOnly(
              sourceLines[sourceBlock.sourceStartLine ?? 0] ?? "",
              sourceBlock.headingLevel ?? 1,
            )))
      )
    ) {
      continue;
    }
    if (
      block.kind === "heading" &&
      sourceBlock.headingOrigin === "atx" &&
      (sourceBlock.headingLevel ?? 0) > 4
    ) {
      const lineIndex = sourceBlock.sourceStartLine ?? 0;
      const line = sourceLines[lineIndex] ?? "";
      const projection = sourceContainerProjection(
        line,
        lineIndex,
        sourceIR,
        sourceLineStarts,
        sourceLines,
        sourceBlock.blockquoteDepth ?? 0,
      );
      const markerMatch = /^( {0,3}#{5,6}[ \t]+)/u.exec(line.slice(projection.offset))?.[0] ?? "";
      const marker = `${" ".repeat(projection.residual)}${markerMatch}`;
      if (marker) {
        const offset = projectOffset(offsets, block.start);
        edits.push({
          start: offset,
          end: offset,
          text: marker,
        });
      }
    } else if (block.kind === "heading" && sourceBlock.headingOrigin === "setext") {
      const lineIndex = (sourceBlock.sourceEndLine ?? 1) - 1;
      const line = sourceLines[lineIndex] ?? "";
      const projection = sourceContainerProjection(
        line,
        lineIndex,
        sourceIR,
        sourceLineStarts,
        sourceLines,
        sourceBlock.blockquoteDepth ?? 0,
      );
      const marker = `${" ".repeat(projection.residual)}${line.slice(projection.offset)}`;
      const offset = projectOffset(offsets, block.end);
      edits.push({
        start: offset,
        end: offset,
        text: `\n${marker}`,
      });
    } else if (block.kind === "thematic_break") {
      const lineIndex = sourceBlock.sourceStartLine ?? 0;
      const line = sourceLines[lineIndex] ?? "";
      const projection = sourceContainerProjection(
        line,
        lineIndex,
        sourceIR,
        sourceLineStarts,
        sourceLines,
        sourceBlock.blockquoteDepth ?? 0,
      );
      edits.push({
        start: projectOffset(offsets, block.start),
        end: projectOffset(offsets, block.end),
        text: `${" ".repeat(projection.residual)}${line.slice(projection.offset)}`,
      });
    }
  }
  edits.push(
    ...collectSourceSpacingEdits(ir, sourceIR, offsets, projectedText, source).filter(
      (spacingEdit) =>
        !edits.some((edit) => spacingEdit.start < edit.end && spacingEdit.end > edit.start),
    ),
  );
  return edits
    .toSorted(
      (left, right) =>
        left.start - right.start ||
        left.end - right.end ||
        Number(right.text.startsWith("\n")) - Number(left.text.startsWith("\n")),
    )
    .filter(
      (edit, index, all) =>
        !all
          .slice(0, index)
          .some(
            (other) =>
              other.start === edit.start && other.end === edit.end && other.text === edit.text,
          ),
    );
}

function renderUnclosedCodeBlock(
  block: MarkdownBlockMetadata,
  sourceIR: MarkdownIRWithBlockMetadata,
  sourceLines: string[],
  sourceLineStarts: number[],
  payload: string,
): string {
  const sourceStartLine = block.sourceStartLine ?? 0;
  const openingLine = sourceLines[sourceStartLine] ?? "";
  const projection = sourceContainerProjection(
    openingLine,
    sourceStartLine,
    sourceIR,
    sourceLineStarts,
    sourceLines,
    block.blockquoteDepth ?? 0,
  );
  const opening =
    block.depth > 1
      ? `${" ".repeat(projection.residual)}${openingLine.slice(projection.offset)}`
      : openingLine;
  if ((block.sourceEndLine ?? 0) - (block.sourceStartLine ?? 0) <= 1) {
    return `${opening}${payload.endsWith("\n") ? "\n" : ""}`;
  }
  return payload ? `${opening}\n${payload}` : opening;
}

function collectSourceSpacingEdits(
  ir: MarkdownIRWithBlockMetadata,
  sourceIR: MarkdownIRWithBlockMetadata,
  offsets: number[],
  text: string,
  source: string,
): TextEdit[] {
  const sourceLines = source.split("\n");
  const sourceLineStarts = sourceLines.reduce<number[]>((starts, _line, index) => {
    starts.push(
      index === 0 ? 0 : (starts[index - 1] ?? 0) + (sourceLines[index - 1]?.length ?? 0) + 1,
    );
    return starts;
  }, []);
  const boundaries = [
    ...(ir.blocks ?? []).map((block) =>
      Object.assign({}, block, {
        sameLineNested: (sourceIR.listItems ?? []).some(
          (item) => item.sourceStartLine === block.sourceStartLine,
        ),
      }),
    ),
    ...(ir.listItems ?? []).flatMap((item, itemIndex) =>
      item.start !== undefined &&
      item.end !== undefined &&
      item.sourceStartLine !== undefined &&
      item.sourceEndLine !== undefined
        ? [
            {
              start: item.start,
              end: item.end,
              sourceStartLine: item.sourceStartLine,
              sourceEndLine: item.sourceEndLine,
              sameLineNested: (() => {
                const sourceItem = sourceIR.listItems?.[itemIndex];
                if (!sourceItem?.sourceMarker || sourceItem.sourceStartLine === undefined) {
                  return false;
                }
                const lineStart = sourceLineStarts[sourceItem.sourceStartLine] ?? 0;
                const firstMarker = (sourceIR.listItems ?? [])
                  .filter((candidate) => candidate.sourceStartLine === sourceItem.sourceStartLine)
                  .reduce(
                    (first, candidate) => Math.min(first, candidate.sourceMarker?.start ?? first),
                    Number.POSITIVE_INFINITY,
                  );
                return sourceItem.sourceMarker.start > Math.max(lineStart, firstMarker);
              })(),
            },
          ]
        : [],
    ),
  ];
  const edits: TextEdit[] = [];
  const sourceLineHasContent = (lineIndex: number): boolean =>
    (sourceIR.blocks ?? []).some(
      (block) => block.kind === "thematic_break" && block.sourceStartLine === lineIndex,
    ) || Boolean(sourceContainerContent(sourceLines[lineIndex] ?? "").replace(/[ \t\r\n]/gu, ""));
  for (const boundary of boundaries) {
    const start = projectOffset(offsets, boundary.start);
    if (
      boundary.sourceStartLine !== undefined &&
      boundary.sourceStartLine > 0 &&
      !boundary.sameLineNested &&
      sourceLineHasContent(boundary.sourceStartLine - 1)
    ) {
      if (start > 0 && text[start - 1] !== "\n") {
        edits.push({ start, end: start, text: "\n" });
      } else if (text.slice(Math.max(0, start - 2), start) === "\n\n") {
        edits.push({ start: start - 1, end: start, text: "" });
      }
    }

    const end = projectOffset(offsets, boundary.end);
    if (
      boundary.sourceEndLine !== undefined &&
      boundary.sourceEndLine < sourceLines.length &&
      (boundary.sourceEndLine === 0 || sourceLineHasContent(boundary.sourceEndLine - 1)) &&
      sourceLineHasContent(boundary.sourceEndLine)
    ) {
      let newlineStart = end;
      while (newlineStart > 0 && text[newlineStart - 1] === "\n") {
        newlineStart -= 1;
      }
      let newlineEnd = end;
      while (newlineEnd < text.length && text[newlineEnd] === "\n") {
        newlineEnd += 1;
      }
      if (newlineEnd - newlineStart > 1) {
        edits.push({ start: newlineEnd - 1, end: newlineEnd, text: "" });
      }
    }
  }
  return edits;
}

function sourceContainerContent(line: string): string {
  let cursor = 0;
  while (cursor < line.length) {
    let marker = cursor;
    while (marker < line.length && marker - cursor < 3 && line[marker] === " ") {
      marker += 1;
    }
    if (line[marker] === ">") {
      cursor = marker + 1;
      if (line[cursor] === " " || line[cursor] === "\t") {
        cursor += 1;
      }
      continue;
    }
    const listMarker = /^(?:[-*+]|\d{1,9}[.)])(?:[ \t]+|$)/u.exec(line.slice(marker));
    if (listMarker) {
      cursor = marker + listMarker[0].length;
      continue;
    }
    break;
  }
  return line.slice(cursor);
}

function normalizeCodeBlock(
  text: string,
  origin: "fenced" | "indented" | undefined,
  trimTerminalNewline: boolean,
  ir: MarkdownIRWithBlockMetadata,
  sourceLines: string[],
  sourceLineStarts: number[],
  sourceStartLine: number | undefined,
  blockquoteDepth: number,
): string {
  const indent = origin === "indented" ? "\u00A0".repeat(4) : "";
  const normalized = text
    .split("\n")
    .map((line, index) => {
      if (line) {
        return indent + normalizeCodeBlockLeadingWhitespace(line);
      }
      if (origin !== "indented" || sourceStartLine === undefined) {
        return line;
      }
      const lineIndex = sourceStartLine + index;
      const rawLine = sourceLines[lineIndex] ?? "";
      const prefixLength = sourceContainerPrefixLength(
        rawLine,
        lineIndex,
        ir,
        sourceLineStarts,
        sourceLines,
        blockquoteDepth,
      );
      const sourceContent = rawLine.slice(prefixLength);
      return /^[ \t]+$/u.test(sourceContent)
        ? normalizeCodeBlockLeadingWhitespace(sourceContent)
        : line;
    })
    .join("\n");
  return trimTerminalNewline && normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
}
