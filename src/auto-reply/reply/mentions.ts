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
import type { BuildMentionRegexesOptions, ExplicitMentionSignal } from "./mentions.types.js";
export type { BuildMentionRegexesOptions } from "./mentions.types.js";

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
const UNICODE_WORD_CHAR = String.raw`[${NAME_TOKEN_CHARS}\u200C\u200D]`;
// Decoration between word runs (emoji, flags, symbols, punctuation) may be
// typed as shown, replaced by whitespace, or omitted. Only code points the
// name itself carries are accepted, so matching and stripping never consume
// unrelated punctuation adjacent to a mention.
// A token has to carry an identity character: marks attach to one, they never
// stand for one. A run of bare marks is presentation -- the variation selector
// U+FE0F an emoji identity name carries, the enclosing keycap U+20E3 -- and
// requiring it as the token would match every unrelated emoji carrying the
// same mark.
const NAME_TOKEN_SPLIT = new RegExp(
  `([${NAME_TOKEN_CHARS}]*[${NAME_IDENTITY_CHARS}][${NAME_TOKEN_CHARS}]*)`,
  "gu",
);

type DerivedNameParts = {
  leading: string;
  core: string;
  trailing: string;
};

function wrapDerivedMentionPattern(parts: DerivedNameParts): string {
  // JavaScript \b is ASCII-oriented. Derived identity names need Unicode word
  // boundaries so a name is neither missed nor matched inside another word.
  // Edge decoration is optional, so each assertion has to reach across it:
  // checked next to the tokens instead, the class matches nothing and the
  // decoration itself satisfies the boundary, letting the name match while
  // glued to another word.
  const before = parts.leading
    ? `(?<!${UNICODE_WORD_CHAR}[${parts.leading}]*)`
    : `(?<!${UNICODE_WORD_CHAR})`;
  const after = parts.trailing
    ? `(?![${parts.trailing}]*${UNICODE_WORD_CHAR})`
    : `(?!${UNICODE_WORD_CHAR})`;
  const leading = parts.leading ? `[${parts.leading}]*` : "";
  const trailing = parts.trailing ? `[${parts.trailing}]*` : "";
  return `(?:@|${before})${leading}${parts.core}${after}${trailing}`;
}

function decorationClassBody(gap: string): string {
  const bodies = new Set<string>();
  for (const char of gap) {
    const codePoint = char.codePointAt(0);
    if (codePoint === undefined || /\s/u.test(char)) {
      continue;
    }
    bodies.add(`\\u{${codePoint.toString(16)}}`);
  }
  return [...bodies].join("");
}

function deriveNameParts(name: string): DerivedNameParts {
  // Odd indices are captured word tokens; even indices are the gaps around them.
  const segments = name.split(NAME_TOKEN_SPLIT);
  const tokens = segments.filter((_, index) => index % 2 === 1);
  if (tokens.length === 0) {
    // Decoration-only name (e.g. a bare emoji): match it literally.
    return { leading: "", core: escapeRegExp(name), trailing: "" };
  }
  let core = "";
  for (const [index, token] of tokens.entries()) {
    if (index > 0) {
      const gap = segments[index * 2] ?? "";
      const decorations = decorationClassBody(gap);
      // Plain spacing stays required; decoration-only gaps are optional
      // separators. A gap carrying whitespace keeps a one-separator floor so
      // the bare concatenation of the surrounding words never matches.
      core += decorations ? `[\\s${decorations}]${/\s/u.test(gap) ? "+" : "*"}` : String.raw`\s+`;
    }
    core += escapeRegExp(token);
  }
  return {
    leading: decorationClassBody(segments[0] ?? ""),
    core,
    trailing: decorationClassBody(segments[segments.length - 1] ?? ""),
  };
}

function deriveMentionPatterns(identity?: { name?: string; emoji?: string }) {
  const patterns: string[] = [];
  const name = normalizeOptionalString(identity?.name);
  if (name) {
    patterns.push(wrapDerivedMentionPattern(deriveNameParts(name)));
  }
  const emoji = normalizeOptionalString(identity?.emoji);
  if (emoji) {
    patterns.push(escapeRegExp(emoji));
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

export const CURRENT_MESSAGE_MARKER = "[Current message - respond to this]";

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
  const afterMarker = text.includes(CURRENT_MESSAGE_MARKER)
    ? text.slice(text.indexOf(CURRENT_MESSAGE_MARKER) + CURRENT_MESSAGE_MARKER.length).trimStart()
    : text;
  const afterEnvelope = afterMarker.replace(/\[[^\]]+\]\s*/g, "");
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
