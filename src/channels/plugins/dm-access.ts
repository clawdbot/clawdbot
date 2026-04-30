import { normalizeStringEntries } from "../../shared/string-normalization.js";

export type ChannelDmAllowFromMode = "topOnly" | "topOrNested" | "nestedOnly";
export type ChannelDmPolicy = "pairing" | "allowlist" | "open" | "disabled";

export type ChannelDmAccess = {
  dmPolicy?: ChannelDmPolicy;
  allowFrom?: Array<string | number>;
};

export type DmAccessRecord = Record<string, unknown>;

type DmFieldKind = "policy" | "allowFrom";

type DmFieldPaths = {
  canonicalPath: readonly string[];
  legacyPath: readonly string[];
};

export type CompatMutationResult = {
  entry: DmAccessRecord;
  changed: boolean;
};

export function normalizeChannelDmPolicy(value: string | undefined): ChannelDmPolicy | undefined {
  return value === "pairing" || value === "allowlist" || value === "open" || value === "disabled"
    ? value
    : undefined;
}

function asObjectRecord(value: unknown): DmAccessRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as DmAccessRecord)
    : null;
}

function cloneDm(entry: DmAccessRecord): DmAccessRecord | null {
  const dm = asObjectRecord(entry.dm);
  return dm ? { ...dm } : null;
}

function resolveDmFieldPaths(mode: ChannelDmAllowFromMode, kind: DmFieldKind): DmFieldPaths {
  const topKey = kind === "policy" ? "dmPolicy" : "allowFrom";
  const nestedKey = kind === "policy" ? "policy" : "allowFrom";
  if (mode === "nestedOnly") {
    return {
      canonicalPath: ["dm", nestedKey],
      legacyPath: [topKey],
    };
  }
  return {
    canonicalPath: [topKey],
    legacyPath: ["dm", nestedKey],
  };
}

function readPath(entry: DmAccessRecord | null | undefined, path: readonly string[]): unknown {
  let current: unknown = entry;
  for (const segment of path) {
    const record = asObjectRecord(current);
    if (!record) {
      return undefined;
    }
    current = record[segment];
  }
  return current;
}

function deletePath(entry: DmAccessRecord, path: readonly string[]): boolean {
  if (path.length === 1) {
    if (entry[path[0]] === undefined) {
      return false;
    }
    delete entry[path[0]];
    return true;
  }
  const parent = asObjectRecord(entry[path[0]]);
  if (!parent || parent[path[1]] === undefined) {
    return false;
  }
  delete parent[path[1]];
  if (Object.keys(parent).length === 0) {
    delete entry[path[0]];
  } else {
    entry[path[0]] = parent;
  }
  return true;
}

function writePath(entry: DmAccessRecord, path: readonly string[], value: unknown): void {
  if (path.length === 1) {
    entry[path[0]] = value;
    return;
  }
  const parent = asObjectRecord(entry[path[0]]) ? { ...(entry[path[0]] as DmAccessRecord) } : {};
  parent[path[1]] = value;
  entry[path[0]] = parent;
}

function allowFromListsMatch(left: unknown, right: unknown): boolean {
  if (!Array.isArray(left) || !Array.isArray(right)) {
    return false;
  }
  const normalizedLeft = normalizeStringEntries(left);
  const normalizedRight = normalizeStringEntries(right);
  if (normalizedLeft.length !== normalizedRight.length) {
    return false;
  }
  return normalizedLeft.every((value, index) => value === normalizedRight[index]);
}

function formatPath(pathPrefix: string, path: readonly string[]): string {
  return `${pathPrefix}.${path.join(".")}`;
}

function readCanonicalOrLegacy(
  entry: DmAccessRecord | null | undefined,
  mode: ChannelDmAllowFromMode,
  kind: DmFieldKind,
): unknown {
  const paths = resolveDmFieldPaths(mode, kind);
  return readPath(entry, paths.canonicalPath) ?? readPath(entry, paths.legacyPath);
}

export function resolveChannelDmPolicy(params: {
  account?: DmAccessRecord | null;
  parent?: DmAccessRecord | null;
  mode?: ChannelDmAllowFromMode;
  defaultPolicy?: string;
}): ChannelDmPolicy | undefined {
  const mode = params.mode ?? "topOnly";
  const value =
    readCanonicalOrLegacy(params.account, mode, "policy") ??
    readCanonicalOrLegacy(params.parent, mode, "policy") ??
    params.defaultPolicy;
  return typeof value === "string" ? normalizeChannelDmPolicy(value) : undefined;
}

export function resolveChannelDmAllowFrom(params: {
  account?: DmAccessRecord | null;
  parent?: DmAccessRecord | null;
  mode?: ChannelDmAllowFromMode;
}): Array<string | number> | undefined {
  const mode = params.mode ?? "topOnly";
  const value =
    readCanonicalOrLegacy(params.account, mode, "allowFrom") ??
    readCanonicalOrLegacy(params.parent, mode, "allowFrom");
  return Array.isArray(value) ? (value as Array<string | number>) : undefined;
}

export function resolveChannelDmAccess(params: {
  account?: DmAccessRecord | null;
  parent?: DmAccessRecord | null;
  mode?: ChannelDmAllowFromMode;
  defaultPolicy?: string;
}): ChannelDmAccess {
  return {
    dmPolicy: resolveChannelDmPolicy(params),
    allowFrom: resolveChannelDmAllowFrom(params),
  };
}

export function setCanonicalDmAllowFrom(params: {
  entry: DmAccessRecord;
  mode: ChannelDmAllowFromMode;
  allowFrom: Array<string | number>;
  pathPrefix: string;
  changes?: string[];
  reason: string;
}): void {
  const paths = resolveDmFieldPaths(params.mode, "allowFrom");
  writePath(params.entry, paths.canonicalPath, [...params.allowFrom]);
  if (deletePath(params.entry, paths.legacyPath)) {
    params.changes?.push(
      `- ${formatPath(params.pathPrefix, paths.legacyPath)}: removed after moving allowlist to ${formatPath(params.pathPrefix, paths.canonicalPath)}`,
    );
  }
  params.changes?.push(`- ${formatPath(params.pathPrefix, paths.canonicalPath)}: ${params.reason}`);
}

export function normalizeLegacyDmAliases(params: {
  entry: DmAccessRecord;
  pathPrefix: string;
  changes: string[];
  promoteAllowFrom?: boolean;
}): CompatMutationResult {
  let changed = false;
  let updated: DmAccessRecord = params.entry;
  const rawDm = updated.dm;
  const dm = cloneDm(updated);
  let dmChanged = false;

  const topDmPolicy = updated.dmPolicy;
  const legacyDmPolicy = dm?.policy;
  if (topDmPolicy === undefined && legacyDmPolicy !== undefined) {
    updated = { ...updated, dmPolicy: legacyDmPolicy };
    changed = true;
    if (dm) {
      delete dm.policy;
      dmChanged = true;
    }
    params.changes.push(`Moved ${params.pathPrefix}.dm.policy → ${params.pathPrefix}.dmPolicy.`);
  } else if (
    topDmPolicy !== undefined &&
    legacyDmPolicy !== undefined &&
    topDmPolicy === legacyDmPolicy
  ) {
    if (dm) {
      delete dm.policy;
      dmChanged = true;
      params.changes.push(`Removed ${params.pathPrefix}.dm.policy (dmPolicy already set).`);
    }
  }

  if (params.promoteAllowFrom !== false) {
    const topAllowFrom = updated.allowFrom;
    const legacyAllowFrom = dm?.allowFrom;
    if (topAllowFrom === undefined && legacyAllowFrom !== undefined) {
      updated = { ...updated, allowFrom: legacyAllowFrom };
      changed = true;
      if (dm) {
        delete dm.allowFrom;
        dmChanged = true;
      }
      params.changes.push(
        `Moved ${params.pathPrefix}.dm.allowFrom → ${params.pathPrefix}.allowFrom.`,
      );
    } else if (
      topAllowFrom !== undefined &&
      legacyAllowFrom !== undefined &&
      allowFromListsMatch(topAllowFrom, legacyAllowFrom)
    ) {
      if (dm) {
        delete dm.allowFrom;
        dmChanged = true;
        params.changes.push(`Removed ${params.pathPrefix}.dm.allowFrom (allowFrom already set).`);
      }
    }
  }

  if (dm && asObjectRecord(rawDm) && dmChanged) {
    const keys = Object.keys(dm);
    if (keys.length === 0) {
      if (updated.dm !== undefined) {
        const { dm: _ignored, ...rest } = updated;
        updated = rest;
        changed = true;
        params.changes.push(`Removed empty ${params.pathPrefix}.dm after migration.`);
      }
    } else {
      updated = { ...updated, dm };
      changed = true;
    }
  }

  return { entry: updated, changed };
}

function hasWildcard(list?: Array<string | number>) {
  return list?.some((value) => String(value).trim() === "*") ?? false;
}

export function ensureOpenDmPolicyAllowFromWildcard(params: {
  entry: DmAccessRecord;
  mode: ChannelDmAllowFromMode;
  pathPrefix: string;
  changes: string[];
}): void {
  const policy = resolveChannelDmPolicy({
    account: params.entry,
    mode: params.mode,
  });
  if (policy !== "open") {
    return;
  }

  const policyPaths = resolveDmFieldPaths(params.mode, "policy");
  const canonicalPolicy = readPath(params.entry, policyPaths.canonicalPath);
  const legacyPolicy = readPath(params.entry, policyPaths.legacyPath);
  if (canonicalPolicy === undefined && legacyPolicy === "open") {
    writePath(params.entry, policyPaths.canonicalPath, "open");
    deletePath(params.entry, policyPaths.legacyPath);
    params.changes.push(
      `- ${formatPath(params.pathPrefix, policyPaths.canonicalPath)}: set to "open" (migrated from ${formatPath(params.pathPrefix, policyPaths.legacyPath)})`,
    );
  }

  const allowPaths = resolveDmFieldPaths(params.mode, "allowFrom");
  const canonicalAllowFrom = readPath(params.entry, allowPaths.canonicalPath);
  const legacyAllowFrom = readPath(params.entry, allowPaths.legacyPath);
  const sourceAllowFrom = Array.isArray(canonicalAllowFrom)
    ? (canonicalAllowFrom as Array<string | number>)
    : Array.isArray(legacyAllowFrom)
      ? (legacyAllowFrom as Array<string | number>)
      : undefined;

  if (hasWildcard(sourceAllowFrom)) {
    if (canonicalAllowFrom === undefined && sourceAllowFrom) {
      setCanonicalDmAllowFrom({
        entry: params.entry,
        mode: params.mode,
        allowFrom: sourceAllowFrom,
        pathPrefix: params.pathPrefix,
        changes: params.changes,
        reason: `moved wildcard allowlist from ${formatPath(params.pathPrefix, allowPaths.legacyPath)}`,
      });
    }
    return;
  }

  const nextAllowFrom = [...(sourceAllowFrom ?? []), "*"];
  setCanonicalDmAllowFrom({
    entry: params.entry,
    mode: params.mode,
    allowFrom: nextAllowFrom,
    pathPrefix: params.pathPrefix,
    changes: params.changes,
    reason: Array.isArray(sourceAllowFrom)
      ? 'added "*" (required by dmPolicy="open")'
      : 'set to ["*"] (required by dmPolicy="open")',
  });
}
