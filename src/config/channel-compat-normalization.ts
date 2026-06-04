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
  if (
    (hadLegacyStreamMode ||
      typeof beforeStreaming === "boolean" ||
      typeof beforeStreaming === "string") &&
    streaming.mode === undefined
  ) {
    streaming.mode = params.resolvedMode;
    if (hadLegacyStreamMode) {
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
    delete updated.streamMode;
    changed = true;
  }
  if (updated.chunkMode !== undefined && streaming.chunkMode === undefined) {
    streaming.chunkMode = updated.chunkMode;
    delete updated.chunkMode;
    params.changes.push(
      `Moved ${params.pathPrefix}.chunkMode → ${params.pathPrefix}.streaming.chunkMode.`,
    );
    changed = true;
  }
  if (updated.blockStreaming !== undefined && block.enabled === undefined) {
    block.enabled = updated.blockStreaming;
    delete updated.blockStreaming;
    params.changes.push(
      `Moved ${params.pathPrefix}.blockStreaming → ${params.pathPrefix}.streaming.block.enabled.`,
    );
    changed = true;
  }
  if (
    params.includePreviewChunk === true &&
    updated.draftChunk !== undefined &&
    preview.chunk === undefined
  ) {
    preview.chunk = updated.draftChunk;
    delete updated.draftChunk;
    params.changes.push(
      `Moved ${params.pathPrefix}.draftChunk → ${params.pathPrefix}.streaming.preview.chunk.`,
    );
    changed = true;
  }
  if (updated.blockStreamingCoalesce !== undefined && block.coalesce === undefined) {
    block.coalesce = updated.blockStreamingCoalesce;
    delete updated.blockStreamingCoalesce;
    params.changes.push(
      `Moved ${params.pathPrefix}.blockStreamingCoalesce → ${params.pathPrefix}.streaming.block.coalesce.`,
    );
    changed = true;
  }
  if (
    updated.nativeStreaming !== undefined &&
    streaming.nativeTransport === undefined &&
    params.resolvedNativeTransport !== undefined
  ) {
    streaming.nativeTransport = params.resolvedNativeTransport;
    delete updated.nativeStreaming;
    params.changes.push(
      `Moved ${params.pathPrefix}.nativeStreaming → ${params.pathPrefix}.streaming.nativeTransport.`,
    );
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
