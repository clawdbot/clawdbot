import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { resolveStateDir } from "../config/paths.js";
import { registerFatalErrorHook } from "../infra/fatal-error-hooks.js";
import {
  getDiagnosticStabilitySnapshot,
  MAX_DIAGNOSTIC_STABILITY_LIMIT,
  type DiagnosticStabilitySnapshot,
} from "./diagnostic-stability.js";

export const DIAGNOSTIC_STABILITY_BUNDLE_VERSION = 1;
export const DEFAULT_DIAGNOSTIC_STABILITY_BUNDLE_LIMIT = MAX_DIAGNOSTIC_STABILITY_LIMIT;
export const DEFAULT_DIAGNOSTIC_STABILITY_BUNDLE_RETENTION = 20;
export const MAX_DIAGNOSTIC_STABILITY_BUNDLE_BYTES = 5 * 1024 * 1024;

const SAFE_REASON_CODE = /^[A-Za-z0-9_.:-]{1,120}$/u;
const BUNDLE_PREFIX = "openclaw-stability-";
const BUNDLE_SUFFIX = ".json";
const REDACTED_HOSTNAME = "<redacted-hostname>";

export type DiagnosticStabilityBundle = {
  version: typeof DIAGNOSTIC_STABILITY_BUNDLE_VERSION;
  generatedAt: string;
  reason: string;
  process: {
    pid: number;
    platform: NodeJS.Platform;
    arch: string;
    node: string;
    uptimeMs: number;
  };
  host: {
    hostname: string;
  };
  error?: {
    name?: string;
    code?: string;
  };
  snapshot: DiagnosticStabilitySnapshot;
};

export type WriteDiagnosticStabilityBundleResult =
  | { status: "written"; path: string; bundle: DiagnosticStabilityBundle }
  | { status: "skipped"; reason: "empty" }
  | { status: "failed"; error: unknown };

export type WriteDiagnosticStabilityBundleOptions = {
  reason: string;
  error?: unknown;
  includeEmpty?: boolean;
  limit?: number;
  now?: Date;
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
  retention?: number;
};

export type DiagnosticStabilityBundleLocationOptions = {
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
};

export type DiagnosticStabilityBundleFile = {
  path: string;
  mtimeMs: number;
};

export type ReadDiagnosticStabilityBundleResult =
  | { status: "found"; path: string; mtimeMs: number; bundle: DiagnosticStabilityBundle }
  | { status: "missing"; dir: string }
  | { status: "failed"; path?: string; error: unknown };

export type DiagnosticStabilityBundleFailureWriteOutcome =
  | { status: "written"; message: string; path: string }
  | { status: "failed"; message: string; error: unknown }
  | { status: "skipped"; reason: "empty" };

export type WriteDiagnosticStabilityBundleForFailureOptions = Omit<
  WriteDiagnosticStabilityBundleOptions,
  "error" | "includeEmpty" | "reason"
>;

let fatalHookUnsubscribe: (() => void) | null = null;

function normalizeReason(reason: string): string {
  return SAFE_REASON_CODE.test(reason) ? reason : "unknown";
}

function formatBundleTimestamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

function readErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && SAFE_REASON_CODE.test(code)) {
    return code;
  }
  if (typeof code === "number" && Number.isFinite(code)) {
    return String(code);
  }
  return undefined;
}

function readErrorName(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("name" in error)) {
    return undefined;
  }
  const name = (error as { name?: unknown }).name;
  return typeof name === "string" && SAFE_REASON_CODE.test(name) ? name : undefined;
}

function readSafeErrorMetadata(error: unknown): DiagnosticStabilityBundle["error"] | undefined {
  const name = readErrorName(error);
  const code = readErrorCode(error);
  if (!name && !code) {
    return undefined;
  }
  return {
    ...(name ? { name } : {}),
    ...(code ? { code } : {}),
  };
}

export function resolveDiagnosticStabilityBundleDir(
  options: DiagnosticStabilityBundleLocationOptions = {},
): string {
  return path.join(
    options.stateDir ?? resolveStateDir(options.env ?? process.env),
    "logs",
    "stability",
  );
}

function buildBundlePath(dir: string, now: Date, reason: string): string {
  return path.join(
    dir,
    `${BUNDLE_PREFIX}${formatBundleTimestamp(now)}-${process.pid}-${normalizeReason(reason)}${BUNDLE_SUFFIX}`,
  );
}

function isBundleFile(name: string): boolean {
  return name.startsWith(BUNDLE_PREFIX) && name.endsWith(BUNDLE_SUFFIX);
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function readObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid stability bundle: ${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function readNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Invalid stability bundle: ${label} must be a finite number`);
  }
  return value;
}

function readTimestampMs(value: unknown, label: string): number {
  const timestamp = readNumber(value, label);
  if (Number.isNaN(new Date(timestamp).getTime())) {
    throw new Error(`Invalid stability bundle: ${label} must be a valid timestamp`);
  }
  return timestamp;
}

function readOptionalNumber(value: unknown, label: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  return readNumber(value, label);
}

function readString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`Invalid stability bundle: ${label} must be a string`);
  }
  return value;
}

function readTimestampString(value: unknown, label: string): string {
  const timestamp = readString(value, label);
  if (Number.isNaN(new Date(timestamp).getTime())) {
    throw new Error(`Invalid stability bundle: ${label} must be a valid timestamp`);
  }
  return timestamp;
}

function readCodeString(value: unknown, label: string): string {
  const code = readString(value, label);
  if (!SAFE_REASON_CODE.test(code)) {
    throw new Error(`Invalid stability bundle: ${label} must be a safe diagnostic code`);
  }
  return code;
}

function readOptionalCodeString(value: unknown, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const code = readString(value, label);
  return SAFE_REASON_CODE.test(code) ? code : undefined;
}

function assignOptionalNumber(target: object, key: string, value: unknown, label: string): void {
  const parsed = readOptionalNumber(value, label);
  if (parsed !== undefined) {
    (target as Record<string, unknown>)[key] = parsed;
  }
}

function assignOptionalCodeString(
  target: object,
  key: string,
  value: unknown,
  label: string,
): void {
  const parsed = readOptionalCodeString(value, label);
  if (parsed !== undefined) {
    (target as Record<string, unknown>)[key] = parsed;
  }
}

function readMemoryUsage(
  value: unknown,
  label: string,
): NonNullable<DiagnosticStabilitySnapshot["summary"]["memory"]>["latest"] {
  const memory = readObject(value, label);
  return {
    rssBytes: readNumber(memory.rssBytes, `${label}.rssBytes`),
    heapTotalBytes: readNumber(memory.heapTotalBytes, `${label}.heapTotalBytes`),
    heapUsedBytes: readNumber(memory.heapUsedBytes, `${label}.heapUsedBytes`),
    externalBytes: readNumber(memory.externalBytes, `${label}.externalBytes`),
    arrayBuffersBytes: readNumber(memory.arrayBuffersBytes, `${label}.arrayBuffersBytes`),
  };
}

function readNumberMap(value: unknown, label: string): Record<string, number> {
  const source = readObject(value, label);
  const result: Record<string, number> = {};
  for (const [key, entry] of Object.entries(source)) {
    if (!SAFE_REASON_CODE.test(key)) {
      continue;
    }
    result[key] = readNumber(entry, `${label}.${key}`);
  }
  return result;
}

function readOptionalMemorySummary(
  value: unknown,
): DiagnosticStabilitySnapshot["summary"]["memory"] | undefined {
  if (value === undefined) {
    return undefined;
  }
  const memory = readObject(value, "snapshot.summary.memory");
  const latest =
    memory.latest === undefined
      ? undefined
      : readMemoryUsage(memory.latest, "snapshot.summary.memory.latest");
  return {
    ...(latest ? { latest } : {}),
    ...(memory.maxRssBytes !== undefined
      ? { maxRssBytes: readNumber(memory.maxRssBytes, "snapshot.summary.memory.maxRssBytes") }
      : {}),
    ...(memory.maxHeapUsedBytes !== undefined
      ? {
          maxHeapUsedBytes: readNumber(
            memory.maxHeapUsedBytes,
            "snapshot.summary.memory.maxHeapUsedBytes",
          ),
        }
      : {}),
    pressureCount: readNumber(memory.pressureCount, "snapshot.summary.memory.pressureCount"),
  };
}

function readOptionalPayloadLargeSummary(
  value: unknown,
): DiagnosticStabilitySnapshot["summary"]["payloadLarge"] | undefined {
  if (value === undefined) {
    return undefined;
  }
  const payloadLarge = readObject(value, "snapshot.summary.payloadLarge");
  return {
    count: readNumber(payloadLarge.count, "snapshot.summary.payloadLarge.count"),
    rejected: readNumber(payloadLarge.rejected, "snapshot.summary.payloadLarge.rejected"),
    truncated: readNumber(payloadLarge.truncated, "snapshot.summary.payloadLarge.truncated"),
    chunked: readNumber(payloadLarge.chunked, "snapshot.summary.payloadLarge.chunked"),
    bySurface: readNumberMap(payloadLarge.bySurface, "snapshot.summary.payloadLarge.bySurface"),
  };
}

function readStabilityEventRecord(
  value: unknown,
  label: string,
): DiagnosticStabilitySnapshot["events"][number] {
  const record = readObject(value, label);
  const sanitized: DiagnosticStabilitySnapshot["events"][number] = {
    seq: readNumber(record.seq, `${label}.seq`),
    ts: readTimestampMs(record.ts, `${label}.ts`),
    type: readCodeString(
      record.type,
      `${label}.type`,
    ) as DiagnosticStabilitySnapshot["events"][number]["type"],
  };

  assignOptionalCodeString(sanitized, "channel", record.channel, `${label}.channel`);
  assignOptionalCodeString(sanitized, "pluginId", record.pluginId, `${label}.pluginId`);
  assignOptionalCodeString(sanitized, "source", record.source, `${label}.source`);
  assignOptionalCodeString(sanitized, "surface", record.surface, `${label}.surface`);
  assignOptionalCodeString(sanitized, "action", record.action, `${label}.action`);
  assignOptionalCodeString(sanitized, "reason", record.reason, `${label}.reason`);
  assignOptionalCodeString(sanitized, "outcome", record.outcome, `${label}.outcome`);
  assignOptionalCodeString(sanitized, "level", record.level, `${label}.level`);
  assignOptionalCodeString(sanitized, "detector", record.detector, `${label}.detector`);
  assignOptionalCodeString(sanitized, "toolName", record.toolName, `${label}.toolName`);
  assignOptionalCodeString(
    sanitized,
    "pairedToolName",
    record.pairedToolName,
    `${label}.pairedToolName`,
  );
  assignOptionalCodeString(sanitized, "provider", record.provider, `${label}.provider`);
  assignOptionalCodeString(sanitized, "model", record.model, `${label}.model`);

  assignOptionalNumber(sanitized, "durationMs", record.durationMs, `${label}.durationMs`);
  assignOptionalNumber(sanitized, "requestBytes", record.requestBytes, `${label}.requestBytes`);
  assignOptionalNumber(sanitized, "responseBytes", record.responseBytes, `${label}.responseBytes`);
  assignOptionalNumber(
    sanitized,
    "timeToFirstByteMs",
    record.timeToFirstByteMs,
    `${label}.timeToFirstByteMs`,
  );
  assignOptionalNumber(sanitized, "costUsd", record.costUsd, `${label}.costUsd`);
  assignOptionalNumber(sanitized, "count", record.count, `${label}.count`);
  assignOptionalNumber(sanitized, "bytes", record.bytes, `${label}.bytes`);
  assignOptionalNumber(sanitized, "limitBytes", record.limitBytes, `${label}.limitBytes`);
  assignOptionalNumber(
    sanitized,
    "thresholdBytes",
    record.thresholdBytes,
    `${label}.thresholdBytes`,
  );
  assignOptionalNumber(
    sanitized,
    "rssGrowthBytes",
    record.rssGrowthBytes,
    `${label}.rssGrowthBytes`,
  );
  assignOptionalNumber(sanitized, "windowMs", record.windowMs, `${label}.windowMs`);
  assignOptionalNumber(sanitized, "ageMs", record.ageMs, `${label}.ageMs`);
  assignOptionalNumber(sanitized, "queueDepth", record.queueDepth, `${label}.queueDepth`);
  assignOptionalNumber(sanitized, "queueSize", record.queueSize, `${label}.queueSize`);
  assignOptionalNumber(sanitized, "waitMs", record.waitMs, `${label}.waitMs`);
  assignOptionalNumber(sanitized, "active", record.active, `${label}.active`);
  assignOptionalNumber(sanitized, "waiting", record.waiting, `${label}.waiting`);
  assignOptionalNumber(sanitized, "queued", record.queued, `${label}.queued`);

  if (record.webhooks !== undefined) {
    const webhooks = readObject(record.webhooks, `${label}.webhooks`);
    sanitized.webhooks = {
      received: readNumber(webhooks.received, `${label}.webhooks.received`),
      processed: readNumber(webhooks.processed, `${label}.webhooks.processed`),
      errors: readNumber(webhooks.errors, `${label}.webhooks.errors`),
    };
  }
  if (record.memory !== undefined) {
    sanitized.memory = readMemoryUsage(record.memory, `${label}.memory`);
  }
  if (record.usage !== undefined) {
    const usage = readObject(record.usage, `${label}.usage`);
    sanitized.usage = {
      ...(usage.input !== undefined
        ? { input: readNumber(usage.input, `${label}.usage.input`) }
        : {}),
      ...(usage.output !== undefined
        ? { output: readNumber(usage.output, `${label}.usage.output`) }
        : {}),
      ...(usage.cacheRead !== undefined
        ? { cacheRead: readNumber(usage.cacheRead, `${label}.usage.cacheRead`) }
        : {}),
      ...(usage.cacheWrite !== undefined
        ? { cacheWrite: readNumber(usage.cacheWrite, `${label}.usage.cacheWrite`) }
        : {}),
      ...(usage.promptTokens !== undefined
        ? { promptTokens: readNumber(usage.promptTokens, `${label}.usage.promptTokens`) }
        : {}),
      ...(usage.total !== undefined
        ? { total: readNumber(usage.total, `${label}.usage.total`) }
        : {}),
    };
  }
  if (record.context !== undefined) {
    const context = readObject(record.context, `${label}.context`);
    sanitized.context = {
      ...(context.limit !== undefined
        ? { limit: readNumber(context.limit, `${label}.context.limit`) }
        : {}),
      ...(context.used !== undefined
        ? { used: readNumber(context.used, `${label}.context.used`) }
        : {}),
    };
  }

  return sanitized;
}

function readStabilitySnapshot(value: unknown): DiagnosticStabilitySnapshot {
  const snapshot = readObject(value, "snapshot");
  const generatedAt = readTimestampString(snapshot.generatedAt, "snapshot.generatedAt");
  const capacity = readNumber(snapshot.capacity, "snapshot.capacity");
  const count = readNumber(snapshot.count, "snapshot.count");
  const dropped = readNumber(snapshot.dropped, "snapshot.dropped");
  const firstSeq = readOptionalNumber(snapshot.firstSeq, "snapshot.firstSeq");
  const lastSeq = readOptionalNumber(snapshot.lastSeq, "snapshot.lastSeq");
  if (!Array.isArray(snapshot.events)) {
    throw new Error("Invalid stability bundle: snapshot.events must be an array");
  }
  const events = snapshot.events.map((event, index) =>
    readStabilityEventRecord(event, `snapshot.events[${index}]`),
  );
  const summary = readObject(snapshot.summary, "snapshot.summary");
  return {
    generatedAt,
    capacity,
    count,
    dropped,
    ...(firstSeq !== undefined ? { firstSeq } : {}),
    ...(lastSeq !== undefined ? { lastSeq } : {}),
    events,
    summary: {
      byType: readNumberMap(summary.byType, "snapshot.summary.byType"),
      ...(summary.memory !== undefined
        ? { memory: readOptionalMemorySummary(summary.memory) }
        : {}),
      ...(summary.payloadLarge !== undefined
        ? { payloadLarge: readOptionalPayloadLargeSummary(summary.payloadLarge) }
        : {}),
    },
  };
}

function parseDiagnosticStabilityBundle(value: unknown): DiagnosticStabilityBundle {
  const bundle = readObject(value, "bundle");
  if (bundle.version !== DIAGNOSTIC_STABILITY_BUNDLE_VERSION) {
    throw new Error(`Unsupported stability bundle version: ${String(bundle.version)}`);
  }
  const processInfo = readObject(bundle.process, "process");
  readObject(bundle.host, "host");
  const error = bundle.error === undefined ? undefined : readSafeErrorMetadata(bundle.error);
  return {
    version: DIAGNOSTIC_STABILITY_BUNDLE_VERSION,
    generatedAt: readTimestampString(bundle.generatedAt, "generatedAt"),
    reason: normalizeReason(readString(bundle.reason, "reason")),
    process: {
      pid: readNumber(processInfo.pid, "process.pid"),
      platform: readCodeString(processInfo.platform, "process.platform") as NodeJS.Platform,
      arch: readCodeString(processInfo.arch, "process.arch"),
      node: readCodeString(processInfo.node, "process.node"),
      uptimeMs: readNumber(processInfo.uptimeMs, "process.uptimeMs"),
    },
    host: {
      hostname: REDACTED_HOSTNAME,
    },
    ...(error ? { error } : {}),
    snapshot: readStabilitySnapshot(bundle.snapshot),
  };
}

export function listDiagnosticStabilityBundleFilesSync(
  options: DiagnosticStabilityBundleLocationOptions = {},
): DiagnosticStabilityBundleFile[] {
  const dir = resolveDiagnosticStabilityBundleDir(options);
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && isBundleFile(entry.name))
      .map((entry) => {
        const file = path.join(dir, entry.name);
        return {
          path: file,
          mtimeMs: fs.statSync(file).mtimeMs,
        };
      })
      .toSorted((a, b) => b.mtimeMs - a.mtimeMs || b.path.localeCompare(a.path));
  } catch (error) {
    if (isMissingFileError(error)) {
      return [];
    }
    throw error;
  }
}

export function readDiagnosticStabilityBundleFileSync(
  file: string,
): ReadDiagnosticStabilityBundleResult {
  try {
    const stat = fs.statSync(file);
    if (stat.size > MAX_DIAGNOSTIC_STABILITY_BUNDLE_BYTES) {
      throw new Error(
        `Stability bundle is too large: ${stat.size} bytes exceeds ${MAX_DIAGNOSTIC_STABILITY_BUNDLE_BYTES}`,
      );
    }
    const raw = fs.readFileSync(file, "utf8");
    const bundle = parseDiagnosticStabilityBundle(JSON.parse(raw));
    return {
      status: "found",
      path: file,
      mtimeMs: stat.mtimeMs,
      bundle,
    };
  } catch (error) {
    return { status: "failed", path: file, error };
  }
}

export function readLatestDiagnosticStabilityBundleSync(
  options: DiagnosticStabilityBundleLocationOptions = {},
): ReadDiagnosticStabilityBundleResult {
  try {
    const latest = listDiagnosticStabilityBundleFilesSync(options)[0];
    if (!latest) {
      return {
        status: "missing",
        dir: resolveDiagnosticStabilityBundleDir(options),
      };
    }
    return readDiagnosticStabilityBundleFileSync(latest.path);
  } catch (error) {
    return { status: "failed", error };
  }
}

function pruneOldBundles(dir: string, retention: number): void {
  if (!Number.isFinite(retention) || retention < 1) {
    return;
  }
  try {
    const entries = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && isBundleFile(entry.name))
      .map((entry) => {
        const file = path.join(dir, entry.name);
        let mtimeMs = 0;
        try {
          mtimeMs = fs.statSync(file).mtimeMs;
        } catch {
          // Missing files are ignored below.
        }
        return { file, mtimeMs };
      })
      .toSorted((a, b) => b.mtimeMs - a.mtimeMs || b.file.localeCompare(a.file));

    for (const entry of entries.slice(retention)) {
      try {
        fs.unlinkSync(entry.file);
      } catch {
        // Retention cleanup must not block failure handling.
      }
    }
  } catch {
    // Retention cleanup must not block failure handling.
  }
}

export function writeDiagnosticStabilityBundleSync(
  options: WriteDiagnosticStabilityBundleOptions,
): WriteDiagnosticStabilityBundleResult {
  try {
    const now = options.now ?? new Date();
    const snapshot = getDiagnosticStabilitySnapshot({
      limit: options.limit ?? DEFAULT_DIAGNOSTIC_STABILITY_BUNDLE_LIMIT,
    });
    if (!options.includeEmpty && snapshot.count === 0) {
      return { status: "skipped", reason: "empty" };
    }

    const reason = normalizeReason(options.reason);
    const error = options.error ? readSafeErrorMetadata(options.error) : undefined;
    const bundle: DiagnosticStabilityBundle = {
      version: DIAGNOSTIC_STABILITY_BUNDLE_VERSION,
      generatedAt: now.toISOString(),
      reason,
      process: {
        pid: process.pid,
        platform: process.platform,
        arch: process.arch,
        node: process.versions.node,
        uptimeMs: Math.round(process.uptime() * 1000),
      },
      host: {
        hostname: REDACTED_HOSTNAME,
      },
      ...(error ? { error } : {}),
      snapshot,
    };

    const dir = resolveDiagnosticStabilityBundleDir(options);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = buildBundlePath(dir, now, reason);
    const tmpFile = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmpFile, `${JSON.stringify(bundle, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.renameSync(tmpFile, file);
    pruneOldBundles(dir, options.retention ?? DEFAULT_DIAGNOSTIC_STABILITY_BUNDLE_RETENTION);
    return { status: "written", path: file, bundle };
  } catch (error) {
    return { status: "failed", error };
  }
}

export function writeDiagnosticStabilityBundleForFailureSync(
  reason: string,
  error?: unknown,
  options: WriteDiagnosticStabilityBundleForFailureOptions = {},
): DiagnosticStabilityBundleFailureWriteOutcome {
  const result = writeDiagnosticStabilityBundleSync({
    ...options,
    reason,
    error,
    includeEmpty: true,
  });
  if (result.status === "written") {
    return {
      status: "written",
      path: result.path,
      message: `wrote stability bundle: ${result.path}`,
    };
  }
  if (result.status === "failed") {
    return {
      status: "failed",
      error: result.error,
      message: `failed to write stability bundle: ${String(result.error)}`,
    };
  }
  return result;
}

export function installDiagnosticStabilityFatalHook(
  options: WriteDiagnosticStabilityBundleForFailureOptions = {},
): void {
  if (fatalHookUnsubscribe) {
    return;
  }
  fatalHookUnsubscribe = registerFatalErrorHook(({ reason, error }) => {
    const result = writeDiagnosticStabilityBundleForFailureSync(reason, error, options);
    return "message" in result ? result.message : undefined;
  });
}

export function uninstallDiagnosticStabilityFatalHook(): void {
  fatalHookUnsubscribe?.();
  fatalHookUnsubscribe = null;
}

export function resetDiagnosticStabilityBundleForTest(): void {
  uninstallDiagnosticStabilityFatalHook();
}
