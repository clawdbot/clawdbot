/**
 * Channel DM access helpers.
 *
 * Reads, writes, migrates, and normalizes direct-message policy and allowFrom fields.
 */
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";

/**
 * Selects whether canonical DM fields live at the top level or under `dm`.
 */
export type ChannelDmAllowFromMode = "topOnly" | "topOrNested" | "nestedOnly";

/**
 * Supported direct-message policy values for channel account config.
 */
export type ChannelDmPolicy = "pairing" | "allowlist" | "open" | "disabled";

/**
 * Normalized DM access view consumed by channel setup and reply gates.
 */
export type ChannelDmAccess = {
  dmPolicy?: ChannelDmPolicy;
  allowFrom?: Array<string | number>;
};

/**
 * Mutable config record used while migrating channel account DM fields.
 */
export type DmAccessRecord = Record<string, unknown>;

type DmFieldKind = "policy" | "allowFrom";

type DmFieldPaths = {
  canonicalPath: readonly string[];
  legacyPath: readonly string[];
};

/**
 * Result returned by compatibility helpers after optional DM config mutation.
 */
export type CompatMutationResult = {
  entry: DmAccessRecord;
  changed: boolean;
};

/**
 * Narrows a raw string to a supported channel DM policy.
 */
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
  // Some channels kept DM access under `dm.*`, while newer config uses top
  // fields. Resolve both names here so read/write/migration logic stays paired.
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
  const [head, tail] = path;
  if (head === undefined) {
    return false;
  }
  if (path.length === 1) {
    if (entry[head] === undefined) {
      return false;
    }
    delete entry[head];
    return true;
  }
  if (tail === undefined) {
    return false;
  }
  const parent = asObjectRecord(entry[head]);
  if (!parent || parent[tail] === undefined) {
    return false;
  }
  delete parent[tail];
  if (Object.keys(parent).length === 0) {
    delete entry[head];
  } else {
    entry[head] = parent;
  }
  return true;
}

function writePath(entry: DmAccessRecord, path: readonly string[], value: unknown): void {
  const [head, tail] = path;
  if (head === undefined) {
    return;
  }
  if (path.length === 1) {
    entry[head] = value;
    return;
  }
  if (tail === undefined) {
    return;
  }
  const existingParent = asObjectRecord(entry[head]);
  const parent = existingParent ? { ...existingParent } : {};
  parent[tail] = value;
  entry[head] = parent;
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

/**
 * Resolves the effective DM policy from account, parent account, and default policy.
 */
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

/**
 * Resolves the effective DM allowlist from account or parent account config.
 */
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

/**
 * Resolves policy and allowlist together for channel access checks.
 */
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

/**
 * Writes a canonical DM allowlist and removes the matching legacy alias.
 */
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

/**
 * Migrates legacy `dm.*` aliases into the canonical DM access fields.
 */
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

  // Preserve an explicit canonical value when it exists, but remove a matching
  // legacy alias so doctor does not keep reporting the same repair.
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
    // `allowFrom` promotion is optional because some channels keep nested DM
    // allowlists as the canonical shape until their config schema moves.
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

/**
 * Ensures `dmPolicy="open"` has the wildcard allowlist required by access gates.
 */
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
  // Open policy may have arrived through the legacy nested path; move it before
  // adding the wildcard so all repair output points at canonical config.
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
