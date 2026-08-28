// `/model` directive parser for auto-reply messages.
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { splitTrailingAuthProfile } from "../agents/model-ref-profile.js";
import type { ModelSelectionScope } from "../config/types.agent-defaults.js";
import { escapeRegExp } from "../utils.js";

export type { ModelSelectionScope } from "../config/types.agent-defaults.js";

const MODEL_REF_PATTERN = String.raw`[A-Za-z0-9_.:@-]+(?:\/[A-Za-z0-9_.:@-]+)*`;
const MODEL_RUNTIME_VALUE_PATTERN = String.raw`[A-Za-z0-9_.:-]+`;
const MODEL_SCOPE_OPTION_PATTERN = String.raw`(?:--session|-s|--agent|-a|--global|-g)(?=$|\s)`;
const MODEL_OPTION_PATTERN = String.raw`(?:(?:${MODEL_SCOPE_OPTION_PATTERN}|--runtime)(?=$|\s)|runtime=|harness=)`;
const MODEL_RUNTIME_OPTION_PATTERN = String.raw`(?:--runtime|runtime=|harness=)\s*((?!${MODEL_OPTION_PATTERN})${MODEL_RUNTIME_VALUE_PATTERN})`;
// Captures 2/3 are runtime-first; 4/5 are scope-first so duplicates stay unconsumed.
const MODEL_TRAILING_OPTIONS_PATTERN = String.raw`(?:(?:\s+(?:--runtime|runtime=|harness=)\s*((?!${MODEL_OPTION_PATTERN})${MODEL_RUNTIME_VALUE_PATTERN}))(\s+${MODEL_SCOPE_OPTION_PATTERN})?|(\s+${MODEL_SCOPE_OPTION_PATTERN})(?:\s+(?:--runtime|runtime=|harness=)\s*((?!${MODEL_OPTION_PATTERN})${MODEL_RUNTIME_VALUE_PATTERN}))?)?`;
const MODEL_OPTIONS_ONLY_DIRECTIVE_PATTERN = new RegExp(
  String.raw`(?:^|\s)\/model(?=$|\s|:)\s*:?\s*(?:${MODEL_RUNTIME_OPTION_PATTERN}(\s+${MODEL_SCOPE_OPTION_PATTERN})?|(${MODEL_SCOPE_OPTION_PATTERN})(?:\s+${MODEL_RUNTIME_OPTION_PATTERN})?)`,
  "i",
);
const MODEL_DIRECTIVE_PATTERN = new RegExp(
  String.raw`(?:^|\s)\/model(?=$|\s|:)\s*:?\s*((?!${MODEL_OPTION_PATTERN})${MODEL_REF_PATTERN})?${MODEL_TRAILING_OPTIONS_PATTERN}`,
  "i",
);

function parseModelScope(raw: string | undefined): ModelSelectionScope | undefined {
  switch (raw?.trim().toLowerCase()) {
    case "-s":
    case "--session":
      return "session";
    case "-a":
    case "--agent":
      return "agent";
    case "-g":
    case "--global":
      return "global";
    default:
      return undefined;
  }
}

function parseModelDirectiveMatch(match: RegExpMatchArray | null) {
  return {
    rawModel: match?.[1]?.trim(),
    rawRuntime: (match?.[2] ?? match?.[5])?.trim(),
    scope: parseModelScope(match?.[3] ?? match?.[4]),
  };
}

function hasAdditionalModelScope(body: string, match: RegExpMatchArray | null): boolean {
  if (!match || match.index === undefined) {
    return false;
  }
  const trailing = body.slice(match.index + match[0].length);
  return new RegExp(String.raw`^\s+${MODEL_SCOPE_OPTION_PATTERN}`, "i").test(trailing);
}

/** Extract and remove a `/model` directive, including optional auth profile/runtime hints. */
export function extractModelDirective(
  body?: string,
  options?: { aliases?: string[] },
): {
  cleaned: string;
  rawModel?: string;
  rawProfile?: string;
  rawRuntime?: string;
  scope?: ModelSelectionScope;
  scopeConflict: boolean;
  hasDirective: boolean;
  source?: "alias" | "model";
} {
  if (!body) {
    return { cleaned: "", scopeConflict: false, hasDirective: false };
  }

  const modelOptionsOnlyMatch = body.match(MODEL_OPTIONS_ONLY_DIRECTIVE_PATTERN);
  const modelMatch = modelOptionsOnlyMatch ?? body.match(MODEL_DIRECTIVE_PATTERN);

  const aliases = normalizeStringEntries(options?.aliases);
  const aliasMatch =
    modelMatch || aliases.length === 0
      ? null
      : body.match(
          new RegExp(
            String.raw`(?:^|\s)\/(${aliases.map(escapeRegExp).join("|")})(?=$|\s|:)(?:\s*:)?${MODEL_TRAILING_OPTIONS_PATTERN}`,
            "i",
          ),
        );

  const match = modelMatch ?? aliasMatch;
  const parsed = modelOptionsOnlyMatch
    ? {
        rawModel: undefined,
        rawRuntime: (modelOptionsOnlyMatch[1] ?? modelOptionsOnlyMatch[4])?.trim(),
        scope: parseModelScope(modelOptionsOnlyMatch[2] ?? modelOptionsOnlyMatch[3]),
      }
    : parseModelDirectiveMatch(match);
  const { rawModel: raw, rawRuntime, scope } = parsed;

  let rawModel = raw;
  let rawProfile: string | undefined;
  if (raw) {
    const split = splitTrailingAuthProfile(raw);
    rawModel = split.model;
    rawProfile = split.profile;
  }

  const cleaned = match ? body.replace(match[0], " ").replace(/\s+/g, " ").trim() : body.trim();

  return {
    cleaned,
    rawModel,
    rawProfile,
    rawRuntime,
    scope,
    scopeConflict: hasAdditionalModelScope(body, match),
    hasDirective: Boolean(match),
    ...(match ? { source: modelMatch ? ("model" as const) : ("alias" as const) } : {}),
  };
}
