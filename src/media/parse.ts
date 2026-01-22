// Shared helpers for parsing MEDIA tokens from command/stdout text.

import { parseFenceSpans } from "../markdown/fences.js";
import { parseAudioTag } from "./audio-tags.js";

// Allow optional wrapping backticks and punctuation after the token; capture the core token.
export const MEDIA_TOKEN_RE = /\bMEDIA:\s*`?([^\n]+)`?/gi;

export function normalizeMediaSource(src: string) {
  return src.startsWith("file://") ? src.replace("file://", "") : src;
}

function cleanCandidate(raw: string) {
  return raw.replace(/^[`"'[{(]+/, "").replace(/[`"'\\})\],]+$/, "");
}

function isValidMedia(candidate: string, opts?: { allowSpaces?: boolean }) {
  if (!candidate) return false;
  if (candidate.length > 4096) return false;
  if (!opts?.allowSpaces && /\s/.test(candidate)) return false;
  if (/^https?:\/\//i.test(candidate)) return true;
  if (candidate.startsWith("/")) return true;
  if (candidate.startsWith("./")) return true;
  if (candidate.startsWith("../")) return true;
  if (candidate.startsWith("~")) return true;
  return false;
}

function unwrapQuoted(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.length < 2) return undefined;
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if (first !== last) return undefined;
  if (first !== `"` && first !== "'" && first !== "`") return undefined;
  return trimmed.slice(1, -1).trim();
}

// Check if a character offset is inside any fenced code block
function isInsideFence(fenceSpans: Array<{ start: number; end: number }>, offset: number): boolean {
  return fenceSpans.some((span) => offset >= span.start && offset < span.end);
}

export function splitMediaFromOutput(raw: string): {
  text: string;
  mediaUrls?: string[];
  mediaUrl?: string; // legacy first item for backward compatibility
  audioAsVoice?: boolean; // true if [[audio_as_voice]] tag was found
} {
  // KNOWN: Leading whitespace is semantically meaningful in Markdown (lists, indented fences).
  // We only trim the end; token cleanup below handles removing `MEDIA:` lines.
  const trimmedRaw = raw.trimEnd();
  if (!trimmedRaw.trim()) return { text: "" };

  const media: string[] = [];
  let foundMediaToken = false;

  // Parse fenced code blocks to avoid extracting MEDIA tokens from inside them
  const fenceSpans = parseFenceSpans(trimmedRaw);

  // Collect tokens line by line so we can strip them cleanly.
  const lines = trimmedRaw.split("\n");
  const keptLines: string[] = [];

  let lineOffset = 0; // Track character offset for fence checking
  for (const line of lines) {
    // Skip MEDIA extraction if this line is inside a fenced code block
    if (isInsideFence(fenceSpans, lineOffset)) {
      keptLines.push(line);
      lineOffset += line.length + 1; // +1 for newline
      continue;
    }

    const matches = Array.from(line.matchAll(MEDIA_TOKEN_RE));
    if (matches.length === 0) {
      keptLines.push(line);
      lineOffset += line.length + 1; // +1 for newline
      continue;
    }

    foundMediaToken = true;
    const pieces: string[] = [];
    let cursor = 0;
    let hasValidMedia = false;

    for (const match of matches) {
      const start = match.index ?? 0;
      pieces.push(line.slice(cursor, start));

      const payload = match[1];
      const unwrapped = unwrapQuoted(payload);
      const payloadValue = unwrapped ?? payload;
      const parts = unwrapped ? [unwrapped] : payload.split(/\s+/).filter(Boolean);
      const mediaStartIndex = media.length;
      let validCount = 0;
      const invalidParts: string[] = [];
      for (const part of parts) {
        const candidate = normalizeMediaSource(cleanCandidate(part));
        if (isValidMedia(candidate, unwrapped ? { allowSpaces: true } : undefined)) {
          media.push(candidate);
          hasValidMedia = true;
          validCount += 1;
        } else {
          invalidParts.push(part);
        }
      }

      const trimmedPayload = payloadValue.trim();
      const looksLikeLocalPath =
        trimmedPayload.startsWith("/") ||
        trimmedPayload.startsWith("./") ||
        trimmedPayload.startsWith("../") ||
        trimmedPayload.startsWith("~") ||
        trimmedPayload.startsWith("file://");
      if (
        !unwrapped &&
        validCount === 1 &&
        invalidParts.length > 0 &&
        /\s/.test(payloadValue) &&
        looksLikeLocalPath
      ) {
        const fallback = normalizeMediaSource(cleanCandidate(payloadValue));
        if (isValidMedia(fallback, { allowSpaces: true })) {
          media.splice(mediaStartIndex, media.length - mediaStartIndex, fallback);
          hasValidMedia = true;
          validCount = 1;
          invalidParts.length = 0;
        }
      }

      if (!hasValidMedia) {
        const fallback = normalizeMediaSource(cleanCandidate(payloadValue));
        if (isValidMedia(fallback, { allowSpaces: true })) {
          media.push(fallback);
          hasValidMedia = true;
          invalidParts.length = 0;
        }
      }

      if (hasValidMedia && invalidParts.length > 0) {
        pieces.push(invalidParts.join(" "));
      }

      cursor = start + match[0].length;
    }

    pieces.push(line.slice(cursor));

    const cleanedLine = pieces
      .join("")
      .replace(/[ \t]{2,}/g, " ")
      .trim();

    // If the line becomes empty, drop it.
    if (cleanedLine) {
      keptLines.push(cleanedLine);
    }
    lineOffset += line.length + 1; // +1 for newline
  }

  let cleanedText = keptLines
    .join("\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();

  // Detect and strip [[audio_as_voice]] tag
  const audioTagResult = parseAudioTag(cleanedText);
  const hasAudioAsVoice = audioTagResult.audioAsVoice;
  if (audioTagResult.hadTag) {
    cleanedText = audioTagResult.text.replace(/\n{2,}/g, "\n").trim();
  }

  if (media.length === 0) {
    const result: ReturnType<typeof splitMediaFromOutput> = {
      // Return cleaned text if we found a media token OR audio tag, otherwise original
      text: foundMediaToken || hasAudioAsVoice ? cleanedText : trimmedRaw,
    };
    if (hasAudioAsVoice) result.audioAsVoice = true;
    return result;
  }

  return {
    text: cleanedText,
    mediaUrls: media,
    mediaUrl: media[0],
    ...(hasAudioAsVoice ? { audioAsVoice: true } : {}),
  };
}
