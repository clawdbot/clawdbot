// Loads, validates, migrates, snapshots, and writes OpenClaw config files.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { collectManifestModelIdNormalizationPolicies } from "@openclaw/model-catalog-core/provider-model-id-normalization";
import JSON5 from "json5";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope-config.js";
import { ensureOwnerDisplaySecret } from "../agents/owner-display.js";
import { isVerbose } from "../global-state.js";
import { loadDotEnv } from "../infra/dotenv.js";
import { isTruthyEnvValue } from "../infra/env.js";
import {
  collectErrorGraphCandidates,
  extractErrorCode,
  formatErrorMessage,
} from "../infra/errors.js";
import { resolveRequiredHomeDir } from "../infra/home-dir.js";
import { replaceFileAtomic, replaceFileAtomicSync } from "../infra/replace-file.js";
import {
  loadShellEnvFallback,
  resolveShellEnvFallbackTimeoutMs,
  shouldDeferShellEnvFallback,
  shouldEnableShellEnvFallback,
} from "../infra/shell-env.js";
import { createConfigValidationMetadataPluginIdScope } from "../plugins/gateway-startup-plugin-ids.js";
import {
  loadInstalledPluginIndexInstallRecordsSync,
  writePersistedInstalledPluginIndexInstallRecordsSync,
} from "../plugins/installed-plugin-index-records.js";
import {
  resolvePluginMetadataSnapshot,
  type PluginMetadataSnapshot,
} from "../plugins/plugin-metadata-snapshot.js";
import { isRecord } from "../utils.js";
import { VERSION } from "../version.js";
import { DuplicateAgentDirError, findDuplicateAgentDirs } from "./agent-dirs.js";
import { maintainConfigBackups } from "./backup-rotation.js";
import { EnvRefArrayMutationError, restoreEnvVarRefs } from "./env-preserve.js";
import {
  type EnvSubstitutionWarning,
  containsEnvVarReference,
  resolveConfigEnvVars,
} from "./env-substitution.js";
import { applyConfigEnvVars, cloneEnvWithPlatformSemantics } from "./env-vars.js";
import {
  ConfigIncludeError,
  hashConfigIncludeRaw,
  INCLUDE_KEY,
  readConfigIncludeFileWithGuards,
  resolveConfigIncludeWritePath,
  resolveConfigIncludes,
} from "./includes.js";
import {
  appendConfigAuditRecord,
  appendConfigAuditRecordSync,
  createConfigWriteAuditRecordBase,
  finalizeConfigWriteAuditRecord,
  formatConfigOverwriteLogMessage,
  snapshotConfigAuditProcessInfo,
  type ConfigWriteAuditResult,
} from "./io.audit.js";
import { persistBoundedClobberedConfigSnapshot } from "./io.clobber-snapshot.js";
import {
  readConfigHealthStateFromStore,
  writeConfigHealthStateToStore,
  type ConfigHealthEntry,
  type ConfigHealthFingerprint,
  type ConfigHealthState,
} from "./io.health-state.js";
import { throwInvalidConfig } from "./io.invalid-config.js";
import { stampConfigWriteMetadata } from "./io.meta.js";
import {
  maybeRecoverSuspiciousConfigRead as maybeRecoverSuspiciousConfigReadWithDeps,
  maybeRecoverSuspiciousConfigReadSync as maybeRecoverSuspiciousConfigReadSyncWithDeps,
  promoteConfigSnapshotToLastKnownGood as promoteConfigSnapshotToLastKnownGoodWithDeps,
  recoverConfigFromLastKnownGood as recoverConfigFromLastKnownGoodWithDeps,
} from "./io.observe-recovery.js";
import { resolveConfigObserveSuspiciousReasons } from "./io.observe-suspicious.js";
import { retainGeneratedOwnerDisplaySecret } from "./io.owner-display-secret.js";
import {
  collectChangedPaths,
  createMergePatch,
  formatConfigValidationFailure,
  applyUnsetPathsForWrite,
  preserveIncludeOwnedConfigForWrite,
  restoreEnvRefsFromMap,
  resolvePersistCandidateForWrite,
  resolveManagedUnsetPathsForWrite,
  resolveWriteEnvSnapshotForPath,
} from "./io.write-prepare.js";
import {
  asResolvedSourceConfig,
  asRuntimeConfig,
  materializeRuntimeConfig,
} from "./materialize.js";
import { applyMergePatch } from "./merge-patch.js";
import { ConfigMutationConflictError } from "./mutation-conflict.js";
import { assertConfigWriteAllowedInCurrentMode } from "./nix-mode-write-guard.js";
import { resolveConfigPath, resolveIncludeRoots, resolveStateDir } from "./paths.js";
import {
  extractShippedPluginInstallConfigRecords,
  stripShippedPluginInstallConfigRecords,
} from "./plugin-install-config-migration.js";
import { applyConfigOverrides } from "./runtime-overrides.js";
import {
  clearRuntimeConfigSnapshot as clearRuntimeConfigSnapshotState,
  createRuntimeConfigWriteNotification,
  finalizeRuntimeSnapshotWrite,
  getRuntimeConfigSnapshotMetadata as getRuntimeConfigSnapshotMetadataState,
  getRuntimeConfigSnapshot as getRuntimeConfigSnapshotState,
  getRuntimeConfigSourceSnapshot as getRuntimeConfigSourceSnapshotState,
  loadPinnedRuntimeConfig,
  notifyRuntimeConfigWriteListeners,
  preflightRuntimeSnapshotWrite,
  registerRuntimeConfigWriteListener,
  resetConfigRuntimeState as resetConfigRuntimeStateState,
  resolveRuntimeConfigCacheKey,
  selectApplicableRuntimeConfig,
  setRuntimeConfigSnapshot as setRuntimeConfigSnapshotState,
  getRuntimeConfigSnapshotRefreshHandler as getRuntimeConfigSnapshotRefreshHandlerState,
  setRuntimeConfigSnapshotRefreshHandler as setRuntimeConfigSnapshotRefreshHandlerState,
  type ConfigWriteAfterWrite,
  type RuntimeConfigSnapshotRefreshOptions,
  type RuntimeConfigWriteNotification,
} from "./runtime-snapshot.js";
export { projectConfigOntoRuntimeSourceSnapshot } from "./runtime-source-projection.js";
import { resolveShellEnvExpectedKeys } from "./shell-env-expected-keys.js";
import type { OpenClawConfig, ConfigFileSnapshot, LegacyConfigIssue } from "./types.js";
import {
  validateConfigObjectRawWithPlugins,
  validateConfigObjectWithPlugins,
} from "./validation.js";
import { shouldWarnOnTouchedVersion } from "./version.js";

export {
  clearRuntimeConfigSnapshotState as clearRuntimeConfigSnapshot,
  getRuntimeConfigSnapshotMetadataState as getRuntimeConfigSnapshotMetadata,
  getRuntimeConfigSnapshotState as getRuntimeConfigSnapshot,
  getRuntimeConfigSourceSnapshotState as getRuntimeConfigSourceSnapshot,
  resetConfigRuntimeStateState as resetConfigRuntimeState,
  resolveRuntimeConfigCacheKey,
  selectApplicableRuntimeConfig,
  setRuntimeConfigSnapshotState as setRuntimeConfigSnapshot,
  setRuntimeConfigSnapshotRefreshHandlerState as setRuntimeConfigSnapshotRefreshHandler,
};

// Re-export for backwards compatibility
export { CircularIncludeError, ConfigIncludeError } from "./includes.js";
export { MissingEnvVarError } from "./env-substitution.js";
export { resolveShellEnvExpectedKeys } from "./shell-env-expected-keys.js";

type ShippedPluginInstallConfigWriteMigration =
  | {
      migrated: false;
    }
  | {
      migrated: true;
    };

type ShippedPluginInstallConfigReadMigration = {
  config: unknown;
  validationConfig?: unknown;
  persistedRootParsed?: unknown;
  persistedRootRaw?: string;
};

const loggedInvalidConfigs = new Set<string>();
const loggedConfigWarningFingerprints = new Map<string, string>();
const warnedFutureTouchedVersions = new Set<string>();

export type ParseConfigJson5Result = { ok: true; parsed: unknown } | { ok: false; error: string };
export type ConfigWriteResult = { persistedHash: string; persistedConfig: OpenClawConfig };
const configWritePostCommitRollback = Symbol("configWritePostCommitRollback");
type InternalConfigWriteResult = ConfigWriteResult & {
  [configWritePostCommitRollback]?: () => void;
};
export type ConfigWriteOptions = {
  /**
   * Read-time env snapshot used to validate `${VAR}` restoration decisions.
   * If omitted, write falls back to current process env.
   */
  envSnapshotForRestore?: Record<string, string | undefined>;
  /**
   * Optional safety check: only use envSnapshotForRestore when writing the
   * same config file path that produced the snapshot.
   */
  expectedConfigPath?: string;
  /** Internal write destination captured by readConfigFileSnapshotForWrite(). */
  ownedConfigPathForWrite?: string;
  /**
   * Internal mutation-start ownership guard. Rechecks that the config path
   * captured by readConfigFileSnapshotForWrite() is still active at commit.
   */
  assertConfigPathForWrite?: () => void;
  /**
   * Paths that must be explicitly removed from the persisted file payload,
   * even if schema/default normalization reintroduces them.
   */
  unsetPaths?: string[][];
  /**
   * Paths that were explicitly set by the caller. Values at these paths are
   * persisted even when they equal runtime-injected defaults.
   */
  explicitSetPaths?: readonly (readonly string[])[];
  /**
   * Internal companion for explicitSetPaths after a wrapper has projected a
   * runtime-shaped config back onto the authored source shape.
   */
  explicitSetValueSource?: OpenClawConfig;
  /**
   * Internal fast path for callers that already hold a fresh config snapshot.
   * Avoids rereading the full config just to prepare an immediate write.
   */
  baseSnapshot?: ConfigFileSnapshot;
  /**
   * Plugin metadata paired with baseSnapshot when the caller already read it.
   */
  basePluginMetadataSnapshot?: PluginMetadataSnapshot;
  /**
   * Internal one-shot CLI fast path. When no runtime snapshot is active, skip
   * the post-write runtime snapshot refresh/reload tail entirely.
   */
  skipRuntimeSnapshotRefresh?: boolean;
  /**
   * Optional controls for the active runtime snapshot refresh after this write.
   */
  runtimeRefresh?: RuntimeConfigSnapshotRefreshOptions;
  /**
   * Allow intentionally destructive config writes, such as explicit reset flows.
   * Normal writers must keep this false so clobbers are rejected before disk commit.
   */
  allowDestructiveWrite?: boolean;
  /**
   * Allow an intentional large config size drop while keeping other destructive
   * guards active. Used by repair flows that remove stale or legacy config.
   */
  allowConfigSizeDrop?: boolean;
  /**
   * Suppress human-readable output logs (overwrite/anomaly messages).
   * Useful when the caller wants machine-readable output only (--json mode).
   */
  skipOutputLogs?: boolean;
  /**
   * Runtime reload intent for observers that react to committed config writes.
   * Omitted means the observer should use its normal reload plan.
   */
  afterWrite?: ConfigWriteAfterWrite;
  /**
   * Legacy root keys to preserve on disk while excluding them from write validation.
   * This is for doctor repair of historical config metadata that should not become
   * part of the public schema contract again.
   */
  preservedLegacyRootKeys?: readonly string[];
  /**
   * Skip plugin-aware validation before writing. Use only for safe partial
   * migrations (e.g. legacy key removal) where the base schema is valid but
   * an unrelated plugin rule prevents the full write from succeeding.
   */
  skipPluginValidation?: boolean;
  /**
   * Preserve an older writer version for update handoff writes that must be
   * readable by the parent process after a candidate doctor repair.
   */
  lastTouchedVersionOverride?: string;
  /**
   * Internal hook used by the exported runtime-aware writer after validation
   * has produced the exact source config that will be committed.
   */
  preCommitRuntimePreflight?: (sourceConfig: OpenClawConfig) => Promise<unknown>;
  /** Internal snapshot-time hashes for include files that mutation writers may update directly. */
  includeFileHashesForWrite?: Record<string, string>;
  /** Internal snapshot-time canonical targets for include files that mutation writers may update. */
  includeFileTargetsForWrite?: Record<string, string>;
};

export type ReadConfigFileSnapshotForWriteResult = {
  snapshot: ConfigFileSnapshot;
  writeOptions: ConfigWriteOptions;
};

export type ConfigWriteNotification = RuntimeConfigWriteNotification;
export type ConfigSnapshotReadMeasure = <T>(name: string, run: () => T | Promise<T>) => Promise<T>;

export class ConfigRuntimeRefreshError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ConfigRuntimeRefreshError";
  }
}

function hashConfigRaw(raw: string | null): string {
  // Present-file hashes stay compatible with last-known-good recovery metadata.
  // Missing needs a distinct token so optimistic writes reject missing-to-empty races.
  if (raw === null) {
    return hashConfigIncludeRaw(null);
  }
  return crypto.createHash("sha256").update(raw).digest("hex");
}

function assertBaseSnapshotStillCurrent(
  snapshot: ConfigFileSnapshot,
  configPath: string,
  ioFs: typeof fs,
): void {
  if (snapshot.path !== configPath) {
    throw new ConfigMutationConflictError("config path changed since last load", {
      currentHash: null,
      retryable: false,
    });
  }
  // Unreadable snapshots cannot be re-read for freshness; the write guard rejects
  // them before commit unless the caller explicitly requests a destructive write.
  if (snapshot.readError) {
    return;
  }
  const expectedHash = resolveConfigSnapshotHash(snapshot);
  let currentRaw: string | null = null;
  let currentExists = true;
  try {
    currentRaw = ioFs.readFileSync(configPath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      throw error;
    }
    currentExists = false;
  }
  const currentHash = currentExists ? hashConfigRaw(currentRaw) : null;
  if (
    currentExists !== snapshot.exists ||
    (currentExists && expectedHash !== null && currentHash !== expectedHash)
  ) {
    throw new ConfigMutationConflictError("config changed since last load", { currentHash });
  }
}

async function tightenStateDirPermissionsIfNeeded(params: {
  configPath: string;
  env: NodeJS.ProcessEnv;
  homedir: () => string;
  fsModule: typeof fs;
}): Promise<void> {
  if (process.platform === "win32") {
    return;
  }
  const stateDir = resolveStateDir(params.env, params.homedir);
  const configDir = path.dirname(params.configPath);
  if (path.resolve(configDir) !== path.resolve(stateDir)) {
    return;
  }
  try {
    const stat = await params.fsModule.promises.stat(configDir);
    const mode = stat.mode & 0o777;
    if ((mode & 0o077) === 0) {
      return;
    }
    await params.fsModule.promises.chmod(configDir, 0o700);
  } catch {
    // Best-effort hardening only; callers still need the config write to proceed.
  }
}

export function resolveConfigSnapshotHash(snapshot: {
  hash?: string;
  raw?: string | null;
}): string | null {
  if (typeof snapshot.hash === "string") {
    const trimmed = snapshot.hash.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  if (typeof snapshot.raw !== "string") {
    return null;
  }
  return hashConfigRaw(snapshot.raw);
}

async function rollbackConfigFileWriteIfUnchanged(params: {
  configPath: string;
  previousSnapshot: ConfigFileSnapshot;
  committedHash: string;
  fsModule: typeof fs;
}): Promise<boolean> {
  let currentRaw: string | null = null;
  try {
    currentRaw = await params.fsModule.promises.readFile(params.configPath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      throw error;
    }
  }
  if (hashConfigRaw(currentRaw) !== params.committedHash) {
    return false;
  }
  if (params.previousSnapshot.exists && typeof params.previousSnapshot.raw === "string") {
    await replaceFileAtomic({
      filePath: params.configPath,
      content: params.previousSnapshot.raw,
      dirMode: 0o700,
      mode: 0o600,
      tempPrefix: path.basename(params.configPath),
      copyFallbackOnPermissionError: true,
      fileSystem: params.fsModule,
    });
    return true;
  }
  if (params.previousSnapshot.exists) {
    return false;
  }
  try {
    await params.fsModule.promises.unlink(params.configPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      throw error;
    }
  }
  return true;
}

function coerceConfig(value: unknown): OpenClawConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as OpenClawConfig;
}

function hasConfigMeta(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const meta = value.meta;
  return isRecord(meta);
}

function resolveGatewayMode(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }
  const gateway = value.gateway;
  if (!isRecord(gateway) || typeof gateway.mode !== "string") {
    return null;
  }
  const trimmed = gateway.mode.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function collectEnvRefPaths(value: unknown, pathLocal: string, output: Map<string, string>): void {
  if (typeof value === "string") {
    if (containsEnvVarReference(value)) {
      output.set(pathLocal, value);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      collectEnvRefPaths(item, `${pathLocal}[${index}]`, output);
    });
    return;
  }
  if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      const childPath = pathLocal ? `${pathLocal}.${key}` : key;
      collectEnvRefPaths(child, childPath, output);
    }
  }
}

function containsConfigIncludeDirective(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => containsConfigIncludeDirective(item));
  }
  if (!isRecord(value)) {
    return false;
  }
  if (INCLUDE_KEY in value) {
    return true;
  }
  return Object.values(value).some((item) => containsConfigIncludeDirective(item));
}

function normalizeStatNumber(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeStatId(value: number | bigint | null | undefined): string | null {
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

function resolveConfigStatMetadata(
  stat: fs.Stats | null,
): Pick<ConfigHealthFingerprint, "dev" | "ino" | "mode" | "nlink" | "uid" | "gid"> {
  return {
    dev: normalizeStatId(stat?.dev ?? null),
    ino: normalizeStatId(stat?.ino ?? null),
    mode: normalizeStatNumber(stat ? stat.mode & 0o777 : null),
    nlink: normalizeStatNumber(stat?.nlink ?? null),
    uid: normalizeStatNumber(stat?.uid ?? null),
    gid: normalizeStatNumber(stat?.gid ?? null),
  };
}

function resolveConfigWriteSuspiciousReasons(params: {
  existsBefore: boolean;
  unreadableBefore: boolean;
  sizeBaselineBytes: number | null;
  nextBytes: number | null;
  hasMetaBefore: boolean;
  gatewayModeBefore: string | null;
  gatewayModeAfter: string | null;
}): string[] {
  const reasons: string[] = [];
  if (!params.existsBefore) {
    return reasons;
  }
  if (params.unreadableBefore) {
    reasons.push("unreadable-config-before-write");
  }
  if (
    typeof params.sizeBaselineBytes === "number" &&
    typeof params.nextBytes === "number" &&
    params.sizeBaselineBytes >= 512 &&
    params.nextBytes < Math.floor(params.sizeBaselineBytes * 0.5)
  ) {
    reasons.push(`size-drop:${params.sizeBaselineBytes}->${params.nextBytes}`);
  }
  if (!params.hasMetaBefore) {
    reasons.push("missing-meta-before-write");
  }
  if (params.gatewayModeBefore && !params.gatewayModeAfter) {
    reasons.push("gateway-mode-removed");
  }
  return reasons;
}

function resolveConfigWriteBlockingReasons(
  suspicious: string[],
  options: Pick<ConfigWriteOptions, "allowConfigSizeDrop"> = {},
): string[] {
  return suspicious.filter(
    (reason) =>
      reason === "unreadable-config-before-write" ||
      (reason.startsWith("size-drop:") && options.allowConfigSizeDrop !== true) ||
      reason === "gateway-mode-removed",
  );
}

async function readConfigHealthState(deps: Required<ConfigIoDeps>): Promise<ConfigHealthState> {
  return readConfigHealthStateFromStore(deps);
}

function readConfigHealthStateSync(deps: Required<ConfigIoDeps>): ConfigHealthState {
  return readConfigHealthStateFromStore(deps);
}

async function writeConfigHealthState(
  deps: Required<ConfigIoDeps>,
  state: ConfigHealthState,
): Promise<void> {
  writeConfigHealthStateToStore(deps, state);
}

function writeConfigHealthStateSync(deps: Required<ConfigIoDeps>, state: ConfigHealthState): void {
  writeConfigHealthStateToStore(deps, state);
}

function getConfigHealthEntry(state: ConfigHealthState, configPath: string): ConfigHealthEntry {
  const entries = state.entries;
  if (!entries || !isRecord(entries)) {
    return {};
  }
  const entry = entries[configPath];
  return entry && isRecord(entry) ? entry : {};
}

function setConfigHealthEntry(
  state: ConfigHealthState,
  configPath: string,
  entry: ConfigHealthEntry,
): ConfigHealthState {
  return {
    ...state,
    entries: {
      ...state.entries,
      [configPath]: entry,
    },
  };
}

async function readConfigFingerprintForPath(
  deps: Required<ConfigIoDeps>,
  targetPath: string,
): Promise<ConfigHealthFingerprint | null> {
  try {
    const raw = await deps.fs.promises.readFile(targetPath, "utf-8");
    const stat = await deps.fs.promises.stat(targetPath).catch(() => null);
    const parsedRes = parseConfigJson5(raw, deps.json5);
    const parsed = parsedRes.ok ? parsedRes.parsed : {};
    return {
      hash: hashConfigRaw(raw),
      bytes: Buffer.byteLength(raw, "utf-8"),
      mtimeMs: stat?.mtimeMs ?? null,
      ctimeMs: stat?.ctimeMs ?? null,
      ...resolveConfigStatMetadata(stat),
      hasMeta: hasConfigMeta(parsed),
      gatewayMode: resolveGatewayMode(parsed),
      observedAt: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

function readConfigFingerprintForPathSync(
  deps: Required<ConfigIoDeps>,
  targetPath: string,
): ConfigHealthFingerprint | null {
  try {
    const raw = deps.fs.readFileSync(targetPath, "utf-8");
    const stat = deps.fs.statSync(targetPath, { throwIfNoEntry: false }) ?? null;
    const parsedRes = parseConfigJson5(raw, deps.json5);
    const parsed = parsedRes.ok ? parsedRes.parsed : {};
    return {
      hash: hashConfigRaw(raw),
      bytes: Buffer.byteLength(raw, "utf-8"),
      mtimeMs: stat?.mtimeMs ?? null,
      ctimeMs: stat?.ctimeMs ?? null,
      ...resolveConfigStatMetadata(stat),
      hasMeta: hasConfigMeta(parsed),
      gatewayMode: resolveGatewayMode(parsed),
      observedAt: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

function formatConfigArtifactTimestamp(ts: string): string {
  return ts.replaceAll(":", "-").replaceAll(".", "-");
}

function sameFingerprint(
  left: ConfigHealthFingerprint | undefined,
  right: ConfigHealthFingerprint,
): boolean {
  if (!left) {
    return false;
  }
  return (
    left.hash === right.hash &&
    left.bytes === right.bytes &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.hasMeta === right.hasMeta &&
    left.gatewayMode === right.gatewayMode
  );
}

async function observeConfigSnapshot(
  deps: Required<ConfigIoDeps>,
  snapshot: ConfigFileSnapshot,
): Promise<void> {
  if (!snapshot.exists || typeof snapshot.raw !== "string") {
    return;
  }

  const stat = await deps.fs.promises.stat(snapshot.path).catch(() => null);
  const now = new Date().toISOString();
  const current: ConfigHealthFingerprint = {
    hash: resolveConfigSnapshotHash(snapshot) ?? hashConfigRaw(snapshot.raw),
    bytes: Buffer.byteLength(snapshot.raw, "utf-8"),
    mtimeMs: stat?.mtimeMs ?? null,
    ctimeMs: stat?.ctimeMs ?? null,
    ...resolveConfigStatMetadata(stat),
    hasMeta: hasConfigMeta(snapshot.parsed),
    gatewayMode: resolveGatewayMode(snapshot.resolved),
    observedAt: now,
  };

  let healthState = await readConfigHealthState(deps);
  const entry = getConfigHealthEntry(healthState, snapshot.path);
  const backupBaseline =
    entry.lastKnownGood ??
    (await readConfigFingerprintForPath(deps, `${snapshot.path}.bak`)) ??
    undefined;
  const suspicious = resolveConfigObserveSuspiciousReasons({
    bytes: current.bytes,
    hasMeta: current.hasMeta,
    gatewayMode: current.gatewayMode,
    parsed: snapshot.parsed,
    lastKnownGood: backupBaseline,
  });

  if (suspicious.length === 0) {
    if (snapshot.valid) {
      const nextEntry: ConfigHealthEntry = {
        ...entry,
        lastKnownGood: current,
        lastObservedSuspiciousSignature: null,
      };
      if (
        !sameFingerprint(entry.lastKnownGood, current) ||
        entry.lastObservedSuspiciousSignature !== null
      ) {
        healthState = setConfigHealthEntry(healthState, snapshot.path, nextEntry);
        await writeConfigHealthState(deps, healthState);
      }
    }
    return;
  }

  const suspiciousSignature = `${current.hash}:${suspicious.join(",")}`;
  if (entry.lastObservedSuspiciousSignature === suspiciousSignature) {
    return;
  }

  const backup =
    (backupBaseline?.hash ? backupBaseline : null) ??
    (await readConfigFingerprintForPath(deps, `${snapshot.path}.bak`));
  deps.logger.warn(`Config observe anomaly: ${snapshot.path} (${suspicious.join(", ")})`);
  await appendConfigAuditRecord({
    fs: deps.fs,
    env: deps.env,
    homedir: deps.homedir,
    record: {
      ts: now,
      source: "config-io",
      event: "config.observe",
      phase: "read",
      configPath: snapshot.path,
      ...snapshotConfigAuditProcessInfo(),
      exists: true,
      valid: snapshot.valid,
      hash: current.hash,
      bytes: current.bytes,
      mtimeMs: current.mtimeMs,
      ctimeMs: current.ctimeMs,
      dev: current.dev,
      ino: current.ino,
      mode: current.mode,
      nlink: current.nlink,
      uid: current.uid,
      gid: current.gid,
      hasMeta: current.hasMeta,
      gatewayMode: current.gatewayMode,
      suspicious,
      lastKnownGoodHash: entry.lastKnownGood?.hash ?? null,
      lastKnownGoodBytes: entry.lastKnownGood?.bytes ?? null,
      lastKnownGoodMtimeMs: entry.lastKnownGood?.mtimeMs ?? null,
      lastKnownGoodCtimeMs: entry.lastKnownGood?.ctimeMs ?? null,
      lastKnownGoodDev: entry.lastKnownGood?.dev ?? null,
      lastKnownGoodIno: entry.lastKnownGood?.ino ?? null,
      lastKnownGoodMode: entry.lastKnownGood?.mode ?? null,
      lastKnownGoodNlink: entry.lastKnownGood?.nlink ?? null,
      lastKnownGoodUid: entry.lastKnownGood?.uid ?? null,
      lastKnownGoodGid: entry.lastKnownGood?.gid ?? null,
      lastKnownGoodGatewayMode: entry.lastKnownGood?.gatewayMode ?? null,
      backupHash: backup?.hash ?? null,
      backupBytes: backup?.bytes ?? null,
      backupMtimeMs: backup?.mtimeMs ?? null,
      backupCtimeMs: backup?.ctimeMs ?? null,
      backupDev: backup?.dev ?? null,
      backupIno: backup?.ino ?? null,
      backupMode: backup?.mode ?? null,
      backupNlink: backup?.nlink ?? null,
      backupUid: backup?.uid ?? null,
      backupGid: backup?.gid ?? null,
      backupGatewayMode: backup?.gatewayMode ?? null,
      clobberedPath: null,
      restoredFromBackup: false,
      restoredBackupPath: null,
      restoreErrorCode: null,
      restoreErrorMessage: null,
    },
  });

  healthState = setConfigHealthEntry(healthState, snapshot.path, {
    ...entry,
    lastObservedSuspiciousSignature: suspiciousSignature,
  });
  await writeConfigHealthState(deps, healthState);
}

function observeConfigSnapshotSync(
  deps: Required<ConfigIoDeps>,
  snapshot: ConfigFileSnapshot,
): void {
  if (!snapshot.exists || typeof snapshot.raw !== "string") {
    return;
  }

  const stat = deps.fs.statSync(snapshot.path, { throwIfNoEntry: false }) ?? null;
  const now = new Date().toISOString();
  const current: ConfigHealthFingerprint = {
    hash: resolveConfigSnapshotHash(snapshot) ?? hashConfigRaw(snapshot.raw),
    bytes: Buffer.byteLength(snapshot.raw, "utf-8"),
    mtimeMs: stat?.mtimeMs ?? null,
    ctimeMs: stat?.ctimeMs ?? null,
    ...resolveConfigStatMetadata(stat),
    hasMeta: hasConfigMeta(snapshot.parsed),
    gatewayMode: resolveGatewayMode(snapshot.resolved),
    observedAt: now,
  };

  let healthState = readConfigHealthStateSync(deps);
  const entry = getConfigHealthEntry(healthState, snapshot.path);
  const backupBaseline =
    entry.lastKnownGood ??
    readConfigFingerprintForPathSync(deps, `${snapshot.path}.bak`) ??
    undefined;
  const suspicious = resolveConfigObserveSuspiciousReasons({
    bytes: current.bytes,
    hasMeta: current.hasMeta,
    gatewayMode: current.gatewayMode,
    parsed: snapshot.parsed,
    lastKnownGood: backupBaseline,
  });

  if (suspicious.length === 0) {
    if (snapshot.valid) {
      const nextEntry: ConfigHealthEntry = {
        ...entry,
        lastKnownGood: current,
        lastObservedSuspiciousSignature: null,
      };
      if (
        !sameFingerprint(entry.lastKnownGood, current) ||
        entry.lastObservedSuspiciousSignature !== null
      ) {
        healthState = setConfigHealthEntry(healthState, snapshot.path, nextEntry);
        writeConfigHealthStateSync(deps, healthState);
      }
    }
    return;
  }

  const suspiciousSignature = `${current.hash}:${suspicious.join(",")}`;
  if (entry.lastObservedSuspiciousSignature === suspiciousSignature) {
    return;
  }

  const backup =
    (backupBaseline?.hash ? backupBaseline : null) ??
    readConfigFingerprintForPathSync(deps, `${snapshot.path}.bak`);
  deps.logger.warn(`Config observe anomaly: ${snapshot.path} (${suspicious.join(", ")})`);
  appendConfigAuditRecordSync({
    fs: deps.fs,
    env: deps.env,
    homedir: deps.homedir,
    record: {
      ts: now,
      source: "config-io",
      event: "config.observe",
      phase: "read",
      configPath: snapshot.path,
      ...snapshotConfigAuditProcessInfo(),
      exists: true,
      valid: snapshot.valid,
      hash: current.hash,
      bytes: current.bytes,
      mtimeMs: current.mtimeMs,
      ctimeMs: current.ctimeMs,
      dev: current.dev,
      ino: current.ino,
      mode: current.mode,
      nlink: current.nlink,
      uid: current.uid,
      gid: current.gid,
      hasMeta: current.hasMeta,
      gatewayMode: current.gatewayMode,
      suspicious,
      lastKnownGoodHash: entry.lastKnownGood?.hash ?? null,
      lastKnownGoodBytes: entry.lastKnownGood?.bytes ?? null,
      lastKnownGoodMtimeMs: entry.lastKnownGood?.mtimeMs ?? null,
      lastKnownGoodCtimeMs: entry.lastKnownGood?.ctimeMs ?? null,
      lastKnownGoodDev: entry.lastKnownGood?.dev ?? null,
      lastKnownGoodIno: entry.lastKnownGood?.ino ?? null,
      lastKnownGoodMode: entry.lastKnownGood?.mode ?? null,
      lastKnownGoodNlink: entry.lastKnownGood?.nlink ?? null,
      lastKnownGoodUid: entry.lastKnownGood?.uid ?? null,
      lastKnownGoodGid: entry.lastKnownGood?.gid ?? null,
      lastKnownGoodGatewayMode: entry.lastKnownGood?.gatewayMode ?? null,
      backupHash: backup?.hash ?? null,
      backupBytes: backup?.bytes ?? null,
      backupMtimeMs: backup?.mtimeMs ?? null,
      backupCtimeMs: backup?.ctimeMs ?? null,
      backupDev: backup?.dev ?? null,
      backupIno: backup?.ino ?? null,
      backupMode: backup?.mode ?? null,
      backupNlink: backup?.nlink ?? null,
      backupUid: backup?.uid ?? null,
      backupGid: backup?.gid ?? null,
      backupGatewayMode: backup?.gatewayMode ?? null,
      clobberedPath: null,
      restoredFromBackup: false,
      restoredBackupPath: null,
      restoreErrorCode: null,
      restoreErrorMessage: null,
    },
  });

  healthState = setConfigHealthEntry(healthState, snapshot.path, {
    ...entry,
    lastObservedSuspiciousSignature: suspiciousSignature,
  });
  writeConfigHealthStateSync(deps, healthState);
}

export type ConfigIoDeps = {
  fs?: typeof fs;
  json5?: typeof JSON5;
  env?: NodeJS.ProcessEnv;
  lowerPrecedenceEnv?: Readonly<Record<string, string>>;
  homedir?: () => string;
  configPath?: string;
  logger?: Pick<typeof console, "error" | "warn">;
  measure?: ConfigSnapshotReadMeasure;
  suppressFutureVersionWarning?: boolean;
  observe?: boolean;
};

export type ConfigSnapshotReadOptions = {
  measure?: ConfigSnapshotReadMeasure;
  observe?: boolean;
  isolateEnv?: boolean;
  lowerPrecedenceEnv?: Readonly<Record<string, string>>;
  recoverSuspicious?: boolean;
  allowSuspiciousRecovery?: (
    candidate: OpenClawConfig,
    current: OpenClawConfig,
  ) => boolean | Promise<boolean>;
  skipPluginValidation?: boolean;
  preservedLegacyRootKeys?: readonly string[];
  suppressFutureVersionWarning?: boolean;
};

function warnOnConfigMiskeys(raw: unknown, logger: Pick<typeof console, "warn">): void {
  if (!raw || typeof raw !== "object") {
    return;
  }
  const gateway = (raw as Record<string, unknown>).gateway;
  if (!gateway || typeof gateway !== "object") {
    return;
  }
  if ("token" in (gateway as Record<string, unknown>)) {
    logger.warn(
      'Config uses "gateway.token". This key is ignored; use "gateway.auth.token" instead.',
    );
  }
}

function logConfigWarningsOnce(params: {
  configPath: string;
  warnings: Array<{ path: string; message: string }>;
  logger: Pick<typeof console, "warn">;
}): void {
  if (params.warnings.length === 0) {
    // A later recurrence should be visible after the config becomes clean.
    loggedConfigWarningFingerprints.delete(params.configPath);
    return;
  }

  const details = params.warnings
    .map(
      (warning) =>
        `- ${sanitizeTerminalText(warning.path || "<root>")}: ${sanitizeTerminalText(warning.message)}`,
    )
    .join("\n");
  const fingerprint = hashConfigRaw(details);
  if (loggedConfigWarningFingerprints.get(params.configPath) === fingerprint) {
    return;
  }
  loggedConfigWarningFingerprints.set(params.configPath, fingerprint);
  params.logger.warn(`Config warnings:\n${details}`);
}

function stampConfigVersion(cfg: OpenClawConfig, version?: string): OpenClawConfig {
  return stampConfigWriteMetadata(cfg, new Date().toISOString(), version);
}

function resolveConfigSizeBaselineBytes(params: {
  raw: string | null;
  json5: { parse: (value: string) => unknown };
  lastTouchedVersionOverride?: string;
}): number | null {
  if (params.raw === null) {
    return null;
  }
  const rawBytes = Buffer.byteLength(params.raw, "utf-8");
  const parsed = parseConfigJson5(params.raw, params.json5);
  if (!parsed.ok || !isRecord(parsed.parsed)) {
    return rawBytes;
  }
  const canonical = JSON.stringify(
    stampConfigVersion(parsed.parsed as OpenClawConfig, params.lastTouchedVersionOverride),
    null,
    2,
  )
    .trimEnd()
    .concat("\n");
  return Buffer.byteLength(canonical, "utf-8");
}

function warnIfConfigFromFuture(cfg: OpenClawConfig, logger: Pick<typeof console, "warn">): void {
  const touched = cfg.meta?.lastTouchedVersion;
  if (!touched) {
    return;
  }
  if (shouldWarnOnTouchedVersion(VERSION, touched)) {
    if (warnedFutureTouchedVersions.has(touched)) {
      return;
    }
    warnedFutureTouchedVersions.add(touched);
    logger.warn(
      [
        `Your OpenClaw config was written by version ${touched}, but this command is running ${VERSION}.`,
        "Check: `openclaw --version`, `which openclaw`, and `openclaw gateway status --deep`.",
        "If unexpected, update PATH so `openclaw` points to the version you want, or reinstall the Gateway service from that same OpenClaw install.",
      ].join("\n"),
    );
  }
}

function shouldSuppressFutureVersionWarningForEnv(env: NodeJS.ProcessEnv): boolean {
  return (
    isTruthyEnvValue(env.OPENCLAW_UPDATE_IN_PROGRESS) ||
    isTruthyEnvValue(env.OPENCLAW_UPDATE_POST_CORE)
  );
}

function resolveConfigPathForDeps(deps: Required<ConfigIoDeps>): string {
  if (deps.configPath) {
    return deps.configPath;
  }
  return resolveConfigPath(deps.env, resolveStateDir(deps.env, deps.homedir));
}

function normalizeDeps(overrides: ConfigIoDeps = {}): Required<ConfigIoDeps> {
  const env = overrides.env ?? process.env;
  return {
    fs: overrides.fs ?? fs,
    json5: overrides.json5 ?? JSON5,
    env,
    lowerPrecedenceEnv: overrides.lowerPrecedenceEnv ?? {},
    homedir: overrides.homedir ?? (() => resolveRequiredHomeDir(env, os.homedir)),
    configPath: overrides.configPath ?? "",
    logger: overrides.logger ?? console,
    measure: overrides.measure ?? (async (_name, run) => await run()),
    suppressFutureVersionWarning:
      overrides.suppressFutureVersionWarning ?? shouldSuppressFutureVersionWarningForEnv(env),
    observe: overrides.observe ?? true,
  };
}

function maybeLoadDotEnvForConfig(env: NodeJS.ProcessEnv): void {
  // Only hydrate dotenv for the real process env. Callers using injected env
  // objects (tests/diagnostics) should stay isolated.
  if (env !== process.env) {
    return;
  }
  loadDotEnv({ quiet: true });
}

export function parseConfigJson5(
  raw: string,
  json5: { parse: (value: string) => unknown } = JSON5,
): ParseConfigJson5Result {
  try {
    return { ok: true, parsed: JSON.parse(raw) };
  } catch {
    // Keep JSON5 compatibility for authored config, but avoid the slower parser
    // on the JSON files OpenClaw writes itself.
  }
  try {
    return { ok: true, parsed: json5.parse(raw) };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

function findJsonRootSuffix(
  raw: string,
  json5: { parse: (value: string) => unknown } = JSON5,
): { raw: string; parsed: unknown } | null {
  if (/^\s*(?:\{|\[)/.test(raw)) {
    return null;
  }
  let offset = 0;
  while (offset < raw.length) {
    const nextNewline = raw.indexOf("\n", offset);
    const lineEnd = nextNewline === -1 ? raw.length : nextNewline + 1;
    const line = raw.slice(offset, lineEnd);
    if (/^\s*(?:\{|\[)/.test(line)) {
      const candidate = raw.slice(offset);
      const parsed = parseConfigJson5(candidate, json5);
      return parsed.ok ? { raw: candidate, parsed: parsed.parsed } : null;
    }
    offset = lineEnd;
  }
  return null;
}

function warnOnConfigPermissionHardeningFailure(params: {
  deps: Required<ConfigIoDeps>;
  configPath: string;
  context: string;
  error: unknown;
}): void {
  const detail = params.error instanceof Error ? params.error.message : String(params.error);
  params.deps.logger.warn(
    `Config permission hardening failed (${params.context}): ${params.configPath}: ${detail}`,
  );
}

async function persistPrefixedConfigRecovery(params: {
  deps: Required<ConfigIoDeps>;
  configPath: string;
  originalRaw: string;
  recoveredRaw: string;
}): Promise<void> {
  const observedAt = new Date().toISOString();
  const clobberedPath = await persistBoundedClobberedConfigSnapshot({
    deps: params.deps,
    configPath: params.configPath,
    raw: params.originalRaw,
    observedAt,
  });
  await params.deps.fs.promises.writeFile(params.configPath, params.recoveredRaw, {
    encoding: "utf-8",
    mode: 0o600,
  });
  await params.deps.fs.promises.chmod?.(params.configPath, 0o600).catch((error: unknown) => {
    warnOnConfigPermissionHardeningFailure({
      deps: params.deps,
      configPath: params.configPath,
      context: "prefix recovery",
      error,
    });
  });
  params.deps.logger.warn(
    `Config auto-stripped non-JSON prefix: ${params.configPath}` +
      (clobberedPath ? ` (original saved as ${clobberedPath})` : ""),
  );
}

async function recoverConfigFromJsonRootSuffixWithDeps(params: {
  deps: Required<ConfigIoDeps>;
  configPath: string;
  snapshot: ConfigFileSnapshot;
}): Promise<boolean> {
  if (!params.snapshot.exists || params.snapshot.valid || typeof params.snapshot.raw !== "string") {
    return false;
  }
  const suffixRecovery = findJsonRootSuffix(params.snapshot.raw, params.deps.json5);
  if (!suffixRecovery) {
    return false;
  }

  let resolved: unknown;
  try {
    resolved = resolveConfigIncludesForRead(suffixRecovery.parsed, params.configPath, params.deps);
  } catch {
    return false;
  }
  const readResolution = resolveConfigForRead(
    resolved,
    params.deps.env,
    params.deps.lowerPrecedenceEnv,
  );
  const validated = validateConfigObjectWithPlugins(
    stripShippedPluginInstallConfigRecords(readResolution.resolvedConfigRaw),
    {
      env: params.deps.env,
      sourceRaw: suffixRecovery.parsed,
    },
  );
  if (!validated.ok) {
    return false;
  }

  await persistPrefixedConfigRecovery({
    deps: params.deps,
    configPath: params.configPath,
    originalRaw: params.snapshot.raw,
    recoveredRaw: suffixRecovery.raw,
  });
  return true;
}

type ConfigReadResolution = {
  resolvedConfigRaw: unknown;
  envSnapshotForRestore: Record<string, string | undefined>;
  envWarnings: EnvSubstitutionWarning[];
};

const TILDE_PATH_VALUE_RE = /^~(?=$|[\\/])/;
const PATH_LIKE_CONFIG_KEY_RE = /(dir|path|paths|file|root|workspace)$/i;
const PATH_LIKE_CONFIG_LIST_KEYS = new Set(["paths", "pathPrepend"]);

function isPathLikeConfigKey(key: string | undefined): boolean {
  return Boolean(key && (PATH_LIKE_CONFIG_KEY_RE.test(key) || PATH_LIKE_CONFIG_LIST_KEYS.has(key)));
}

function expandAuthoredTildePath(value: string, home: string): string {
  const suffix = value.slice(1);
  if (!suffix) {
    return home;
  }
  if (suffix.startsWith("/") || suffix.startsWith("\\")) {
    return path.join(home, suffix.slice(1));
  }
  return value;
}

function restoreAuthoredTildePathsForWrite(
  next: unknown,
  authored: unknown,
  key: string | undefined,
  home: string,
): unknown {
  if (
    typeof next === "string" &&
    typeof authored === "string" &&
    isPathLikeConfigKey(key) &&
    TILDE_PATH_VALUE_RE.test(authored.trim()) &&
    path.normalize(next) === path.normalize(expandAuthoredTildePath(authored.trim(), home))
  ) {
    return authored;
  }

  if (Array.isArray(next) && Array.isArray(authored)) {
    const normalizeChildren = isPathLikeConfigKey(key);
    return next.map((entry, index) =>
      restoreAuthoredTildePathsForWrite(
        entry,
        authored[index],
        normalizeChildren ? key : undefined,
        home,
      ),
    );
  }

  if (!isRecord(next) || !isRecord(authored)) {
    return next;
  }

  const out: Record<string, unknown> = { ...next };
  for (const [childKey, childValue] of Object.entries(out)) {
    if (Object.hasOwn(authored, childKey)) {
      out[childKey] = restoreAuthoredTildePathsForWrite(
        childValue,
        authored[childKey],
        childKey,
        home,
      );
    }
  }
  return out;
}

function resolveConfigIncludesForRead(
  parsed: unknown,
  configPath: string,
  deps: Required<ConfigIoDeps>,
  includeFileHashesForWrite?: Record<string, string>,
  includeFileTargetsForWrite?: Record<string, string>,
): unknown {
  const allowedRoots = resolveIncludeRoots(deps.env, deps.homedir);
  const recordIncludeTarget = (resolvedPath: string, canonicalPath?: string) => {
    if (!includeFileTargetsForWrite) {
      return;
    }
    const normalizedPath = path.normalize(resolvedPath);
    try {
      includeFileTargetsForWrite[normalizedPath] = path.normalize(
        canonicalPath ??
          resolveConfigIncludeWritePath({
            configPath,
            includePath: resolvedPath,
            allowedRoots,
          }),
      );
    } catch {
      // Unsafe or unresolvable targets remain unavailable to direct include mutation.
    }
  };
  return resolveConfigIncludes(
    parsed,
    configPath,
    {
      readFile: (candidate) => deps.fs.readFileSync(candidate, "utf-8"),
      readFileWithGuards: ({ includePath, resolvedPath, rootRealDir }) => {
        try {
          const raw = readConfigIncludeFileWithGuards({
            includePath,
            resolvedPath,
            rootRealDir,
            ioFs: deps.fs,
            onResolvedPath: (canonicalPath) => recordIncludeTarget(resolvedPath, canonicalPath),
          });
          if (includeFileHashesForWrite) {
            includeFileHashesForWrite[path.normalize(resolvedPath)] = hashConfigIncludeRaw(raw);
          }
          return raw;
        } catch (error) {
          const missing = collectErrorGraphCandidates(error, (current) => [current.cause]).some(
            (candidate) => extractErrorCode(candidate) === "ENOENT",
          );
          if (includeFileHashesForWrite && missing) {
            includeFileHashesForWrite[path.normalize(resolvedPath)] = hashConfigIncludeRaw(null);
          }
          if (missing) {
            recordIncludeTarget(resolvedPath);
          }
          throw error;
        }
      },
      parseJson: (raw) => deps.json5.parse(raw),
    },
    { allowedRoots },
  );
}

function resolveConfigForRead(
  resolvedIncludes: unknown,
  env: NodeJS.ProcessEnv,
  lowerPrecedenceEnv: Readonly<Record<string, string>> = {},
): ConfigReadResolution {
  // Apply config.env to process.env BEFORE substitution so ${VAR} can reference config-defined vars.
  if (resolvedIncludes && typeof resolvedIncludes === "object" && "env" in resolvedIncludes) {
    applyConfigEnvVars(resolvedIncludes as OpenClawConfig, env, { lowerPrecedenceEnv });
  }

  // Collect missing env var references as warnings instead of throwing,
  // so non-critical config sections with unset vars don't crash the gateway.
  const envWarnings: EnvSubstitutionWarning[] = [];
  return {
    resolvedConfigRaw: resolveConfigEnvVars(resolvedIncludes, env, {
      onMissing: (w) => envWarnings.push(w),
    }),
    // Capture env snapshot after substitution for write-time ${VAR} restoration.
    envSnapshotForRestore: { ...env } as Record<string, string | undefined>,
    envWarnings,
  };
}

function snapshotEnv(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  return { ...env };
}

export function restoreEnvChangesIfUnchanged(params: {
  env: NodeJS.ProcessEnv;
  before: Record<string, string | undefined>;
  after: Record<string, string | undefined>;
}): void {
  const keys = new Set([...Object.keys(params.before), ...Object.keys(params.after)]);
  for (const key of keys) {
    if (params.before[key] === params.after[key] || params.env[key] !== params.after[key]) {
      continue;
    }
    const previous = params.before[key];
    if (previous === undefined) {
      delete params.env[key];
    } else {
      params.env[key] = previous;
    }
  }
}

type ReadConfigFileSnapshotInternalResult = {
  snapshot: ConfigFileSnapshot;
  envSnapshotForRestore?: Record<string, string | undefined>;
  includeFileHashesForWrite?: Record<string, string>;
  includeFileTargetsForWrite?: Record<string, string>;
  pluginMetadataSnapshot?: PluginMetadataSnapshot;
};

export type ReadConfigFileSnapshotWithPluginMetadataResult = {
  snapshot: ConfigFileSnapshot;
  pluginMetadataSnapshot?: PluginMetadataSnapshot;
};

export type BestEffortConfigSnapshot = {
  config: OpenClawConfig;
  sourceConfig: OpenClawConfig;
};

function createConfigFileSnapshot(params: {
  path: string;
  exists: boolean;
  raw: string | null;
  parsed: unknown;
  sourceConfig: OpenClawConfig;
  valid: boolean;
  runtimeConfig: OpenClawConfig;
  hash?: string;
  readError?: { code: string | null };
  issues: ConfigFileSnapshot["issues"];
  warnings: ConfigFileSnapshot["warnings"];
  legacyIssues: LegacyConfigIssue[];
}): ConfigFileSnapshot {
  const sourceConfig = asResolvedSourceConfig(params.sourceConfig);
  const runtimeConfig = asRuntimeConfig(params.runtimeConfig);
  return {
    path: params.path,
    exists: params.exists,
    raw: params.raw,
    parsed: params.parsed,
    sourceConfig,
    resolved: sourceConfig,
    valid: params.valid,
    runtimeConfig,
    config: runtimeConfig,
    hash: params.hash,
    ...(params.readError ? { readError: params.readError } : {}),
    issues: params.issues,
    warnings: params.warnings,
    legacyIssues: params.legacyIssues,
  };
}

async function finalizeReadConfigSnapshotInternalResult(
  deps: Required<ConfigIoDeps>,
  result: ReadConfigFileSnapshotInternalResult,
  options?: { observe?: boolean },
): Promise<ReadConfigFileSnapshotInternalResult> {
  if (deps.observe && options?.observe !== false) {
    await observeConfigSnapshot(deps, result.snapshot);
  }
  return result;
}

async function collectInvalidConfigLegacyIssues(
  raw: unknown,
  sourceRaw: unknown,
): Promise<LegacyConfigIssue[]> {
  if (!raw || typeof raw !== "object") {
    return [];
  }
  const { findDoctorLegacyConfigIssues } =
    await import("../commands/doctor/shared/legacy-config-issues.js");
  return findDoctorLegacyConfigIssues(raw, sourceRaw);
}

export function createConfigIO(
  overrides: ConfigIoDeps & {
    pluginValidation?: "full" | "skip";
    preservedLegacyRootKeys?: readonly string[];
    shellEnvFallback?: "load" | "defer";
  } = {},
) {
  const deps = normalizeDeps(overrides);
  const configPath = resolveConfigPathForDeps(deps);

  function observeLoadConfigSnapshot(snapshot: ConfigFileSnapshot): ConfigFileSnapshot {
    if (deps.observe) {
      observeConfigSnapshotSync(deps, snapshot);
    }
    return snapshot;
  }

  function finalizeLoadedRuntimeConfig(cfg: OpenClawConfig): OpenClawConfig {
    const duplicates = findDuplicateAgentDirs(cfg, {
      env: deps.env,
      homedir: deps.homedir,
    });
    if (duplicates.length > 0) {
      throw new DuplicateAgentDirError(duplicates);
    }

    applyConfigEnvVars(cfg, deps.env);

    const enabled = shouldEnableShellEnvFallback(deps.env) || cfg.env?.shellEnv?.enabled === true;
    if (
      enabled &&
      overrides.shellEnvFallback !== "defer" &&
      !shouldDeferShellEnvFallback(deps.env)
    ) {
      loadShellEnvFallback({
        enabled: true,
        env: deps.env,
        expectedKeys: resolveShellEnvExpectedKeys(deps.env),
        logger: deps.logger,
        timeoutMs: cfg.env?.shellEnv?.timeoutMs ?? resolveShellEnvFallbackTimeoutMs(deps.env),
      });
    }

    const pendingSecret = AUTO_OWNER_DISPLAY_SECRET_BY_PATH.get(configPath);
    const ownerDisplaySecretResolution = ensureOwnerDisplaySecret(
      cfg,
      () => pendingSecret ?? crypto.randomBytes(32).toString("hex"),
    );
    const cfgWithOwnerDisplaySecret = retainGeneratedOwnerDisplaySecret({
      config: ownerDisplaySecretResolution.config,
      configPath,
      generatedSecret: ownerDisplaySecretResolution.generatedSecret,
      state: {
        pendingByPath: AUTO_OWNER_DISPLAY_SECRET_BY_PATH,
      },
    });

    return applyConfigOverrides(cfgWithOwnerDisplaySecret);
  }

  function replaceConfigFileSync(raw: string): void {
    replaceFileAtomicSync({
      filePath: configPath,
      content: raw,
      dirMode: 0o700,
      mode: 0o600,
      tempPrefix: path.basename(configPath),
      copyFallbackOnPermissionError: true,
      fileSystem: deps.fs,
    });
  }

  function migrateAndStripShippedPluginInstallConfigRecords(
    configRaw: unknown,
    options: { persist?: boolean; rootConfigRaw?: unknown } = {},
  ): ShippedPluginInstallConfigReadMigration {
    const installRecords = extractShippedPluginInstallConfigRecords(configRaw);
    const stripped = stripShippedPluginInstallConfigRecords(configRaw);
    if (Object.keys(installRecords).length === 0) {
      return { config: stripped };
    }
    if (options.persist === false) {
      return { config: configRaw, validationConfig: stripped };
    }

    try {
      const stateDir = resolveStateDir(deps.env, deps.homedir);
      const existingRecords = loadInstalledPluginIndexInstallRecordsSync({
        env: deps.env,
        stateDir,
      });
      const nextRecords = {
        ...installRecords,
        ...existingRecords,
      };
      if (Object.keys(installRecords).some((pluginId) => !(pluginId in existingRecords))) {
        writePersistedInstalledPluginIndexInstallRecordsSync(nextRecords, {
          config: coerceConfig(stripped),
          env: deps.env,
          stateDir,
        });
      }
      const rootConfigRaw = options.rootConfigRaw;
      if (
        rootConfigRaw !== undefined &&
        Object.keys(extractShippedPluginInstallConfigRecords(rootConfigRaw)).length > 0
      ) {
        const persistedRootParsed = stripShippedPluginInstallConfigRecords(rootConfigRaw);
        const persistedRootRaw = JSON.stringify(persistedRootParsed, null, 2)
          .trimEnd()
          .concat("\n");
        replaceConfigFileSync(persistedRootRaw);
        return { config: stripped, persistedRootParsed, persistedRootRaw };
      }
    } catch (err) {
      deps.logger.warn(
        `Config (${configPath}): could not migrate shipped plugins.installs records into the plugin index: ${formatErrorMessage(
          err,
        )}`,
      );
      return { config: configRaw };
    }

    return { config: stripped };
  }

  function retainRuntimeOnlyShippedPluginInstallConfigRecords(
    config: OpenClawConfig,
    sourceRaw: unknown,
  ): OpenClawConfig {
    const installRecords = extractShippedPluginInstallConfigRecords(sourceRaw);
    if (Object.keys(installRecords).length === 0) {
      return config;
    }
    return {
      ...config,
      plugins: {
        ...config.plugins,
        installs: installRecords,
      },
    };
  }

  function createValidationPluginMetadataSnapshotLoader(params: {
    effectiveConfigRaw: unknown;
    env: NodeJS.ProcessEnv;
  }): {
    load: (config: OpenClawConfig) => PluginMetadataSnapshot;
    getSnapshot: () => PluginMetadataSnapshot | undefined;
  } {
    let pluginMetadataSnapshot: PluginMetadataSnapshot | undefined;
    return {
      load: (config) => {
        if (pluginMetadataSnapshot) {
          return pluginMetadataSnapshot;
        }
        const metadataConfig = retainRuntimeOnlyShippedPluginInstallConfigRecords(
          config,
          params.effectiveConfigRaw,
        );
        const defaultAgentId = resolveDefaultAgentId(metadataConfig);
        pluginMetadataSnapshot = resolvePluginMetadataSnapshot({
          config: metadataConfig,
          workspaceDir: resolveAgentWorkspaceDir(metadataConfig, defaultAgentId, params.env),
          env: params.env,
          allowWorkspaceScopedCurrent: true,
          pluginIdScope: createConfigValidationMetadataPluginIdScope({
            config: metadataConfig,
            env: params.env,
          }),
        });
        return pluginMetadataSnapshot;
      },
      getSnapshot: () => pluginMetadataSnapshot,
    };
  }

  function resolveRuntimePreflightSourceConfig(candidate: OpenClawConfig): OpenClawConfig {
    const env = { ...deps.env } as NodeJS.ProcessEnv;
    const resolvedIncludes = resolveConfigIncludesForRead(candidate, configPath, {
      ...deps,
      env,
    });
    const readResolution = resolveConfigForRead(resolvedIncludes, env, deps.lowerPrecedenceEnv);
    return coerceConfig(
      migrateAndStripShippedPluginInstallConfigRecords(readResolution.resolvedConfigRaw, {
        persist: false,
        rootConfigRaw: candidate,
      }).config,
    );
  }

  function ensureShippedPluginInstallConfigRecordsMigratedForWrite(
    snapshot: ConfigFileSnapshot,
  ): ShippedPluginInstallConfigWriteMigration {
    const installRecords = {
      ...extractShippedPluginInstallConfigRecords(snapshot.sourceConfig),
      ...extractShippedPluginInstallConfigRecords(snapshot.parsed),
    };
    if (Object.keys(installRecords).length === 0) {
      return { migrated: false };
    }

    const stateDir = resolveStateDir(deps.env, deps.homedir);
    const existingRecords = loadInstalledPluginIndexInstallRecordsSync({
      env: deps.env,
      stateDir,
    });
    if (Object.keys(installRecords).every((pluginId) => pluginId in existingRecords)) {
      return { migrated: false };
    }

    try {
      writePersistedInstalledPluginIndexInstallRecordsSync(
        {
          ...installRecords,
          ...existingRecords,
        },
        {
          config: coerceConfig(stripShippedPluginInstallConfigRecords(snapshot.sourceConfig)),
          env: deps.env,
          stateDir,
        },
      );
      return {
        migrated: true,
      };
    } catch (err) {
      throw new Error(
        `Config write blocked: shipped plugins.installs records in ${configPath} could not be migrated into the plugin index. Fix state directory permissions or run openclaw plugins registry --refresh, then retry. ${formatErrorMessage(
          err,
        )}`,
        { cause: err },
      );
    }
  }

  function rollbackShippedPluginInstallConfigWriteMigration(
    migration: ShippedPluginInstallConfigWriteMigration,
  ): boolean {
    if (!migration.migrated) {
      return false;
    }
    return false;
  }

  function resolveSuspiciousRecoveryBackupCandidate(parsed: unknown): OpenClawConfig | null {
    try {
      const candidateEnv = cloneEnvWithPlatformSemantics(deps.env);
      const candidateDeps = { ...deps, env: candidateEnv };
      const resolved = resolveConfigIncludesForRead(parsed, configPath, candidateDeps);
      const readResolution = resolveConfigForRead(resolved, candidateEnv, deps.lowerPrecedenceEnv);
      const installMigration = migrateAndStripShippedPluginInstallConfigRecords(
        readResolution.resolvedConfigRaw,
        {
          persist: false,
          rootConfigRaw: parsed,
        },
      );
      const effectiveConfigRaw = installMigration.config;
      const validationConfigRaw = installMigration.validationConfig ?? effectiveConfigRaw;
      const validationPluginMetadata = createValidationPluginMetadataSnapshotLoader({
        effectiveConfigRaw,
        env: candidateEnv,
      });
      const validated = validateConfigObjectWithPlugins(validationConfigRaw, {
        env: candidateEnv,
        pluginValidation: overrides.pluginValidation,
        loadPluginMetadataSnapshot: validationPluginMetadata.load,
        sourceRaw: parsed,
        preservedLegacyRootKeys: overrides.preservedLegacyRootKeys,
      });
      return validated.ok ? coerceConfig(effectiveConfigRaw) : null;
    } catch {
      return null;
    }
  }

  function loadConfigLocal(options: { skipSuspiciousRecovery?: boolean } = {}): OpenClawConfig {
    try {
      maybeLoadDotEnvForConfig(deps.env);
      const envBeforeRead = snapshotEnv(deps.env);
      if (!deps.fs.existsSync(configPath)) {
        loggedConfigWarningFingerprints.delete(configPath);
        if (
          overrides.shellEnvFallback !== "defer" &&
          shouldEnableShellEnvFallback(deps.env) &&
          !shouldDeferShellEnvFallback(deps.env)
        ) {
          loadShellEnvFallback({
            enabled: true,
            env: deps.env,
            expectedKeys: resolveShellEnvExpectedKeys(deps.env),
            logger: deps.logger,
            timeoutMs: resolveShellEnvFallbackTimeoutMs(deps.env),
          });
        }
        return {};
      }
      const raw = deps.fs.readFileSync(configPath, "utf-8");
      const parsed = deps.json5.parse(raw);
      const readResolution = resolveConfigForRead(
        resolveConfigIncludesForRead(parsed, configPath, deps),
        deps.env,
        deps.lowerPrecedenceEnv,
      );
      const resolvedConfig = readResolution.resolvedConfigRaw;
      const installMigration = migrateAndStripShippedPluginInstallConfigRecords(resolvedConfig, {
        persist: false,
        rootConfigRaw: parsed,
      });
      const effectiveConfigRaw = installMigration.config;
      const validationConfigRaw = installMigration.validationConfig ?? effectiveConfigRaw;
      const snapshotRaw = installMigration.persistedRootRaw ?? raw;
      const snapshotParsed = installMigration.persistedRootParsed ?? parsed;
      const hash = hashConfigRaw(snapshotRaw);
      for (const w of readResolution.envWarnings) {
        deps.logger.warn(
          `Config (${configPath}): missing env var "${w.varName}" at ${w.configPath} - feature using this value will be unavailable`,
        );
      }
      warnOnConfigMiskeys(validationConfigRaw, deps.logger);
      if (typeof validationConfigRaw !== "object" || validationConfigRaw === null) {
        loggedConfigWarningFingerprints.delete(configPath);
        observeLoadConfigSnapshot({
          ...createConfigFileSnapshot({
            path: configPath,
            exists: true,
            raw: snapshotRaw,
            parsed: snapshotParsed,
            sourceConfig: {},
            valid: true,
            runtimeConfig: {},
            hash,
            issues: [],
            warnings: [],
            legacyIssues: [],
          }),
        });
        return {};
      }
      const preValidationDuplicates = findDuplicateAgentDirs(
        validationConfigRaw as OpenClawConfig,
        {
          env: deps.env,
          homedir: deps.homedir,
        },
      );
      if (preValidationDuplicates.length > 0) {
        throw new DuplicateAgentDirError(preValidationDuplicates);
      }
      const validationPluginMetadata = createValidationPluginMetadataSnapshotLoader({
        effectiveConfigRaw,
        env: deps.env,
      });
      const validated = validateConfigObjectWithPlugins(validationConfigRaw, {
        env: deps.env,
        pluginValidation: overrides.pluginValidation,
        loadPluginMetadataSnapshot: validationPluginMetadata.load,
        sourceRaw: snapshotParsed,
        preservedLegacyRootKeys: overrides.preservedLegacyRootKeys,
      });
      if (!validated.ok) {
        observeLoadConfigSnapshot({
          ...createConfigFileSnapshot({
            path: configPath,
            exists: true,
            raw: snapshotRaw,
            parsed: snapshotParsed,
            sourceConfig: coerceConfig(effectiveConfigRaw),
            valid: false,
            runtimeConfig: coerceConfig(effectiveConfigRaw),
            hash,
            issues: validated.issues,
            warnings: validated.warnings,
            legacyIssues: [],
          }),
        });
        throwInvalidConfig({
          configPath,
          issues: validated.issues,
          logger: deps.logger,
          loggedConfigPaths: loggedInvalidConfigs,
        });
      }
      if (overrides.pluginValidation !== "skip") {
        logConfigWarningsOnce({
          configPath,
          warnings: validated.warnings,
          logger: deps.logger,
        });
      }
      if (!deps.suppressFutureVersionWarning) {
        warnIfConfigFromFuture(validated.config, deps.logger);
      }
      if (
        deps.observe &&
        !options.skipSuspiciousRecovery &&
        !containsConfigIncludeDirective(parsed)
      ) {
        const recovery = maybeRecoverSuspiciousConfigReadSyncWithDeps({
          deps,
          configPath,
          raw,
          parsed,
          validateBackupSync: (backup) =>
            resolveSuspiciousRecoveryBackupCandidate(backup.parsed) !== null,
        });
        if (recovery.raw !== raw) {
          restoreEnvChangesIfUnchanged({
            env: deps.env,
            before: envBeforeRead,
            after: snapshotEnv(deps.env),
          });
          return loadConfigLocal({ skipSuspiciousRecovery: true });
        }
      }
      const cfg = retainRuntimeOnlyShippedPluginInstallConfigRecords(
        materializeRuntimeConfig(validated.config, "load", {
          manifestRegistry: validationPluginMetadata.getSnapshot()?.manifestRegistry,
        }),
        effectiveConfigRaw,
      );
      observeLoadConfigSnapshot({
        ...createConfigFileSnapshot({
          path: configPath,
          exists: true,
          raw: snapshotRaw,
          parsed: snapshotParsed,
          sourceConfig: coerceConfig(effectiveConfigRaw),
          valid: true,
          runtimeConfig: cfg,
          hash,
          issues: [],
          warnings: validated.warnings,
          legacyIssues: [],
        }),
      });
      return finalizeLoadedRuntimeConfig(cfg);
    } catch (err) {
      if (err instanceof DuplicateAgentDirError) {
        deps.logger.error(err.message);
        throw err;
      }
      const error = err as { code?: string };
      if (error?.code === "INVALID_CONFIG") {
        // Fail closed so invalid configs cannot silently fall back to permissive defaults.
        throw err;
      }
      deps.logger.error(`Failed to read config at ${configPath}`, err);
      throw err;
    }
  }

  async function readConfigFileSnapshotInternal(
    options: {
      recoverSuspicious?: boolean;
      skipSuspiciousRecovery?: boolean;
      allowSuspiciousRecovery?: (
        candidate: OpenClawConfig,
        current: OpenClawConfig,
      ) => boolean | Promise<boolean>;
    } = {},
  ): Promise<ReadConfigFileSnapshotInternalResult> {
    maybeLoadDotEnvForConfig(deps.env);
    const envBeforeRead = snapshotEnv(deps.env);
    const exists = deps.fs.existsSync(configPath);
    if (!exists) {
      const hash = hashConfigRaw(null);
      const config = {};
      const legacyIssues: LegacyConfigIssue[] = [];
      return await finalizeReadConfigSnapshotInternalResult(deps, {
        snapshot: createConfigFileSnapshot({
          path: configPath,
          exists: false,
          raw: null,
          parsed: {},
          sourceConfig: {},
          valid: true,
          runtimeConfig: config,
          hash,
          issues: [],
          warnings: [],
          legacyIssues,
        }),
      });
    }

    let fallbackRaw: string | null = null;
    let fallbackParsed: unknown = {};
    let fallbackSourceConfig: OpenClawConfig = {};
    let fallbackHash = hashConfigRaw(null);
    let fallbackEnvSnapshotForRestore: Record<string, string | undefined> | undefined;
    const includeFileHashesForWrite: Record<string, string> = {};
    const includeFileTargetsForWrite: Record<string, string> = {};

    try {
      const raw = await deps.measure("config.snapshot.read.file", () =>
        deps.fs.readFileSync(configPath, "utf-8"),
      );
      const rawHash = await deps.measure("config.snapshot.read.hash", () => hashConfigRaw(raw));
      fallbackRaw = raw;
      fallbackHash = rawHash;
      const parsedRes = await deps.measure("config.snapshot.read.parse", () =>
        parseConfigJson5(raw, deps.json5),
      );
      if (!parsedRes.ok) {
        return await finalizeReadConfigSnapshotInternalResult(deps, {
          snapshot: createConfigFileSnapshot({
            path: configPath,
            exists: true,
            raw,
            parsed: {},
            sourceConfig: {},
            valid: false,
            runtimeConfig: {},
            hash: rawHash,
            issues: [{ path: "", message: `JSON5 parse failed: ${parsedRes.error}` }],
            warnings: [],
            legacyIssues: [],
          }),
        });
      }
      fallbackParsed = parsedRes.parsed;
      fallbackSourceConfig = coerceConfig(parsedRes.parsed);

      // Resolve $include directives
      const effectiveParsed = parsedRes.parsed;
      const hash = rawHash;
      fallbackRaw = raw;
      fallbackParsed = effectiveParsed;
      fallbackSourceConfig = coerceConfig(effectiveParsed);
      fallbackHash = hash;

      let resolved: unknown;
      try {
        resolved = await deps.measure("config.snapshot.read.includes", () =>
          resolveConfigIncludesForRead(
            effectiveParsed,
            configPath,
            deps,
            includeFileHashesForWrite,
            includeFileTargetsForWrite,
          ),
        );
      } catch (err) {
        const message =
          err instanceof ConfigIncludeError
            ? err.message
            : `Include resolution failed: ${String(err)}`;
        return await finalizeReadConfigSnapshotInternalResult(deps, {
          snapshot: createConfigFileSnapshot({
            path: configPath,
            exists: true,
            raw,
            parsed: effectiveParsed,
            sourceConfig: coerceConfig(effectiveParsed),
            valid: false,
            runtimeConfig: coerceConfig(effectiveParsed),
            hash,
            issues: [{ path: "", message }],
            warnings: [],
            legacyIssues: [],
          }),
          includeFileHashesForWrite,
          includeFileTargetsForWrite,
        });
      }

      const readResolution = await deps.measure("config.snapshot.read.env", () =>
        resolveConfigForRead(resolved, deps.env, deps.lowerPrecedenceEnv),
      );
      fallbackEnvSnapshotForRestore = readResolution.envSnapshotForRestore;

      // Convert missing env var references to config warnings instead of fatal errors.
      // This allows the gateway to start in degraded mode when non-critical config
      // sections reference unset env vars (e.g. optional provider API keys).
      const envVarWarnings = readResolution.envWarnings.map((w) => ({
        path: w.configPath,
        message: `Missing env var "${w.varName}" - feature using this value will be unavailable`,
      }));

      const resolvedConfigRaw = readResolution.resolvedConfigRaw;
      const installMigration = await deps.measure(
        "config.snapshot.read.plugin-install-migration",
        () =>
          migrateAndStripShippedPluginInstallConfigRecords(resolvedConfigRaw, {
            persist: false,
            rootConfigRaw: effectiveParsed,
          }),
      );
      const effectiveConfigRaw = installMigration.config;
      const validationConfigRaw = installMigration.validationConfig ?? effectiveConfigRaw;
      const snapshotRaw = installMigration.persistedRootRaw ?? raw;
      const snapshotParsed = installMigration.persistedRootParsed ?? effectiveParsed;
      const snapshotHash = installMigration.persistedRootRaw
        ? hashConfigRaw(installMigration.persistedRootRaw)
        : hash;
      fallbackSourceConfig = coerceConfig(effectiveConfigRaw);
      const validationPluginMetadata = createValidationPluginMetadataSnapshotLoader({
        effectiveConfigRaw,
        env: deps.env,
      });
      const validated = await deps.measure("config.snapshot.read.validate", () =>
        validateConfigObjectWithPlugins(validationConfigRaw, {
          env: deps.env,
          pluginValidation: overrides.pluginValidation,
          loadPluginMetadataSnapshot: validationPluginMetadata.load,
          sourceRaw: effectiveParsed,
          preservedLegacyRootKeys: overrides.preservedLegacyRootKeys,
        }),
      );
      if (!validated.ok) {
        const legacyIssues = await deps.measure("config.snapshot.read.legacy-issues", () =>
          collectInvalidConfigLegacyIssues(effectiveConfigRaw, effectiveParsed),
        );
        return await finalizeReadConfigSnapshotInternalResult(deps, {
          snapshot: createConfigFileSnapshot({
            path: configPath,
            exists: true,
            raw: snapshotRaw,
            parsed: snapshotParsed,
            sourceConfig: coerceConfig(effectiveConfigRaw),
            valid: false,
            runtimeConfig: coerceConfig(effectiveConfigRaw),
            hash: snapshotHash,
            issues: validated.issues,
            warnings: [...validated.warnings, ...envVarWarnings],
            legacyIssues,
          }),
          envSnapshotForRestore: readResolution.envSnapshotForRestore,
          includeFileHashesForWrite,
          includeFileTargetsForWrite,
        });
      }

      if (!deps.suppressFutureVersionWarning) {
        warnIfConfigFromFuture(validated.config, deps.logger);
      }
      let callerRejectedSuspiciousRecovery = false;
      if (
        options.recoverSuspicious === true &&
        deps.observe &&
        !options.skipSuspiciousRecovery &&
        !containsConfigIncludeDirective(effectiveParsed)
      ) {
        const allowSuspiciousRecovery = options.allowSuspiciousRecovery;
        let recoveryCandidate: OpenClawConfig | null = null;
        const recovery = await deps.measure("config.snapshot.read.recover-suspicious", () =>
          maybeRecoverSuspiciousConfigReadWithDeps({
            deps,
            configPath,
            raw,
            parsed: effectiveParsed,
            validateBackup: async (backup) => {
              recoveryCandidate = resolveSuspiciousRecoveryBackupCandidate(backup.parsed);
              return recoveryCandidate !== null;
            },
            ...(allowSuspiciousRecovery
              ? {
                  allowBackupRecovery: async () => {
                    const allowed =
                      recoveryCandidate !== null &&
                      (await allowSuspiciousRecovery(recoveryCandidate, validated.config));
                    callerRejectedSuspiciousRecovery = !allowed;
                    return allowed;
                  },
                }
              : {}),
          }),
        );
        if (recovery.raw !== raw) {
          restoreEnvChangesIfUnchanged({
            env: deps.env,
            before: envBeforeRead,
            after: snapshotEnv(deps.env),
          });
          return await readConfigFileSnapshotInternal({
            recoverSuspicious: options.recoverSuspicious,
            skipSuspiciousRecovery: true,
          });
        }
      }
      const snapshotConfig = await deps.measure("config.snapshot.read.materialize", () =>
        retainRuntimeOnlyShippedPluginInstallConfigRecords(
          materializeRuntimeConfig(validated.config, "snapshot", {
            manifestRegistry: validationPluginMetadata.getSnapshot()?.manifestRegistry,
          }),
          effectiveConfigRaw,
        ),
      );
      return await deps.measure("config.snapshot.read.observe", () =>
        finalizeReadConfigSnapshotInternalResult(
          deps,
          {
            snapshot: createConfigFileSnapshot({
              path: configPath,
              exists: true,
              raw: snapshotRaw,
              parsed: snapshotParsed,
              // Use resolvedConfigRaw (after $include and ${ENV} substitution but BEFORE runtime defaults)
              // for config set/unset operations (issue #6070)
              sourceConfig: coerceConfig(effectiveConfigRaw),
              valid: true,
              runtimeConfig: snapshotConfig,
              hash: snapshotHash,
              issues: [],
              warnings: [...validated.warnings, ...envVarWarnings],
              legacyIssues: [],
            }),
            envSnapshotForRestore: readResolution.envSnapshotForRestore,
            includeFileHashesForWrite,
            includeFileTargetsForWrite,
            pluginMetadataSnapshot: validationPluginMetadata.getSnapshot(),
          },
          { observe: !callerRejectedSuspiciousRecovery },
        ),
      );
    } catch (err) {
      const nodeErr = err as NodeJS.ErrnoException;
      let message: string;
      if (nodeErr?.code === "EACCES") {
        // Permission denied - common in Docker/container deployments where the
        // config file is owned by root but the gateway runs as a non-root user.
        const uid = process.getuid?.();
        const uidHint = typeof uid === "number" ? String(uid) : "$(id -u)";
        message = [
          `read failed: ${String(err)}`,
          ``,
          `Config file is not readable by the current process. If running in a container`,
          `or 1-click deployment, fix ownership with:`,
          `  chown ${uidHint} "${configPath}"`,
          `Then restart the gateway.`,
        ].join("\n");
        deps.logger.error(message);
      } else {
        message = `read failed: ${String(err)}`;
      }
      return await finalizeReadConfigSnapshotInternalResult(deps, {
        snapshot: createConfigFileSnapshot({
          path: configPath,
          exists: true,
          raw: fallbackRaw,
          parsed: fallbackParsed,
          sourceConfig: fallbackSourceConfig,
          valid: false,
          runtimeConfig: fallbackSourceConfig,
          hash: fallbackHash,
          ...(fallbackRaw === null ? { readError: { code: nodeErr?.code ?? null } } : {}),
          issues: [{ path: "", message }],
          warnings: [],
          legacyIssues: [],
        }),
        envSnapshotForRestore: fallbackEnvSnapshotForRestore,
        includeFileHashesForWrite,
        includeFileTargetsForWrite,
      });
    }
  }

  async function readConfigFileSnapshotLocal(
    options: ConfigSnapshotReadOptions = {},
  ): Promise<ConfigFileSnapshot> {
    const result = await readConfigFileSnapshotInternal({
      recoverSuspicious: options.recoverSuspicious === true,
      allowSuspiciousRecovery: options.allowSuspiciousRecovery,
    });
    return result.snapshot;
  }

  async function readConfigFileSnapshotWithPluginMetadataLocal(
    options: ConfigSnapshotReadOptions = {},
  ): Promise<ReadConfigFileSnapshotWithPluginMetadataResult> {
    const result = await readConfigFileSnapshotInternal({
      recoverSuspicious: options.recoverSuspicious === true,
      allowSuspiciousRecovery: options.allowSuspiciousRecovery,
    });
    return {
      snapshot: result.snapshot,
      ...(result.pluginMetadataSnapshot
        ? { pluginMetadataSnapshot: result.pluginMetadataSnapshot }
        : {}),
    };
  }

  async function promoteConfigSnapshotToLastKnownGoodLocal(
    snapshot: ConfigFileSnapshot,
  ): Promise<boolean> {
    return await promoteConfigSnapshotToLastKnownGoodWithDeps({
      deps,
      snapshot,
      logger: deps.logger,
    });
  }

  async function recoverConfigFromLastKnownGoodLocal(params: {
    snapshot: ConfigFileSnapshot;
    reason: string;
  }): Promise<boolean> {
    return await recoverConfigFromLastKnownGoodWithDeps({
      deps,
      snapshot: params.snapshot,
      reason: params.reason,
    });
  }

  async function recoverConfigFromJsonRootSuffixLocal(
    snapshot: ConfigFileSnapshot,
  ): Promise<boolean> {
    return await recoverConfigFromJsonRootSuffixWithDeps({
      deps,
      configPath,
      snapshot,
    });
  }

  async function readConfigFileSnapshotForWriteLocal(): Promise<ReadConfigFileSnapshotForWriteResult> {
    const assertConfigPathForWrite = () => {
      const activeConfigPath = resolveConfigPathForDeps(deps);
      if (activeConfigPath !== configPath) {
        throw new ConfigMutationConflictError("config path changed since last load", {
          currentHash: null,
          retryable: false,
        });
      }
    };
    assertConfigPathForWrite();
    const result = await readConfigFileSnapshotInternal();
    assertConfigPathForWrite();
    return {
      snapshot: result.snapshot,
      writeOptions: {
        assertConfigPathForWrite,
        basePluginMetadataSnapshot: result.pluginMetadataSnapshot,
        envSnapshotForRestore: result.envSnapshotForRestore,
        expectedConfigPath: configPath,
        ownedConfigPathForWrite: configPath,
        includeFileHashesForWrite: result.includeFileHashesForWrite,
        includeFileTargetsForWrite: result.includeFileTargetsForWrite,
        unsetPaths: resolveManagedUnsetPathsForWrite(undefined),
      },
    };
  }

  async function readBestEffortConfigSnapshotLocal(): Promise<BestEffortConfigSnapshot> {
    const result = await readConfigFileSnapshotInternal();
    if (!result.snapshot.valid) {
      return {
        config: result.snapshot.config,
        sourceConfig: result.snapshot.sourceConfig,
      };
    }
    return {
      config: finalizeLoadedRuntimeConfig(
        materializeRuntimeConfig(result.snapshot.sourceConfig, "load", {
          manifestRegistry: result.pluginMetadataSnapshot?.manifestRegistry,
        }),
      ),
      sourceConfig: result.snapshot.sourceConfig,
    };
  }

  async function readBestEffortConfigLocal(): Promise<OpenClawConfig> {
    return (await readBestEffortConfigSnapshotLocal()).config;
  }

  async function readSourceConfigBestEffortLocal(): Promise<OpenClawConfig> {
    maybeLoadDotEnvForConfig(deps.env);
    const exists = deps.fs.existsSync(configPath);
    if (!exists) {
      return {};
    }

    try {
      const raw = deps.fs.readFileSync(configPath, "utf-8");
      const parsedRes = parseConfigJson5(raw, deps.json5);
      if (!parsedRes.ok) {
        return {};
      }

      let resolved: unknown;
      try {
        resolved = resolveConfigIncludesForRead(parsedRes.parsed, configPath, deps);
      } catch {
        return coerceConfig(parsedRes.parsed);
      }

      const readResolution = resolveConfigForRead(resolved, deps.env, deps.lowerPrecedenceEnv);
      return coerceConfig(stripShippedPluginInstallConfigRecords(readResolution.resolvedConfigRaw));
    } catch {
      return {};
    }
  }

  async function writeConfigFileLocal(
    cfg: OpenClawConfig,
    options: ConfigWriteOptions = {},
  ): Promise<InternalConfigWriteResult> {
    options.assertConfigPathForWrite?.();
    assertConfigWriteAllowedInCurrentMode({ configPath, env: deps.env });
    clearConfigCache();
    const unsetPaths = resolveManagedUnsetPathsForWrite(options.unsetPaths);
    let persistCandidate: unknown = cfg;
    const snapshotRead = options.baseSnapshot
      ? {
          snapshot: options.baseSnapshot,
          pluginMetadataSnapshot: options.basePluginMetadataSnapshot,
        }
      : await readConfigFileSnapshotInternal();
    const snapshot = snapshotRead.snapshot;
    if (options.baseSnapshot) {
      assertBaseSnapshotStillCurrent(snapshot, configPath, deps.fs);
    }
    let envRefMap: Map<string, string> | null = null;
    let changedPaths: Set<string> | null = null;
    const identityRestoredPaths = new Set<string>();
    const hasAuthoredIncludes = containsConfigIncludeDirective(snapshot.parsed);
    // Valid authored directives keep ownership even when a descendant include
    // is broken. Malformed directives remain removable by replacement repairs.
    const hasResolvedAuthoredIncludes =
      hasAuthoredIncludes && !containsConfigIncludeDirective(snapshot.sourceConfig);
    if (snapshot.valid && snapshot.exists) {
      persistCandidate = resolvePersistCandidateForWrite({
        runtimeConfig: snapshot.config,
        sourceConfig: snapshot.resolved,
        nextConfig: cfg,
        rootAuthoredConfig: snapshot.parsed,
        unsetPaths,
        explicitSetPaths: options.explicitSetPaths,
        explicitSetValueSource: options.explicitSetValueSource,
        modelIdNormalizationPolicies: snapshotRead.pluginMetadataSnapshot
          ? collectManifestModelIdNormalizationPolicies(snapshotRead.pluginMetadataSnapshot.plugins)
          : undefined,
      });
    } else if (snapshot.exists && hasAuthoredIncludes) {
      persistCandidate = preserveIncludeOwnedConfigForWrite({
        runtimeConfig: snapshot.config,
        sourceConfig: snapshot.resolved,
        nextConfig: cfg,
        rootAuthoredConfig: snapshot.parsed,
      });
    }
    if (snapshot.exists && (snapshot.valid || hasResolvedAuthoredIncludes)) {
      try {
        const resolvedIncludes = resolveConfigIncludes(
          snapshot.parsed,
          configPath,
          {
            readFile: (candidate) => deps.fs.readFileSync(candidate, "utf-8"),
            readFileWithGuards: ({ includePath, resolvedPath, rootRealDir }) =>
              readConfigIncludeFileWithGuards({
                includePath,
                resolvedPath,
                rootRealDir,
                ioFs: deps.fs,
              }),
            parseJson: (raw) => deps.json5.parse(raw),
          },
          { allowedRoots: resolveIncludeRoots(deps.env, deps.homedir) },
        );
        const collected = new Map<string, string>();
        collectEnvRefPaths(resolvedIncludes, "", collected);
        if (collected.size > 0) {
          envRefMap = collected;
          changedPaths = new Set<string>();
          collectChangedPaths(snapshot.config, cfg, "", changedPaths);
        }
      } catch {
        envRefMap = null;
      }
    }

    persistCandidate = applyUnsetPathsForWrite(persistCandidate as OpenClawConfig, unsetPaths);

    const envForRestore = options.envSnapshotForRestore ?? deps.env;
    const validationSourceCandidate = containsConfigIncludeDirective(persistCandidate)
      ? restoreEnvVarRefs(persistCandidate, snapshot.parsed, envForRestore)
      : persistCandidate;
    const validationCandidate = containsConfigIncludeDirective(validationSourceCandidate)
      ? resolveRuntimePreflightSourceConfig(validationSourceCandidate as OpenClawConfig)
      : validationSourceCandidate;
    const validated = validateConfigObjectRawWithPlugins(validationCandidate, {
      env: deps.env,
      pluginValidation: options.skipPluginValidation ? "skip" : "full",
      preservedLegacyRootKeys: options.preservedLegacyRootKeys,
    });
    if (!validated.ok) {
      const issue = validated.issues[0];
      const pathLabel = issue?.path ? issue.path : "<root>";
      const issueMessage = issue?.message ?? "invalid";
      throw new Error(formatConfigValidationFailure(pathLabel, issueMessage));
    }
    const previousWarningFingerprint = loggedConfigWarningFingerprints.get(configPath);

    // Restore ${VAR} env var references that were resolved during config loading.
    // Read the current file (pre-substitution) and restore any references whose
    // resolved values match the incoming config - so we don't overwrite
    // "${ANTHROPIC_API_KEY}" with "sk-ant-..." when the caller didn't change it.
    //
    // We use only the root file's parsed content (no $include resolution) to avoid
    // pulling values from included files into the root config on write-back.
    // Use persistCandidate (the merge-patched value before validation) rather than
    // validated.config, because plugin/channel AJV validation may inject schema
    // defaults (e.g., enrichGroupParticipantsFromContacts) that should not be
    // persisted to disk (issue #56772).
    // Apply legacy web-search normalization so that migration results are still
    // persisted even though we bypass validated.config.
    let cfgToWrite = persistCandidate as OpenClawConfig;
    try {
      if (deps.fs.existsSync(configPath)) {
        const currentRaw = await deps.fs.promises.readFile(configPath, "utf-8");
        const parsedRes = parseConfigJson5(currentRaw, deps.json5);
        if (parsedRes.ok) {
          // Use env snapshot from when config was loaded (if available) to avoid
          // TOCTOU issues where env changes between load and write. Falls back to
          // live env if no snapshot exists (e.g., first write before any load).
          const configBeforeIdentityRestore = cfgToWrite;
          cfgToWrite = restoreEnvVarRefs(
            cfgToWrite,
            parsedRes.parsed,
            envForRestore,
          ) as OpenClawConfig;
          collectChangedPaths(configBeforeIdentityRestore, cfgToWrite, "", identityRestoredPaths);
        }
      }
    } catch (error) {
      if (error instanceof EnvRefArrayMutationError) {
        throw error;
      }
      // If reading the current file fails, write cfg as-is (no env restoration)
    }

    const dir = path.dirname(configPath);
    await deps.fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
    await tightenStateDirPermissionsIfNeeded({
      configPath,
      env: deps.env,
      homedir: deps.homedir,
      fsModule: deps.fs,
    });
    const outputConfigBase =
      envRefMap && changedPaths
        ? (restoreEnvRefsFromMap(
            cfgToWrite,
            "",
            envRefMap,
            changedPaths,
            identityRestoredPaths,
          ) as OpenClawConfig)
        : cfgToWrite;
    const tildeRestoredOutputConfig = restoreAuthoredTildePathsForWrite(
      outputConfigBase,
      snapshot.parsed,
      undefined,
      deps.homedir(),
    ) as OpenClawConfig;
    const outputConfig = applyUnsetPathsForWrite(tildeRestoredOutputConfig, unsetPaths);
    // Do NOT apply runtime defaults when writing - user config should only contain
    // explicitly set values. Runtime defaults are applied when loading (issue #6070).
    const stampedOutputConfig = stampConfigVersion(
      outputConfig,
      options.lastTouchedVersionOverride,
    );
    const json = JSON.stringify(stampedOutputConfig, null, 2).trimEnd().concat("\n");
    const nextHash = hashConfigRaw(json);
    const previousHash = resolveConfigSnapshotHash(snapshot);
    const changedPathCount = changedPaths?.size;
    const previousBytes =
      typeof snapshot.raw === "string" ? Buffer.byteLength(snapshot.raw, "utf-8") : null;
    // Formatting is not data. Keep malformed/non-object files on the raw-byte
    // baseline, but compare parseable authored config in its canonical form.
    const sizeBaselineBytes = resolveConfigSizeBaselineBytes({
      raw: snapshot.raw,
      json5: deps.json5,
      lastTouchedVersionOverride: options.lastTouchedVersionOverride,
    });
    const nextBytes = Buffer.byteLength(json, "utf-8");
    const previousStat = snapshot.exists
      ? await deps.fs.promises.stat(configPath).catch(() => null)
      : null;
    const hasMetaBefore = hasConfigMeta(snapshot.parsed);
    const hasMetaAfter = hasConfigMeta(stampedOutputConfig);
    const gatewayModeBefore = resolveGatewayMode(snapshot.resolved);
    const gatewayModeAfter = resolveGatewayMode(stampedOutputConfig);
    const suspiciousReasons = resolveConfigWriteSuspiciousReasons({
      existsBefore: snapshot.exists,
      unreadableBefore: snapshot.readError != null,
      sizeBaselineBytes,
      nextBytes,
      hasMetaBefore,
      gatewayModeBefore,
      gatewayModeAfter,
    });
    const logConfigOverwrite = () => {
      if (!snapshot.exists) {
        return;
      }
      if (options.skipOutputLogs) {
        return;
      }
      const isVitest = deps.env.VITEST === "true";
      const shouldLogInVitest = deps.env.OPENCLAW_TEST_CONFIG_OVERWRITE_LOG === "1";
      if (isVitest && !shouldLogInVitest) {
        return;
      }
      if (!isVerbose() && deps.env.OPENCLAW_CONFIG_OVERWRITE_LOG !== "1" && !shouldLogInVitest) {
        return;
      }
      deps.logger.warn(
        formatConfigOverwriteLogMessage({
          configPath,
          previousHash: previousHash ?? null,
          nextHash,
          changedPathCount,
        }),
      );
    };
    const logConfigWriteAnomalies = () => {
      if (suspiciousReasons.length === 0) {
        return;
      }
      if (options.skipOutputLogs) {
        return;
      }
      // Tests often write minimal configs (missing meta, etc); keep output quiet unless requested.
      const isVitest = deps.env.VITEST === "true";
      const shouldLogInVitest = deps.env.OPENCLAW_TEST_CONFIG_WRITE_ANOMALY_LOG === "1";
      if (isVitest && !shouldLogInVitest) {
        return;
      }
      const shouldLogBenignMissingMeta =
        isVerbose() || deps.env.OPENCLAW_CONFIG_WRITE_ANOMALY_LOG === "1" || shouldLogInVitest;
      const visibleReasons = shouldLogBenignMissingMeta
        ? suspiciousReasons
        : suspiciousReasons.filter((reason) => reason !== "missing-meta-before-write");
      if (visibleReasons.length === 0) {
        return;
      }
      deps.logger.warn(`Config write anomaly: ${configPath} (${visibleReasons.join(", ")})`);
    };
    const previousMetadata = resolveConfigStatMetadata(previousStat);
    const auditRecordBase = createConfigWriteAuditRecordBase({
      configPath,
      env: deps.env,
      existsBefore: snapshot.exists,
      previousHash: previousHash ?? null,
      nextHash,
      previousBytes,
      nextBytes,
      previousMetadata,
      changedPathCount,
      hasMetaBefore,
      hasMetaAfter,
      gatewayModeBefore,
      gatewayModeAfter,
      suspicious: suspiciousReasons,
    });
    const appendWriteAudit = async (
      result: ConfigWriteAuditResult,
      err?: unknown,
      nextStat?: fs.Stats | null,
    ) => {
      await appendConfigAuditRecord({
        fs: deps.fs,
        env: deps.env,
        homedir: deps.homedir,
        record: finalizeConfigWriteAuditRecord({
          base: auditRecordBase,
          result,
          err,
          nextMetadata: resolveConfigStatMetadata(nextStat ?? null),
        }),
      });
    };
    const blockingReasons = resolveConfigWriteBlockingReasons(suspiciousReasons, options);
    if (blockingReasons.length > 0 && options.allowDestructiveWrite !== true) {
      const rejectedPath = `${configPath}.rejected.${formatConfigArtifactTimestamp(new Date().toISOString())}`;
      await deps.fs.promises
        .writeFile(rejectedPath, json, {
          encoding: "utf-8",
          mode: 0o600,
          flag: "wx",
        })
        .catch(() => {});
      const message = `Config write rejected: ${configPath} (${blockingReasons.join(", ")}). Rejected payload saved to ${rejectedPath}.`;
      const err = Object.assign(new Error(message), {
        code: "CONFIG_WRITE_REJECTED",
        rejectedPath,
        reasons: blockingReasons,
      });
      deps.logger.warn(message);
      await appendWriteAudit("rejected", err);
      throw err;
    }

    const preCommitRuntimePreflight =
      options.preCommitRuntimePreflight ??
      (async (sourceConfig: OpenClawConfig) => {
        await preflightRuntimeSnapshotWrite({
          nextSourceConfig: sourceConfig,
          refreshOptions: options.runtimeRefresh,
          formatRefreshError: (error) => formatErrorMessage(error),
          createRefreshError: (detail, cause) =>
            new ConfigRuntimeRefreshError(
              `Config write blocked before committing ${configPath}: active SecretRef resolution failed: ${detail}`,
              { cause },
            ),
        });
      });
    await preCommitRuntimePreflight(resolveRuntimePreflightSourceConfig(stampedOutputConfig));

    const pluginInstallConfigMigration =
      ensureShippedPluginInstallConfigRecordsMigratedForWrite(snapshot);
    let configCommitted = false;
    try {
      const result = await replaceFileAtomic({
        filePath: configPath,
        content: json,
        dirMode: 0o700,
        mode: 0o600,
        tempPrefix: path.basename(configPath),
        copyFallbackOnPermissionError: true,
        fileSystem: deps.fs,
        beforeRename: async () => {
          options.assertConfigPathForWrite?.();
          if (options.baseSnapshot) {
            assertBaseSnapshotStillCurrent(snapshot, configPath, deps.fs);
          }
          if (deps.fs.existsSync(configPath)) {
            await maintainConfigBackups(configPath, deps.fs.promises);
          }
          if (options.baseSnapshot) {
            assertBaseSnapshotStillCurrent(snapshot, configPath, deps.fs);
          }
          options.assertConfigPathForWrite?.();
        },
      });
      configCommitted = true;
      try {
        options.assertConfigPathForWrite?.();
      } catch (error) {
        try {
          const rolledBack = await rollbackConfigFileWriteIfUnchanged({
            configPath,
            previousSnapshot: snapshot,
            committedHash: nextHash,
            fsModule: deps.fs,
          });
          if (rolledBack) {
            rollbackShippedPluginInstallConfigWriteMigration(pluginInstallConfigMigration);
          }
        } catch (rollbackError) {
          throw new ConfigRuntimeRefreshError(
            `${formatErrorMessage(error)} Rollback failed: ${formatErrorMessage(rollbackError)}`,
            { cause: error },
          );
        }
        throw error;
      }
      logConfigOverwrite();
      logConfigWriteAnomalies();
      await appendWriteAudit(
        result.method,
        undefined,
        await deps.fs.promises.stat(configPath).catch(() => null),
      );
      if (!options.skipPluginValidation) {
        // Only successful full-validation commits can advance warning state.
        // The outer runtime refresh may still roll back this commit and state.
        logConfigWarningsOnce({
          configPath,
          warnings: validated.warnings,
          logger: deps.logger,
        });
      }
      return {
        persistedHash: nextHash,
        persistedConfig: stampedOutputConfig,
        ...(pluginInstallConfigMigration.migrated || !options.skipPluginValidation
          ? {
              [configWritePostCommitRollback]: () => {
                rollbackShippedPluginInstallConfigWriteMigration(pluginInstallConfigMigration);
                if (previousWarningFingerprint === undefined) {
                  loggedConfigWarningFingerprints.delete(configPath);
                } else {
                  loggedConfigWarningFingerprints.set(configPath, previousWarningFingerprint);
                }
              },
            }
          : {}),
      };
    } catch (err) {
      if (!configCommitted) {
        rollbackShippedPluginInstallConfigWriteMigration(pluginInstallConfigMigration);
      }
      await appendWriteAudit("failed", err);
      throw err;
    }
  }

  return {
    configPath,
    env: deps.env,
    loadConfig: loadConfigLocal,
    readBestEffortConfig: readBestEffortConfigLocal,
    readBestEffortConfigSnapshot: readBestEffortConfigSnapshotLocal,
    readSourceConfigBestEffort: readSourceConfigBestEffortLocal,
    readConfigFileSnapshot: readConfigFileSnapshotLocal,
    readConfigFileSnapshotWithPluginMetadata: readConfigFileSnapshotWithPluginMetadataLocal,
    readConfigFileSnapshotForWrite: readConfigFileSnapshotForWriteLocal,
    promoteConfigSnapshotToLastKnownGood: promoteConfigSnapshotToLastKnownGoodLocal,
    recoverConfigFromLastKnownGood: recoverConfigFromLastKnownGoodLocal,
    recoverConfigFromJsonRootSuffix: recoverConfigFromJsonRootSuffixLocal,
    writeConfigFile: writeConfigFileLocal,
  };
}

// NOTE: These wrappers intentionally do *not* cache the resolved config path at
// module scope. `OPENCLAW_CONFIG_PATH` (and friends) are expected to work even
// when set after the module has been imported (tests, one-off scripts, etc.).
const AUTO_OWNER_DISPLAY_SECRET_BY_PATH = new Map<string, string>();
export function clearConfigCache(): void {
  // Compat shim: runtime snapshot is the only in-process cache now.
}

export function registerConfigWriteListener(
  listener: (event: ConfigWriteNotification) => void,
): () => void {
  return registerRuntimeConfigWriteListener(listener);
}

export function loadConfig(options?: {
  skipPluginValidation?: boolean;
  pin?: boolean;
  skipShellEnvFallback?: boolean;
}): OpenClawConfig {
  const loadFresh = () =>
    createConfigIO({
      ...(options?.skipPluginValidation ? { pluginValidation: "skip" as const } : {}),
      ...(options?.skipShellEnvFallback ? { shellEnvFallback: "defer" as const } : {}),
    }).loadConfig();
  if (options?.pin === false) {
    return loadFresh();
  }
  // First successful load becomes the process snapshot. Long-lived runtimes
  // should swap this snapshot via explicit reload/watcher paths instead of
  // reparsing openclaw.json on hot code paths.
  return loadPinnedRuntimeConfig(loadFresh);
}

export function getRuntimeConfig(options?: {
  skipPluginValidation?: boolean;
  pin?: boolean;
  skipShellEnvFallback?: boolean;
}): OpenClawConfig {
  return loadConfig(options);
}

export async function readBestEffortConfig(options?: {
  isolateEnv?: boolean;
  observe?: boolean;
  skipPluginValidation?: boolean;
}): Promise<OpenClawConfig> {
  return await createConfigIO({
    ...(options?.isolateEnv ? { env: cloneEnvWithPlatformSemantics(process.env) } : {}),
    ...(options?.observe === false ? { observe: false } : {}),
    ...(options?.skipPluginValidation ? { pluginValidation: "skip" } : {}),
  }).readBestEffortConfig();
}

export async function readBestEffortConfigSnapshot(options?: {
  skipPluginValidation?: boolean;
}): Promise<BestEffortConfigSnapshot> {
  return await createConfigIO(
    options?.skipPluginValidation ? { pluginValidation: "skip" } : {},
  ).readBestEffortConfigSnapshot();
}

export async function readSourceConfigBestEffort(): Promise<OpenClawConfig> {
  return await createConfigIO().readSourceConfigBestEffort();
}

export async function readConfigFileSnapshot(
  options: ConfigSnapshotReadOptions = {},
): Promise<ConfigFileSnapshot> {
  return await createConfigIO({
    ...(options.measure ? { measure: options.measure } : {}),
    ...(options.observe === false ? { observe: false } : {}),
    ...(options.isolateEnv ? { env: cloneEnvWithPlatformSemantics(process.env) } : {}),
    ...(options.lowerPrecedenceEnv ? { lowerPrecedenceEnv: options.lowerPrecedenceEnv } : {}),
    ...(options.skipPluginValidation ? { pluginValidation: "skip" } : {}),
    ...(options.suppressFutureVersionWarning ? { suppressFutureVersionWarning: true } : {}),
    ...(options.preservedLegacyRootKeys
      ? { preservedLegacyRootKeys: options.preservedLegacyRootKeys }
      : {}),
  }).readConfigFileSnapshot({
    recoverSuspicious: options.recoverSuspicious === true,
    allowSuspiciousRecovery: options.allowSuspiciousRecovery,
  });
}

export async function readConfigFileSnapshotWithPluginMetadata(
  options?: Pick<
    ConfigSnapshotReadOptions,
    | "allowSuspiciousRecovery"
    | "isolateEnv"
    | "lowerPrecedenceEnv"
    | "measure"
    | "observe"
    | "recoverSuspicious"
  >,
): Promise<ReadConfigFileSnapshotWithPluginMetadataResult> {
  return await createConfigIO({
    ...(options?.measure ? { measure: options.measure } : {}),
    ...(options?.observe === false ? { observe: false } : {}),
    ...(options?.isolateEnv ? { env: cloneEnvWithPlatformSemantics(process.env) } : {}),
    ...(options?.lowerPrecedenceEnv ? { lowerPrecedenceEnv: options.lowerPrecedenceEnv } : {}),
  }).readConfigFileSnapshotWithPluginMetadata({
    recoverSuspicious: options?.recoverSuspicious === true,
    allowSuspiciousRecovery: options?.allowSuspiciousRecovery,
  });
}

export async function promoteConfigSnapshotToLastKnownGood(
  snapshot: ConfigFileSnapshot,
): Promise<boolean> {
  return await createConfigIO().promoteConfigSnapshotToLastKnownGood(snapshot);
}

export async function recoverConfigFromLastKnownGood(params: {
  snapshot: ConfigFileSnapshot;
  reason: string;
}): Promise<boolean> {
  return await createConfigIO().recoverConfigFromLastKnownGood(params);
}

export async function recoverConfigFromJsonRootSuffix(
  snapshot: ConfigFileSnapshot,
): Promise<boolean> {
  return await createConfigIO().recoverConfigFromJsonRootSuffix(snapshot);
}

export async function readSourceConfigSnapshot(): Promise<ConfigFileSnapshot> {
  return await readConfigFileSnapshot();
}

export async function readConfigFileSnapshotForWrite(options?: {
  skipPluginValidation?: boolean;
}): Promise<ReadConfigFileSnapshotForWriteResult> {
  const readOptions = options?.skipPluginValidation ? { pluginValidation: "skip" as const } : {};
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const result = await createConfigIO(readOptions).readConfigFileSnapshotForWrite();
      result.writeOptions.assertConfigPathForWrite?.();
      return result;
    } catch (error) {
      if (!(error instanceof ConfigMutationConflictError) || error.retryable || attempt === 2) {
        throw error;
      }
    }
  }
  throw new Error("unreachable");
}

export async function readSourceConfigSnapshotForWrite(): Promise<ReadConfigFileSnapshotForWriteResult> {
  return await readConfigFileSnapshotForWrite();
}

export async function writeConfigFile(
  cfg: OpenClawConfig,
  options: ConfigWriteOptions = {},
): Promise<ConfigWriteResult> {
  options.assertConfigPathForWrite?.();
  const io = createConfigIO({
    ...(options.ownedConfigPathForWrite ? { configPath: options.ownedConfigPathForWrite } : {}),
    ...(options.skipPluginValidation ? { pluginValidation: "skip" as const } : {}),
    ...(options.preservedLegacyRootKeys
      ? { preservedLegacyRootKeys: options.preservedLegacyRootKeys }
      : {}),
  });
  assertConfigWriteAllowedInCurrentMode({ configPath: io.configPath });
  let nextCfg = cfg;
  const runtimeConfigSnapshot = getRuntimeConfigSnapshotState();
  const runtimeConfigSourceSnapshot = getRuntimeConfigSourceSnapshotState();
  const hadRuntimeSnapshot = Boolean(runtimeConfigSnapshot);
  const hadBothSnapshots = Boolean(runtimeConfigSnapshot && runtimeConfigSourceSnapshot);
  if (hadBothSnapshots) {
    const runtimePatch = createMergePatch(runtimeConfigSnapshot!, cfg);
    nextCfg = coerceConfig(applyMergePatch(runtimeConfigSourceSnapshot!, runtimePatch));
  }
  const baseSnapshotRead = options.baseSnapshot
    ? {
        snapshot: options.baseSnapshot,
        pluginMetadataSnapshot: options.basePluginMetadataSnapshot,
      }
    : await io.readConfigFileSnapshotWithPluginMetadata();
  const baseSnapshot = baseSnapshotRead.snapshot;
  let runtimePreflightResult: unknown;
  const writeResult = await io.writeConfigFile(nextCfg, {
    baseSnapshot,
    basePluginMetadataSnapshot: baseSnapshotRead.pluginMetadataSnapshot,
    assertConfigPathForWrite: options.assertConfigPathForWrite,
    envSnapshotForRestore: resolveWriteEnvSnapshotForPath({
      actualConfigPath: io.configPath,
      expectedConfigPath: options.expectedConfigPath,
      envSnapshotForRestore: options.envSnapshotForRestore,
    }),
    unsetPaths: resolveManagedUnsetPathsForWrite(options.unsetPaths),
    explicitSetPaths: options.explicitSetPaths,
    explicitSetValueSource: options.explicitSetPaths
      ? (options.explicitSetValueSource ?? cfg)
      : undefined,
    afterWrite: options.afterWrite,
    allowDestructiveWrite: options.allowDestructiveWrite,
    allowConfigSizeDrop: options.allowConfigSizeDrop,
    skipRuntimeSnapshotRefresh: options.skipRuntimeSnapshotRefresh,
    skipOutputLogs: options.skipOutputLogs,
    skipPluginValidation: options.skipPluginValidation,
    preservedLegacyRootKeys: options.preservedLegacyRootKeys,
    lastTouchedVersionOverride: options.lastTouchedVersionOverride,
    preCommitRuntimePreflight: async (sourceConfig) => {
      runtimePreflightResult = await preflightRuntimeSnapshotWrite({
        nextSourceConfig: sourceConfig,
        refreshOptions: options.runtimeRefresh,
        formatRefreshError: (error) => formatErrorMessage(error),
        createRefreshError: (detail, cause) =>
          new ConfigRuntimeRefreshError(
            `Config write blocked before committing ${io.configPath}: active SecretRef resolution failed: ${detail}`,
            { cause },
          ),
      });
    },
  });
  if (
    options.skipRuntimeSnapshotRefresh &&
    !hadRuntimeSnapshot &&
    !getRuntimeConfigSnapshotRefreshHandlerState()
  ) {
    return writeResult;
  }
  // Re-read the freshly persisted file so the sourceConfig we publish matches
  // exactly what readConfigFileSnapshot() will produce when the file-watcher
  // path next picks up an external edit. Without this, the in-process write
  // path emits `nextCfg` (the pre-write source merge) while the file-watcher
  // path emits a sourceConfig that has additionally been shaped by include/
  // env resolution, legacy migration, and the shipped-plugin-install strip.
  // The two diverge on schema-derived defaults that the read pipeline adds
  // but `nextCfg` never sees, so the gateway reload pump's
  // currentCompareConfig drifts permanently from on-disk state and diffs out
  // phantom paths under plugins.entries.* on every save — incorrectly
  // triggering a `plugins`-scoped restart of the gateway for changes that
  // never touched any plugin entry.
  let canonicalSourceConfig: OpenClawConfig = nextCfg;
  const envBeforeCanonicalRead = snapshotEnv(process.env);
  let envAfterCanonicalRead;
  try {
    const freshSnapshot = await io.readConfigFileSnapshot();
    if (freshSnapshot.exists && freshSnapshot.valid) {
      canonicalSourceConfig = freshSnapshot.sourceConfig;
    }
  } catch {
    // Best-effort; fall back to nextCfg so a transient read failure does not
    // block the write notification.
  } finally {
    envAfterCanonicalRead = snapshotEnv(process.env);
  }
  const notifyCommittedWrite = () => {
    const currentRuntimeConfig = getRuntimeConfigSnapshotState();
    if (!currentRuntimeConfig) {
      return;
    }
    notifyRuntimeConfigWriteListeners(
      createRuntimeConfigWriteNotification({
        configPath: io.configPath,
        sourceConfig: canonicalSourceConfig,
        runtimeConfig: currentRuntimeConfig,
        persistedHash: writeResult.persistedHash,
        afterWrite: options.afterWrite,
      }),
    );
  };
  // Keep the last-known-good runtime snapshot active until the specialized refresh path
  // succeeds, so concurrent readers do not observe unresolved SecretRefs mid-refresh.
  try {
    options.assertConfigPathForWrite?.();
    await finalizeRuntimeSnapshotWrite({
      nextSourceConfig: canonicalSourceConfig,
      refreshOptions: options.runtimeRefresh,
      hadRuntimeSnapshot,
      hadBothSnapshots,
      loadFreshConfig: () => io.loadConfig(),
      notifyCommittedWrite,
      formatRefreshError: (error) => formatErrorMessage(error),
      preflightResult: runtimePreflightResult,
      createRefreshError: (detail, cause) =>
        new ConfigRuntimeRefreshError(
          `Config was written to ${io.configPath}, but runtime snapshot refresh failed: ${detail}`,
          { cause },
        ),
    });
  } catch (error) {
    try {
      const rolledBackConfig = await rollbackConfigFileWriteIfUnchanged({
        configPath: io.configPath,
        previousSnapshot: baseSnapshot,
        committedHash: writeResult.persistedHash,
        fsModule: fs,
      });
      if (rolledBackConfig) {
        restoreEnvChangesIfUnchanged({
          env: process.env,
          before: envBeforeCanonicalRead,
          after: envAfterCanonicalRead,
        });
        writeResult[configWritePostCommitRollback]?.();
      }
    } catch (rollbackError) {
      throw new ConfigRuntimeRefreshError(
        `${formatErrorMessage(error)} Rollback failed: ${formatErrorMessage(rollbackError)}`,
        { cause: error },
      );
    }
    throw error;
  }
  return { ...writeResult, persistedConfig: canonicalSourceConfig };
}
