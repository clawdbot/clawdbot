function normalizeAllowList(list?: Array<string | number>) {
  return (list ?? []).map((entry) => String(entry).trim()).filter(Boolean);
}

export function normalizeAllowListLower(list?: Array<string | number>) {
  return normalizeAllowList(list).map((entry) => entry.toLowerCase());
}

function normalizeMatrixUser(raw?: string | null): string {
  return (raw ?? "").trim().toLowerCase();
}

export function resolveMatrixAllowListMatches(params: {
  allowList: string[];
  userId?: string;
  userName?: string;
}) {
  const allowList = params.allowList;
  if (allowList.length === 0) return false;
  if (allowList.includes("*")) return true;
  const userId = normalizeMatrixUser(params.userId);
  const userName = normalizeMatrixUser(params.userName);
  const localPart = userId.startsWith("@") ? (userId.slice(1).split(":")[0] ?? "") : "";
  const candidates = [
    userId,
    userId ? `matrix:${userId}` : "",
    userId ? `user:${userId}` : "",
    userName,
    localPart,
  ].filter(Boolean);
  return candidates.some((value) => allowList.includes(value));
}
