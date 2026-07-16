import fs from "node:fs/promises";
import path from "node:path";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { createSubsystemLogger } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import type { ResolvedQmdConfig } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import {
  canMigrateLegacyQmdCollection,
  deriveLegacyQmdCollectionName,
  findQmdCollectionByPathPattern,
  isQmdCollectionAlreadyExistsError,
  isQmdCollectionMissingError,
  isSameNameQmdCollectionAlreadyExistsError,
  parseConflictingQmdCollectionName,
  parseListedQmdCollections,
  parseShownQmdCollection,
  renderQmdCollectionIndexConfig,
  shouldRepairDuplicateQmdDocumentConstraint,
  shouldRepairNullByteQmdCollectionError,
  shouldRebindQmdCollection,
  type ListedQmdCollection,
  type ManagedQmdCollection,
} from "./qmd-collection-metadata.js";
import {
  isMissingCollectionSearchError,
  isUnsupportedQmdOptionError,
} from "./qmd-command-errors.js";
import { resolveQmdCollectionPatternFlags, type QmdCollectionPatternFlag } from "./qmd-compat.js";
import {
  readQmdCollectionValidationCache,
  writeQmdCollectionValidationCache,
  type QmdRuntimeCollectionValidationCacheContext,
} from "./qmd-runtime-cache.js";
import type {
  QmdCollectionValidationDebug,
  QmdSearchRuntimeDebugContext,
} from "./qmd-runtime-debug.js";

const log = createSubsystemLogger("memory");
const QMD_INDEX_CONFIG_FILE = "index.yml";

export type { ManagedQmdCollection } from "./qmd-collection-metadata.js";
export type { QmdSearchRuntimeDebugContext } from "./qmd-runtime-debug.js";

type RunQmd = (
  args: string[],
  opts?: { timeoutMs?: number; discardOutput?: boolean; signal?: AbortSignal },
) => Promise<{ stdout: string; stderr: string }>;

export class QmdCollectionController {
  private collectionPatternFlag: QmdCollectionPatternFlag | null = "--mask";
  private attemptedNullByteCollectionRepair = false;
  private attemptedDuplicateDocumentRepair = false;
  private pendingValidationDebug: QmdCollectionValidationDebug | undefined;

  constructor(
    private readonly qmd: ResolvedQmdConfig,
    private readonly agentId: string,
    private readonly workspaceDir: string,
    private readonly xdgConfigHome: string,
    private readonly runQmd: RunQmd,
    private readonly buildValidationCacheContext: () => Promise<QmdRuntimeCollectionValidationCacheContext>,
  ) {}

  consumePendingValidationDebug(): QmdCollectionValidationDebug | undefined {
    const debug = this.pendingValidationDebug;
    this.pendingValidationDebug = undefined;
    return debug;
  }

  async ensureCollections(options?: {
    force?: boolean;
    debugContext?: QmdSearchRuntimeDebugContext;
  }): Promise<void> {
    const startedAt = Date.now();
    const cacheContext = await this.buildValidationCacheContext();
    if (!options?.force) {
      const cached = await readQmdCollectionValidationCache(cacheContext);
      if (cached.state === "hit") {
        await this.ensureCollectionPathsBestEffort();
        this.recordValidationDebug(
          {
            cacheState: "hit",
            elapsedMs: Math.max(0, Date.now() - startedAt),
            collectionCount: cached.value.validation.collectionCount,
            listCalls: 0,
            showCalls: 0,
          },
          options?.debugContext,
        );
        return;
      }
    }

    const stats = { listCalls: 0, showCalls: 0 };
    let validationComplete = true;
    const existing = await this.listCollectionsBestEffort(stats);
    await this.migrateLegacyUnscopedCollections(existing);

    for (const collection of this.qmd.collections) {
      const listed = existing.get(collection.name);
      if (
        listed &&
        !shouldRebindQmdCollection({ collection, listed, workspaceDir: this.workspaceDir })
      ) {
        continue;
      }
      if (listed) {
        try {
          await this.removeCollection(collection.name);
        } catch (err) {
          const message = formatErrorMessage(err);
          if (!isQmdCollectionMissingError(message)) {
            validationComplete = false;
            log.warn(`qmd collection remove failed for ${collection.name}: ${message}`);
          }
        }
      }
      try {
        await this.ensureCollectionPath(collection);
        await this.addCollection(collection.path, collection.name, collection.pattern);
        existing.set(collection.name, {
          path: collection.path,
          pattern: collection.pattern,
        });
      } catch (err) {
        const message = formatErrorMessage(err);
        if (isQmdCollectionAlreadyExistsError(message)) {
          const rebound =
            (await this.tryRebindSameNameCollection({
              collection,
              addErrorMessage: message,
            })) ||
            (await this.tryRebindConflictingCollection({
              collection,
              existing,
              addErrorMessage: message,
            }));
          if (rebound) {
            existing.set(collection.name, {
              path: collection.path,
              pattern: collection.pattern,
            });
          } else {
            validationComplete = false;
            log.warn(`qmd collection add skipped for ${collection.name}: ${message}`);
          }
          continue;
        }
        validationComplete = false;
        log.warn(`qmd collection add failed for ${collection.name}: ${message}`);
      }
    }
    const wroteCache = validationComplete
      ? await writeQmdCollectionValidationCache(cacheContext)
      : false;
    this.recordValidationDebug(
      {
        cacheState: validationComplete
          ? options?.force
            ? "bypass-force"
            : wroteCache
              ? "write"
              : "error"
          : "error",
        elapsedMs: Math.max(0, Date.now() - startedAt),
        collectionCount: this.qmd.collections.length,
        listCalls: stats.listCalls,
        showCalls: stats.showCalls,
      },
      options?.debugContext,
    );
  }

  async tryRepairMissingCollectionSearch(
    err: unknown,
    debugContext: QmdSearchRuntimeDebugContext,
  ): Promise<boolean> {
    if (!isMissingCollectionSearchError(err)) {
      return false;
    }
    log.warn(
      "qmd search failed because a managed collection is missing; repairing collections and retrying once",
    );
    await this.ensureCollections({ force: true, debugContext });
    return true;
  }

  async tryRepairNullByteCollections(err: unknown, reason: string): Promise<boolean> {
    if (this.attemptedNullByteCollectionRepair || !shouldRepairNullByteQmdCollectionError(err)) {
      return false;
    }
    this.attemptedNullByteCollectionRepair = true;
    log.warn(
      `qmd update failed with suspected null-byte collection metadata (${reason}); rebuilding managed collections and retrying once`,
    );
    await this.rebuildManagedCollectionsForRepair(`null-byte metadata (${reason})`);
    return true;
  }

  async tryRepairDuplicateDocumentConstraint(err: unknown, reason: string): Promise<boolean> {
    if (this.attemptedDuplicateDocumentRepair || !shouldRepairDuplicateQmdDocumentConstraint(err)) {
      return false;
    }
    this.attemptedDuplicateDocumentRepair = true;
    log.warn(
      `qmd update failed with duplicate document constraint (${reason}); rebuilding managed collections and retrying once`,
    );
    await this.rebuildManagedCollectionsForRepair(`duplicate-document constraint (${reason})`);
    return true;
  }

  private recordValidationDebug(
    debug: QmdCollectionValidationDebug,
    debugContext?: QmdSearchRuntimeDebugContext,
  ): void {
    if (debugContext) {
      debugContext.collectionValidation = debug;
    } else {
      this.pendingValidationDebug = debug;
    }
  }

  private async ensureCollectionPathsBestEffort(): Promise<void> {
    for (const collection of this.qmd.collections) {
      try {
        await this.ensureCollectionPath(collection);
      } catch (err) {
        log.warn(
          `qmd collection path prepare failed for ${collection.name}: ${formatErrorMessage(err)}`,
        );
      }
    }
  }

  private async tryRebindSameNameCollection(params: {
    collection: ManagedQmdCollection;
    addErrorMessage: string;
  }): Promise<boolean> {
    const { collection, addErrorMessage } = params;
    if (!isSameNameQmdCollectionAlreadyExistsError(collection.name, addErrorMessage)) {
      return false;
    }
    log.warn(
      `qmd collection add conflict for ${collection.name}: collection name already exists; recreating managed collection`,
    );
    try {
      await this.removeCollection(collection.name);
    } catch (removeErr) {
      const removeMessage = formatErrorMessage(removeErr);
      if (!isQmdCollectionMissingError(removeMessage)) {
        log.warn(`qmd collection remove failed for ${collection.name}: ${removeMessage}`);
        return false;
      }
    }
    try {
      await this.ensureCollectionPath(collection);
      await this.addCollection(collection.path, collection.name, collection.pattern);
      return true;
    } catch (retryErr) {
      const retryMessage = formatErrorMessage(retryErr);
      log.warn(
        `qmd collection add failed for ${collection.name} after recreating same-name collection: ${retryMessage} (initial: ${addErrorMessage})`,
      );
      return false;
    }
  }

  private async listCollectionsBestEffort(stats?: {
    listCalls: number;
    showCalls: number;
  }): Promise<Map<string, ListedQmdCollection>> {
    const existing = new Map<string, ListedQmdCollection>();
    try {
      if (stats) {
        stats.listCalls += 1;
      }
      const result = await this.runQmd(["collection", "list", "--json"], {
        timeoutMs: this.qmd.update.commandTimeoutMs,
      });
      for (const [name, details] of parseListedQmdCollections(result.stdout)) {
        existing.set(name, details);
      }
    } catch {
      // Older qmd versions might not support list --json.
    }

    for (const collection of this.qmd.collections) {
      const entry = existing.get(collection.name);
      if (!entry || entry.path) {
        continue;
      }
      try {
        if (stats) {
          stats.showCalls += 1;
        }
        const showResult = await this.runQmd(["collection", "show", collection.name], {
          timeoutMs: this.qmd.update.commandTimeoutMs,
        });
        const shown = parseShownQmdCollection(showResult.stdout);
        if (shown.path) {
          entry.path = shown.path;
        }
        if (shown.pattern && !entry.pattern) {
          entry.pattern = shown.pattern;
        }
      } catch {
        // Incomplete metadata preserves the non-destructive reconciliation path.
      }
    }
    return existing;
  }

  private async tryRebindConflictingCollection(params: {
    collection: ManagedQmdCollection;
    existing: Map<string, ListedQmdCollection>;
    addErrorMessage: string;
  }): Promise<boolean> {
    const { collection, existing, addErrorMessage } = params;
    let conflictName = findQmdCollectionByPathPattern({
      collection,
      listed: existing,
      workspaceDir: this.workspaceDir,
    });
    if (!conflictName) {
      const refreshed = await this.listCollectionsBestEffort();
      existing.clear();
      for (const [name, details] of refreshed) {
        existing.set(name, details);
      }
      conflictName = findQmdCollectionByPathPattern({
        collection,
        listed: existing,
        workspaceDir: this.workspaceDir,
      });
    }
    if (!conflictName) {
      const parsedConflictName = parseConflictingQmdCollectionName(addErrorMessage);
      if (parsedConflictName) {
        log.warn(
          `qmd collection add conflict for ${collection.name}: qmd reported existing collection ${parsedConflictName}, but list output did not include verifiable path/pattern metadata; refusing automatic rebind. If ${parsedConflictName} is stale, remove it manually with 'qmd collection remove ${parsedConflictName}'`,
        );
      }
      return false;
    }
    if (conflictName === collection.name) {
      existing.set(collection.name, {
        path: collection.path,
        pattern: collection.pattern,
      });
      return true;
    }
    log.warn(
      `qmd collection add conflict for ${collection.name}: path+pattern already bound by ${conflictName}; rebinding`,
    );
    try {
      await this.removeCollection(conflictName);
      existing.delete(conflictName);
    } catch (removeErr) {
      const removeMessage = formatErrorMessage(removeErr);
      if (!isQmdCollectionMissingError(removeMessage)) {
        log.warn(`qmd collection remove failed for ${conflictName}: ${removeMessage}`);
      }
      return false;
    }
    try {
      await this.addCollection(collection.path, collection.name, collection.pattern);
      existing.set(collection.name, {
        path: collection.path,
        pattern: collection.pattern,
      });
      return true;
    } catch (retryErr) {
      const retryMessage = formatErrorMessage(retryErr);
      log.warn(
        `qmd collection add failed for ${collection.name} after rebinding ${conflictName}: ${retryMessage} (initial: ${addErrorMessage})`,
      );
      return false;
    }
  }

  private async migrateLegacyUnscopedCollections(
    existing: Map<string, ListedQmdCollection>,
  ): Promise<void> {
    for (const collection of this.qmd.collections) {
      if (existing.has(collection.name)) {
        continue;
      }
      const legacyName = deriveLegacyQmdCollectionName(collection.name, this.agentId);
      if (!legacyName) {
        continue;
      }
      const listedLegacy = existing.get(legacyName);
      if (!listedLegacy) {
        continue;
      }
      if (
        !canMigrateLegacyQmdCollection({
          collection,
          listed: listedLegacy,
          workspaceDir: this.workspaceDir,
        })
      ) {
        log.debug(
          `qmd legacy collection migration skipped for ${legacyName} (path/pattern mismatch)`,
        );
        continue;
      }
      try {
        await this.removeCollection(legacyName);
        existing.delete(legacyName);
      } catch (err) {
        const message = formatErrorMessage(err);
        if (!isQmdCollectionMissingError(message)) {
          log.warn(`qmd collection remove failed for ${legacyName}: ${message}`);
        }
      }
    }
  }

  private async ensureCollectionPath(collection: ManagedQmdCollection): Promise<void> {
    if (
      collection.pattern.includes("*") ||
      collection.pattern.includes("?") ||
      collection.pattern.includes("[")
    ) {
      await fs.mkdir(collection.path, { recursive: true });
    }
  }

  private async addCollection(pathArg: string, name: string, pattern: string): Promise<void> {
    const candidateFlags = resolveQmdCollectionPatternFlags(this.collectionPatternFlag);
    let lastError: unknown;
    for (const flag of candidateFlags) {
      try {
        await this.runQmd(["collection", "add", pathArg, "--name", name, flag, pattern], {
          timeoutMs: this.qmd.update.commandTimeoutMs,
        });
        this.collectionPatternFlag = flag;
        return;
      } catch (err) {
        lastError = err;
        if (!isUnsupportedQmdOptionError(err) || candidateFlags.at(-1) === flag) {
          throw err;
        }
        log.warn(`qmd collection add rejected ${flag}; retrying with legacy compatibility flag`);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async removeCollection(name: string): Promise<void> {
    await this.runQmd(["collection", "remove", name], {
      timeoutMs: this.qmd.update.commandTimeoutMs,
    });
  }

  private async refreshManagedCollectionIndexConfig(): Promise<void> {
    const configPath = path.join(this.xdgConfigHome, "qmd", QMD_INDEX_CONFIG_FILE);
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, renderQmdCollectionIndexConfig(this.qmd.collections), "utf8");
  }

  private async rebuildManagedCollectionsForRepair(reason: string): Promise<void> {
    try {
      await this.refreshManagedCollectionIndexConfig();
    } catch (configErr) {
      log.warn(
        `qmd managed collection index refresh failed for update repair (${reason}): ${formatErrorMessage(configErr)}`,
      );
    }
    for (const collection of this.qmd.collections) {
      try {
        await this.removeCollection(collection.name);
      } catch (removeErr) {
        const removeMessage = formatErrorMessage(removeErr);
        if (!isQmdCollectionMissingError(removeMessage)) {
          log.warn(`qmd collection remove failed for ${collection.name}: ${removeMessage}`);
        }
      }
      try {
        await this.addCollection(collection.path, collection.name, collection.pattern);
      } catch (addErr) {
        const addMessage = formatErrorMessage(addErr);
        if (!isQmdCollectionAlreadyExistsError(addMessage)) {
          log.warn(`qmd collection add failed for ${collection.name}: ${addMessage}`);
        }
      }
    }
    log.warn(`qmd managed collections rebuilt for update repair (${reason})`);
  }
}
