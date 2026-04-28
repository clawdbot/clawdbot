import { normalizeLowercaseStringOrEmpty } from "./string-utils.js";

/**
 * Query expansion for FTS-only search mode.
 *
 * When no embedding provider is available, we fall back to FTS (full-text search).
 * FTS works best with specific keywords, but users often ask conversational queries
 * like "that thing we discussed yesterday" or "之前讨论的那个方案".
 *
 * This module extracts meaningful keywords from such queries to improve FTS results.
 */

// Common stop words that don't add search value
const STOP_WORDS_EN = new Set([
  // Articles and determiners
  "a",
  "an",
  "the",
  "this",
  "that",
  "these",
  "those",
  // Pronouns
  "i",
  "me",
  "my",
  "we",
  "our",
  "you",
  "your",
  "he",
  "she",
  "it",
  "they",
  "them",
  // Common verbs
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "could",
  "should",
  "can",
  "may",
  "might",
  // Prepositions
  "in",
  "on",
  "at",
  "to",
  "for",
  "of",
  "with",
  "by",
  "from",
  "about",
  "into",
  "through",
  "during",
  "before",
  "after",
  "above",
  "below",
  "between",
  "under",
  "over",
  // Conjunctions
  "and",
  "or",
  "but",
  "if",
  "then",
  "because",
  "as",
  "while",
  "when",
  "where",
  "what",
  "which",
  "who",
  "how",
  "why",
  // Time references (vague, not useful for FTS)
  "yesterday",
  "today",
  "tomorrow",
  "earlier",
  "later",
  "recently",
  "before",
  "ago",
  "just",
  "now",
  // Vague references
  "thing",
  "things",
  "stuff",
  "something",
  "anything",
  "everything",
  "nothing",
  // Question words
  "please",
  "help",
  "find",
  "show",
  "get",
  "tell",
  "give",
]);

const STOP_WORDS_ES = new Set([
  // Articles and determiners
  "el",
  "la",
  "los",
  "las",
  "un",
  "una",
  "unos",
  "unas",
  "este",
  "esta",
  "ese",
  "esa",
  // Pronouns
  "yo",
  "me",
  "mi",
  "nosotros",
  "nosotras",
  "tu",
  "tus",
  "usted",
  "ustedes",
  "ellos",
  "ellas",
  // Prepositions and conjunctions
  "de",
  "del",
  "a",
  "en",
  "con",
  "por",
  "para",
  "sobre",
  "entre",
  "y",
  "o",
  "pero",
  "si",
  "porque",
  "como",
  // Common verbs / auxiliaries
  "es",
  "son",
  "fue",
  "fueron",
  "ser",
  "estar",
  "haber",
  "tener",
  "hacer",
  // Time references (vague)
  "ayer",
  "hoy",
  "mañana",
  "antes",
  "despues",
  "después",
  "ahora",
  "recientemente",
  // Question/request words
  "que",
  "qué",
  "cómo",
  "cuando",
  "cuándo",
  "donde",
  "dónde",
  "porqué",
  "favor",
  "ayuda",
]);

const STOP_WORDS_PT = new Set([
  // Articles and determiners
  "o",
  "a",
  "os",
  "as",
  "um",
  "uma",
  "uns",
  "umas",
  "este",
  "esta",
  "esse",
  "essa",
  // Pronouns
  "eu",
  "me",
  "meu",
  "minha",
  "nos",
  "nós",
  "você",
  "vocês",
  "ele",
  "ela",
  "eles",
  "elas",
  // Prepositions and conjunctions
  "de",
  "do",
  "da",
  "em",
  "com",
  "por",
  "para",
  "sobre",
  "entre",
  "e",
  "ou",
  "mas",
  "se",
  "porque",
  "como",
  // Common verbs / auxiliaries
  "é",
  "são",
  "foi",
  "foram",
  "ser",
  "estar",
  "ter",
  "fazer",
  // Time references (vague)
  "ontem",
  "hoje",
  "amanhã",
  "antes",
  "depois",
  "agora",
  "recentemente",
  // Question/request words
  "que",
  "quê",
  "quando",
  "onde",
  "porquê",
  "favor",
  "ajuda",
]);

const STOP_WORDS_AR = new Set([
  // Articles and connectors
  "ال",
  "و",
  "أو",
  "لكن",
  "ثم",
  "بل",
  // Pronouns / references
  "أنا",
  "نحن",
  "هو",
  "هي",
  "هم",
  "هذا",
  "هذه",
  "ذلك",
  "تلك",
  "هنا",
  "هناك",
  // Common prepositions
  "من",
  "إلى",
  "الى",
  "في",
  "على",
  "عن",
  "مع",
  "بين",
  "ل",
  "ب",
  "ك",
  // Common auxiliaries / vague verbs
  "كان",
  "كانت",
  "يكون",
  "تكون",
  "صار",
  "أصبح",
  "يمكن",
  "ممكن",
  // Time references (vague)
  "بالأمس",
  "امس",
  "اليوم",
  "غدا",
  "الآن",
  "قبل",
  "بعد",
  "مؤخرا",
  // Question/request words
  "لماذا",
  "كيف",
  "ماذا",
  "متى",
  "أين",
  "هل",
  "من فضلك",
  "فضلا",
  "ساعد",
]);

const STOP_WORDS_KO = new Set([
  // Particles (조사)
  "은",
  "는",
  "이",
  "가",
  "을",
  "를",
  "의",
  "에",
  "에서",
  "로",
  "으로",
  "와",
  "과",
  "도",
  "만",
  "까지",
  "부터",
  "한테",
  "에게",
  "께",
  "처럼",
  "같이",
  "보다",
  "마다",
  "밖에",
  "대로",
  // Pronouns (대명사)
  "나",
  "나는",
  "내가",
  "나를",
  "너",
  "우리",
  "저",
  "저희",
  "그",
  "그녀",
  "그들",
  "이것",
  "저것",
  "그것",
  "여기",
  "저기",
  "거기",
  // Common verbs / auxiliaries (일반 동사/보조 동사)
  "있다",
  "없다",
  "하다",
  "되다",
  "이다",
  "아니다",
  "보다",
  "주다",
  "오다",
  "가다",
  // Nouns (의존 명사 / vague)
  "것",
  "거",
  "등",
  "수",
  "때",
  "곳",
  "중",
  "분",
  // Adverbs
  "잘",
  "더",
  "또",
  "매우",
  "정말",
  "아주",
  "많이",
  "너무",
  "좀",
  // Conjunctions
  "그리고",
  "하지만",
  "그래서",
  "그런데",
  "그러나",
  "또는",
  "그러면",
  // Question words
  "왜",
  "어떻게",
  "뭐",
  "언제",
  "어디",
  "누구",
  "무엇",
  "어떤",
  // Time (vague)
  "어제",
  "오늘",
  "내일",
  "최근",
  "지금",
  "아까",
  "나중",
  "전에",
  // Request words
  "제발",
  "부탁",
]);

// Common Korean trailing particles to strip from words for tokenization
// Sorted by descending length so longest-match-first is guaranteed.
const KO_TRAILING_PARTICLES = [
  "에서",
  "으로",
  "에게",
  "한테",
  "처럼",
  "같이",
  "보다",
  "까지",
  "부터",
  "마다",
  "밖에",
  "대로",
  "은",
  "는",
  "이",
  "가",
  "을",
  "를",
  "의",
  "에",
  "로",
  "와",
  "과",
  "도",
  "만",
].toSorted((a, b) => b.length - a.length);

function stripKoreanTrailingParticle(token: string): string | null {
  for (const particle of KO_TRAILING_PARTICLES) {
    if (token.length > particle.length && token.endsWith(particle)) {
      return token.slice(0, -particle.length);
    }
  }
  return null;
}

function isUsefulKoreanStem(stem: string): boolean {
  // Prevent bogus one-syllable stems from words like "논의" -> "논".
  if (/[\uac00-\ud7af]/.test(stem)) {
    return stem.length >= 2;
  }
  // Keep stripped ASCII stems for mixed tokens like "API를" -> "api".
  return /^[a-z0-9_]+$/i.test(stem);
}

const STOP_WORDS_JA = new Set([
  // Pronouns and references
  "これ",
  "それ",
  "あれ",
  "この",
  "その",
  "あの",
  "ここ",
  "そこ",
  "あそこ",
  // Common auxiliaries / vague verbs
  "する",
  "した",
  "して",
  "です",
  "ます",
  "いる",
  "ある",
  "なる",
  "できる",
  // Particles / connectors
  "の",
  "こと",
  "もの",
  "ため",
  "そして",
  "しかし",
  "また",
  "でも",
  "から",
  "まで",
  "より",
  "だけ",
  // Question words
  "なぜ",
  "どう",
  "何",
  "いつ",
  "どこ",
  "誰",
  "どれ",
  // Time (vague)
  "昨日",
  "今日",
  "明日",
  "最近",
  "今",
  "さっき",
  "前",
  "後",
]);

const STOP_WORDS_ZH = new Set([
  // Pronouns
  "我",
  "我们",
  "你",
  "你们",
  "他",
  "她",
  "它",
  "他们",
  "这",
  "那",
  "这个",
  "那个",
  "这些",
  "那些",
  // Auxiliary words
  "的",
  "了",
  "着",
  "过",
  "得",
  "地",
  "吗",
  "呢",
  "吧",
  "啊",
  "呀",
  "嘛",
  "啦",
  // Verbs (common, vague)
  "是",
  "有",
  "在",
  "被",
  "把",
  "给",
  "让",
  "用",
  "到",
  "去",
  "来",
  "做",
  "说",
  "看",
  "找",
  "想",
  "要",
  "能",
  "会",
  "可以",
  // Prepositions and conjunctions
  "和",
  "与",
  "或",
  "但",
  "但是",
  "因为",
  "所以",
  "如果",
  "虽然",
  "而",
  "也",
  "都",
  "就",
  "还",
  "又",
  "再",
  "才",
  "只",
  // Time (vague)
  "之前",
  "以前",
  "之后",
  "以后",
  "刚才",
  "现在",
  "昨天",
  "今天",
  "明天",
  "最近",
  // Vague references
  "东西",
  "事情",
  "事",
  "什么",
  "哪个",
  "哪些",
  "怎么",
  "为什么",
  "多少",
  // Question/request words
  "请",
  "帮",
  "帮忙",
  "告诉",
]);

export function isQueryStopWordToken(token: string): boolean {
  return (
    STOP_WORDS_EN.has(token) ||
    STOP_WORDS_ES.has(token) ||
    STOP_WORDS_PT.has(token) ||
    STOP_WORDS_AR.has(token) ||
    STOP_WORDS_ZH.has(token) ||
    STOP_WORDS_KO.has(token) ||
    STOP_WORDS_JA.has(token)
  );
}

/**
 * Check if a token looks like a meaningful keyword.
 * Returns false for short tokens, numbers-only, etc.
 */
function isValidKeyword(token: string): boolean {
  if (!token || token.length === 0) {
    return false;
  }
  // Skip very short English words (likely stop words or fragments)
  if (/^[a-zA-Z]+$/.test(token) && token.length < 3) {
    return false;
  }
  // Skip pure numbers (not useful for semantic search)
  if (/^\d+$/.test(token)) {
    return false;
  }
  // Skip tokens that are all punctuation
  if (/^[\p{P}\p{S}]+$/u.test(token)) {
    return false;
  }
  return true;
}

/**
 * Simple tokenizer that handles English, Chinese, Korean, and Japanese text.
 * For Chinese, we do character-based splitting since we don't have a proper segmenter.
 * For English, we split on whitespace and punctuation.
 */
function tokenize(text: string, opts?: { ftsTokenizer?: "unicode61" | "trigram" }): string[] {
  const useTrigram = opts?.ftsTokenizer === "trigram";
  const tokens: string[] = [];
  const normalized = normalizeLowercaseStringOrEmpty(text);

  // Split into segments (English words, Chinese character sequences, etc.)
  const segments = normalized.split(/[\s\p{P}]+/u).filter(Boolean);

  for (const segment of segments) {
    // Japanese text often mixes scripts (kanji/kana/ASCII) without spaces.
    // Extract script-specific chunks so technical terms like "API" / "バグ" are retained.
    if (/[\u3040-\u30ff]/.test(segment)) {
      const jpParts =
        segment.match(/[a-z0-9_]+|[\u30a0-\u30ffー]+|[\u4e00-\u9fff]+|[\u3040-\u309f]{2,}/g) ?? [];
      for (const part of jpParts) {
        if (/^[\u4e00-\u9fff]+$/.test(part)) {
          tokens.push(part);
          if (!useTrigram) {
            for (let i = 0; i < part.length - 1; i++) {
              tokens.push(part[i] + part[i + 1]);
            }
          }
        } else {
          tokens.push(part);
        }
      }
    } else if (/[\u4e00-\u9fff]/.test(segment)) {
      // Check if segment contains CJK characters (Chinese)
      const chars = Array.from(segment).filter((c) => /[\u4e00-\u9fff]/.test(c));
      if (useTrigram) {
        // In trigram mode, push the whole contiguous CJK block (mirroring the
        // Japanese kanji path). SQLite's trigram FTS requires at least 3 characters
        // per query term — individual characters silently return no results.
        const block = chars.join("");
        if (block.length > 0) {
          tokens.push(block);
        }
      } else {
        // Default mode: unigrams + bigrams for phrase matching
        tokens.push(...chars);
        for (let i = 0; i < chars.length - 1; i++) {
          tokens.push(chars[i] + chars[i + 1]);
        }
      }
    } else if (/[\uac00-\ud7af\u3131-\u3163]/.test(segment)) {
      // For Korean (Hangul syllables and jamo), keep the word as-is unless it is
      // effectively a stop word once trailing particles are removed.
      const stem = stripKoreanTrailingParticle(segment);
      const stemIsStopWord = stem !== null && STOP_WORDS_KO.has(stem);
      if (!STOP_WORDS_KO.has(segment) && !stemIsStopWord) {
        tokens.push(segment);
      }
      // Also emit particle-stripped stems when they are useful keywords.
      if (stem && !STOP_WORDS_KO.has(stem) && isUsefulKoreanStem(stem)) {
        tokens.push(stem);
      }
    } else {
      // For non-CJK, keep as single token
      tokens.push(segment);
    }
  }

  return tokens;
}

/**
 * Extract keywords from a conversational query for FTS search.
 *
 * Examples:
 * - "that thing we discussed about the API" → ["discussed", "API"]
 * - "之前讨论的那个方案" → ["讨论", "方案"]
 * - "what was the solution for the bug" → ["solution", "bug"]
 */
export function extractKeywords(
  query: string,
  opts?: { ftsTokenizer?: "unicode61" | "trigram" },
): string[] {
  const tokens = tokenize(query, opts);
  const keywords: string[] = [];
  const seen = new Set<string>();

  for (const token of tokens) {
    // Skip stop words
    if (isQueryStopWordToken(token)) {
      continue;
    }
    // Skip invalid keywords
    if (!isValidKeyword(token)) {
      continue;
    }
    // Skip duplicates
    if (seen.has(token)) {
      continue;
    }
    seen.add(token);
    keywords.push(token);
  }

  return keywords;
}

/**
 * Expand a query for FTS search.
 * Returns both the original query and extracted keywords for OR-matching.
 *
 * @param query - User's original query
 * @returns Object with original query and extracted keywords
 */
export function expandQueryForFts(
  query: string,
  opts?: { ftsTokenizer?: "unicode61" | "trigram" },
): {
  original: string;
  keywords: string[];
  expanded: string;
} {
  const original = query.trim();
  const keywords = extractKeywords(original, opts);

  // Build expanded query: original terms OR extracted keywords
  // This ensures both exact matches and keyword matches are found
  const expanded = keywords.length > 0 ? `${original} OR ${keywords.join(" OR ")}` : original;

  return { original, keywords, expanded };
}

/**
 * Type for an optional LLM-based query expander.
 * Can be provided to enhance keyword extraction with semantic understanding.
 */
export type LlmQueryExpander = (query: string) => Promise<string[]>;

/**
 * Expand query with optional LLM assistance.
 * Falls back to local extraction if LLM is unavailable or fails.
 */
export async function expandQueryWithLlm(
  query: string,
  llmExpander?: LlmQueryExpander,
  opts?: { ftsTokenizer?: "unicode61" | "trigram" },
): Promise<string[]> {
  // If LLM expander is provided, try it first
  if (llmExpander) {
    try {
      const llmKeywords = await llmExpander(query);
      if (llmKeywords.length > 0) {
        return llmKeywords;
      }
    } catch {
      // LLM failed, fall back to local extraction
    }
  }

  // Fall back to local keyword extraction
  return extractKeywords(query, opts);
}
