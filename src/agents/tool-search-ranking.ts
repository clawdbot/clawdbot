// Lexical ranking for the OpenClaw Tool Search runtime.
import { isRecord } from "@openclaw/normalization-core/record-coerce";

/** Collects property names and descriptions from a JSON-Schema-shaped value. */
export function readParameterText(parameters: unknown, depth = 0): string {
  if (depth > 4 || !isRecord(parameters)) {
    return "";
  }
  const parts: string[] = [];
  const description = parameters.description;
  if (typeof description === "string") {
    parts.push(description);
  }
  const properties = parameters.properties;
  if (isRecord(properties)) {
    for (const [name, child] of Object.entries(properties)) {
      parts.push(name, readParameterText(child, depth + 1));
    }
  }
  const items = parameters.items;
  if (items !== undefined) {
    parts.push(readParameterText(items, depth + 1));
  }
  return parts.filter(Boolean).join(" ");
}

/** BM25 term-frequency saturation. Standard Okapi default. */
const BM25_K1 = 1.2;
/** BM25 length normalization. Standard Okapi default. */
const BM25_B = 0.75;

/**
 * Terms carrying no discriminating signal in a tool catalog. IDF already damps
 * these; dropping them keeps a query like "read a file and post it" from
 * scoring on "a"/"it" when a tool description happens to repeat them.
 *
 * Capability verbs stay out of this list even when they look like filler:
 * "get" names real operations ("get_weather"), and discarding it would reduce
 * "get issue" to "issue" and let a shorter delete/update entry outrank it.
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
    terms: ["remind", "reminder", "later", "tomorrow", "daily", "weekly", "recurring"],
    add: ["schedule", "automations", "cron", "reminder"],
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

/**
 * Words ending in `s` that are not plurals. Stripping it changes the meaning and
 * collides with an unrelated root: "news" would become "new" and then literal-
 * match every "Create a new ..." tool, outranking the search tool the query
 * meant. Several are ordinary tool vocabulary here ("status", "canvas", "alias").
 */
const NON_PLURAL_S_WORDS = new Set([
  "news",
  "status",
  "alias",
  "canvas",
  "focus",
  "bonus",
  "virus",
  "atlas",
  "lens",
  "axis",
  "basis",
  "analysis",
  "gas",
  "bus",
  "plus",
]);

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
  if (token.length <= 3 || NON_PLURAL_S_WORDS.has(token)) {
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
    // "repositories" -> "repository", not "repositori", or it never meets the
    // singular form the catalog is more likely to use.
    if (suffix === "ies") {
      return `${token.slice(0, -3)}y`;
    }
    const stripped = token.slice(0, -suffix.length);
    return UNDOUBLING_SUFFIXES.has(suffix) ? undoubleFinalConsonant(stripped) : stripped;
  }
  return token;
}

/**
 * Word parts inside a compound identifier, matched rather than split so an
 * acronym stays whole. Splitting on case transitions cuts "URLs" into "UR"/"Ls"
 * and makes the obvious query unable to reach the tool; the first alternative
 * keeps a run of capitals together, including a trailing plural `s`.
 */
const WORD_PARTS = /\p{Lu}+s?(?![\p{Ll}])|\p{Lu}?\p{Ll}+|\p{N}+/gu;

/**
 * Splits on anything that is not a word character, which keeps `_`-joined tool
 * names addressable as whole tokens while still emitting their parts, including
 * camelCase components that MCP catalogs commonly use.
 *
 * Unicode letters survive rather than being rejected: a catalog is allowed to
 * name or describe tools in another script, and dropping those would make them
 * permanently unreachable. What makes non-English queries fruitless in practice
 * is that catalogs are written in English, which is why `tool_search` asks the
 * model to query in English rather than this function refusing the input.
 */
function splitWords(input: string): string[] {
  const words: string[] = [];
  for (const raw of input.split(/[^\p{L}\p{N}_]+/u)) {
    if (!raw) {
      continue;
    }
    words.push(raw.toLowerCase());
    const parts: string[] = [];
    for (const underscorePart of raw.split("_")) {
      for (const casePart of underscorePart.match(WORD_PARTS) ?? []) {
        parts.push(casePart.toLowerCase());
      }
    }
    if (parts.length < 2) {
      continue;
    }
    for (const part of parts) {
      words.push(part);
    }
  }
  return words;
}

/**
 * Stems for one word. `-ies` is ambiguous — "policies" is "policy" but "cookies"
 * is "cookie" — so both readings are emitted and whichever the catalog actually
 * uses will match. Every other word has a single stem.
 */
function stemVariants(word: string): string[] {
  if (word.length > 4 && word.endsWith("ies")) {
    const base = word.slice(0, -3);
    return [`${base}y`, stem(`${base}ie`)];
  }
  const stemmed = stem(word);
  return stemmed ? [stemmed] : [];
}

/** Indexable terms for one document, with stopwords dropped and roots collapsed. */
export function tokenizeDocument(input: string): string[] {
  return splitWords(input)
    .filter((word) => !STOPWORDS.has(word))
    .flatMap(stemVariants)
    .filter(Boolean);
}

/**
 * Triggers are matched on a singularized word rather than the document stemmer.
 * Full stemming collapses unrelated vocabulary — "news" becomes "new", so "open
 * a new issue" would silently acquire a web-search intent — and an expansion
 * that fires on the wrong word is worse than one that does not fire.
 */
function normalizeTrigger(word: string): string {
  if (word.length > 4 && word.endsWith("ies")) {
    return `${word.slice(0, -3)}y`;
  }
  return word.length > 4 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word;
}

const NORMALIZED_EXPANSIONS: ReadonlyArray<{
  triggers: ReadonlySet<string>;
  add: readonly string[];
}> = QUERY_EXPANSIONS.map((group) => ({
  triggers: new Set(group.terms.map(normalizeTrigger)),
  add: group.add.map(stem),
}));

/**
 * Weight for a term the caller did not write. Expansions are a hint about what
 * the catalog might call this capability, so they must not let a merely related
 * tool outscore one that matches the words actually typed.
 */
const EXPANSION_WEIGHT = 0.35;

type WeightedTerm = { term: string; weight: number };

/** Query terms: literal words at full weight, expansions discounted. */
export function tokenizeQuery(input: string): WeightedTerm[] {
  const words = splitWords(input).filter((word) => !STOPWORDS.has(word));
  const weights = new Map<string, number>();
  for (const term of words.flatMap(stemVariants).filter(Boolean)) {
    weights.set(term, 1);
  }
  const triggers = new Set(words.map(normalizeTrigger));
  for (const group of NORMALIZED_EXPANSIONS) {
    if (![...group.triggers].some((trigger) => triggers.has(trigger))) {
      continue;
    }
    for (const addition of group.add) {
      // A word the caller actually wrote keeps full weight.
      weights.set(addition, Math.max(weights.get(addition) ?? 0, EXPANSION_WEIGHT));
    }
  }
  return [...weights].map(([term, weight]) => ({ term, weight }));
}

type RankedDocument<T> = { value: T; terms: readonly string[] };

type IndexedDocument<T> = { readonly value: T; readonly length: number; readonly position: number };

type LexicalIndex<T> = {
  postings: ReadonlyMap<string, ReadonlyMap<IndexedDocument<T>, number>>;
  documentCount: number;
  averageLength: number;
};

export function buildLexicalIndex<T>(documents: ReadonlyArray<RankedDocument<T>>): LexicalIndex<T> {
  const postings = new Map<string, Map<IndexedDocument<T>, number>>();
  const prepared = documents.map((document, position) => {
    const indexed = { value: document.value, length: document.terms.length, position };
    for (const term of document.terms) {
      let matches = postings.get(term);
      if (!matches) {
        matches = new Map();
        postings.set(term, matches);
      }
      matches.set(indexed, (matches.get(indexed) ?? 0) + 1);
    }
    return indexed;
  });
  const totalLength = prepared.reduce((sum, document) => sum + document.length, 0);
  return {
    postings,
    documentCount: prepared.length,
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
 *
 * `matchedLiteral` reports whether a hit shares any word the caller actually
 * typed. Callers rank on it first: discounting expansions is not sufficient on
 * its own, because BM25 sums per term and a common literal term carries little
 * IDF, so a short document collecting two rare expansions can still outscore it.
 */
export function scoreLexical<T>(
  index: LexicalIndex<T>,
  queryTerms: readonly WeightedTerm[],
): Array<{ value: T; score: number; matchedLiteral: boolean }> {
  if (queryTerms.length === 0 || index.documentCount === 0) {
    return [];
  }
  const total = index.documentCount;
  const results: Array<{ value: T; score: number; matchedLiteral: boolean }> = [];
  for (const { term, weight } of queryTerms) {
    const matches = index.postings.get(term);
    if (!matches) {
      continue;
    }
    const matching = matches.size;
    const idf = Math.log(1 + (total - matching + 0.5) / (matching + 0.5));
    for (const [document, frequency] of matches) {
      let result = results[document.position];
      if (!result) {
        result = { value: document.value, score: 0, matchedLiteral: false };
        results[document.position] = result;
      }
      if (weight >= 1) {
        result.matchedLiteral = true;
      }
      const normalized = index.averageLength > 0 ? document.length / index.averageLength : 1;
      result.score +=
        (weight * (idf * (frequency * (BM25_K1 + 1)))) /
        (frequency + BM25_K1 * (1 - BM25_B + BM25_B * normalized));
    }
  }
  // Sparse slots keep document positions; filter skips holes and preserves catalog order.
  return results.filter((result) => result.score > 0);
}
