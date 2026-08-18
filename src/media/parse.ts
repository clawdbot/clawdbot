// Media parse helpers normalize media references from user and channel input.
import { hasHttpUrlPrefix } from "@openclaw/net-policy/url-protocol";
import { expectDefined } from "@openclaw/normalization-core";
import { parseFenceSpans } from "../../packages/markdown-core/src/fences.js";
import { parseAudioTag } from "./audio-tags.js";
import {
  cleanCandidate,
  FILE_URL_PREFIX_RE,
  isValidMedia,
  looksLikeLocalFilePath,
  normalizeMediaSource,
  unwrapQuoted,
  MEDIA_TOKEN_RE,
  lineHasAcceptableMediaDirective,
  resolveMediaDirectivePayload,
} from "./media-directive-validation.js";

/** Ordered output segment emitted after visible text and extracted media are separated. */
type ParsedMediaOutputSegment =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "media";
      url: string;
    };

/** Controls which non-MEDIA syntaxes may be lifted into media attachments. */
type SplitMediaFromOutputOptions = {
  extractAudioDirectives?: boolean;
  extractMarkdownImages?: boolean;
  extractMediaDirectives?: boolean;
  /**
   * Invoked when a `MEDIA:` token is skipped because it sits inside a fenced
   * code block (see #41966). Callers running in a Node context can pass a
   * logger here to surface the otherwise-silent skip. Left undefined by
   * default so this module stays free of Node-only logger imports and remains
   * safe to bundle into the browser UI.
   */
  onFencedMediaTokenSkipped?: (line: string) => void;
};
function mayContainFenceMarkers(input: string): boolean {
  return input.includes("```") || input.includes("~~~");
}

function cleanLineText(text: string): string {
  return text.replace(/[ \t]{2,}/g, " ").trim();
}

type MarkdownImageMatch = {
  start: number;
  end: number;
  destination: string;
};

const MAX_MARKDOWN_IMAGE_LINE_LENGTH = 20_000;
const MAX_MARKDOWN_IMAGE_ATTEMPTS_PER_LINE = 80;
const MAX_MARKDOWN_IMAGE_MATCHES_PER_LINE = 50;

function findMatchingBracket(
  input: string,
  start: number,
  open: string,
  close: string,
): number | undefined {
  let depth = 1;
  for (let i = start; i < input.length; i += 1) {
    const ch = input[i];
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === open) {
      depth += 1;
      continue;
    }
    if (ch !== close) {
      continue;
    }
    depth -= 1;
    if (depth === 0) {
      return i;
    }
  }
  return undefined;
}

function isRemoteMarkdownImageMedia(candidate: string): boolean {
  return hasHttpUrlPrefix(candidate) && isValidMedia(candidate);
}

function parseMarkdownTitle(input: string, start: number): number | undefined {
  let index = start;
  while (index < input.length && /\s/.test(input[index] ?? "")) {
    index += 1;
  }
  const opener = input[index];
  if (!opener) {
    return undefined;
  }
  const closer = opener === '"' || opener === "'" ? opener : opener === "(" ? ")" : null;
  if (!closer) {
    return undefined;
  }
  const closingIndex =
    opener === "("
      ? findMatchingBracket(input, index + 1, "(", ")")
      : (() => {
          for (let i = index + 1; i < input.length; i += 1) {
            const ch = input[i];
            if (ch === "\\") {
              i += 1;
              continue;
            }
            if (ch === closer) {
              return i;
            }
          }
          return undefined;
        })();
  if (closingIndex == null) {
    return undefined;
  }
  let tailIndex = closingIndex + 1;
  while (tailIndex < input.length && /\s/.test(input[tailIndex] ?? "")) {
    tailIndex += 1;
  }
  return input[tailIndex] === ")" ? tailIndex + 1 : undefined;
}

function parseMarkdownImageDestination(
  input: string,
  start: number,
): { destination: string; end: number } | undefined {
  let index = start;
  while (index < input.length && /\s/.test(input[index] ?? "")) {
    index += 1;
  }
  if (index >= input.length) {
    return undefined;
  }

  if (input[index] === "<") {
    let closing = index + 1;
    while (closing < input.length) {
      const ch = input[closing];
      if (ch === "\\") {
        closing += 2;
        continue;
      }
      if (ch === ">") {
        const destination = input.slice(index + 1, closing).trim();
        if (!destination) {
          return undefined;
        }
        let tailIndex = closing + 1;
        while (tailIndex < input.length && /\s/.test(input[tailIndex] ?? "")) {
          tailIndex += 1;
        }
        if (input[tailIndex] === ")") {
          return { destination, end: tailIndex + 1 };
        }
        const titledEnd = parseMarkdownTitle(input, tailIndex);
        return titledEnd ? { destination, end: titledEnd } : undefined;
      }
      closing += 1;
    }
    return undefined;
  }

  const destinationStart = index;
  let destinationEnd = index;
  let parenDepth = 0;
  while (index < input.length) {
    const ch = input.charAt(index);
    if (ch === "\\") {
      index += 2;
      destinationEnd = index;
      continue;
    }
    if (ch === "(") {
      parenDepth += 1;
      index += 1;
      destinationEnd = index;
      continue;
    }
    if (ch === ")") {
      if (parenDepth === 0) {
        const destination = input.slice(destinationStart, destinationEnd).trim();
        return destination ? { destination, end: index + 1 } : undefined;
      }
      parenDepth -= 1;
      index += 1;
      destinationEnd = index;
      continue;
    }
    if (/\s/.test(ch) && parenDepth === 0) {
      const destination = input.slice(destinationStart, destinationEnd).trim();
      if (!destination) {
        return undefined;
      }
      const titledEnd = parseMarkdownTitle(input, index);
      return titledEnd ? { destination, end: titledEnd } : undefined;
    }
    index += 1;
    destinationEnd = index;
  }
  return undefined;
}

function findMarkdownImageMatches(line: string): MarkdownImageMatch[] {
  if (line.length > MAX_MARKDOWN_IMAGE_LINE_LENGTH) {
    return [];
  }
  const matches: MarkdownImageMatch[] = [];
  let searchIndex = 0;
  let attempts = 0;
  while (
    matches.length < MAX_MARKDOWN_IMAGE_MATCHES_PER_LINE &&
    attempts < MAX_MARKDOWN_IMAGE_ATTEMPTS_PER_LINE
  ) {
    const index = line.indexOf("![", searchIndex);
    if (index < 0) {
      break;
    }
    attempts += 1;
    const altEnd = findMatchingBracket(line, index + 2, "[", "]");
    if (altEnd == null || line[altEnd + 1] !== "(") {
      searchIndex = index + 2;
      continue;
    }
    const parsed = parseMarkdownImageDestination(line, altEnd + 2);
    if (!parsed) {
      searchIndex = index + 2;
      continue;
    }
    matches.push({
      start: index,
      end: parsed.end,
      destination: parsed.destination,
    });
    searchIndex = parsed.end;
  }
  return matches;
}

function collectMarkdownImageSegments(params: { line: string; media: string[] }): {
  cleanedLine?: string;
  lineSegments: ParsedMediaOutputSegment[];
  foundMedia: boolean;
} {
  const matches = findMarkdownImageMatches(params.line);
  if (matches.length === 0) {
    return { lineSegments: [], foundMedia: false };
  }

  const segmentPieces: string[] = [];
  const visiblePieces: string[] = [];
  const lineSegments: ParsedMediaOutputSegment[] = [];
  let cursor = 0;
  let foundMedia = false;

  for (const match of matches) {
    const before = params.line.slice(cursor, match.start);
    segmentPieces.push(before);
    visiblePieces.push(before);

    const target = normalizeMediaSource(
      cleanCandidate(unwrapQuoted(match.destination) ?? match.destination),
    );
    if (isRemoteMarkdownImageMedia(target)) {
      const beforeText = cleanLineText(segmentPieces.join(""));
      if (beforeText) {
        lineSegments.push({ type: "text", text: beforeText });
      }
      segmentPieces.length = 0;
      params.media.push(target);
      lineSegments.push({ type: "media", url: target });
      foundMedia = true;
    } else {
      const original = params.line.slice(match.start, match.end);
      segmentPieces.push(original);
      visiblePieces.push(original);
    }

    cursor = match.end;
  }

  const after = params.line.slice(cursor);
  segmentPieces.push(after);
  visiblePieces.push(after);
  const trailingText = cleanLineText(segmentPieces.join(""));
  if (trailingText) {
    lineSegments.push({ type: "text", text: trailingText });
  }
  const cleanedLine = cleanLineText(visiblePieces.join(""));

  return {
    cleanedLine: cleanedLine || undefined,
    lineSegments,
    foundMedia,
  };
}

/** Splits tool/stdout text into visible text, media attachments, voice tags, and ordered segments. */

export function splitMediaFromOutput(
  raw: string,
  options: SplitMediaFromOutputOptions = {},
): {
  text: string;
  mediaUrls?: string[];
  audioAsVoice?: boolean; // true if [[audio_as_voice]] tag was found
  segments?: ParsedMediaOutputSegment[];
} {
  // KNOWN: Leading whitespace is semantically meaningful in Markdown (lists, indented fences).
  // We only trim the end; token cleanup below handles removing `MEDIA:` lines.
  const trimmedRaw = raw.trimEnd();
  if (!trimmedRaw.trim()) {
    return { text: "" };
  }
  const extractMarkdownImages = options.extractMarkdownImages === true;
  const extractMediaDirectives = options.extractMediaDirectives !== false;
  const onFencedMediaTokenSkipped = options.onFencedMediaTokenSkipped;
  const mayContainMediaToken = extractMediaDirectives && /media:/i.test(trimmedRaw);
  const mayContainMarkdownImage = extractMarkdownImages && /!\[[^\]]*]\(/.test(trimmedRaw);
  const mayContainAudioTag = trimmedRaw.includes("[[");
  if (!mayContainMediaToken && !mayContainMarkdownImage && !mayContainAudioTag) {
    return { text: trimmedRaw };
  }

  const media: string[] = [];
  let foundMediaToken = false;
  const segments: ParsedMediaOutputSegment[] = [];
  let lastTextSegment: Extract<ParsedMediaOutputSegment, { type: "text" }> | undefined;

  const pushTextSegment = (text: string) => {
    const last = segments[segments.length - 1];
    if (last?.type === "text") {
      last.text = `${last.text}\n${text.trim() ? text : ""}`;
    } else if (!text.trim()) {
      if (last?.type === "media" && lastTextSegment && !lastTextSegment.text.endsWith("\n")) {
        lastTextSegment.text += "\n";
      }
    } else {
      lastTextSegment = { type: "text", text };
      segments.push(lastTextSegment);
    }
  };

  // Parse fenced code blocks to avoid extracting MEDIA tokens from inside them
  const hasFenceMarkers = mayContainFenceMarkers(trimmedRaw);
  const fenceSpans = hasFenceMarkers ? parseFenceSpans(trimmedRaw) : [];

  // Line-wise parsing preserves visible text while letting MEDIA-only lines disappear cleanly.
  const lines = trimmedRaw.split("\n");
  const keptLines: string[] = [];

  let lineOffset = 0; // Track character offset for fence checking
  for (const line of lines) {
    // Fenced examples must remain text; extracting their MEDIA tokens would mutate transcripts.
    if (fenceSpans.some((span) => lineOffset >= span.start && lineOffset < span.end)) {
      // Notify the caller so the silent-failure mode is at least observable
      // (fixes #41966 — MEDIA tokens in code fences are otherwise silently ignored).
      // Only signal when media-directive extraction is enabled. Callers that keep
      // this function active for other features (e.g. markdown images) with
      // extractMediaDirectives: false must not create a warning path (#41966).
      if (
        extractMediaDirectives &&
        onFencedMediaTokenSkipped &&
        lineHasAcceptableMediaDirective(line)
      ) {
        onFencedMediaTokenSkipped(line);
      }
      keptLines.push(line);
      pushTextSegment(line);
      lineOffset += line.length + 1; // +1 for newline
      continue;
    }

    const trimmedStart = line.trimStart();
    if (!extractMediaDirectives || !trimmedStart.toUpperCase().startsWith("MEDIA:")) {
      const markdownImageResult = extractMarkdownImages
        ? collectMarkdownImageSegments({ line, media })
        : { lineSegments: [], foundMedia: false };
      if (!markdownImageResult.foundMedia) {
        keptLines.push(line);
        pushTextSegment(line);
      } else {
        foundMediaToken = true;
        if (markdownImageResult.cleanedLine) {
          keptLines.push(markdownImageResult.cleanedLine);
        }
        for (const segment of markdownImageResult.lineSegments) {
          if (segment.type === "text") {
            pushTextSegment(segment.text);
            continue;
          }
          segments.push(segment);
        }
      }
      lineOffset += line.length + 1; // +1 for newline
      continue;
    }

    const matches = Array.from(line.matchAll(MEDIA_TOKEN_RE));
    if (matches.length === 0) {
      keptLines.push(line);
      pushTextSegment(line);
      lineOffset += line.length + 1; // +1 for newline
      continue;
    }

    const pieces: string[] = [];
    const lineSegments: ParsedMediaOutputSegment[] = [];
    let cursor = 0;

    for (const match of matches) {
      const start = match.index ?? 0;
      pieces.push(line.slice(cursor, start));

      const payload = expectDefined(match[1], "parse regex capture 1");
      const mediaStartIndex = media.length;
      const resolved = resolveMediaDirectivePayload(payload);
      let hasValidMedia = false;
      const invalidParts: string[] = [];
      if (resolved) {
        media.push(...resolved.media);
        hasValidMedia = true;
        foundMediaToken = true;
        invalidParts.push(...resolved.invalidParts);
      }
      const unwrappedPayload = unwrapQuoted(payload);
      const trimmedPayload = (unwrappedPayload ?? payload).trim();
      const looksLikeLocalPath = resolved
        ? resolved.looksLikeLocalPath
        : looksLikeLocalFilePath(trimmedPayload) || FILE_URL_PREFIX_RE.test(trimmedPayload);

      if (hasValidMedia) {
        const beforeText = cleanLineText(pieces.join(""));
        if (beforeText) {
          lineSegments.push({ type: "text", text: beforeText });
        }
        pieces.length = 0;
        for (const url of media.slice(mediaStartIndex)) {
          lineSegments.push({ type: "media", url });
        }
        if (invalidParts.length > 0) {
          pieces.push(invalidParts.join(" "));
        }
      } else if (looksLikeLocalPath) {
        // Strip MEDIA: lines with local paths even when invalid (e.g. absolute paths
        // from internal tools like TTS). They should never leak as visible text.
        foundMediaToken = true;
      } else {
        // If no valid media was found in this match, keep the original token text.
        pieces.push(match[0]);
      }

      cursor = start + match[0].length;
    }

    pieces.push(line.slice(cursor));

    const cleanedLine = cleanLineText(pieces.join(""));

    // If the line becomes empty, drop it.
    if (cleanedLine) {
      keptLines.push(cleanedLine);
      lineSegments.push({ type: "text", text: cleanedLine });
    }
    for (const segment of lineSegments) {
      if (segment.type === "text") {
        pushTextSegment(segment.text);
        continue;
      }
      segments.push(segment);
    }
    lineOffset += line.length + 1; // +1 for newline
  }

  const visibleText = keptLines.join("\n").replace(/^(?:[ \t]*\n)+/, "");
  const audioTagResult =
    options.extractAudioDirectives === false
      ? { text: visibleText, audioAsVoice: false }
      : parseAudioTag(visibleText);
  const cleanedText = audioTagResult.text.trimEnd();
  const hasAudioAsVoice = audioTagResult.audioAsVoice;

  if (media.length === 0) {
    const parsedText = foundMediaToken || hasAudioAsVoice ? cleanedText : trimmedRaw;
    const result: ReturnType<typeof splitMediaFromOutput> = {
      text: parsedText,
      segments: parsedText ? [{ type: "text", text: parsedText }] : [],
    };
    if (hasAudioAsVoice) {
      result.audioAsVoice = true;
    }
    return result;
  }

  return {
    text: cleanedText,
    mediaUrls: media,
    segments: segments.length > 0 ? segments : [{ type: "text", text: cleanedText }],
    ...(hasAudioAsVoice ? { audioAsVoice: true } : {}),
  };
}
