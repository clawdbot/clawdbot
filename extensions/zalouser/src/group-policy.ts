import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { ZalouserGroupConfig } from "./types.js";

type ZalouserGroups = Record<string, ZalouserGroupConfig>;

function toGroupCandidate(value?: string | null): string {
  return value?.trim() ?? "";
}

export function normalizeZalouserGroupSlug(raw?: string | null): string {
  const trimmed = normalizeOptionalLowercaseString(raw) ?? "";
  if (!trimmed) {
    return "";
  }
  return trimmed
    .replace(/^#/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function buildZalouserGroupCandidates(params: {
  groupId?: string | null;
  groupChannel?: string | null;
  groupName?: string | null;
  includeGroupIdAlias?: boolean;
  includeWildcard?: boolean;
  allowNameMatching?: boolean;
}): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (value?: string | null) => {
    const normalized = toGroupCandidate(value);
    if (!normalized || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    out.push(normalized);
  };

  const groupId = toGroupCandidate(params.groupId);
  const groupChannel = toGroupCandidate(params.groupChannel);
  const groupName = toGroupCandidate(params.groupName);

  push(groupId);
  if (params.includeGroupIdAlias === true && groupId) {
    push(`group:${groupId}`);
  }
  if (params.allowNameMatching !== false) {
    push(groupChannel);
    push(groupName);
    if (groupName) {
      push(normalizeZalouserGroupSlug(groupName));
    }
  }
  if (params.includeWildcard !== false) {
    push("*");
  }
  return out;
}

export function findZalouserGroupEntry(
  groups: ZalouserGroups | undefined,
  candidates: string[],
): ZalouserGroupConfig | undefined {
  if (!groups) {
    return undefined;
  }
  for (const candidate of candidates) {
    const entry = groups[candidate];
    if (entry) {
      return entry;
    }
  }
  return undefined;
}

export function isZalouserGroupEntryAllowed(entry: ZalouserGroupConfig | undefined): boolean {
  if (!entry) {
    return false;
  }
  const legacyAllow = (entry as ZalouserGroupConfig & { allow?: unknown }).allow;
  return legacyAllow !== false && entry.enabled !== false;
}
