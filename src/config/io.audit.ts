import path from "node:path";
import { resolveStateDir } from "./paths.js";

const CONFIG_AUDIT_LOG_FILENAME = "config-audit.jsonl";

export type ConfigWriteAuditResult = "rename" | "copy-fallback" | "failed" | "rejected";

export type ConfigWriteAuditRecord = {
  ts: string;
  source: "config-io";
  event: "config.write";
  result: ConfigWriteAuditResult;
  configPath: string;
  pid: number;
  ppid: number;
  cwd: string;
  argv: string[];
  execArgv: string[];
  watchMode: boolean;
  watchSession: string | null;
  watchCommand: string | null;
  existsBefore: boolean;
  previousHash: string | null;
  nextHash: string | null;
  previousBytes: number | null;
  nextBytes: number | null;
  previousDev: string | null;
  nextDev: string | null;
  previousIno: string | null;
  nextIno: string | null;
  previousMode: number | null;
  nextMode: number | null;
  previousNlink: number | null;
  nextNlink: number | null;
  previousUid: number | null;
  nextUid: number | null;
  previousGid: number | null;
  nextGid: number | null;
  changedPathCount: number | null;
  hasMetaBefore: boolean;
  hasMetaAfter: boolean;
  gatewayModeBefore: string | null;
  gatewayModeAfter: string | null;
  suspicious: string[];
  errorCode?: string;
  errorMessage?: string;
};

export type ConfigObserveAuditRecord = {
  ts: string;
  source: "config-io";
  event: "config.observe";
  phase: "read";
  configPath: string;
  pid: number;
  ppid: number;
  cwd: string;
  argv: string[];
  execArgv: string[];
  exists: boolean;
  valid: boolean;
  hash: string | null;
  bytes: number | null;
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
  suspicious: string[];
  lastKnownGoodHash: string | null;
  lastKnownGoodBytes: number | null;
  lastKnownGoodMtimeMs: number | null;
  lastKnownGoodCtimeMs: number | null;
  lastKnownGoodDev: string | null;
  lastKnownGoodIno: string | null;
  lastKnownGoodMode: number | null;
  lastKnownGoodNlink: number | null;
  lastKnownGoodUid: number | null;
  lastKnownGoodGid: number | null;
  lastKnownGoodGatewayMode: string | null;
  backupHash: string | null;
  backupBytes: number | null;
  backupMtimeMs: number | null;
  backupCtimeMs: number | null;
  backupDev: string | null;
  backupIno: string | null;
  backupMode: number | null;
  backupNlink: number | null;
  backupUid: number | null;
  backupGid: number | null;
  backupGatewayMode: string | null;
  clobberedPath: string | null;
  restoredFromBackup: boolean;
  restoredBackupPath: string | null;
};

export type ConfigAuditRecord = ConfigWriteAuditRecord | ConfigObserveAuditRecord;

export type ConfigAuditStatMetadata = {
  dev: string | null;
  ino: string | null;
  mode: number | null;
  nlink: number | null;
  uid: number | null;
  gid: number | null;
};

export type ConfigAuditProcessInfo = {
  pid: number;
  ppid: number;
  cwd: string;
  argv: string[];
  execArgv: string[];
};

export type ConfigWriteAuditRecordBase = Omit<
  ConfigWriteAuditRecord,
  | "result"
  | "nextDev"
  | "nextIno"
  | "nextMode"
  | "nextNlink"
  | "nextUid"
  | "nextGid"
  | "errorCode"
  | "errorMessage"
> & {
  nextHash: string;
  nextBytes: number;
};

type ConfigAuditFs = {
  promises: {
    mkdir(path: string, options?: { recursive?: boolean; mode?: number }): Promise<unknown>;
    appendFile(
      path: string,
      data: string,
      options?: { encoding?: BufferEncoding; mode?: number },
    ): Promise<unknown>;
  };
  mkdirSync(path: string, options?: { recursive?: boolean; mode?: number }): unknown;
  appendFileSync(
    path: string,
    data: string,
    options?: { encoding?: BufferEncoding; mode?: number },
  ): unknown;
};

function normalizeAuditLabel(value: string | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function resolveConfigAuditProcessInfo(
  processInfo?: ConfigAuditProcessInfo,
): ConfigAuditProcessInfo {
  if (processInfo) {
    return processInfo;
  }
  return {
    pid: process.pid,
    ppid: process.ppid,
    cwd: process.cwd(),
    argv: process.argv.slice(0, 8),
    execArgv: process.execArgv.slice(0, 8),
  };
}

export function resolveConfigAuditLogPath(env: NodeJS.ProcessEnv, homedir: () => string): string {
  return path.join(resolveStateDir(env, homedir), "logs", CONFIG_AUDIT_LOG_FILENAME);
}

export function formatConfigOverwriteLogMessage(params: {
  configPath: string;
  previousHash: string | null;
  nextHash: string;
  changedPathCount?: number;
}): string {
  const changeSummary =
    typeof params.changedPathCount === "number" ? `, changedPaths=${params.changedPathCount}` : "";
  return `Config overwrite: ${params.configPath} (sha256 ${params.previousHash ?? "unknown"} -> ${params.nextHash}, backup=${params.configPath}.bak${changeSummary})`;
}

export function createConfigWriteAuditRecordBase(params: {
  configPath: string;
  env: NodeJS.ProcessEnv;
  existsBefore: boolean;
  previousHash: string | null;
  nextHash: string;
  previousBytes: number | null;
  nextBytes: number;
  previousMetadata: ConfigAuditStatMetadata;
  changedPathCount: number | null | undefined;
  hasMetaBefore: boolean;
  hasMetaAfter: boolean;
  gatewayModeBefore: string | null;
  gatewayModeAfter: string | null;
  suspicious: string[];
  now?: string;
  processInfo?: ConfigAuditProcessInfo;
}): ConfigWriteAuditRecordBase {
  const processSnapshot = resolveConfigAuditProcessInfo(params.processInfo);
  return {
    ts: params.now ?? new Date().toISOString(),
    source: "config-io",
    event: "config.write",
    configPath: params.configPath,
    pid: processSnapshot.pid,
    ppid: processSnapshot.ppid,
    cwd: processSnapshot.cwd,
    argv: processSnapshot.argv,
    execArgv: processSnapshot.execArgv,
    watchMode: params.env.OPENCLAW_WATCH_MODE === "1",
    watchSession: normalizeAuditLabel(params.env.OPENCLAW_WATCH_SESSION),
    watchCommand: normalizeAuditLabel(params.env.OPENCLAW_WATCH_COMMAND),
    existsBefore: params.existsBefore,
    previousHash: params.previousHash,
    nextHash: params.nextHash,
    previousBytes: params.previousBytes,
    nextBytes: params.nextBytes,
    previousDev: params.previousMetadata.dev,
    previousIno: params.previousMetadata.ino,
    previousMode: params.previousMetadata.mode,
    previousNlink: params.previousMetadata.nlink,
    previousUid: params.previousMetadata.uid,
    previousGid: params.previousMetadata.gid,
    changedPathCount: typeof params.changedPathCount === "number" ? params.changedPathCount : null,
    hasMetaBefore: params.hasMetaBefore,
    hasMetaAfter: params.hasMetaAfter,
    gatewayModeBefore: params.gatewayModeBefore,
    gatewayModeAfter: params.gatewayModeAfter,
    suspicious: params.suspicious,
  };
}

export function finalizeConfigWriteAuditRecord(params: {
  base: ConfigWriteAuditRecordBase;
  result: ConfigWriteAuditResult;
  nextMetadata?: ConfigAuditStatMetadata | null;
  err?: unknown;
}): ConfigWriteAuditRecord {
  const errorCode =
    params.err &&
    typeof params.err === "object" &&
    "code" in params.err &&
    typeof params.err.code === "string"
      ? params.err.code
      : undefined;
  const errorMessage =
    params.err &&
    typeof params.err === "object" &&
    "message" in params.err &&
    typeof params.err.message === "string"
      ? params.err.message
      : undefined;
  const nextMetadata = params.nextMetadata ?? {
    dev: null,
    ino: null,
    mode: null,
    nlink: null,
    uid: null,
    gid: null,
  };
  const success = params.result !== "failed" && params.result !== "rejected";
  return {
    ...params.base,
    result: params.result,
    nextHash: success ? params.base.nextHash : null,
    nextBytes: success ? params.base.nextBytes : null,
    nextDev: success ? nextMetadata.dev : null,
    nextIno: success ? nextMetadata.ino : null,
    nextMode: success ? nextMetadata.mode : null,
    nextNlink: success ? nextMetadata.nlink : null,
    nextUid: success ? nextMetadata.uid : null,
    nextGid: success ? nextMetadata.gid : null,
    errorCode,
    errorMessage,
  };
}

type ConfigAuditAppendContext = {
  fs: ConfigAuditFs;
  env: NodeJS.ProcessEnv;
  homedir: () => string;
};

type ConfigAuditAppendParams = ConfigAuditAppendContext &
  (
    | {
        record: ConfigAuditRecord;
      }
    | ConfigAuditRecord
  );

function resolveConfigAuditAppendRecord(params: ConfigAuditAppendParams): ConfigAuditRecord {
  if ("record" in params) {
    return params.record;
  }
  const { fs: _fs, env: _env, homedir: _homedir, ...record } = params;
  return record as ConfigAuditRecord;
}

export async function appendConfigAuditRecord(params: ConfigAuditAppendParams): Promise<void> {
  try {
    const auditPath = resolveConfigAuditLogPath(params.env, params.homedir);
    const record = resolveConfigAuditAppendRecord(params);
    await params.fs.promises.mkdir(path.dirname(auditPath), { recursive: true, mode: 0o700 });
    await params.fs.promises.appendFile(auditPath, `${JSON.stringify(record)}\n`, {
      encoding: "utf-8",
      mode: 0o600,
    });
  } catch {
    // best-effort
  }
}

export function appendConfigAuditRecordSync(params: ConfigAuditAppendParams): void {
  try {
    const auditPath = resolveConfigAuditLogPath(params.env, params.homedir);
    const record = resolveConfigAuditAppendRecord(params);
    params.fs.mkdirSync(path.dirname(auditPath), { recursive: true, mode: 0o700 });
    params.fs.appendFileSync(auditPath, `${JSON.stringify(record)}\n`, {
      encoding: "utf-8",
      mode: 0o600,
    });
  } catch {
    // best-effort
  }
}
