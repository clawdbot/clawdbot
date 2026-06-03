import { parseStrictFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { readSnakeCaseParamRaw } from "./param-key.js";

type PollCreationParamKind = "string" | "stringArray" | "positiveInteger" | "boolean";

type PollCreationParamDef = {
  kind: PollCreationParamKind;
};

const SHARED_POLL_CREATION_PARAM_DEFS = {
  pollQuestion: { kind: "string" },
  pollOption: { kind: "stringArray" },
  pollDurationHours: { kind: "positiveInteger" },
  pollMulti: { kind: "boolean" },
} satisfies Record<string, PollCreationParamDef>;

export const POLL_CREATION_PARAM_DEFS: Record<string, PollCreationParamDef> =
  SHARED_POLL_CREATION_PARAM_DEFS;

type SharedPollCreationParamName = keyof typeof SHARED_POLL_CREATION_PARAM_DEFS;

export const SHARED_POLL_CREATION_PARAM_NAMES = Object.keys(
  SHARED_POLL_CREATION_PARAM_DEFS,
) as SharedPollCreationParamName[];
const SHARED_POLL_CREATION_PARAM_KEY_SET = new Set(
  SHARED_POLL_CREATION_PARAM_NAMES.map(normalizePollParamKey),
);
const POLL_VOTE_PARAM_KEY_SET = new Set(
  ["pollId", "pollOptionId", "pollOptionIds", "pollOptionIndex", "pollOptionIndexes"].map(
    normalizePollParamKey,
  ),
);

function readPollParamRaw(params: Record<string, unknown>, key: string): unknown {
  return readSnakeCaseParamRaw(params, key);
}

function normalizePollParamKey(key: string): string {
  return normalizeLowercaseStringOrEmpty(key.replaceAll("_", ""));
}

function isChannelPollCreationParamName(key: string): boolean {
  const normalized = normalizePollParamKey(key);
  return (
    normalized.startsWith("poll") &&
    !SHARED_POLL_CREATION_PARAM_KEY_SET.has(normalized) &&
    !POLL_VOTE_PARAM_KEY_SET.has(normalized)
  );
}

function hasExplicitUnknownPollValue(key: string, value: unknown): boolean {
  if (value === true) {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) && value !== 0;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return false;
    }
    if (normalizePollParamKey(key).includes("duration")) {
      const parsed = parseStrictFiniteNumber(trimmed);
      return Number.isFinite(parsed) && parsed !== 0;
    }
    const normalized = normalizeLowercaseStringOrEmpty(trimmed);
    return normalized !== "false" && normalized !== "0";
  }
  if (Array.isArray(value)) {
    return value.some((entry) => hasExplicitUnknownPollValue(key, entry));
  }
  return false;
}

// Among the shared poll params, only the content-bearing fields (pollQuestion,
// pollOption) signal poll intent on their own. The modifier fields
// (pollDurationHours, pollMulti) are exposed by the shared `message` tool
// schema for both `send` and `poll` actions, so LLMs routinely echo their
// schema-implied defaults (`1`, `false`) on plain `send` calls — see issue
// for context. Treating those modifier defaults as "the agent meant to create
// a poll" produces false positives and blocks routine sends. The modifiers
// only count when accompanied by a content-bearing field.
const CONTENT_BEARING_SHARED_POLL_PARAM_NAMES = ["pollQuestion", "pollOption"] as const;

function hasContentBearingPollCreationParam(params: Record<string, unknown>): boolean {
  for (const key of CONTENT_BEARING_SHARED_POLL_PARAM_NAMES) {
    const def = POLL_CREATION_PARAM_DEFS[key];
    const value = readPollParamRaw(params, key);
    if (def.kind === "string" && typeof value === "string" && value.trim().length > 0) {
      return true;
    }
    if (def.kind === "stringArray") {
      if (
        Array.isArray(value) &&
        value.some((entry) => typeof entry === "string" && entry.trim())
      ) {
        return true;
      }
      if (typeof value === "string" && value.trim().length > 0) {
        return true;
      }
    }
  }
  return false;
}

export function hasPollCreationParams(params: Record<string, unknown>): boolean {
  if (hasContentBearingPollCreationParam(params)) {
    return true;
  }
  // Channel-specific poll-prefixed params (e.g. pollDurationSeconds,
  // pollPublic) are not part of the shared schema, so an explicit value still
  // indicates deliberate poll intent and continues to trigger the validator
  // even without a pollQuestion/pollOption.
  for (const [key, value] of Object.entries(params)) {
    if (isChannelPollCreationParamName(key) && hasExplicitUnknownPollValue(key, value)) {
      return true;
    }
  }
  return false;
}
