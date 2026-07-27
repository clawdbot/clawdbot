// Lexical ranking shared by Tool Search results and directory-mode hydration.
//
// Both surfaces answer the same question — "which tools does this query mean?" —
// so they index and score through here rather than keeping separate heuristics
// that can disagree about the same catalog.

/** BM25 term-frequency saturation. Standard Okapi default. */
const BM25_K1 = 1.2;
/** BM25 length normalization. Standard Okapi default. */
const BM25_B = 0.75;

/**
 * Terms carrying no discriminating signal in a tool catalog. IDF already damps
 * these; dropping them keeps a query like "read a file and post it" from
 * scoring on "a"/"it" when a tool description happens to repeat them.
 */
const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "can",
  "do",
  "for",
  "from",
  "get",
  "had",
  "has",
  "have",
  "here",
  "how",
  "i",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "me",
  "my",
  "no",
  "not",
  "of",
  "on",
  "or",
  "our",
  "so",
  "that",
  "the",
  "their",
  "them",
  "then",
  "there",
  "these",
  "they",
  "this",
  "to",
  "up",
  "us",
  "was",
  "we",
  "were",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "will",
  "with",
  "you",
  "your",
]);

/**
 * Query vocabulary mapped to the capability words tool descriptions actually
 * use. This bridges intent to wording ("look up the price" -> "search"), which
 * pure lexical overlap cannot do.
 *
 * Values must stay generic capability terms. Never put plugin, vendor, or
 * product names here: those break silently when a plugin is renamed, and a
 * catalog is not required to contain any particular provider.
 */
const QUERY_EXPANSIONS: ReadonlyArray<{ terms: readonly string[]; add: readonly string[] }> = [
  { terms: ["look", "lookup", "google", "research"], add: ["search", "web", "find"] },
  {
    terms: ["current", "today", "latest", "now", "recent", "news", "price", "weather"],
    add: ["search", "web"],
  },
  { terms: ["url", "link", "page", "article", "site", "website"], add: ["fetch", "web", "browse"] },
  {
    terms: ["remember", "recall", "memory", "earlier", "previously", "discussed", "decided"],
    add: ["memory", "recall", "history"],
  },
  {
    terms: ["remind", "later", "tomorrow", "daily", "weekly", "recurring"],
    add: ["schedule", "cron", "reminder"],
  },
  { terms: ["say", "tell", "reply", "respond", "answer"], add: ["message", "send"] },
  { terms: ["picture", "photo", "meme", "screenshot"], add: ["image"] },
  { terms: ["speak", "say", "voice"], add: ["audio", "speech"] },
  { terms: ["run", "execute", "command", "shell", "terminal"], add: ["exec", "process"] },
  { terms: ["directory", "folder", "path"], add: ["file", "list"] },
];

/**
 * Light English suffix stripper. Not a full Porter stemmer: it exists so that
 * "scheduling" reaches a tool described as "Schedule a recurring task", which
 * exact-token matching misses entirely. Applied repeatedly so plural verb forms
 * ("reminders" -> "reminder" -> "remind") collapse to one root.
 */
function stem(token: string): string {
  let current = token;
  for (let pass = 0; pass < 3; pass += 1) {
    const next = stripOneSuffix(current);
    if (next === current) {
      return current;
    }
    current = next;
  }
  return current;
}

/** Suffixes whose stripping can expose a consonant doubled only by inflection. */
const UNDOUBLING_SUFFIXES = new Set(["ing", "ed", "er"]);
/** Doubles that belong to the root ("call", "process", "off", "buzz"). */
const KEPT_DOUBLE_CONSONANTS = new Set(["l", "s", "f", "z"]);

/**
 * "running" strips to "runn", which would never meet "run". English doubles the
 * final consonant before these suffixes, so undo that — otherwise the stemmer
 * makes common pairs (run/running, stop/stopping, log/logging) unreachable, a
 * regression the old substring scorer did not have.
 */
function undoubleFinalConsonant(token: string): string {
  const last = token.at(-1);
  if (
    !last ||
    last !== token.at(-2) ||
    KEPT_DOUBLE_CONSONANTS.has(last) ||
    "aeiou".includes(last) ||
    token.length <= 3
  ) {
    return token;
  }
  return token.slice(0, -1);
}

function stripOneSuffix(token: string): string {
  if (token.length <= 3) {
    return token;
  }
  for (const suffix of ["ies", "ing", "ed", "ly", "es", "er", "s", "e"]) {
    if (!token.endsWith(suffix) || token.length - suffix.length < 3) {
      continue;
    }
    // "ss" is part of the root ("process"), not a plural marker.
    if (suffix === "s" && token.endsWith("ss")) {
      continue;
    }
    if (suffix === "ies") {
      return `${token.slice(0, -3)}i`;
    }
    const stripped = token.slice(0, -suffix.length);
    return UNDOUBLING_SUFFIXES.has(suffix) ? undoubleFinalConsonant(stripped) : stripped;
  }
  return token;
}

/**
 * Splits on anything that is not a word character, which keeps `_`-joined tool
 * names addressable as whole tokens while still emitting their parts.
 *
 * Unicode letters survive rather than being rejected: a catalog is allowed to
 * name or describe tools in another script, and dropping those would make them
 * permanently unreachable. What makes non-English queries fruitless in practice
 * is that catalogs are written in English, which is why `tool_search` asks the
 * model to query in English rather than this function refusing the input.
 */
function splitWords(input: string): string[] {
  const words: string[] = [];
  for (const word of input.toLowerCase().split(/[^\p{L}\p{N}_]+/u)) {
    if (!word) {
      continue;
    }
    words.push(word);
    if (!word.includes("_")) {
      continue;
    }
    for (const part of word.split("_")) {
      if (part) {
        words.push(part);
      }
    }
  }
  return words;
}

/** Indexable terms for one document, with stopwords dropped and roots collapsed. */
export function tokenizeDocument(input: string): string[] {
  return splitWords(input)
    .filter((word) => !STOPWORDS.has(word))
    .map(stem)
    .filter(Boolean);
}

/**
 * Expansion table keyed by stemmed trigger, so one entry covers a word's whole
 * family: "remind" also fires for "reminder" and "reminders". The table itself
 * stays written in plain words.
 */
const STEMMED_EXPANSIONS: ReadonlyArray<{ triggers: ReadonlySet<string>; add: readonly string[] }> =
  QUERY_EXPANSIONS.map((group) => ({
    triggers: new Set(group.terms.map(stem)),
    add: group.add.map(stem),
  }));

/** Query terms: stemmed, then expanded toward the words descriptions use. */
export function tokenizeQuery(input: string): string[] {
  const stemmed = splitWords(input)
    .filter((word) => !STOPWORDS.has(word))
    .map(stem)
    .filter(Boolean);
  const expanded = new Set(stemmed);
  for (const group of STEMMED_EXPANSIONS) {
    if (stemmed.some((term) => group.triggers.has(term))) {
      for (const addition of group.add) {
        expanded.add(addition);
      }
    }
  }
  return [...expanded];
}

export type RankedDocument<T> = { value: T; terms: readonly string[] };

export type LexicalIndex<T> = {
  documents: ReadonlyArray<{ value: T; termCounts: ReadonlyMap<string, number>; length: number }>;
  documentFrequency: ReadonlyMap<string, number>;
  averageLength: number;
};

export function buildLexicalIndex<T>(documents: ReadonlyArray<RankedDocument<T>>): LexicalIndex<T> {
  const documentFrequency = new Map<string, number>();
  const prepared = documents.map((document) => {
    const termCounts = new Map<string, number>();
    for (const term of document.terms) {
      termCounts.set(term, (termCounts.get(term) ?? 0) + 1);
    }
    for (const term of termCounts.keys()) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
    return { value: document.value, termCounts, length: document.terms.length };
  });
  const totalLength = prepared.reduce((sum, document) => sum + document.length, 0);
  return {
    documents: prepared,
    documentFrequency,
    averageLength: prepared.length > 0 ? totalLength / prepared.length : 0,
  };
}

/**
 * Okapi BM25. Ranks by how well a document matches the query terms, damping
 * terms that appear across most of the catalog and normalizing for description
 * length so a verbose tool does not outrank a precise one.
 *
 * An empty query scores nothing on purpose: returning the whole catalog in
 * arbitrary order would look like a ranked answer without being one.
 */
export function scoreLexical<T>(
  index: LexicalIndex<T>,
  queryTerms: readonly string[],
): Array<{ value: T; score: number }> {
  if (queryTerms.length === 0 || index.documents.length === 0) {
    return [];
  }
  const total = index.documents.length;
  const results: Array<{ value: T; score: number }> = [];
  for (const document of index.documents) {
    let score = 0;
    for (const term of queryTerms) {
      const frequency = document.termCounts.get(term);
      if (!frequency) {
        continue;
      }
      const matching = index.documentFrequency.get(term) ?? 0;
      const idf = Math.log(1 + (total - matching + 0.5) / (matching + 0.5));
      const normalized = index.averageLength > 0 ? document.length / index.averageLength : 1;
      score +=
        (idf * (frequency * (BM25_K1 + 1))) /
        (frequency + BM25_K1 * (1 - BM25_B + BM25_B * normalized));
    }
    if (score > 0) {
      results.push({ value: document.value, score });
    }
  }
  return results;
}
