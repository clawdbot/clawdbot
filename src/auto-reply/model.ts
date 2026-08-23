// `/model` directive parser for auto-reply messages.
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { splitTrailingAuthProfile } from "../agents/model-ref-profile.js";
import { escapeRegExp } from "../utils.js";

const MODEL_REF_PATTERN = String.raw`[A-Za-z0-9_.:@-]+(?:\/[A-Za-z0-9_.:@-]+)*`;
const MODEL_RUNTIME_VALUE_PATTERN = String.raw`[A-Za-z0-9_.:-]+`;
const MODEL_OPTION_PATTERN = String.raw`(?:(?:--session|-s|--runtime)(?=$|\s)|runtime=|harness=)`;
const MODEL_SESSION_OPTION_PATTERN = String.raw`(?:--session|-s)(?=$|\s)`;
const MODEL_RUNTIME_OPTION_PATTERN = String.raw`(?:--runtime|runtime=|harness=)\s*((?!${MODEL_OPTION_PATTERN})${MODEL_RUNTIME_VALUE_PATTERN})`;
// Captures 2/3 are runtime-first; 4/5 are session-first so duplicates stay unconsumed.
const MODEL_TRAILING_OPTIONS_PATTERN = String.raw`(?:(?:\s+(?:--runtime|runtime=|harness=)\s*((?!${MODEL_OPTION_PATTERN})${MODEL_RUNTIME_VALUE_PATTERN}))(\s+(?:--session|-s)(?=$|\s))?|(\s+(?:--session|-s)(?=$|\s))(?:\s+(?:--runtime|runtime=|harness=)\s*((?!${MODEL_OPTION_PATTERN})${MODEL_RUNTIME_VALUE_PATTERN}))?)?`;
const MODEL_OPTIONS_ONLY_DIRECTIVE_PATTERN = new RegExp(
  String.raw`(?:^|\s)\/model(?=$|\s|:)\s*:?\s*(?:${MODEL_RUNTIME_OPTION_PATTERN}(\s+${MODEL_SESSION_OPTION_PATTERN})?|(${MODEL_SESSION_OPTION_PATTERN})(?:\s+${MODEL_RUNTIME_OPTION_PATTERN})?)`,
  "i",
);
const MODEL_DIRECTIVE_PATTERN = new RegExp(
  String.raw`(?:^|\s)\/model(?=$|\s|:)\s*:?\s*((?!${MODEL_OPTION_PATTERN})${MODEL_REF_PATTERN})?${MODEL_TRAILING_OPTIONS_PATTERN}`,
  "i",
);

function parseModelDirectiveMatch(match: RegExpMatchArray | null) {
  return {
    rawModel: match?.[1]?.trim(),
    rawRuntime: (match?.[2] ?? match?.[5])?.trim(),
    sessionOnly: Boolean(match?.[3] ?? match?.[4]),
  };
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
  sessionOnly: boolean;
  hasDirective: boolean;
  source?: "alias" | "model";
} {
  if (!body) {
    return { cleaned: "", sessionOnly: false, hasDirective: false };
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
        sessionOnly: Boolean(modelOptionsOnlyMatch[2] ?? modelOptionsOnlyMatch[3]),
      }
    : parseModelDirectiveMatch(match);
  const { rawModel: raw, rawRuntime, sessionOnly } = parsed;

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
    sessionOnly,
    hasDirective: Boolean(match),
    ...(match ? { source: modelMatch ? ("model" as const) : ("alias" as const) } : {}),
  };
}
