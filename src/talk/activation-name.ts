export const REALTIME_VOICE_ACTIVATION_NAME_MAX_WORDS = 2;

export type RealtimeVoiceActivationNameEdge = "leading" | "trailing";
export type RealtimeVoiceActivationNameMatchKind = "exact" | "fuzzy";

export type RealtimeVoiceActivationNameTranscriptResult =
  | {
      allowed: true;
      text: string;
      activationName: string;
      heardName: string;
      match: RealtimeVoiceActivationNameMatchKind;
      edge: RealtimeVoiceActivationNameEdge;
    }
  | { allowed: false; text: string };

type EdgeActivationNameCandidate = {
  edge: RealtimeVoiceActivationNameEdge;
  heardName: string;
  startIndex: number;
  endIndex: number;
  strongBoundary: boolean;
};

type PreparedActivationName = {
  activationName: string;
  compact: string;
};

type PreparedEdgeActivationNameCandidate = {
  candidate: EdgeActivationNameCandidate;
  compact: string;
};

export function realtimeVoiceActivationNameWordCount(value: string): number {
  return Array.from(value.matchAll(/[a-z0-9]+/gi)).length;
}

export function normalizeRealtimeVoiceActivationName(value: string): string | undefined {
  const normalized = value.toLowerCase().replace(/\s+/g, " ").trim();
  return normalized || undefined;
}

export function normalizeRealtimeVoiceActivationNamePrefix(
  value: string,
  maxWords = REALTIME_VOICE_ACTIVATION_NAME_MAX_WORDS,
): string | undefined {
  const words = Array.from(value.matchAll(/[a-z0-9]+/gi), (match) => match[0]);
  if (words.length === 0) {
    return undefined;
  }
  return words.slice(0, maxWords).join(" ");
}

export function isSupportedRealtimeVoiceActivationName(
  value: string,
  maxWords = REALTIME_VOICE_ACTIVATION_NAME_MAX_WORDS,
): boolean {
  const wordCount = realtimeVoiceActivationNameWordCount(value);
  return wordCount >= 1 && wordCount <= maxWords;
}

export function normalizeSupportedRealtimeVoiceActivationName(
  value: string | undefined,
  maxWords = REALTIME_VOICE_ACTIVATION_NAME_MAX_WORDS,
): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = normalizeRealtimeVoiceActivationName(value);
  return normalized && isSupportedRealtimeVoiceActivationName(normalized, maxWords)
    ? normalized
    : undefined;
}

export function sortRealtimeVoiceActivationNames(names: string[]): string[] {
  return names.toSorted((left, right) => right.length - left.length || left.localeCompare(right));
}

export function matchRealtimeVoiceActivationName(
  text: string,
  activationNames: string[],
  maxWords = REALTIME_VOICE_ACTIVATION_NAME_MAX_WORDS,
): Extract<RealtimeVoiceActivationNameTranscriptResult, { allowed: true }> | undefined {
  const preparedActivationNames: PreparedActivationName[] = [];
  for (const activationName of activationNames) {
    const normalizedActivationName = normalizeActivationNameCandidate(activationName);
    if (!normalizedActivationName) {
      continue;
    }
    preparedActivationNames.push({
      activationName,
      compact: compactActivationName(normalizedActivationName),
    });
  }
  if (preparedActivationNames.length === 0) {
    return undefined;
  }

  const candidates = [
    ...leadingActivationNameCandidates(text, maxWords),
    ...trailingActivationNameCandidates(text, maxWords),
  ]
    .map(
      (candidate): PreparedEdgeActivationNameCandidate => ({
        candidate,
        compact: compactActivationName(candidate.heardName),
      }),
    )
    .toSorted((left, right) => right.compact.length - left.compact.length);

  for (const { candidate, compact: heardCompact } of candidates) {
    for (const { activationName, compact: activationCompact } of preparedActivationNames) {
      const exactMatch = heardCompact === activationCompact;
      const fuzzyMatch =
        candidate.edge === "leading" &&
        isFuzzyActivationNameMatch(candidate, heardCompact, activationCompact);
      if (exactMatch || fuzzyMatch) {
        return {
          allowed: true,
          text: stripEdgeActivationNameCandidate(text, candidate),
          activationName,
          heardName: candidate.heardName,
          match: exactMatch ? "exact" : "fuzzy",
          edge: candidate.edge,
        };
      }
    }
  }
  return undefined;
}

function normalizeActivationNameCandidate(value: string): string | undefined {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized || undefined;
}

function compactActivationName(value: string): string {
  return value.replace(/[^a-z0-9]+/g, "");
}

function leadingActivationNameCandidates(
  text: string,
  maxWords: number,
): EdgeActivationNameCandidate[] {
  const opener = /^\s*(?:(?:hey|ok|okay)(?:\s*[-,:;]+\s*|\s+))?/i.exec(text);
  const nameStart = opener?.[0].length ?? 0;
  const candidates: EdgeActivationNameCandidate[] = [];
  const candidateStarts = nameStart > 0 ? [0, nameStart] : [0];

  for (const startIndex of candidateStarts) {
    const tokenPattern = /[a-z0-9]+/gi;
    tokenPattern.lastIndex = startIndex;
    const startCandidates: EdgeActivationNameCandidate[] = [];

    for (let wordCount = 0; wordCount < maxWords; wordCount += 1) {
      const token = tokenPattern.exec(text);
      if (!token) {
        break;
      }
      const previousEndIndex =
        wordCount === 0 ? startIndex : startCandidates[wordCount - 1]?.endIndex;
      const between = text.slice(previousEndIndex, token.index);
      if (wordCount > 0 && !/^[\s'-]+$/.test(between)) {
        break;
      }
      const endIndex = token.index + token[0].length;
      const heardName = normalizeActivationNameCandidate(text.slice(startIndex, endIndex));
      if (!heardName) {
        break;
      }
      const boundary = text.slice(endIndex).match(/^\s*([,.:;!?-]|$)/);
      startCandidates.push({
        edge: "leading",
        heardName,
        startIndex,
        endIndex,
        strongBoundary: Boolean(boundary),
      });
    }

    candidates.push(...startCandidates);
  }

  return candidates;
}

function trailingActivationNameCandidates(
  text: string,
  maxWords: number,
): EdgeActivationNameCandidate[] {
  const tokens = Array.from(text.matchAll(/[a-z0-9]+/gi));
  const candidates: EdgeActivationNameCandidate[] = [];
  const tokenCount = Math.min(tokens.length, maxWords);

  for (let wordCount = 1; wordCount <= tokenCount; wordCount += 1) {
    const startToken = tokens[tokens.length - wordCount];
    const endToken = tokens[tokens.length - 1];
    if (!startToken || !endToken?.[0]) {
      break;
    }
    const startIndex = startToken.index ?? 0;
    const endIndex = (endToken.index ?? 0) + endToken[0].length;
    if (!/^\s*(?:[,.:;!?-]+\s*)?$/.test(text.slice(endIndex))) {
      break;
    }
    if (!/(^|[\s,.:;!?-])$/.test(text.slice(0, startIndex))) {
      break;
    }
    if (wordCount > 1) {
      const previousToken = tokens[tokens.length - wordCount + 1];
      const between = previousToken
        ? text.slice(startIndex + startToken[0].length, previousToken.index)
        : "";
      if (!/^[\s'-]+$/.test(between)) {
        break;
      }
    }
    const heardName = normalizeActivationNameCandidate(text.slice(startIndex, endIndex));
    if (!heardName) {
      break;
    }
    candidates.push({
      edge: "trailing",
      heardName,
      startIndex,
      endIndex,
      strongBoundary: true,
    });
  }

  return candidates;
}

function levenshteinDistance(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  if (!left) {
    return right.length;
  }
  if (!right) {
    return left.length;
  }

  let previous = new Uint32Array(right.length + 1);
  let current = new Uint32Array(right.length + 1);
  for (let index = 0; index <= right.length; index += 1) {
    previous[index] = index;
  }
  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    current[0] = leftIndex + 1;
    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      const cost = left[leftIndex] === right[rightIndex] ? 0 : 1;
      current[rightIndex + 1] = Math.min(
        current[rightIndex] + 1,
        previous[rightIndex + 1] + 1,
        previous[rightIndex] + cost,
      );
    }
    const nextPrevious = current;
    current = previous;
    previous = nextPrevious;
  }
  return previous[right.length];
}

function hasOnlyPhoneticSubstitutions(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const vowels = new Set(["a", "e", "i", "o", "u", "y"]);
  const liquids = new Set(["l", "r"]);
  let substitutions = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftChar = left[index];
    const rightChar = right[index];
    if (leftChar === rightChar) {
      continue;
    }
    const vowelLike = vowels.has(leftChar ?? "") && vowels.has(rightChar ?? "");
    const liquidLike = liquids.has(leftChar ?? "") && liquids.has(rightChar ?? "");
    if (!vowelLike && !liquidLike) {
      return false;
    }
    substitutions += 1;
  }
  return substitutions > 0;
}

function commonPrefixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  for (let index = 0; index < limit; index += 1) {
    if (left[index] !== right[index]) {
      return index;
    }
  }
  return limit;
}

function isFuzzyActivationNameMatch(
  candidate: EdgeActivationNameCandidate,
  heardCompact: string,
  activationCompact: string,
): boolean {
  if (!heardCompact || !activationCompact || activationCompact.length < 5) {
    return false;
  }
  if (!candidate.strongBoundary) {
    return false;
  }
  if (heardCompact[0] !== activationCompact[0]) {
    return false;
  }
  const distance = levenshteinDistance(heardCompact, activationCompact);
  if (distance <= 1) {
    return true;
  }
  if (
    distance === 2 &&
    heardCompact.length >= 4 &&
    activationCompact.length >= 5 &&
    (heardCompact.length !== activationCompact.length ||
      hasOnlyPhoneticSubstitutions(heardCompact, activationCompact) ||
      commonPrefixLength(heardCompact, activationCompact) >= 6)
  ) {
    return true;
  }
  if (
    distance === 3 &&
    heardCompact.length >= 7 &&
    activationCompact.length >= 7 &&
    heardCompact.length !== activationCompact.length &&
    commonPrefixLength(heardCompact, activationCompact) >= 5
  ) {
    return true;
  }
  return false;
}

function stripEdgeActivationNameCandidate(
  text: string,
  candidate: EdgeActivationNameCandidate,
): string {
  if (candidate.edge === "leading") {
    return text
      .slice(candidate.endIndex)
      .replace(/^\s*(?:[-,:;.!?]+\s*)?/, "")
      .trim();
  }
  return text
    .slice(0, candidate.startIndex)
    .replace(/\s*(?:[-,:;.!?]+\s*)?$/, "")
    .trim();
}
