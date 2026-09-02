// Zalouser plugin module implements group policy behavior.
import type { ScopeTree } from "openclaw/plugin-sdk/channel-policy";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { ZalouserGroupConfig } from "./types.js";

type ZalouserGroups = Record<string, ZalouserGroupConfig>;

const toGroupCandidate = (value?: string | null) => value?.trim() ?? "";

function normalizeZalouserGroupSlug(raw?: string | null): string {
  const trimmed = normalizeOptionalLowercaseString(raw) ?? "";
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
    [groupChannel, groupName, normalizeZalouserGroupSlug(groupName)].forEach(push);
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
  const { tree, path } = resolveZalouserGroupScope(groups, candidates);
  const key = path[0];
  return key ? (tree.scopes[key] as ZalouserGroupConfig | undefined) : undefined;
}

export function resolveZalouserGroupScope(
  groups: ZalouserGroups | undefined,
  candidates: string[],
) {
  // Whole-entry selection: an exact candidate hides every wildcard field.
  // Candidate construction owns aliases, names, and wildcard opt-in; the monitor
  // requests group:<id>, groupName, and "*" through buildZalouserGroupCandidates.
  const tree: ScopeTree = { scopes: groups ?? {} };
  const key =
    candidates.find((candidate) => candidate !== "*" && Object.hasOwn(tree.scopes, candidate)) ??
    (candidates.includes("*") && Object.hasOwn(tree.scopes, "*") ? "*" : undefined);
  return { tree, path: key ? [key] : [] };
}

export function isZalouserGroupEntryAllowed(entry: ZalouserGroupConfig | undefined): boolean {
  if (!entry) {
    return false;
  }
  const legacyAllow = (entry as ZalouserGroupConfig & { allow?: unknown }).allow;
  return legacyAllow !== false && entry.enabled !== false;
}
