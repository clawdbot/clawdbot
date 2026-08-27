import {
  FormatCapabilityProfile,
  markdownToIR,
  renderMarkdownWithAttributedRanges,
} from "openclaw/plugin-sdk/text-chunking";

type IMessageFormatStyle = "bold" | "italic" | "underline" | "strikethrough";

type IMessageFormatRange = {
  start: number;
  length: number;
  styles: IMessageFormatStyle[];
};

const IMESSAGE_FORMAT_PROFILE = FormatCapabilityProfile.define({
  mechanism: "ranges",
  constructs: {
    spoiler: "strip",
    codeInline: "fallback",
    codeBlock: "fallback",
    codeLanguage: "strip",
    linkLabel: "fallback",
    heading: "fallback",
    bulletList: "fallback",
    orderedList: "fallback",
    taskList: "fallback",
    table: "fallback",
    blockquote: "fallback",
    image: "fallback",
    mention: "strip",
  },
  chunk: { limit: 4_000, unit: "utf16" },
});

const IMESSAGE_CODE_PROFILE = FormatCapabilityProfile.define({
  ...IMESSAGE_FORMAT_PROFILE,
  constructs: { ...IMESSAGE_FORMAT_PROFILE.constructs, codeInline: "native" },
});

const IMESSAGE_STYLE_MAP = {
  bold: "bold",
  italic: "italic",
  underline: "underline",
  strikethrough: "strikethrough",
} as const;

function codeDelimiter(content: string): string {
  const longestRun = Math.max(0, ...[...content.matchAll(/`+/gu)].map((match) => match[0].length));
  return "`".repeat(longestRun + 1);
}

type TextEdit = { start: number; end: number; text: string };

function applyTextEdits(text: string, edits: TextEdit[]) {
  const ordered = edits.toSorted((left, right) => left.start - right.start);
  let rendered = "";
  let cursor = 0;
  for (const edit of ordered) {
    rendered += text.slice(cursor, edit.start) + edit.text;
    cursor = edit.end;
  }
  rendered += text.slice(cursor);
  return {
    text: rendered,
    mapOffset: (offset: number) =>
      offset +
      ordered.reduce(
        (delta, edit) =>
          delta + (edit.end <= offset ? edit.text.length - edit.end + edit.start : 0),
        0,
      ),
  };
}

function restoreCodeMarkers(
  text: string,
  ranges: Array<{ start: number; length: number; styles: IMessageFormatStyle[] }>,
  codeRanges: Array<{ start: number; length: number }>,
): { text: string; ranges: IMessageFormatRange[] } {
  const edits = codeRanges.map((range) => {
    const end = range.start + range.length;
    const content = text.slice(range.start, end);
    const marker = codeDelimiter(content);
    const padding = content.startsWith("`") || content.endsWith("`") ? " " : "";
    return { start: range.start, end, text: `${marker}${padding}${content}${padding}${marker}` };
  });
  const edited = applyTextEdits(text, edits);
  return {
    text: edited.text,
    ranges: ranges.map((range) => ({
      ...range,
      start: edited.mapOffset(range.start),
      length: edited.mapOffset(range.start + range.length) - edited.mapOffset(range.start),
    })),
  };
}

export function extractMarkdownFormatRuns(input: string): {
  text: string;
  ranges: IMessageFormatRange[];
} {
  const ir = markdownToIR(input, {
    autolink: false,
    enableHtmlUnderline: true,
    headingStyle: "rich",
    linkify: false,
    preserveDunderIdentifiers: true,
    preserveSourceBlockSpacing: true,
  });
  const rendered = renderMarkdownWithAttributedRanges(
    ir,
    { styleMap: IMESSAGE_STYLE_MAP },
    IMESSAGE_FORMAT_PROFILE,
  );
  const code = renderMarkdownWithAttributedRanges(
    ir,
    { styleMap: { code: "code" } },
    IMESSAGE_CODE_PROFILE,
  );
  return restoreCodeMarkers(
    rendered.text,
    rendered.ranges.map(({ start, length, style }) => ({
      start,
      length,
      styles: [style],
    })),
    code.ranges,
  );
}
