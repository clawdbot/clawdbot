export type AssistantTranscriptRole = "assistant" | "developer" | "system" | "user";

export type AssistantTranscriptRoleHeaderKind =
  | "angle_role_header"
  | "role_timestamp_bracket"
  | "timestamp_role_colon";

export type AssistantTranscriptRoleHeaderSpan = {
  start: number;
  end: number;
  kind: AssistantTranscriptRoleHeaderKind;
  role: AssistantTranscriptRole;
};

type TextRange = {
  start: number;
  end: number;
};

const TRANSCRIPT_ROLES: readonly AssistantTranscriptRole[] = [
  "assistant",
  "developer",
  "system",
  "user",
];

function isHorizontalWhitespace(char: string | undefined): boolean {
  return char === " " || char === "\t";
}

function isLineTrailingWhitespace(char: string | undefined): boolean {
  return isHorizontalWhitespace(char) || char === "\r";
}

function skipHorizontalWhitespace(text: string, start: number, end: number): number {
  let cursor = start;
  while (cursor < end && isHorizontalWhitespace(text[cursor])) {
    cursor += 1;
  }
  return cursor;
}

function matchRoleAt(
  text: string,
  start: number,
  end: number,
): { role: AssistantTranscriptRole; end: number } | null {
  for (const role of TRANSCRIPT_ROLES) {
    const roleEnd = start + role.length;
    if (roleEnd <= end && text.slice(start, roleEnd).toLowerCase() === role) {
      return { role, end: roleEnd };
    }
  }
  return null;
}

function findDelimitedEnd(params: {
  text: string;
  contentStart: number;
  lineEnd: number;
  close: "]" | ">";
  minContentLength: number;
  maxContentLength: number;
}): number | null {
  const searchEnd = Math.min(params.lineEnd, params.contentStart + params.maxContentLength + 1);
  let closeAt = -1;
  for (let index = params.contentStart; index < searchEnd; index += 1) {
    const char = params.text[index];
    // Paired backticks are parsed as code and excluded earlier. An unmatched
    // delimiter leaves a header that target renderers cannot wrap consistently.
    if (char === "`") {
      return null;
    }
    if (char === params.close) {
      closeAt = index;
      break;
    }
  }
  if (closeAt === -1) {
    return null;
  }
  const contentLength = closeAt - params.contentStart;
  if (contentLength < params.minContentLength || contentLength > params.maxContentLength) {
    return null;
  }
  return closeAt + 1;
}

function isHeaderBoundary(char: string | undefined): boolean {
  return char === undefined || isLineTrailingWhitespace(char) || char === ":" || char === "：";
}

function matchRoleTimestampHeader(
  text: string,
  start: number,
  lineEnd: number,
): AssistantTranscriptRoleHeaderSpan | null {
  const role = matchRoleAt(text, start, lineEnd);
  if (!role) {
    return null;
  }
  const bracketStart = skipHorizontalWhitespace(text, role.end, lineEnd);
  if (text[bracketStart] !== "[") {
    return null;
  }
  const headerEnd = findDelimitedEnd({
    text,
    contentStart: bracketStart + 1,
    lineEnd,
    close: "]",
    minContentLength: 1,
    maxContentLength: 160,
  });
  if (!headerEnd || !isHeaderBoundary(text[headerEnd])) {
    return null;
  }
  return {
    start,
    end: headerEnd,
    kind: "role_timestamp_bracket",
    role: role.role,
  };
}

function matchTimestampRoleHeader(
  text: string,
  start: number,
  lineEnd: number,
): AssistantTranscriptRoleHeaderSpan | null {
  if (text[start] !== "[") {
    return null;
  }
  const bracketEnd = findDelimitedEnd({
    text,
    contentStart: start + 1,
    lineEnd,
    close: "]",
    minContentLength: 4,
    maxContentLength: 160,
  });
  if (!bracketEnd) {
    return null;
  }
  const roleStart = skipHorizontalWhitespace(text, bracketEnd, lineEnd);
  const role = matchRoleAt(text, roleStart, lineEnd);
  if (!role) {
    return null;
  }
  const colonAt = skipHorizontalWhitespace(text, role.end, lineEnd);
  if (text[colonAt] !== ":" && text[colonAt] !== "：") {
    return null;
  }
  return {
    start,
    end: colonAt + 1,
    kind: "timestamp_role_colon",
    role: role.role,
  };
}

function matchAngleRoleHeader(
  text: string,
  start: number,
  lineEnd: number,
): AssistantTranscriptRoleHeaderSpan | null {
  if (text[start] !== "<") {
    return null;
  }
  const roleStart = skipHorizontalWhitespace(text, start + 1, lineEnd);
  const role = matchRoleAt(text, roleStart, lineEnd);
  const roleBoundary = role ? text[role.end] : undefined;
  if (!role || (roleBoundary !== ">" && !isHorizontalWhitespace(roleBoundary))) {
    return null;
  }
  const headerEnd = findDelimitedEnd({
    text,
    contentStart: role.end,
    lineEnd,
    close: ">",
    minContentLength: 0,
    maxContentLength: 160,
  });
  if (!headerEnd || !isHeaderBoundary(text[headerEnd])) {
    return null;
  }
  return {
    start,
    end: headerEnd,
    kind: "angle_role_header",
    role: role.role,
  };
}

function rangesOverlap(left: TextRange, right: TextRange): boolean {
  return left.start < right.end && left.end > right.start;
}

/** Finds supported transcript-role headers in parser-visible text. */
export function findAssistantTranscriptRoleHeaderSpans(
  text: string,
  excludedRanges: readonly TextRange[] = [],
): AssistantTranscriptRoleHeaderSpan[] {
  const spans: AssistantTranscriptRoleHeaderSpan[] = [];
  const sortedExcludedRanges = [...excludedRanges].toSorted(
    (left, right) => left.start - right.start || left.end - right.end,
  );
  let excludedRangeIndex = 0;
  let lineStart = 0;
  while (lineStart < text.length) {
    const newlineAt = text.indexOf("\n", lineStart);
    const lineEnd = newlineAt === -1 ? text.length : newlineAt;
    const contentStart = skipHorizontalWhitespace(text, lineStart, lineEnd);
    const span =
      matchTimestampRoleHeader(text, contentStart, lineEnd) ??
      matchAngleRoleHeader(text, contentStart, lineEnd) ??
      matchRoleTimestampHeader(text, contentStart, lineEnd);
    if (span) {
      for (;;) {
        const excludedRange = sortedExcludedRanges[excludedRangeIndex];
        if (!excludedRange || excludedRange.end > span.start) {
          break;
        }
        excludedRangeIndex += 1;
      }
      const excludedRange = sortedExcludedRanges[excludedRangeIndex];
      if (!excludedRange || !rangesOverlap(span, excludedRange)) {
        spans.push(span);
      }
    }
    if (newlineAt === -1) {
      break;
    }
    lineStart = newlineAt + 1;
  }
  return spans;
}
