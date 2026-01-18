import type { AllowlistMatch } from "clawdbot/plugin-sdk";

function normalizeAllowList(list?: Array<string | number>) {
  return (list ?? []).map((entry) => String(entry).trim()).filter(Boolean);
}

export function normalizeAllowListLower(list?: Array<string | number>) {
  return normalizeAllowList(list).map((entry) => entry.toLowerCase());
}

function normalizeMatrixUser(raw?: string | null): string {
  return (raw ?? "").trim().toLowerCase();
}

export type MatrixAllowListMatch = AllowlistMatch<
  "wildcard" | "id" | "prefixed-id" | "prefixed-user" | "name" | "localpart"
>;

export function resolveMatrixAllowListMatch(params: {
  allowList: string[];
  userId?: string;
  userName?: string;
}): MatrixAllowListMatch {
  const allowList = params.allowList;
  if (allowList.length === 0) return { allowed: false };
  if (allowList.includes("*")) {
    return { allowed: true, matchKey: "*", matchSource: "wildcard" };
  }
  const userId = normalizeMatrixUser(params.userId);
  const userName = normalizeMatrixUser(params.userName);
  const localPart = userId.startsWith("@") ? (userId.slice(1).split(":")[0] ?? "") : "";
  const candidates: Array<{ value?: string; source: MatrixAllowListMatch["matchSource"] }> = [
    { value: userId, source: "id" },
    { value: userId ? `matrix:${userId}` : "", source: "prefixed-id" },
    { value: userId ? `user:${userId}` : "", source: "prefixed-user" },
    { value: userName, source: "name" },
    { value: localPart, source: "localpart" },
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

export function resolveMatrixAllowListMatches(params: {
  allowList: string[];
  userId?: string;
  userName?: string;
}) {
  return resolveMatrixAllowListMatch(params).allowed;
}
