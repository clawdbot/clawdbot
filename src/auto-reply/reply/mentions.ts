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

// Word runs carry a name's identity. ZWJ/ZWNJ are word characters for the
// boundary assertions below but stay out of the token class: mention text is
// normalized with those characters stripped, so a derived name may never
// require them.
const NAME_IDENTITY_CHARS = String.raw`\p{L}\p{N}\p{Pc}`;
const NAME_TOKEN_CHARS = String.raw`${NAME_IDENTITY_CHARS}\p{M}`;
const JOINER_CHARS = String.raw`\u200C\u200D`;
// Decoration is written with the joiners normalization strips, and between two
// word runs also with the spacing members put around it, so both stay optional
// where they can appear.
const JOINER_SPACING = String.raw`[${JOINER_CHARS}]*`;
const DECORATION_SPACING = String.raw`[${JOINER_CHARS}\s]*`;
const UNICODE_WORD_CHAR = String.raw`[${NAME_TOKEN_CHARS}${JOINER_CHARS}]`;
const JOINER_RUN = new RegExp(`[${JOINER_CHARS}]+`, "u");
// A token starts at an identity character: marks attach to the character
// before them, they never stand for one. So a mark run that trails decoration
// is decoration too -- the variation selector U+FE0F an emoji carries, the
// enclosing keycap U+20E3 -- while a mark on a letter stays part of its token.
// Deriving a bare mark run as the token would both require decoration nobody
// types and match every unrelated emoji carrying the same mark.
const NAME_TOKEN_SPLIT = new RegExp(`([${NAME_IDENTITY_CHARS}][${NAME_TOKEN_CHARS}]*)`, "gu");
// Decoration is what a member may leave out when typing the name: symbol and
// mark code points (emoji, flags, dingbats), the skin-tone modifiers, and the
// invisible format characters normalization strips. Everything else a name
// spells stays literal -- punctuation such as "-", "/", or "." separates, it
// does not decorate, and making it omittable would hand every existing name
// like "foo-bar" a new bare spelling and with it a new implicit trigger.
const DECORATION_CHAR = new RegExp(
  String.raw`[\p{So}\p{M}\u{1F3FB}-\u{1F3FF}\u200B-\u200F\u202A-\u202E\u2060-\u206F]`,
  "u",
);
// U+FE0F requests emoji presentation and U+20E3 encloses a keycap: a character
// carrying either is typed as a pictograph even when, like the "#" in a
// keycap, it is punctuation on its own.
const EMOJI_PRESENTATION_MARKS = new Set(["\uFE0F", "\u20E3"]);

type DerivedNameParts = {
  leading: string;
  core: string;
  trailing: string;
};

function wrapDerivedMentionPattern(parts: DerivedNameParts): string {
  // JavaScript \b is ASCII-oriented. Derived identity names need Unicode word
  // boundaries so a name is neither missed nor matched inside another word.
  // Edge decoration is optional, so each assertion has to reach across it, or
  // the decoration satisfies the boundary itself and the name matches while
  // glued to another word. The decoration is one optional occurrence of what
  // the name carries: repeating it would consume decoration a member typed
  // beyond the identity, and stripping would take that away with the mention.
  // Joiners sit in the word class, so raw text carrying one right against the
  // core would satisfy the trailing assertion's word character and block the
  // match stripping needs; each seam takes the joiners first. Backtracking
  // cannot cheat past that: a joiner the seam leaves behind is itself the
  // word character the assertion refuses.
  const leading = parts.leading ? `(?:${parts.leading}|)` : "";
  const trailing = parts.trailing ? `(?:${parts.trailing}|)` : "";
  return `(?:@|(?<!${UNICODE_WORD_CHAR}${leading}))${leading}${JOINER_SPACING}${parts.core}${JOINER_SPACING}(?!${trailing}${UNICODE_WORD_CHAR})${trailing}`;
}

function escapeJoinerTolerantLiteral(literal: string): string {
  // Matching runs on normalized text, which has joiners stripped, while
  // stripping runs on the raw text that still carries them. A literal has to
  // accept both forms or an identity built only from a ZWJ sequence can be
  // stripped but never matched.
  const parts = literal.split(JOINER_RUN);
  if (parts.every((part) => part === "")) {
    // Nothing survives normalization. Emitting the optional joiner class alone
    // would match the empty string, i.e. every message.
    return "";
  }
  return parts.map(escapeRegExp).join(JOINER_SPACING);
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
  | { kind: "decoration"; marks: string[]; spaced: boolean };
type DecorationUnit = Extract<NameUnit, { kind: "decoration" }>;
type SeparatorUnit = Extract<NameUnit, { kind: "separator" }>;

function parseNameUnits(name: string): NameUnit[] {
  const units: NameUnit[] = [];
  // Odd indices are captured word tokens; even indices are the gaps around them.
  for (const [index, segment] of name.split(NAME_TOKEN_SPLIT).entries()) {
    if (index % 2 === 1) {
      units.push({ kind: "token", literal: segment });
      continue;
    }
    if (!segment) {
      continue;
    }
    const marks: string[] = [];
    let decorative = true;
    // A non-decoration character is decoration after all when the character
    // following it requests emoji presentation, so its verdict stays pending
    // until the next character either excuses it or confirms it.
    let pending = false;
    for (const char of segment) {
      // Whitespace is spacing, and joiners do not survive normalization: what a
      // typed mention has to carry is the decoration left between them.
      if (/\s/u.test(char) || JOINER_RUN.test(char)) {
        continue;
      }
      if (pending && !EMOJI_PRESENTATION_MARKS.has(char)) {
        decorative = false;
      }
      pending = !DECORATION_CHAR.test(char);
      marks.push(escapeRegExp(char));
    }
    units.push(
      decorative && !pending
        ? { kind: "decoration", marks, spaced: /\s/u.test(segment) }
        : { kind: "separator", literal: segment },
    );
  }
  return units;
}

// A separator is typed as the name spells it. Whitespace inside it stays
// width-flexible, as the literal derivation always read it, and the joiners
// raw text still carries for stripping stay reachable without being required.
function encodeSeparator(unit: SeparatorUnit): string {
  return unit.literal
    .split(/(\s+)/u)
    .filter(Boolean)
    .map((piece) => (/^\s+$/u.test(piece) ? String.raw`\s+` : escapeJoinerTolerantLiteral(piece)))
    .join(JOINER_SPACING);
}

// Decoration at the name's edge. It is offered to the boundary assertions and
// to the match as the sequence the name spells, once, together with the
// spacing that sits between it and the word runs: left out, the bare core
// matches while the decoration stands and stripping takes the name but leaves
// its decoration behind in the command text. The edge never reaches for the
// whitespace on its far side: with no word run there, that whitespace is the
// member's own text rather than part of the name.
function encodeEdgeDecoration(unit: NameUnit | undefined, side: "leading" | "trailing"): string {
  if (unit?.kind !== "decoration") {
    return "";
  }
  const spelled = unit.marks.join(JOINER_SPACING);
  if (!spelled) {
    // A markless edge is spelled with joiners and spacing alone. The joiners
    // are taken at the core's seam, and the whitespace is the member's own.
    return "";
  }
  return side === "leading" ? `${spelled}${DECORATION_SPACING}` : `${DECORATION_SPACING}${spelled}`;
}

// Decoration between two word runs (emoji, flags, symbols) may be typed as
// shown, spaced apart, replaced by whitespace, or omitted -- and, like an
// edge, is taken at most once. A class repeating over it swallowed whatever
// extra decoration a member typed inside the name and stripping removed that
// too. Only code points the name itself carries are accepted, so neither path
// ever consumes unrelated punctuation beside a mention.
function encodeInteriorDecoration(unit: DecorationUnit): string {
  const spelled = unit.marks.join(DECORATION_SPACING);
  if (!spelled) {
    // Joiners vanish from normalized text while whitespace survives it. So a
    // gap spelled with joiners alone may be omitted but never replaced by
    // whitespace -- the spaced spelling normalizes to a different name -- and
    // a spaced gap keeps its separator required while reaching across the
    // joiners the raw text still carries for stripping.
    return unit.spaced ? String.raw`${JOINER_SPACING}\s${DECORATION_SPACING}` : JOINER_SPACING;
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
        ? escapeRegExp(unit.literal)
        : unit.kind === "separator"
          ? encodeSeparator(unit)
          : encodeInteriorDecoration(unit);
  }
  return {
    leading: encodeEdgeDecoration(units[0], "leading"),
    core,
    trailing: encodeEdgeDecoration(units.at(-1), "trailing"),
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
