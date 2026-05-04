import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Logger as TsLogger } from "tslog";
import type { OpenClawConfig } from "../config/types.js";
import { emitDiagnosticEvent } from "../infra/diagnostic-events.js";
import {
  getActiveDiagnosticTraceContext,
  isValidDiagnosticSpanId,
  isValidDiagnosticTraceFlags,
  isValidDiagnosticTraceId,
  type DiagnosticTraceContext,
} from "../infra/diagnostic-trace-context.js";
import { expandHomePrefix } from "../infra/home-dir.js";
import { isBlockedObjectKey } from "../infra/prototype-keys.js";
import {
  POSIX_OPENCLAW_TMP_DIR,
  resolvePreferredOpenClawTmpDir,
} from "../infra/tmp-openclaw-dir.js";
import { readLoggingConfig, shouldSkipMutatingLoggingConfigRead } from "./config.js";
import { resolveEnvLogLevelOverride } from "./env-log-level.js";
import { type LogLevel, levelToMinLevel, normalizeLogLevel } from "./levels.js";
import { redactSensitiveText } from "./redact.js";
import { loggingState } from "./state.js";
import { formatTimestamp } from "./timestamps.js";
import type { LoggerSettings } from "./types.js";
export type { LoggerSettings } from "./types.js";

type ProcessWithBuiltinModule = NodeJS.Process & {
  getBuiltinModule?: (id: string) => unknown;
};

function canUseNodeFs(): boolean {
  const getBuiltinModule = (process as ProcessWithBuiltinModule).getBuiltinModule;
  if (typeof getBuiltinModule !== "function") {
    return false;
  }
  try {
    return getBuiltinModule("fs") !== undefined;
  } catch {
    return false;
  }
}

function resolveDefaultLogDir(): string {
  return canUseNodeFs() ? resolvePreferredOpenClawTmpDir() : POSIX_OPENCLAW_TMP_DIR;
}

function resolveDefaultLogFile(defaultLogDir: string): string {
  return canUseNodeFs()
    ? path.join(defaultLogDir, "openclaw.log")
    : `${POSIX_OPENCLAW_TMP_DIR}/openclaw.log`;
}

export const DEFAULT_LOG_DIR = resolveDefaultLogDir();
export const DEFAULT_LOG_FILE = resolveDefaultLogFile(DEFAULT_LOG_DIR); // legacy single-file path

const LOG_PREFIX = "openclaw";
const LOG_SUFFIX = ".log";
const MAX_LOG_AGE_MS = 24 * 60 * 60 * 1000; // 24h
const DEFAULT_MAX_LOG_FILE_BYTES = 100 * 1024 * 1024; // 100 MB
const MAX_ROTATED_LOG_FILES = 5;

type LogObj = { date?: Date } & Record<string, unknown>;

type ResolvedSettings = {
  level: LogLevel;
  file: string;
  maxFileBytes: number;
};
export type LoggerResolvedSettings = ResolvedSettings;
type TsLogRecord = Record<string, unknown>;

type DiagnosticLogCode = {
  line?: number;
  functionName?: string;
};

const MAX_DIAGNOSTIC_LOG_BINDINGS_JSON_CHARS = 8 * 1024;
const MAX_DIAGNOSTIC_LOG_MESSAGE_CHARS = 4 * 1024;
const MAX_DIAGNOSTIC_LOG_ATTRIBUTE_COUNT = 32;
const MAX_DIAGNOSTIC_LOG_ATTRIBUTE_VALUE_CHARS = 2 * 1024;
const MAX_DIAGNOSTIC_LOG_NAME_CHARS = 120;
const MAX_FILE_LOG_MESSAGE_CHARS = 4 * 1024;
const MAX_FILE_LOG_CONTEXT_VALUE_CHARS = 512;
const DIAGNOSTIC_LOG_ATTRIBUTE_KEY_RE = /^[A-Za-z0-9_.:-]{1,64}$/u;
const HOSTNAME = os.hostname() || "unknown";

type DiagnosticLogAttributes = Record<string, string | number | boolean>;

function clampDiagnosticLogText(value: string, maxChars: number): string {
  return value.length > maxChars ? `${value.slice(0, maxChars)}...(truncated)` : value;
}

function sanitizeDiagnosticLogText(value: string, maxChars: number): string {
  return clampDiagnosticLogText(
    redactSensitiveText(clampDiagnosticLogText(value, maxChars)),
    maxChars,
  );
}

function normalizeDiagnosticLogName(value: string | undefined): string | undefined {
  if (!value || value.trim().startsWith("{")) {
    return undefined;
  }
  const sanitized = sanitizeDiagnosticLogText(value.trim(), MAX_DIAGNOSTIC_LOG_NAME_CHARS);
  return DIAGNOSTIC_LOG_ATTRIBUTE_KEY_RE.test(sanitized) ? sanitized : undefined;
}

function assignDiagnosticLogAttribute(
  attributes: DiagnosticLogAttributes,
  state: { count: number },
  key: string,
  value: unknown,
): void {
  if (state.count >= MAX_DIAGNOSTIC_LOG_ATTRIBUTE_COUNT) {
    return;
  }
  const normalizedKey = key.trim();
  if (isBlockedObjectKey(normalizedKey)) {
    return;
  }
  if (redactSensitiveText(normalizedKey) !== normalizedKey) {
    return;
  }
  if (!DIAGNOSTIC_LOG_ATTRIBUTE_KEY_RE.test(normalizedKey)) {
    return;
  }
  if (typeof value === "string") {
    attributes[normalizedKey] = sanitizeDiagnosticLogText(
      value,
      MAX_DIAGNOSTIC_LOG_ATTRIBUTE_VALUE_CHARS,
    );
    state.count += 1;
    return;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    attributes[normalizedKey] = value;
    state.count += 1;
    return;
  }
  if (typeof value === "boolean") {
    attributes[normalizedKey] = value;
    state.count += 1;
  }
}

function addDiagnosticLogAttributesFrom(
  attributes: DiagnosticLogAttributes,
  state: { count: number },
  source: Record<string, unknown> | undefined,
): void {
  if (!source) {
    return;
  }
  for (const key in source) {
    if (state.count >= MAX_DIAGNOSTIC_LOG_ATTRIBUTE_COUNT) {
      break;
    }
    if (!Object.hasOwn(source, key) || key === "trace") {
      continue;
    }
    assignDiagnosticLogAttribute(attributes, state, key, source[key]);
  }
}

function isPlainLogRecordObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeTraceContext(value: unknown): DiagnosticTraceContext | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const candidate = value as Partial<DiagnosticTraceContext>;
  if (!isValidDiagnosticTraceId(candidate.traceId)) {
    return undefined;
  }
  if (candidate.spanId !== undefined && !isValidDiagnosticSpanId(candidate.spanId)) {
    return undefined;
  }
  if (candidate.parentSpanId !== undefined && !isValidDiagnosticSpanId(candidate.parentSpanId)) {
    return undefined;
  }
  if (candidate.traceFlags !== undefined && !isValidDiagnosticTraceFlags(candidate.traceFlags)) {
    return undefined;
  }
  return {
    traceId: candidate.traceId,
    ...(candidate.spanId ? { spanId: candidate.spanId } : {}),
    ...(candidate.parentSpanId ? { parentSpanId: candidate.parentSpanId } : {}),
    ...(candidate.traceFlags ? { traceFlags: candidate.traceFlags } : {}),
  };
}

function extractTraceContext(value: unknown): DiagnosticTraceContext | undefined {
  const direct = normalizeTraceContext(value);
  if (direct) {
    return direct;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return normalizeTraceContext((value as { trace?: unknown }).trace);
}

function getSortedNumericLogArgs(logObj: TsLogRecord): unknown[] {
  return Object.entries(logObj)
    .filter(([key]) => /^\d+$/.test(key))
    .toSorted((a, b) => Number(a[0]) - Number(b[0]))
    .map(([, value]) => value);
}

function clampFileLogText(value: string, maxChars: number): string {
  return value.length > maxChars ? `${value.slice(0, maxChars)}...(truncated)` : value;
}

function normalizeFileLogContextValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    const normalized = value.trim();
    return normalized ? clampFileLogText(normalized, MAX_FILE_LOG_CONTEXT_VALUE_CHARS) : undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "boolean") {
    return String(value);
  }
  return undefined;
}

function readFirstContextString(
  sources: Array<Record<string, unknown> | undefined>,
  keys: readonly string[],
): string | undefined {
  for (const source of sources) {
    if (!source) {
      continue;
    }
    for (const key of keys) {
      const value = normalizeFileLogContextValue(source[key]);
      if (value) {
        return value;
      }
    }
  }
  return undefined;
}

function stringifyFileLogMessagePart(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (value instanceof Error) {
    return value.message || value.name;
  }
  if (isPlainLogRecordObject(value) && typeof value.message === "string") {
    return value.message;
  }
  if (value === null || value === undefined) {
    return undefined;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function buildFileLogMessage(numericArgs: readonly unknown[]): string | undefined {
  const parts = numericArgs
    .map(stringifyFileLogMessagePart)
    .filter((part): part is string => Boolean(part && part.trim()));
  if (parts.length === 0) {
    return undefined;
  }
  return clampFileLogText(parts.join(" "), MAX_FILE_LOG_MESSAGE_CHARS);
}

function extractLogBindingPrefix(numericArgs: unknown[]): {
  bindings?: Record<string, unknown>;
  args: unknown[];
} {
  if (
    typeof numericArgs[0] === "string" &&
    numericArgs[0].length <= MAX_DIAGNOSTIC_LOG_BINDINGS_JSON_CHARS &&
    numericArgs[0].trim().startsWith("{")
  ) {
    try {
      const parsed = JSON.parse(numericArgs[0]);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return {
          bindings: parsed as Record<string, unknown>,
          args: numericArgs.slice(1),
        };
      }
    } catch {
      // ignore malformed json bindings
    }
  }
  return { args: numericArgs };
}

function findLogTraceContext(
  bindings: Record<string, unknown> | undefined,
  numericArgs: readonly unknown[],
): DiagnosticTraceContext | undefined {
  const fromBindings = extractTraceContext(bindings);
  if (fromBindings) {
    return fromBindings;
  }
  for (const arg of numericArgs) {
    const fromArg = extractTraceContext(arg);
    if (fromArg) {
      return fromArg;
    }
  }
  return undefined;
}

function buildTraceFileLogFields(logObj: TsLogRecord): Record<string, string> | undefined {
  const { bindings, args } = extractLogBindingPrefix(getSortedNumericLogArgs(logObj));
  const trace = findLogTraceContext(bindings, args) ?? getActiveDiagnosticTraceContext();
  if (!trace) {
    return undefined;
  }
  return {
    traceId: trace.traceId,
    ...(trace.spanId ? { spanId: trace.spanId } : {}),
    ...(trace.parentSpanId ? { parentSpanId: trace.parentSpanId } : {}),
    ...(trace.traceFlags ? { traceFlags: trace.traceFlags } : {}),
  };
}

function buildStructuredFileLogFields(logObj: TsLogRecord): Record<string, string> {
  const { bindings, args } = extractLogBindingPrefix(getSortedNumericLogArgs(logObj));
  const structuredArg = isPlainLogRecordObject(args[0]) ? args[0] : undefined;
  const sources = [structuredArg, bindings, logObj];
  const messageArgs =
    structuredArg && typeof structuredArg.message !== "string" ? args.slice(1) : args;
  const message = buildFileLogMessage(messageArgs);
  const agentId = readFirstContextString(sources, ["agent_id", "agentId"]);
  const sessionId = readFirstContextString(sources, ["session_id", "sessionId", "sessionKey"]);
  const channel = readFirstContextString(sources, ["channel", "messageProvider"]);
  return {
    hostname: HOSTNAME,
    ...(message ? { message } : {}),
    ...(agentId ? { agent_id: agentId } : {}),
    ...(sessionId ? { session_id: sessionId } : {}),
    ...(channel ? { channel } : {}),
  };
}

function buildDiagnosticLogRecord(logObj: TsLogRecord) {
  const meta = logObj._meta as
    | {
        logLevelName?: string;
        date?: Date;
        name?: string;
        parentNames?: string[];
        path?: {
          filePath?: string;
          fileLine?: string;
          fileColumn?: string;
          filePathWithLine?: string;
          method?: string;
        };
      }
    | undefined;
  const { bindings, args: numericArgs } = extractLogBindingPrefix(getSortedNumericLogArgs(logObj));

  const trace = findLogTraceContext(bindings, numericArgs) ?? getActiveDiagnosticTraceContext();
  const structuredArg = numericArgs[0];
  const structuredBindings = isPlainLogRecordObject(structuredArg) ? structuredArg : undefined;
  if (structuredBindings) {
    numericArgs.shift();
  }

  let message = "";
  if (numericArgs.length > 0 && typeof numericArgs[numericArgs.length - 1] === "string") {
    message = sanitizeDiagnosticLogText(
      String(numericArgs.pop()),
      MAX_DIAGNOSTIC_LOG_MESSAGE_CHARS,
    );
  } else if (
    numericArgs.length === 1 &&
    (typeof numericArgs[0] === "number" || typeof numericArgs[0] === "boolean")
  ) {
    message = String(numericArgs[0]);
    numericArgs.length = 0;
  }
  if (!message) {
    message = "log";
  }

  const attributes: DiagnosticLogAttributes = Object.create(null) as DiagnosticLogAttributes;
  const attributeState = { count: 0 };
  addDiagnosticLogAttributesFrom(attributes, attributeState, bindings);
  addDiagnosticLogAttributesFrom(attributes, attributeState, structuredBindings);

  const code: DiagnosticLogCode = {};
  if (meta?.path?.fileLine) {
    const line = Number(meta.path.fileLine);
    if (Number.isFinite(line)) {
      code.line = line;
    }
  }
  if (meta?.path?.method) {
    code.functionName = sanitizeDiagnosticLogText(meta.path.method, MAX_DIAGNOSTIC_LOG_NAME_CHARS);
  }

  const loggerName = normalizeDiagnosticLogName(meta?.name);
  const loggerParents = meta?.parentNames
    ?.map(normalizeDiagnosticLogName)
    .filter((name): name is string => Boolean(name));

  return {
    type: "log.record" as const,
    level: meta?.logLevelName ?? "INFO",
    message,
    ...(loggerName ? { loggerName } : {}),
    ...(loggerParents?.length ? { loggerParents } : {}),
    ...(Object.keys(attributes).length > 0 ? { attributes } : {}),
    ...(Object.keys(code).length > 0 ? { code } : {}),
    ...(trace ? { trace } : {}),
  };
}

function attachDiagnosticEventTransport(logger: TsLogger<LogObj>): void {
  logger.attachTransport((logObj: LogObj) => {
    try {
      emitDiagnosticEvent(buildDiagnosticLogRecord(logObj as TsLogRecord));
    } catch {
      // never block on logging failures
    }
  });
}

function canUseSilentVitestFileLogFastPath(envLevel: LogLevel | undefined): boolean {
  return (
    process.env.VITEST === "true" &&
    process.env.OPENCLAW_TEST_FILE_LOG !== "1" &&
    !envLevel &&
    !loggingState.overrideSettings
  );
}

function resolveSettings(): ResolvedSettings {
  if (!canUseNodeFs()) {
    return {
      level: "silent",
      file: DEFAULT_LOG_FILE,
      maxFileBytes: DEFAULT_MAX_LOG_FILE_BYTES,
    };
  }

  const envLevel = resolveEnvLogLevelOverride();
  // Test runs default file logs to silent. Skip config reads and fallback load in the
  // common case to avoid pulling heavy config/schema stacks on startup.
  if (canUseSilentVitestFileLogFastPath(envLevel)) {
    return {
      level: "silent",
      file: defaultRollingPathForToday(),
      maxFileBytes: DEFAULT_MAX_LOG_FILE_BYTES,
    };
  }

  const cfg: OpenClawConfig["logging"] | undefined =
    (loggingState.overrideSettings as LoggerSettings | null) ?? readLoggingConfig();
  const defaultLevel =
    process.env.VITEST === "true" && process.env.OPENCLAW_TEST_FILE_LOG !== "1" ? "silent" : "info";
  const fromConfig = normalizeLogLevel(cfg?.level, defaultLevel);
  const level = envLevel ?? fromConfig;
  const file = cfg?.file ?? defaultRollingPathForToday();
  const maxFileBytes = resolveMaxLogFileBytes(cfg?.maxFileBytes);
  return { level, file, maxFileBytes };
}

function settingsChanged(a: ResolvedSettings | null, b: ResolvedSettings) {
  if (!a) {
    return true;
  }
  return a.level !== b.level || a.file !== b.file || a.maxFileBytes !== b.maxFileBytes;
}

export function isFileLogLevelEnabled(level: LogLevel): boolean {
  const settings = (loggingState.cachedSettings as ResolvedSettings | null) ?? resolveSettings();
  if (!loggingState.cachedSettings) {
    loggingState.cachedSettings = settings;
  }
  if (level === "silent") {
    return false;
  }
  if (settings.level === "silent") {
    return false;
  }
  return levelToMinLevel(level) >= levelToMinLevel(settings.level);
}

function buildLogger(settings: ResolvedSettings): TsLogger<LogObj> {
  const logger = new TsLogger<LogObj>({
    name: "openclaw",
    minLevel: levelToMinLevel(settings.level),
    type: "hidden", // no ansi formatting
  });

  // Silent logging does not write files; skip all filesystem setup in this path.
  if (settings.level === "silent") {
    attachDiagnosticEventTransport(logger);
    return logger;
  }

  const rollingFile = isRollingPath(settings.file);
  let activeFile = resolveActiveLogFile(settings.file);
  fs.mkdirSync(path.dirname(activeFile), { recursive: true });
  // Clean up stale rolling logs when using a dated log filename.
  if (rollingFile) {
    pruneOldRollingLogs(path.dirname(activeFile));
  }
  let currentFileBytes = getCurrentLogFileBytes(activeFile);
  let warnedAboutRotationFailure = false;

  logger.attachTransport((logObj: LogObj) => {
    try {
      const nextActiveFile = resolveActiveLogFile(settings.file);
      if (nextActiveFile !== activeFile) {
        activeFile = nextActiveFile;
        fs.mkdirSync(path.dirname(activeFile), { recursive: true });
        if (rollingFile) {
          pruneOldRollingLogs(path.dirname(activeFile));
        }
        currentFileBytes = getCurrentLogFileBytes(activeFile);
      }
      const time = formatTimestamp(logObj.date ?? new Date(), { style: "long" });
      const traceFields = buildTraceFileLogFields(logObj as TsLogRecord);
      const structuredFields = buildStructuredFileLogFields(logObj as TsLogRecord);
      const line = redactSensitiveText(
        JSON.stringify({ ...logObj, time, ...structuredFields, ...traceFields }),
      );
      const payload = `${line}\n`;
      const payloadBytes = Buffer.byteLength(payload, "utf8");
      const nextBytes = currentFileBytes + payloadBytes;
      if (currentFileBytes > 0 && nextBytes > settings.maxFileBytes) {
        if (rotateLogFile(activeFile)) {
          currentFileBytes = getCurrentLogFileBytes(activeFile);
          warnedAboutRotationFailure = false;
        } else if (!warnedAboutRotationFailure) {
          warnedAboutRotationFailure = true;
          process.stderr.write(
            `[openclaw] log file rotation failed; continuing writes file=${activeFile} maxFileBytes=${settings.maxFileBytes}\n`,
          );
        }
      }
      if (appendLogLine(activeFile, payload)) {
        currentFileBytes += payloadBytes;
      }
    } catch {
      // never block on logging failures
    }
  });
  attachDiagnosticEventTransport(logger);

  return logger;
}

function resolveMaxLogFileBytes(raw: unknown): number {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return Math.floor(raw);
  }
  return DEFAULT_MAX_LOG_FILE_BYTES;
}

function getCurrentLogFileBytes(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

function appendLogLine(file: string, line: string): boolean {
  try {
    fs.appendFileSync(file, line, { encoding: "utf8" });
    return true;
  } catch {
    return false;
  }
}

export function getLogger(): TsLogger<LogObj> {
  const settings = resolveSettings();
  const cachedLogger = loggingState.cachedLogger as TsLogger<LogObj> | null;
  const cachedSettings = loggingState.cachedSettings as ResolvedSettings | null;
  if (!cachedLogger || settingsChanged(cachedSettings, settings)) {
    loggingState.cachedLogger = buildLogger(settings);
    loggingState.cachedSettings = settings;
  }
  return loggingState.cachedLogger as TsLogger<LogObj>;
}

export function getChildLogger(
  bindings?: Record<string, unknown>,
  opts?: { level?: LogLevel },
): TsLogger<LogObj> {
  const base = getLogger();
  const minLevel = opts?.level ? levelToMinLevel(opts.level) : base.settings.minLevel;
  const name = bindings ? JSON.stringify(bindings) : undefined;
  return base.getSubLogger({
    name,
    minLevel,
    prefix: bindings ? [name ?? ""] : [],
  });
}

// Baileys expects a pino-like logger shape. Provide a lightweight adapter.
export function toPinoLikeLogger(logger: TsLogger<LogObj>, level: LogLevel): PinoLikeLogger {
  const buildChild = (bindings?: Record<string, unknown>) =>
    toPinoLikeLogger(
      logger.getSubLogger({
        name: bindings ? JSON.stringify(bindings) : undefined,
        minLevel: logger.settings.minLevel,
      }),
      level,
    );

  return {
    level,
    child: buildChild,
    trace: (...args: unknown[]) => logger.trace(...args),
    debug: (...args: unknown[]) => logger.debug(...args),
    info: (...args: unknown[]) => logger.info(...args),
    warn: (...args: unknown[]) => logger.warn(...args),
    error: (...args: unknown[]) => logger.error(...args),
    fatal: (...args: unknown[]) => logger.fatal(...args),
  };
}

export type PinoLikeLogger = {
  level: string;
  child: (bindings?: Record<string, unknown>) => PinoLikeLogger;
  trace: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  fatal: (...args: unknown[]) => void;
};

export function getResolvedLoggerSettings(): LoggerResolvedSettings {
  return resolveSettings();
}

// Test helpers
export function setLoggerOverride(settings: LoggerSettings | null) {
  loggingState.overrideSettings = settings;
  loggingState.cachedLogger = null;
  loggingState.cachedSettings = null;
  loggingState.cachedConsoleSettings = null;
}

export function resetLogger() {
  loggingState.cachedLogger = null;
  loggingState.cachedSettings = null;
  loggingState.cachedConsoleSettings = null;
  loggingState.overrideSettings = null;
}

export const __test__ = {
  resolveActiveLogFile,
  shouldSkipMutatingLoggingConfigRead,
};

function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function defaultRollingPathForToday(): string {
  return rollingPathForDate(DEFAULT_LOG_DIR, new Date());
}

function rollingPathForDate(dir: string, date: Date): string {
  const today = formatLocalDate(date);
  return path.join(dir, `${LOG_PREFIX}-${today}${LOG_SUFFIX}`);
}

function resolveActiveLogFile(file: string): string {
  const expandedFile = expandHomePrefix(file);
  if (!isRollingPath(expandedFile)) {
    return expandedFile;
  }
  return rollingPathForDate(path.dirname(expandedFile), new Date());
}

function isRollingPath(file: string): boolean {
  const base = path.basename(file);
  return (
    base.startsWith(`${LOG_PREFIX}-`) &&
    base.endsWith(LOG_SUFFIX) &&
    base.length === `${LOG_PREFIX}-YYYY-MM-DD${LOG_SUFFIX}`.length
  );
}

function pruneOldRollingLogs(dir: string): void {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const cutoff = Date.now() - MAX_LOG_AGE_MS;
    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }
      if (!entry.name.startsWith(`${LOG_PREFIX}-`) || !entry.name.endsWith(LOG_SUFFIX)) {
        continue;
      }
      const fullPath = path.join(dir, entry.name);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.mtimeMs < cutoff) {
          fs.rmSync(fullPath, { force: true });
        }
      } catch {
        // ignore errors during pruning
      }
    }
  } catch {
    // ignore missing dir or read errors
  }
}

function rotatedLogPath(file: string, index: number): string {
  const ext = path.extname(file);
  const base = file.slice(0, file.length - ext.length);
  return `${base}.${index}${ext}`;
}

function rotateLogFile(file: string): boolean {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.rmSync(rotatedLogPath(file, MAX_ROTATED_LOG_FILES), { force: true });
    for (let index = MAX_ROTATED_LOG_FILES - 1; index >= 1; index -= 1) {
      const from = rotatedLogPath(file, index);
      if (!fs.existsSync(from)) {
        continue;
      }
      fs.renameSync(from, rotatedLogPath(file, index + 1));
    }
    if (fs.existsSync(file)) {
      fs.renameSync(file, rotatedLogPath(file, 1));
    }
    return true;
  } catch {
    return false;
  }
}
