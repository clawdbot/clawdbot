// Normalizes channel config compatibility fields during config loading.
import {
  normalizeLegacyDmAliases,
  type CompatMutationResult,
} from "../channels/plugins/dm-access.js";

export { normalizeLegacyDmAliases };
export type { CompatMutationResult };

/** Resolved streaming values a channel doctor supplies while migrating legacy aliases. */
export type LegacyStreamingAliasOptions = {
  resolvedMode: string;
  includePreviewChunk?: boolean;
  resolvedNativeTransport?: unknown;
  offModeLegacyNotice?: (pathPrefix: string) => string;
};

/** Account-level channel config passed to channel-specific doctor migrations. */
export type NormalizeLegacyChannelAccountParams = {
  account: Record<string, unknown>;
  accountId: string;
  pathPrefix: string;
  changes: string[];
};

/** Narrows unknown config JSON values to mutable object records. */
export function asObjectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseAliasStreamingMode(value: unknown): "off" | "partial" | "block" | "progress" | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "off" ||
    normalized === "partial" ||
    normalized === "block" ||
    normalized === "progress"
    ? normalized
    : null;
}

/**
 * Doctor-only stream mode resolution across nested and legacy alias keys.
 *
 * Runtime helpers no longer read `streamMode`, so doctor contracts use this to
 * preserve legacy intent (nested mode > scalar string > streamMode > scalar
 * boolean) while migrating flat aliases into `streaming.mode`.
 */
export function resolveLegacyAliasStreamingMode(
  entry: Record<string, unknown>,
  defaultMode: "off" | "partial" | "block" | "progress",
): "off" | "partial" | "block" | "progress" {
  const nestedMode = asObjectRecord(entry.streaming)?.mode;
  const parsed =
    parseAliasStreamingMode(nestedMode ?? entry.streaming) ??
    parseAliasStreamingMode(entry.streamMode);
  if (parsed) {
    return parsed;
  }
  if (typeof entry.streaming === "boolean") {
    return entry.streaming ? "partial" : "off";
  }
  return defaultMode;
}

/** Checks whether any account entry still carries a channel-specific legacy alias. */
export function hasLegacyAccountStreamingAliases(
  value: unknown,
  match: (entry: unknown) => boolean,
): boolean {
  const accounts = asObjectRecord(value);
  if (!accounts) {
    return false;
  }
  return Object.values(accounts).some((account) => match(account));
}

function ensureNestedRecord(owner: Record<string, unknown>, key: string): Record<string, unknown> {
  const existing = asObjectRecord(owner[key]);
  if (existing) {
    // Clone nested records before migration so callers keep immutable before/after snapshots.
    return { ...existing };
  }
  return {};
}

/**
 * Moves legacy flat streaming aliases into the nested `streaming` config shape.
 *
 * Existing nested values win over legacy aliases, matching doctor migration rules
 * that preserve explicit modern config while removing stale compatibility keys.
 */
export function normalizeLegacyStreamingAliases(
  params: {
    entry: Record<string, unknown>;
    pathPrefix: string;
    changes: string[];
  } & LegacyStreamingAliasOptions,
): CompatMutationResult {
  const beforeStreaming = params.entry.streaming;
  const hadLegacyStreamMode = params.entry.streamMode !== undefined;
  const hasLegacyFlatFields =
    params.entry.chunkMode !== undefined ||
    params.entry.blockStreaming !== undefined ||
    params.entry.blockStreamingCoalesce !== undefined ||
    (params.includePreviewChunk === true && params.entry.draftChunk !== undefined) ||
    params.entry.nativeStreaming !== undefined;
  const shouldNormalize =
    hadLegacyStreamMode ||
    typeof beforeStreaming === "boolean" ||
    typeof beforeStreaming === "string" ||
    hasLegacyFlatFields;
  if (!shouldNormalize) {
    return { entry: params.entry, changed: false };
  }

  const updated = { ...params.entry };
  let changed = false;
  const streaming = ensureNestedRecord(updated, "streaming");
  const block = ensureNestedRecord(streaming, "block");
  const preview = ensureNestedRecord(streaming, "preview");

  // Only fill `streaming.mode` when the modern nested field is absent.
  let movedStreamMode = false;
  if (
    (hadLegacyStreamMode ||
      typeof beforeStreaming === "boolean" ||
      typeof beforeStreaming === "string") &&
    streaming.mode === undefined
  ) {
    streaming.mode = params.resolvedMode;
    if (hadLegacyStreamMode) {
      movedStreamMode = true;
      params.changes.push(
        `Moved ${params.pathPrefix}.streamMode → ${params.pathPrefix}.streaming.mode (${params.resolvedMode}).`,
      );
    } else if (typeof beforeStreaming === "boolean") {
      params.changes.push(
        `Moved ${params.pathPrefix}.streaming (boolean) → ${params.pathPrefix}.streaming.mode (${params.resolvedMode}).`,
      );
    } else if (typeof beforeStreaming === "string") {
      params.changes.push(
        `Moved ${params.pathPrefix}.streaming (scalar) → ${params.pathPrefix}.streaming.mode (${params.resolvedMode}).`,
      );
    }
    changed = true;
  }
  if (hadLegacyStreamMode) {
    if (!movedStreamMode) {
      // Every mutation needs a change message: doctor discards mutations with
      // empty change lists, which would leave the schema-invalid flat key in
      // the persisted config forever.
      params.changes.push(
        `Removed ${params.pathPrefix}.streamMode (${params.pathPrefix}.streaming.mode already set).`,
      );
    }
    delete updated.streamMode;
    changed = true;
  }
  // Each flat alias either moves into the nested slot or, when the nested
  // value is already set, is removed outright. Leaving the flat key in place
  // would keep the config schema-invalid after `doctor --fix` because runtime
  // schemas no longer accept these aliases.
  const moveOrRemoveAlias = (
    flatKey: string,
    target: Record<string, unknown>,
    slot: string,
    nestedPath: string,
  ) => {
    if (updated[flatKey] === undefined) {
      return;
    }
    const nested = `${params.pathPrefix}.streaming.${nestedPath}`;
    if (target[slot] === undefined) {
      target[slot] = updated[flatKey];
      params.changes.push(`Moved ${params.pathPrefix}.${flatKey} → ${nested}.`);
    } else {
      params.changes.push(`Removed ${params.pathPrefix}.${flatKey} (${nested} already set).`);
    }
    delete updated[flatKey];
    changed = true;
  };
  moveOrRemoveAlias("chunkMode", streaming, "chunkMode", "chunkMode");
  moveOrRemoveAlias("blockStreaming", block, "enabled", "block.enabled");
  if (params.includePreviewChunk === true) {
    moveOrRemoveAlias("draftChunk", preview, "chunk", "preview.chunk");
  }
  moveOrRemoveAlias("blockStreamingCoalesce", block, "coalesce", "block.coalesce");
  if (updated.nativeStreaming !== undefined && params.resolvedNativeTransport !== undefined) {
    if (streaming.nativeTransport === undefined) {
      streaming.nativeTransport = params.resolvedNativeTransport;
      params.changes.push(
        `Moved ${params.pathPrefix}.nativeStreaming → ${params.pathPrefix}.streaming.nativeTransport.`,
      );
    } else {
      params.changes.push(
        `Removed ${params.pathPrefix}.nativeStreaming (${params.pathPrefix}.streaming.nativeTransport already set).`,
      );
    }
    delete updated.nativeStreaming;
    changed = true;
  } else if (
    typeof beforeStreaming === "boolean" &&
    streaming.nativeTransport === undefined &&
    params.resolvedNativeTransport !== undefined
  ) {
    streaming.nativeTransport = params.resolvedNativeTransport;
    params.changes.push(
      `Moved ${params.pathPrefix}.streaming (boolean) → ${params.pathPrefix}.streaming.nativeTransport.`,
    );
    changed = true;
  }

  if (Object.keys(preview).length > 0) {
    streaming.preview = preview;
  }
  if (Object.keys(block).length > 0) {
    streaming.block = block;
  }
  updated.streaming = streaming;
  if (
    hadLegacyStreamMode &&
    params.resolvedMode === "off" &&
    params.offModeLegacyNotice !== undefined
  ) {
    params.changes.push(params.offModeLegacyNotice(params.pathPrefix));
  }
  return { entry: updated, changed };
}

/**
 * Runs generic channel doctor alias migration for the root entry and accounts.
 *
 * Channel plugins provide streaming resolution and optional account-specific
 * migrations so core can keep one compatibility path for all channel shapes.
 */
export function normalizeLegacyChannelAliases(params: {
  entry: Record<string, unknown>;
  pathPrefix: string;
  changes: string[];
  normalizeDm?: boolean;
  rootDmPromoteAllowFrom?: boolean;
  normalizeAccountDm?: boolean;
  resolveStreamingOptions: (entry: Record<string, unknown>) => LegacyStreamingAliasOptions;
  normalizeAccountExtra?: (params: NormalizeLegacyChannelAccountParams) => CompatMutationResult;
}): CompatMutationResult {
  let updated = params.entry;
  let changed = false;

  if (params.normalizeDm === true) {
    const dm = normalizeLegacyDmAliases({
      entry: updated,
      pathPrefix: params.pathPrefix,
      changes: params.changes,
      promoteAllowFrom: params.rootDmPromoteAllowFrom,
    });
    updated = dm.entry;
    changed = dm.changed;
  }

  const streaming = normalizeLegacyStreamingAliases({
    entry: updated,
    pathPrefix: params.pathPrefix,
    changes: params.changes,
    ...params.resolveStreamingOptions(updated),
  });
  updated = streaming.entry;
  changed = changed || streaming.changed;

  const rawAccounts = asObjectRecord(updated.accounts);
  if (!rawAccounts) {
    return { entry: updated, changed };
  }

  let accountsChanged = false;
  const accounts = { ...rawAccounts };
  for (const [accountId, rawAccount] of Object.entries(rawAccounts)) {
    const account = asObjectRecord(rawAccount);
    if (!account) {
      continue;
    }
    let accountEntry = account;
    let accountChanged = false;
    const accountPathPrefix = `${params.pathPrefix}.accounts.${accountId}`;

    if (params.normalizeAccountDm === true) {
      const accountDm = normalizeLegacyDmAliases({
        entry: accountEntry,
        pathPrefix: accountPathPrefix,
        changes: params.changes,
      });
      accountEntry = accountDm.entry;
      accountChanged = accountDm.changed;
    }

    const accountStreaming = normalizeLegacyStreamingAliases({
      entry: accountEntry,
      pathPrefix: accountPathPrefix,
      changes: params.changes,
      ...params.resolveStreamingOptions(accountEntry),
    });
    accountEntry = accountStreaming.entry;
    accountChanged = accountChanged || accountStreaming.changed;

    const accountExtra = params.normalizeAccountExtra?.({
      account: accountEntry,
      accountId,
      pathPrefix: accountPathPrefix,
      changes: params.changes,
    });
    if (accountExtra) {
      accountEntry = accountExtra.entry;
      accountChanged = accountChanged || accountExtra.changed;
    }

    if (accountChanged) {
      accounts[accountId] = accountEntry;
      accountsChanged = true;
    }
  }
  if (accountsChanged) {
    updated = { ...updated, accounts };
    changed = true;
  }

  return { entry: updated, changed };
}

/** Detects legacy streaming aliases on one channel or account config entry. */
export function hasLegacyStreamingAliases(
  value: unknown,
  options?: { includePreviewChunk?: boolean; includeNativeTransport?: boolean },
): boolean {
  const entry = asObjectRecord(value);
  if (!entry) {
    return false;
  }
  return (
    entry.streamMode !== undefined ||
    typeof entry.streaming === "boolean" ||
    typeof entry.streaming === "string" ||
    entry.chunkMode !== undefined ||
    entry.blockStreaming !== undefined ||
    entry.blockStreamingCoalesce !== undefined ||
    (options?.includePreviewChunk === true && entry.draftChunk !== undefined) ||
    (options?.includeNativeTransport === true && entry.nativeStreaming !== undefined)
  );
}
