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
  /**
   * Mode to persist when migration creates the `streaming` object from flat
   * delivery aliases alone (no streamMode/scalar/boolean mode source). Only
   * needed by channels whose "streaming absent" runtime default differs from
   * their object-without-mode default (Discord: progress vs off).
   */
  aliasOnlyMode?: string;
  includePreviewChunk?: boolean;
  resolvedNativeTransport?: unknown;
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

  // Materializing `streaming` for delivery-only aliases would otherwise flip
  // channels whose runtime treats "streaming absent" differently from an
  // object without `mode` (Discord defaults to progress only when the whole
  // object is absent). Pin the previous effective mode so migration never
  // changes behavior. Guarded on `changed` so entries with no movable alias
  // stay a no-op instead of minting a mode-only mutation. Account callers
  // suppress aliasOnlyMode when a root streaming object exists: the seed in
  // normalizeLegacyChannelAliases carries the inherited settings instead, and
  // pinning the absent-object default there would change effective behavior.
  if (
    changed &&
    beforeStreaming === undefined &&
    streaming.mode === undefined &&
    params.aliasOnlyMode !== undefined
  ) {
    streaming.mode = params.aliasOnlyMode;
    params.changes.push(
      `Set ${params.pathPrefix}.streaming.mode (${params.aliasOnlyMode}) to keep the previous default while migrating flat streaming keys.`,
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
  return { entry: updated, changed };
}

/**
 * Root flat delivery aliases resolved per-key for every account (nested-first,
 * flat-fallback), even when the account carried its own `streaming` value that
 * replaces the root object wholesale at merge time. Capture them before root
 * migration so replace-semantics channels can seed existing account streaming
 * objects with the delivery settings those accounts previously inherited.
 */
function buildRootFlatDeliverySeed(
  entry: Record<string, unknown>,
  includePreviewChunk: boolean | undefined,
): Record<string, unknown> | null {
  const seed: Record<string, unknown> = {};
  if (entry.chunkMode !== undefined) {
    seed.chunkMode = entry.chunkMode;
  }
  const block: Record<string, unknown> = {};
  if (entry.blockStreaming !== undefined) {
    block.enabled = entry.blockStreaming;
  }
  if (entry.blockStreamingCoalesce !== undefined) {
    block.coalesce = entry.blockStreamingCoalesce;
  }
  if (Object.keys(block).length > 0) {
    seed.block = block;
  }
  if (includePreviewChunk === true && entry.draftChunk !== undefined) {
    seed.preview = { chunk: entry.draftChunk };
  }
  return Object.keys(seed).length > 0 ? seed : null;
}

/**
 * Rebuilds a materialized account streaming object with the per-slot
 * precedence the runtime resolvers applied pre-migration. The slots disagree:
 * - mode, block.enabled, preview.chunk resolve on the MERGED entry
 *   (src/channels/streaming.ts nested-first), so the root nested object
 *   outranked account flat aliases and preview.chunk picks atomically.
 * - chunkMode resolves the raw account entry before the root entry
 *   (resolveChunkModeForProvider in src/auto-reply/chunk.ts), so an account
 *   flat chunkMode outranked every root spelling.
 * - block.coalesce merges the account pick over the root pick per field
 *   (resolveProviderBlockStreamingCoalesce in
 *   src/auto-reply/reply/block-streaming.ts).
 * One generic deep-fill cannot express that ladder, so seed slot by slot.
 * Copying root values freezes inheritance at fix time by design (the change
 * message records it); merged-entry channels (mattermost-style resolved
 * accounts) would otherwise lose the root values entirely once the account
 * owns a streaming object.
 */
function seedMaterializedAccountStreaming(params: {
  created: Record<string, unknown>;
  rootNestedBefore: Record<string, unknown> | null;
  rootFlat: Record<string, unknown> | null;
  rootAfter: Record<string, unknown>;
}): Record<string, unknown> {
  const { created } = params;
  const rootNested = params.rootNestedBefore ?? {};
  const rootFlat = params.rootFlat ?? {};
  // Root-first base for the merged-entry slots plus inherited root extras
  // (progress, preview.toolProgress, ...). Account values fill the gaps.
  let seeded = fillMissingRecordFields(structuredClone(rootNested), created).value;
  seeded = fillMissingRecordFields(seeded, rootFlat).value;
  // Root migration can add fields the pre-migration snapshot lacked (mode
  // restored from root streamMode/scalar aliases); the account previously
  // inherited the root object wholesale, so it inherits the restored intent.
  seeded = fillMissingRecordFields(seeded, params.rootAfter).value;
  // chunkMode: account-entry-first resolver, so the account alias wins.
  if (created.chunkMode !== undefined) {
    seeded = { ...seeded, chunkMode: created.chunkMode };
  }
  // block.coalesce: account fields merge over the root pick per field.
  const createdCoalesce = asObjectRecord(asObjectRecord(created.block)?.coalesce);
  if (createdCoalesce) {
    const rootCoalesce =
      asObjectRecord(asObjectRecord(rootNested.block)?.coalesce) ??
      asObjectRecord(asObjectRecord(rootFlat.block)?.coalesce);
    seeded = {
      ...seeded,
      block: {
        ...asObjectRecord(seeded.block),
        coalesce: { ...structuredClone(rootCoalesce ?? {}), ...structuredClone(createdCoalesce) },
      },
    };
  }
  // preview.chunk: merged-entry resolver picks the whole object atomically, so
  // never blend a root nested chunk with an account draftChunk-derived one.
  const rootNestedPreviewChunk = asObjectRecord(rootNested.preview)?.chunk;
  if (
    rootNestedPreviewChunk !== undefined &&
    asObjectRecord(created.preview)?.chunk !== undefined
  ) {
    seeded = {
      ...seeded,
      preview: {
        ...asObjectRecord(seeded.preview),
        chunk: structuredClone(rootNestedPreviewChunk),
      },
    };
  }
  return seeded;
}

/** Deep-fills record fields missing from target with copies of source values. */
function fillMissingRecordFields(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): { value: Record<string, unknown>; filled: boolean } {
  let filled = false;
  const value = { ...target };
  for (const [key, sourceValue] of Object.entries(source)) {
    if (sourceValue === undefined) {
      continue;
    }
    const existing = value[key];
    if (existing === undefined) {
      // Copy so later account-level edits never alias the root config object.
      value[key] = structuredClone(sourceValue);
      filled = true;
      continue;
    }
    const existingRecord = asObjectRecord(existing);
    const sourceRecord = asObjectRecord(sourceValue);
    if (!existingRecord || !sourceRecord) {
      continue;
    }
    const merged = fillMissingRecordFields(existingRecord, sourceRecord);
    if (merged.filled) {
      value[key] = merged.value;
      filled = true;
    }
  }
  return { value, filled };
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
  /**
   * Set for channels whose runtime account merge replaces the root `streaming`
   * object wholesale (`streaming` not deep-merged). Doctor then seeds account
   * objects it materializes with the inherited root settings. Channels that
   * deep-merge streaming (slack, imessage) must NOT seed: their runtime keeps
   * composing root+account, and seeded copies would freeze inheritance.
   */
  seedAccountStreamingFromRoot?: boolean;
  resolveStreamingOptions: (entry: Record<string, unknown>) => LegacyStreamingAliasOptions;
  normalizeAccountExtra?: (params: NormalizeLegacyChannelAccountParams) => CompatMutationResult;
}): CompatMutationResult {
  let updated = params.entry;
  let changed = false;

  // Captured before root migration deletes the flat keys / rewrites the
  // nested object, because seeding must reproduce the per-slot precedence the
  // resolvers applied pre-migration: root.nested > account.flat > root.flat.
  const rootFlatDeliverySeed =
    params.seedAccountStreamingFromRoot === true
      ? buildRootFlatDeliverySeed(
          params.entry,
          params.resolveStreamingOptions(params.entry).includePreviewChunk,
        )
      : null;
  const rootNestedStreamingBefore =
    params.seedAccountStreamingFromRoot === true ? asObjectRecord(params.entry.streaming) : null;

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

  // For replace-semantics channels (seedAccountStreamingFromRoot), an account
  // object materialized by migration must be seeded with the settings the
  // account previously inherited from the root object, or `doctor --fix`
  // silently changes effective delivery/preview behavior for that account.
  const rootStreaming = asObjectRecord(updated.streaming);

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

    const accountStreamingOptions = { ...params.resolveStreamingOptions(accountEntry) };
    if (rootStreaming) {
      // Truth table rows 2-3: with a root object to seed from, the account
      // previously resolved that object's semantics (its mode, or the
      // object-without-mode default), so pinning absentObjectDefault is wrong.
      delete accountStreamingOptions.aliasOnlyMode;
    }
    const beforeAccountStreaming = accountEntry.streaming;
    const accountStreaming = normalizeLegacyStreamingAliases({
      entry: accountEntry,
      pathPrefix: accountPathPrefix,
      changes: params.changes,
      ...accountStreamingOptions,
    });
    accountEntry = accountStreaming.entry;
    accountChanged = accountChanged || accountStreaming.changed;

    if (
      params.seedAccountStreamingFromRoot === true &&
      accountStreaming.changed &&
      beforeAccountStreaming === undefined &&
      rootStreaming
    ) {
      const created = asObjectRecord(accountEntry.streaming);
      if (created) {
        const seeded = seedMaterializedAccountStreaming({
          created,
          rootNestedBefore: rootNestedStreamingBefore,
          rootFlat: rootFlatDeliverySeed,
          rootAfter: rootStreaming,
        });
        if (JSON.stringify(seeded) !== JSON.stringify(created)) {
          accountEntry = { ...accountEntry, streaming: seeded };
          params.changes.push(
            `Copied ${params.pathPrefix}.streaming into ${accountPathPrefix}.streaming to keep inherited settings while migrating flat streaming keys.`,
          );
        }
      }
    } else if (rootFlatDeliverySeed && beforeAccountStreaming !== undefined) {
      // The account already had a streaming value, so merged-entry channels
      // (mattermost-style resolved accounts) replace the root object wholesale
      // and would lose the root FLAT keys they previously read through the
      // merged flat fallback. Fill only slots the account does not set itself
      // (per-field for coalesce, atomically for preview.chunk); copying the
      // current value freezes inheritance at fix time by design — the change
      // message records it — while raw-entry channels (matrix, feishu) keep
      // resolving the same values from the migrated root entry either way.
      const accountStreamingObject = asObjectRecord(accountEntry.streaming);
      if (accountStreamingObject) {
        let seededAccount = accountStreamingObject;
        if (rootFlatDeliverySeed.chunkMode !== undefined && seededAccount.chunkMode === undefined) {
          seededAccount = { ...seededAccount, chunkMode: rootFlatDeliverySeed.chunkMode };
        }
        const rootFlatBlock = asObjectRecord(rootFlatDeliverySeed.block);
        const rootFlatBlockEnabled = rootFlatBlock?.enabled;
        if (
          rootFlatBlockEnabled !== undefined &&
          asObjectRecord(seededAccount.block)?.enabled === undefined
        ) {
          seededAccount = {
            ...seededAccount,
            block: {
              ...asObjectRecord(seededAccount.block),
              enabled: rootFlatBlockEnabled,
            },
          };
        }
        const rootFlatCoalesce = asObjectRecord(rootFlatBlock?.coalesce);
        if (rootFlatCoalesce) {
          const accountCoalesce = asObjectRecord(asObjectRecord(seededAccount.block)?.coalesce);
          const mergedCoalesce = {
            ...structuredClone(rootFlatCoalesce),
            ...structuredClone(accountCoalesce ?? {}),
          };
          if (JSON.stringify(mergedCoalesce) !== JSON.stringify(accountCoalesce ?? {})) {
            seededAccount = {
              ...seededAccount,
              block: {
                ...asObjectRecord(seededAccount.block),
                coalesce: mergedCoalesce,
              },
            };
          }
        }
        const rootFlatPreviewChunk = asObjectRecord(rootFlatDeliverySeed.preview)?.chunk;
        // Atomic slot: only copy the whole chunk object when the account has none.
        if (
          rootFlatPreviewChunk !== undefined &&
          asObjectRecord(seededAccount.preview)?.chunk === undefined
        ) {
          seededAccount = {
            ...seededAccount,
            preview: {
              ...asObjectRecord(seededAccount.preview),
              chunk: structuredClone(rootFlatPreviewChunk),
            },
          };
        }
        if (seededAccount !== accountStreamingObject) {
          accountEntry = { ...accountEntry, streaming: seededAccount };
          accountChanged = true;
          params.changes.push(
            `Copied flat ${params.pathPrefix} delivery keys into ${accountPathPrefix}.streaming to keep inherited settings while migrating flat streaming keys.`,
          );
        }
      }
    }

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
