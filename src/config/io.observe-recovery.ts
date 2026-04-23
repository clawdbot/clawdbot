import crypto from "node:crypto";
import path from "node:path";
import { isRecord } from "../utils.js";
import {
  appendConfigAuditRecord,
  appendConfigAuditRecordSync,
  type ConfigObserveAuditRecord,
} from "./io.audit.js";
import { resolveStateDir } from "./paths.js";
import type { ConfigFileSnapshot } from "./types.openclaw.js";

export type ObserveRecoveryDeps = {
  fs: {
    promises: {
      stat(path: string): Promise<{
        mtimeMs?: number;
        ctimeMs?: number;
        dev?: number | bigint;
        ino?: number | bigint;
        mode?: number;
        nlink?: number;
        uid?: number;
        gid?: number;
      } | null>;
      readFile(path: string, encoding: BufferEncoding): Promise<string>;
      writeFile(
        path: string,
        data: string,
        options?: { encoding?: BufferEncoding; mode?: number; flag?: string },
      ): Promise<unknown>;
      copyFile(src: string, dest: string): Promise<unknown>;
      chmod?(path: string, mode: number): Promise<unknown>;
      mkdir(path: string, options?: { recursive?: boolean; mode?: number }): Promise<unknown>;
      appendFile(
        path: string,
        data: string,
        options?: { encoding?: BufferEncoding; mode?: number },
      ): Promise<unknown>;
    };
    statSync(
      path: string,
      options?: { throwIfNoEntry?: boolean },
    ): {
      mtimeMs?: number;
      ctimeMs?: number;
      dev?: number | bigint;
      ino?: number | bigint;
      mode?: number;
      nlink?: number;
      uid?: number;
      gid?: number;
    } | null;
    readFileSync(path: string, encoding: BufferEncoding): string;
    writeFileSync(
      path: string,
      data: string,
      options?: { encoding?: BufferEncoding; mode?: number; flag?: string },
    ): unknown;
    copyFileSync(src: string, dest: string): unknown;
    chmodSync?(path: string, mode: number): unknown;
    mkdirSync(path: string, options?: { recursive?: boolean; mode?: number }): unknown;
    appendFileSync(
      path: string,
      data: string,
      options?: { encoding?: BufferEncoding; mode?: number },
    ): unknown;
  };
  json5: { parse(value: string): unknown };
  env: NodeJS.ProcessEnv;
  homedir: () => string;
  logger: Pick<typeof console, "warn">;
};

type ObserveSnapshot = {
  path: string;
  exists: boolean;
  valid: boolean;
  raw: string | null;
  hash?: string;
  parsed: unknown;
  resolved?: unknown;
};

type ConfigHealthFingerprint = {
  hash: string;
  bytes: number;
  mtimeMs: number | null;
  ctimeMs: number | null;
  dev: string | null;
  ino: string | null;
  mode: number | null;
  nlink: number | null;
  uid: number | null;
  gid: number | null;
  hasMeta: boolean;
  gatewayMode: string | null;
  observedAt: string;
};

type ConfigStatMetadataSource =
  | ({
      mtimeMs?: number;
      ctimeMs?: number;
      dev?: number | bigint;
      ino?: number | bigint;
      mode?: number;
      nlink?: number;
      uid?: number;
      gid?: number;
    } & Record<string, unknown>)
  | null;

type ConfigHealthEntry = {
  lastKnownGood?: ConfigHealthFingerprint;
  lastPromotedGood?: ConfigHealthFingerprint;
  lastObservedSuspiciousSignature?: string | null;
};

type ConfigHealthState = {
  entries?: Record<string, ConfigHealthEntry>;
};

function createConfigObserveAuditRecord(params: {
  ts: string;
  configPath: string;
  valid: boolean;
  current: ConfigHealthFingerprint;
  suspicious: string[];
  lastKnownGood: ConfigHealthFingerprint | undefined;
  backup: ConfigHealthFingerprint | null | undefined;
  clobberedPath: string | null;
  restoredFromBackup: boolean;
  restoredBackupPath: string | null;
}): ConfigObserveAuditRecord {
  return {
    ts: params.ts,
    source: "config-io",
    event: "config.observe",
    phase: "read",
    configPath: params.configPath,
    pid: process.pid,
    ppid: process.ppid,
    cwd: process.cwd(),
    argv: process.argv.slice(0, 8),
    execArgv: process.execArgv.slice(0, 8),
    exists: true,
    valid: params.valid,
    hash: params.current.hash,
    bytes: params.current.bytes,
    mtimeMs: params.current.mtimeMs,
    ctimeMs: params.current.ctimeMs,
    dev: params.current.dev,
    ino: params.current.ino,
    mode: params.current.mode,
    nlink: params.current.nlink,
    uid: params.current.uid,
    gid: params.current.gid,
    hasMeta: params.current.hasMeta,
    gatewayMode: params.current.gatewayMode,
    suspicious: params.suspicious,
    lastKnownGoodHash: params.lastKnownGood?.hash ?? null,
    lastKnownGoodBytes: params.lastKnownGood?.bytes ?? null,
    lastKnownGoodMtimeMs: params.lastKnownGood?.mtimeMs ?? null,
    lastKnownGoodCtimeMs: params.lastKnownGood?.ctimeMs ?? null,
    lastKnownGoodDev: params.lastKnownGood?.dev ?? null,
    lastKnownGoodIno: params.lastKnownGood?.ino ?? null,
    lastKnownGoodMode: params.lastKnownGood?.mode ?? null,
    lastKnownGoodNlink: params.lastKnownGood?.nlink ?? null,
    lastKnownGoodUid: params.lastKnownGood?.uid ?? null,
    lastKnownGoodGid: params.lastKnownGood?.gid ?? null,
    lastKnownGoodGatewayMode: params.lastKnownGood?.gatewayMode ?? null,
    backupHash: params.backup?.hash ?? null,
    backupBytes: params.backup?.bytes ?? null,
    backupMtimeMs: params.backup?.mtimeMs ?? null,
    backupCtimeMs: params.backup?.ctimeMs ?? null,
    backupDev: params.backup?.dev ?? null,
    backupIno: params.backup?.ino ?? null,
    backupMode: params.backup?.mode ?? null,
    backupNlink: params.backup?.nlink ?? null,
    backupUid: params.backup?.uid ?? null,
    backupGid: params.backup?.gid ?? null,
    backupGatewayMode: params.backup?.gatewayMode ?? null,
    clobberedPath: params.clobberedPath,
    restoredFromBackup: params.restoredFromBackup,
    restoredBackupPath: params.restoredBackupPath,
  };
}

type ConfigObserveAuditRecordParams = Parameters<typeof createConfigObserveAuditRecord>[0];

function createConfigObserveAuditAppendParams(
  deps: ObserveRecoveryDeps,
  params: ConfigObserveAuditRecordParams,
) {
  return {
    fs: deps.fs,
    env: deps.env,
    homedir: deps.homedir,
    record: createConfigObserveAuditRecord(params),
  };
}

function createConfigObserveAnomalyAuditAppendParams(
  deps: ObserveRecoveryDeps,
  params: Omit<ConfigObserveAuditRecordParams, "restoredFromBackup" | "restoredBackupPath">,
) {
  return createConfigObserveAuditAppendParams(deps, {
    ...params,
    restoredFromBackup: false,
    restoredBackupPath: null,
  });
}

function hashConfigRaw(raw: string | null): string {
  return crypto
    .createHash("sha256")
    .update(raw ?? "")
    .digest("hex");
}

function resolveConfigSnapshotHash(snapshot: {
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

function hasConfigMeta(value: unknown): boolean {
  return (
    isRecord(value) &&
    isRecord(value.meta) &&
    (typeof value.meta.lastTouchedVersion === "string" ||
      typeof value.meta.lastTouchedAt === "string")
  );
}

function resolveGatewayMode(value: unknown): string | null {
  if (!isRecord(value) || !isRecord(value.gateway)) {
    return null;
  }
  return typeof value.gateway.mode === "string" ? value.gateway.mode : null;
}

function resolveConfigStatMetadata(stat: ConfigStatMetadataSource): {
  dev: string | null;
  ino: string | null;
  mode: number | null;
  nlink: number | null;
  uid: number | null;
  gid: number | null;
} {
  if (!stat) {
    return {
      dev: null,
      ino: null,
      mode: null,
      nlink: null,
      uid: null,
      gid: null,
    };
  }
  return {
    dev: typeof stat.dev === "number" || typeof stat.dev === "bigint" ? String(stat.dev) : null,
    ino: typeof stat.ino === "number" || typeof stat.ino === "bigint" ? String(stat.ino) : null,
    mode: typeof stat.mode === "number" ? stat.mode : null,
    nlink: typeof stat.nlink === "number" ? stat.nlink : null,
    uid: typeof stat.uid === "number" ? stat.uid : null,
    gid: typeof stat.gid === "number" ? stat.gid : null,
  };
}

function createConfigHealthFingerprint(params: {
  hash: string;
  raw: string;
  parsed: unknown;
  gatewaySource: unknown;
  stat: ConfigStatMetadataSource;
  observedAt: string;
}): ConfigHealthFingerprint {
  return {
    hash: params.hash,
    bytes: Buffer.byteLength(params.raw, "utf-8"),
    mtimeMs: params.stat?.mtimeMs ?? null,
    ctimeMs: params.stat?.ctimeMs ?? null,
    ...resolveConfigStatMetadata(params.stat),
    hasMeta: hasConfigMeta(params.parsed),
    gatewayMode: resolveGatewayMode(params.gatewaySource),
    observedAt: params.observedAt,
  };
}

function parseConfigRawOrEmpty(deps: ObserveRecoveryDeps, raw: string): unknown {
  try {
    return deps.json5.parse(raw);
  } catch {
    return {};
  }
}

function resolveConfigHealthStatePath(env: NodeJS.ProcessEnv, homedir: () => string): string {
  return path.join(resolveStateDir(env, homedir), "logs", "config-health.json");
}

async function readConfigHealthState(deps: ObserveRecoveryDeps): Promise<ConfigHealthState> {
  try {
    const raw = await deps.fs.promises.readFile(
      resolveConfigHealthStatePath(deps.env, deps.homedir),
      "utf-8",
    );
    const parsed = deps.json5.parse(raw);
    return isRecord(parsed) ? (parsed as ConfigHealthState) : {};
  } catch {
    return {};
  }
}

function readConfigHealthStateSync(deps: ObserveRecoveryDeps): ConfigHealthState {
  try {
    const raw = deps.fs.readFileSync(resolveConfigHealthStatePath(deps.env, deps.homedir), "utf-8");
    const parsed = deps.json5.parse(raw);
    return isRecord(parsed) ? (parsed as ConfigHealthState) : {};
  } catch {
    return {};
  }
}

async function writeConfigHealthState(
  deps: ObserveRecoveryDeps,
  state: ConfigHealthState,
): Promise<void> {
  try {
    const healthPath = resolveConfigHealthStatePath(deps.env, deps.homedir);
    await deps.fs.promises.mkdir(path.dirname(healthPath), { recursive: true, mode: 0o700 });
    await deps.fs.promises.writeFile(healthPath, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: "utf-8",
      mode: 0o600,
    });
  } catch {}
}

function writeConfigHealthStateSync(deps: ObserveRecoveryDeps, state: ConfigHealthState): void {
  try {
    const healthPath = resolveConfigHealthStatePath(deps.env, deps.homedir);
    deps.fs.mkdirSync(path.dirname(healthPath), { recursive: true, mode: 0o700 });
    deps.fs.writeFileSync(healthPath, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: "utf-8",
      mode: 0o600,
    });
  } catch {}
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

function createLastObservedSuspiciousEntry(
  entry: ConfigHealthEntry,
  suspiciousSignature: string,
): ConfigHealthEntry {
  return {
    ...entry,
    lastObservedSuspiciousSignature: suspiciousSignature,
  };
}

function isUpdateChannelOnlyRoot(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "update") {
    return false;
  }
  const update = value.update;
  if (!isRecord(update)) {
    return false;
  }
  const updateKeys = Object.keys(update);
  return updateKeys.length === 1 && typeof update.channel === "string";
}

function resolveConfigObserveSuspiciousReasons(params: {
  bytes: number;
  hasMeta: boolean;
  gatewayMode: string | null;
  parsed: unknown;
  lastKnownGood?: ConfigHealthFingerprint;
}): string[] {
  const reasons: string[] = [];
  const baseline = params.lastKnownGood;
  if (!baseline) {
    return reasons;
  }
  if (baseline.bytes >= 512 && params.bytes < Math.floor(baseline.bytes * 0.5)) {
    reasons.push(`size-drop-vs-last-good:${baseline.bytes}->${params.bytes}`);
  }
  if (baseline.hasMeta && !params.hasMeta) {
    reasons.push("missing-meta-vs-last-good");
  }
  if (baseline.gatewayMode && !params.gatewayMode) {
    reasons.push("gateway-mode-missing-vs-last-good");
  }
  if (baseline.gatewayMode && isUpdateChannelOnlyRoot(params.parsed)) {
    reasons.push("update-channel-only-root");
  }
  return reasons;
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

async function readConfigFingerprintForPath(
  deps: ObserveRecoveryDeps,
  targetPath: string,
): Promise<ConfigHealthFingerprint | null> {
  try {
    const raw = await deps.fs.promises.readFile(targetPath, "utf-8");
    const stat = await deps.fs.promises.stat(targetPath).catch(() => null);
    const parsed = parseConfigRawOrEmpty(deps, raw);
    return createConfigHealthFingerprint({
      hash: hashConfigRaw(raw),
      raw,
      parsed,
      gatewaySource: parsed,
      stat: stat as ConfigStatMetadataSource,
      observedAt: new Date().toISOString(),
    });
  } catch {
    return null;
  }
}

function readConfigFingerprintForPathSync(
  deps: ObserveRecoveryDeps,
  targetPath: string,
): ConfigHealthFingerprint | null {
  try {
    const raw = deps.fs.readFileSync(targetPath, "utf-8");
    const stat = deps.fs.statSync(targetPath, { throwIfNoEntry: false }) ?? null;
    const parsed = parseConfigRawOrEmpty(deps, raw);
    return createConfigHealthFingerprint({
      hash: hashConfigRaw(raw),
      raw,
      parsed,
      gatewaySource: parsed,
      stat,
      observedAt: new Date().toISOString(),
    });
  } catch {
    return null;
  }
}

function formatConfigArtifactTimestamp(ts: string): string {
  return ts.replaceAll(":", "-").replaceAll(".", "-");
}

export function resolveLastKnownGoodConfigPath(configPath: string): string {
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

async function persistClobberedConfigSnapshot(params: {
  deps: ObserveRecoveryDeps;
  configPath: string;
  raw: string;
  observedAt: string;
}): Promise<string | null> {
  const targetPath = `${params.configPath}.clobbered.${formatConfigArtifactTimestamp(params.observedAt)}`;
  try {
    await params.deps.fs.promises.writeFile(targetPath, params.raw, {
      encoding: "utf-8",
      mode: 0o600,
      flag: "wx",
    });
    return targetPath;
  } catch {
    return null;
  }
}

function persistClobberedConfigSnapshotSync(params: {
  deps: ObserveRecoveryDeps;
  configPath: string;
  raw: string;
  observedAt: string;
}): string | null {
  const targetPath = `${params.configPath}.clobbered.${formatConfigArtifactTimestamp(params.observedAt)}`;
  try {
    params.deps.fs.writeFileSync(targetPath, params.raw, {
      encoding: "utf-8",
      mode: 0o600,
      flag: "wx",
    });
    return targetPath;
  } catch {
    return null;
  }
}

export async function maybeRecoverSuspiciousConfigRead(params: {
  deps: ObserveRecoveryDeps;
  configPath: string;
  raw: string;
  parsed: unknown;
}): Promise<{ raw: string; parsed: unknown }> {
  const stat = await params.deps.fs.promises.stat(params.configPath).catch(() => null);
  const now = new Date().toISOString();
  const current = createConfigHealthFingerprint({
    hash: hashConfigRaw(params.raw),
    raw: params.raw,
    parsed: params.parsed,
    gatewaySource: params.parsed,
    stat: stat as ConfigStatMetadataSource,
    observedAt: now,
  });

  let healthState = await readConfigHealthState(params.deps);
  const entry = getConfigHealthEntry(healthState, params.configPath);
  const backupPath = `${params.configPath}.bak`;
  const backupBaseline =
    entry.lastKnownGood ??
    (await readConfigFingerprintForPath(params.deps, backupPath)) ??
    undefined;
  const recoveryContext = resolveConfigReadRecoveryContext({
    current,
    parsed: params.parsed,
    entry,
    backupBaseline,
  });
  if (!recoveryContext) {
    return { raw: params.raw, parsed: params.parsed };
  }
  const { suspicious, suspiciousSignature } = recoveryContext;

  const backupRaw = await params.deps.fs.promises.readFile(backupPath, "utf-8").catch(() => null);
  if (!backupRaw) {
    return { raw: params.raw, parsed: params.parsed };
  }
  let backupParsed: unknown;
  try {
    backupParsed = params.deps.json5.parse(backupRaw);
  } catch {
    return { raw: params.raw, parsed: params.parsed };
  }
  const backup = backupBaseline ?? (await readConfigFingerprintForPath(params.deps, backupPath));
  if (!backup?.gatewayMode) {
    return { raw: params.raw, parsed: params.parsed };
  }

  const clobberedPath = await persistClobberedConfigSnapshot({
    deps: params.deps,
    configPath: params.configPath,
    raw: params.raw,
    observedAt: now,
  });

  let restoredFromBackup = false;
  try {
    await params.deps.fs.promises.copyFile(backupPath, params.configPath);
    restoredFromBackup = true;
  } catch {}

  params.deps.logger.warn(
    `Config auto-restored from backup: ${params.configPath} (${suspicious.join(", ")})`,
  );
  await appendConfigAuditRecord(
    createConfigObserveAuditAppendParams(params.deps, {
      ts: now,
      configPath: params.configPath,
      valid: true,
      current,
      suspicious,
      lastKnownGood: entry.lastKnownGood,
      backup,
      clobberedPath,
      restoredFromBackup,
      restoredBackupPath: backupPath,
    }),
  );

  healthState = setConfigHealthEntry(
    healthState,
    params.configPath,
    createLastObservedSuspiciousEntry(entry, suspiciousSignature),
  );
  await writeConfigHealthState(params.deps, healthState);
  return { raw: backupRaw, parsed: backupParsed };
}

export function maybeRecoverSuspiciousConfigReadSync(params: {
  deps: ObserveRecoveryDeps;
  configPath: string;
  raw: string;
  parsed: unknown;
}): { raw: string; parsed: unknown } {
  const stat = params.deps.fs.statSync(params.configPath, { throwIfNoEntry: false }) ?? null;
  const now = new Date().toISOString();
  const current = createConfigHealthFingerprint({
    hash: hashConfigRaw(params.raw),
    raw: params.raw,
    parsed: params.parsed,
    gatewaySource: params.parsed,
    stat,
    observedAt: now,
  });

  let healthState = readConfigHealthStateSync(params.deps);
  const entry = getConfigHealthEntry(healthState, params.configPath);
  const backupPath = `${params.configPath}.bak`;
  const backupBaseline =
    entry.lastKnownGood ?? readConfigFingerprintForPathSync(params.deps, backupPath) ?? undefined;
  const recoveryContext = resolveConfigReadRecoveryContext({
    current,
    parsed: params.parsed,
    entry,
    backupBaseline,
  });
  if (!recoveryContext) {
    return { raw: params.raw, parsed: params.parsed };
  }
  const { suspicious, suspiciousSignature } = recoveryContext;

  let backupRaw: string;
  try {
    backupRaw = params.deps.fs.readFileSync(backupPath, "utf-8");
  } catch {
    return { raw: params.raw, parsed: params.parsed };
  }
  let backupParsed: unknown;
  try {
    backupParsed = params.deps.json5.parse(backupRaw);
  } catch {
    return { raw: params.raw, parsed: params.parsed };
  }
  const backup = backupBaseline ?? readConfigFingerprintForPathSync(params.deps, backupPath);
  if (!backup?.gatewayMode) {
    return { raw: params.raw, parsed: params.parsed };
  }

  const clobberedPath = persistClobberedConfigSnapshotSync({
    deps: params.deps,
    configPath: params.configPath,
    raw: params.raw,
    observedAt: now,
  });

  let restoredFromBackup = false;
  try {
    params.deps.fs.copyFileSync(backupPath, params.configPath);
    restoredFromBackup = true;
  } catch {}

  params.deps.logger.warn(
    `Config auto-restored from backup: ${params.configPath} (${suspicious.join(", ")})`,
  );
  appendConfigAuditRecordSync(
    createConfigObserveAuditAppendParams(params.deps, {
      ts: now,
      configPath: params.configPath,
      valid: true,
      current,
      suspicious,
      lastKnownGood: entry.lastKnownGood,
      backup,
      clobberedPath,
      restoredFromBackup,
      restoredBackupPath: backupPath,
    }),
  );

  healthState = setConfigHealthEntry(
    healthState,
    params.configPath,
    createLastObservedSuspiciousEntry(entry, suspiciousSignature),
  );
  writeConfigHealthStateSync(params.deps, healthState);
  return { raw: backupRaw, parsed: backupParsed };
}

export async function observeConfigSnapshot(
  deps: ObserveRecoveryDeps,
  snapshot: ObserveSnapshot,
): Promise<void> {
  if (!snapshot.exists || typeof snapshot.raw !== "string") {
    return;
  }

  const stat = await deps.fs.promises.stat(snapshot.path).catch(() => null);
  const now = new Date().toISOString();
  const current = createConfigHealthFingerprint({
    hash: resolveConfigSnapshotHash(snapshot) ?? hashConfigRaw(snapshot.raw),
    raw: snapshot.raw,
    parsed: snapshot.parsed,
    gatewaySource: snapshot.resolved,
    stat: stat as ConfigStatMetadataSource,
    observedAt: now,
  });

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
      const same =
        entry.lastKnownGood &&
        entry.lastKnownGood.hash === current.hash &&
        entry.lastKnownGood.bytes === current.bytes &&
        entry.lastKnownGood.mtimeMs === current.mtimeMs &&
        entry.lastKnownGood.ctimeMs === current.ctimeMs &&
        entry.lastKnownGood.dev === current.dev &&
        entry.lastKnownGood.ino === current.ino &&
        entry.lastKnownGood.mode === current.mode &&
        entry.lastKnownGood.nlink === current.nlink &&
        entry.lastKnownGood.uid === current.uid &&
        entry.lastKnownGood.gid === current.gid &&
        entry.lastKnownGood.hasMeta === current.hasMeta &&
        entry.lastKnownGood.gatewayMode === current.gatewayMode;
      if (!same || entry.lastObservedSuspiciousSignature !== null) {
        healthState = setConfigHealthEntry(healthState, snapshot.path, nextEntry);
        await writeConfigHealthState(deps, healthState);
      }
    }
    return;
  }

  const suspiciousSignature = resolveSuspiciousSignature(current, suspicious);
  if (entry.lastObservedSuspiciousSignature === suspiciousSignature) {
    return;
  }

  const backup =
    (backupBaseline?.hash ? backupBaseline : null) ??
    (await readConfigFingerprintForPath(deps, `${snapshot.path}.bak`));
  const clobberedPath = await persistClobberedConfigSnapshot({
    deps,
    configPath: snapshot.path,
    raw: snapshot.raw,
    observedAt: now,
  });

  deps.logger.warn(`Config observe anomaly: ${snapshot.path} (${suspicious.join(", ")})`);
  await appendConfigAuditRecord(
    createConfigObserveAnomalyAuditAppendParams(deps, {
      ts: now,
      configPath: snapshot.path,
      valid: snapshot.valid,
      current,
      suspicious,
      lastKnownGood: entry.lastKnownGood,
      backup,
      clobberedPath,
    }),
  );

  healthState = setConfigHealthEntry(
    healthState,
    snapshot.path,
    createLastObservedSuspiciousEntry(entry, suspiciousSignature),
  );
  await writeConfigHealthState(deps, healthState);
}

export function observeConfigSnapshotSync(
  deps: ObserveRecoveryDeps,
  snapshot: ObserveSnapshot,
): void {
  if (!snapshot.exists || typeof snapshot.raw !== "string") {
    return;
  }

  const stat = deps.fs.statSync(snapshot.path, { throwIfNoEntry: false }) ?? null;
  const now = new Date().toISOString();
  const current = createConfigHealthFingerprint({
    hash: resolveConfigSnapshotHash(snapshot) ?? hashConfigRaw(snapshot.raw),
    raw: snapshot.raw,
    parsed: snapshot.parsed,
    gatewaySource: snapshot.resolved,
    stat,
    observedAt: now,
  });

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
      healthState = setConfigHealthEntry(healthState, snapshot.path, {
        ...entry,
        lastKnownGood: current,
        lastObservedSuspiciousSignature: null,
      });
      writeConfigHealthStateSync(deps, healthState);
    }
    return;
  }

  const suspiciousSignature = resolveSuspiciousSignature(current, suspicious);
  if (entry.lastObservedSuspiciousSignature === suspiciousSignature) {
    return;
  }

  const backup =
    (backupBaseline?.hash ? backupBaseline : null) ??
    readConfigFingerprintForPathSync(deps, `${snapshot.path}.bak`);
  const clobberedPath = persistClobberedConfigSnapshotSync({
    deps,
    configPath: snapshot.path,
    raw: snapshot.raw,
    observedAt: now,
  });

  deps.logger.warn(`Config observe anomaly: ${snapshot.path} (${suspicious.join(", ")})`);
  appendConfigAuditRecordSync(
    createConfigObserveAnomalyAuditAppendParams(deps, {
      ts: now,
      configPath: snapshot.path,
      valid: snapshot.valid,
      current,
      suspicious,
      lastKnownGood: entry.lastKnownGood,
      backup,
      clobberedPath,
    }),
  );

  healthState = setConfigHealthEntry(
    healthState,
    snapshot.path,
    createLastObservedSuspiciousEntry(entry, suspiciousSignature),
  );
  writeConfigHealthStateSync(deps, healthState);
}

export async function promoteConfigSnapshotToLastKnownGood(params: {
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
    hash: resolveConfigSnapshotHash(snapshot) ?? hashConfigRaw(snapshot.raw),
    raw: snapshot.raw,
    parsed: snapshot.parsed,
    gatewaySource: snapshot.resolved,
    stat: stat as ConfigStatMetadataSource,
    observedAt: now,
  });
  const lastGoodPath = resolveLastKnownGoodConfigPath(snapshot.path);
  await deps.fs.promises.writeFile(lastGoodPath, snapshot.raw, {
    encoding: "utf-8",
    mode: 0o600,
  });
  await deps.fs.promises.chmod?.(lastGoodPath, 0o600).catch(() => {});
  const healthState = await readConfigHealthState(deps);
  const entry = getConfigHealthEntry(healthState, snapshot.path);
  await writeConfigHealthState(
    deps,
    setConfigHealthEntry(healthState, snapshot.path, {
      ...entry,
      lastKnownGood: current,
      lastPromotedGood: current,
      lastObservedSuspiciousSignature: null,
    }),
  );
  return true;
}

export async function recoverConfigFromLastKnownGood(params: {
  deps: ObserveRecoveryDeps;
  snapshot: ConfigFileSnapshot;
  reason: string;
}): Promise<boolean> {
  const { deps, snapshot } = params;
  if (!snapshot.exists || typeof snapshot.raw !== "string") {
    return false;
  }
  const healthState = await readConfigHealthState(deps);
  const entry = getConfigHealthEntry(healthState, snapshot.path);
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
  const polluted = collectPollutedSecretPlaceholders(backupParsed);
  if (polluted.length > 0) {
    deps.logger.warn(
      `Config last-known-good recovery skipped: redacted secret placeholder at ${polluted[0]}`,
    );
    return false;
  }
  const now = new Date().toISOString();
  const stat = await deps.fs.promises.stat(snapshot.path).catch(() => null);
  const current = createConfigHealthFingerprint({
    hash: resolveConfigSnapshotHash(snapshot) ?? hashConfigRaw(snapshot.raw),
    raw: snapshot.raw,
    parsed: snapshot.parsed,
    gatewaySource: snapshot.resolved,
    stat: stat as ConfigStatMetadataSource,
    observedAt: now,
  });
  const clobberedPath = await persistClobberedConfigSnapshot({
    deps,
    configPath: snapshot.path,
    raw: snapshot.raw,
    observedAt: now,
  });
  await deps.fs.promises.copyFile(lastGoodPath, snapshot.path);
  await deps.fs.promises.chmod?.(snapshot.path, 0o600).catch(() => {});
  deps.logger.warn(
    `Config auto-restored from last-known-good: ${snapshot.path} (${params.reason})`,
  );
  await appendConfigAuditRecord(
    createConfigObserveAuditAppendParams(deps, {
      ts: now,
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
  await writeConfigHealthState(
    deps,
    setConfigHealthEntry(healthState, snapshot.path, {
      ...entry,
      lastKnownGood: promoted,
      lastPromotedGood: promoted,
      lastObservedSuspiciousSignature: null,
    }),
  );
  return true;
}
