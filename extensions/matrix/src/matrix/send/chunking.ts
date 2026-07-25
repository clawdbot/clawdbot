// Matrix helper module prepares and chunks outbound formatted text.
import type { MarkdownTableMode } from "openclaw/plugin-sdk/markdown-table-runtime";
import { requireRuntimeConfig } from "openclaw/plugin-sdk/plugin-config-runtime";
import { findCodeRegions, isInsideCode, tokenizeHtmlTags } from "openclaw/plugin-sdk/text-chunking";
import { getMatrixRuntime } from "../../runtime.js";
import type { CoreConfig } from "../../types.js";
import {
  createMatrixPrivateMarkers,
  isMarkdownEscaped,
  type MatrixSpoilerMarkers,
  type MatrixSpoilerProtection,
} from "../format-profile.js";
import {
  findMatrixMarkdownMetadataRanges,
  hasMatrixSpoilerMetadataCollision,
} from "../format-spoiler-ranges.js";
import { findMatrixTableSourceRanges } from "../format-table-ranges.js";
import {
  markdownToMatrixBody,
  MATRIX_FORMAT_PROFILE,
  protectMatrixSpoilerDelimiters,
  renderMatrixMarkdownTables,
} from "../format.js";

type MatrixPreparedSingleText = {
  trimmedText: string;
  convertedText: string;
  singleEventLimit: number;
  eventTextLength: number;
  fitsInSingleEvent: boolean;
  tableMode: MarkdownTableMode;
};

type MatrixPreparedChunkedText = MatrixPreparedSingleText & {
  chunks: string[];
};

const getCore = () => getMatrixRuntime();

function protectMatrixUnderlineTags(markdown: string): MatrixSpoilerProtection {
  const codeRegions = findCodeRegions(markdown);
  const metadataRanges = findMatrixMarkdownMetadataRanges(markdown);
  const tags = [...tokenizeHtmlTags(markdown)].filter(
    (tag) =>
      (tag.name === "u" || tag.name === "ins") &&
      !tag.selfClosing &&
      !isInsideCode(tag.start, codeRegions) &&
      !isMarkdownEscaped(markdown, tag.start) &&
      !metadataRanges.some((range) => tag.start >= range.start && tag.start < range.end),
  );
  if (tags.length === 0) {
    return { markdown };
  }
  const markers = createMatrixPrivateMarkers(
    markdown,
    "Matrix underline chunking exhausted its private marker pool",
  );
  let depth = 0;
  const replacements = tags.flatMap((tag) => {
    if (!tag.closing) {
      depth += 1;
      return [{ tag, marker: depth === 1 ? markers.open : "" }];
    }
    if (depth === 0) {
      return [];
    }
    depth -= 1;
    return [{ tag, marker: depth === 0 ? markers.close : "" }];
  });
  let protectedMarkdown = markdown;
  for (const { tag, marker } of replacements.toReversed()) {
    protectedMarkdown = `${protectedMarkdown.slice(0, tag.start)}${marker}${markers.padding.repeat(tag.raw.length - marker.length)}${protectedMarkdown.slice(tag.end)}`;
  }
  return { markdown: protectedMarkdown, markers };
}

type MatrixChunkStyle = "spoiler" | "underline";

function restoreMatrixStyleChunks(
  chunks: string[],
  spoiler: MatrixSpoilerMarkers | undefined,
  underline: MatrixSpoilerMarkers | undefined,
): string[] {
  const stack: MatrixChunkStyle[] = [];
  const syntax = {
    spoiler: { open: "||", close: "||", markers: spoiler },
    underline: { open: "<u>", close: "</u>", markers: underline },
  } as const;
  return chunks.map((chunk) => {
    let restored = stack.map((style) => syntax[style].open).join("");
    for (const character of chunk) {
      const opening = (Object.keys(syntax) as MatrixChunkStyle[]).find(
        (style) => character === syntax[style].markers?.open,
      );
      const closing = (Object.keys(syntax) as MatrixChunkStyle[]).find(
        (style) => character === syntax[style].markers?.close,
      );
      if (opening) {
        stack.push(opening);
        restored += syntax[opening].open;
      } else if (closing) {
        const stackIndex = stack.lastIndexOf(closing);
        if (stackIndex >= 0) {
          const above = stack.slice(stackIndex + 1);
          restored += above
            .toReversed()
            .map((style) => syntax[style].close)
            .join("");
          restored += syntax[closing].close;
          stack.splice(stackIndex, 1);
          restored += above.map((style) => syntax[style].open).join("");
        }
      } else if (character !== spoiler?.padding && character !== underline?.padding) {
        restored += character;
      }
    }
    return (
      restored +
      stack
        .toReversed()
        .map((style) => syntax[style].close)
        .join("")
    );
  });
}

function splitMatrixTableSegments(markdown: string): Array<{ table: boolean; text: string }> {
  const segments: Array<{ table: boolean; text: string }> = [];
  let cursor = 0;
  for (const range of findMatrixTableSourceRanges(markdown)) {
    const plain = markdown.slice(cursor, range.start).replace(/(?:[ \t]*\n)+$/u, "");
    if (plain.trim()) {
      segments.push({ table: false, text: plain });
    }
    const rawTable = markdown.slice(range.start, range.end).trimEnd();
    const indent = /^ +/u.exec(rawTable)?.[0] ?? "";
    const table = indent
      ? rawTable
          .split("\n")
          .map((line) => (line.startsWith(indent) ? line.slice(indent.length) : line))
          .join("\n")
      : rawTable;
    segments.push({ table: true, text: table });
    cursor = range.end;
  }
  const tail = markdown.slice(cursor).replace(/^(?:[ \t]*\n)+/u, "");
  if (tail.trim()) {
    segments.push({ table: false, text: tail });
  }
  return segments;
}

export function prepareMatrixSingleText(
  text: string,
  opts: {
    cfg: CoreConfig;
    accountId?: string;
    tableMode?: MarkdownTableMode;
    preserveWhitespace?: boolean;
  },
): MatrixPreparedSingleText {
  const normalizedText = text.replace(/\r\n?/gu, "\n");
  const trimmedText = opts.preserveWhitespace ? normalizedText : normalizedText.trim();
  const cfg = requireRuntimeConfig(opts.cfg, "Matrix text preparation") as CoreConfig;
  const tableMode =
    opts.tableMode ??
    getCore().channel.text.resolveMarkdownTableMode({
      cfg,
      channel: "matrix",
      accountId: opts.accountId,
      supportsBlockTables: MATRIX_FORMAT_PROFILE.constructs.table === "native",
    });
  const singleEventLimit = Math.min(
    getCore().channel.text.resolveTextChunkLimit(cfg, "matrix", opts.accountId),
    MATRIX_FORMAT_PROFILE.chunk.limit,
  );
  const convertedText = renderMatrixMarkdownTables(trimmedText, tableMode);
  const eventTextLength = Math.max(
    convertedText.length,
    markdownToMatrixBody(convertedText).length,
  );
  return {
    trimmedText,
    convertedText,
    singleEventLimit,
    eventTextLength,
    fitsInSingleEvent: eventTextLength <= singleEventLimit,
    tableMode,
  };
}

export function chunkMatrixText(
  text: string,
  opts: {
    cfg: CoreConfig;
    accountId?: string;
    tableMode?: MarkdownTableMode;
    preserveWhitespace?: boolean;
  },
): MatrixPreparedChunkedText {
  const preparedText = prepareMatrixSingleText(text, opts);
  if (preparedText.fitsInSingleEvent) {
    return {
      ...preparedText,
      chunks: preparedText.convertedText ? [preparedText.convertedText] : [],
    };
  }
  const cfg = requireRuntimeConfig(opts.cfg, "Matrix text chunking") as CoreConfig;
  const chunkMode = getCore().channel.text.resolveChunkMode(cfg, "matrix", opts.accountId);
  const collisionRedacted = hasMatrixSpoilerMetadataCollision(preparedText.convertedText)
    ? markdownToMatrixBody(preparedText.convertedText)
    : undefined;
  const chunkSegment = (segmentText: string): string[] => {
    const sourceText = hasMatrixSpoilerMetadataCollision(segmentText)
      ? markdownToMatrixBody(segmentText)
      : segmentText;
    const protectedUnderline = protectMatrixUnderlineTags(sourceText);
    const protectedSpoilers = protectMatrixSpoilerDelimiters(protectedUnderline.markdown);
    const wrapperReserve =
      (protectedSpoilers.markers ? 4 : 0) + (protectedUnderline.markers ? 7 : 0);
    const privateMarkers = [protectedSpoilers.markers, protectedUnderline.markers].flatMap(
      (markers) => (markers ? [markers.open, markers.close, markers.padding] : []),
    );
    let reserve = wrapperReserve;
    while (reserve < preparedText.singleEventLimit) {
      const protectedChunks = getCore().channel.text.chunkMarkdownTextWithMode(
        protectedSpoilers.markdown,
        preparedText.singleEventLimit - reserve,
        chunkMode,
      );
      const restored = restoreMatrixStyleChunks(
        protectedChunks,
        protectedSpoilers.markers,
        protectedUnderline.markers,
      ).filter((_, index) => {
        const source = privateMarkers.reduce(
          (value, marker) => value.replaceAll(marker, ""),
          protectedChunks[index] ?? "",
        );
        return source.length > 0;
      });
      const overflow = Math.max(
        0,
        ...restored.map(
          (chunk) =>
            Math.max(chunk.length, markdownToMatrixBody(chunk).length) -
            preparedText.singleEventLimit,
        ),
      );
      if (overflow === 0) {
        return restored;
      }
      reserve += overflow;
    }
    throw new Error("Matrix text chunk limit is too small for formatted content");
  };
  const chunks =
    collisionRedacted !== undefined
      ? chunkSegment(collisionRedacted)
      : preparedText.tableMode === "block"
        ? splitMatrixTableSegments(preparedText.convertedText).flatMap((segment) => {
            if (!segment.table) {
              return chunkSegment(segment.text);
            }
            return segment.text.length <= preparedText.singleEventLimit
              ? [segment.text]
              : chunkSegment(renderMatrixMarkdownTables(segment.text, "bullets"));
          })
        : chunkSegment(preparedText.convertedText);
  return {
    ...preparedText,
    chunks,
  };
}
