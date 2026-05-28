import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import type { Transport } from "../../llm/types.js";
import { CONFIG_DIR_NAME, getAgentDir } from "../config.js";
import { DEFAULT_HTTP_IDLE_TIMEOUT_MS, parseHttpIdleTimeoutMs } from "./http-dispatcher.js";

export interface CompactionSettings {
  enabled?: boolean; // default: true
  reserveTokens?: number; // default: 16384
  keepRecentTokens?: number; // default: 20000
}

export interface BranchSummarySettings {
  reserveTokens?: number; // default: 16384 (tokens reserved for prompt + LLM response)
  skipPrompt?: boolean; // default: false - when true, skips "Summarize branch?" prompt and defaults to no summary
}

export interface ProviderRetrySettings {
  timeoutMs?: number; // SDK/provider request timeout in milliseconds
  maxRetries?: number; // SDK/provider retry attempts
  maxRetryDelayMs?: number; // default: 60000 (max server-requested delay before failing)
}

export interface RetrySettings {
  enabled?: boolean; // default: true
  maxRetries?: number; // default: 3
  baseDelayMs?: number; // default: 2000 (exponential backoff: 2s, 4s, 8s)
  provider?: ProviderRetrySettings;
}

export interface TerminalSettings {
  showImages?: boolean; // default: true (only relevant if terminal supports images)
  imageWidthCells?: number; // default: 60 (preferred inline image width in terminal cells)
  clearOnShrink?: boolean; // default: false (clear empty rows when content shrinks)
  showTerminalProgress?: boolean; // default: false (OSC 9;4 terminal progress indicators)
}

export interface ImageSettings {
  autoResize?: boolean; // default: true (resize images to 2000x2000 max for better model compatibility)
  blockImages?: boolean; // default: false - when true, prevents all images from being sent to LLM providers
}

export interface ThinkingBudgetsSettings {
  minimal?: number;
  low?: number;
  medium?: number;
  high?: number;
}

export interface MarkdownSettings {
  codeBlockIndent?: string; // default: "  "
}

export interface WarningSettings {
  anthropicExtraUsage?: boolean; // default: true
}

export type TransportSetting = Transport;

/**
 * Package source for npm/git packages.
 * - String form: load all resources from the package
 * - Object form: filter which resources to load
 */
export type PackageSource =
  | string
  | {
      source: string;
      extensions?: string[];
      skills?: string[];
      prompts?: string[];
      themes?: string[];
    };

export interface Settings {
  lastChangelogVersion?: string;
  defaultProvider?: string;
  defaultModel?: string;
  defaultThinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  transport?: TransportSetting; // default: "auto"
  steeringMode?: "all" | "one-at-a-time";
  followUpMode?: "all" | "one-at-a-time";
  theme?: string;
  compaction?: CompactionSettings;
  branchSummary?: BranchSummarySettings;
  retry?: RetrySettings;
  hideThinkingBlock?: boolean;
  shellPath?: string; // Custom shell path (e.g., for Cygwin users on Windows)
  quietStartup?: boolean;
  shellCommandPrefix?: string; // Prefix prepended to every bash command (e.g., "shopt -s expand_aliases" for alias support)
  npmCommand?: string[]; // Command used for npm package lookup/install operations, argv-style (e.g., ["mise", "exec", "node@20", "--", "npm"])
  collapseChangelog?: boolean; // Show condensed changelog after update (use /changelog for full)
  enableInstallTelemetry?: boolean; // default: true - anonymous version/update ping after changelog-detected updates
  packages?: PackageSource[]; // Array of npm/git package sources (string or object with filtering)
  extensions?: string[]; // Array of local extension file paths or directories
  skills?: string[]; // Array of local skill file paths or directories
  prompts?: string[]; // Array of local prompt template paths or directories
  themes?: string[]; // Array of local theme file paths or directories
  enableSkillCommands?: boolean; // default: true - register skills as /skill:name commands
  terminal?: TerminalSettings;
  images?: ImageSettings;
  enabledModels?: string[]; // Model patterns for cycling (same format as --models CLI flag)
  doubleEscapeAction?: "fork" | "tree" | "none"; // Action for double-escape with empty editor (default: "tree")
  treeFilterMode?: "default" | "no-tools" | "user-only" | "labeled-only" | "all"; // Default filter when opening /tree
  thinkingBudgets?: ThinkingBudgetsSettings; // Custom token budgets for thinking levels
  editorPaddingX?: number; // Horizontal padding for input editor (default: 0)
  autocompleteMaxVisible?: number; // Max visible items in autocomplete dropdown (default: 5)
  showHardwareCursor?: boolean; // Show terminal cursor while still positioning it for IME
  markdown?: MarkdownSettings;
  warnings?: WarningSettings;
  sessionDir?: string; // Custom session storage directory (same format as --session-dir CLI flag)
  httpIdleTimeoutMs?: number; // HTTP header/body idle timeout in milliseconds; 0 disables it
}

/** Deep merge settings: project/overrides take precedence, nested objects merge recursively */
function deepMergeSettings(base: Settings, overrides: Settings): Settings {
  const result: Settings = { ...base };

  for (const key of Object.keys(overrides) as (keyof Settings)[]) {
    const overrideValue = overrides[key];
    const baseValue = base[key];

    if (overrideValue === undefined) {
      continue;
    }

    // For nested objects, merge recursively
    if (
      typeof overrideValue === "object" &&
      overrideValue !== null &&
      !Array.isArray(overrideValue) &&
      typeof baseValue === "object" &&
      baseValue !== null &&
      !Array.isArray(baseValue)
    ) {
      (result as Record<string, unknown>)[key] = { ...baseValue, ...overrideValue };
    } else {
      // For primitives and arrays, override value wins
      (result as Record<string, unknown>)[key] = overrideValue;
    }
  }

  return result;
}

export type SettingsScope = "global" | "project";

export interface SettingsStorage {
  withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void;
}

export interface SettingsError {
  scope: SettingsScope;
  error: Error;
}

export class FileSettingsStorage implements SettingsStorage {
  private globalSettingsPath: string;
  private projectSettingsPath: string;

  constructor(cwd: string, agentDir: string) {
    this.globalSettingsPath = join(agentDir, "settings.json");
    this.projectSettingsPath = join(cwd, CONFIG_DIR_NAME, "settings.json");
  }

  private acquireLockSyncWithRetry(path: string): () => void {
    const maxAttempts = 10;
    const delayMs = 20;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return lockfile.lockSync(path, { realpath: false });
      } catch (error) {
        const code =
          typeof error === "object" && error !== null && "code" in error
            ? String((error as { code?: unknown }).code)
            : undefined;
        if (code !== "ELOCKED" || attempt === maxAttempts) {
          throw error;
        }
        lastError = error;
        const start = Date.now();
        while (Date.now() - start < delayMs) {
          // Sleep synchronously to avoid changing callers to async.
        }
      }
    }

    throw (lastError as Error) ?? new Error("Failed to acquire settings lock");
  }

  withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void {
    const path = scope === "global" ? this.globalSettingsPath : this.projectSettingsPath;
    const dir = dirname(path);

    let release: (() => void) | undefined;
    try {
      // Only create directory and lock if file exists or we need to write
      const fileExists = existsSync(path);
      if (fileExists) {
        release = this.acquireLockSyncWithRetry(path);
      }
      const current = fileExists ? readFileSync(path, "utf-8") : undefined;
      const next = fn(current);
      if (next !== undefined) {
        // Only create directory when we actually need to write
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }
        if (!release) {
          release = this.acquireLockSyncWithRetry(path);
        }
        writeFileSync(path, next, "utf-8");
      }
    } finally {
      if (release) {
        release();
      }
    }
  }
}

export class InMemorySettingsStorage implements SettingsStorage {
  private global: string | undefined;
  private project: string | undefined;

  withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void {
    const current = scope === "global" ? this.global : this.project;
    const next = fn(current);
    if (next !== undefined) {
      if (scope === "global") {
        this.global = next;
      } else {
        this.project = next;
      }
    }
  }
}

export class SettingsManager {
  private storage: SettingsStorage;
  private globalSettings: Settings;
  private projectSettings: Settings;
  private settings: Settings;
  private modifiedFields = new Set<keyof Settings>(); // Track global fields modified during session
  private modifiedNestedFields = new Map<keyof Settings, Set<string>>(); // Track global nested field modifications
  private modifiedProjectFields = new Set<keyof Settings>(); // Track project fields modified during session
  private modifiedProjectNestedFields = new Map<keyof Settings, Set<string>>(); // Track project nested field modifications
  private globalSettingsLoadError: Error | null = null; // Track if global settings file had parse errors
  private projectSettingsLoadError: Error | null = null; // Track if project settings file had parse errors
  private writeQueue: Promise<void> = Promise.resolve();
  private errors: SettingsError[];

  private constructor(
    storage: SettingsStorage,
    initialGlobal: Settings,
    initialProject: Settings,
    globalLoadError: Error | null = null,
    projectLoadError: Error | null = null,
    initialErrors: SettingsError[] = [],
  ) {
    this.storage = storage;
    this.globalSettings = initialGlobal;
    this.projectSettings = initialProject;
    this.globalSettingsLoadError = globalLoadError;
    this.projectSettingsLoadError = projectLoadError;
    this.errors = [...initialErrors];
    this.settings = deepMergeSettings(this.globalSettings, this.projectSettings);
  }

  /** Create a SettingsManager that loads from files */
  static create(cwd: string, agentDir: string = getAgentDir()): SettingsManager {
    const storage = new FileSettingsStorage(cwd, agentDir);
    return SettingsManager.fromStorage(storage);
  }

  /** Create a SettingsManager from an arbitrary storage backend */
  static fromStorage(storage: SettingsStorage): SettingsManager {
    const globalLoad = SettingsManager.tryLoadFromStorage(storage, "global");
    const projectLoad = SettingsManager.tryLoadFromStorage(storage, "project");
    const initialErrors: SettingsError[] = [];
    if (globalLoad.error) {
      initialErrors.push({ scope: "global", error: globalLoad.error });
    }
    if (projectLoad.error) {
      initialErrors.push({ scope: "project", error: projectLoad.error });
    }

    return new SettingsManager(
      storage,
      globalLoad.settings,
      projectLoad.settings,
      globalLoad.error,
      projectLoad.error,
      initialErrors,
    );
  }

  /** Create an in-memory SettingsManager (no file I/O) */
  static inMemory(settings: Partial<Settings> = {}): SettingsManager {
    const storage = new InMemorySettingsStorage();
    const initialSettings = SettingsManager.migrateSettings(
      structuredClone(settings) as Record<string, unknown>,
    );
    storage.withLock("global", () => JSON.stringify(initialSettings, null, 2));
    return SettingsManager.fromStorage(storage);
  }

  private static loadFromStorage(storage: SettingsStorage, scope: SettingsScope): Settings {
    let content: string | undefined;
    storage.withLock(scope, (current) => {
      content = current;
      return undefined;
    });

    if (!content) {
      return {};
    }
    const settings = JSON.parse(content);
    return SettingsManager.migrateSettings(settings);
  }

  private static tryLoadFromStorage(
    storage: SettingsStorage,
    scope: SettingsScope,
  ): { settings: Settings; error: Error | null } {
    try {
      return { settings: SettingsManager.loadFromStorage(storage, scope), error: null };
    } catch (error) {
      return { settings: {}, error: error as Error };
    }
  }

  /** Migrate old settings format to new format */
  private static migrateSettings(settings: Record<string, unknown>): Settings {
    // Migrate queueMode -> steeringMode
    if ("queueMode" in settings && !("steeringMode" in settings)) {
      settings.steeringMode = settings.queueMode;
      delete settings.queueMode;
    }

    // Migrate legacy websockets boolean -> transport enum
    if (!("transport" in settings) && typeof settings.websockets === "boolean") {
      settings.transport = settings.websockets ? "websocket" : "sse";
      delete settings.websockets;
    }

    // Migrate old skills object format to new array format
    if (
      "skills" in settings &&
      typeof settings.skills === "object" &&
      settings.skills !== null &&
      !Array.isArray(settings.skills)
    ) {
      const skillsSettings = settings.skills as {
        enableSkillCommands?: boolean;
        customDirectories?: unknown;
      };
      if (
        skillsSettings.enableSkillCommands !== undefined &&
        settings.enableSkillCommands === undefined
      ) {
        settings.enableSkillCommands = skillsSettings.enableSkillCommands;
      }
      if (
        Array.isArray(skillsSettings.customDirectories) &&
        skillsSettings.customDirectories.length > 0
      ) {
        settings.skills = skillsSettings.customDirectories;
      } else {
        delete settings.skills;
      }
    }

    // Migrate retry.maxDelayMs -> retry.provider.maxRetryDelayMs
    if (
      "retry" in settings &&
      typeof settings.retry === "object" &&
      settings.retry !== null &&
      !Array.isArray(settings.retry)
    ) {
      const retrySettings = settings.retry as Record<string, unknown>;
      const providerSettings =
        typeof retrySettings.provider === "object" && retrySettings.provider !== null
          ? (retrySettings.provider as Record<string, unknown>)
          : undefined;
      if (
        typeof retrySettings.maxDelayMs === "number" &&
        (providerSettings?.maxRetryDelayMs === undefined ||
          providerSettings?.maxRetryDelayMs === null)
      ) {
        retrySettings.provider = {
          ...providerSettings,
          maxRetryDelayMs: retrySettings.maxDelayMs,
        };
      }
      delete retrySettings.maxDelayMs;
    }

    return settings as Settings;
  }

  getGlobalSettings(): Settings {
    return structuredClone(this.globalSettings);
  }

  getProjectSettings(): Settings {
    return structuredClone(this.projectSettings);
  }

  async reload(): Promise<void> {
    await this.writeQueue;
    const globalLoad = SettingsManager.tryLoadFromStorage(this.storage, "global");
    if (!globalLoad.error) {
      this.globalSettings = globalLoad.settings;
      this.globalSettingsLoadError = null;
    } else {
      this.globalSettingsLoadError = globalLoad.error;
      this.recordError("global", globalLoad.error);
    }

    this.modifiedFields.clear();
    this.modifiedNestedFields.clear();
    this.modifiedProjectFields.clear();
    this.modifiedProjectNestedFields.clear();

    const projectLoad = SettingsManager.tryLoadFromStorage(this.storage, "project");
    if (!projectLoad.error) {
      this.projectSettings = projectLoad.settings;
      this.projectSettingsLoadError = null;
    } else {
      this.projectSettingsLoadError = projectLoad.error;
      this.recordError("project", projectLoad.error);
    }

    this.settings = deepMergeSettings(this.globalSettings, this.projectSettings);
  }

  /** Apply additional overrides on top of current settings */
  applyOverrides(overrides: Partial<Settings>): void {
    this.settings = deepMergeSettings(this.settings, overrides);
  }

  /** Mark a global field as modified during this session */
  private markModified(field: keyof Settings, nestedKey?: string): void {
    this.modifiedFields.add(field);
    if (nestedKey) {
      if (!this.modifiedNestedFields.has(field)) {
        this.modifiedNestedFields.set(field, new Set());
      }
      this.modifiedNestedFields.get(field)!.add(nestedKey);
    }
  }

  /** Mark a project field as modified during this session */
  private markProjectModified(field: keyof Settings, nestedKey?: string): void {
    this.modifiedProjectFields.add(field);
    if (nestedKey) {
      if (!this.modifiedProjectNestedFields.has(field)) {
        this.modifiedProjectNestedFields.set(field, new Set());
      }
      this.modifiedProjectNestedFields.get(field)!.add(nestedKey);
    }
  }

  private recordError(scope: SettingsScope, error: unknown): void {
    const normalizedError = error instanceof Error ? error : new Error(String(error));
    this.errors.push({ scope, error: normalizedError });
  }

  private clearModifiedScope(scope: SettingsScope): void {
    if (scope === "global") {
      this.modifiedFields.clear();
      this.modifiedNestedFields.clear();
      return;
    }

    this.modifiedProjectFields.clear();
    this.modifiedProjectNestedFields.clear();
  }

  private enqueueWrite(scope: SettingsScope, task: () => void): void {
    this.writeQueue = this.writeQueue
      .then(() => {
        task();
        this.clearModifiedScope(scope);
      })
      .catch((error) => {
        this.recordError(scope, error);
      });
  }

  private cloneModifiedNestedFields(
    source: Map<keyof Settings, Set<string>>,
  ): Map<keyof Settings, Set<string>> {
    const snapshot = new Map<keyof Settings, Set<string>>();
    for (const [key, value] of source.entries()) {
      snapshot.set(key, new Set(value));
    }
    return snapshot;
  }

  private persistScopedSettings(
    scope: SettingsScope,
    snapshotSettings: Settings,
    modifiedFields: Set<keyof Settings>,
    modifiedNestedFields: Map<keyof Settings, Set<string>>,
  ): void {
    this.storage.withLock(scope, (current) => {
      const currentFileSettings = current
        ? SettingsManager.migrateSettings(JSON.parse(current) as Record<string, unknown>)
        : {};
      const mergedSettings: Settings = { ...currentFileSettings };
      for (const field of modifiedFields) {
        const value = snapshotSettings[field];
        if (modifiedNestedFields.has(field) && typeof value === "object" && value !== null) {
          const nestedModified = modifiedNestedFields.get(field)!;
          const baseNested = (currentFileSettings[field] as Record<string, unknown>) ?? {};
          const inMemoryNested = value as Record<string, unknown>;
          const mergedNested = { ...baseNested };
          for (const nestedKey of nestedModified) {
            mergedNested[nestedKey] = inMemoryNested[nestedKey];
          }
          (mergedSettings as Record<string, unknown>)[field] = mergedNested;
        } else {
          (mergedSettings as Record<string, unknown>)[field] = value;
        }
      }

      return JSON.stringify(mergedSettings, null, 2);
    });
  }

  private save(): void {
    this.settings = deepMergeSettings(this.globalSettings, this.projectSettings);

    if (this.globalSettingsLoadError) {
      return;
    }

    const snapshotGlobalSettings = structuredClone(this.globalSettings);
    const modifiedFields = new Set(this.modifiedFields);
    const modifiedNestedFields = this.cloneModifiedNestedFields(this.modifiedNestedFields);

    this.enqueueWrite("global", () => {
      this.persistScopedSettings(
        "global",
        snapshotGlobalSettings,
        modifiedFields,
        modifiedNestedFields,
      );
    });
  }

  private saveProjectSettings(settings: Settings): void {
    this.projectSettings = structuredClone(settings);
    this.settings = deepMergeSettings(this.globalSettings, this.projectSettings);

    if (this.projectSettingsLoadError) {
      return;
    }

    const snapshotProjectSettings = structuredClone(this.projectSettings);
    const modifiedFields = new Set(this.modifiedProjectFields);
    const modifiedNestedFields = this.cloneModifiedNestedFields(this.modifiedProjectNestedFields);
    this.enqueueWrite("project", () => {
      this.persistScopedSettings(
        "project",
        snapshotProjectSettings,
        modifiedFields,
        modifiedNestedFields,
      );
    });
  }

  async flush(): Promise<void> {
    await this.writeQueue;
  }

  drainErrors(): SettingsError[] {
    const drained = [...this.errors];
    this.errors = [];
    return drained;
  }

  getLastChangelogVersion(): string | undefined {
    return this.settings.lastChangelogVersion;
  }

  setLastChangelogVersion(version: string): void {
    this.globalSettings.lastChangelogVersion = version;
    this.markModified("lastChangelogVersion");
    this.save();
  }

  getSessionDir(): string | undefined {
    const sessionDir = this.settings.sessionDir;
    if (!sessionDir) {
      return sessionDir;
    }
    if (sessionDir === "~") {
      return homedir();
    }
    if (sessionDir.startsWith("~/")) {
      return join(homedir(), sessionDir.slice(2));
    }
    return sessionDir;
  }

  getDefaultProvider(): string | undefined {
    return this.settings.defaultProvider;
  }

  getDefaultModel(): string | undefined {
    return this.settings.defaultModel;
  }

  setDefaultProvider(provider: string): void {
    this.globalSettings.defaultProvider = provider;
    this.markModified("defaultProvider");
    this.save();
  }

  setDefaultModel(modelId: string): void {
    this.globalSettings.defaultModel = modelId;
    this.markModified("defaultModel");
    this.save();
  }

  setDefaultModelAndProvider(provider: string, modelId: string): void {
    this.globalSettings.defaultProvider = provider;
    this.globalSettings.defaultModel = modelId;
    this.markModified("defaultProvider");
    this.markModified("defaultModel");
    this.save();
  }

  getSteeringMode(): "all" | "one-at-a-time" {
    return this.settings.steeringMode || "one-at-a-time";
  }

  setSteeringMode(mode: "all" | "one-at-a-time"): void {
    this.globalSettings.steeringMode = mode;
    this.markModified("steeringMode");
    this.save();
  }

  getFollowUpMode(): "all" | "one-at-a-time" {
    return this.settings.followUpMode || "one-at-a-time";
  }

  setFollowUpMode(mode: "all" | "one-at-a-time"): void {
    this.globalSettings.followUpMode = mode;
    this.markModified("followUpMode");
    this.save();
  }

  getTheme(): string | undefined {
    return this.settings.theme;
  }

  setTheme(theme: string): void {
    this.globalSettings.theme = theme;
    this.markModified("theme");
    this.save();
  }

  getDefaultThinkingLevel(): "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | undefined {
    return this.settings.defaultThinkingLevel;
  }

  setDefaultThinkingLevel(level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh"): void {
    this.globalSettings.defaultThinkingLevel = level;
    this.markModified("defaultThinkingLevel");
    this.save();
  }

  getTransport(): TransportSetting {
    return this.settings.transport ?? "auto";
  }

  setTransport(transport: TransportSetting): void {
    this.globalSettings.transport = transport;
    this.markModified("transport");
    this.save();
  }

  getCompactionEnabled(): boolean {
    return this.settings.compaction?.enabled ?? true;
  }

  setCompactionEnabled(enabled: boolean): void {
    if (!this.globalSettings.compaction) {
      this.globalSettings.compaction = {};
    }
    this.globalSettings.compaction.enabled = enabled;
    this.markModified("compaction", "enabled");
    this.save();
  }

  getCompactionReserveTokens(): number {
    return this.settings.compaction?.reserveTokens ?? 16384;
  }

  getCompactionKeepRecentTokens(): number {
    return this.settings.compaction?.keepRecentTokens ?? 20000;
  }

  getCompactionSettings(): { enabled: boolean; reserveTokens: number; keepRecentTokens: number } {
    return {
      enabled: this.getCompactionEnabled(),
      reserveTokens: this.getCompactionReserveTokens(),
      keepRecentTokens: this.getCompactionKeepRecentTokens(),
    };
  }

  getBranchSummarySettings(): { reserveTokens: number; skipPrompt: boolean } {
    return {
      reserveTokens: this.settings.branchSummary?.reserveTokens ?? 16384,
      skipPrompt: this.settings.branchSummary?.skipPrompt ?? false,
    };
  }

  getBranchSummarySkipPrompt(): boolean {
    return this.settings.branchSummary?.skipPrompt ?? false;
  }

  getRetryEnabled(): boolean {
    return this.settings.retry?.enabled ?? true;
  }

  setRetryEnabled(enabled: boolean): void {
    if (!this.globalSettings.retry) {
      this.globalSettings.retry = {};
    }
    this.globalSettings.retry.enabled = enabled;
    this.markModified("retry", "enabled");
    this.save();
  }

  getRetrySettings(): { enabled: boolean; maxRetries: number; baseDelayMs: number } {
    return {
      enabled: this.getRetryEnabled(),
      maxRetries: this.settings.retry?.maxRetries ?? 3,
      baseDelayMs: this.settings.retry?.baseDelayMs ?? 2000,
    };
  }

  getHttpIdleTimeoutMs(): number {
    const value = this.settings.httpIdleTimeoutMs;
    const timeoutMs = parseHttpIdleTimeoutMs(value);
    if (timeoutMs !== undefined) {
      return timeoutMs;
    }
    if (value !== undefined) {
      throw new Error(`Invalid httpIdleTimeoutMs setting: ${String(value)}`);
    }
    return DEFAULT_HTTP_IDLE_TIMEOUT_MS;
  }

  setHttpIdleTimeoutMs(timeoutMs: number): void {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
      throw new Error(`Invalid httpIdleTimeoutMs setting: ${String(timeoutMs)}`);
    }
    this.globalSettings.httpIdleTimeoutMs = Math.floor(timeoutMs);
    this.markModified("httpIdleTimeoutMs");
    this.save();
  }

  getProviderRetrySettings(): { timeoutMs?: number; maxRetries?: number; maxRetryDelayMs: number } {
    return {
      timeoutMs: this.settings.retry?.provider?.timeoutMs,
      maxRetries: this.settings.retry?.provider?.maxRetries,
      maxRetryDelayMs: this.settings.retry?.provider?.maxRetryDelayMs ?? 60000,
    };
  }

  getHideThinkingBlock(): boolean {
    return this.settings.hideThinkingBlock ?? false;
  }

  setHideThinkingBlock(hide: boolean): void {
    this.globalSettings.hideThinkingBlock = hide;
    this.markModified("hideThinkingBlock");
    this.save();
  }

  getShellPath(): string | undefined {
    return this.settings.shellPath;
  }

  setShellPath(path: string | undefined): void {
    this.globalSettings.shellPath = path;
    this.markModified("shellPath");
    this.save();
  }

  getQuietStartup(): boolean {
    return this.settings.quietStartup ?? false;
  }

  setQuietStartup(quiet: boolean): void {
    this.globalSettings.quietStartup = quiet;
    this.markModified("quietStartup");
    this.save();
  }

  getShellCommandPrefix(): string | undefined {
    return this.settings.shellCommandPrefix;
  }

  setShellCommandPrefix(prefix: string | undefined): void {
    this.globalSettings.shellCommandPrefix = prefix;
    this.markModified("shellCommandPrefix");
    this.save();
  }

  getNpmCommand(): string[] | undefined {
    return this.settings.npmCommand ? [...this.settings.npmCommand] : undefined;
  }

  setNpmCommand(command: string[] | undefined): void {
    this.globalSettings.npmCommand = command ? [...command] : undefined;
    this.markModified("npmCommand");
    this.save();
  }

  getCollapseChangelog(): boolean {
    return this.settings.collapseChangelog ?? false;
  }

  setCollapseChangelog(collapse: boolean): void {
    this.globalSettings.collapseChangelog = collapse;
    this.markModified("collapseChangelog");
    this.save();
  }

  getEnableInstallTelemetry(): boolean {
    return this.settings.enableInstallTelemetry ?? true;
  }

  setEnableInstallTelemetry(enabled: boolean): void {
    this.globalSettings.enableInstallTelemetry = enabled;
    this.markModified("enableInstallTelemetry");
    this.save();
  }

  getPackages(): PackageSource[] {
    return [...(this.settings.packages ?? [])];
  }

  setPackages(packages: PackageSource[]): void {
    this.globalSettings.packages = packages;
    this.markModified("packages");
    this.save();
  }

  setProjectPackages(packages: PackageSource[]): void {
    const projectSettings = structuredClone(this.projectSettings);
    projectSettings.packages = packages;
    this.markProjectModified("packages");
    this.saveProjectSettings(projectSettings);
  }

  getExtensionPaths(): string[] {
    return [...(this.settings.extensions ?? [])];
  }

  setExtensionPaths(paths: string[]): void {
    this.globalSettings.extensions = paths;
    this.markModified("extensions");
    this.save();
  }

  setProjectExtensionPaths(paths: string[]): void {
    const projectSettings = structuredClone(this.projectSettings);
    projectSettings.extensions = paths;
    this.markProjectModified("extensions");
    this.saveProjectSettings(projectSettings);
  }

  getSkillPaths(): string[] {
    return [...(this.settings.skills ?? [])];
  }

  setSkillPaths(paths: string[]): void {
    this.globalSettings.skills = paths;
    this.markModified("skills");
    this.save();
  }

  setProjectSkillPaths(paths: string[]): void {
    const projectSettings = structuredClone(this.projectSettings);
    projectSettings.skills = paths;
    this.markProjectModified("skills");
    this.saveProjectSettings(projectSettings);
  }

  getPromptTemplatePaths(): string[] {
    return [...(this.settings.prompts ?? [])];
  }

  setPromptTemplatePaths(paths: string[]): void {
    this.globalSettings.prompts = paths;
    this.markModified("prompts");
    this.save();
  }

  setProjectPromptTemplatePaths(paths: string[]): void {
    const projectSettings = structuredClone(this.projectSettings);
    projectSettings.prompts = paths;
    this.markProjectModified("prompts");
    this.saveProjectSettings(projectSettings);
  }

  getThemePaths(): string[] {
    return [...(this.settings.themes ?? [])];
  }

  setThemePaths(paths: string[]): void {
    this.globalSettings.themes = paths;
    this.markModified("themes");
    this.save();
  }

  setProjectThemePaths(paths: string[]): void {
    const projectSettings = structuredClone(this.projectSettings);
    projectSettings.themes = paths;
    this.markProjectModified("themes");
    this.saveProjectSettings(projectSettings);
  }

  getEnableSkillCommands(): boolean {
    return this.settings.enableSkillCommands ?? true;
  }

  setEnableSkillCommands(enabled: boolean): void {
    this.globalSettings.enableSkillCommands = enabled;
    this.markModified("enableSkillCommands");
    this.save();
  }

  getThinkingBudgets(): ThinkingBudgetsSettings | undefined {
    return this.settings.thinkingBudgets;
  }

  getShowImages(): boolean {
    return this.settings.terminal?.showImages ?? true;
  }

  setShowImages(show: boolean): void {
    if (!this.globalSettings.terminal) {
      this.globalSettings.terminal = {};
    }
    this.globalSettings.terminal.showImages = show;
    this.markModified("terminal", "showImages");
    this.save();
  }

  getImageWidthCells(): number {
    const width = this.settings.terminal?.imageWidthCells;
    if (typeof width !== "number" || !Number.isFinite(width)) {
      return 60;
    }
    return Math.max(1, Math.floor(width));
  }

  setImageWidthCells(width: number): void {
    if (!this.globalSettings.terminal) {
      this.globalSettings.terminal = {};
    }
    this.globalSettings.terminal.imageWidthCells = Math.max(1, Math.floor(width));
    this.markModified("terminal", "imageWidthCells");
    this.save();
  }

  getClearOnShrink(): boolean {
    // Settings takes precedence, then env var, then default false
    if (this.settings.terminal?.clearOnShrink !== undefined) {
      return this.settings.terminal.clearOnShrink;
    }
    return process.env.OPENCLAW_CLEAR_ON_SHRINK === "1";
  }

  setClearOnShrink(enabled: boolean): void {
    if (!this.globalSettings.terminal) {
      this.globalSettings.terminal = {};
    }
    this.globalSettings.terminal.clearOnShrink = enabled;
    this.markModified("terminal", "clearOnShrink");
    this.save();
  }

  getShowTerminalProgress(): boolean {
    return this.settings.terminal?.showTerminalProgress ?? false;
  }

  setShowTerminalProgress(enabled: boolean): void {
    if (!this.globalSettings.terminal) {
      this.globalSettings.terminal = {};
    }
    this.globalSettings.terminal.showTerminalProgress = enabled;
    this.markModified("terminal", "showTerminalProgress");
    this.save();
  }

  getImageAutoResize(): boolean {
    return this.settings.images?.autoResize ?? true;
  }

  setImageAutoResize(enabled: boolean): void {
    if (!this.globalSettings.images) {
      this.globalSettings.images = {};
    }
    this.globalSettings.images.autoResize = enabled;
    this.markModified("images", "autoResize");
    this.save();
  }

  getBlockImages(): boolean {
    return this.settings.images?.blockImages ?? false;
  }

  setBlockImages(blocked: boolean): void {
    if (!this.globalSettings.images) {
      this.globalSettings.images = {};
    }
    this.globalSettings.images.blockImages = blocked;
    this.markModified("images", "blockImages");
    this.save();
  }

  getEnabledModels(): string[] | undefined {
    return this.settings.enabledModels;
  }

  setEnabledModels(patterns: string[] | undefined): void {
    this.globalSettings.enabledModels = patterns;
    this.markModified("enabledModels");
    this.save();
  }

  getDoubleEscapeAction(): "fork" | "tree" | "none" {
    return this.settings.doubleEscapeAction ?? "tree";
  }

  setDoubleEscapeAction(action: "fork" | "tree" | "none"): void {
    this.globalSettings.doubleEscapeAction = action;
    this.markModified("doubleEscapeAction");
    this.save();
  }

  getTreeFilterMode(): "default" | "no-tools" | "user-only" | "labeled-only" | "all" {
    const mode = this.settings.treeFilterMode;
    const valid = ["default", "no-tools", "user-only", "labeled-only", "all"];
    return mode && valid.includes(mode) ? mode : "default";
  }

  setTreeFilterMode(mode: "default" | "no-tools" | "user-only" | "labeled-only" | "all"): void {
    this.globalSettings.treeFilterMode = mode;
    this.markModified("treeFilterMode");
    this.save();
  }

  getShowHardwareCursor(): boolean {
    return this.settings.showHardwareCursor ?? process.env.OPENCLAW_HARDWARE_CURSOR === "1";
  }

  setShowHardwareCursor(enabled: boolean): void {
    this.globalSettings.showHardwareCursor = enabled;
    this.markModified("showHardwareCursor");
    this.save();
  }

  getEditorPaddingX(): number {
    return this.settings.editorPaddingX ?? 0;
  }

  setEditorPaddingX(padding: number): void {
    this.globalSettings.editorPaddingX = Math.max(0, Math.min(3, Math.floor(padding)));
    this.markModified("editorPaddingX");
    this.save();
  }

  getAutocompleteMaxVisible(): number {
    return this.settings.autocompleteMaxVisible ?? 5;
  }

  setAutocompleteMaxVisible(maxVisible: number): void {
    this.globalSettings.autocompleteMaxVisible = Math.max(3, Math.min(20, Math.floor(maxVisible)));
    this.markModified("autocompleteMaxVisible");
    this.save();
  }

  getCodeBlockIndent(): string {
    return this.settings.markdown?.codeBlockIndent ?? "  ";
  }

  getWarnings(): WarningSettings {
    return { ...this.settings.warnings };
  }

  setWarnings(warnings: WarningSettings): void {
    this.globalSettings.warnings = { ...warnings };
    this.markModified("warnings");
    this.save();
  }
}
