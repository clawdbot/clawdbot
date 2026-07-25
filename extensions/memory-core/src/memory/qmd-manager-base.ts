import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FSWatcher } from "chokidar";
import {
  createSubsystemLogger,
  resolveAgentContextLimits,
  resolveMemorySearchSyncConfig,
  resolveAgentWorkspaceDir,
  resolveStateDir,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import type {
  MemorySource,
  ResolvedMemoryBackendConfig,
  ResolvedQmdConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import type {
  PluginStateLeaseContext,
  PluginStateLeaseRunner,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  QmdCollectionController,
  type ManagedQmdCollection as ManagedCollection,
  type QmdSearchRuntimeDebugContext,
} from "./qmd-collection-controller.js";
import { QmdCommandClient } from "./qmd-command-client.js";
import { asQmdAbortError } from "./qmd-command-errors.js";
import {
  QmdDocumentResolver,
  type QmdCollectionRoot as CollectionRoot,
} from "./qmd-document-resolver.js";
import { buildQmdProcessPath, MAX_QMD_OUTPUT_CHARS } from "./qmd-manager-helpers.js";
import type {
  QmdRuntimeCollectionValidationCacheContext,
  QmdRuntimeManagedCollection,
  QmdRuntimeMultiCollectionProbeCacheContext,
} from "./qmd-runtime-cache.js";
import { QmdSessionExporter, resolveQmdSessionExporterConfig } from "./qmd-session-exporter.js";
import type { MemoryWatchPressureWarningState } from "./watch-pressure.js";
import type { MemoryWatchSettleQueue } from "./watch-settle.js";

export const qmdManagerLog = createSubsystemLogger("memory");

type QmdManagerMode = "full" | "status" | "cli";
type QmdManagerRuntimeConfig = {
  workspaceDir: string;
  syncSettings: ReturnType<typeof resolveMemorySearchSyncConfig>;
  contextLimits: ReturnType<typeof resolveAgentContextLimits>;
};

type SqliteDatabase = import("node:sqlite").DatabaseSync;

export abstract class QmdManagerBase {
  protected readonly agentId: string;
  protected readonly qmd: ResolvedQmdConfig;
  protected readonly workspaceDir: string;
  protected readonly contextLimits: ReturnType<typeof resolveAgentContextLimits>;
  protected readonly stateDir: string;
  protected readonly agentStateDir: string;
  protected readonly qmdDir: string;
  protected readonly xdgConfigHome: string;
  protected readonly xdgCacheHome: string;
  protected readonly indexPath: string;
  protected readonly env: NodeJS.ProcessEnv;
  protected readonly commands: QmdCommandClient;
  protected readonly withLease: PluginStateLeaseRunner;
  protected readonly collectionController: QmdCollectionController;
  protected readonly documentResolver: QmdDocumentResolver;
  protected readonly syncSettings: ReturnType<typeof resolveMemorySearchSyncConfig>;
  protected readonly managedCollectionNames: string[];
  protected readonly collectionRoots = new Map<string, CollectionRoot>();
  protected readonly sources = new Set<MemorySource>();
  protected readonly maxQmdOutputChars = MAX_QMD_OUTPUT_CHARS;
  protected readonly sessionExporter: QmdSessionExporter | null;
  protected updateTimer: NodeJS.Timeout | null = null;
  protected embedTimer: NodeJS.Timeout | null = null;
  protected watcher: FSWatcher | null = null;
  protected watchTimer: NodeJS.Timeout | null = null;
  protected readonly pendingWatchPaths: MemoryWatchSettleQueue = new Map();
  protected readonly watchPressureWarning: MemoryWatchPressureWarningState = { shown: false };
  protected pendingUpdate: Promise<void> | null = null;
  protected queuedForcedUpdate: Promise<void> | null = null;
  protected queuedForcedRuns = 0;
  protected dirty = false;
  protected closed = false;
  protected mode: QmdManagerMode = "full";
  protected readonly closeSignal: Promise<void>;
  protected resolveCloseSignal!: () => void;
  protected readonly closeAbortController = new AbortController();
  protected qmdRuntimeIdentityPromise: Promise<string> | null = null;
  protected db: SqliteDatabase | null = null;
  protected lastUpdateAt: number | null = null;
  protected lastEmbedAt: number | null = null;
  protected embedLeaseRetryPending = false;
  protected embedBackoffUntil: number | null = null;
  protected embedFailureCount = 0;
  protected vectorAvailable: boolean | null = null;
  protected vectorStatusDetail: string | null = null;
  protected readonly sessionWarm = new Set<string>();
  protected multiCollectionFilterSupported: boolean | null = null;

  protected constructor(params: {
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
    // QMD manages collections in its index DB while XDG config and cache dirs
    // isolate contexts and index.sqlite per agent.
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
            this.documentResolver.buildSearchPath(
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

  protected async initialize(mode: QmdManagerMode): Promise<void> {
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

    // Reuse default-cache ML models despite the per-agent XDG cache override
    // so qmd does not download them separately for every agent.
    await this.symlinkSharedModels();

    await this.ensureCollections();
    if (mode === "cli") {
      if (this.qmd.update.onBoot && this.qmd.update.waitForBootSync) {
        await this.runUpdate("boot:cli", true).catch((err: unknown) => {
          qmdManagerLog.warn(`qmd cli boot update failed: ${String(err)}`);
        });
      }
      qmdManagerLog.info(
        `qmd manager initialized for agent "${this.agentId}" mode=cli collections=${this.qmd.collections.length} durationMs=${Date.now() - startTime}`,
      );
      return;
    }

    this.ensureWatcher();
    qmdManagerLog.info(
      `qmd manager initialized for agent "${this.agentId}" mode=full collections=${this.qmd.collections.length} durationMs=${Date.now() - startTime}`,
    );

    if (this.qmd.update.onBoot) {
      const bootRun = this.runUpdate("boot", true);
      if (this.qmd.update.waitForBootSync) {
        await bootRun.catch((err: unknown) => {
          qmdManagerLog.warn(`qmd boot update failed: ${String(err)}`);
        });
      } else {
        void bootRun.catch((err: unknown) => {
          qmdManagerLog.warn(`qmd boot update failed: ${String(err)}`);
        });
      }
    }
    if (this.qmd.update.intervalMs > 0) {
      this.updateTimer = setInterval(() => {
        void this.runUpdate("interval").catch((err: unknown) => {
          qmdManagerLog.warn(`qmd update failed (${String(err)})`);
        });
      }, this.qmd.update.intervalMs);
    }
    if (this.shouldScheduleEmbedTimer()) {
      const startPeriodicEmbedTimer = () => {
        this.embedTimer = setInterval(() => {
          void this.runUpdate("embed-interval").catch((err: unknown) => {
            qmdManagerLog.warn(`qmd embed interval update failed (${String(err)})`);
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
              qmdManagerLog.warn(`qmd embed interval update failed (${String(err)})`);
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

  protected bootstrapCollections(): void {
    this.collectionRoots.clear();
    this.sources.clear();
    for (const collection of this.qmd.collections) {
      const kind: MemorySource = collection.kind === "sessions" ? "sessions" : "memory";
      this.collectionRoots.set(collection.name, { path: collection.path, kind });
      this.sources.add(kind);
    }
  }

  protected qmdRuntimeCacheSources(): string[] {
    return [...this.sources].toSorted();
  }

  protected qmdRuntimeCacheCollections(): QmdRuntimeManagedCollection[] {
    return this.qmd.collections.map((collection) => ({
      name: collection.name,
      kind: collection.kind,
      path: collection.path,
      pattern: collection.pattern,
    }));
  }

  protected buildQmdRuntimeEnvironmentHash(): string {
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

  protected async buildQmdCollectionValidationCacheContext(
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

  protected async buildQmdMultiCollectionProbeCacheContext(): Promise<QmdRuntimeMultiCollectionProbeCacheContext> {
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

  protected resolveQmdRuntimeIdentity(signal?: AbortSignal): Promise<string> {
    if (signal) {
      return this.readQmdRuntimeIdentity(signal);
    }
    this.qmdRuntimeIdentityPromise ??= this.readQmdRuntimeIdentity();
    return this.qmdRuntimeIdentityPromise;
  }

  protected async readQmdRuntimeIdentity(signal?: AbortSignal): Promise<string> {
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

  protected async ensureCollections(options?: {
    force?: boolean;
    debugContext?: QmdSearchRuntimeDebugContext;
    parentSignal?: AbortSignal;
  }): Promise<void> {
    await this.withQmdStoreWriteLease(async (lease) => {
      await this.collectionController.ensureCollections({ ...options, lease });
    }, options?.parentSignal);
  }

  protected async tryRepairNullByteCollections(
    err: unknown,
    reason: string,
    lease: PluginStateLeaseContext,
  ): Promise<boolean> {
    return await this.collectionController.tryRepairNullByteCollections(err, reason, lease);
  }

  protected async tryRepairDuplicateDocumentConstraint(
    err: unknown,
    reason: string,
    lease: PluginStateLeaseContext,
  ): Promise<boolean> {
    return await this.collectionController.tryRepairDuplicateDocumentConstraint(err, reason, lease);
  }

  protected computeManagedCollectionNames(): string[] {
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

  protected async symlinkSharedModels(): Promise<void> {
    const defaultCacheHome =
      process.env.XDG_CACHE_HOME ||
      (process.platform === "win32" ? process.env.LOCALAPPDATA : undefined) ||
      path.join(os.homedir(), ".cache");
    const defaultModelsDir = path.join(defaultCacheHome, "qmd", "models");
    const targetModelsDir = path.join(this.xdgCacheHome, "qmd", "models");
    try {
      const stat = await fs.stat(defaultModelsDir).catch((err: unknown) => {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          return null;
        }
        throw err;
      });
      if (!stat?.isDirectory()) {
        return;
      }
      try {
        await fs.lstat(targetModelsDir);
        return;
      } catch {
        // Does not exist – proceed to create symlink.
      }
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
      qmdManagerLog.debug(`symlinked qmd models: ${defaultModelsDir} → ${targetModelsDir}`);
    } catch (err) {
      // Non-fatal: if we can't symlink, qmd will fall back to downloading.
      qmdManagerLog.warn(`failed to symlink qmd models directory: ${String(err)}`);
    }
  }

  protected async runQmd(
    args: string[],
    opts?: { timeoutMs?: number; discardOutput?: boolean; signal?: AbortSignal },
  ): Promise<{ stdout: string; stderr: string }> {
    return await this.commands.run(args, opts);
  }

  protected abstract runUpdate(reason: string, force?: boolean): Promise<void>;
  protected abstract ensureWatcher(): void;
  protected abstract shouldScheduleEmbedTimer(): boolean;
  protected abstract resolveEmbedStartupJitterMs(): number;
  protected abstract withQmdStoreWriteLease<T>(
    task: (lease: PluginStateLeaseContext) => Promise<T>,
    parentSignal?: AbortSignal,
  ): Promise<T>;
  protected abstract ensureDb(): SqliteDatabase;
}

export function resolveQmdManagerRuntimeConfig(
  cfg: OpenClawConfig,
  agentId: string,
): QmdManagerRuntimeConfig {
  return {
    workspaceDir: resolveAgentWorkspaceDir(cfg, agentId),
    syncSettings: resolveMemorySearchSyncConfig(cfg, agentId),
    contextLimits: resolveAgentContextLimits(cfg, agentId),
  };
}

export type QmdManagerCreateParams = {
  cfg: OpenClawConfig;
  agentId: string;
  resolved: ResolvedMemoryBackendConfig;
  withLease: PluginStateLeaseRunner;
  mode?: QmdManagerMode;
  runtimeConfig?: QmdManagerRuntimeConfig;
};

export type { ManagedCollection };
