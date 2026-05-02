import { readSnakeCaseParamRaw } from "./param-key.js";
import { normalizeLowercaseStringOrEmpty } from "./shared/string-coerce.js";

type PollCreationParamKind = "string" | "stringArray" | "number" | "boolean";

type PollCreationParamDef = {
  kind: PollCreationParamKind;
};

const SHARED_POLL_CREATION_PARAM_DEFS = {
  pollQuestion: { kind: "string" },
  pollOption: { kind: "stringArray" },
  pollDurationHours: { kind: "number" },
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
      const parsed = Number(trimmed);
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

export function hasPollCreationParams(params: Record<string, unknown>): boolean {
  for (const key of SHARED_POLL_CREATION_PARAM_NAMES) {
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
    if (def.kind === "number") {
      // Treat zero-valued numeric defaults as unset, but preserve any non-zero
      // numeric value as explicit poll intent so invalid durations still hit
      // the poll-only validation path.
      if (typeof value === "number" && Number.isFinite(value) && value !== 0) {
        return true;
      }
      if (typeof value === "string") {
        const trimmed = value.trim();
        const parsed = Number(trimmed);
        if (trimmed.length > 0 && Number.isFinite(parsed) && parsed !== 0) {
          return true;
        }
      }
    }
    if (def.kind === "boolean") {
      if (value === true) {
        return true;
      }
      if (typeof value === "string" && normalizeLowercaseStringOrEmpty(value) === "true") {
        return true;
      }
    }
  }
  for (const [key, value] of Object.entries(params)) {
    if (isChannelPollCreationParamName(key) && hasExplicitUnknownPollValue(key, value)) {
      return true;
    }
  }
  return false;
}
