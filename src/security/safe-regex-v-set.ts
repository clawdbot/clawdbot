import { expectDefined } from "@openclaw/normalization-core";
import { readEscapedLiteral } from "./safe-regex-atom-overlap.js";

const MAX_V_SET_SOURCE_LENGTH = 4096;
const MAX_V_SET_MEMBERS = 64;
const MAX_V_SET_RESIDUALS = 4096;

type QStringSpan = {
  end: number;
  members: string[];
  start: number;
};

function decodeVStringMember(source: string): string | null {
  let decoded = "";
  for (let index = 0; index < source.length;) {
    if (source[index] === "\\") {
      const escaped = readEscapedLiteral(source, index);
      if (!escaped) {
        return null;
      }
      decoded += escaped.value;
      index = escaped.next;
      continue;
    }
    const value = String.fromCodePoint(
      expectDefined(source.codePointAt(index), "UnicodeSets string code point"),
    );
    decoded += value;
    index += value.length;
  }
  return decoded || null;
}

function readQStringSpan(source: string, start: number): QStringSpan | null {
  const members: string[] = [];
  let memberStart = start + 3;
  for (let index = memberStart; index < source.length; index += 1) {
    if (source[index] === "\\") {
      const escaped = readEscapedLiteral(source, index);
      if (!escaped) {
        return null;
      }
      index = escaped.next - 1;
      continue;
    }
    if (source[index] !== "|" && source[index] !== "}") {
      continue;
    }
    const member = decodeVStringMember(source.slice(memberStart, index));
    if (!member) {
      return null;
    }
    members.push(member);
    if (source[index] === "}") {
      return { end: index + 1, members, start };
    }
    memberStart = index + 1;
  }
  return null;
}

function collectVSetMembers(source: string): string[] | null {
  if (
    source.length > MAX_V_SET_SOURCE_LENGTH ||
    !source.startsWith("[") ||
    !source.endsWith("]") ||
    source.startsWith("[^")
  ) {
    return null;
  }

  const spans: QStringSpan[] = [];
  for (let index = source.indexOf("\\q{"); index >= 0; index = source.indexOf("\\q{", index)) {
    const span = readQStringSpan(source, index);
    if (!span) {
      return null;
    }
    spans.push(span);
    index = span.end;
  }
  if (spans.length === 0) {
    return [];
  }

  const members = spans.flatMap((span) => span.members);
  let spanIndex = 0;
  for (let index = 1; index < source.length - 1;) {
    const span = spans[spanIndex];
    if (span && index === span.start) {
      index = span.end;
      spanIndex += 1;
      continue;
    }
    if (source[index] === "\\") {
      const escaped = readEscapedLiteral(source, index);
      if (!escaped) {
        return null;
      }
      members.push(escaped.value);
      index = escaped.next;
      continue;
    }
    const value = String.fromCodePoint(
      expectDefined(source.codePointAt(index), "UnicodeSets character code point"),
    );
    // Nested sets, ranges, intersections, and subtractions need full set
    // evaluation. A string-valued class using them therefore fails closed.
    if (value === "[" || value === "]" || value === "&" || value === "-") {
      return null;
    }
    members.push(value);
    index += value.length;
  }
  return members;
}

function addResidual(target: Set<string>, residual: string): boolean {
  if (!residual) {
    return true;
  }
  target.add(residual);
  return target.size > MAX_V_SET_RESIDUALS;
}

function isUniquelyDecodable(members: string[]): boolean {
  const words = [...new Set(members)];
  if (
    words.length > MAX_V_SET_MEMBERS ||
    words.reduce((total, word) => total + word.length, 0) > MAX_V_SET_SOURCE_LENGTH
  ) {
    return false;
  }
  if (words.length < 2) {
    return true;
  }

  let residuals = new Set<string>();
  for (let leftIndex = 0; leftIndex < words.length; leftIndex += 1) {
    const left = expectDefined(words[leftIndex], "UnicodeSets code word");
    for (let rightIndex = 0; rightIndex < words.length; rightIndex += 1) {
      if (leftIndex === rightIndex) {
        continue;
      }
      const right = expectDefined(words[rightIndex], "UnicodeSets code word");
      if (right.startsWith(left) && addResidual(residuals, right.slice(left.length))) {
        return false;
      }
    }
  }

  const seen = new Set<string>();
  while (residuals.size > 0) {
    const next = new Set<string>();
    for (const residual of residuals) {
      if (seen.has(residual) || words.includes(residual)) {
        if (words.includes(residual)) {
          return false;
        }
        continue;
      }
      seen.add(residual);
      if (seen.size > MAX_V_SET_RESIDUALS) {
        return false;
      }
      for (const word of words) {
        if (
          (word.startsWith(residual) && addResidual(next, word.slice(residual.length))) ||
          (residual.startsWith(word) && addResidual(next, residual.slice(word.length)))
        ) {
          return false;
        }
      }
    }
    residuals = next;
  }
  return true;
}

export function vSetHasAmbiguousStrings(source: string): boolean {
  const members = collectVSetMembers(source);
  return members === null || !isUniquelyDecodable(members);
}
