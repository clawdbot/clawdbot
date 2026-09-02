// Observes and recovers config files that appear missing, corrupt, or clobbered.
import type fs from "node:fs";
import path from "node:path";
import { replaceFileAtomic, replaceFileAtomicSync } from "../infra/replace-file.js";
import { isRecord } from "../utils.js";
import { appendConfigAuditRecord, appendConfigAuditRecordSync } from "./io.audit.js";
import {
  persistBoundedClobberedConfigSnapshot,
  persistBoundedClobberedConfigSnapshotSync,
} from "./io.clobber-snapshot.js";
import {
  readConfigHealthStateFromStore,
  writeConfigHealthStateToStore,
  type ConfigHealthEntry,
  type ConfigHealthFingerprint,
} from "./io.health-state.js";
import {
  createConfigHealthFingerprint,
  createConfigObserveAuditRecord,
  readConfigFingerprintForPath,
  readConfigFingerprintForPathSync,
  readConfigHealthEntry,
  updateConfigHealthEntry,
} from "./io.observe-state.js";
import { resolveConfigObserveSuspiciousReasons } from "./io.observe-suspicious.js";
import { hashConfigRaw, resolveConfigSnapshotHash } from "./io.read-helpers.js";
import type {
  ConfigRecoveryCandidatePreparation,
  NormalizedConfigIoDeps,
  PrepareConfigRecoveryCandidate,
} from "./io.types.js";
import { formatConfigIssueSummary } from "./issue-format.js";
import { warnIfJSON5CommentsWillBeStripped } from "./json5-comments.js";
import {
  isPluginLocalInvalidConfigSnapshot,
  shouldAttemptLastKnownGoodRecovery,
} from "./recovery-policy.js";
import type { ConfigFileSnapshot } from "./types.openclaw.js";

type ObserveRecoveryDeps = Pick<NormalizedConfigIoDeps, "fs" | "json5" | "env" | "homedir"> & {
  logger: Pick<typeof console, "warn">;
};

function formatConfigPermissionHardeningWarning(params: {
  configPath: string;
  context: string;
  error: unknown;
}): string {
  const detail = params.error instanceof Error ? params.error.message : String(params.error);
  return `Config permission hardening failed (${params.context}): ${params.configPath}: ${detail}`;
}

async function chmodConfigBestEffort(params: {
  deps: ObserveRecoveryDeps;
  configPath: string;
  context: string;
}): Promise<void> {
  try {
    await params.deps.fs.promises.chmod?.(params.configPath, 0o600);
  } catch (error) {
    params.deps.logger.warn(
      formatConfigPermissionHardeningWarning({
        configPath: params.configPath,
        context: params.context,
        error,
      }),
    );
  }
}

function chmodConfigBestEffortSync(params: {
  deps: ObserveRecoveryDeps;
  configPath: string;
  context: string;
}): void {
  try {
    params.deps.fs.chmodSync?.(params.configPath, 0o600);
  } catch (error) {
    params.deps.logger.warn(
      formatConfigPermissionHardeningWarning({
        configPath: params.configPath,
        context: params.context,
        error,
      }),
    );
  }
}
type ConfigReadRecoveryParams = {
  deps: ObserveRecoveryDeps;
  configPath: string;
  raw: string;
  parsed: unknown;
  prepareBackup: PrepareConfigRecoveryCandidate;
  allowBackupRecovery?: () => Promise<boolean>;
};

type ConfigReadRecoveryResult = {
  raw: string;
  parsed: unknown;
};

function createRecoveryCommitEffect(params: {
  deps: ObserveRecoveryDeps;
  configPath: string;
  raw: string;
}): ConfigRecoveryEffect<void> {
  const options = {
    filePath: params.configPath,
    content: params.raw,
    dirMode: 0o700,
    mode: 0o600,
    tempPrefix: path.basename(params.configPath),
    fileSystem: params.deps.fs,
  };
  return {
    sync: () => {
      replaceFileAtomicSync(options);
    },
    async: async () => {
      await replaceFileAtomic(options);
    },
  };
}

type ConfigObserveAuditRecordParams = Parameters<typeof createConfigObserveAuditRecord>[0];

function createConfigObserveAuditAppendParams(
  deps: ObserveRecoveryDeps,
  params: ConfigObserveAuditRecordParams,
) {
  return {
    env: deps.env,
    homedir: deps.homedir,
    record: createConfigObserveAuditRecord(params),
  };
}

function extractRestoreErrorDetails(error: unknown): {
  code: string | null;
  message: string | null;
} {
  if (!error || typeof error !== "object") {
    return { code: null, message: typeof error === "string" ? error : null };
  }
  const code =
    "code" in error && typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code
      : null;
  const message =
    "message" in error && typeof (error as { message?: unknown }).message === "string"
      ? (error as { message: string }).message
      : null;
  return { code, message };
}

function returnOriginalConfigRead(params: ConfigReadRecoveryParams): ConfigReadRecoveryResult {
  return { raw: params.raw, parsed: params.parsed };
}

function parseBackupConfigRaw(
  deps: ObserveRecoveryDeps,
  backupRaw: string,
): { parsed: unknown } | null {
  try {
    return { parsed: deps.json5.parse(backupRaw) };
  } catch {
    return null;
  }
}

function logBackupRestoreResult(params: {
  deps: ObserveRecoveryDeps;
  configPath: string;
  suspicious: string[];
  restoredFromBackup: boolean;
  restoreErrorMessage: string | null;
}): void {
  if (params.restoredFromBackup) {
    params.deps.logger.warn(
      `Config auto-restored from backup: ${params.configPath} (${params.suspicious.join(", ")})`,
    );
    return;
  }
  params.deps.logger.warn(
    `Config auto-restore from backup failed: ${params.configPath} (${params.suspicious.join(", ")}${
      params.restoreErrorMessage ? `; ${params.restoreErrorMessage}` : ""
    })`,
  );
}

function createBackupRestoreAuditAppendParams(params: {
  deps: ObserveRecoveryDeps;
  configPath: string;
  restoredFromBackup: boolean;
  current: ConfigHealthFingerprint;
  suspicious: string[];
  entry: ConfigHealthEntry;
  backup: ConfigHealthFingerprint | null | undefined;
  clobberedPath: string | null;
  backupPath: string;
  restoreErrorDetails: { code: string | null; message: string | null };
}) {
  return createConfigObserveAuditAppendParams(params.deps, {
    configPath: params.configPath,
    valid: params.restoredFromBackup,
    current: params.current,
    suspicious: params.suspicious,
    lastKnownGood: params.entry.lastKnownGood,
    backup: params.backup,
    clobberedPath: params.clobberedPath,
    restoredFromBackup: params.restoredFromBackup,
    restoredBackupPath: params.backupPath,
    restoreErrorCode: params.restoreErrorDetails.code,
    restoreErrorMessage: params.restoreErrorDetails.message,
  });
}

function resolveSuspiciousSignature(
  current: ConfigHealthFingerprint,
  suspicious: string[],
): string {
  return `${current.hash}:${suspicious.join(",")}`;
}

function isRecoverableConfigReadSuspiciousReason(reason: string): boolean {
  return (
    reason === "missing-meta-vs-last-good" ||
    reason === "gateway-mode-missing-vs-last-good" ||
    reason === "update-channel-only-root" ||
    reason.startsWith("size-drop-vs-last-good:")
  );
}

function resolveConfigReadRecoveryContext(params: {
  current: ConfigHealthFingerprint;
  parsed: unknown;
  entry: ConfigHealthEntry;
  backupBaseline?: ConfigHealthFingerprint;
}): { suspicious: string[]; suspiciousSignature: string } | null {
  const suspicious = resolveConfigObserveSuspiciousReasons({
    bytes: params.current.bytes,
    hasMeta: params.current.hasMeta,
    gatewayMode: params.current.gatewayMode,
    parsed: params.parsed,
    lastKnownGood: params.backupBaseline,
  });
  if (!suspicious.some(isRecoverableConfigReadSuspiciousReason)) {
    return null;
  }
  const suspiciousSignature = resolveSuspiciousSignature(params.current, suspicious);
  if (params.entry.lastObservedSuspiciousSignature === suspiciousSignature) {
    return null;
  }
  return { suspicious, suspiciousSignature };
}

function resolveLastKnownGoodConfigPath(configPath: string): string {
  return `${configPath}.last-good`;
}

function isSensitiveConfigPath(pathLabel: string): boolean {
  return /(^|\.)(api[-_]?key|auth|bearer|credential|password|private[-_]?key|secret|token)(\.|$)/i.test(
    pathLabel,
  );
}

function collectPollutedSecretPlaceholders(
  value: unknown,
  pathLabel = "",
  output: string[] = [],
): string[] {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "***" || trimmed === "[redacted]") {
      output.push(pathLabel || "<root>");
      return output;
    }
    if (isSensitiveConfigPath(pathLabel) && (trimmed.includes("...") || trimmed.includes("…"))) {
      output.push(pathLabel || "<root>");
    }
    return output;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      collectPollutedSecretPlaceholders(item, `${pathLabel}[${index}]`, output),
    );
    return output;
  }
  if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      const childPath = pathLabel ? `${pathLabel}.${key}` : key;
      collectPollutedSecretPlaceholders(child, childPath, output);
    }
  }
  return output;
}

export async function maybeRecoverSuspiciousConfigRead(
  params: ConfigReadRecoveryParams,
): Promise<ConfigReadRecoveryResult> {
  const recovery = recoverSuspiciousConfigRead(params);
  let step = recovery.next();
  while (!step.done) {
    try {
      step = recovery.next(await step.value.async());
    } catch (error) {
      step = recovery.throw(error);
    }
  }
  return step.value;
}

export function maybeRecoverSuspiciousConfigReadSync(
  params: ConfigReadRecoveryParams,
): ConfigReadRecoveryResult {
  const recovery = recoverSuspiciousConfigRead(params);
  let step = recovery.next();
  while (!step.done) {
    try {
      step = recovery.next(step.value.sync());
    } catch (error) {
      step = recovery.throw(error);
    }
  }
  return step.value;
}

type ConfigRecoveryEffect<T> = {
  sync: () => T;
  async: () => T | Promise<T>;
};

function createConfigRecoveryStatEffect(
  deps: ObserveRecoveryDeps,
  configPath: string,
): ConfigRecoveryEffect<fs.Stats | null> {
  return {
    sync: () => {
      try {
        return deps.fs.statSync(configPath, { throwIfNoEntry: false }) ?? null;
      } catch {
        return null;
      }
    },
    async: () => deps.fs.promises.stat(configPath).catch(() => null),
  };
}

function createConfigBackupReadEffect(
  deps: ObserveRecoveryDeps,
  backupPath: string,
): ConfigRecoveryEffect<string | null> {
  return {
    sync: () => {
      try {
        return deps.fs.readFileSync(backupPath, "utf-8");
      } catch {
        return null;
      }
    },
    async: () => deps.fs.promises.readFile(backupPath, "utf-8").catch(() => null),
  };
}

function* recoverSuspiciousConfigRead(
  params: ConfigReadRecoveryParams,
): Generator<ConfigRecoveryEffect<unknown>, ConfigReadRecoveryResult, unknown> {
  const { deps, configPath, raw, parsed } = params;
  const stat = (yield createConfigRecoveryStatEffect(deps, configPath)) as fs.Stats | null;
  const now = new Date().toISOString();
  const current = createConfigHealthFingerprint({
    raw,
    parsed,
    stat,
    observedAt: now,
  });
  const healthState = readConfigHealthStateFromStore(deps);
  const entry = readConfigHealthEntry(healthState, configPath);
  const backupPath = `${configPath}.bak`;
  const backupBaseline =
    entry.lastKnownGood ??
    ((yield {
      sync: () => readConfigFingerprintForPathSync(deps, backupPath),
      async: () => readConfigFingerprintForPath(deps, backupPath),
    }) as ConfigHealthFingerprint | null) ??
    undefined;
  const recoveryContext = resolveConfigReadRecoveryContext({
    current,
    parsed,
    entry,
    backupBaseline,
  });
  if (!recoveryContext) {
    return returnOriginalConfigRead(params);
  }
  const { suspicious, suspiciousSignature } = recoveryContext;
  const backupRaw = (yield createConfigBackupReadEffect(deps, backupPath)) as string | null;
  if (!backupRaw) {
    return returnOriginalConfigRead(params);
  }
  const backupParse = parseBackupConfigRaw(deps, backupRaw);
  if (!backupParse) {
    return returnOriginalConfigRead(params);
  }
  const backupCandidate = { raw: backupRaw, parsed: backupParse.parsed };
  const prepared = (yield {
    sync: () => params.prepareBackup(backupCandidate),
    async: () => params.prepareBackup(backupCandidate),
  }) as ConfigRecoveryCandidatePreparation;
  if (!prepared.ok) {
    return returnOriginalConfigRead(params);
  }
  const preparedCandidate = prepared.candidate;
  // Eligibility must describe the approved backup bytes, never an older healthy config.
  const backupStat = (yield createConfigRecoveryStatEffect(deps, backupPath)) as fs.Stats | null;
  const backup = createConfigHealthFingerprint({
    raw: backupRaw,
    parsed: backupParse.parsed,
    stat: backupStat,
  });
  if (!backup.gatewayMode) {
    return returnOriginalConfigRead(params);
  }
  if (params.allowBackupRecovery) {
    const allowed = (yield {
      sync: () => true,
      async: () => params.allowBackupRecovery?.() ?? true,
    }) as boolean;
    if (!allowed) {
      return returnOriginalConfigRead(params);
    }
  }
  const snapshotParams = {
    deps,
    configPath,
    raw,
    observedAt: now,
  };
  const clobberedPath = (yield {
    sync: () => persistBoundedClobberedConfigSnapshotSync(snapshotParams),
    async: () => persistBoundedClobberedConfigSnapshot(snapshotParams),
  }) as string | null;
  let restoredFromBackup = false;
  let restoreError: unknown;
  try {
    if (preparedCandidate.raw !== backupRaw) {
      warnIfJSON5CommentsWillBeStripped({
        raw: backupRaw,
        filePath: configPath,
        warn: (message) => deps.logger.warn(message),
      });
    }
    yield createRecoveryCommitEffect({ deps, configPath, raw: preparedCandidate.raw });
    const chmodParams = { deps, configPath, context: "backup restore" };
    yield {
      sync: () => chmodConfigBestEffortSync(chmodParams),
      async: () => chmodConfigBestEffort(chmodParams),
    };
    restoredFromBackup = true;
  } catch (error) {
    restoreError = error;
  }
  const restoreErrorDetails = restoredFromBackup
    ? { code: null, message: null }
    : extractRestoreErrorDetails(restoreError);
  logBackupRestoreResult({
    deps,
    configPath,
    suspicious,
    restoredFromBackup,
    restoreErrorMessage: restoreErrorDetails.message,
  });
  const audit = createBackupRestoreAuditAppendParams({
    deps,
    configPath,
    restoredFromBackup,
    current,
    suspicious,
    entry,
    backup,
    clobberedPath,
    backupPath,
    restoreErrorDetails,
  });
  yield {
    sync: () => appendConfigAuditRecordSync(audit),
    async: () => appendConfigAuditRecord(audit),
  };
  if (restoredFromBackup) {
    writeConfigHealthStateToStore(
      deps,
      updateConfigHealthEntry(healthState, configPath, {
        ...entry,
        lastObservedSuspiciousSignature: suspiciousSignature,
      }),
    );
  }
  return preparedCandidate;
}

export async function promoteConfigSnapshotToLastKnownGoodCore(params: {
  deps: ObserveRecoveryDeps;
  snapshot: ConfigFileSnapshot;
  logger?: Pick<typeof console, "warn">;
}): Promise<boolean> {
  const { deps, snapshot } = params;
  if (!snapshot.exists || !snapshot.valid || typeof snapshot.raw !== "string") {
    return false;
  }
  const polluted = collectPollutedSecretPlaceholders(snapshot.parsed);
  if (polluted.length > 0) {
    params.logger?.warn(
      `Config last-known-good promotion skipped: redacted secret placeholder at ${polluted[0]}`,
    );
    return false;
  }
  const stat = await deps.fs.promises.stat(snapshot.path).catch(() => null);
  const now = new Date().toISOString();
  const current = createConfigHealthFingerprint({
    hash: resolveConfigSnapshotHash(snapshot) ?? undefined,
    raw: snapshot.raw,
    parsed: snapshot.parsed,
    resolved: snapshot.resolved,
    stat,
    observedAt: now,
  });
  const lastGoodPath = resolveLastKnownGoodConfigPath(snapshot.path);
  await deps.fs.promises.writeFile(lastGoodPath, snapshot.raw, {
    encoding: "utf-8",
    mode: 0o600,
  });
  await chmodConfigBestEffort({
    deps,
    configPath: lastGoodPath,
    context: "last-known-good promotion",
  });
  const healthState = readConfigHealthStateFromStore(deps);
  const entry = readConfigHealthEntry(healthState, snapshot.path);
  writeConfigHealthStateToStore(
    deps,
    updateConfigHealthEntry(healthState, snapshot.path, {
      ...entry,
      lastKnownGood: current,
      lastPromotedGood: current,
      lastObservedSuspiciousSignature: null,
    }),
  );
  return true;
}

export async function recoverConfigFromLastKnownGoodCore(params: {
  deps: ObserveRecoveryDeps;
  snapshot: ConfigFileSnapshot;
  reason: string;
  prepareCandidate: PrepareConfigRecoveryCandidate;
}): Promise<boolean> {
  const { deps, snapshot } = params;
  if (!snapshot.exists || typeof snapshot.raw !== "string") {
    return false;
  }
  if (!shouldAttemptLastKnownGoodRecovery(snapshot)) {
    if (isPluginLocalInvalidConfigSnapshot(snapshot)) {
      deps.logger.warn(
        `Config last-known-good recovery skipped: invalidity is scoped to stale plugin config (${params.reason})`,
      );
    }
    return false;
  }
  const healthState = readConfigHealthStateFromStore(deps);
  const entry = readConfigHealthEntry(healthState, snapshot.path);
  const promoted = entry.lastPromotedGood;
  if (!promoted?.hash) {
    return false;
  }
  const lastGoodPath = resolveLastKnownGoodConfigPath(snapshot.path);
  const backupRaw = await deps.fs.promises.readFile(lastGoodPath, "utf-8").catch(() => null);
  if (!backupRaw || hashConfigRaw(backupRaw) !== promoted.hash) {
    return false;
  }
  let backupParsed: unknown;
  try {
    backupParsed = deps.json5.parse(backupRaw);
  } catch {
    return false;
  }
  // Historical bytes become live config only after their owner has migrated and validated them.
  // This prevents Doctor recovery from exposing a schema-invalid intermediate file.
  const originalCandidate = { raw: backupRaw, parsed: backupParsed };
  const prepared = params.prepareCandidate(originalCandidate);
  if (!prepared.ok) {
    deps.logger.warn(
      `Config last-known-good recovery skipped: ${prepared.reason} (${params.reason})`,
    );
    return false;
  }
  const recoveryCandidate = prepared.candidate;
  const polluted = collectPollutedSecretPlaceholders(recoveryCandidate.parsed);
  if (polluted.length > 0) {
    deps.logger.warn(
      `Config last-known-good recovery skipped: redacted secret placeholder at ${polluted[0]}`,
    );
    return false;
  }
  const now = new Date().toISOString();
  const stat = await deps.fs.promises.stat(snapshot.path).catch(() => null);
  const current = createConfigHealthFingerprint({
    hash: resolveConfigSnapshotHash(snapshot) ?? undefined,
    raw: snapshot.raw,
    parsed: snapshot.parsed,
    resolved: snapshot.resolved,
    stat,
    observedAt: now,
  });
  const clobberedPath = await preserveConfigSnapshotAsClobberedCore({
    deps,
    snapshot,
    observedAt: now,
  });
  if (recoveryCandidate.raw !== backupRaw) {
    warnIfJSON5CommentsWillBeStripped({
      raw: backupRaw,
      filePath: snapshot.path,
      warn: (message) => deps.logger.warn(message),
    });
  }
  await createRecoveryCommitEffect({
    deps,
    configPath: snapshot.path,
    raw: recoveryCandidate.raw,
  }).async();
  await chmodConfigBestEffort({
    deps,
    configPath: snapshot.path,
    context: "last-known-good recovery",
  });
  const issueSummary = formatConfigIssueSummary([...snapshot.issues, ...snapshot.legacyIssues]);
  deps.logger.warn(
    `Config auto-restored from last-known-good: ${snapshot.path} (${params.reason})${issueSummary ? `; Rejected validation details: ${issueSummary}.` : ""}`,
  );
  await appendConfigAuditRecord(
    createConfigObserveAuditAppendParams(deps, {
      configPath: snapshot.path,
      valid: snapshot.valid,
      current,
      suspicious: [params.reason],
      lastKnownGood: promoted,
      backup: promoted,
      clobberedPath,
      restoredFromBackup: true,
      restoredBackupPath: lastGoodPath,
    }),
  );
  writeConfigHealthStateToStore(
    deps,
    updateConfigHealthEntry(healthState, snapshot.path, {
      ...entry,
      lastKnownGood: promoted,
      lastPromotedGood: promoted,
      lastObservedSuspiciousSignature: null,
    }),
  );
  return true;
}

async function preserveConfigSnapshotAsClobberedCore(params: {
  deps: ObserveRecoveryDeps;
  snapshot: ConfigFileSnapshot;
  observedAt?: string;
}): Promise<string | null> {
  if (!params.snapshot.exists || typeof params.snapshot.raw !== "string") {
    return null;
  }
  return await persistBoundedClobberedConfigSnapshot({
    deps: params.deps,
    configPath: params.snapshot.path,
    raw: params.snapshot.raw,
    observedAt: params.observedAt ?? new Date().toISOString(),
  });
}
