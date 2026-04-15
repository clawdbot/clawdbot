import {
  compileAllowlist,
  resolveCompiledAllowlistMatch,
  type AllowlistMatch,
} from "openclaw/plugin-sdk/allow-from";
import {
  normalizeHyphenSlug,
  normalizeStringEntries,
  normalizeStringEntriesLower,
} from "openclaw/plugin-sdk/string-normalization-runtime";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/text-runtime";

const SLACK_SLUG_CACHE_MAX = 512;
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
  const withoutPrefix = trimmed.replace(/^(slack:|user:)/, "");
  return /^u[a-z0-9]+$/.test(withoutPrefix) ? withoutPrefix : undefined;
}

export type SlackAllowListMatch = AllowlistMatch<
  "wildcard" | "id" | "prefixed-id" | "prefixed-user" | "name" | "prefixed-name" | "slug"
>;
type SlackAllowListSource = Exclude<SlackAllowListMatch["matchSource"], undefined>;

export function resolveSlackAllowListMatch(params: {
  allowList: string[];
  id?: string;
  name?: string;
  allowNameMatching?: boolean;
}): SlackAllowListMatch {
  const compiledAllowList = compileAllowlist(params.allowList);
  const id = normalizeOptionalLowercaseString(params.id);
  const name = normalizeOptionalLowercaseString(params.name);
  const slug = normalizeSlackSlug(name);
  const candidates: Array<{ value?: string; source: SlackAllowListSource }> = [
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
    candidates,
  });
}

export function allowListMatches(params: {
  allowList: string[];
  id?: string;
  name?: string;
  allowNameMatching?: boolean;
}) {
  return resolveSlackAllowListMatch(params).allowed;
}

export function resolveSlackUserAllowed(params: {
  allowList?: Array<string | number>;
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
    id: params.userId,
    name: params.userName,
    allowNameMatching: params.allowNameMatching,
  });
}
