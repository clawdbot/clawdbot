/**
 * Session settings manager.
 *
 * Loads and persists user/session defaults for models, transports, retry policy, UI, packages, and telemetry.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveIntegerOption } from "@openclaw/normalization-core/number-coercion";
import { asOptionalObjectRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
import { mergeDeep } from "../../infra/deep-merge.js";
import { getAgentDir } from "../config.js";
import { DEFAULT_HTTP_IDLE_TIMEOUT_MS, parseHttpIdleTimeoutMs } from "./http-dispatcher.js";
import {
  FileSettingsStorage,
  InMemorySettingsStorage,
  SETTINGS_SCOPES,
  type PackageSource,
  type Settings,
  type SettingsError,
  type SettingsScope,
  type SettingsStorage,
  type ThinkingBudgetsSettings,
  type TransportSetting,
  type WarningSettings,
} from "./settings-storage.js";

export { FileSettingsStorage, InMemorySettingsStorage } from "./settings-storage.js";
export type {
  BranchSummarySettings,
  ImageSettings,
  MarkdownSettings,
  PackageSource,
  ProviderRetrySettings,
  RetrySettings,
  Settings,
  SettingsError,
  SettingsScope,
  SettingsStorage,
  TerminalSettings,
  ThinkingBudgetsSettings,
  TransportSetting,
  WarningSettings,
} from "./settings-storage.js";

/** Deep merge settings: project/overrides take precedence, nested objects merge recursively */
function deepMergeSettings(base: Settings, overrides: Settings): Settings {
  return mergeDeep(base, overrides) as Settings;
}

interface SettingsScopeState {
  settings: Settings;
  modified: Map<keyof Settings, Set<string> | null>;
  loadError: Error | null;
}

export class SettingsManager {
  private settings: Settings = {};
  // Non-persisted overrides layered above global/project settings for this manager.
  private runtimeOverrides: Settings = {};
  private writeQueue: Promise<void> = Promise.resolve();
  private errors: SettingsError[];

  private constructor(
    private storage: SettingsStorage,
    private scopes: Record<SettingsScope, SettingsScopeState>,
  ) {
    this.errors = SETTINGS_SCOPES.flatMap((scope) => {
      const error = scopes[scope].loadError;
      return error ? [{ scope, error }] : [];
    });
    this.recomputeSettings();
  }

  /** Create a SettingsManager that loads from files */
  static create(cwd: string, agentDir: string = getAgentDir()): SettingsManager {
    const storage = new FileSettingsStorage(cwd, agentDir);
    return SettingsManager.fromStorage(storage);
  }

  /** Create a SettingsManager from an arbitrary storage backend */
  static fromStorage(storage: SettingsStorage): SettingsManager {
    return new SettingsManager(storage, {
      global: SettingsManager.loadScope(storage, "global"),
      project: SettingsManager.loadScope(storage, "project"),
    });
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

  private static loadScope(storage: SettingsStorage, scope: SettingsScope): SettingsScopeState {
    let content: string | undefined;
    try {
      storage.withLock(scope, (current) => {
        content = current;
        return undefined;
      });
      const settings = content
        ? SettingsManager.migrateSettings(JSON.parse(content) as Record<string, unknown>)
        : {};
      return SettingsManager.createScopeState(settings);
    } catch (error) {
      return SettingsManager.createScopeState({}, error as Error);
    }
  }

  private static createScopeState(
    settings: Settings,
    loadError: Error | null = null,
  ): SettingsScopeState {
    return {
      settings,
      modified: new Map(),
      loadError,
    };
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
    if (isRecord(settings.skills)) {
      const skillsSettings = settings.skills;
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
    if (isRecord(settings.retry)) {
      const retrySettings = settings.retry;
      const providerSettings = asOptionalObjectRecord(retrySettings.provider);
      if (
        typeof retrySettings.maxDelayMs === "number" &&
        providerSettings?.maxRetryDelayMs == null
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
    return structuredClone(this.scopes.global.settings);
  }

  getProjectSettings(): Settings {
    return structuredClone(this.scopes.project.settings);
  }

  private recomputeSettings(): void {
    this.settings = deepMergeSettings(
      deepMergeSettings(this.scopes.global.settings, this.scopes.project.settings),
      this.runtimeOverrides,
    );
  }

  async reload(): Promise<void> {
    await this.writeQueue;
    for (const scope of SETTINGS_SCOPES) {
      const state = this.scopes[scope];
      const loaded = SettingsManager.loadScope(this.storage, scope);
      if (loaded.loadError) {
        state.loadError = loaded.loadError;
        this.recordError(scope, loaded.loadError);
      } else {
        state.settings = loaded.settings;
        state.loadError = null;
      }
      state.modified.clear();
    }

    this.recomputeSettings();
  }

  /** Apply non-persisted overrides on top of global/project settings. */
  applyOverrides(overrides: Partial<Settings>): void {
    this.runtimeOverrides = deepMergeSettings(this.runtimeOverrides, overrides);
    this.recomputeSettings();
  }

  private markModified(scope: SettingsScope, field: keyof Settings, nestedKey?: string): void {
    const state = this.scopes[scope];
    const existing = state.modified.get(field);
    if (!nestedKey || existing === null) {
      state.modified.set(field, null);
      return;
    }
    const nestedFields = existing ?? new Set<string>();
    nestedFields.add(nestedKey);
    state.modified.set(field, nestedFields);
  }

  private recordError(scope: SettingsScope, error: unknown): void {
    const normalizedError = error instanceof Error ? error : new Error(String(error));
    this.errors.push({ scope, error: normalizedError });
  }

  private enqueueWrite(scope: SettingsScope, task: () => void): void {
    this.writeQueue = this.writeQueue
      .then(() => {
        task();
        this.scopes[scope].modified.clear();
      })
      .catch((error: unknown) => {
        this.recordError(scope, error);
      });
  }

  private persistScopedSettings(
    scope: SettingsScope,
    snapshotSettings: Settings,
    modified: Map<keyof Settings, Set<string> | null>,
  ): void {
    this.storage.withLock(scope, (current) => {
      const currentFileSettings = current
        ? SettingsManager.migrateSettings(JSON.parse(current) as Record<string, unknown>)
        : {};
      const mergedSettings: Settings = { ...currentFileSettings };
      for (const [field, nestedModified] of modified) {
        const value = snapshotSettings[field];
        if (nestedModified && typeof value === "object" && value !== null) {
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

  private save(scope: SettingsScope): void {
    this.recomputeSettings();
    const state = this.scopes[scope];
    if (state.loadError) {
      return;
    }
    const snapshotSettings = structuredClone(state.settings);
    const modified = new Map(
      [...state.modified].map(([field, nested]) => [field, nested && new Set(nested)]),
    );
    this.enqueueWrite(scope, () => {
      this.persistScopedSettings(scope, snapshotSettings, modified);
    });
  }

  private setScopedSetting<K extends keyof Settings>(
    scope: SettingsScope,
    field: K,
    value: Settings[K],
  ): void {
    this.scopes[scope].settings[field] = scope === "project" ? structuredClone(value) : value;
    this.markModified(scope, field);
    this.save(scope);
  }

  private setGlobalNestedSetting(
    field: "compaction" | "images" | "retry" | "terminal",
    nestedField: string,
    value: unknown,
  ): void {
    const current = this.scopes.global.settings[field];
    const nested = isRecord(current) ? { ...current } : {};
    nested[nestedField] = value;
    (this.scopes.global.settings as Record<string, unknown>)[field] = nested;
    this.markModified("global", field, nestedField);
    this.save("global");
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
    this.setScopedSetting("global", "lastChangelogVersion", version);
  }

  getSessionDir(): string | undefined {
    const sessionDir = this.settings.sessionDir;
    if (!sessionDir) {
      return sessionDir;
    }
    return sessionDir === "~"
      ? homedir()
      : sessionDir.startsWith("~/")
        ? join(homedir(), sessionDir.slice(2))
        : sessionDir;
  }

  getDefaultProvider(): string | undefined {
    return this.settings.defaultProvider;
  }

  getDefaultModel(): string | undefined {
    return this.settings.defaultModel;
  }

  setDefaultProvider(provider: string): void {
    this.setScopedSetting("global", "defaultProvider", provider);
  }

  setDefaultModel(modelId: string): void {
    this.setScopedSetting("global", "defaultModel", modelId);
  }

  setDefaultModelAndProvider(provider: string, modelId: string): void {
    this.scopes.global.settings.defaultProvider = provider;
    this.scopes.global.settings.defaultModel = modelId;
    this.markModified("global", "defaultProvider");
    this.markModified("global", "defaultModel");
    this.save("global");
  }

  getSteeringMode(): "all" | "one-at-a-time" {
    return this.settings.steeringMode || "one-at-a-time";
  }

  setSteeringMode(mode: "all" | "one-at-a-time"): void {
    this.setScopedSetting("global", "steeringMode", mode);
  }

  getFollowUpMode(): "all" | "one-at-a-time" {
    return this.settings.followUpMode || "one-at-a-time";
  }

  setFollowUpMode(mode: "all" | "one-at-a-time"): void {
    this.setScopedSetting("global", "followUpMode", mode);
  }

  getTheme(): string | undefined {
    return this.settings.theme;
  }

  setTheme(theme: string): void {
    this.setScopedSetting("global", "theme", theme);
  }

  getDefaultThinkingLevel(): Settings["defaultThinkingLevel"] {
    return this.settings.defaultThinkingLevel;
  }

  setDefaultThinkingLevel(level: NonNullable<Settings["defaultThinkingLevel"]>): void {
    this.setScopedSetting("global", "defaultThinkingLevel", level);
  }

  getTransport(): TransportSetting {
    return this.settings.transport ?? "auto";
  }

  setTransport(transport: TransportSetting): void {
    this.setScopedSetting("global", "transport", transport);
  }

  getCompactionEnabled(): boolean {
    return this.settings.compaction?.enabled ?? true;
  }

  setCompactionEnabled(enabled: boolean): void {
    this.setGlobalNestedSetting("compaction", "enabled", enabled);
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
    this.setGlobalNestedSetting("retry", "enabled", enabled);
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
    this.setScopedSetting("global", "httpIdleTimeoutMs", Math.floor(timeoutMs));
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
    this.setScopedSetting("global", "hideThinkingBlock", hide);
  }

  getShellPath(): string | undefined {
    return this.settings.shellPath;
  }

  setShellPath(path: string | undefined): void {
    this.setScopedSetting("global", "shellPath", path);
  }

  getQuietStartup(): boolean {
    return this.settings.quietStartup ?? false;
  }

  setQuietStartup(quiet: boolean): void {
    this.setScopedSetting("global", "quietStartup", quiet);
  }

  getShellCommandPrefix(): string | undefined {
    return this.settings.shellCommandPrefix;
  }

  setShellCommandPrefix(prefix: string | undefined): void {
    this.setScopedSetting("global", "shellCommandPrefix", prefix);
  }

  getNpmCommand(): string[] | undefined {
    return this.settings.npmCommand ? [...this.settings.npmCommand] : undefined;
  }

  setNpmCommand(command: string[] | undefined): void {
    this.setScopedSetting("global", "npmCommand", command ? [...command] : undefined);
  }

  getCollapseChangelog(): boolean {
    return this.settings.collapseChangelog ?? false;
  }

  setCollapseChangelog(collapse: boolean): void {
    this.setScopedSetting("global", "collapseChangelog", collapse);
  }

  getEnableInstallTelemetry(): boolean {
    return this.settings.enableInstallTelemetry ?? true;
  }

  setEnableInstallTelemetry(enabled: boolean): void {
    this.setScopedSetting("global", "enableInstallTelemetry", enabled);
  }

  getPackages(): PackageSource[] {
    return [...(this.settings.packages ?? [])];
  }

  setPackages(packages: PackageSource[]): void {
    this.setScopedSetting("global", "packages", packages);
  }

  setProjectPackages(packages: PackageSource[]): void {
    this.setScopedSetting("project", "packages", packages);
  }

  getExtensionPaths(): string[] {
    return [...(this.settings.extensions ?? [])];
  }

  setExtensionPaths(paths: string[]): void {
    this.setScopedSetting("global", "extensions", paths);
  }

  setProjectExtensionPaths(paths: string[]): void {
    this.setScopedSetting("project", "extensions", paths);
  }

  getSkillPaths(): string[] {
    return [...(this.settings.skills ?? [])];
  }

  setSkillPaths(paths: string[]): void {
    this.setScopedSetting("global", "skills", paths);
  }

  setProjectSkillPaths(paths: string[]): void {
    this.setScopedSetting("project", "skills", paths);
  }

  getPromptTemplatePaths(): string[] {
    return [...(this.settings.prompts ?? [])];
  }

  setPromptTemplatePaths(paths: string[]): void {
    this.setScopedSetting("global", "prompts", paths);
  }

  setProjectPromptTemplatePaths(paths: string[]): void {
    this.setScopedSetting("project", "prompts", paths);
  }

  getThemePaths(): string[] {
    return [...(this.settings.themes ?? [])];
  }

  setThemePaths(paths: string[]): void {
    this.setScopedSetting("global", "themes", paths);
  }

  setProjectThemePaths(paths: string[]): void {
    this.setScopedSetting("project", "themes", paths);
  }

  getEnableSkillCommands(): boolean {
    return this.settings.enableSkillCommands ?? true;
  }

  setEnableSkillCommands(enabled: boolean): void {
    this.setScopedSetting("global", "enableSkillCommands", enabled);
  }

  getThinkingBudgets(): ThinkingBudgetsSettings | undefined {
    return this.settings.thinkingBudgets;
  }

  getShowImages(): boolean {
    return this.settings.terminal?.showImages ?? true;
  }

  setShowImages(show: boolean): void {
    this.setGlobalNestedSetting("terminal", "showImages", show);
  }

  getImageWidthCells(): number {
    return resolveIntegerOption(this.settings.terminal?.imageWidthCells, 60, { min: 1 });
  }

  setImageWidthCells(width: number): void {
    this.setGlobalNestedSetting("terminal", "imageWidthCells", Math.max(1, Math.floor(width)));
  }

  getClearOnShrink(): boolean {
    return this.settings.terminal?.clearOnShrink ?? false;
  }

  setClearOnShrink(enabled: boolean): void {
    this.setGlobalNestedSetting("terminal", "clearOnShrink", enabled);
  }

  getShowTerminalProgress(): boolean {
    return this.settings.terminal?.showTerminalProgress ?? false;
  }

  setShowTerminalProgress(enabled: boolean): void {
    this.setGlobalNestedSetting("terminal", "showTerminalProgress", enabled);
  }

  getImageAutoResize(): boolean {
    return this.settings.images?.autoResize ?? true;
  }

  setImageAutoResize(enabled: boolean): void {
    this.setGlobalNestedSetting("images", "autoResize", enabled);
  }

  getBlockImages(): boolean {
    return this.settings.images?.blockImages ?? false;
  }

  setBlockImages(blocked: boolean): void {
    this.setGlobalNestedSetting("images", "blockImages", blocked);
  }

  getEnabledModels(): string[] | undefined {
    return this.settings.enabledModels;
  }

  setEnabledModels(patterns: string[] | undefined): void {
    this.setScopedSetting("global", "enabledModels", patterns);
  }

  getDoubleEscapeAction(): "fork" | "tree" | "none" {
    return this.settings.doubleEscapeAction ?? "tree";
  }

  setDoubleEscapeAction(action: "fork" | "tree" | "none"): void {
    this.setScopedSetting("global", "doubleEscapeAction", action);
  }

  getTreeFilterMode(): "default" | "no-tools" | "user-only" | "labeled-only" | "all" {
    const mode = this.settings.treeFilterMode;
    const valid = ["default", "no-tools", "user-only", "labeled-only", "all"];
    return mode && valid.includes(mode) ? mode : "default";
  }

  setTreeFilterMode(mode: "default" | "no-tools" | "user-only" | "labeled-only" | "all"): void {
    this.setScopedSetting("global", "treeFilterMode", mode);
  }

  getShowHardwareCursor(): boolean {
    return this.settings.showHardwareCursor ?? false;
  }

  setShowHardwareCursor(enabled: boolean): void {
    this.setScopedSetting("global", "showHardwareCursor", enabled);
  }

  getEditorPaddingX(): number {
    return this.settings.editorPaddingX ?? 0;
  }

  setEditorPaddingX(padding: number): void {
    this.setScopedSetting(
      "global",
      "editorPaddingX",
      Math.max(0, Math.min(3, Math.floor(padding))),
    );
  }

  getAutocompleteMaxVisible(): number {
    return this.settings.autocompleteMaxVisible ?? 5;
  }

  setAutocompleteMaxVisible(maxVisible: number): void {
    this.setScopedSetting(
      "global",
      "autocompleteMaxVisible",
      Math.max(3, Math.min(20, Math.floor(maxVisible))),
    );
  }

  getCodeBlockIndent(): string {
    return this.settings.markdown?.codeBlockIndent ?? "  ";
  }

  getWarnings(): WarningSettings {
    return { ...this.settings.warnings };
  }

  setWarnings(warnings: WarningSettings): void {
    this.setScopedSetting("global", "warnings", { ...warnings });
  }
}
