import { MAX_HUMAN_MENTIONS } from "@openclaw/gateway-protocol";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { HumanMention } from "./chat-types.ts";

export { MAX_HUMAN_MENTIONS } from "@openclaw/gateway-protocol";

export type HumanMentionInput = {
  value: string;
  start: number;
  end: number;
  inputType: string;
};

/** Stored browser drafts are untrusted; never recover a recipient without its visible token. */
export function readHumanMentions(
  text: string,
  value: unknown,
): readonly HumanMention[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_HUMAN_MENTIONS) {
    return undefined;
  }
  const mentions: HumanMention[] = [];
  let previousEnd = 0;
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      typeof entry.profileId !== "string" ||
      !entry.profileId.trim() ||
      entry.profileId.length > 256 ||
      typeof entry.start !== "number" ||
      !Number.isSafeInteger(entry.start) ||
      typeof entry.end !== "number" ||
      !Number.isSafeInteger(entry.end) ||
      entry.start < previousEnd ||
      entry.end <= entry.start + 1 ||
      entry.end > text.length ||
      text[entry.start] !== "@" ||
      /[\p{L}\p{N}\p{M}_@.%+-]/u.test(text[entry.start - 1] ?? "") ||
      !text.slice(entry.start + 1, entry.end).trim()
    ) {
      return undefined;
    }
    for (let offset = entry.start; offset < entry.end; offset += 1) {
      if (text.charCodeAt(offset) < 32) {
        return undefined;
      }
    }
    mentions.push({ profileId: entry.profileId, start: entry.start, end: entry.end });
    previousEnd = entry.end;
  }
  return mentions;
}

/** A contiguous edit shifts later spans and invalidates every token it touches. */
export function updateHumanMentions(
  previous: string,
  next: string,
  mentions: readonly HumanMention[] = [],
  input?: HumanMentionInput,
): readonly HumanMention[] {
  if ((!input && previous === next) || mentions.length === 0) {
    return mentions;
  }
  let start = 0;
  while (start < previous.length && start < next.length && previous[start] === next[start]) {
    start += 1;
  }
  let suffix = 0;
  const sharedLength = Math.min(previous.length, next.length);
  while (
    suffix < sharedLength &&
    previous[previous.length - suffix - 1] === next[next.length - suffix - 1]
  ) {
    suffix += 1;
  }
  let previousEnd = previous.length - suffix;
  // Repeated labels make a text-only diff ambiguous. Invalidate the union of
  // possible edits unless beforeinput proves exactly which occurrence changed.
  if (start + suffix > sharedLength) {
    previousEnd = start + Math.max(0, previous.length - next.length);
    start = sharedLength - suffix;
  }
  if (input?.value === previous && !input.inputType.startsWith("history")) {
    const removed = previous.length - next.length;
    let inputStart = input.start;
    let inputEnd = input.end;
    if (inputStart === inputEnd && input.inputType.startsWith("delete") && removed > 0) {
      if (input.inputType.endsWith("Backward")) {
        inputStart -= removed;
      } else {
        inputEnd += removed;
      }
    }
    const inserted = next.length - previous.length + inputEnd - inputStart;
    if (
      inputStart >= 0 &&
      inserted >= 0 &&
      previous.slice(0, inputStart) === next.slice(0, inputStart) &&
      previous.slice(inputEnd) === next.slice(inputStart + inserted)
    ) {
      start = inputStart;
      previousEnd = inputEnd;
    }
  }
  const delta = next.length - previous.length;
  const shifted = mentions.flatMap((mention) => {
    if (mention.end <= start) {
      // Typing into the end of a selected label edits that label, not its identity.
      return mention.end === start && /[\p{L}\p{N}\p{M}_-]/u.test(next[start] ?? "")
        ? []
        : [mention];
    }
    if (mention.start >= previousEnd) {
      return [{ ...mention, start: mention.start + delta, end: mention.end + delta }];
    }
    return [];
  });
  return readHumanMentions(next, shifted) ?? [];
}

/** Text and UTF-16 spans must be normalized together at the submission boundary. */
export function trimHumanMentions(text: string, mentions: readonly HumanMention[] = []) {
  const trimmed = text.trim();
  const offset = text.length - text.trimStart().length;
  const shifted = mentions.map((mention) => ({
    ...mention,
    start: mention.start - offset,
    end: mention.end - offset,
  }));
  const normalized = readHumanMentions(trimmed, shifted);
  return { text: trimmed, ...(normalized ? { mentions: normalized } : {}) };
}
