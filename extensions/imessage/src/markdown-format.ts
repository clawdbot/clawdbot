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
type DunderProtection = { token: string; identifier: string };

function protectDunderIdentifiers(input: string): {
  markdown: string;
  protections: DunderProtection[];
} {
  const protections: DunderProtection[] = [];
  let markdown = "";
  let cursor = 0;
  for (const match of input.matchAll(/__[\p{L}_][\p{L}\p{N}_]*__/gu)) {
    const identifier = match[0];
    const start = match.index ?? 0;
    const end = start + identifier.length;
    const before = input[start - 1];
    const beforeBefore = input[start - 2];
    const after = input[end];
    const member = before === ".";
    const call = after === "(";
    const functionArgument = before === "(" && /[\p{L}\p{N}_]/u.test(beforeBefore ?? "");
    const index = after === "[";
    if (!member && !call && !functionArgument && !index) {
      continue;
    }
    let token = `OCdunder${protections.length}token`;
    while (input.includes(token)) {
      token += "x";
    }
    markdown += input.slice(cursor, start) + token;
    protections.push({ token, identifier });
    cursor = end;
  }
  return { markdown: markdown + input.slice(cursor), protections };
}

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

function restoreDunderIdentifiers(
  text: string,
  ranges: IMessageFormatRange[],
  codeRanges: Array<{ start: number; length: number }>,
  protections: DunderProtection[],
) {
  const edits = protections.flatMap((protection) => {
    const start = text.indexOf(protection.token);
    return start === -1
      ? []
      : [{ start, end: start + protection.token.length, text: protection.identifier }];
  });
  const edited = applyTextEdits(text, edits);
  const mapRange = <T extends { start: number; length: number }>(range: T): T => ({
    ...range,
    start: edited.mapOffset(range.start),
    length: edited.mapOffset(range.start + range.length) - edited.mapOffset(range.start),
  });
  return {
    text: edited.text,
    ranges: ranges.map(mapRange),
    codeRanges: codeRanges.map(mapRange),
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
  const protectedDunders = protectDunderIdentifiers(input);
  const ir = markdownToIR(protectedDunders.markdown, {
    autolink: false,
    enableHtmlUnderline: true,
    headingStyle: "rich",
    linkify: false,
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
  const dunders = restoreDunderIdentifiers(
    rendered.text,
    rendered.ranges.map(({ start, length, style }) => ({
      start,
      length,
      styles: [style],
    })),
    code.ranges,
    protectedDunders.protections,
  );
  return restoreCodeMarkers(dunders.text, dunders.ranges, dunders.codeRanges);
}
