import type fs from "node:fs";
import { isRecord } from "../utils.js";
import {
  appendConfigAuditRecord,
  appendConfigAuditRecordSync,
  snapshotConfigAuditProcessInfo,
  type ConfigObserveAuditRecord,
} from "./io.audit.js";
import {
  readConfigHealthStateFromStore,
  writeConfigHealthStateToStore,
  type ConfigHealthEntry,
  type ConfigHealthFingerprint,
  type ConfigHealthState,
} from "./io.health-state.js";
import { resolveConfigObserveSuspiciousReasons } from "./io.observe-suspicious.js";
import {
  hashConfigRaw,
  hasConfigMeta,
  parseConfigJson5,
  resolveConfigSnapshotHash,
  resolveGatewayMode,
} from "./io.read-helpers.js";
import type { NormalizedConfigIoDeps } from "./io.types.js";
import { resolveConfigStatMetadata } from "./io.write-safety.js";
import type { ConfigFileSnapshot } from "./types.js";

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
    entries: { ...state.entries, [configPath]: entry },
  };
}

function fingerprintFromRaw(
  raw: string,
  stat: fs.Stats | null,
  parsed: unknown,
  resolved: unknown,
): ConfigHealthFingerprint {
  return {
    hash: hashConfigRaw(raw),
    bytes: Buffer.byteLength(raw, "utf-8"),
    mtimeMs: stat?.mtimeMs ?? null,
    ctimeMs: stat?.ctimeMs ?? null,
    ...resolveConfigStatMetadata(stat),
    hasMeta: hasConfigMeta(parsed),
    gatewayMode: resolveGatewayMode(resolved),
    observedAt: new Date().toISOString(),
  };
}

async function readConfigFingerprintForPath(
  deps: NormalizedConfigIoDeps,
  targetPath: string,
): Promise<ConfigHealthFingerprint | null> {
  try {
    const raw = await deps.fs.promises.readFile(targetPath, "utf-8");
    const stat = await deps.fs.promises.stat(targetPath).catch(() => null);
    const parsed = parseConfigJson5(raw, deps.json5);
    const value = parsed.ok ? parsed.parsed : {};
    return fingerprintFromRaw(raw, stat, value, value);
  } catch {
    return null;
  }
}

function readConfigFingerprintForPathSync(
  deps: NormalizedConfigIoDeps,
  targetPath: string,
): ConfigHealthFingerprint | null {
  try {
    const raw = deps.fs.readFileSync(targetPath, "utf-8");
    const stat = deps.fs.statSync(targetPath, { throwIfNoEntry: false }) ?? null;
    const parsed = parseConfigJson5(raw, deps.json5);
    const value = parsed.ok ? parsed.parsed : {};
    return fingerprintFromRaw(raw, stat, value, value);
  } catch {
    return null;
  }
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

function createObservedFingerprint(snapshot: ConfigFileSnapshot, stat: fs.Stats | null) {
  const raw = snapshot.raw as string;
  return {
    ...fingerprintFromRaw(raw, stat, snapshot.parsed, snapshot.resolved),
    hash: resolveConfigSnapshotHash(snapshot) ?? hashConfigRaw(raw),
  };
}

function createObserveAuditRecord(params: {
  snapshot: ConfigFileSnapshot;
  current: ConfigHealthFingerprint;
  suspicious: string[];
  entry: ConfigHealthEntry;
  backup: ConfigHealthFingerprint | null;
}): ConfigObserveAuditRecord {
  const { snapshot, current, suspicious, entry, backup } = params;
  return {
    ts: current.observedAt,
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
  };
}

function resolveObservation(params: {
  snapshot: ConfigFileSnapshot;
  current: ConfigHealthFingerprint;
  healthState: ConfigHealthState;
  backupBaseline?: ConfigHealthFingerprint;
}) {
  const entry = getConfigHealthEntry(params.healthState, params.snapshot.path);
  const baseline = entry.lastKnownGood ?? params.backupBaseline;
  const suspicious = resolveConfigObserveSuspiciousReasons({
    bytes: params.current.bytes,
    hasMeta: params.current.hasMeta,
    gatewayMode: params.current.gatewayMode,
    parsed: params.snapshot.parsed,
    lastKnownGood: baseline,
  });
  return { entry, baseline, suspicious };
}

function updateHealthyObservation(params: {
  snapshot: ConfigFileSnapshot;
  current: ConfigHealthFingerprint;
  entry: ConfigHealthEntry;
  healthState: ConfigHealthState;
}): ConfigHealthState | null {
  if (!params.snapshot.valid) {
    return null;
  }
  const nextEntry: ConfigHealthEntry = {
    ...params.entry,
    lastKnownGood: params.current,
    lastObservedSuspiciousSignature: null,
  };
  return !sameFingerprint(params.entry.lastKnownGood, params.current) ||
    params.entry.lastObservedSuspiciousSignature !== null
    ? setConfigHealthEntry(params.healthState, params.snapshot.path, nextEntry)
    : null;
}

export async function observeConfigSnapshot(
  deps: NormalizedConfigIoDeps,
  snapshot: ConfigFileSnapshot,
): Promise<void> {
  if (!snapshot.exists || typeof snapshot.raw !== "string") {
    return;
  }
  const stat = await deps.fs.promises.stat(snapshot.path).catch(() => null);
  const current = createObservedFingerprint(snapshot, stat);
  let healthState = readConfigHealthStateFromStore(deps);
  const backupPath = `${snapshot.path}.bak`;
  const initialEntry = getConfigHealthEntry(healthState, snapshot.path);
  const backupBaseline =
    initialEntry.lastKnownGood ??
    (await readConfigFingerprintForPath(deps, backupPath)) ??
    undefined;
  const { entry, baseline, suspicious } = resolveObservation({
    snapshot,
    current,
    healthState,
    backupBaseline,
  });
  if (suspicious.length === 0) {
    const nextState = updateHealthyObservation({ snapshot, current, entry, healthState });
    if (nextState) {
      writeConfigHealthStateToStore(deps, nextState);
    }
    return;
  }
  const signature = `${current.hash}:${suspicious.join(",")}`;
  if (entry.lastObservedSuspiciousSignature === signature) {
    return;
  }
  const backup =
    (baseline?.hash ? baseline : null) ?? (await readConfigFingerprintForPath(deps, backupPath));
  deps.logger.warn(`Config observe anomaly: ${snapshot.path} (${suspicious.join(", ")})`);
  await appendConfigAuditRecord({
    env: deps.env,
    homedir: deps.homedir,
    record: createObserveAuditRecord({ snapshot, current, suspicious, entry, backup }),
  });
  healthState = setConfigHealthEntry(healthState, snapshot.path, {
    ...entry,
    lastObservedSuspiciousSignature: signature,
  });
  writeConfigHealthStateToStore(deps, healthState);
}

export function observeConfigSnapshotSync(
  deps: NormalizedConfigIoDeps,
  snapshot: ConfigFileSnapshot,
): void {
  if (!snapshot.exists || typeof snapshot.raw !== "string") {
    return;
  }
  const stat = deps.fs.statSync(snapshot.path, { throwIfNoEntry: false }) ?? null;
  const current = createObservedFingerprint(snapshot, stat);
  let healthState = readConfigHealthStateFromStore(deps);
  const backupPath = `${snapshot.path}.bak`;
  const initialEntry = getConfigHealthEntry(healthState, snapshot.path);
  const backupBaseline =
    initialEntry.lastKnownGood ?? readConfigFingerprintForPathSync(deps, backupPath) ?? undefined;
  const { entry, baseline, suspicious } = resolveObservation({
    snapshot,
    current,
    healthState,
    backupBaseline,
  });
  if (suspicious.length === 0) {
    const nextState = updateHealthyObservation({ snapshot, current, entry, healthState });
    if (nextState) {
      writeConfigHealthStateToStore(deps, nextState);
    }
    return;
  }
  const signature = `${current.hash}:${suspicious.join(",")}`;
  if (entry.lastObservedSuspiciousSignature === signature) {
    return;
  }
  const backup =
    (baseline?.hash ? baseline : null) ?? readConfigFingerprintForPathSync(deps, backupPath);
  deps.logger.warn(`Config observe anomaly: ${snapshot.path} (${suspicious.join(", ")})`);
  appendConfigAuditRecordSync({
    env: deps.env,
    homedir: deps.homedir,
    record: createObserveAuditRecord({ snapshot, current, suspicious, entry, backup }),
  });
  healthState = setConfigHealthEntry(healthState, snapshot.path, {
    ...entry,
    lastObservedSuspiciousSignature: signature,
  });
  writeConfigHealthStateToStore(deps, healthState);
}
