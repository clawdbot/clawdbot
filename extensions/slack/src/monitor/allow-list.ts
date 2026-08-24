// Slack plugin module implements allow list behavior.
import {
  compileAllowlist,
  resolveCompiledAllowlistMatch,
  type AllowlistMatch,
} from "openclaw/plugin-sdk/allow-from";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  normalizeHyphenSlug,
  normalizeStringEntries,
  normalizeStringEntriesLower,
} from "openclaw/plugin-sdk/string-normalization-runtime";
import { parseSlackTarget } from "../target-parsing.js";

const SLACK_SLUG_CACHE_MAX = 512;
const SLACK_STABLE_USER_ID_RE = /^[ubw][a-z0-9]+$/;
const slackSlugCache = new Map<string, string>();

export function normalizeSlackSlug(raw?: string) {
  const key = raw ?? "";
  const cached = slackSlugCache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const normalized = normalizeHyphenSlug(raw);
  slackSlugCache.set(key, normalized);
  if (slackSlugCache.size > SLACK_SLUG_CACHE_MAX) {
    const oldest = slackSlugCache.keys().next();
    if (!oldest.done) {
      slackSlugCache.delete(oldest.value);
    }
  }
  return normalized;
}

export function normalizeAllowList(list?: Array<string | number>) {
  return normalizeStringEntries(list);
}

export function normalizeAllowListLower(list?: Array<string | number>) {
  return normalizeStringEntriesLower(list);
}

export function normalizeSlackAllowOwnerEntry(entry: string): string | undefined {
  const trimmed = normalizeOptionalLowercaseString(entry);
  if (!trimmed || trimmed === "*") {
    return undefined;
  }
  try {
    const target = parseSlackTarget(trimmed);
    if (target?.kind === "user" && target.teamId) {
      return target.id.toLowerCase();
    }
  } catch {
    return undefined;
  }
  const withoutPrefix = trimmed.replace(/^(slack:|user:)/, "");
  return SLACK_STABLE_USER_ID_RE.test(withoutPrefix) ? withoutPrefix : undefined;
}

export type SlackAllowListMatch = AllowlistMatch<
  | "wildcard"
  | "workspace-id"
  | "id"
  | "prefixed-id"
  | "prefixed-user"
  | "name"
  | "prefixed-name"
  | "slug"
>;
type SlackAllowListSource = Exclude<SlackAllowListMatch["matchSource"], undefined>;

export function resolveSlackAllowListMatch(params: {
  allowList: readonly string[];
  teamId?: string;
  id?: string;
  name?: string;
  allowNameMatching?: boolean;
}): SlackAllowListMatch {
  const compiledAllowList = compileAllowlist(params.allowList);
  const teamId = normalizeOptionalLowercaseString(params.teamId);
  const id = normalizeOptionalLowercaseString(params.id);
  const name = normalizeOptionalLowercaseString(params.name);
  const slug = normalizeSlackSlug(name);
  const scopedCandidates: Array<{ value?: string; source: SlackAllowListSource }> = [
    {
      value: teamId && id ? `team:${teamId}:user:${id}` : undefined,
      source: "workspace-id",
    },
  ];
  const unscopedCandidates: Array<{ value?: string; source: SlackAllowListSource }> = [
    { value: id, source: "id" },
    { value: id ? `slack:${id}` : undefined, source: "prefixed-id" },
    { value: id ? `user:${id}` : undefined, source: "prefixed-user" },
    ...(params.allowNameMatching === true
      ? ([
          { value: name, source: "name" as const },
          { value: name ? `slack:${name}` : undefined, source: "prefixed-name" as const },
          { value: slug, source: "slug" as const },
        ] satisfies Array<{ value?: string; source: SlackAllowListSource }>)
      : []),
  ];
  return resolveCompiledAllowlistMatch({
    compiledAllowlist: compiledAllowList,
    candidates: [...scopedCandidates, ...unscopedCandidates],
  });
}

export function allowListMatches(params: {
  allowList: string[];
  teamId?: string;
  id?: string;
  name?: string;
  allowNameMatching?: boolean;
}) {
  return resolveSlackAllowListMatch(params).allowed;
}

export function resolveSlackUserAllowed(params: {
  allowList?: Array<string | number>;
  teamId?: string;
  userId?: string;
  userName?: string;
  allowNameMatching?: boolean;
}) {
  const allowList = normalizeAllowListLower(params.allowList);
  if (allowList.length === 0) {
    return true;
  }
  return allowListMatches({
    allowList,
    teamId: params.teamId,
    id: params.userId,
    name: params.userName,
    allowNameMatching: params.allowNameMatching,
  });
}

export function resolveSlackUserAllowListForTeam(params: {
  allowList?: Array<string | number>;
  teamId?: string;
  preserveUnmatchedScopedEntries?: boolean;
}): string[] {
  const allowList = normalizeAllowListLower(params.allowList);
  const teamId = normalizeOptionalLowercaseString(params.teamId);
  return allowList.flatMap((entry) => {
    if (entry === "*") {
      return [entry];
    }
    if (!entry.startsWith("team:")) {
      return [entry];
    }
    try {
      const target = parseSlackTarget(entry);
      if (target?.kind === "user" && target.teamId?.toLowerCase() === teamId) {
        return [entry];
      }
      return params.preserveUnmatchedScopedEntries ? [entry] : [];
    } catch {
      return params.preserveUnmatchedScopedEntries ? [entry] : [];
    }
  });
}
