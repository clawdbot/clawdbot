// Memory Core plugin module implements concept vocabulary behavior.
import path from "node:path";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";

export const MAX_CONCEPT_TAGS = 8;

type ConceptTagScriptFamily = "latin" | "cjk" | "mixed" | "other";

export type ConceptTagScriptCoverage = {
  latinEntryCount: number;
  cjkEntryCount: number;
  mixedEntryCount: number;
  otherEntryCount: number;
};

const LANGUAGE_STOP_WORDS = {
  shared: [
    "about",
    "after",
    "agent",
    "again",
    "also",
    "assistant",
    "because",
    "before",
    "being",
    "between",
    "build",
    "called",
    "could",
    "daily",
    "default",
    "deploy",
    "during",
    "every",
    "file",
    "files",
    "from",
    "have",
    "into",
    "just",
    "line",
    "lines",
    "long",
    "main",
    "make",
    "memory",
    "month",
    "more",
    "most",
    "move",
    "much",
    "next",
    "note",
    "notes",
    "over",
    "part",
    "past",
    "port",
    "same",
    "score",
    "search",
    "session",
    "sessions",
    "short",
    "should",
    "since",
    "some",
    "subagent",
    "system",
    "than",
    "that",
    "their",
    "there",
    "these",
    "they",
    "this",
    "through",
    "today",
    "user",
    "using",
    "with",
    "work",
    "workspace",
    "year",
  ],
  english: ["and", "are", "for", "into", "its", "our", "the", "then", "were", "you", "your"],
  spanish: [
    "al",
    "con",
    "como",
    "de",
    "del",
    "el",
    "en",
    "es",
    "la",
    "las",
    "los",
    "para",
    "por",
    "que",
    "se",
    "sin",
    "su",
    "sus",
    "una",
    "uno",
    "unos",
    "unas",
    "y",
  ],
  french: [
    "au",
    "aux",
    "avec",
    "dans",
    "de",
    "des",
    "du",
    "en",
    "est",
    "et",
    "la",
    "le",
    "les",
    "ou",
    "pour",
    "que",
    "qui",
    "sans",
    "ses",
    "son",
    "sur",
    "une",
    "un",
  ],
  german: [
    "auf",
    "aus",
    "bei",
    "das",
    "dem",
    "den",
    "der",
    "des",
    "die",
    "ein",
    "eine",
    "einem",
    "einen",
    "einer",
    "für",
    "im",
    "in",
    "mit",
    "nach",
    "oder",
    "ohne",
    "über",
    "und",
    "von",
    "zu",
    "zum",
    "zur",
  ],
  cjk: [
    "が",
    "から",
    "する",
    "して",
    "した",
    "で",
    "と",
    "に",
    "の",
    "は",
    "へ",
    "まで",
    "も",
    "や",
    "を",
    "与",
    "为",
    "了",
    "及",
    "和",
    "在",
    "将",
    "或",
    "把",
    "是",
    "用",
    "的",
    "과",
    "는",
    "도",
    "로",
    "를",
    "에",
    "에서",
    "와",
    "은",
    "으로",
    "을",
    "이",
    "하다",
    "한",
    "할",
    "해",
    "했다",
  ],
  pathNoise: [
    "cjs",
    "cpp",
    "cts",
    "jsx",
    "json",
    "md",
    "mjs",
    "mts",
    "text",
    "toml",
    "ts",
    "tsx",
    "txt",
    "yaml",
    "yml",
  ],
} as const;

const CONCEPT_STOP_WORDS = new Set(
  Object.values(LANGUAGE_STOP_WORDS)
    .flat()
    .map((word) => normalizeLowercaseStringOrEmpty(word)),
);

const PROTECTED_GLOSSARY = [
  "backup",
  "backups",
  "embedding",
  "embeddings",
  "failover",
  "gateway",
  "glacier",
  "gpt",
  "kv",
  "network",
  "openai",
  "qmd",
  "router",
  "s3",
  "vlan",
  "sauvegarde",
  "routeur",
  "passerelle",
  "konfiguration",
  "sicherung",
  "überwachung",
  "configuración",
  "respaldo",
  "enrutador",
  "puerta-de-enlace",
  "バックアップ",
  "フェイルオーバー",
  "ルーター",
  "ネットワーク",
  "ゲートウェイ",
  "障害対応",
  "路由器",
  "备份",
  "故障转移",
  "网络",
  "网关",
  "라우터",
  "백업",
  "페일오버",
  "네트워크",
  "게이트웨이",
  "장애대응",
].map((word) => normalizeLowercaseStringOrEmpty(word.normalize("NFKC")));

const COMPOUND_TOKEN_RE = /[\p{L}\p{N}]+(?:[._/-][\p{L}\p{N}]+)+/gu;
const LETTER_OR_NUMBER_RE = /[\p{L}\p{N}]/u;
const LATIN_RE = /\p{Script=Latin}/u;
const HAN_RE = /\p{Script=Han}/u;
const HIRAGANA_RE = /\p{Script=Hiragana}/u;
const KATAKANA_RE = /\p{Script=Katakana}/u;
const HANGUL_RE = /\p{Script=Hangul}/u;

const DEFAULT_WORD_SEGMENTER =
  typeof Intl.Segmenter === "function" ? new Intl.Segmenter("und", { granularity: "word" }) : null;

function containsLetterOrNumber(value: string): boolean {
  return LETTER_OR_NUMBER_RE.test(value);
}

function classifyConceptTagScript(tag: string): ConceptTagScriptFamily {
  const normalized = tag.normalize("NFKC");
  const hasLatin = LATIN_RE.test(normalized);
  const hasCjk =
    HAN_RE.test(normalized) ||
    HIRAGANA_RE.test(normalized) ||
    KATAKANA_RE.test(normalized) ||
    HANGUL_RE.test(normalized);
  if (hasLatin && hasCjk) {
    return "mixed";
  }
  if (hasCjk) {
    return "cjk";
  }
  if (hasLatin) {
    return "latin";
  }
  return "other";
}

function minimumTokenLengthForScript(script: ConceptTagScriptFamily): number {
  if (script === "cjk") {
    return 2;
  }
  return 3;
}

function isKanaOnlyToken(value: string): boolean {
  return (
    !HAN_RE.test(value) &&
    !HANGUL_RE.test(value) &&
    (HIRAGANA_RE.test(value) || KATAKANA_RE.test(value))
  );
}

function normalizeConceptToken(rawToken: string, fromGlossary = false): string | null {
  const normalized = normalizeLowercaseStringOrEmpty(
    rawToken
      .normalize("NFKC")
      .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")
      .replaceAll("_", "-"),
  );
  if (!normalized || !containsLetterOrNumber(normalized) || normalized.length > 32) {
    return null;
  }
  if (
    /^\d+$/.test(normalized) ||
    /^\d{4}-\d{2}-\d{2}$/u.test(normalized) ||
    /^\d{4}-\d{2}-\d{2}\.[\p{L}\p{N}]+$/u.test(normalized)
  ) {
    return null;
  }
  const script = classifyConceptTagScript(normalized);
  // Glossary entries are an explicit allowlist of short technical terms (e.g. "kv", "s3"); they
  // bypass the per-script minimum length that would otherwise discard them.
  if (!fromGlossary && normalized.length < minimumTokenLengthForScript(script)) {
    return null;
  }
  if (isKanaOnlyToken(normalized) && normalized.length < 3) {
    return null;
  }
  if (CONCEPT_STOP_WORDS.has(normalized)) {
    return null;
  }
  return normalized;
}

// Only entries shorter than their script's minimum token length rely on the glossary bypass, and
// only those need whole-word matching so they don't fire inside longer words ("kv" in "mkv"). Longer
// entries keep substring containment (the shipped behavior, e.g. "backup" tagging inside "backups").
// Precomputed so derive() does not reclassify on every call.
const GLOSSARY_ENTRIES = PROTECTED_GLOSSARY.map((entry) => ({
  entry,
  wholeWord: entry.length < minimumTokenLengthForScript(classifyConceptTagScript(entry)),
}));

function isAlphanumericAt(source: string, index: number): boolean {
  const ch = source[index];
  return ch !== undefined && LETTER_OR_NUMBER_RE.test(ch);
}

// True when `entry` occurs as a delimiter-bounded token, not inside a longer word. Keeps short
// glossary entries like "kv"/"s3" from firing inside "mkv"/"css3" once they bypass the length gate.
function includesStandaloneTerm(source: string, entry: string): boolean {
  let from = source.indexOf(entry);
  while (from !== -1) {
    if (!isAlphanumericAt(source, from - 1) && !isAlphanumericAt(source, from + entry.length)) {
      return true;
    }
    from = source.indexOf(entry, from + 1);
  }
  return false;
}

function collectGlossaryMatches(source: string): string[] {
  const normalizedSource = normalizeLowercaseStringOrEmpty(source.normalize("NFKC"));
  const matches: string[] = [];
  for (const { entry, wholeWord } of GLOSSARY_ENTRIES) {
    const present = wholeWord
      ? includesStandaloneTerm(normalizedSource, entry)
      : normalizedSource.includes(entry);
    if (present) {
      matches.push(entry);
    }
  }
  return matches;
}

function collectCompoundTokens(source: string): string[] {
  return source.match(COMPOUND_TOKEN_RE) ?? [];
}

function collectSegmentTokens(source: string): string[] {
  if (DEFAULT_WORD_SEGMENTER) {
    return Array.from(DEFAULT_WORD_SEGMENTER.segment(source), (part) =>
      part.isWordLike ? part.segment : "",
    ).filter(Boolean);
  }
  return source.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

function pushNormalizedTag(
  tags: string[],
  rawToken: string,
  limit: number,
  fromGlossary = false,
): void {
  const normalized = normalizeConceptToken(rawToken, fromGlossary);
  if (!normalized || tags.includes(normalized)) {
    return;
  }
  tags.push(normalized);
  if (tags.length > limit) {
    tags.splice(limit);
  }
}

export function deriveConceptTags(params: {
  path: string;
  snippet: string;
  limit?: number;
}): string[] {
  const source = `${path.basename(params.path)} ${params.snippet}`;
  const limit = Number.isFinite(params.limit)
    ? Math.max(0, Math.floor(params.limit as number))
    : MAX_CONCEPT_TAGS;
  if (limit === 0) {
    return [];
  }

  const tags: string[] = [];
  const tokenSources: Array<{ tokens: string[]; fromGlossary: boolean }> = [
    { tokens: collectGlossaryMatches(source), fromGlossary: true },
    { tokens: collectCompoundTokens(source), fromGlossary: false },
    { tokens: collectSegmentTokens(source), fromGlossary: false },
  ];
  for (const { tokens, fromGlossary } of tokenSources) {
    for (const rawToken of tokens) {
      pushNormalizedTag(tags, rawToken, limit, fromGlossary);
      if (tags.length >= limit) {
        return tags;
      }
    }
  }
  return tags;
}

export function summarizeConceptTagScriptCoverage(
  conceptTagsByEntry: string[][],
): ConceptTagScriptCoverage {
  const coverage: ConceptTagScriptCoverage = {
    latinEntryCount: 0,
    cjkEntryCount: 0,
    mixedEntryCount: 0,
    otherEntryCount: 0,
  };

  for (const conceptTags of conceptTagsByEntry) {
    let hasLatin = false;
    let hasCjk = false;
    let hasOther = false;
    for (const tag of conceptTags) {
      const family = classifyConceptTagScript(tag);
      if (family === "mixed") {
        hasLatin = true;
        hasCjk = true;
        continue;
      }
      if (family === "latin") {
        hasLatin = true;
        continue;
      }
      if (family === "cjk") {
        hasCjk = true;
        continue;
      }
      hasOther = true;
    }

    if (hasLatin && hasCjk) {
      coverage.mixedEntryCount += 1;
    } else if (hasCjk) {
      coverage.cjkEntryCount += 1;
    } else if (hasLatin) {
      coverage.latinEntryCount += 1;
    } else if (hasOther) {
      coverage.otherEntryCount += 1;
    }
  }

  return coverage;
}
