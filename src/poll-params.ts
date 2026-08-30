import { expectDefined } from "@openclaw/normalization-core";
// Parses poll command parameters into validated polling options.
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

function readPollParamRaw(params: Record<string, unknown>, key: string): unknown {
  return readSnakeCaseParamRaw(params, key);
}

// Among the shared poll params, only the content-bearing fields (pollQuestion,
// pollOption) signal poll intent on their own. The modifier fields
// (pollDurationHours, pollMulti) and channel-specific metadata
// (pollDurationSeconds, pollPublic, pollAnonymous) are also exposed on the
// shared `message` tool schema, so schema-padded plain sends may echo them.
// Only content fields count here; action="poll" validates modifiers later.
const CONTENT_BEARING_SHARED_POLL_PARAM_NAMES = ["pollQuestion", "pollOption"] as const;

function hasContentBearingPollCreationParam(params: Record<string, unknown>): boolean {
  for (const key of CONTENT_BEARING_SHARED_POLL_PARAM_NAMES) {
    const def = expectDefined(
      POLL_CREATION_PARAM_DEFS[key],
      "poll creation param defs entry at key",
    );
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
  return hasContentBearingPollCreationParam(params);
}
