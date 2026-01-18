import type { AllowlistMatch } from "../../channels/allowlist-match.js";

export function normalizeSlackSlug(raw?: string) {
  const trimmed = raw?.trim().toLowerCase() ?? "";
  if (!trimmed) return "";
  const dashed = trimmed.replace(/\s+/g, "-");
  const cleaned = dashed.replace(/[^a-z0-9#@._+-]+/g, "-");
  return cleaned.replace(/-{2,}/g, "-").replace(/^[-.]+|[-.]+$/g, "");
}

export function normalizeAllowList(list?: Array<string | number>) {
  return (list ?? []).map((entry) => String(entry).trim()).filter(Boolean);
}

export function normalizeAllowListLower(list?: Array<string | number>) {
  return normalizeAllowList(list).map((entry) => entry.toLowerCase());
}

export type SlackAllowListMatch = AllowlistMatch<
  "wildcard" | "id" | "prefixed-id" | "prefixed-user" | "name" | "prefixed-name" | "slug"
>;

export function resolveSlackAllowListMatch(params: {
  allowList: string[];
  id?: string;
  name?: string;
}): SlackAllowListMatch {
  const allowList = params.allowList;
  if (allowList.length === 0) return { allowed: false };
  if (allowList.includes("*")) {
    return { allowed: true, matchKey: "*", matchSource: "wildcard" };
  }
  const id = params.id?.toLowerCase();
  const name = params.name?.toLowerCase();
  const slug = normalizeSlackSlug(name);
  const candidates: Array<{ value?: string; source: SlackAllowListMatch["matchSource"] }> = [
    { value: id, source: "id" },
    { value: id ? `slack:${id}` : undefined, source: "prefixed-id" },
    { value: id ? `user:${id}` : undefined, source: "prefixed-user" },
    { value: name, source: "name" },
    { value: name ? `slack:${name}` : undefined, source: "prefixed-name" },
    { value: slug, source: "slug" },
  ];
  for (const candidate of candidates) {
    if (!candidate.value) continue;
    if (allowList.includes(candidate.value)) {
      return {
        allowed: true,
        matchKey: candidate.value,
        matchSource: candidate.source,
      };
    }
  }
  return { allowed: false };
}

export function allowListMatches(params: { allowList: string[]; id?: string; name?: string }) {
  return resolveSlackAllowListMatch(params).allowed;
}

export function resolveSlackUserAllowed(params: {
  allowList?: Array<string | number>;
  userId?: string;
  userName?: string;
}) {
  const allowList = normalizeAllowListLower(params.allowList);
  if (allowList.length === 0) return true;
  return allowListMatches({
    allowList,
    id: params.userId,
    name: params.userName,
  });
}
