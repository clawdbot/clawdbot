import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import chokidar, { type FSWatcher } from "chokidar";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { withFileLock } from "openclaw/plugin-sdk/file-lock";
import {
  createSubsystemLogger,
  resolveMemorySearchSyncConfig,
  resolveAgentWorkspaceDir,
  resolveGlobalSingleton,
  resolveStateDir,
  writeFileWithinRoot,
  type OpenClawConfig,
  type ResolvedMemorySearchSyncConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import {
  buildSessionEntry,
  deriveQmdScopeChannel,
  deriveQmdScopeChatType,
  isQmdScopeAllowed,
  listSessionFilesForAgent,
  parseQmdQueryJson,
  resolveCliSpawnInvocation,
  runCliCommand,
  type QmdQueryResult,
  type SessionFileEntry,
} from "openclaw/plugin-sdk/memory-core-host-engine-qmd";
import {
  isFileMissingError,
  requireNodeSqlite,
  statRegularFile,
  type MemoryEmbeddingProbeResult,
  type MemoryProviderStatus,
  type MemorySearchManager,
  type MemorySearchResult,
  type MemorySource,
  type MemorySyncProgressUpdate,
  type ResolvedMemoryBackendConfig,
  type ResolvedQmdConfig,
  type ResolvedQmdMcporterConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import {
  localeLowercasePreservingWhitespace,
  normalizeLowercaseStringOrEmpty,
} from "openclaw/plugin-sdk/text-runtime";
import { asRecord } from "../dreaming-shared.js";
import { resolveQmdCollectionPatternFlags, type QmdCollectionPatternFlag } from "./qmd-compat.js";

type SqliteDatabase = import("node:sqlite").DatabaseSync;

const log = createSubsystemLogger("memory");

const SNIPPET_HEADER_RE = /@@\s*-([0-9]+),([0-9]+)/;
const SEARCH_PENDING_UPDATE_WAIT_MS = 500;
const QMD_WATCH_STABILITY_MS = 200;
const MAX_QMD_OUTPUT_CHARS = 200_000;
const NUL_MARKER_RE = /(?:\^@|\\0|\\x00|\\u0000|null\s*byte|nul\s*byte)/i;
const QMD_EMBED_BACKOFF_BASE_MS = 60_000;
const QMD_EMBED_BACKOFF_MAX_MS = 60 * 60 * 1000;
const HAN_SCRIPT_RE = /[\u3400-\u9fff]/u;
const QMD_EMBED_LOCK_MIN_WAIT_MS = 15 * 60 * 1000;
const QMD_EMBED_LOCK_RETRY_TEMPLATE = {
  factor: 1.2,
  minTimeout: 250,
  maxTimeout: 10_000,
  randomize: true,
} as const;
const MCPORTER_STATE_KEY = Symbol.for("openclaw.mcporterState");
const QMD_EMBED_QUEUE_KEY = Symbol.for("openclaw.qmdEmbedQueueTail");
const IGNORED_MEMORY_WATCH_DIR_NAMES = new Set([
  ".git",
  "node_modules",
  ".pnpm-store",
  ".venv",
  "venv",
  ".tox",
  "__pycache__",
]);

type McporterState = {
  coldStartWarned: boolean;
  daemonStart: Promise<void> | null;
};

type QmdEmbedQueueState = {
  tail: Promise<void>;
};

function getMcporterState(): McporterState {
  return resolveGlobalSingleton<McporterState>(MCPORTER_STATE_KEY, () => ({
    coldStartWarned: false,
    daemonStart: null,
  }));
}

function getQmdEmbedQueueState(): QmdEmbedQueueState {
  return resolveGlobalSingleton<QmdEmbedQueueState>(QMD_EMBED_QUEUE_KEY, () => ({
    tail: Promise.resolve(),
  }));
}

function _hasHanScript(value: string): boolean {
  return HAN_SCRIPT_RE.test(value);
}

function normalizeHanBm25Query(query: string): string {
  const trimmed = query.trim();
  // Keep Han/CJK BM25 queries intact so OpenClaw search semantics match direct qmd search.
  return trimmed;
}

function parseQmdStatusVectorCount(raw: string): number | null {
  const match = raw.match(/(?:^|\n)\s*Vectors:\s*(\d+)\b/i);
  if (!match) {
    return null;
  }
  const count = Number.parseInt(match[1] ?? "", 10);
  return Number.isFinite(count) ? count : null;
}

function resolveStableJitterMs(params: { seed: string; windowMs: number }): number {
  if (params.windowMs <= 0) {
    return 0;
  }
  const hash = crypto.createHash("sha256").update(params.seed).digest();
  const bucket = hash.readUInt32BE(0);
  return bucket % (Math.floor(params.windowMs) + 1);
}

function resolveQmdEmbedLockOptions(embedTimeoutMs: number) {
  const expectedEmbedMs = Math.max(1, embedTimeoutMs);
  const waitBudgetMs = Math.max(QMD_EMBED_LOCK_MIN_WAIT_MS, expectedEmbedMs * 6);
  return {
    retries: {
      retries: Math.max(60, Math.ceil(waitBudgetMs / QMD_EMBED_LOCK_RETRY_TEMPLATE.maxTimeout)),
      ...QMD_EMBED_LOCK_RETRY_TEMPLATE,
    },
    stale: Math.max(QMD_EMBED_LOCK_MIN_WAIT_MS, expectedEmbedMs * 2),
  };
}

function shouldIgnoreMemoryWatchPath(watchPath: string): boolean {
  const normalized = path.normalize(watchPath);
  const parts = normalized
    .split(path.sep)
    .map((segment) => normalizeLowercaseStringOrEmpty(segment));
  return parts.some((segment) => IGNORED_MEMORY_WATCH_DIR_NAMES.has(segment));
}

type CollectionRoot = {
  path: string;
  kind: MemorySource;
};

type SessionExporterConfig = {
  dir: string;
  retentionMs?: number;
  collectionName: string;
};

type ListedCollection = {
  path?: string;
  pattern?: string;
};

type ManagedCollection = {
  name: string;
  path: string;
  pattern: string;
  kind: "memory" | "custom" | "sessions";
};

type QmdManagerMode = "full" | "status";
type BuiltinQmdMcpTool = "query" | "search" | "vector_search" | "deep_search";
type QmdMcporterSearchParams =
  | {
      mcporter: ResolvedQmdMcporterConfig;
      tool: string;
      searchCommand?: string;
      explicitToolOverride: true;
      query: string;
      limit: number;
      minScore: number;
      collection?: string;
      timeoutMs: number;
    }
  | {
      mcporter: ResolvedQmdMcporterConfig;
      tool: BuiltinQmdMcpTool;
      searchCommand?: string;
      explicitToolOverride: false;
      query: string;
      limit: number;
      minScore: number;
      collection?: string;
      timeoutMs: number;
    };
type QmdMcporterAcrossCollectionsParams =
  | {
      tool: string;
      searchCommand?: string;
      explicitToolOverride: true;
      query: string;
      limit: number;
      minScore: number;
      collectionNames: string[];
    }
  | {
      tool: BuiltinQmdMcpTool;
      searchCommand?: string;
      explicitToolOverride: false;
      query: string;
      limit: number;
      minScore: number;
      collectionNames: string[];
    };

export class QmdMemoryManager implements MemorySearchManager {
  static async create(params: {
    cfg: OpenClawConfig;
    agentId: string;
    resolved: ResolvedMemoryBackendConfig;
    mode?: QmdManagerMode;
  }): Promise<QmdMemoryManager | null> {
    const resolved = params.resolved.qmd;
    if (!resolved) {
      return null;
    }
    const manager = new QmdMemoryManager({ cfg: params.cfg, agentId: params.agentId, resolved });
    await manager.initialize(params.mode ?? "full");
    return manager;
  }

  private readonly cfg: OpenClawConfig;
  private readonly agentId: string;
  private readonly qmd: ResolvedQmdConfig;
  private readonly workspaceDir: string;
  private readonly stateDir: string;
  private readonly agentStateDir: string;
  private readonly qmdDir: string;
  private readonly xdgConfigHome: string;
  private readonly xdgCacheHome: string;
  private readonly indexPath: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly syncSettings: ResolvedMemorySearchSyncConfig | null;
  private readonly managedCollectionNames: string[];
  private readonly collectionRoots = new Map<string, CollectionRoot>();
  private readonly sources = new Set<MemorySource>();
  private readonly docPathCache = new Map<
    string,
    { rel: string; abs: string; source: MemorySource }
  >();
  private readonly exportedSessionState = new Map<
    string,
    {
      hash: string;
      mtimeMs: number;
      target: string;
    }
  >();
  private readonly maxQmdOutputChars = MAX_QMD_OUTPUT_CHARS;
  private readonly sessionExporter: SessionExporterConfig | null;
  private updateTimer: NodeJS.Timeout | null = null;
  private embedTimer: NodeJS.Timeout | null = null;
  private watcher: FSWatcher | null = null;
  private watchTimer: NodeJS.Timeout | null = null;
  private pendingUpdate: Promise<void> | null = null;
  private queuedForcedUpdate: Promise<void> | null = null;
  private queuedForcedRuns = 0;
  private dirty = false;
  private closed = false;
  private db: SqliteDatabase | null = null;
  private lastUpdateAt: number | null = null;
  private lastEmbedAt: number | null = null;
  private embedBackoffUntil: number | null = null;
  private embedFailureCount = 0;
  private vectorAvailable: boolean | null = null;
  private vectorStatusDetail: string | null = null;
  private attemptedNullByteCollectionRepair = false;
  private attemptedDuplicateDocumentRepair = false;
  private readonly sessionWarm = new Set<string>();
  private collectionPatternFlag: QmdCollectionPatternFlag | null = "--glob";

  private constructor(params: {
    cfg: OpenClawConfig;
    agentId: string;
    resolved: ResolvedQmdConfig;
  }) {
    this.cfg = params.cfg;
    this.agentId = params.agentId;
    this.qmd = params.resolved;
    this.workspaceDir = resolveAgentWorkspaceDir(params.cfg, params.agentId);
    this.stateDir = resolveStateDir(process.env, os.homedir);
    this.agentStateDir = path.join(this.stateDir, "agents", this.agentId);
    this.qmdDir = path.join(this.agentStateDir, "qmd");
    this.syncSettings = resolveMemorySearchSyncConfig(params.cfg, params.agentId);
    // QMD uses XDG base dirs for its internal state.
    // Collections are managed via `qmd collection add` and stored inside the index DB.
    // - config:  $XDG_CONFIG_HOME (contexts, etc.)
    // - cache:   $XDG_CACHE_HOME/qmd/index.sqlite
    this.xdgConfigHome = path.join(this.qmdDir, "xdg-config");
    this.xdgCacheHome = path.join(this.qmdDir, "xdg-cache");
    this.indexPath = path.join(this.xdgCacheHome, "qmd", "index.sqlite");

    this.env = {
      ...process.env,
      XDG_CONFIG_HOME: this.xdgConfigHome,
      // QMD resolves index.yml relative to QMD_CONFIG_DIR rather than XDG_CONFIG_HOME.
      // Point it at the nested qmd config directory so per-agent collections are visible.
      QMD_CONFIG_DIR: path.join(this.xdgConfigHome, "qmd"),
      XDG_CACHE_HOME: this.xdgCacheHome,
      NO_COLOR: "1",
    };
    this.sessionExporter = this.qmd.sessions.enabled
      ? {
          dir: this.qmd.sessions.exportDir ?? path.join(this.qmdDir, "sessions"),
          retentionMs: this.qmd.sessions.retentionDays
            ? this.qmd.sessions.retentionDays * 24 * 60 * 60 * 1000
            : undefined,
          collectionName: this.pickSessionCollectionName(),
        }
      : null;
    if (this.sessionExporter) {
      this.qmd.collections = [
        ...this.qmd.collections,
        {
          name: this.sessionExporter.collectionName,
          path: this.sessionExporter.dir,
          pattern: "**/*.md",
          kind: "sessions",
        },
      ];
    }
    this.managedCollectionNames = this.computeManagedCollectionNames();
  }

  private async initialize(mode: QmdManagerMode): Promise<void> {
    this.bootstrapCollections();
    if (mode === "status") {
      return;
    }

    await fs.mkdir(this.xdgConfigHome, { recursive: true });
    await fs.mkdir(this.xdgCacheHome, { recursive: true });
    await fs.mkdir(path.dirname(this.indexPath), { recursive: true });
    if (this.sessionExporter) {
      await fs.mkdir(this.sessionExporter.dir, { recursive: true });
    }

    // QMD stores its ML models under $XDG_CACHE_HOME/qmd/models/.  Because we
    // override XDG_CACHE_HOME to isolate the index per-agent, qmd would not
    // find models installed at the default location (~/.cache/qmd/models/) and
    // would attempt to re-download them on every invocation.  Symlink the
    // default models directory into our custom cache so the index stays
    // isolated while models are shared.
    await this.symlinkSharedModels();

    await this.ensureCollections();
    this.ensureWatcher();

    if (this.qmd.update.onBoot) {
      const bootRun = this.runUpdate("boot", true);
      if (this.qmd.update.waitForBootSync) {
        await bootRun.catch((err) => {
          log.warn(`qmd boot update failed: ${String(err)}`);
        });
      } else {
        void bootRun.catch((err) => {
          log.warn(`qmd boot update failed: ${String(err)}`);
        });
      }
    }
    if (this.qmd.update.intervalMs > 0) {
      this.updateTimer = setInterval(() => {
        void this.runUpdate("interval").catch((err) => {
          log.warn(`qmd update failed (${String(err)})`);
        });
      }, this.qmd.update.intervalMs);
    }
    if (this.shouldScheduleEmbedTimer()) {
      const startPeriodicEmbedTimer = () => {
        this.embedTimer = setInterval(() => {
          void this.runUpdate("embed-interval").catch((err) => {
            log.warn(`qmd embed interval update failed (${String(err)})`);
          });
        }, this.qmd.update.embedIntervalMs);
      };
      const initialDelayMs = this.resolveEmbedStartupJitterMs();
      if (initialDelayMs > 0) {
        this.embedTimer = setTimeout(() => {
          this.embedTimer = null;
          if (this.closed) {
            return;
          }
          void this.runUpdate("embed-interval")
            .catch((err) => {
              log.warn(`qmd embed interval update failed (${String(err)})`);
            })
            .finally(() => {
              if (!this.closed) {
                startPeriodicEmbedTimer();
              }
            });
        }, initialDelayMs);
      } else {
        startPeriodicEmbedTimer();
      }
    }
  }

  private bootstrapCollections(): void {
    this.collectionRoots.clear();
    this.sources.clear();
    for (const collection of this.qmd.collections) {
      const kind: MemorySource = collection.kind === "sessions" ? "sessions" : "memory";
      this.collectionRoots.set(collection.name, { path: collection.path, kind });
      this.sources.add(kind);
    }
  }

  private async ensureCollections(): Promise<void> {
    // QMD collections are persisted inside the index database and must be created
    // via the CLI. Prefer listing existing collections when supported, otherwise
    // fall back to best-effort idempotent `qmd collection add`.
    const existing = await this.listCollectionsBestEffort();

    await this.migrateLegacyUnscopedCollections(existing);

    for (const collection of this.qmd.collections) {
      const listed = existing.get(collection.name);
      if (listed && !this.shouldRebindCollection(collection, listed)) {
        continue;
      }
      if (listed) {
        try {
          await this.removeCollection(collection.name);
        } catch (err) {
          const message = formatErrorMessage(err);
          if (!this.isCollectionMissingError(message)) {
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
        if (this.isCollectionAlreadyExistsError(message)) {
          const rebound = await this.tryRebindConflictingCollection({
            collection,
            existing,
            addErrorMessage: message,
          });
          if (!rebound) {
            log.warn(`qmd collection add skipped for ${collection.name}: ${message}`);
          }
          continue;
        }
        log.warn(`qmd collection add failed for ${collection.name}: ${message}`);
      }
    }
  }

  private async listCollectionsBestEffort(): Promise<Map<string, ListedCollection>> {
    const existing = new Map<string, ListedCollection>();
    try {
      const result = await this.runQmd(["collection", "list", "--json"], {
        timeoutMs: this.qmd.update.commandTimeoutMs,
      });
      const parsed = this.parseListedCollections(result.stdout);
      for (const [name, details] of parsed) {
        existing.set(name, details);
      }
    } catch {
      // ignore; older qmd versions might not support list --json.
    }
    return existing;
  }

  private findCollectionByPathPattern(
    collection: ManagedCollection,
    listed: Map<string, ListedCollection>,
  ): string | null {
    for (const [name, details] of listed) {
      if (!details.path || typeof details.pattern !== "string") {
        continue;
      }
      if (!this.pathsMatch(details.path, collection.path)) {
        continue;
      }
      if (details.pattern !== collection.pattern) {
        continue;
      }
      return name;
    }
    return null;
  }

  private async tryRebindConflictingCollection(params: {
    collection: ManagedCollection;
    existing: Map<string, ListedCollection>;
    addErrorMessage: string;
  }): Promise<boolean> {
    const { collection, existing, addErrorMessage } = params;
    let conflictName = this.findCollectionByPathPattern(collection, existing);
    if (!conflictName) {
      const refreshed = await this.listCollectionsBestEffort();
      existing.clear();
      for (const [name, details] of refreshed) {
        existing.set(name, details);
      }
      conflictName = this.findCollectionByPathPattern(collection, existing);
    }

    if (!conflictName) {
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
      if (!this.isCollectionMissingError(removeMessage)) {
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
    existing: Map<string, ListedCollection>,
  ): Promise<void> {
    for (const collection of this.qmd.collections) {
      if (existing.has(collection.name)) {
        continue;
      }
      const legacyName = this.deriveLegacyCollectionName(collection.name);
      if (!legacyName) {
        continue;
      }
      const listedLegacy = existing.get(legacyName);
      if (!listedLegacy) {
        continue;
      }
      if (!this.canMigrateLegacyCollection(collection, listedLegacy)) {
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
        if (!this.isCollectionMissingError(message)) {
          log.warn(`qmd collection remove failed for ${legacyName}: ${message}`);
        }
      }
    }
  }

  private deriveLegacyCollectionName(scopedName: string): string | null {
    const agentSuffix = `-${this.sanitizeCollectionNameSegment(this.agentId)}`;
    if (!scopedName.endsWith(agentSuffix)) {
      return null;
    }
    const legacyName = scopedName.slice(0, -agentSuffix.length).trim();
    return legacyName || null;
  }

  private canMigrateLegacyCollection(
    collection: ManagedCollection,
    listedLegacy: ListedCollection,
  ): boolean {
    if (listedLegacy.path && !this.pathsMatch(listedLegacy.path, collection.path)) {
      return false;
    }
    if (typeof listedLegacy.pattern === "string" && listedLegacy.pattern !== collection.pattern) {
      return false;
    }
    return true;
  }

  private async ensureCollectionPath(collection: {
    path: string;
    pattern: string;
    kind: "memory" | "custom" | "sessions";
  }): Promise<void> {
    if (!this.isDirectoryGlobPattern(collection.pattern)) {
      return;
    }
    await fs.mkdir(collection.path, { recursive: true });
  }

  private isDirectoryGlobPattern(pattern: string): boolean {
    return pattern.includes("*") || pattern.includes("?") || pattern.includes("[");
  }

  private isCollectionAlreadyExistsError(message: string): boolean {
    const lower = normalizeLowercaseStringOrEmpty(message);
    return lower.includes("already exists") || lower.includes("exists");
  }

  private isCollectionMissingError(message: string): boolean {
    const lower = normalizeLowercaseStringOrEmpty(message);
    return (
      lower.includes("not found") || lower.includes("does not exist") || lower.includes("missing")
    );
  }

  private isMissingCollectionSearchError(err: unknown): boolean {
    const message = formatErrorMessage(err);
    return (
      this.isCollectionMissingError(message) &&
      normalizeLowercaseStringOrEmpty(message).includes("collection")
    );
  }

  private async tryRepairMissingCollectionSearch(err: unknown): Promise<boolean> {
    if (!this.isMissingCollectionSearchError(err)) {
      return false;
    }
    log.warn(
      "qmd search failed because a managed collection is missing; repairing collections and retrying once",
    );
    await this.ensureCollections();
    return true;
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
        if (!this.isUnsupportedQmdOptionError(err) || candidateFlags.at(-1) === flag) {
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

  private parseListedCollections(output: string): Map<string, ListedCollection> {
    const listed = new Map<string, ListedCollection>();
    const trimmed = output.trim();
    if (!trimmed) {
      return listed;
    }
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed)) {
        for (const entry of parsed) {
          if (typeof entry === "string") {
            listed.set(entry, {});
            continue;
          }
          if (!entry || typeof entry !== "object") {
            continue;
          }
          const name = (entry as { name?: unknown }).name;
          if (typeof name !== "string") {
            continue;
          }
          const listedPath = (entry as { path?: unknown }).path;
          const listedPattern = (entry as { pattern?: unknown; mask?: unknown }).pattern;
          const listedMask = (entry as { mask?: unknown }).mask;
          listed.set(name, {
            path: typeof listedPath === "string" ? listedPath : undefined,
            pattern:
              typeof listedPattern === "string"
                ? listedPattern
                : typeof listedMask === "string"
                  ? listedMask
                  : undefined,
          });
        }
        return listed;
      }
    } catch {
      // Some qmd builds ignore `--json` and still print table output.
    }

    let currentName: string | null = null;
    for (const rawLine of output.split(/\r?\n/)) {
      const line = rawLine.trimEnd();
      if (!line.trim()) {
        currentName = null;
        continue;
      }
      const collectionLine = /^\s*([a-z0-9._-]+)\s+\(qmd:\/\/[^)]+\)\s*$/i.exec(line);
      if (collectionLine) {
        currentName = collectionLine[1];
        if (!listed.has(currentName)) {
          listed.set(currentName, {});
        }
        continue;
      }
      if (/^\s*collections\b/i.test(line)) {
        continue;
      }
      const bareNameLine = /^\s*([a-z0-9._-]+)\s*$/i.exec(line);
      if (bareNameLine && !line.includes(":")) {
        currentName = bareNameLine[1];
        if (!listed.has(currentName)) {
          listed.set(currentName, {});
        }
        continue;
      }
      if (!currentName) {
        continue;
      }
      const patternLine = /^\s*(?:pattern|mask)\s*:\s*(.+?)\s*$/i.exec(line);
      if (patternLine) {
        const existing = listed.get(currentName) ?? {};
        existing.pattern = patternLine[1].trim();
        listed.set(currentName, existing);
        continue;
      }
      const pathLine = /^\s*path\s*:\s*(.+?)\s*$/i.exec(line);
      if (pathLine) {
        const existing = listed.get(currentName) ?? {};
        existing.path = pathLine[1].trim();
        listed.set(currentName, existing);
      }
    }
    return listed;
  }

  private shouldRebindCollection(collection: ManagedCollection, listed: ListedCollection): boolean {
    if (typeof listed.pattern === "string" && listed.pattern !== collection.pattern) {
      return true;
    }
    if (!listed.path) {
      // Older qmd versions may only return names from `collection list --json`.
      // If the pattern is also missing, do not perform destructive rebinds when
      // metadata is incomplete: remove+add can permanently drop collections if
      // add fails (for example on timeout).
      return false;
    }
    if (!this.pathsMatch(listed.path, collection.path)) {
      return true;
    }
    return false;
  }

  private pathsMatch(left: string, right: string): boolean {
    const normalize = (value: string): string => {
      const resolved = path.isAbsolute(value)
        ? path.resolve(value)
        : path.resolve(this.workspaceDir, value);
      const normalized = path.normalize(resolved);
      return process.platform === "win32"
        ? normalizeLowercaseStringOrEmpty(normalized)
        : normalized;
    };
    return normalize(left) === normalize(right);
  }

  private shouldRepairNullByteCollectionError(err: unknown): boolean {
    const message = formatErrorMessage(err);
    const lower = normalizeLowercaseStringOrEmpty(message);
    return (
      (lower.includes("enotdir") ||
        lower.includes("not a directory") ||
        lower.includes("enoent") ||
        lower.includes("no such file")) &&
      NUL_MARKER_RE.test(message)
    );
  }

  private shouldRepairDuplicateDocumentConstraint(err: unknown): boolean {
    const message = formatErrorMessage(err);
    const lower = normalizeLowercaseStringOrEmpty(message);
    return (
      lower.includes("unique constraint failed") &&
      lower.includes("documents.collection") &&
      lower.includes("documents.path")
    );
  }

  private async rebuildManagedCollectionsForRepair(reason: string): Promise<void> {
    for (const collection of this.qmd.collections) {
      try {
        await this.removeCollection(collection.name);
      } catch (removeErr) {
        const removeMessage = formatErrorMessage(removeErr);
        if (!this.isCollectionMissingError(removeMessage)) {
          log.warn(`qmd collection remove failed for ${collection.name}: ${removeMessage}`);
        }
      }
      try {
        await this.addCollection(collection.path, collection.name, collection.pattern);
      } catch (addErr) {
        const addMessage = formatErrorMessage(addErr);
        if (!this.isCollectionAlreadyExistsError(addMessage)) {
          log.warn(`qmd collection add failed for ${collection.name}: ${addMessage}`);
        }
      }
    }
    log.warn(`qmd managed collections rebuilt for update repair (${reason})`);
  }

  private async tryRepairNullByteCollections(err: unknown, reason: string): Promise<boolean> {
    if (this.attemptedNullByteCollectionRepair) {
      return false;
    }
    if (!this.shouldRepairNullByteCollectionError(err)) {
      return false;
    }
    this.attemptedNullByteCollectionRepair = true;
    log.warn(
      `qmd update failed with suspected null-byte collection metadata (${reason}); rebuilding managed collections and retrying once`,
    );
    await this.rebuildManagedCollectionsForRepair(`null-byte metadata (${reason})`);
    return true;
  }

  private async tryRepairDuplicateDocumentConstraint(
    err: unknown,
    reason: string,
  ): Promise<boolean> {
    if (this.attemptedDuplicateDocumentRepair) {
      return false;
    }
    if (!this.shouldRepairDuplicateDocumentConstraint(err)) {
      return false;
    }
    this.attemptedDuplicateDocumentRepair = true;
    log.warn(
      `qmd update failed with duplicate document constraint (${reason}); rebuilding managed collections and retrying once`,
    );
    await this.rebuildManagedCollectionsForRepair(`duplicate-document constraint (${reason})`);
    return true;
  }

  async search(
    query: string,
    opts?: { maxResults?: number; minScore?: number; sessionKey?: string },
  ): Promise<MemorySearchResult[]> {
    if (!this.isScopeAllowed(opts?.sessionKey)) {
      this.logScopeDenied(opts?.sessionKey);
      return [];
    }
    const trimmed = query.trim();
    if (!trimmed) {
      return [];
    }
    await this.maybeWarmSession(opts?.sessionKey);
    await this.maybeSyncDirtySearchState();
    await this.waitForPendingUpdateBeforeSearch();
    const limit = Math.min(
      this.qmd.limits.maxResults,
      opts?.maxResults ?? this.qmd.limits.maxResults,
    );
    const collectionNames = this.listManagedCollectionNames();
    if (collectionNames.length === 0) {
      log.warn("qmd query skipped: no managed collections configured");
      return [];
    }
    const qmdSearchCommand = this.qmd.searchMode;
    const explicitSearchTool = this.qmd.searchTool;
    const mcporterEnabled = this.qmd.mcporter.enabled;
    const runSearchAttempt = async (
      allowMissingCollectionRepair: boolean,
    ): Promise<QmdQueryResult[]> => {
      try {
        if (mcporterEnabled) {
          const minScore = opts?.minScore ?? 0;
          if (explicitSearchTool) {
            if (collectionNames.length > 1) {
              return await this.runMcporterAcrossCollections({
                tool: explicitSearchTool,
                searchCommand: qmdSearchCommand,
                explicitToolOverride: true,
                query: trimmed,
                limit,
                minScore,
                collectionNames,
              });
            }
            return await this.runQmdSearchViaMcporter({
              mcporter: this.qmd.mcporter,
              tool: explicitSearchTool,
              searchCommand: qmdSearchCommand,
              explicitToolOverride: true,
              query: trimmed,
              limit,
              minScore,
              collection: collectionNames[0],
              timeoutMs: this.qmd.limits.timeoutMs,
            });
          }
          const tool = this.resolveQmdMcpTool(qmdSearchCommand);
          if (collectionNames.length > 1) {
            return await this.runMcporterAcrossCollections({
              tool,
              searchCommand: qmdSearchCommand,
              explicitToolOverride: false,
              query: trimmed,
              limit,
              minScore,
              collectionNames,
            });
          }
          return await this.runQmdSearchViaMcporter({
            mcporter: this.qmd.mcporter,
            tool,
            searchCommand: qmdSearchCommand,
            explicitToolOverride: false,
            query: trimmed,
            limit,
            minScore,
            collection: collectionNames[0],
            timeoutMs: this.qmd.limits.timeoutMs,
          });
        }
        if (collectionNames.length > 1) {
          return await this.runQueryAcrossCollections(
            trimmed,
            limit,
            collectionNames,
            qmdSearchCommand,
          );
        }
        const args = this.buildSearchArgs(qmdSearchCommand, trimmed, limit);
        args.push(...this.buildCollectionFilterArgs(collectionNames));
        // Always scope to managed collections (default + custom). Even for `search`/`vsearch`,
        // pass collection filters; if a given QMD build rejects these flags, we fall back to `query`.
        const result = await this.runQmd(args, { timeoutMs: this.qmd.limits.timeoutMs });
        return parseQmdQueryJson(result.stdout, result.stderr);
      } catch (err) {
        if (allowMissingCollectionRepair && this.isMissingCollectionSearchError(err)) {
          throw err;
        }
        if (
          !mcporterEnabled &&
          qmdSearchCommand !== "query" &&
          this.isUnsupportedQmdOptionError(err)
        ) {
          log.warn(
            `qmd ${qmdSearchCommand} does not support configured flags; retrying search with qmd query`,
          );
          try {
            if (collectionNames.length > 1) {
              return await this.runQueryAcrossCollections(trimmed, limit, collectionNames, "query");
            }
            const fallbackArgs = this.buildSearchArgs("query", trimmed, limit);
            fallbackArgs.push(...this.buildCollectionFilterArgs(collectionNames));
            const fallback = await this.runQmd(fallbackArgs, {
              timeoutMs: this.qmd.limits.timeoutMs,
            });
            return parseQmdQueryJson(fallback.stdout, fallback.stderr);
          } catch (fallbackErr) {
            log.warn(`qmd query fallback failed: ${String(fallbackErr)}`);
            throw fallbackErr instanceof Error ? fallbackErr : new Error(String(fallbackErr));
          }
        }
        const label = mcporterEnabled ? "mcporter/qmd" : `qmd ${qmdSearchCommand}`;
        log.warn(`${label} failed: ${String(err)}`);
        throw err instanceof Error ? err : new Error(String(err));
      }
    };

    let parsed: QmdQueryResult[];
    try {
      parsed = await runSearchAttempt(true);
    } catch (err) {
      if (!(await this.tryRepairMissingCollectionSearch(err))) {
        throw err instanceof Error ? err : new Error(String(err));
      }
      parsed = await runSearchAttempt(false);
    }
    const results: MemorySearchResult[] = [];
    for (const entry of parsed) {
      const docHints = this.normalizeDocHints({
        preferredCollection: entry.collection,
        preferredFile: entry.file,
      });
      const doc = await this.resolveDocLocation(entry.docid, docHints);
      if (!doc) {
        continue;
      }
      const snippet = entry.snippet?.slice(0, this.qmd.limits.maxSnippetChars) ?? "";
      const lines = this.resolveSnippetLines(entry, snippet);
      const score = typeof entry.score === "number" ? entry.score : 0;
      const minScore = opts?.minScore ?? 0;
      if (score < minScore) {
        continue;
      }
      results.push({
        path: doc.rel,
        startLine: lines.startLine,
        endLine: lines.endLine,
        score,
        snippet,
        source: doc.source,
      });
    }
    return this.clampResultsByInjectedChars(this.diversifyResultsBySource(results, limit));
  }

  async sync(params?: {
    reason?: string;
    force?: boolean;
    sessionFiles?: string[];
    progress?: (update: MemorySyncProgressUpdate) => void;
  }): Promise<void> {
    if (params?.sessionFiles?.some((sessionFile) => sessionFile.trim().length > 0)) {
      log.debug("qmd sync ignoring targeted sessionFiles hint; running regular update");
    }
    if (params?.progress) {
      params.progress({ completed: 0, total: 1, label: "Updating QMD index…" });
    }
    await this.runUpdate(params?.reason ?? "manual", params?.force);
    if (params?.progress) {
      params.progress({ completed: 1, total: 1, label: "QMD index updated" });
    }
  }

  async readFile(params: {
    relPath: string;
    from?: number;
    lines?: number;
  }): Promise<{ text: string; path: string }> {
    const relPath = params.relPath?.trim();
    if (!relPath) {
      throw new Error("path required");
    }
    const absPath = this.resolveReadPath(relPath);
    if (!absPath.endsWith(".md")) {
      throw new Error("path required");
    }
    const statResult = await statRegularFile(absPath);
    if (statResult.missing) {
      return { text: "", path: relPath };
    }
    if (params.from !== undefined || params.lines !== undefined) {
      const partial = await this.readPartialText(absPath, params.from, params.lines);
      if (partial.missing) {
        return { text: "", path: relPath };
      }
      return { text: partial.text, path: relPath };
    }
    const full = await this.readFullText(absPath);
    if (full.missing) {
      return { text: "", path: relPath };
    }
    if (!params.from && !params.lines) {
      return { text: full.text, path: relPath };
    }
    const lines = full.text.split("\n");
    const start = Math.max(1, params.from ?? 1);
    const count = Math.max(1, params.lines ?? lines.length);
    const slice = lines.slice(start - 1, start - 1 + count);
    return { text: slice.join("\n"), path: relPath };
  }

  status(): MemoryProviderStatus {
    const counts = this.readCounts();
    return {
      backend: "qmd",
      provider: "qmd",
      model: "qmd",
      requestedProvider: "qmd",
      files: counts.totalDocuments,
      chunks: counts.totalDocuments,
      dirty: false,
      workspaceDir: this.workspaceDir,
      dbPath: this.indexPath,
      sources: Array.from(this.sources),
      sourceCounts: counts.sourceCounts,
      vector: {
        enabled: true,
        available: this.vectorAvailable ?? undefined,
        loadError: this.vectorStatusDetail ?? undefined,
      },
      batch: {
        enabled: false,
        failures: 0,
        limit: 0,
        wait: false,
        concurrency: 0,
        pollIntervalMs: 0,
        timeoutMs: 0,
      },
      custom: {
        qmd: {
          collections: this.qmd.collections.length,
          lastUpdateAt: this.lastUpdateAt,
        },
      },
    };
  }

  async probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult> {
    const ok = await this.probeVectorAvailability();
    return {
      ok,
      error: ok ? undefined : (this.vectorStatusDetail ?? "QMD semantic vectors are unavailable"),
    };
  }

  async probeVectorAvailability(): Promise<boolean> {
    try {
      const result = await this.runQmd(["status"], {
        timeoutMs: Math.min(this.qmd.limits.timeoutMs, 5_000),
      });
      const vectorCount = parseQmdStatusVectorCount(`${result.stdout}\n${result.stderr}`);
      if (vectorCount === null) {
        this.vectorAvailable = false;
        this.vectorStatusDetail = "Could not determine QMD vector status from `qmd status`";
        return false;
      }
      this.vectorAvailable = vectorCount > 0;
      this.vectorStatusDetail =
        vectorCount > 0
          ? null
          : "QMD index has 0 vectors; semantic search is unavailable until embeddings finish";
      return this.vectorAvailable;
    } catch (err) {
      const message = formatErrorMessage(err);
      this.vectorAvailable = false;
      this.vectorStatusDetail = `QMD status probe failed: ${message}`;
      return false;
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.updateTimer) {
      clearInterval(this.updateTimer);
      this.updateTimer = null;
    }
    if (this.embedTimer) {
      clearTimeout(this.embedTimer);
      this.embedTimer = null;
    }
    if (this.watchTimer) {
      clearTimeout(this.watchTimer);
      this.watchTimer = null;
    }
    if (this.watcher) {
      await this.watcher.close().catch(() => undefined);
      this.watcher = null;
    }
    this.queuedForcedRuns = 0;
    await this.pendingUpdate?.catch(() => undefined);
    await this.queuedForcedUpdate?.catch(() => undefined);
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  private async runUpdate(
    reason: string,
    force?: boolean,
    opts?: { fromForcedQueue?: boolean },
  ): Promise<void> {
    if (this.closed) {
      return;
    }
    if (this.pendingUpdate) {
      if (force) {
        return this.enqueueForcedUpdate(reason);
      }
      return this.pendingUpdate;
    }
    if (this.queuedForcedUpdate && !opts?.fromForcedQueue) {
      if (force) {
        return this.enqueueForcedUpdate(reason);
      }
      return this.queuedForcedUpdate;
    }
    if (this.shouldSkipUpdate(force)) {
      return;
    }
    const run = async () => {
      if (this.sessionExporter) {
        await this.exportSessions();
      }
      await this.runQmdUpdateWithRetry(reason);
      this.dirty = false;
      if (this.shouldRunEmbed(force)) {
        try {
          await this.withQmdEmbedLock(async () => {
            await this.runQmd(["embed"], {
              timeoutMs: this.qmd.update.embedTimeoutMs,
              discardOutput: true,
            });
          });
          this.lastEmbedAt = Date.now();
          this.embedBackoffUntil = null;
          this.embedFailureCount = 0;
        } catch (err) {
          this.noteEmbedFailure(reason, err);
        }
      }
      this.lastUpdateAt = Date.now();
      this.docPathCache.clear();
    };
    this.pendingUpdate = run().finally(() => {
      this.pendingUpdate = null;
    });
    await this.pendingUpdate;
  }

  private ensureWatcher(): void {
    if (!this.syncSettings?.watch || this.watcher || this.closed) {
      return;
    }
    const watchPaths = new Set<string>();
    for (const collection of this.qmd.collections) {
      if (collection.kind === "sessions") {
        continue;
      }
      watchPaths.add(this.resolveCollectionWatchPath(collection));
    }
    if (watchPaths.size === 0) {
      return;
    }
    this.watcher = chokidar.watch(Array.from(watchPaths), {
      ignoreInitial: true,
      ignored: (watchPath) => shouldIgnoreMemoryWatchPath(watchPath),
      awaitWriteFinish: {
        stabilityThreshold: QMD_WATCH_STABILITY_MS,
        pollInterval: 100,
      },
    });
    const markDirty = () => {
      this.dirty = true;
      this.scheduleWatchSync();
    };
    this.watcher.on("add", markDirty);
    this.watcher.on("change", markDirty);
    this.watcher.on("unlink", markDirty);
  }

  private resolveCollectionWatchPath(collection: ManagedCollection): string {
    return path.join(path.normalize(collection.path), collection.pattern);
  }

  private scheduleWatchSync(): void {
    if (!this.syncSettings?.watch) {
      return;
    }
    if (this.watchTimer) {
      clearTimeout(this.watchTimer);
    }
    this.watchTimer = setTimeout(() => {
      this.watchTimer = null;
      void this.sync({ reason: "watch" }).catch((err) => {
        log.warn(`qmd watch sync failed: ${String(err)}`);
      });
    }, this.syncSettings.watchDebounceMs);
  }

  private async maybeWarmSession(sessionKey?: string): Promise<void> {
    if (!this.syncSettings?.onSessionStart) {
      return;
    }
    const key = sessionKey?.trim() || "";
    if (!key || this.sessionWarm.has(key)) {
      return;
    }
    this.sessionWarm.add(key);
    void this.sync({ reason: "session-start" }).catch((err) => {
      log.warn(`qmd session-start sync failed: ${String(err)}`);
    });
  }

  private async maybeSyncDirtySearchState(): Promise<void> {
    if (!this.syncSettings?.onSearch || !this.dirty) {
      return;
    }
    await this.sync({ reason: "search" });
  }

  private async runQmdUpdateWithRetry(reason: string): Promise<void> {
    const isBootRun = reason === "boot" || reason.startsWith("boot:");
    const maxAttempts = isBootRun ? 3 : 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await this.runQmdUpdateOnce(reason);
        return;
      } catch (err) {
        if (attempt >= maxAttempts || !this.isRetryableUpdateError(err)) {
          throw err;
        }
        const delayMs = 500 * 2 ** (attempt - 1);
        log.warn(
          `qmd update retry ${attempt}/${maxAttempts - 1} after failure (${reason}): ${String(err)}`,
        );
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  private async runQmdUpdateOnce(reason: string): Promise<void> {
    try {
      await this.runQmd(["update"], {
        timeoutMs: this.qmd.update.updateTimeoutMs,
        discardOutput: true,
      });
    } catch (err) {
      if (
        !(await this.tryRepairNullByteCollections(err, reason)) &&
        !(await this.tryRepairDuplicateDocumentConstraint(err, reason))
      ) {
        throw err;
      }
      await this.runQmd(["update"], {
        timeoutMs: this.qmd.update.updateTimeoutMs,
        discardOutput: true,
      });
    }
  }

  private isRetryableUpdateError(err: unknown): boolean {
    if (this.isSqliteBusyError(err)) {
      return true;
    }
    const message = formatErrorMessage(err);
    const normalized = normalizeLowercaseStringOrEmpty(message);
    return normalized.includes("timed out");
  }

  private shouldRunEmbed(force?: boolean): boolean {
    // Keep embeddings current regardless of the active retrieval mode.
    // Search-mode indexing still needs vectors so later mode switches and
    // hybrid flows do not inherit an incomplete QMD index.
    const now = Date.now();
    if (this.embedBackoffUntil !== null && now < this.embedBackoffUntil) {
      return false;
    }
    const embedIntervalMs = this.qmd.update.embedIntervalMs;
    return (
      Boolean(force) ||
      this.lastEmbedAt === null ||
      (embedIntervalMs > 0 && now - this.lastEmbedAt > embedIntervalMs)
    );
  }

  private shouldScheduleEmbedTimer(): boolean {
    const embedIntervalMs = this.qmd.update.embedIntervalMs;
    if (embedIntervalMs <= 0) {
      return false;
    }
    const updateIntervalMs = this.qmd.update.intervalMs;
    return updateIntervalMs <= 0 || updateIntervalMs > embedIntervalMs;
  }

  private resolveEmbedStartupJitterMs(): number {
    const windowMs = this.qmd.update.embedIntervalMs;
    if (windowMs <= 0) {
      return 0;
    }
    const customCollections = this.qmd.collections
      .filter((collection) => collection.kind === "custom")
      .map((collection) => `${collection.path}\u0000${collection.pattern}`)
      .toSorted()
      .join("\u0001");
    if (!customCollections) {
      return 0;
    }
    return resolveStableJitterMs({
      seed: `${this.agentId}:${customCollections}`,
      windowMs,
    });
  }

  private async withQmdEmbedLock<T>(task: () => Promise<T>): Promise<T> {
    const lockPath = path.join(this.stateDir, "qmd", "embed.lock");
    const queue = getQmdEmbedQueueState();
    const previous = queue.tail;
    let releaseCurrent!: () => void;
    const current = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    queue.tail = previous.then(
      () => current,
      () => current,
    );
    await previous.catch(() => undefined);
    try {
      return await withFileLock(
        lockPath,
        resolveQmdEmbedLockOptions(this.qmd.update.embedTimeoutMs),
        task,
      );
    } finally {
      releaseCurrent();
    }
  }

  private noteEmbedFailure(reason: string, err: unknown): void {
    this.embedFailureCount += 1;
    const delayMs = Math.min(
      QMD_EMBED_BACKOFF_MAX_MS,
      QMD_EMBED_BACKOFF_BASE_MS * 2 ** Math.max(0, this.embedFailureCount - 1),
    );
    this.embedBackoffUntil = Date.now() + delayMs;
    log.warn(
      `qmd embed failed (${reason}): ${String(err)}; backing off for ${Math.ceil(delayMs / 1000)}s`,
    );
  }

  private enqueueForcedUpdate(reason: string): Promise<void> {
    this.queuedForcedRuns += 1;
    if (!this.queuedForcedUpdate) {
      this.queuedForcedUpdate = this.drainForcedUpdates(reason).finally(() => {
        this.queuedForcedUpdate = null;
      });
    }
    return this.queuedForcedUpdate;
  }

  private async drainForcedUpdates(reason: string): Promise<void> {
    await this.pendingUpdate?.catch(() => undefined);
    while (!this.closed && this.queuedForcedRuns > 0) {
      this.queuedForcedRuns -= 1;
      await this.runUpdate(`${reason}:queued`, true, { fromForcedQueue: true });
    }
  }

  /**
   * Symlink the default QMD models directory into our custom XDG_CACHE_HOME so
   * that the pre-installed ML models (~/.cache/qmd/models/) are reused rather
   * than re-downloaded for every agent.  If the default models directory does
   * not exist, or a models directory/symlink already exists in the target, this
   * is a no-op.
   */
  private async symlinkSharedModels(): Promise<void> {
    // process.env is never modified — only this.env (passed to child_process
    // spawn) overrides XDG_CACHE_HOME.  So reading it here gives us the
    // user's original value, which is where `qmd` downloaded its models.
    //
    // On Windows, well-behaved apps (including Rust `dirs` / Go os.UserCacheDir)
    // store caches under %LOCALAPPDATA% rather than ~/.cache.  Fall back to
    // LOCALAPPDATA when XDG_CACHE_HOME is not set on Windows.
    const defaultCacheHome =
      process.env.XDG_CACHE_HOME ||
      (process.platform === "win32" ? process.env.LOCALAPPDATA : undefined) ||
      path.join(os.homedir(), ".cache");
    const defaultModelsDir = path.join(defaultCacheHome, "qmd", "models");
    const targetModelsDir = path.join(this.xdgCacheHome, "qmd", "models");
    try {
      // Check if the default models directory exists.
      // Missing path is normal on first run and should be silent.
      const stat = await fs.stat(defaultModelsDir).catch((err: unknown) => {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          return null;
        }
        throw err;
      });
      if (!stat?.isDirectory()) {
        return;
      }
      // Check if something already exists at the target path
      try {
        await fs.lstat(targetModelsDir);
        // Already exists (directory, symlink, or file) – leave it alone
        return;
      } catch {
        // Does not exist – proceed to create symlink
      }
      // On Windows, creating directory symlinks requires either Administrator
      // privileges or Developer Mode.  Fall back to a directory junction which
      // works without elevated privileges (junctions are always absolute-path,
      // which is fine here since both paths are already absolute).
      try {
        await fs.symlink(defaultModelsDir, targetModelsDir, "dir");
      } catch (symlinkErr: unknown) {
        const code = (symlinkErr as NodeJS.ErrnoException).code;
        if (process.platform === "win32" && (code === "EPERM" || code === "ENOTSUP")) {
          await fs.symlink(defaultModelsDir, targetModelsDir, "junction");
        } else {
          throw symlinkErr;
        }
      }
      log.debug(`symlinked qmd models: ${defaultModelsDir} → ${targetModelsDir}`);
    } catch (err) {
      // Non-fatal: if we can't symlink, qmd will fall back to downloading
      log.warn(`failed to symlink qmd models directory: ${String(err)}`);
    }
  }

  private async runQmd(
    args: string[],
    opts?: { timeoutMs?: number; discardOutput?: boolean },
  ): Promise<{ stdout: string; stderr: string }> {
    return await runCliCommand({
      commandSummary: `qmd ${args.join(" ")}`,
      spawnInvocation: resolveCliSpawnInvocation({
        command: this.qmd.command,
        args,
        env: this.env,
        packageName: "qmd",
      }),
      env: this.env,
      cwd: this.workspaceDir,
      timeoutMs: opts?.timeoutMs,
      maxOutputChars: this.maxQmdOutputChars,
      // Large `qmd update` runs can easily exceed the output cap; keep only stderr.
      discardStdout: opts?.discardOutput,
    });
  }

  /**
   * QMD 1.1+ unified all search modes under a single "query" MCP tool
   * that accepts a `searches` array with typed sub-queries (lex, vec, hyde).
   * QMD <1.1 exposed separate tools: search, vector_search, deep_search.
   *
   * This method probes the MCP server once to detect which interface is
   * available and caches the result for subsequent calls.
   */
  private qmdMcpToolVersion: "v2" | "v1" | null = null;

  private resolveQmdMcpTool(searchCommand: string): BuiltinQmdMcpTool {
    if (this.qmdMcpToolVersion === "v2") {
      return "query";
    }
    if (this.qmdMcpToolVersion === "v1") {
      return searchCommand === "search"
        ? "search"
        : searchCommand === "vsearch"
          ? "vector_search"
          : "deep_search";
    }
    // Not yet probed — default to v2 (current QMD).
    // If the call fails with "not found", markQmdV1Fallback() will retry with v1 names.
    return "query";
  }

  private markQmdV1Fallback(): void {
    if (this.qmdMcpToolVersion !== "v1") {
      this.qmdMcpToolVersion = "v1";
      log.warn(
        "QMD MCP server does not expose the v2 'query' tool; falling back to v1 tool names (search/vector_search/deep_search).",
      );
    }
  }

  private markQmdV2(): void {
    this.qmdMcpToolVersion = "v2";
  }

  /**
   * Build the `searches` array for QMD 1.1+ `query` tool, respecting
   * the configured searchMode so lexical-only or vector-only modes
   * don't trigger unnecessary LLM/embedding work.
   */
  private buildV2Searches(
    query: string,
    searchCommand?: string,
  ): Array<{ type: string; query: string }> {
    switch (searchCommand) {
      case "search":
        // BM25 keyword search only
        return [{ type: "lex", query }];
      case "vsearch":
        // Vector search only
        return [{ type: "vec", query }];
      case "query":
      case undefined:
      default:
        // Full hybrid: lex + vec + hyde (query expansion)
        return [
          { type: "lex", query },
          { type: "vec", query },
          { type: "hyde", query },
        ];
    }
  }

  private isQueryToolNotFoundError(err: unknown): boolean {
    const message = formatErrorMessage(err);
    const detail = message.match(/ failed \(code \d+\): ([\s\S]*)$/)?.[1];
    if (!detail) {
      return false;
    }
    // Match only the specific v2-query missing-tool signatures emitted by MCP.
    // The full mcporter command summary includes the serialized user query, so
    // parse only the trailing stderr/stdout detail before deciding to pin v1.
    return /(?:^|\n|:\s)(?:MCP error [^:\n]+:\s*)?Tool ['"]?query['"]? not found\b/i.test(detail);
  }

  private async ensureMcporterDaemonStarted(mcporter: ResolvedQmdMcporterConfig): Promise<void> {
    if (!mcporter.enabled) {
      return;
    }
    const state = getMcporterState();
    if (!mcporter.startDaemon) {
      if (!state.coldStartWarned) {
        state.coldStartWarned = true;
        log.warn(
          "mcporter qmd bridge enabled but startDaemon=false; each query may cold-start QMD MCP. Consider setting memory.qmd.mcporter.startDaemon=true to keep it warm.",
        );
      }
      return;
    }
    if (!state.daemonStart) {
      state.daemonStart = (async () => {
        try {
          await this.runMcporter(["daemon", "start"], { timeoutMs: 10_000 });
        } catch (err) {
          log.warn(`mcporter daemon start failed: ${String(err)}`);
          // Allow future searches to retry daemon start on transient failures.
          state.daemonStart = null;
        }
      })();
    }
    await state.daemonStart;
  }

  private async runMcporter(
    args: string[],
    opts?: { timeoutMs?: number },
  ): Promise<{ stdout: string; stderr: string }> {
    const spawnInvocation = resolveCliSpawnInvocation({
      command: "mcporter",
      args,
      env: this.env,
      packageName: "mcporter",
    });
    return await runCliCommand({
      commandSummary: `${spawnInvocation.command} ${spawnInvocation.argv.join(" ")}`,
      spawnInvocation,
      // Keep mcporter and direct qmd commands on the same agent-scoped XDG state.
      env: this.env,
      cwd: this.workspaceDir,
      timeoutMs: opts?.timeoutMs,
      maxOutputChars: this.maxQmdOutputChars,
    });
  }

  private async runQmdSearchViaMcporter(
    params: QmdMcporterSearchParams,
  ): Promise<QmdQueryResult[]> {
    await this.ensureMcporterDaemonStarted(params.mcporter);

    // If the version is already known as v1 but we received a stale "query" tool name
    // (e.g. from runMcporterAcrossCollections iterating after the first collection
    // triggered the fallback), resolve the correct v1 tool name immediately.
    const effectiveTool =
      params.tool === "query" && this.qmdMcpToolVersion === "v1"
        ? this.resolveQmdMcpTool(params.searchCommand ?? "query")
        : params.tool;

    const selector = `${params.mcporter.serverName}.${effectiveTool}`;
    const useUnifiedQueryTool = effectiveTool === "query";
    const callArgs: Record<string, unknown> = useUnifiedQueryTool
      ? {
          // QMD 1.1+ "query" tool accepts typed sub-queries via `searches` array.
          // Derive sub-query types from searchCommand to respect searchMode config.
          // Note: minScore is intentionally omitted — QMD 1.1+'s query tool uses
          // its own reranking pipeline and does not accept a minScore parameter.
          searches: this.buildV2Searches(params.query, params.searchCommand),
          limit: params.limit,
        }
      : {
          // QMD 1.x tools accept a flat query string.
          query: params.query,
          limit: params.limit,
          minScore: params.minScore,
        };
    if (params.collection) {
      if (useUnifiedQueryTool) {
        callArgs.collections = [params.collection];
      } else {
        callArgs.collection = params.collection;
      }
    }

    let result: { stdout: string };
    try {
      result = await this.runMcporter(
        [
          "call",
          selector,
          "--args",
          JSON.stringify(callArgs),
          "--output",
          "json",
          "--timeout",
          String(Math.max(0, params.timeoutMs)),
        ],
        { timeoutMs: Math.max(params.timeoutMs + 2_000, 5_000) },
      );
      // If we got here with the v2 "query" tool, confirm v2 for future calls.
      if (useUnifiedQueryTool && this.qmdMcpToolVersion === null) {
        this.markQmdV2();
      }
    } catch (err) {
      // If the v2 "query" tool is not found, fall back to v1 tool names.
      // No need to guard on qmdMcpToolVersion !== "v1" here — if the version
      // were already "v1", effectiveTool would have been resolved to a v1 tool
      // name at the top of this function (not "query"). The effectiveTool ===
      // "query" check alone prevents infinite retry loops since the recursive
      // call passes a v1 tool name. Removing the version guard also fixes a
      // race condition where concurrent searches both probe with "query" while
      // the version is null — the second call would otherwise fail after the
      // first sets the version to "v1".
      if (useUnifiedQueryTool && this.isQueryToolNotFoundError(err)) {
        this.markQmdV1Fallback();
        const v1Tool = this.resolveQmdMcpTool(params.searchCommand ?? "query");
        return this.runQmdSearchViaMcporter({
          mcporter: params.mcporter,
          tool: v1Tool,
          searchCommand: params.searchCommand,
          explicitToolOverride: false,
          query: params.query,
          limit: params.limit,
          minScore: params.minScore,
          collection: params.collection,
          timeoutMs: params.timeoutMs,
        });
      }
      throw err;
    }

    const parsedUnknown: unknown = JSON.parse(result.stdout);
    const parsedRecord = asRecord(parsedUnknown);
    const structuredContent = parsedRecord ? asRecord(parsedRecord.structuredContent) : null;
    const structured: unknown = structuredContent ?? parsedUnknown;

    const structuredRecord = asRecord(structured);
    const results: unknown[] =
      structuredRecord && Array.isArray(structuredRecord.results)
        ? (structuredRecord.results as unknown[])
        : Array.isArray(structured)
          ? structured
          : [];

    const out: QmdQueryResult[] = [];
    for (const item of results) {
      const itemRecord = asRecord(item);
      if (!itemRecord) {
        continue;
      }
      const docidRaw = itemRecord.docid;
      const docid = typeof docidRaw === "string" ? docidRaw.replace(/^#/, "").trim() : "";
      if (!docid) {
        continue;
      }
      const scoreRaw = itemRecord.score;
      const score = typeof scoreRaw === "number" ? scoreRaw : Number(scoreRaw);
      const snippet = typeof itemRecord.snippet === "string" ? itemRecord.snippet : "";
      out.push({
        docid,
        score: Number.isFinite(score) ? score : 0,
        snippet,
        collection: typeof itemRecord.collection === "string" ? itemRecord.collection : undefined,
        file: typeof itemRecord.file === "string" ? itemRecord.file : undefined,
        body: typeof itemRecord.body === "string" ? itemRecord.body : undefined,
        startLine: this.normalizeSnippetLine(itemRecord.start_line ?? itemRecord.startLine),
        endLine: this.normalizeSnippetLine(itemRecord.end_line ?? itemRecord.endLine),
      });
    }
    return out;
  }

  private async readPartialText(
    absPath: string,
    from?: number,
    lines?: number,
  ): Promise<{ missing: true } | { missing: false; text: string }> {
    const start = Math.max(1, from ?? 1);
    const count = Math.max(1, lines ?? Number.POSITIVE_INFINITY);
    let handle;
    try {
      handle = await fs.open(absPath);
    } catch (err) {
      if (isFileMissingError(err)) {
        return { missing: true };
      }
      throw err;
    }
    const stream = handle.createReadStream({ encoding: "utf-8" });
    const rl = readline.createInterface({
      input: stream,
      crlfDelay: Infinity,
    });
    const selected: string[] = [];
    let index = 0;
    try {
      for await (const line of rl) {
        index += 1;
        if (index < start) {
          continue;
        }
        if (selected.length >= count) {
          break;
        }
        selected.push(line);
      }
    } finally {
      rl.close();
      await handle.close();
    }
    return { missing: false, text: selected.slice(0, count).join("\n") };
  }

  private async readFullText(
    absPath: string,
  ): Promise<{ missing: true } | { missing: false; text: string }> {
    try {
      const text = await fs.readFile(absPath, "utf-8");
      return { missing: false, text };
    } catch (err) {
      if (isFileMissingError(err)) {
        return { missing: true };
      }
      throw err;
    }
  }

  private ensureDb(): SqliteDatabase {
    if (this.db) {
      return this.db;
    }
    const { DatabaseSync } = requireNodeSqlite();
    this.db = new DatabaseSync(this.indexPath, { readOnly: true });
    // busy_timeout is per-connection; set it on every open so concurrent
    // processes retry instead of failing immediately with SQLITE_BUSY.
    // Use a lower value than the write path (5 s) because this read-only
    // connection runs synchronous queries on the main thread via DatabaseSync.
    // In WAL mode readers rarely block, so 1 s is a safe upper bound.
    this.db.exec("PRAGMA busy_timeout = 1000");
    return this.db;
  }

  private async exportSessions(): Promise<void> {
    if (!this.sessionExporter) {
      return;
    }
    const exportDir = this.sessionExporter.dir;
    await fs.mkdir(exportDir, { recursive: true });
    const files = await listSessionFilesForAgent(this.agentId);
    const keep = new Set<string>();
    const tracked = new Set<string>();
    const cutoff = this.sessionExporter.retentionMs
      ? Date.now() - this.sessionExporter.retentionMs
      : null;
    for (const sessionFile of files) {
      const entry = await buildSessionEntry(sessionFile);
      if (!entry) {
        continue;
      }
      if (cutoff && entry.mtimeMs < cutoff) {
        continue;
      }
      const targetName = `${path.basename(sessionFile, ".jsonl")}.md`;
      const target = path.join(exportDir, targetName);
      tracked.add(sessionFile);
      const state = this.exportedSessionState.get(sessionFile);
      if (!state || state.hash !== entry.hash || state.mtimeMs !== entry.mtimeMs) {
        await writeFileWithinRoot({
          rootDir: exportDir,
          relativePath: targetName,
          data: this.renderSessionMarkdown(entry),
          encoding: "utf-8",
        });
      }
      this.exportedSessionState.set(sessionFile, {
        hash: entry.hash,
        mtimeMs: entry.mtimeMs,
        target,
      });
      keep.add(target);
    }
    const exported = await fs.readdir(exportDir).catch(() => []);
    for (const name of exported) {
      if (!name.endsWith(".md")) {
        continue;
      }
      const full = path.join(exportDir, name);
      if (!keep.has(full)) {
        await fs.rm(full, { force: true });
      }
    }
    for (const [sessionFile, state] of this.exportedSessionState) {
      if (!tracked.has(sessionFile) || !state.target.startsWith(exportDir + path.sep)) {
        this.exportedSessionState.delete(sessionFile);
      }
    }
  }

  private renderSessionMarkdown(entry: SessionFileEntry): string {
    const header = `# Session ${path.basename(entry.absPath, path.extname(entry.absPath))}`;
    const body = entry.content?.trim().length ? entry.content.trim() : "(empty)";
    return `${header}\n\n${body}\n`;
  }

  private pickSessionCollectionName(): string {
    const existing = new Set(this.qmd.collections.map((collection) => collection.name));
    const base = `sessions-${this.sanitizeCollectionNameSegment(this.agentId)}`;
    if (!existing.has(base)) {
      return base;
    }
    let counter = 2;
    let candidate = `${base}-${counter}`;
    while (existing.has(candidate)) {
      counter += 1;
      candidate = `${base}-${counter}`;
    }
    return candidate;
  }

  private sanitizeCollectionNameSegment(input: string): string {
    const lower = normalizeLowercaseStringOrEmpty(input).replace(/[^a-z0-9-]+/g, "-");
    const trimmed = lower.replace(/^-+|-+$/g, "");
    return trimmed || "agent";
  }

  private async resolveDocLocation(
    docid?: string,
    hints?: { preferredCollection?: string; preferredFile?: string },
  ): Promise<{ rel: string; abs: string; source: MemorySource } | null> {
    const normalizedHints = this.normalizeDocHints(hints);
    if (!docid) {
      return this.resolveDocLocationFromHints(normalizedHints);
    }
    const normalized = docid.startsWith("#") ? docid.slice(1) : docid;
    if (!normalized) {
      return null;
    }
    const cacheKey = `${normalizedHints.preferredCollection ?? "*"}:${normalized}`;
    const cached = this.docPathCache.get(cacheKey);
    if (cached) {
      return cached;
    }
    const db = this.ensureDb();
    let rows: Array<{ collection: string; path: string }> = [];
    try {
      rows = db
        .prepare("SELECT collection, path FROM documents WHERE hash = ? AND active = 1")
        .all(normalized) as Array<{ collection: string; path: string }>;
      if (rows.length === 0) {
        rows = db
          .prepare("SELECT collection, path FROM documents WHERE hash LIKE ? AND active = 1")
          .all(`${normalized}%`) as Array<{ collection: string; path: string }>;
      }
    } catch (err) {
      if (this.isSqliteBusyError(err)) {
        log.debug(`qmd index is busy while resolving doc path: ${String(err)}`);
        throw this.createQmdBusyError(err);
      }
      throw err;
    }
    if (rows.length === 0) {
      return null;
    }
    const location = this.pickDocLocation(rows, normalizedHints);
    if (!location) {
      return null;
    }
    this.docPathCache.set(cacheKey, location);
    return location;
  }

  private resolveDocLocationFromHints(hints: {
    preferredCollection?: string;
    preferredFile?: string;
  }): { rel: string; abs: string; source: MemorySource } | null {
    if (!hints.preferredCollection || !hints.preferredFile) {
      return null;
    }
    const indexedLocation = this.resolveIndexedDocLocationFromHint(
      hints.preferredCollection,
      hints.preferredFile,
    );
    if (indexedLocation) {
      return indexedLocation;
    }
    const collectionRelativePath = this.toCollectionRelativePath(
      hints.preferredCollection,
      hints.preferredFile,
    );
    if (!collectionRelativePath) {
      return null;
    }
    return this.toDocLocation(hints.preferredCollection, collectionRelativePath);
  }

  private resolveIndexedDocLocationFromHint(
    collection: string,
    preferredFile: string,
  ): { rel: string; abs: string; source: MemorySource } | null {
    const trimmedCollection = collection.trim();
    const trimmedFile = preferredFile.trim();
    if (!trimmedCollection || !trimmedFile) {
      return null;
    }
    const exactPath = path.normalize(trimmedFile).replace(/\\/g, "/");
    let rows: Array<{ path: string }> = [];
    try {
      const db = this.ensureDb();
      const exactRows = db
        .prepare("SELECT path FROM documents WHERE collection = ? AND path = ? AND active = 1")
        .all(trimmedCollection, exactPath) as Array<{ path: string }>;
      if (exactRows.length > 0) {
        return this.toDocLocation(trimmedCollection, exactRows[0].path);
      }
      rows = db
        .prepare("SELECT path FROM documents WHERE collection = ? AND active = 1")
        .all(trimmedCollection) as Array<{ path: string }>;
    } catch (err) {
      if (this.isSqliteBusyError(err)) {
        log.debug(`qmd index is busy while resolving hinted path: ${String(err)}`);
        throw this.createQmdBusyError(err);
      }
      // Hint-based lookup is best effort. Fall back to the raw hinted path when
      // the index is unavailable or still warming.
      log.debug(`qmd index hint lookup skipped: ${String(err)}`);
      return null;
    }
    const matches = rows.filter((row) => this.matchesPreferredFileHint(row.path, trimmedFile));
    if (matches.length !== 1) {
      return null;
    }
    return this.toDocLocation(trimmedCollection, matches[0].path);
  }

  private normalizeDocHints(hints?: { preferredCollection?: string; preferredFile?: string }): {
    preferredCollection?: string;
    preferredFile?: string;
  } {
    const preferredCollection = hints?.preferredCollection?.trim();
    const preferredFile = hints?.preferredFile?.trim();
    if (!preferredFile) {
      return preferredCollection ? { preferredCollection } : {};
    }

    const parsedQmdFile = this.parseQmdFileUri(preferredFile);
    return {
      preferredCollection: parsedQmdFile?.collection ?? preferredCollection,
      preferredFile: parsedQmdFile?.collectionRelativePath ?? preferredFile,
    };
  }

  private parseQmdFileUri(fileRef: string): {
    collection?: string;
    collectionRelativePath?: string;
  } | null {
    if (!normalizeLowercaseStringOrEmpty(fileRef).startsWith("qmd://")) {
      return null;
    }
    try {
      const parsed = new URL(fileRef);
      const collection = decodeURIComponent(parsed.hostname).trim();
      const pathname = decodeURIComponent(parsed.pathname).replace(/^\/+/, "").trim();
      if (!collection && !pathname) {
        return null;
      }
      return {
        collection: collection || undefined,
        collectionRelativePath: pathname || undefined,
      };
    } catch {
      return null;
    }
  }

  private toCollectionRelativePath(collection: string, filePath: string): string | null {
    const root = this.collectionRoots.get(collection);
    if (!root) {
      return null;
    }
    const trimmedFilePath = filePath.trim();
    if (!trimmedFilePath) {
      return null;
    }
    const normalizedInput = path.normalize(trimmedFilePath);
    const absolutePath = path.isAbsolute(normalizedInput)
      ? normalizedInput
      : path.resolve(root.path, normalizedInput);
    if (!this.isWithinRoot(root.path, absolutePath)) {
      return null;
    }
    const relative = path.relative(root.path, absolutePath);
    if (!relative || relative === ".") {
      return null;
    }
    return relative.replace(/\\/g, "/");
  }

  private pickDocLocation(
    rows: Array<{ collection: string; path: string }>,
    hints?: { preferredCollection?: string; preferredFile?: string },
  ): { rel: string; abs: string; source: MemorySource } | null {
    if (hints?.preferredCollection) {
      for (const row of rows) {
        if (row.collection !== hints.preferredCollection) {
          continue;
        }
        const location = this.toDocLocation(row.collection, row.path);
        if (location) {
          return location;
        }
      }
    }
    if (hints?.preferredFile) {
      for (const row of rows) {
        if (!this.matchesPreferredFileHint(row.path, hints.preferredFile)) {
          continue;
        }
        const location = this.toDocLocation(row.collection, row.path);
        if (location) {
          return location;
        }
      }
    }
    for (const row of rows) {
      const location = this.toDocLocation(row.collection, row.path);
      if (location) {
        return location;
      }
    }
    return null;
  }

  private matchesPreferredFileHint(rowPath: string, preferredFile: string): boolean {
    const preferred = path.normalize(preferredFile).replace(/\\/g, "/");
    const normalizedRowPath = path.normalize(rowPath).replace(/\\/g, "/");
    if (normalizedRowPath === preferred || normalizedRowPath.endsWith(`/${preferred}`)) {
      return true;
    }
    const normalizedPreferredLookup = this.normalizeQmdLookupPath(preferredFile);
    if (!normalizedPreferredLookup) {
      return false;
    }
    const normalizedRowLookup = this.normalizeQmdLookupPath(rowPath);
    return (
      normalizedRowLookup === normalizedPreferredLookup ||
      normalizedRowLookup.endsWith(`/${normalizedPreferredLookup}`)
    );
  }

  private normalizeQmdLookupPath(filePath: string): string {
    return filePath
      .replace(/\\/g, "/")
      .split("/")
      .filter((segment) => segment.length > 0 && segment !== ".")
      .map((segment) => this.normalizeQmdLookupSegment(segment))
      .filter(Boolean)
      .join("/");
  }

  private normalizeQmdLookupSegment(segment: string): string {
    const trimmed = segment.trim();
    if (!trimmed) {
      return "";
    }
    if (trimmed === "." || trimmed === "..") {
      return trimmed;
    }
    const parsed = path.posix.parse(trimmed);
    const normalizePart = (value: string): string =>
      localeLowercasePreservingWhitespace(value.normalize("NFKD"))
        .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
        .replace(/-{2,}/g, "-")
        .replace(/^-+|-+$/g, "");
    const normalizedName = normalizePart(parsed.name);
    const normalizedExt = localeLowercasePreservingWhitespace(parsed.ext.normalize("NFKD")).replace(
      /[^\p{Letter}\p{Number}.]+/gu,
      "",
    );
    const fallbackName = normalizeLowercaseStringOrEmpty(parsed.name.normalize("NFKD")).replace(
      /\s+/g,
      "-",
    );
    return `${normalizedName || fallbackName || "file"}${normalizedExt}`;
  }

  private extractSnippetLines(snippet: string): { startLine: number; endLine: number } {
    const headerLines = this.parseSnippetHeaderLines(snippet);
    if (headerLines) {
      return headerLines;
    }
    const lines = snippet.split("\n").length;
    return { startLine: 1, endLine: lines };
  }

  private resolveSnippetLines(
    entry: QmdQueryResult,
    snippet: string,
  ): { startLine: number; endLine: number } {
    const explicitStart = this.normalizeSnippetLine(entry.startLine);
    const explicitEnd = this.normalizeSnippetLine(entry.endLine);
    const headerLines = this.parseSnippetHeaderLines(snippet);
    if (explicitStart !== undefined && explicitEnd !== undefined) {
      return explicitStart <= explicitEnd
        ? { startLine: explicitStart, endLine: explicitEnd }
        : { startLine: explicitEnd, endLine: explicitStart };
    }
    if (explicitStart !== undefined) {
      if (headerLines) {
        const width = headerLines.endLine - headerLines.startLine;
        return {
          startLine: explicitStart,
          endLine: explicitStart + Math.max(0, width),
        };
      }
      return { startLine: explicitStart, endLine: explicitStart };
    }
    if (explicitEnd !== undefined) {
      if (headerLines) {
        const width = headerLines.endLine - headerLines.startLine;
        return {
          startLine: Math.max(1, explicitEnd - Math.max(0, width)),
          endLine: explicitEnd,
        };
      }
      return { startLine: explicitEnd, endLine: explicitEnd };
    }
    if (headerLines) {
      return headerLines;
    }
    return { startLine: 1, endLine: snippet.split("\n").length };
  }

  private normalizeSnippetLine(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
  }

  private parseSnippetHeaderLines(snippet: string): { startLine: number; endLine: number } | null {
    const match = SNIPPET_HEADER_RE.exec(snippet);
    if (!match) {
      return null;
    }
    const start = Number(match[1]);
    const count = Number(match[2]);
    if (Number.isFinite(start) && Number.isFinite(count)) {
      return { startLine: start, endLine: start + count - 1 };
    }
    return null;
  }

  private readCounts(): {
    totalDocuments: number;
    sourceCounts: Array<{ source: MemorySource; files: number; chunks: number }>;
  } {
    try {
      const db = this.ensureDb();
      const rows = db
        .prepare(
          "SELECT collection, COUNT(*) as c FROM documents WHERE active = 1 GROUP BY collection",
        )
        .all() as Array<{ collection: string; c: number }>;
      const bySource = new Map<MemorySource, { files: number; chunks: number }>();
      for (const source of this.sources) {
        bySource.set(source, { files: 0, chunks: 0 });
      }
      let total = 0;
      for (const row of rows) {
        const root = this.collectionRoots.get(row.collection);
        const source = root?.kind ?? "memory";
        const entry = bySource.get(source) ?? { files: 0, chunks: 0 };
        entry.files += row.c ?? 0;
        entry.chunks += row.c ?? 0;
        bySource.set(source, entry);
        total += row.c ?? 0;
      }
      return {
        totalDocuments: total,
        sourceCounts: Array.from(bySource.entries()).map(([source, value]) => ({
          source,
          files: value.files,
          chunks: value.chunks,
        })),
      };
    } catch (err) {
      log.warn(`failed to read qmd index stats: ${String(err)}`);
      return {
        totalDocuments: 0,
        sourceCounts: Array.from(this.sources).map((source) => ({ source, files: 0, chunks: 0 })),
      };
    }
  }

  private logScopeDenied(sessionKey?: string): void {
    const channel = deriveQmdScopeChannel(sessionKey) ?? "unknown";
    const chatType = deriveQmdScopeChatType(sessionKey) ?? "unknown";
    const key = sessionKey?.trim() || "<none>";
    log.warn(
      `qmd search denied by scope (channel=${channel}, chatType=${chatType}, session=${key})`,
    );
  }

  private isScopeAllowed(sessionKey?: string): boolean {
    return isQmdScopeAllowed(this.qmd.scope, sessionKey);
  }

  private toDocLocation(
    collection: string,
    collectionRelativePath: string,
  ): { rel: string; abs: string; source: MemorySource } | null {
    const root = this.collectionRoots.get(collection);
    if (!root) {
      return null;
    }
    const normalizedRelative = collectionRelativePath.replace(/\\/g, "/");
    const absPath = path.normalize(path.resolve(root.path, collectionRelativePath));
    const relativeToWorkspace = path.relative(this.workspaceDir, absPath);
    const relPath = this.buildSearchPath(
      collection,
      normalizedRelative,
      relativeToWorkspace,
      absPath,
    );
    return { rel: relPath, abs: absPath, source: root.kind };
  }

  private buildSearchPath(
    collection: string,
    collectionRelativePath: string,
    relativeToWorkspace: string,
    absPath: string,
  ): string {
    const sanitized = collectionRelativePath.replace(/^\/+/, "");
    const insideWorkspace = this.isInsideWorkspace(relativeToWorkspace);
    if (insideWorkspace) {
      const normalized = relativeToWorkspace.replace(/\\/g, "/");
      if (!normalized) {
        return path.basename(absPath);
      }
      // `qmd/<collection>/...` is a reserved virtual path namespace consumed by
      // readFile(). If a real workspace file happens to live under `qmd/...`,
      // return the explicit collection-scoped virtual path so search->read
      // remains roundtrip-safe.
      if (normalized === "qmd" || normalized.startsWith("qmd/")) {
        return `qmd/${collection}/${sanitized}`;
      }
      return normalized;
    }
    return `qmd/${collection}/${sanitized}`;
  }

  private isInsideWorkspace(relativePath: string): boolean {
    if (!relativePath) {
      return true;
    }
    if (relativePath.startsWith("..")) {
      return false;
    }
    if (relativePath.startsWith(`..${path.sep}`)) {
      return false;
    }
    return !path.isAbsolute(relativePath);
  }

  private resolveReadPath(relPath: string): string {
    if (relPath.startsWith("qmd/")) {
      const [, collection, ...rest] = relPath.split("/");
      if (!collection || rest.length === 0) {
        throw new Error("invalid qmd path");
      }
      const root = this.collectionRoots.get(collection);
      if (!root) {
        throw new Error(`unknown qmd collection: ${collection}`);
      }
      const joined = rest.join("/");
      const resolved = path.resolve(root.path, joined);
      if (!this.isWithinRoot(root.path, resolved)) {
        throw new Error("qmd path escapes collection");
      }
      return resolved;
    }
    const absPath = path.resolve(this.workspaceDir, relPath);
    if (!this.isWithinWorkspace(absPath)) {
      throw new Error("path escapes workspace");
    }
    return absPath;
  }

  private isWithinWorkspace(absPath: string): boolean {
    const normalizedWorkspace = this.workspaceDir.endsWith(path.sep)
      ? this.workspaceDir
      : `${this.workspaceDir}${path.sep}`;
    if (absPath === this.workspaceDir) {
      return true;
    }
    const candidate = absPath.endsWith(path.sep) ? absPath : `${absPath}${path.sep}`;
    return candidate.startsWith(normalizedWorkspace);
  }

  private isWithinRoot(root: string, candidate: string): boolean {
    const normalizedRoot = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
    if (candidate === root) {
      return true;
    }
    const next = candidate.endsWith(path.sep) ? candidate : `${candidate}${path.sep}`;
    return next.startsWith(normalizedRoot);
  }

  private clampResultsByInjectedChars(results: MemorySearchResult[]): MemorySearchResult[] {
    const budget = this.qmd.limits.maxInjectedChars;
    if (!budget || budget <= 0) {
      return results;
    }
    let remaining = budget;
    const clamped: MemorySearchResult[] = [];
    for (const entry of results) {
      if (remaining <= 0) {
        break;
      }
      const snippet = entry.snippet ?? "";
      if (snippet.length <= remaining) {
        clamped.push(entry);
        remaining -= snippet.length;
      } else {
        const trimmed = snippet.slice(0, Math.max(0, remaining));
        clamped.push({ ...entry, snippet: trimmed });
        break;
      }
    }
    return clamped;
  }

  private diversifyResultsBySource(
    results: MemorySearchResult[],
    limit: number,
  ): MemorySearchResult[] {
    const target = Math.max(0, limit);
    if (target <= 0) {
      return [];
    }
    if (results.length <= 1) {
      return results.slice(0, target);
    }
    const bySource = new Map<MemorySource, MemorySearchResult[]>();
    for (const entry of results) {
      const list = bySource.get(entry.source) ?? [];
      list.push(entry);
      bySource.set(entry.source, list);
    }
    const hasSessions = bySource.has("sessions");
    const hasMemory = bySource.has("memory");
    if (!hasSessions || !hasMemory) {
      return results.slice(0, target);
    }
    const sourceOrder = Array.from(bySource.entries())
      .toSorted((a, b) => (b[1][0]?.score ?? 0) - (a[1][0]?.score ?? 0))
      .map(([source]) => source);
    const diversified: MemorySearchResult[] = [];
    while (diversified.length < target) {
      let emitted = false;
      for (const source of sourceOrder) {
        const next = bySource.get(source)?.shift();
        if (!next) {
          continue;
        }
        diversified.push(next);
        emitted = true;
        if (diversified.length >= target) {
          break;
        }
      }
      if (!emitted) {
        break;
      }
    }
    return diversified;
  }

  private shouldSkipUpdate(force?: boolean): boolean {
    if (force) {
      return false;
    }
    const debounceMs = this.qmd.update.debounceMs;
    if (debounceMs <= 0) {
      return false;
    }
    if (!this.lastUpdateAt) {
      return false;
    }
    return Date.now() - this.lastUpdateAt < debounceMs;
  }

  private isSqliteBusyError(err: unknown): boolean {
    const message = formatErrorMessage(err);
    const normalized = normalizeLowercaseStringOrEmpty(message);
    return normalized.includes("sqlite_busy") || normalized.includes("database is locked");
  }

  private isUnsupportedQmdOptionError(err: unknown): boolean {
    const message = formatErrorMessage(err);
    const normalized = normalizeLowercaseStringOrEmpty(message);
    return (
      normalized.includes("unknown flag") ||
      normalized.includes("unknown option") ||
      normalized.includes("unrecognized option") ||
      normalized.includes("flag provided but not defined") ||
      normalized.includes("unexpected argument")
    );
  }

  private createQmdBusyError(err: unknown): Error {
    const message = formatErrorMessage(err);
    return new Error(`qmd index busy while reading results: ${message}`);
  }

  private async waitForPendingUpdateBeforeSearch(): Promise<void> {
    const pending = this.pendingUpdate;
    if (!pending) {
      return;
    }
    await Promise.race([
      pending.catch(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, SEARCH_PENDING_UPDATE_WAIT_MS)),
    ]);
  }

  private async runQueryAcrossCollections(
    query: string,
    limit: number,
    collectionNames: string[],
    command: "query" | "search" | "vsearch",
  ): Promise<QmdQueryResult[]> {
    log.debug(
      `qmd ${command} multi-collection workaround active (${collectionNames.length} collections)`,
    );
    const bestByResultKey = new Map<string, QmdQueryResult>();
    for (const collectionName of collectionNames) {
      const args = this.buildSearchArgs(command, query, limit);
      args.push("-c", collectionName);
      const result = await this.runQmd(args, { timeoutMs: this.qmd.limits.timeoutMs });
      const parsed = parseQmdQueryJson(result.stdout, result.stderr);
      for (const entry of parsed) {
        const normalizedHints = this.normalizeDocHints({
          preferredCollection: entry.collection ?? collectionName,
          preferredFile: entry.file,
        });
        const normalizedDocId =
          typeof entry.docid === "string" && entry.docid.trim().length > 0
            ? entry.docid
            : undefined;
        const withCollection = {
          ...entry,
          docid: normalizedDocId,
          collection: normalizedHints.preferredCollection ?? entry.collection ?? collectionName,
          file: normalizedHints.preferredFile ?? entry.file,
        } satisfies QmdQueryResult;
        const resultKey = this.buildQmdResultKey(withCollection);
        if (!resultKey) {
          continue;
        }
        const prev = bestByResultKey.get(resultKey);
        const prevScore = typeof prev?.score === "number" ? prev.score : Number.NEGATIVE_INFINITY;
        const nextScore =
          typeof withCollection.score === "number"
            ? withCollection.score
            : Number.NEGATIVE_INFINITY;
        if (!prev || nextScore > prevScore) {
          bestByResultKey.set(resultKey, withCollection);
        }
      }
    }
    return [...bestByResultKey.values()].toSorted((a, b) => (b.score ?? 0) - (a.score ?? 0));
  }

  private buildQmdResultKey(entry: QmdQueryResult): string | null {
    if (typeof entry.docid === "string" && entry.docid.trim().length > 0) {
      return `docid:${entry.docid}`;
    }
    const hints = this.normalizeDocHints({
      preferredCollection: entry.collection,
      preferredFile: entry.file,
    });
    if (!hints.preferredCollection || !hints.preferredFile) {
      return null;
    }
    const collectionRelativePath = this.toCollectionRelativePath(
      hints.preferredCollection,
      hints.preferredFile,
    );
    if (!collectionRelativePath) {
      return null;
    }
    return `file:${hints.preferredCollection}:${collectionRelativePath}`;
  }

  private async runMcporterAcrossCollections(
    params: QmdMcporterAcrossCollectionsParams,
  ): Promise<QmdQueryResult[]> {
    const bestByDocId = new Map<string, QmdQueryResult>();
    for (const collectionName of params.collectionNames) {
      const parsed = params.explicitToolOverride
        ? await this.runQmdSearchViaMcporter({
            mcporter: this.qmd.mcporter,
            tool: params.tool,
            searchCommand: params.searchCommand,
            explicitToolOverride: true,
            query: params.query,
            limit: params.limit,
            minScore: params.minScore,
            collection: collectionName,
            timeoutMs: this.qmd.limits.timeoutMs,
          })
        : await this.runQmdSearchViaMcporter({
            mcporter: this.qmd.mcporter,
            tool: params.tool,
            searchCommand: params.searchCommand,
            explicitToolOverride: false,
            query: params.query,
            limit: params.limit,
            minScore: params.minScore,
            collection: collectionName,
            timeoutMs: this.qmd.limits.timeoutMs,
          });
      for (const entry of parsed) {
        if (typeof entry.docid !== "string" || !entry.docid.trim()) {
          continue;
        }
        const prev = bestByDocId.get(entry.docid);
        const prevScore = typeof prev?.score === "number" ? prev.score : Number.NEGATIVE_INFINITY;
        const nextScore = typeof entry.score === "number" ? entry.score : Number.NEGATIVE_INFINITY;
        if (!prev || nextScore > prevScore) {
          bestByDocId.set(entry.docid, entry);
        }
      }
    }
    return [...bestByDocId.values()].toSorted((a, b) => (b.score ?? 0) - (a.score ?? 0));
  }

  private listManagedCollectionNames(): string[] {
    return this.managedCollectionNames;
  }

  private computeManagedCollectionNames(): string[] {
    const seen = new Set<string>();
    const names: string[] = [];
    for (const collection of this.qmd.collections) {
      const name = collection.name?.trim();
      if (!name || seen.has(name)) {
        continue;
      }
      seen.add(name);
      names.push(name);
    }
    return names;
  }

  private buildCollectionFilterArgs(collectionNames: string[]): string[] {
    if (collectionNames.length === 0) {
      return [];
    }
    const names = collectionNames.filter(Boolean);
    return names.flatMap((name) => ["-c", name]);
  }

  private buildSearchArgs(
    command: "query" | "search" | "vsearch",
    query: string,
    limit: number,
  ): string[] {
    const normalizedQuery = command === "search" ? normalizeHanBm25Query(query) : query;
    if (command === "query") {
      return ["query", normalizedQuery, "--json", "-n", String(limit)];
    }
    return [command, normalizedQuery, "--json", "-n", String(limit)];
  }
}
