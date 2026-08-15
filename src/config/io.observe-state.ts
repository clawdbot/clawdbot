import type fs from "node:fs";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { snapshotConfigAuditProcessInfo, type ConfigObserveAuditRecord } from "./io.audit.js";
import type {
  ConfigHealthEntry,
  ConfigHealthFingerprint,
  ConfigHealthState,
} from "./io.health-state.js";
import {
  hashConfigRaw,
  hasConfigMeta,
  parseConfigJson5,
  resolveGatewayMode,
} from "./io.read-helpers.js";
import type { NormalizedConfigIoDeps } from "./io.types.js";
import { resolveConfigStatMetadata } from "./io.write-safety.js";

type ConfigFingerprintDeps = Pick<NormalizedConfigIoDeps, "fs" | "json5">;

export function readConfigHealthEntry(
  state: ConfigHealthState,
  configPath: string,
): ConfigHealthEntry {
  const entry = state.entries?.[configPath];
  return isRecord(entry) ? entry : {};
}

export function updateConfigHealthEntry(
  state: ConfigHealthState,
  configPath: string,
  entry: ConfigHealthEntry,
): ConfigHealthState {
  return {
    ...state,
    entries: { ...state.entries, [configPath]: entry },
  };
}

export function createConfigHealthFingerprint(params: {
  raw: string;
  parsed: unknown;
  resolved?: unknown;
  stat: fs.Stats | null;
  hash?: string;
  observedAt?: string;
}): ConfigHealthFingerprint {
  return {
    hash: params.hash ?? hashConfigRaw(params.raw),
    bytes: Buffer.byteLength(params.raw, "utf-8"),
    mtimeMs: params.stat?.mtimeMs ?? null,
    ctimeMs: params.stat?.ctimeMs ?? null,
    ...resolveConfigStatMetadata(params.stat),
    hasMeta: hasConfigMeta(params.parsed),
    gatewayMode: resolveGatewayMode(params.resolved ?? params.parsed),
    observedAt: params.observedAt ?? new Date().toISOString(),
  };
}

function createConfigFingerprintFromRead(params: {
  deps: ConfigFingerprintDeps;
  raw: string;
  stat: fs.Stats | null;
}): ConfigHealthFingerprint {
  const parsed = parseConfigJson5(params.raw, params.deps.json5);
  return createConfigHealthFingerprint({
    raw: params.raw,
    parsed: parsed.ok ? parsed.parsed : {},
    stat: params.stat,
  });
}

export async function readConfigFingerprintForPath(
  deps: ConfigFingerprintDeps,
  configPath: string,
): Promise<ConfigHealthFingerprint | null> {
  try {
    const raw = await deps.fs.promises.readFile(configPath, "utf-8");
    const stat = await deps.fs.promises.stat(configPath).catch(() => null);
    return createConfigFingerprintFromRead({ deps, raw, stat });
  } catch {
    return null;
  }
}

export function readConfigFingerprintForPathSync(
  deps: ConfigFingerprintDeps,
  configPath: string,
): ConfigHealthFingerprint | null {
  try {
    const raw = deps.fs.readFileSync(configPath, "utf-8");
    let stat: fs.Stats | null = null;
    try {
      stat = deps.fs.statSync(configPath, { throwIfNoEntry: false }) ?? null;
    } catch {
      // Metadata is diagnostic only; readable backup bytes remain authoritative.
    }
    return createConfigFingerprintFromRead({ deps, raw, stat });
  } catch {
    return null;
  }
}

export function createConfigObserveAuditRecord(params: {
  configPath: string;
  valid: boolean;
  current: ConfigHealthFingerprint;
  suspicious: string[];
  lastKnownGood: ConfigHealthFingerprint | undefined;
  backup: ConfigHealthFingerprint | null | undefined;
  clobberedPath?: string | null;
  restoredFromBackup?: boolean;
  restoredBackupPath?: string | null;
  restoreErrorCode?: string | null;
  restoreErrorMessage?: string | null;
}): ConfigObserveAuditRecord {
  const { current, lastKnownGood, backup } = params;
  return {
    ts: current.observedAt,
    source: "config-io",
    event: "config.observe",
    phase: "read",
    configPath: params.configPath,
    ...snapshotConfigAuditProcessInfo(),
    exists: true,
    valid: params.valid,
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
    suspicious: params.suspicious,
    lastKnownGoodHash: lastKnownGood?.hash ?? null,
    lastKnownGoodBytes: lastKnownGood?.bytes ?? null,
    lastKnownGoodMtimeMs: lastKnownGood?.mtimeMs ?? null,
    lastKnownGoodCtimeMs: lastKnownGood?.ctimeMs ?? null,
    lastKnownGoodDev: lastKnownGood?.dev ?? null,
    lastKnownGoodIno: lastKnownGood?.ino ?? null,
    lastKnownGoodMode: lastKnownGood?.mode ?? null,
    lastKnownGoodNlink: lastKnownGood?.nlink ?? null,
    lastKnownGoodUid: lastKnownGood?.uid ?? null,
    lastKnownGoodGid: lastKnownGood?.gid ?? null,
    lastKnownGoodGatewayMode: lastKnownGood?.gatewayMode ?? null,
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
    clobberedPath: params.clobberedPath ?? null,
    restoredFromBackup: params.restoredFromBackup ?? false,
    restoredBackupPath: params.restoredBackupPath ?? null,
    restoreErrorCode: params.restoreErrorCode ?? null,
    restoreErrorMessage: params.restoreErrorMessage ?? null,
  };
}
