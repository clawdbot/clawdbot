/** Mention matching, stripping, and explicit mention handling for group triggers. */
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { resolveAgentConfig } from "../../agents/agent-scope.js";
import { resolveMentionPatternPolicy } from "../../channels/mention-pattern-policy.js";
import type { ChannelId } from "../../channels/plugins/channel-id.types.js";
import { getLoadedChannelPluginById } from "../../channels/plugins/registry-loaded.js";
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import { normalizeAnyChannelId } from "../../channels/registry.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { compileConfigRegexes, type ConfigRegexRejectReason } from "../../security/config-regex.js";
import { escapeRegExp } from "../../utils.js";
import type { MsgContext } from "../templating.js";
import { HISTORY_CONTEXT_MARKER } from "./history.js";
import type { BuildMentionRegexesOptions, ExplicitMentionSignal } from "./mentions.types.js";
export type { BuildMentionRegexesOptions } from "./mentions.types.js";
export { CURRENT_MESSAGE_MARKER } from "./history.js";

type ResolvedMentionPatterns = {
  patterns: string[];
  unicode: boolean;
};

const NAME_IDENTITY_CHARS = String.raw`\p{L}\p{N}\p{Pc}`;
const NAME_TOKEN_CHARS = String.raw`${NAME_IDENTITY_CHARS}\p{M}`;
const JOINER_CHARS = String.raw`\u200C\u200D`;
const DECORATION_SPACING = String.raw`[${JOINER_CHARS}\s]*`;
const OPTIONAL_JOINER_GAP = String.raw`[${JOINER_CHARS}]*`;
const UNICODE_WORD_CHAR = String.raw`[${NAME_TOKEN_CHARS}${JOINER_CHARS}]`;
const JOINER_RUN = new RegExp(`[${JOINER_CHARS}]+`, "u");
const JOINER_ONLY = new RegExp(`^[${JOINER_CHARS}]+$`, "u");
const OMISSIBLE_DECORATION_CHAR = new RegExp(
  String.raw`[\p{So}\p{M}\u{1F3FB}-\u{1F3FF}\u200B-\u200F\u202A-\u202E\u2060-\u206F\u{E0020}-\u{E007F}]`,
  "u",
);
const EMOJI_PRESENTATION_MARKS = new Set(["\uFE0F", "\u20E3"]);
const EMOJI_PRESENTATION_BASE = /\p{Emoji}/u;
const NAME_IDENTITY_GRAPHEME = new RegExp(`[${NAME_IDENTITY_CHARS}]`, "u");
const NAME_GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

type DerivedNameParts = {
  leading: string;
  core: string;
  trailing: string;
};

function wrapDerivedMentionPattern(parts: DerivedNameParts): string {
  // Boundaries reach across optional edge decoration. Each branch owns its
  // spacing seam because overlapping repetitions make raw stripping quadratic.
  const leading = parts.leading ? `(?:${parts.leading}${DECORATION_SPACING}|)` : "";
  const trailing = parts.trailing
    ? `(?:${DECORATION_SPACING}${parts.trailing}(?!${UNICODE_WORD_CHAR})|(?!${UNICODE_WORD_CHAR})(?!${DECORATION_SPACING}${parts.trailing}${UNICODE_WORD_CHAR}))`
    : `(?!${UNICODE_WORD_CHAR})`;
  return `(?:@|(?<!${UNICODE_WORD_CHAR}${leading}))${leading}${parts.core}${trailing}`;
}

function encodeOptionalJoiners(literal: string): string {
  return literal
    .split(/([\u200C\u200D]+)/u)
    .filter(Boolean)
    .map((part) => (JOINER_ONLY.test(part) ? `(?:${escapeRegExp(part)}|)` : escapeRegExp(part)))
    .join("");
}

function escapeJoinerTolerantLiteral(literal: string): string {
  // Matching runs on normalized text, which has joiners stripped, while
  // stripping runs on the raw text that still carries them. A literal has to
  // accept both forms or an identity built only from a ZWJ sequence can be
  // stripped but never matched.
  if (Array.from(literal).every((character) => JOINER_ONLY.test(character))) {
    // Nothing survives normalization. Emitting the optional joiner class alone
    // would match the empty string, i.e. every message.
    return "";
  }
  return encodeOptionalJoiners(literal);
}

// A name reads as word runs with decoration or separators around and between
// them. It is parsed into those units once and each unit is then encoded for
// the position it sits in, so what decoration means is stated once: it is
// optional, and it is taken at most one time, in the order the name spells it.
// A separator -- any gap carrying a character that is not decoration -- stays
// required exactly as the name spells it. Encoding the positions
// independently is what let a member's repeated decoration count as part of
// the mention -- and be stripped away with it -- at one position while
// another already refused it.
type NameUnit =
  | { kind: "token"; literal: string }
  | { kind: "separator"; literal: string }
  | { kind: "decoration"; literal: string; spellings: string[]; spaced: boolean };
type DecorationUnit = Extract<NameUnit, { kind: "decoration" }>;
type SeparatorUnit = Extract<NameUnit, { kind: "separator" }>;

function isEmojiPresentationGrapheme(grapheme: string): boolean {
  const characters = Array.from(grapheme);
  const first = characters[0];
  return Boolean(
    first &&
    EMOJI_PRESENTATION_BASE.test(first) &&
    characters.some((character) => EMOJI_PRESENTATION_MARKS.has(character)),
  );
}

function isIdentityGrapheme(grapheme: string): boolean {
  return NAME_IDENTITY_GRAPHEME.test(grapheme) && !isEmojiPresentationGrapheme(grapheme);
}

function isDecorationGrapheme(grapheme: string): boolean {
  if (isEmojiPresentationGrapheme(grapheme)) {
    return true;
  }
  return Array.from(grapheme).every(
    (character) =>
      /\s/u.test(character) ||
      JOINER_RUN.test(character) ||
      OMISSIBLE_DECORATION_CHAR.test(character),
  );
}

function parseNameUnits(name: string): NameUnit[] {
  const graphemes = Array.from(NAME_GRAPHEME_SEGMENTER.segment(name), (part) => part.segment);
  const runs: Array<{ identity: boolean; literal: string }> = [];
  for (const grapheme of graphemes) {
    const identity = isIdentityGrapheme(grapheme);
    const previous = runs.at(-1);
    if (previous?.identity === identity) {
      previous.literal += grapheme;
    } else {
      runs.push({ identity, literal: grapheme });
    }
  }
  return runs.map((run) => {
    if (run.identity) {
      return { kind: "token", literal: run.literal };
    }
    const gapGraphemes = Array.from(
      NAME_GRAPHEME_SEGMENTER.segment(run.literal),
      (part) => part.segment,
    );
    if (!gapGraphemes.every(isDecorationGrapheme)) {
      return { kind: "separator", literal: run.literal };
    }
    return {
      kind: "decoration",
      literal: run.literal,
      spellings: gapGraphemes
        .filter((grapheme) => !/^\s+$/u.test(grapheme) && !JOINER_ONLY.test(grapheme))
        .map(escapeJoinerTolerantLiteral),
      spaced: /\s/u.test(run.literal),
    };
  });
}

// A separator is typed as the name spells it. Whitespace inside it stays
// width-flexible, as the literal derivation always read it, and the joiners
// raw text still carries for stripping stay reachable without being required.
function encodeSeparator(unit: SeparatorUnit): string {
  return unit.literal
    .split(/(\s+|[\u200C\u200D]+)/u)
    .filter(Boolean)
    .map((piece) =>
      /^\s+$/u.test(piece)
        ? String.raw`\s+`
        : JOINER_ONLY.test(piece)
          ? encodeOptionalJoiners(piece)
          : escapeRegExp(piece),
    )
    .join("");
}

function encodeEdgeDecorationLiteral(unit: NameUnit | undefined): string {
  if (unit?.kind !== "decoration") {
    return "";
  }
  const spelled = unit.spellings.join(OPTIONAL_JOINER_GAP);
  if (!spelled) {
    // A markless edge is spelled with joiners and spacing alone. The joiners
    // are taken at the core's seam, and the whitespace is the member's own.
    return encodeOptionalJoiners(
      Array.from(unit.literal)
        .filter((character) => JOINER_ONLY.test(character))
        .join(""),
    );
  }
  return spelled;
}

// Decoration between two word runs (emoji, flags, symbols) may be typed as
// shown, spaced apart, replaced by whitespace, or omitted -- and, like an
// edge, is taken at most once. A class repeating over it swallowed whatever
// extra decoration a member typed inside the name and stripping removed that
// too. Only code points the name itself carries are accepted, so neither path
// ever consumes unrelated punctuation beside a mention.
function encodeInteriorDecoration(unit: DecorationUnit): string {
  const spelled = unit.spellings.join(DECORATION_SPACING);
  if (!spelled) {
    // Joiners vanish from normalized text while whitespace survives it. So a
    // gap spelled with joiners alone may be omitted but never replaced by
    // whitespace -- the spaced spelling normalizes to a different name -- and
    // a spaced gap keeps its separator required while reaching across the
    // joiners the raw text still carries for stripping.
    const joiners = encodeOptionalJoiners(
      Array.from(unit.literal)
        .filter((character) => JOINER_ONLY.test(character))
        .join(""),
    );
    return unit.spaced ? String.raw`${joiners}\s${DECORATION_SPACING}` : joiners;
  }
  // A gap carrying whitespace keeps a one-separator floor so the bare
  // concatenation of the surrounding words never matches.
  return `(?:${DECORATION_SPACING}${spelled}${DECORATION_SPACING}|\\s${unit.spaced ? "+" : "*"})`;
}

function deriveNameParts(name: string): DerivedNameParts {
  const units = parseNameUnits(name);
  if (!units.some((unit) => unit.kind === "token")) {
    // No word run at all (e.g. a bare emoji or a punctuation string): match
    // the name literally.
    return { leading: "", core: escapeJoinerTolerantLiteral(name), trailing: "" };
  }
  // Only optional decoration outside the word runs is an edge; a separator
  // there is something a member types, so it stays in the core. The encoders
  // read a token at either end as no decoration at all.
  const start = units[0]?.kind === "decoration" ? 1 : 0;
  const end = units.at(-1)?.kind === "decoration" ? units.length - 1 : units.length;
  let core = "";
  for (const unit of units.slice(start, end)) {
    core +=
      unit.kind === "token"
        ? escapeJoinerTolerantLiteral(unit.literal)
        : unit.kind === "separator"
          ? encodeSeparator(unit)
          : encodeInteriorDecoration(unit);
  }
  return {
    leading: encodeEdgeDecorationLiteral(units[0]),
    core,
    trailing: encodeEdgeDecorationLiteral(units.at(-1)),
  };
}

function deriveMentionPatterns(identity?: { name?: string; emoji?: string }) {
  const patterns: string[] = [];
  const name = normalizeOptionalString(identity?.name);
  const parts = name ? deriveNameParts(name) : undefined;
  if (parts?.core) {
    patterns.push(wrapDerivedMentionPattern(parts));
  }
  const emoji = normalizeOptionalString(identity?.emoji);
  const emojiPattern = emoji ? escapeJoinerTolerantLiteral(emoji) : "";
  if (emojiPattern) {
    patterns.push(emojiPattern);
  }
  return patterns;
}

const BACKSPACE_CHAR = "\u0008";
const mentionMatchRegexCompileCache = new Map<string, RegExp[]>();
const mentionStripRegexCompileCache = new Map<string, RegExp[]>();
const MAX_MENTION_REGEX_COMPILE_CACHE_KEYS = 512;
const mentionPatternWarningCache = new Set<string>();
const MAX_MENTION_PATTERN_WARNING_KEYS = 512;
const log = createSubsystemLogger("mentions");

function normalizeMentionPattern(pattern: string): string {
  if (!pattern.includes(BACKSPACE_CHAR)) {
    return pattern;
  }
  return pattern.split(BACKSPACE_CHAR).join("\\b");
}

function normalizeMentionPatterns(patterns: string[]): string[] {
  return patterns.map(normalizeMentionPattern);
}

function warnRejectedMentionPattern(
  pattern: string,
  flags: string,
  reason: ConfigRegexRejectReason,
) {
  const key = `${flags}::${reason}::${pattern}`;
  if (mentionPatternWarningCache.has(key)) {
    return;
  }
  mentionPatternWarningCache.add(key);
  if (mentionPatternWarningCache.size > MAX_MENTION_PATTERN_WARNING_KEYS) {
    mentionPatternWarningCache.clear();
    mentionPatternWarningCache.add(key);
  }
  log.warn("Ignoring unsupported group mention pattern", {
    pattern,
    flags,
    reason,
  });
}

function cacheMentionRegexes(
  cache: Map<string, RegExp[]>,
  cacheKey: string,
  regexes: RegExp[],
): RegExp[] {
  cache.set(cacheKey, regexes);
  if (cache.size > MAX_MENTION_REGEX_COMPILE_CACHE_KEYS) {
    cache.clear();
    cache.set(cacheKey, regexes);
  }
  return [...regexes];
}

function compileMentionPatternsCached(params: {
  patterns: string[];
  flags: string;
  cache: Map<string, RegExp[]>;
  warnRejected: boolean;
}): RegExp[] {
  if (params.patterns.length === 0) {
    return [];
  }
  const cacheKey = `${params.flags}\u001e${params.patterns.join("\u001f")}`;
  const cached = params.cache.get(cacheKey);
  if (cached) {
    return [...cached];
  }

  const compiled = compileConfigRegexes(params.patterns, params.flags);
  if (params.warnRejected) {
    for (const rejected of compiled.rejected) {
      warnRejectedMentionPattern(rejected.pattern, rejected.flags, rejected.reason);
    }
  }
  return cacheMentionRegexes(params.cache, cacheKey, compiled.regexes);
}

function resolveMentionPatterns(
  cfg: OpenClawConfig | undefined,
  agentId?: string,
): ResolvedMentionPatterns {
  if (!cfg) {
    return { patterns: [], unicode: false };
  }
  const agentConfig = agentId ? resolveAgentConfig(cfg, agentId) : undefined;
  const agentGroupChat = agentConfig?.groupChat;
  if (agentGroupChat && Object.hasOwn(agentGroupChat, "mentionPatterns")) {
    return { patterns: agentGroupChat.mentionPatterns ?? [], unicode: false };
  }
  const globalGroupChat = cfg.messages?.groupChat;
  if (globalGroupChat && Object.hasOwn(globalGroupChat, "mentionPatterns")) {
    return { patterns: globalGroupChat.mentionPatterns ?? [], unicode: false };
  }
  const derived = deriveMentionPatterns(agentConfig?.identity);
  return { patterns: derived, unicode: derived.length > 0 };
}

/** Builds mention regexes from config, agent identity, and channel policy. */
export function buildMentionRegexes(
  cfg: OpenClawConfig | undefined,
  agentId?: string,
  options?: BuildMentionRegexesOptions,
): RegExp[] {
  if (!resolveMentionPatternPolicy({ ...options, cfg, agentId }).enabled) {
    return [];
  }
  const resolved = resolveMentionPatterns(cfg, agentId);
  const patterns = normalizeMentionPatterns(resolved.patterns);
  return compileMentionPatternsCached({
    patterns,
    flags: resolved.unicode ? "iu" : "i",
    cache: mentionMatchRegexCompileCache,
    warnRejected: true,
  });
}

/** Normalizes text before mention matching. */
export function normalizeMentionText(text: string): string {
  return normalizeLowercaseStringOrEmpty(
    (text ?? "").replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f]/g, ""),
  );
}

/** Returns true when text matches one of the configured mention patterns. */
export function matchesMentionPatterns(text: string, mentionRegexes: RegExp[]): boolean {
  if (mentionRegexes.length === 0) {
    return false;
  }
  const cleaned = normalizeMentionText(text ?? "");
  return mentionRegexes.some((re) => re.test(cleaned));
}

/** Combines regex mention matching with provider-native explicit mention metadata. */
export function matchesMentionWithExplicit(params: {
  text: string;
  mentionRegexes: RegExp[];
  explicit?: ExplicitMentionSignal;
  transcript?: string;
}): boolean {
  const cleaned = normalizeMentionText(params.text ?? "");
  const explicit = params.explicit?.isExplicitlyMentioned === true;

  // Check transcript if text is empty and transcript is provided
  const transcriptCleaned = params.transcript ? normalizeMentionText(params.transcript) : "";
  const textToCheck = cleaned || transcriptCleaned;

  return explicit || params.mentionRegexes.some((re) => re.test(textToCheck));
}

/** Removes structural prompt prefixes before mention stripping. */
export function stripStructuralPrefixes(text: string): string {
  if (!text) {
    return "";
  }
  // Ignore wrapper labels, timestamps, and sender prefixes so directive-only
  // detection still works in group batches that include history/context.
  if (text.trimStart().startsWith(HISTORY_CONTEXT_MARKER)) {
    // Flat history has no trustworthy current-message range when users can quote
    // marker text. Leave it non-command-shaped instead of guessing a boundary.
    return text.trim();
  }
  const afterMarker = text;
  const afterEnvelope = afterMarker.replace(/^(?:[ \t]*\[[^\]\n]+\][ \t]*)+/, "");
  const senderPrefixPattern =
    afterEnvelope === afterMarker
      ? /^[ \t]*(?!\/)[^\n:]{1,120}:\s+/gm
      : /^[ \t]*[^\n:]{1,120}:\s+/gm;

  const stripped = afterEnvelope.replace(senderPrefixPattern, "").replace(/\\n/g, " ").trim();
  if (stripped.startsWith("/")) {
    return stripped.replace(/[ \t]+/g, " ");
  }
  return stripped.replace(/\s+/g, " ");
}

/** Removes bot mentions from command text before command normalization. */
export function stripMentions(
  text: string,
  ctx: MsgContext,
  cfg: OpenClawConfig | undefined,
  agentId?: string,
): string {
  let result = text;
  const providerId =
    (ctx.Provider ? normalizeAnyChannelId(ctx.Provider) : null) ??
    (normalizeOptionalLowercaseString(ctx.Provider) as ChannelId | undefined) ??
    null;
  const providerMentions = providerId
    ? (getLoadedChannelPluginById(providerId) as ChannelPlugin | undefined)?.mentions
    : undefined;
  const resolvedPatterns = resolveMentionPatterns(cfg, agentId);
  const configRegexes = compileMentionPatternsCached({
    patterns: normalizeMentionPatterns(resolvedPatterns.patterns),
    flags: resolvedPatterns.unicode ? "giu" : "gi",
    cache: mentionStripRegexCompileCache,
    warnRejected: true,
  });
  const providerRegexes =
    providerMentions?.stripRegexes?.({ ctx, cfg, agentId }) ??
    compileMentionPatternsCached({
      patterns: normalizeMentionPatterns(
        providerMentions?.stripPatterns?.({ ctx, cfg, agentId }) ?? [],
      ),
      flags: "gi",
      cache: mentionStripRegexCompileCache,
      warnRejected: false,
    });
  for (const re of [...configRegexes, ...providerRegexes]) {
    result = result.replace(re, " ");
  }
  if (providerMentions?.stripMentions) {
    result = providerMentions.stripMentions({
      text: result,
      ctx,
      cfg,
      agentId,
    });
  }
  // Generic mention patterns like @123456789 or plain digits
  result = result.replace(/@[0-9+]{5,}/g, " ");
  return result.replace(/\s+/g, " ").trim();
}
