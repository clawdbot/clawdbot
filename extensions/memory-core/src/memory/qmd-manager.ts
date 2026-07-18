// Memory Core plugin module implements qmd manager behavior.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import chokidar, { type FSWatcher } from "chokidar";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  createSubsystemLogger,
  resolveAgentContextLimits,
  resolveMemorySearchSyncConfig,
  resolveAgentWorkspaceDir,
  resolveGlobalSingleton,
  resolveStateDir,
  truncateUtf16Safe,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import {
  deriveQmdScopeChannel,
  deriveQmdScopeChatType,
  isQmdScopeAllowed,
  type QmdQueryResult,
} from "openclaw/plugin-sdk/memory-core-host-engine-qmd";
import {
  buildMemoryReadResult,
  buildMemoryReadResultFromSlice,
  DEFAULT_MEMORY_READ_LINES,
  isFileMissingError,
  type MemoryReadResult,
  requireNodeSqlite,
  statRegularFile,
  type MemoryEmbeddingProbeResult,
  type MemoryProviderStatus,
  type MemorySearchManager,
  type MemorySearchRuntimeDebug,
  type MemorySearchResult,
  type MemorySource,
  type MemorySyncParams,
  type ResolvedMemoryBackendConfig,
  type ResolvedQmdConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import {
  isFutureDateTimestampMs,
  MAX_TIMER_TIMEOUT_MS,
  resolveExpiresAtMsFromDurationMs,
} from "openclaw/plugin-sdk/number-runtime";
import {
  PluginStateLeaseError,
  type PluginStateLeaseContext,
  type PluginStateLeaseRunner,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  normalizeLowercaseStringOrEmpty,
  uniqueValues,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  attachQmdSessionArtifactHit,
  copyQmdSessionArtifactHit,
  resolveQmdSessionArtifactIdentity,
} from "../qmd-session-artifacts.js";
import {
  QmdCollectionController,
  type ManagedQmdCollection as ManagedCollection,
  type QmdSearchRuntimeDebugContext,
} from "./qmd-collection-controller.js";
import { QmdCommandClient, type QmdCommandPhaseReporter } from "./qmd-command-client.js";
import {
  asQmdAbortError,
  isMissingCollectionSearchError,
  isSqliteBusyError,
  isUnsupportedQmdOptionError,
} from "./qmd-command-errors.js";
import {
  isDefaultQmdMemoryPath as isDefaultMemoryPath,
  QmdDocumentResolver,
  type QmdCollectionRoot as CollectionRoot,
  type QmdDocLocation as DocLocation,
} from "./qmd-document-resolver.js";
import {
  clearQmdMultiCollectionProbeCache,
  readQmdMultiCollectionProbeCache,
  writeQmdMultiCollectionProbeCache,
  type QmdRuntimeCollectionValidationCacheContext,
  type QmdRuntimeManagedCollection,
  type QmdRuntimeMultiCollectionProbeCacheContext,
} from "./qmd-runtime-cache.js";
import { QmdSessionExporter, resolveQmdSessionExporterConfig } from "./qmd-session-exporter.js";
import {
  MEMORY_SEARCH_DEADLINE_CONTROL,
  type MemorySearchDeadlineControlOptions,
} from "./search-deadline.js";
import {
  countChokidarWatchedEntries,
  type MemoryWatchPressureWarningState,
  warnIfMemoryWatchPressureHigh,
} from "./watch-pressure.js";
import {
  recordMemoryWatchEventPath,
  settleMemoryWatchEventPaths,
  type MemoryWatchEventStats,
  type MemoryWatchSettleQueue,
} from "./watch-settle.js";

export { resolveQmdMcporterSearchProcessTimeoutMs } from "./qmd-command-client.js";

type SqliteDatabase = import("node:sqlite").DatabaseSync;

const log = createSubsystemLogger("memory");

const SNIPPET_HEADER_RE = /@@\s*-([0-9]+),([0-9]+)/;
const SEARCH_PENDING_UPDATE_WAIT_MS = 500;
const MAX_QMD_OUTPUT_CHARS = 200_000;
const QMD_EMBED_BACKOFF_BASE_MS = 60_000;
const QMD_EMBED_BACKOFF_MAX_MS = 60 * 60 * 1000;
const QMD_EMBED_LEASE_MIN_WAIT_MS = 15 * 60 * 1000;
const QMD_WRITE_LEASE_MIN_WAIT_MS = 5 * 60 * 1000;
const QMD_EMBED_QUEUE_KEY = Symbol.for("openclaw.qmdEmbedQueueTail");
const QMD_UPDATE_QUEUE_KEY = Symbol.for("openclaw.qmdUpdateQueueState");
const IGNORED_MEMORY_WATCH_DIR_NAMES = new Set([
  ".git",
  ".cache",
  "node_modules",
  "vendor",
  "dist",
  "build",
  ".pnpm-store",
  ".venv",
  "venv",
  ".tox",
  "__pycache__",
]);

function qmdUsesVectors(searchMode: ResolvedQmdConfig["searchMode"]): boolean {
  return searchMode !== "search";
}

function buildQmdProcessPath(rawPath: string | undefined): string {
  const nodeBinDir = path.dirname(process.execPath);
  const entries = rawPath?.split(path.delimiter).filter(Boolean) ?? [];
  if (entries.includes(nodeBinDir)) {
    return rawPath ?? nodeBinDir;
  }
  return [...entries, nodeBinDir].join(path.delimiter);
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(1, Math.floor(value))
    : fallback;
}

type QmdEmbedQueueState = {
  tail: Promise<void>;
};

type QmdUpdateQueueState = {
  tails: Map<string, Promise<void>>;
};

function getQmdEmbedQueueState(): QmdEmbedQueueState {
  return resolveGlobalSingleton<QmdEmbedQueueState>(QMD_EMBED_QUEUE_KEY, () => ({
    tail: Promise.resolve(),
  }));
}

function getQmdUpdateQueueState(): QmdUpdateQueueState {
  return resolveGlobalSingleton<QmdUpdateQueueState>(QMD_UPDATE_QUEUE_KEY, () => ({
    tails: new Map<string, Promise<void>>(),
  }));
}

function normalizeHanBm25Query(query: string): string {
  const trimmed = query.trim();
  // Keep Han/CJK BM25 queries intact so OpenClaw search semantics match direct qmd search.
  return trimmed;
}

function parseQmdStatusVectorCount(raw: string): number | null {
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^\s*Vectors(?:\s*[:=]\s*|\s+)(\d+)\b/i);
    if (match?.[1]) {
      const count = Number.parseInt(match[1], 10);
      if (Number.isFinite(count)) {
        return count;
      }
    }
  }
  return null;
}

function resolveStableJitterMs(params: { seed: string; windowMs: number }): number {
  if (params.windowMs <= 0) {
    return 0;
  }
  const hash = crypto.createHash("sha256").update(params.seed).digest();
  const bucket = hash.readUInt32BE(0);
  return bucket % (Math.floor(params.windowMs) + 1);
}

function resolveQmdWriteLeaseOptions(expectedMs: number, minWaitMs: number) {
  const expected = Math.max(1, expectedMs);
  return {
    leaseMs: Math.min(MAX_TIMER_TIMEOUT_MS, Math.max(minWaitMs, expected * 2)),
    waitMs: Math.min(MAX_TIMER_TIMEOUT_MS, Math.max(minWaitMs, expected * 6)),
  };
}

// Cross-process serialization for qmd embeds (heavy ML work, serialized globally).
function resolveQmdEmbedLeaseOptions(embedTimeoutMs: number) {
  return resolveQmdWriteLeaseOptions(embedTimeoutMs, QMD_EMBED_LEASE_MIN_WAIT_MS);
}

// One per-agent write lease shared by the update and embed phases (both write the
// same qmd index.sqlite), so a foreground `memory search` dirty-sync and a
// background gateway update/embed never write the same store at once
// (writer-vs-writer SQLITE_BUSY, #66339). Sized to the slower of the two writes
// so a contending caller waits for the in-flight write instead of erroring.
function resolveQmdStoreWriteLeaseOptions(updateTimeoutMs: number, embedTimeoutMs: number) {
  return resolveQmdWriteLeaseOptions(
    Math.max(updateTimeoutMs, embedTimeoutMs),
    QMD_WRITE_LEASE_MIN_WAIT_MS,
  );
}

function hasIgnoredMemoryWatchSegment(relativePath: string): boolean {
  const parts = relativePath
    .split(path.sep)
    .map((segment) => normalizeLowercaseStringOrEmpty(segment))
    .filter(Boolean);
  return parts.some((segment) => IGNORED_MEMORY_WATCH_DIR_NAMES.has(segment));
}

function shouldIgnoreMemoryWatchPath(watchPath: string, roots: readonly string[]): boolean {
  const normalized = path.normalize(watchPath);
  let matchedRelative: string | null = null;
  let matchedRootLength = -1;
  for (const watchRoot of roots) {
    const normalizedRoot = path.normalize(watchRoot);
    const relative = path.relative(normalizedRoot, normalized);
    if (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
      if (normalizedRoot.length > matchedRootLength) {
        matchedRelative = relative;
        matchedRootLength = normalizedRoot.length;
      }
    }
  }
  if (matchedRelative !== null) {
    if (matchedRelative === "") {
      return false;
    }
    return hasIgnoredMemoryWatchSegment(matchedRelative);
  }
  return hasIgnoredMemoryWatchSegment(normalized);
}

type QmdManagerMode = "full" | "status" | "cli";
type QmdManagerRuntimeConfig = {
  workspaceDir: string;
  syncSettings: ReturnType<typeof resolveMemorySearchSyncConfig>;
  contextLimits: ReturnType<typeof resolveAgentContextLimits>;
};
export class QmdMemoryManager implements MemorySearchManager {
  static async create(params: {
    cfg: OpenClawConfig;
    agentId: string;
    resolved: ResolvedMemoryBackendConfig;
    withLease: PluginStateLeaseRunner;
    mode?: QmdManagerMode;
    runtimeConfig?: QmdManagerRuntimeConfig;
  }): Promise<QmdMemoryManager | null> {
    const resolved = params.resolved.qmd;
    if (!resolved) {
      return null;
    }
    const runtimeConfig =
      params.runtimeConfig ?? resolveQmdManagerRuntimeConfig(params.cfg, params.agentId);
    const manager = new QmdMemoryManager({
      agentId: params.agentId,
      resolved,
      runtimeConfig,
      withLease: params.withLease,
    });
    await manager.initialize(params.mode ?? "full");
    return manager;
  }

  private readonly agentId: string;
  private readonly qmd: ResolvedQmdConfig;
  private readonly workspaceDir: string;
  private readonly contextLimits: ReturnType<typeof resolveAgentContextLimits>;
  private readonly stateDir: string;
  private readonly agentStateDir: string;
  private readonly qmdDir: string;
  private readonly xdgConfigHome: string;
  private readonly xdgCacheHome: string;
  private readonly indexPath: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly commands: QmdCommandClient;
  private readonly withLease: PluginStateLeaseRunner;
  private readonly collectionController: QmdCollectionController;
  private readonly documentResolver: QmdDocumentResolver;
  private readonly syncSettings: ReturnType<typeof resolveMemorySearchSyncConfig>;
  private readonly managedCollectionNames: string[];
  private readonly collectionRoots = new Map<string, CollectionRoot>();
  private readonly sources = new Set<MemorySource>();
  private readonly maxQmdOutputChars = MAX_QMD_OUTPUT_CHARS;
  private readonly sessionExporter: QmdSessionExporter | null;
  private updateTimer: NodeJS.Timeout | null = null;
  private embedTimer: NodeJS.Timeout | null = null;
  private watcher: FSWatcher | null = null;
  private watchTimer: NodeJS.Timeout | null = null;
  private readonly pendingWatchPaths: MemoryWatchSettleQueue = new Map();
  private readonly watchPressureWarning: MemoryWatchPressureWarningState = { shown: false };
  private pendingUpdate: Promise<void> | null = null;
  private queuedForcedUpdate: Promise<void> | null = null;
  private queuedForcedRuns = 0;
  private dirty = false;
  private closed = false;
  private mode: QmdManagerMode = "full";
  private readonly closeSignal: Promise<void>;
  private resolveCloseSignal!: () => void;
  private readonly closeAbortController = new AbortController();
  private qmdRuntimeIdentityPromise: Promise<string> | null = null;
  private db: SqliteDatabase | null = null;
  private lastUpdateAt: number | null = null;
  private lastEmbedAt: number | null = null;
  private embedLeaseRetryPending = false;
  private embedBackoffUntil: number | null = null;
  private embedFailureCount = 0;
  private vectorAvailable: boolean | null = null;
  private vectorStatusDetail: string | null = null;
  private readonly sessionWarm = new Set<string>();
  private multiCollectionFilterSupported: boolean | null = null;

  private constructor(params: {
    agentId: string;
    resolved: ResolvedQmdConfig;
    runtimeConfig: QmdManagerRuntimeConfig;
    withLease: PluginStateLeaseRunner;
  }) {
    this.agentId = params.agentId;
    this.qmd = params.resolved;
    this.workspaceDir = params.runtimeConfig.workspaceDir;
    this.contextLimits = params.runtimeConfig.contextLimits;
    this.withLease = params.withLease;
    this.stateDir = resolveStateDir(process.env, os.homedir);
    this.agentStateDir = path.join(this.stateDir, "agents", this.agentId);
    this.qmdDir = path.join(this.agentStateDir, "qmd");
    this.syncSettings = params.runtimeConfig.syncSettings;
    // QMD uses XDG base dirs for its internal state.
    // Collections are managed via `qmd collection add` and stored inside the index DB.
    // - config:  $XDG_CONFIG_HOME (contexts, etc.)
    // - cache:   $XDG_CACHE_HOME/qmd/index.sqlite
    this.xdgConfigHome = path.join(this.qmdDir, "xdg-config");
    this.xdgCacheHome = path.join(this.qmdDir, "xdg-cache");
    this.indexPath = path.join(this.xdgCacheHome, "qmd", "index.sqlite");

    this.env = {
      ...process.env,
      PATH: buildQmdProcessPath(process.env.PATH),
      XDG_CONFIG_HOME: this.xdgConfigHome,
      // QMD resolves index.yml relative to QMD_CONFIG_DIR rather than XDG_CONFIG_HOME.
      // Point it at the nested qmd config directory so per-agent collections are visible.
      QMD_CONFIG_DIR: path.join(this.xdgConfigHome, "qmd"),
      XDG_CACHE_HOME: this.xdgCacheHome,
      NO_COLOR: "1",
    };
    this.commands = new QmdCommandClient(
      this.qmd,
      this.env,
      this.workspaceDir,
      this.maxQmdOutputChars,
    );
    this.collectionController = new QmdCollectionController(
      this.qmd,
      this.agentId,
      this.workspaceDir,
      this.xdgConfigHome,
      async (args, opts) => await this.commands.run(args, opts),
      async (signal) => await this.buildQmdCollectionValidationCacheContext(signal),
    );
    this.documentResolver = new QmdDocumentResolver(
      this.workspaceDir,
      this.collectionRoots,
      () => this.ensureDb(),
      this.qmd.sessions.readable,
    );
    this.closeSignal = new Promise<void>((resolve) => {
      this.resolveCloseSignal = resolve;
    });
    const sessionExporterConfig = resolveQmdSessionExporterConfig({
      qmd: this.qmd,
      agentId: this.agentId,
      qmdDir: this.qmdDir,
    });
    this.sessionExporter = sessionExporterConfig
      ? new QmdSessionExporter(
          sessionExporterConfig,
          this.agentId,
          this.workspaceDir,
          this.indexPath,
          (collection, collectionRelativePath, workspaceRelativePath, absolutePath) =>
            this.buildSearchPath(
              collection,
              collectionRelativePath,
              workspaceRelativePath,
              absolutePath,
            ),
        )
      : null;
    if (sessionExporterConfig) {
      this.qmd.collections = [
        ...this.qmd.collections,
        {
          name: sessionExporterConfig.collectionName,
          path: sessionExporterConfig.dir,
          pattern: "**/*.md",
          kind: "sessions",
        },
      ];
    }
    this.managedCollectionNames = this.computeManagedCollectionNames();
  }

  private async initialize(mode: QmdManagerMode): Promise<void> {
    this.mode = mode;
    const startTime = Date.now();
    this.bootstrapCollections();
    if (mode === "status") {
      return;
    }

    await fs.mkdir(this.xdgConfigHome, { recursive: true });
    await fs.mkdir(this.xdgCacheHome, { recursive: true });
    await fs.mkdir(path.dirname(this.indexPath), { recursive: true });
    if (this.sessionExporter) {
      await fs.mkdir(this.sessionExporter.config.dir, { recursive: true });
    }

    // QMD stores its ML models under $XDG_CACHE_HOME/qmd/models/.  Because we
    // override XDG_CACHE_HOME to isolate the index per-agent, qmd would not
    // find models installed at the default location (~/.cache/qmd/models/) and
    // would attempt to re-download them on every invocation.  Symlink the
    // default models directory into our custom cache so the index stays
    // isolated while models are shared.
    await this.symlinkSharedModels();

    await this.ensureCollections();
    if (mode === "cli") {
      if (this.qmd.update.onBoot && this.qmd.update.waitForBootSync) {
        await this.runUpdate("boot:cli", true).catch((err: unknown) => {
          log.warn(`qmd cli boot update failed: ${String(err)}`);
        });
      }
      log.info(
        `qmd manager initialized for agent "${this.agentId}" mode=cli collections=${this.qmd.collections.length} durationMs=${Date.now() - startTime}`,
      );
      return;
    }

    this.ensureWatcher();
    log.info(
      `qmd manager initialized for agent "${this.agentId}" mode=full collections=${this.qmd.collections.length} durationMs=${Date.now() - startTime}`,
    );

    if (this.qmd.update.onBoot) {
      const bootRun = this.runUpdate("boot", true);
      if (this.qmd.update.waitForBootSync) {
        await bootRun.catch((err: unknown) => {
          log.warn(`qmd boot update failed: ${String(err)}`);
        });
      } else {
        void bootRun.catch((err: unknown) => {
          log.warn(`qmd boot update failed: ${String(err)}`);
        });
      }
    }
    if (this.qmd.update.intervalMs > 0) {
      this.updateTimer = setInterval(() => {
        void this.runUpdate("interval").catch((err: unknown) => {
          log.warn(`qmd update failed (${String(err)})`);
        });
      }, this.qmd.update.intervalMs);
    }
    if (this.shouldScheduleEmbedTimer()) {
      const startPeriodicEmbedTimer = () => {
        this.embedTimer = setInterval(() => {
          void this.runUpdate("embed-interval").catch((err: unknown) => {
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
            .catch((err: unknown) => {
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

  private qmdRuntimeCacheSources(): string[] {
    return [...this.sources].toSorted();
  }

  private qmdRuntimeCacheCollections(): QmdRuntimeManagedCollection[] {
    return this.qmd.collections.map((collection) => ({
      name: collection.name,
      kind: collection.kind,
      path: collection.path,
      pattern: collection.pattern,
    }));
  }

  private buildQmdRuntimeEnvironmentHash(): string {
    const relevantEnv = Object.fromEntries(
      Object.keys(this.env)
        .filter(
          (key) =>
            key === "PATH" ||
            key === "HOME" ||
            key === "LOCALAPPDATA" ||
            key === "XDG_CONFIG_HOME" ||
            key === "XDG_CACHE_HOME" ||
            key === "QMD_CONFIG_DIR" ||
            key.startsWith("QMD_"),
        )
        .toSorted()
        .map((key) => [key, this.env[key] ?? ""]),
    );
    return crypto.createHash("sha256").update(JSON.stringify(relevantEnv)).digest("hex");
  }

  private async buildQmdCollectionValidationCacheContext(
    signal?: AbortSignal,
  ): Promise<QmdRuntimeCollectionValidationCacheContext> {
    return {
      workspaceDir: this.workspaceDir,
      agentId: this.agentId,
      qmdCommand: this.qmd.command,
      qmdVersion: await this.resolveQmdRuntimeIdentity(signal),
      qmdEnvironmentHash: this.buildQmdRuntimeEnvironmentHash(),
      qmdIndexPath: this.indexPath,
      searchMode: this.qmd.searchMode,
      collections: this.qmdRuntimeCacheCollections(),
      sources: this.qmdRuntimeCacheSources(),
    };
  }

  private async buildQmdMultiCollectionProbeCacheContext(): Promise<QmdRuntimeMultiCollectionProbeCacheContext> {
    return {
      workspaceDir: this.workspaceDir,
      agentId: this.agentId,
      qmdCommand: this.qmd.command,
      qmdVersion: await this.resolveQmdRuntimeIdentity(),
      qmdEnvironmentHash: this.buildQmdRuntimeEnvironmentHash(),
      qmdIndexPath: this.indexPath,
      searchMode: this.qmd.searchMode,
      sources: this.qmdRuntimeCacheSources(),
    };
  }

  private resolveQmdRuntimeIdentity(signal?: AbortSignal): Promise<string> {
    if (signal) {
      return this.readQmdRuntimeIdentity(signal);
    }
    this.qmdRuntimeIdentityPromise ??= this.readQmdRuntimeIdentity();
    return this.qmdRuntimeIdentityPromise;
  }

  private async readQmdRuntimeIdentity(signal?: AbortSignal): Promise<string> {
    const commandIdentity = `command:${this.qmd.command}`;
    try {
      const result = await this.runQmd(["--version"], {
        timeoutMs: Math.min(this.qmd.limits.timeoutMs, 2_000),
        signal,
      });
      const versionText = `${result.stdout}\n${result.stderr}`.trim();
      return versionText ? `${commandIdentity};version:${versionText}` : commandIdentity;
    } catch {
      if (signal?.aborted) {
        throw asQmdAbortError(signal);
      }
      return commandIdentity;
    }
  }

  private recordSearchPlanDebug(params: {
    debugContext: QmdSearchRuntimeDebugContext;
    command: "query" | "search" | "vsearch";
    collectionNames: string[];
    collectionGroups: string[][];
  }): void {
    const sources = uniqueValues(
      params.collectionNames
        .map((collectionName) => this.collectionRoots.get(collectionName)?.kind)
        .filter((source): source is MemorySource => Boolean(source)),
    );
    params.debugContext.searchPlan = {
      command: params.command,
      collectionCount: params.collectionNames.length,
      groupCount: params.collectionGroups.length,
      sources,
    };
  }

  private beginQmdSearchRuntimeDebug(): QmdSearchRuntimeDebugContext {
    const debugContext: QmdSearchRuntimeDebugContext = {};
    const collectionValidation = this.collectionController.consumePendingValidationDebug();
    if (collectionValidation) {
      debugContext.collectionValidation = collectionValidation;
    }
    return debugContext;
  }

  private consumeQmdRuntimeDebug(
    debugContext: QmdSearchRuntimeDebugContext,
  ): MemorySearchRuntimeDebug["qmd"] | undefined {
    const debug: NonNullable<MemorySearchRuntimeDebug["qmd"]> = {};
    if (debugContext.collectionValidation) {
      debug.collectionValidation = debugContext.collectionValidation;
    }
    if (debugContext.multiCollectionProbe) {
      debug.multiCollectionProbe = debugContext.multiCollectionProbe;
    }
    if (debugContext.searchPlan) {
      debug.searchPlan = debugContext.searchPlan;
    }
    return Object.keys(debug).length > 0 ? debug : undefined;
  }

  private async ensureCollections(options?: {
    force?: boolean;
    debugContext?: QmdSearchRuntimeDebugContext;
    parentSignal?: AbortSignal;
  }): Promise<void> {
    await this.withQmdStoreWriteLease(async (lease) => {
      await this.collectionController.ensureCollections({ ...options, lease });
    }, options?.parentSignal);
  }

  private async tryRepairMissingCollectionSearch(
    err: unknown,
    debugContext: QmdSearchRuntimeDebugContext,
    parentSignal?: AbortSignal,
  ): Promise<boolean> {
    if (!this.isMissingCollectionSearchError(err)) {
      return false;
    }
    log.warn(
      "qmd search failed because a managed collection is missing; repairing collections and retrying once",
    );
    await this.ensureCollections({ force: true, debugContext, parentSignal });
    return true;
  }

  private async tryRepairNullByteCollections(
    err: unknown,
    reason: string,
    lease: PluginStateLeaseContext,
  ): Promise<boolean> {
    return await this.collectionController.tryRepairNullByteCollections(err, reason, lease);
  }

  private async tryRepairDuplicateDocumentConstraint(
    err: unknown,
    reason: string,
    lease: PluginStateLeaseContext,
  ): Promise<boolean> {
    return await this.collectionController.tryRepairDuplicateDocumentConstraint(err, reason, lease);
  }

  async search(
    query: string,
    opts?: {
      maxResults?: number;
      minScore?: number;
      sessionKey?: string;
      qmdSearchModeOverride?: "query" | "search" | "vsearch";
      onDebug?: (debug: MemorySearchRuntimeDebug) => void;
      sources?: MemorySource[];
      /**
       * Caller-owned cancellation. When the caller stops waiting (e.g. the
       * memory_search tool deadline fires), abort kills the in-flight qmd
       * subprocess instead of leaving it running orphaned for the full qmd
       * timeout.
       */
      signal?: AbortSignal;
    } & MemorySearchDeadlineControlOptions,
  ): Promise<MemorySearchResult[]> {
    if (!this.isScopeAllowed(opts?.sessionKey)) {
      this.logScopeDenied(opts?.sessionKey);
      return [];
    }
    const searchSignal = opts?.signal;
    const reportCommandPhase = opts?.[MEMORY_SEARCH_DEADLINE_CONTROL];
    if (searchSignal?.aborted) {
      throw asQmdAbortError(searchSignal);
    }
    const debugContext = this.beginQmdSearchRuntimeDebug();
    const trimmed = query.trim();
    if (!trimmed) {
      return [];
    }
    await this.maybeWarmSession(opts?.sessionKey);
    await this.maybeSyncDirtySearchState();
    await this.waitForPendingUpdateBeforeSearch();
    const resultLimit = Math.min(
      this.qmd.limits.maxResults,
      opts?.maxResults ?? this.qmd.limits.maxResults,
    );
    // Remember-only session exports are indexed for trusted recall but are not
    // part of ordinary manager searches. Explicit export keeps its existing
    // ordinary-access behavior; trusted recall always passes sources=sessions.
    const requestedSources = opts?.sources?.length
      ? uniqueValues(opts.sources)
      : this.qmd.sessions.readable
        ? undefined
        : (["memory"] satisfies MemorySource[]);
    const collectionNames = this.listManagedCollectionNames(requestedSources);
    const limit = resultLimit;
    if (collectionNames.length === 0) {
      log.warn("qmd query skipped: no managed collections configured");
      return [];
    }
    const qmdSearchCommand = opts?.qmdSearchModeOverride ?? this.qmd.searchMode;
    let effectiveSearchMode: "query" | "search" | "vsearch" = qmdSearchCommand;
    let searchFallbackReason: string | undefined;
    const explicitSearchTool = this.qmd.searchTool;
    const mcporterEnabled = this.qmd.mcporter.enabled;
    const runSearchAttempt = async (
      allowMissingCollectionRepair: boolean,
    ): Promise<QmdQueryResult[]> => {
      let attemptedCombinedCollectionFilter = false;
      try {
        if (mcporterEnabled) {
          const minScore = opts?.minScore ?? 0;
          if (explicitSearchTool) {
            if (collectionNames.length > 1) {
              return await this.commands.searchAcrossCollections({
                tool: explicitSearchTool,
                searchCommand: qmdSearchCommand,
                explicitToolOverride: true,
                query: trimmed,
                limit,
                minScore,
                collectionNames,
                signal: searchSignal,
                reportCommandPhase,
              });
            }
            return await this.commands.searchViaMcporter({
              mcporter: this.qmd.mcporter,
              tool: explicitSearchTool,
              searchCommand: qmdSearchCommand,
              explicitToolOverride: true,
              query: trimmed,
              limit,
              minScore,
              collection: collectionNames[0],
              timeoutMs: this.qmd.limits.timeoutMs,
              signal: searchSignal,
              reportCommandPhase,
            });
          }
          const tool = this.commands.resolveMcpTool(qmdSearchCommand);
          if (collectionNames.length > 1) {
            return await this.commands.searchAcrossCollections({
              tool,
              searchCommand: qmdSearchCommand,
              explicitToolOverride: false,
              query: trimmed,
              limit,
              minScore,
              collectionNames,
              signal: searchSignal,
              reportCommandPhase,
            });
          }
          return await this.commands.searchViaMcporter({
            mcporter: this.qmd.mcporter,
            tool,
            searchCommand: qmdSearchCommand,
            explicitToolOverride: false,
            query: trimmed,
            limit,
            minScore,
            collection: collectionNames[0],
            timeoutMs: this.qmd.limits.timeoutMs,
            signal: searchSignal,
            reportCommandPhase,
          });
        }
        const collectionGroups = await this.resolveCollectionSearchGroups(
          collectionNames,
          searchSignal,
          debugContext,
        );
        this.recordSearchPlanDebug({
          debugContext,
          command: qmdSearchCommand,
          collectionNames,
          collectionGroups,
        });
        attemptedCombinedCollectionFilter = collectionGroups.some((group) => group.length > 1);
        if (collectionGroups.length > 1) {
          return await this.runQueryAcrossCollectionGroups(
            trimmed,
            limit,
            collectionGroups,
            qmdSearchCommand,
            searchSignal,
            reportCommandPhase,
          );
        }
        const args = this.buildSearchArgs(qmdSearchCommand, trimmed, limit);
        args.push(...this.buildCollectionFilterArgs(collectionGroups[0] ?? collectionNames));
        return await this.runQmdSearch(args, qmdSearchCommand, searchSignal, reportCommandPhase);
      } catch (err) {
        if (allowMissingCollectionRepair && this.isMissingCollectionSearchError(err)) {
          throw err;
        }
        if (
          !mcporterEnabled &&
          qmdSearchCommand !== "query" &&
          this.isUnsupportedQmdOptionError(err)
        ) {
          if (attemptedCombinedCollectionFilter) {
            await this.markQmdMultiCollectionFiltersUnsupported(debugContext);
          }
          effectiveSearchMode = "query";
          searchFallbackReason = "unsupported-search-flags";
          log.warn(
            `qmd ${qmdSearchCommand} does not support configured flags; retrying search with qmd query`,
          );
          try {
            const collectionGroups = await this.resolveCollectionSearchGroups(
              collectionNames,
              searchSignal,
              debugContext,
            );
            this.recordSearchPlanDebug({
              debugContext,
              command: "query",
              collectionNames,
              collectionGroups,
            });
            if (collectionGroups.length > 1) {
              return await this.runQueryAcrossCollectionGroups(
                trimmed,
                limit,
                collectionGroups,
                "query",
                searchSignal,
                reportCommandPhase,
              );
            }
            const fallbackArgs = this.buildSearchArgs("query", trimmed, limit);
            fallbackArgs.push(
              ...this.buildCollectionFilterArgs(collectionGroups[0] ?? collectionNames),
            );
            return await this.runQmdSearch(fallbackArgs, "query", searchSignal, reportCommandPhase);
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
      if (!(await this.tryRepairMissingCollectionSearch(err, debugContext, searchSignal))) {
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
      const snippet = truncateUtf16Safe(entry.snippet ?? "", this.qmd.limits.maxSnippetChars);
      const lines = this.resolveSnippetLines(entry, snippet);
      const score = typeof entry.score === "number" ? entry.score : 0;
      const minScore = opts?.minScore ?? 0;
      if (score < minScore) {
        continue;
      }
      const result = {
        path: doc.rel,
        startLine: lines.startLine,
        endLine: lines.endLine,
        score,
        snippet,
        source: doc.source,
      } satisfies MemorySearchResult;
      const artifactIdentity =
        doc.source === "sessions"
          ? resolveQmdSessionArtifactIdentity({
              artifactPath: doc.collectionRelativePath,
              collection: doc.collection,
              docid: entry.docid?.trim() || undefined,
              indexPath: this.indexPath,
              searchPath: doc.rel,
            })
          : null;
      results.push(
        artifactIdentity ? attachQmdSessionArtifactHit(result, artifactIdentity) : result,
      );
    }
    opts?.onDebug?.({
      backend: "qmd",
      configuredMode: qmdSearchCommand,
      effectiveMode: effectiveSearchMode,
      fallback: searchFallbackReason,
      qmd: this.consumeQmdRuntimeDebug(debugContext),
    });
    let ranked = results;
    if (opts?.sources?.length) {
      const allow = new Set(opts.sources);
      ranked = results.filter((r) => allow.has(r.source));
    }
    return this.clampResultsByInjectedChars(this.diversifyResultsBySource(ranked, resultLimit));
  }

  async sync(params?: MemorySyncParams): Promise<void> {
    if (
      params?.sessions?.some((session) => session.sessionId.trim().length > 0) ||
      params?.archiveFiles?.some((sessionFile) => sessionFile.trim().length > 0)
    ) {
      log.debug("qmd sync ignoring targeted session hint; running regular update");
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
  }): Promise<MemoryReadResult> {
    const relPath = params.relPath?.trim();
    if (!relPath) {
      throw new Error("path required");
    }
    const absPath = this.resolveReadPath(relPath);
    if (!absPath.endsWith(".md")) {
      throw new Error("path required");
    }
    let statResult: Awaited<ReturnType<typeof statRegularFile>>;
    try {
      statResult = await statRegularFile(absPath);
    } catch (err) {
      if (err instanceof Error && err.message === "path must be a regular file") {
        throw new Error("path required", { cause: err });
      }
      throw err;
    }
    if (statResult.missing) {
      return { text: "", path: relPath };
    }
    const contextLimits = this.contextLimits;
    if (params.from !== undefined || params.lines !== undefined) {
      const startLine = normalizePositiveInteger(params.from, 1);
      const requestedCount = normalizePositiveInteger(
        params.lines ?? contextLimits?.memoryGetDefaultLines ?? DEFAULT_MEMORY_READ_LINES,
        DEFAULT_MEMORY_READ_LINES,
      );
      const partial = await this.readPartialText(absPath, startLine, requestedCount);
      if (partial.missing) {
        return { text: "", path: relPath };
      }
      return buildMemoryReadResultFromSlice({
        selectedLines: partial.selectedLines,
        relPath,
        startLine,
        moreSourceLinesRemain: partial.moreSourceLinesRemain,
        maxChars: contextLimits?.memoryGetMaxChars,
        suggestReadFallback: isDefaultMemoryPath(relPath),
      });
    }
    const full = await this.readFullText(absPath);
    if (full.missing) {
      return { text: "", path: relPath };
    }
    return buildMemoryReadResult({
      content: full.text,
      relPath,
      from: params.from,
      lines: params.lines,
      defaultLines: contextLimits?.memoryGetDefaultLines ?? DEFAULT_MEMORY_READ_LINES,
      maxChars: contextLimits?.memoryGetMaxChars,
      suggestReadFallback: isDefaultMemoryPath(relPath),
    });
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
      dirty: this.dirty,
      workspaceDir: this.workspaceDir,
      dbPath: this.indexPath,
      sources: Array.from(this.sources),
      sourceCounts: counts.sourceCounts,
      vector: {
        enabled: qmdUsesVectors(this.qmd.searchMode),
        available: this.vectorAvailable ?? undefined,
        semanticAvailable: this.vectorAvailable ?? undefined,
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
          embedFailures: this.embedFailureCount,
          embedBackoffUntil: this.embedBackoffUntil,
        },
      },
    };
  }

  async probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult> {
    if (!qmdUsesVectors(this.qmd.searchMode)) {
      return { ok: true, checked: false };
    }
    const ok = await this.probeVectorAvailability();
    return {
      ok,
      error: ok ? undefined : (this.vectorStatusDetail ?? "QMD semantic vectors are unavailable"),
    };
  }

  async probeVectorAvailability(): Promise<boolean> {
    if (!qmdUsesVectors(this.qmd.searchMode)) {
      this.vectorAvailable = false;
      this.vectorStatusDetail = null;
      return false;
    }
    try {
      const timeoutMs = this.qmd.limits.timeoutMs;
      const result = await this.runQmd(["status"], {
        timeoutMs,
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
    this.resolveCloseSignal();
    this.closeAbortController.abort(new Error("qmd manager closed"));
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
      const startTime = Date.now();
      let updatePublished = false;
      log.debug(
        `qmd sync started for agent "${this.agentId}" reason=${reason} force=${force === true}`,
      );
      try {
        await this.withQmdUpdateQueue(async (lease) => {
          const { signal } = lease;
          if (this.closed) {
            return;
          }
          if (this.sessionExporter) {
            await this.exportSessions(lease);
            this.throwIfAborted(signal);
          }
          await this.runQmdUpdateWithRetry(reason, lease);
          updatePublished = true;
          if (this.sessionExporter) {
            this.throwIfAborted(signal);
            this.refreshSessionArtifactDocIds(lease);
          }
        });
      } catch (err) {
        if (err instanceof PluginStateLeaseError && this.shouldPreserveLeaseRetry(err)) {
          this.dirty = true;
          if (updatePublished && qmdUsesVectors(this.qmd.searchMode)) {
            this.embedLeaseRetryPending = true;
          }
        }
        throw err;
      }
      if (this.closed) {
        return;
      }
      this.dirty = false;
      if (this.shouldRunEmbed(force)) {
        try {
          // Wait for embed capacity before taking the per-agent write lease. The
          // lease should protect active qmd writes only, not time spent queued
          // behind unrelated agents' embeds.
          const embedded = await this.withQmdEmbedQueue(async () => {
            await this.withQmdGlobalEmbedLease((globalLease) =>
              this.withQmdStoreWriteLease(async (lease) => {
                globalLease.assertOwned();
                lease.assertOwned();
                await this.runQmd(["embed"], {
                  timeoutMs: this.qmd.update.embedTimeoutMs,
                  discardOutput: true,
                  signal: lease.signal,
                });
              }, globalLease.signal),
            );
          });
          if (!embedded) {
            return;
          }
          this.lastEmbedAt = Date.now();
          this.embedLeaseRetryPending = false;
          this.embedBackoffUntil = null;
          this.embedFailureCount = 0;
        } catch (err) {
          if (err instanceof PluginStateLeaseError) {
            if (this.shouldPreserveLeaseRetry(err)) {
              // The update already published documents. Keep both the dirty-sync
              // trigger and embed intent so contention cannot strand them unembedded.
              this.dirty = true;
              this.embedLeaseRetryPending = true;
            }
            throw err;
          }
          this.noteEmbedFailure(reason, err);
        }
      }
      if (this.closed) {
        return;
      }
      this.lastUpdateAt = Date.now();
      this.documentResolver.clearCache();
      log.info(
        `qmd sync completed for agent "${this.agentId}" reason=${reason} durationMs=${Date.now() - startTime}`,
      );
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
    const watchRoots = new Set<string>();
    for (const collection of this.qmd.collections) {
      if (collection.kind === "sessions") {
        continue;
      }
      watchRoots.add(path.normalize(collection.path));
      watchPaths.add(this.resolveCollectionWatchPath(collection));
    }
    if (watchPaths.size === 0) {
      return;
    }
    const watchPathList = Array.from(watchPaths);
    const startTime = Date.now();
    log.info(`qmd watcher starting for agent "${this.agentId}" paths=${watchPathList.length}`);
    const watchRootList = Array.from(watchRoots);
    const watcher = chokidar.watch(watchPathList, {
      ignoreInitial: true,
      ignored: (watchPath) => shouldIgnoreMemoryWatchPath(watchPath, watchRootList),
    });
    this.watcher = watcher;
    const markDirty = (watchPath?: string, stats?: MemoryWatchEventStats) => {
      recordMemoryWatchEventPath(this.pendingWatchPaths, watchPath, stats);
      this.dirty = true;
      this.scheduleWatchSync();
    };
    watcher.on("add", markDirty);
    watcher.on("change", markDirty);
    watcher.on("unlink", markDirty);
    watcher.once("ready", () => {
      this.warnIfWatchPressure(countChokidarWatchedEntries(watcher));
      log.info(
        `qmd watcher ready for agent "${this.agentId}" paths=${watchPathList.length} durationMs=${Date.now() - startTime}`,
      );
    });
  }

  private warnIfWatchPressure(count: number): void {
    warnIfMemoryWatchPressureHigh(
      this.watchPressureWarning,
      count,
      "paths",
      "Large QMD collections can make OpenClaw run out of file watchers or open files.",
      "Remove large collections, or set memorySearch.sync.watch to false and refresh memory manually or with sync.intervalMinutes.",
      (message) => log.warn(message),
    );
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
      void (async () => {
        if (this.closed) {
          return;
        }
        if (!(await settleMemoryWatchEventPaths(this.pendingWatchPaths))) {
          if (!this.closed) {
            this.scheduleWatchSync();
          }
          return;
        }
        if (this.closed) {
          return;
        }
        await this.sync({ reason: "watch" });
      })().catch((err: unknown) => {
        log.warn(`qmd watch sync failed: ${String(err)}`);
      });
    }, this.syncSettings.watchDebounceMs);
  }

  private async maybeWarmSession(sessionKey?: string): Promise<void> {
    if (this.mode === "cli") {
      return;
    }
    if (!this.syncSettings?.onSessionStart) {
      return;
    }
    const key = sessionKey?.trim() || "";
    if (!key || this.sessionWarm.has(key)) {
      return;
    }
    this.sessionWarm.add(key);
    void this.sync({ reason: "session-start" }).catch((err: unknown) => {
      log.warn(`qmd session-start sync failed: ${String(err)}`);
    });
  }

  private async maybeSyncDirtySearchState(): Promise<void> {
    if (this.mode === "cli") {
      return;
    }
    if (!this.syncSettings?.onSearch || !this.dirty) {
      return;
    }
    await this.sync({ reason: "search" });
  }

  private async runQmdUpdateWithRetry(
    reason: string,
    lease: PluginStateLeaseContext,
  ): Promise<void> {
    const { signal } = lease;
    const isBootRun = reason === "boot" || reason.startsWith("boot:");
    const maxAttempts = isBootRun ? 3 : 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await this.runQmdUpdateOnce(reason, lease);
        return;
      } catch (err) {
        if (attempt >= maxAttempts || !this.isRetryableUpdateError(err)) {
          throw err;
        }
        const delayMs = 500 * 2 ** (attempt - 1);
        log.warn(
          `qmd update retry ${attempt}/${maxAttempts - 1} after failure (${reason}): ${String(err)}`,
        );
        await this.waitForRetryDelay(delayMs, signal);
      }
    }
  }

  private async runQmdUpdateOnce(reason: string, lease: PluginStateLeaseContext): Promise<void> {
    const { signal } = lease;
    try {
      lease.assertOwned();
      await this.runQmd(["update"], {
        timeoutMs: this.qmd.update.updateTimeoutMs,
        discardOutput: true,
        signal,
      });
    } catch (err) {
      if (
        !(await this.tryRepairNullByteCollections(err, reason, lease)) &&
        !(await this.tryRepairDuplicateDocumentConstraint(err, reason, lease))
      ) {
        throw err;
      }
      lease.assertOwned();
      await this.runQmd(["update"], {
        timeoutMs: this.qmd.update.updateTimeoutMs,
        discardOutput: true,
        signal,
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

  private throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) {
      throw asQmdAbortError(signal);
    }
  }

  private async waitForRetryDelay(delayMs: number, signal: AbortSignal): Promise<void> {
    this.throwIfAborted(signal);
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timeout);
        reject(asQmdAbortError(signal));
      };
      const timeout = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, delayMs);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private shouldRunEmbed(force?: boolean): boolean {
    if (!qmdUsesVectors(this.qmd.searchMode)) {
      return false;
    }
    const now = Date.now();
    if (this.embedBackoffUntil !== null && isFutureDateTimestampMs(this.embedBackoffUntil)) {
      return false;
    }
    const embedIntervalMs = this.qmd.update.embedIntervalMs;
    return (
      this.embedLeaseRetryPending ||
      Boolean(force) ||
      this.lastEmbedAt === null ||
      (embedIntervalMs > 0 && now - this.lastEmbedAt > embedIntervalMs)
    );
  }

  private shouldPreserveLeaseRetry(err: PluginStateLeaseError): boolean {
    return (
      !this.closed &&
      err.code !== "PLUGIN_STATE_LEASE_ABORTED" &&
      err.code !== "PLUGIN_STATE_LEASE_INVALID_INPUT"
    );
  }

  private shouldScheduleEmbedTimer(): boolean {
    if (!qmdUsesVectors(this.qmd.searchMode)) {
      return false;
    }
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

  private async withQmdEmbedQueue(task: () => Promise<void>): Promise<boolean> {
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
    try {
      const waitResult = await Promise.race([
        previous.then(
          () => "ready" as const,
          () => "ready" as const,
        ),
        this.closeSignal.then(() => "closed" as const),
      ]);
      if (waitResult === "closed") {
        return false;
      }
      await task();
      return true;
    } finally {
      releaseCurrent();
    }
  }

  private async withQmdGlobalEmbedLease<T>(
    task: (lease: PluginStateLeaseContext) => Promise<T>,
  ): Promise<T> {
    return await this.withLease(
      {
        namespace: "qmd",
        key: "embed",
        database: { scope: "shared" },
        ...resolveQmdEmbedLeaseOptions(this.qmd.update.embedTimeoutMs),
        signal: this.closeAbortController.signal,
      },
      async (lease) => await task(lease),
    );
  }

  private async withQmdStoreWriteLease<T>(
    task: (lease: PluginStateLeaseContext) => Promise<T>,
    parentSignal?: AbortSignal,
  ): Promise<T> {
    // SQLite is the sole runtime coordinator. Upgrade cutover requires every
    // process sharing this state directory to restart; never dual-lock sidecars.
    // One per-agent cross-process write lease guarding every qmd write (update and
    // embed) against the same index.sqlite, so a foreground `memory search`
    // dirty-sync and a background gateway update/embed never write concurrently
    // (writer-vs-writer SQLITE_BUSY, #66339). Agent-scoped rows keep different
    // agents parallel. Update takes only this lease; embed first waits for global
    // embed capacity, then takes this lease for
    // the active qmd write.
    return await this.withLease(
      {
        namespace: "qmd",
        key: "write",
        database: { scope: "agent", agentId: this.agentId },
        ...resolveQmdStoreWriteLeaseOptions(
          this.qmd.update.updateTimeoutMs,
          this.qmd.update.embedTimeoutMs,
        ),
        signal: parentSignal
          ? AbortSignal.any([this.closeAbortController.signal, parentSignal])
          : this.closeAbortController.signal,
      },
      async (lease) => await task(lease),
    );
  }

  private async withQmdUpdateQueue<T>(
    task: (lease: PluginStateLeaseContext) => Promise<T>,
  ): Promise<T> {
    const queue = getQmdUpdateQueueState();
    const key = this.qmdDir;
    const previous = queue.tails.get(key) ?? Promise.resolve();
    let releaseCurrent!: () => void;
    const current = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    const next = previous.then(
      () => current,
      () => current,
    );
    queue.tails.set(key, next);
    try {
      const waitResult = await Promise.race([
        previous.then(
          () => "ready" as const,
          () => "ready" as const,
        ),
        this.closeSignal.then(() => "closed" as const),
      ]);
      if (waitResult === "closed") {
        return undefined as T;
      }
      // Serialize the update write across processes (gateway + CLI). The in-process
      // queue above is keyed per store but a separate process cannot see it. The
      // shared per-agent write lease also serializes against the embed write below,
      // which targets the same index.sqlite.
      return await this.withQmdStoreWriteLease(task);
    } finally {
      releaseCurrent();
      void next.finally(() => {
        if (queue.tails.get(key) === next) {
          queue.tails.delete(key);
        }
      });
    }
  }

  private noteEmbedFailure(reason: string, err: unknown): void {
    this.embedFailureCount += 1;
    const delayMs = Math.min(
      QMD_EMBED_BACKOFF_MAX_MS,
      QMD_EMBED_BACKOFF_BASE_MS * 2 ** Math.max(0, this.embedFailureCount - 1),
    );
    this.embedBackoffUntil = resolveExpiresAtMsFromDurationMs(delayMs) ?? null;
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
    opts?: { timeoutMs?: number; discardOutput?: boolean; signal?: AbortSignal },
  ): Promise<{ stdout: string; stderr: string }> {
    return await this.commands.run(args, opts);
  }

  private async runQmdSearch(
    args: string[],
    command: "query" | "search" | "vsearch",
    signal?: AbortSignal,
    reportCommandPhase?: QmdCommandPhaseReporter,
  ): Promise<QmdQueryResult[]> {
    return await this.commands.search(args, command, signal, reportCommandPhase);
  }

  /**
   * QMD 1.1+ unified all search modes under a single "query" MCP tool
   * that accepts a `searches` array with typed sub-queries (lex, vec, hyde).
   * QMD <1.1 exposed separate tools: search, vector_search, deep_search.
   *
   * This method probes the MCP server once to detect which interface is
   * available and caches the result for subsequent calls.
   */
  private async readPartialText(
    absPath: string,
    from?: number,
    lines?: number,
  ): Promise<
    { missing: true } | { missing: false; selectedLines: string[]; moreSourceLinesRemain: boolean }
  > {
    const start = normalizePositiveInteger(from, 1);
    const count = normalizePositiveInteger(lines, Number.MAX_SAFE_INTEGER);
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
    let moreSourceLinesRemain = false;
    try {
      for await (const line of rl) {
        index += 1;
        if (index < start) {
          continue;
        }
        if (selected.length >= count) {
          moreSourceLinesRemain = true;
          break;
        }
        selected.push(line);
      }
    } finally {
      rl.close();
      await handle.close();
    }
    return {
      missing: false,
      selectedLines: selected.slice(0, count),
      moreSourceLinesRemain,
    };
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

  private async exportSessions(lease: PluginStateLeaseContext): Promise<void> {
    await this.sessionExporter?.exportSessions(lease);
  }

  private refreshSessionArtifactDocIds(lease: PluginStateLeaseContext): void {
    this.sessionExporter?.refreshArtifactDocIds(lease);
  }

  private async resolveDocLocation(
    docid?: string,
    hints?: { preferredCollection?: string; preferredFile?: string },
  ): Promise<DocLocation | null> {
    return await this.documentResolver.resolveDocLocation(docid, hints);
  }

  private normalizeDocHints(hints?: { preferredCollection?: string; preferredFile?: string }): {
    preferredCollection?: string;
    preferredFile?: string;
  } {
    return this.documentResolver.normalizeDocHints(hints);
  }

  private toCollectionRelativePath(collection: string, filePath: string): string | null {
    return this.documentResolver.toCollectionRelativePath(collection, filePath);
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
        const rootCandidate = this.collectionRoots.get(row.collection);
        const source = rootCandidate?.kind ?? "memory";
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

  private buildSearchPath(
    collection: string,
    collectionRelativePath: string,
    relativeToWorkspace: string,
    absPath: string,
  ): string {
    return this.documentResolver.buildSearchPath(
      collection,
      collectionRelativePath,
      relativeToWorkspace,
      absPath,
    );
  }

  private resolveReadPath(relPath: string): string {
    return this.documentResolver.resolveReadPath(relPath);
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
        const trimmed = truncateUtf16Safe(snippet, remaining);
        clamped.push(copyQmdSessionArtifactHit(entry, { ...entry, snippet: trimmed }));
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
    return isSqliteBusyError(err);
  }

  private isMissingCollectionSearchError(err: unknown): boolean {
    return isMissingCollectionSearchError(err);
  }

  private isUnsupportedQmdOptionError(err: unknown): boolean {
    return isUnsupportedQmdOptionError(err);
  }

  private async waitForPendingUpdateBeforeSearch(): Promise<void> {
    const pending = this.pendingUpdate;
    if (!pending) {
      return;
    }
    // Release the losing timer when the pending update settles first.
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const wait = new Promise<void>((resolve) => {
      timeout = setTimeout(resolve, SEARCH_PENDING_UPDATE_WAIT_MS);
    });
    await Promise.race([pending.catch(() => undefined), wait]).finally(() => clearTimeout(timeout));
  }

  private async resolveCollectionSearchGroups(
    collectionNames: string[],
    signal?: AbortSignal,
    debugContext?: QmdSearchRuntimeDebugContext,
  ): Promise<string[][]> {
    if (collectionNames.length <= 1) {
      return [collectionNames];
    }
    if (!(await this.supportsQmdMultiCollectionFilters(signal, debugContext))) {
      return collectionNames.map((collectionName) => [collectionName]);
    }
    return this.groupCollectionNamesBySource(collectionNames);
  }

  private async supportsQmdMultiCollectionFilters(
    signal?: AbortSignal,
    debugContext?: QmdSearchRuntimeDebugContext,
  ): Promise<boolean> {
    if (signal?.aborted) {
      throw asQmdAbortError(signal);
    }
    if (this.multiCollectionFilterSupported !== null) {
      return this.multiCollectionFilterSupported;
    }
    const startedAt = Date.now();
    const cacheContext = await this.buildQmdMultiCollectionProbeCacheContext();
    const cached = await readQmdMultiCollectionProbeCache(cacheContext);
    if (cached.state === "hit") {
      this.multiCollectionFilterSupported = cached.value.multiCollectionProbe.supported;
      if (debugContext) {
        debugContext.multiCollectionProbe = {
          cacheState: "hit",
          elapsedMs: Math.max(0, Date.now() - startedAt),
          supported: this.multiCollectionFilterSupported,
        };
      }
      return this.multiCollectionFilterSupported;
    }
    try {
      const result = await this.runQmd(["--help"], {
        timeoutMs: Math.min(this.qmd.limits.timeoutMs, 5_000),
        signal,
      });
      const helpText = `${result.stdout}\n${result.stderr}`;
      this.multiCollectionFilterSupported =
        /\b(?:one or more collections|collection\(s\)|multiple -c flags)\b/i.test(helpText);
      const wroteCache = await writeQmdMultiCollectionProbeCache(
        cacheContext,
        this.multiCollectionFilterSupported,
      );
      if (debugContext) {
        debugContext.multiCollectionProbe = {
          cacheState: wroteCache ? "write" : "error",
          elapsedMs: Math.max(0, Date.now() - startedAt),
          supported: this.multiCollectionFilterSupported,
        };
      }
    } catch (err) {
      // Cancellation says nothing about QMD capabilities; leave the probe uncached.
      if (signal?.aborted) {
        throw asQmdAbortError(signal);
      }
      this.multiCollectionFilterSupported = false;
      if (debugContext) {
        debugContext.multiCollectionProbe = {
          cacheState: "error",
          elapsedMs: Math.max(0, Date.now() - startedAt),
          supported: false,
        };
      }
      log.debug(`qmd multi-collection filter probe failed: ${String(err)}`);
    }
    return this.multiCollectionFilterSupported;
  }

  private async markQmdMultiCollectionFiltersUnsupported(
    debugContext: QmdSearchRuntimeDebugContext,
  ): Promise<void> {
    const startedAt = Date.now();
    const cacheContext = await this.buildQmdMultiCollectionProbeCacheContext();
    this.multiCollectionFilterSupported = false;
    await clearQmdMultiCollectionProbeCache(cacheContext);
    const wroteCache = await writeQmdMultiCollectionProbeCache(cacheContext, false);
    debugContext.multiCollectionProbe = {
      cacheState: wroteCache ? "write" : "error",
      elapsedMs: Math.max(0, Date.now() - startedAt),
      supported: false,
    };
  }

  private async runQueryAcrossCollectionGroups(
    query: string,
    limit: number,
    collectionGroups: string[][],
    command: "query" | "search" | "vsearch",
    signal?: AbortSignal,
    reportCommandPhase?: QmdCommandPhaseReporter,
  ): Promise<QmdQueryResult[]> {
    log.debug(
      `qmd ${command} multi-source collection grouping active (${collectionGroups.length} groups)`,
    );
    const bestByResultKey = new Map<string, QmdQueryResult>();
    for (const collectionNames of collectionGroups) {
      const args = this.buildSearchArgs(command, query, limit);
      args.push(...this.buildCollectionFilterArgs(collectionNames));
      const parsed = await this.runQmdSearch(args, command, signal, reportCommandPhase);
      for (const entry of parsed) {
        const defaultCollection = collectionNames.length === 1 ? collectionNames[0] : undefined;
        const normalizedHints = this.normalizeDocHints({
          preferredCollection: entry.collection ?? defaultCollection,
          preferredFile: entry.file,
        });
        const normalizedDocId =
          typeof entry.docid === "string" && entry.docid.trim().length > 0
            ? entry.docid
            : undefined;
        const withCollection = {
          ...entry,
          docid: normalizedDocId,
          collection: normalizedHints.preferredCollection ?? entry.collection ?? defaultCollection,
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

  private groupCollectionNamesBySource(collectionNames: string[]): string[][] {
    const groups = new Map<string, string[]>();
    for (const collectionName of collectionNames) {
      const source = this.collectionRoots.get(collectionName)?.kind ?? collectionName;
      const group = groups.get(source) ?? [];
      group.push(collectionName);
      groups.set(source, group);
    }
    return [...groups.values()];
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

  private listManagedCollectionNames(sources?: MemorySource[]): string[] {
    if (!sources?.length) {
      return this.managedCollectionNames;
    }
    const allowed = new Set(sources);
    return this.managedCollectionNames.filter((name) => {
      const source = this.collectionRoots.get(name)?.kind;
      return source ? allowed.has(source) : false;
    });
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
      const args = ["query", normalizedQuery, "--json", "-n", String(limit)];
      if (this.qmd.searchMode === "query" && this.qmd.rerank === false) {
        args.push("--no-rerank");
      }
      return args;
    }
    return [command, normalizedQuery, "--json", "-n", String(limit)];
  }
}

function resolveQmdManagerRuntimeConfig(
  cfg: OpenClawConfig,
  agentId: string,
): QmdManagerRuntimeConfig {
  return {
    workspaceDir: resolveAgentWorkspaceDir(cfg, agentId),
    syncSettings: resolveMemorySearchSyncConfig(cfg, agentId),
    contextLimits: resolveAgentContextLimits(cfg, agentId),
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
