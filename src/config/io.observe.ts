import type fs from "node:fs";
import { appendConfigAuditRecord, appendConfigAuditRecordSync } from "./io.audit.js";
import {
  readConfigHealthStateFromStore,
  writeConfigHealthStateToStore,
  type ConfigHealthEntry,
  type ConfigHealthFingerprint,
  type ConfigHealthState,
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
import { resolveConfigSnapshotHash } from "./io.read-helpers.js";
import type { NormalizedConfigIoDeps } from "./io.types.js";
import type { ConfigFileSnapshot } from "./types.js";

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
  return createConfigHealthFingerprint({
    raw,
    parsed: snapshot.parsed,
    resolved: snapshot.resolved,
    stat,
    hash: resolveConfigSnapshotHash(snapshot) ?? undefined,
  });
}

function resolveObservation(params: {
  snapshot: ConfigFileSnapshot;
  current: ConfigHealthFingerprint;
  healthState: ConfigHealthState;
  backupBaseline?: ConfigHealthFingerprint;
}) {
  const entry = readConfigHealthEntry(params.healthState, params.snapshot.path);
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
    ? updateConfigHealthEntry(params.healthState, params.snapshot.path, nextEntry)
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
  const initialEntry = readConfigHealthEntry(healthState, snapshot.path);
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
    record: createConfigObserveAuditRecord({
      configPath: snapshot.path,
      valid: snapshot.valid,
      current,
      suspicious,
      lastKnownGood: entry.lastKnownGood,
      backup,
    }),
  });
  healthState = updateConfigHealthEntry(healthState, snapshot.path, {
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
  const initialEntry = readConfigHealthEntry(healthState, snapshot.path);
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
    record: createConfigObserveAuditRecord({
      configPath: snapshot.path,
      valid: snapshot.valid,
      current,
      suspicious,
      lastKnownGood: entry.lastKnownGood,
      backup,
    }),
  });
  healthState = updateConfigHealthEntry(healthState, snapshot.path, {
    ...entry,
    lastObservedSuspiciousSignature: signature,
  });
  writeConfigHealthStateToStore(deps, healthState);
}
