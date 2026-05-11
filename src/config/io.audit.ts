import path from "node:path";
import { redactSecrets, redactToolPayloadText } from "../logging/redact.js";
import { resolveStateDir } from "./paths.js";

const CONFIG_AUDIT_ARGV_CAP = 8;

// Conservative list of credential-bearing flags. The heuristic suffix
// classifier below catches the long tail (`--custom-api-key`,
// `--alibaba-model-studio-api-key`, plugin-defined `cliFlag` values, etc.)
// without needing every name enumerated here.
const SECRET_FLAG_NAMES = new Set([
  "--token",
  "--api-key",
  "--apikey",
  "--secret",
  "--password",
  "--passwd",
  "--auth-token",
  "--access-token",
  "--refresh-token",
  "--client-secret",
  "--hook-token",
  "--gateway-token",
  "--bot-token",
  "--app-token",
  "--remote-token",
  "--push-token",
  "--webhook-secret",
  "--webhook-token",
  "--service-account-token",
  "--op-service-account-token",
  "--bearer",
  "--bearer-token",
  "--pat",
  "--personal-access-token",
  "--oauth-token",
  "--id-token",
  "--identity-token",
  "--session-token",
  "--service-token",
  "--private-key",
  "--recovery-key",
  "--gateway-key",
  "--session-key",
  "--active-key",
]);

// Suffix-based heuristic. Any `--…-(token|secret|password|passwd|api-key|
// apikey|api-secret|webhook|credential|bearer|pat|private-key|recovery-key|
// signing-key|encryption-key|master-key|session-key|gateway-key|service-key|
// hook-key)` is treated as a secret flag in addition to the explicit list.
// The leading `--` is required so we don't mismatch arbitrary positional args.
const SECRET_FLAG_SUFFIX_PATTERN =
  /^--(?:[a-z0-9]+(?:-[a-z0-9]+)*-)?(?:token|secret|password|passwd|api[-_]?key|api[-_]?secret|webhook|credential|bearer|pat|private[-_]?key|recovery[-_]?key|signing[-_]?key|encryption[-_]?key|master[-_]?key|session[-_]?key|gateway[-_]?key|service[-_]?key|hook[-_]?key)$/;

function isSecretFlagName(flagName: string | null): boolean {
  if (flagName === null) {
    return false;
  }
  if (SECRET_FLAG_NAMES.has(flagName)) {
    return true;
  }
  return SECRET_FLAG_SUFFIX_PATTERN.test(flagName);
}

function parseFlagName(arg: string): string | null {
  if (typeof arg !== "string" || !arg.startsWith("--")) {
    return null;
  }
  const eq = arg.indexOf("=");
  return (eq === -1 ? arg : arg.slice(0, eq)).toLowerCase();
}

// Redacts CLI argv before it lands in the persistent config-audit log.
// Layers, applied per element:
//  1. `--flag=value` form for any name matching the explicit list or the
//     suffix heuristic — mask the value half.
//  2. value following a bare `--flag` form — emit `***` instead of the
//     next arg, even if it starts with `-`. Command parsers accept
//     dash-leading values for required options, and this persistent audit
//     log should fail closed.
//  3. fall back to redactToolPayloadText for everything else, which catches
//     `KEY=VALUE` env-style assignments, raw token shapes (sk-, ghp_, xox*,
//     gsk_, AIza*, npm_, Telegram bot tokens, PEM blocks, Bearer headers,
//     URL query secrets) using the shared redaction patterns.
export function redactConfigAuditArgv(argv: readonly string[]): string[] {
  const result: string[] = [];
  let redactNext = false;
  for (let i = 0; i < argv.length; i++) {
    const current = argv[i];
    if (typeof current !== "string") {
      result.push(current);
      redactNext = false;
      continue;
    }
    if (redactNext) {
      redactNext = false;
      result.push("***");
      continue;
    }
    const currentFlag = parseFlagName(current);
    if (currentFlag !== null && isSecretFlagName(currentFlag)) {
      if (current.includes("=")) {
        const eq = current.indexOf("=");
        result.push(`${current.slice(0, eq + 1)}***`);
        continue;
      }
      result.push(current);
      redactNext = true;
      continue;
    }
    result.push(redactToolPayloadText(current));
  }
  return result;
}

function capArgv(argv: readonly string[] | undefined): string[] {
  if (!Array.isArray(argv)) {
    return [];
  }
  return argv.slice(0, CONFIG_AUDIT_ARGV_CAP);
}

export function snapshotConfigAuditProcessInfo(): ConfigAuditProcessInfo {
  return {
    pid: process.pid,
    ppid: process.ppid,
    cwd: process.cwd(),
    argv: redactConfigAuditArgv(capArgv(process.argv)),
    execArgv: redactConfigAuditArgv(capArgv(process.execArgv)),
  };
}

const CONFIG_AUDIT_LOG_FILENAME = "config-audit.jsonl";

export type ConfigWriteAuditResult = "rename" | "copy-fallback" | "failed" | "rejected";

type ConfigWriteAuditRecord = {
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
  restoreErrorCode: string | null;
  restoreErrorMessage: string | null;
};

type ConfigAuditRecord = ConfigWriteAuditRecord | ConfigObserveAuditRecord;

type ConfigAuditStatMetadata = {
  dev: string | null;
  ino: string | null;
  mode: number | null;
  nlink: number | null;
  uid: number | null;
  gid: number | null;
};

type ConfigAuditProcessInfo = {
  pid: number;
  ppid: number;
  cwd: string;
  argv: string[];
  execArgv: string[];
};

type ConfigWriteAuditRecordBase = Omit<
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
    return {
      ...processInfo,
      argv: redactConfigAuditArgv(capArgv(processInfo.argv)),
      execArgv: redactConfigAuditArgv(capArgv(processInfo.execArgv)),
    };
  }
  return snapshotConfigAuditProcessInfo();
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
    return redactSecrets(params.record);
  }
  const { fs: _fs, env: _env, homedir: _homedir, ...record } = params;
  return redactSecrets(record as ConfigAuditRecord);
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
