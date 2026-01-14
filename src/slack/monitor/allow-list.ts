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

export function allowListMatches(params: {
  allowList: string[];
  id?: string;
  name?: string;
}) {
  const allowList = params.allowList;
  if (allowList.length === 0) return false;
  if (allowList.includes("*")) return true;
  const id = params.id?.toLowerCase();
  const name = params.name?.toLowerCase();
  const slug = normalizeSlackSlug(name);
  const candidates = [
    id,
    id ? `slack:${id}` : undefined,
    id ? `user:${id}` : undefined,
    name,
    name ? `slack:${name}` : undefined,
    slug,
  ].filter(Boolean) as string[];
  return candidates.some((value) => allowList.includes(value));
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
