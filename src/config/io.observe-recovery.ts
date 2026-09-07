// Observes and recovers config files that appear missing, corrupt, or clobbered.
import type fs from "node:fs";
import path from "node:path";
import { replaceFileAtomic, replaceFileAtomicSync } from "../infra/replace-file.js";
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
import {
  isRecoverableConfigReadSuspiciousReason,
  resolveConfigObserveSuspiciousReasons,
} from "./io.observe-suspicious.js";
import { hashConfigRaw } from "./io.read-helpers.js";
import type {
  ConfigRecoveryCandidate,
  ConfigRecoveryCandidatePreparation,
  NormalizedConfigIoDeps,
  PrepareConfigRecoveryCandidate,
} from "./io.types.js";
import { warnIfJSON5CommentsWillBeStripped } from "./json5-comments.js";

export type ObserveRecoveryDeps = Pick<
  NormalizedConfigIoDeps,
  "fs" | "json5" | "env" | "homedir"
> & {
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

export async function chmodConfigBestEffort(params: {
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

export function createRecoveryCommitEffect(params: {
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

export function createConfigObserveAuditAppendParams(
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
  restoredSourceLabel: string;
  restoreErrorMessage: string | null;
}): void {
  if (params.restoredFromBackup) {
    params.deps.logger.warn(
      `Config auto-restored from ${params.restoredSourceLabel}: ${params.configPath} (${params.suspicious.join(", ")})`,
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

export function resolveLastKnownGoodConfigPath(configPath: string): string {
  return `${configPath}.last-good`;
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

// Reads a retained `.last-good` payload and accepts it as a recovery source
// only when its bytes still match the recorded accepted-baseline hash. Any
// mismatch (missing file, divergent bytes, unparsable JSON5, rejected
// candidate) returns null so the caller falls back to the explicit path
// instead of restoring unverified bytes.
function* prepareLastGoodRecoverySource(params: {
  deps: ObserveRecoveryDeps;
  prepareBackup: PrepareConfigRecoveryCandidate;
  lastGoodPath: string;
  baselineHash: string;
}): Generator<
  ConfigRecoveryEffect<unknown>,
  {
    raw: string;
    candidate: { raw: string; parsed: unknown };
    fingerprint: ConfigHealthFingerprint;
  } | null,
  unknown
> {
  const { deps } = params;
  // SAFETY: the backup read effect resolves to the retained payload or null.
  const lastGoodRaw = (yield createConfigBackupReadEffect(deps, params.lastGoodPath)) as
    | string
    | null;
  if (!lastGoodRaw || hashConfigRaw(lastGoodRaw) !== params.baselineHash) {
    return null;
  }
  const lastGoodParse = parseBackupConfigRaw(deps, lastGoodRaw);
  if (!lastGoodParse) {
    return null;
  }
  const prepared = (yield {
    sync: () => params.prepareBackup({ raw: lastGoodRaw, parsed: lastGoodParse.parsed }),
    async: () => params.prepareBackup({ raw: lastGoodRaw, parsed: lastGoodParse.parsed }),
    // SAFETY: the preparation effect resolves to the prepared candidate result.
  }) as ConfigRecoveryCandidatePreparation;
  if (!prepared.ok) {
    return null;
  }
  const lastGoodStat = (yield createConfigRecoveryStatEffect(
    deps,
    params.lastGoodPath,
    // SAFETY: the stat effect resolves to the retained payload's stats or null.
  )) as fs.Stats | null;
  const fingerprint = createConfigHealthFingerprint({
    raw: lastGoodRaw,
    parsed: lastGoodParse.parsed,
    stat: lastGoodStat,
  });
  if (!fingerprint.gatewayMode) {
    return null;
  }
  return { raw: lastGoodRaw, candidate: prepared.candidate, fingerprint };
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
  const backupParse = backupRaw ? parseBackupConfigRaw(deps, backupRaw) : null;
  // A metadata-free accepted baseline can only be hand-authored (product
  // writers always stamp `meta`), so a `.bak` holding different bytes predates
  // the operator's file and restoring it would silently revert that config.
  // Recovery therefore prefers the retained `.last-good` payload when Gateway
  // promoted one and its hash still matches the accepted baseline; without a
  // verified copy the state stays on the explicit doctor path.
  const baseline = entry.lastKnownGood;
  // Source selection needs only the retained baseline's hash, so it happens
  // before any source-specific preparation: an unusable `.bak` must not gate
  // access to a verified `.last-good` payload promoted for these exact bytes.
  const preferLastGoodSource = Boolean(
    baseline?.hash &&
    !baseline.hasMeta &&
    (!backupRaw || !backupParse || hashConfigRaw(backupRaw) !== baseline.hash),
  );
  let restoreSourceRaw: string;
  let restoreSourcePath: string;
  let restoreSourceContext: string;
  let restoredSourceLabel: string;
  let backup: ConfigHealthFingerprint;
  let preparedCandidateFinal: ConfigRecoveryCandidate;
  if (preferLastGoodSource && baseline?.hash) {
    const lastGoodSource = yield* prepareLastGoodRecoverySource({
      deps,
      prepareBackup: params.prepareBackup,
      lastGoodPath: resolveLastKnownGoodConfigPath(configPath),
      baselineHash: baseline.hash,
    });
    if (!lastGoodSource) {
      deps.logger.warn(
        `Config auto-restore from backup skipped: ${configPath} (${suspicious.join(", ")}); accepted baseline is hand-authored and no verified last-good copy exists`,
      );
      return returnOriginalConfigRead(params);
    }
    restoreSourceRaw = lastGoodSource.raw;
    restoreSourcePath = resolveLastKnownGoodConfigPath(configPath);
    restoreSourceContext = "last-good restore";
    restoredSourceLabel = "last-good";
    backup = lastGoodSource.fingerprint;
    preparedCandidateFinal = lastGoodSource.candidate;
  } else {
    if (!backupRaw || !backupParse) {
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
    // Eligibility must describe the approved backup bytes, never an older healthy config.
    const backupStat = (yield createConfigRecoveryStatEffect(deps, backupPath)) as fs.Stats | null;
    backup = createConfigHealthFingerprint({
      raw: backupRaw,
      parsed: backupParse.parsed,
      stat: backupStat,
    });
    if (!backup.gatewayMode) {
      return returnOriginalConfigRead(params);
    }
    restoreSourceRaw = backupRaw;
    restoreSourcePath = backupPath;
    restoreSourceContext = "backup restore";
    restoredSourceLabel = "backup";
    preparedCandidateFinal = prepared.candidate;
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
    if (preparedCandidateFinal.raw !== restoreSourceRaw) {
      warnIfJSON5CommentsWillBeStripped({
        raw: restoreSourceRaw,
        filePath: configPath,
        warn: (message) => deps.logger.warn(message),
      });
    }
    yield createRecoveryCommitEffect({ deps, configPath, raw: preparedCandidateFinal.raw });
    const chmodParams = { deps, configPath, context: restoreSourceContext };
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
    restoredSourceLabel,
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
    backupPath: restoreSourcePath,
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
  return preparedCandidateFinal;
}
