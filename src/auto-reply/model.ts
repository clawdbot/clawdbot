// `/model` directive parser for auto-reply messages.
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { splitTrailingAuthProfile } from "../agents/model-ref-profile.js";
import { escapeRegExp } from "../utils.js";

/** Extract and remove a `/model` directive, including optional auth profile/runtime hints. */
export function extractModelDirective(
  body?: string,
  options?: { aliases?: string[] },
): {
  cleaned: string;
  rawModel?: string;
  rawProfile?: string;
  rawRuntime?: string;
  hasDirective: boolean;
} {
  if (!body) {
    return { cleaned: "", hasDirective: false };
  }

  const modelMatch = body.match(
    /(?:^|\s)\/model(?=$|\s|:)\s*:?\s*([A-Za-z0-9_.:@-]+(?:\/[A-Za-z0-9_.:@-]+)*)?(?:\s+(?:--runtime|runtime=|harness=)\s*([A-Za-z0-9_.:-]+))?/i,
  );

  const aliases = normalizeStringEntries(options?.aliases);
  const aliasMatch =
    modelMatch || aliases.length === 0
      ? null
      : body.match(
          new RegExp(
            `(?:^|\\s)\\/(${aliases.map(escapeRegExp).join("|")})(?=$|\\s|:)(?:\\s*:\\s*)?`,
            "i",
          ),
        );

  const match = modelMatch ?? aliasMatch;
  const raw = modelMatch ? modelMatch?.[1]?.trim() : aliasMatch?.[1]?.trim();
  const rawRuntime = modelMatch?.[2]?.trim();

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
    hasDirective: Boolean(match),
  };
}
