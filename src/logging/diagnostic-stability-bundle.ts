import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import v8 from "node:v8";
import { resolveStateDir } from "../config/paths.js";
import type {
  DiagnosticMemoryPressureEvent,
  DiagnosticMemoryUsage,
} from "../infra/diagnostic-events.js";
import { registerFatalErrorHook } from "../infra/fatal-error-hooks.js";
import { replaceFileAtomicSync } from "../infra/replace-file.js";
import {
  getDiagnosticStabilitySnapshot,
  MAX_DIAGNOSTIC_STABILITY_LIMIT,
  type DiagnosticStabilitySnapshot,
} from "./diagnostic-stability.js";
import { redactSensitiveText } from "./redact.js";

export const DIAGNOSTIC_STABILITY_BUNDLE_VERSION = 1;
export const DEFAULT_DIAGNOSTIC_STABILITY_BUNDLE_LIMIT = MAX_DIAGNOSTIC_STABILITY_LIMIT;
export const DEFAULT_DIAGNOSTIC_STABILITY_BUNDLE_RETENTION = 20;
export const MAX_DIAGNOSTIC_STABILITY_BUNDLE_BYTES = 5 * 1024 * 1024;

const SAFE_REASON_CODE = /^[A-Za-z0-9_.:-]{1,120}$/u;
const BUNDLE_PREFIX = "openclaw-stability-";
const BUNDLE_SUFFIX = ".json";
const REDACTED_HOSTNAME = "<redacted-hostname>";
const MAX_SAFE_ERROR_MESSAGE_LENGTH = 500;
const MAX_ACTIVE_RESOURCE_TYPES = 25;
const MAX_SESSION_FILE_RESULTS = 20;
const MAX_SESSION_SCAN_AGENTS = 100;
const MAX_SESSION_SCAN_FILES = 5000;
const CGROUP_V2_MEMORY_FILES = ["current", "max", "high", "peak", "swap.current", "swap.max"];
const CGROUP_V2_MEMORY_EVENTS = ["events", "events.local"];

type DiagnosticHeapSpaceSummary = {
  spaceName: string;
  spaceSizeBytes: number;
  spaceUsedBytes: number;
  spaceAvailableBytes: number;
  physicalSpaceSizeBytes: number;
};

type DiagnosticHeapStatisticsSummary = {
  totalHeapSizeBytes: number;
  totalHeapSizeExecutableBytes: number;
  totalPhysicalSizeBytes: number;
  totalAvailableSizeBytes: number;
  usedHeapSizeBytes: number;
  heapSizeLimitBytes: number;
  mallocedMemoryBytes: number;
  externalMemoryBytes: number;
};

type DiagnosticActiveResourceSummary = {
  total: number;
  byType: Record<string, number>;
};

type DiagnosticCgroupMemorySummary = {
  version: "v2";
  values: Record<string, number | "max">;
  events: Record<string, number>;
};

type DiagnosticSessionFileSummary = {
  relativePath: string;
  sizeBytes: number;
  mtimeMs: number;
};

export type DiagnosticMemoryPressureBundleEvidence = {
  level: DiagnosticMemoryPressureEvent["level"];
  reason: DiagnosticMemoryPressureEvent["reason"];
  memory: DiagnosticMemoryUsage;
  thresholdBytes?: number;
  rssGrowthBytes?: number;
  windowMs?: number;
  heapStatistics?: DiagnosticHeapStatisticsSummary;
  heapSpaces?: DiagnosticHeapSpaceSummary[];
  cgroup?: DiagnosticCgroupMemorySummary;
  activeResources?: DiagnosticActiveResourceSummary;
  topSessionFiles?: DiagnosticSessionFileSummary[];
};

export type DiagnosticStabilityBundleEvidence = {
  memoryPressure?: DiagnosticMemoryPressureBundleEvidence;
};

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
    message?: string;
  };
  evidence?: DiagnosticStabilityBundleEvidence;
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
  evidence?: DiagnosticStabilityBundleEvidence;
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

export type WriteDiagnosticMemoryPressureBundleOptions = Omit<
  WriteDiagnosticStabilityBundleOptions,
  "reason" | "error" | "evidence" | "includeEmpty"
> & {
  pressure: Omit<DiagnosticMemoryPressureEvent, "seq" | "ts" | "type" | "trace">;
  sessionStorePaths?: string[];
};

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

function readErrorMessage(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("message" in error)) {
    return undefined;
  }
  const message = (error as { message?: unknown }).message;
  if (typeof message !== "string") {
    return undefined;
  }
  const sanitized = redactSensitiveText(message, { mode: "tools" }).replace(/\s+/gu, " ").trim();
  if (!sanitized) {
    return undefined;
  }
  return sanitized.length > MAX_SAFE_ERROR_MESSAGE_LENGTH
    ? `${sanitized.slice(0, MAX_SAFE_ERROR_MESSAGE_LENGTH)}...`
    : sanitized;
}

function readSafeErrorMetadata(error: unknown): DiagnosticStabilityBundle["error"] | undefined {
  const name = readErrorName(error);
  const code = readErrorCode(error);
  const message = readErrorMessage(error);
  if (!name && !code && !message) {
    return undefined;
  }
  return {
    ...(name ? { name } : {}),
    ...(code ? { code } : {}),
    ...(message ? { message } : {}),
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

function readOptionalPositiveInteger(value: unknown, label: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = readNumber(value, label);
  return parsed >= 0 ? Math.floor(parsed) : undefined;
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

function assignOptionalPositiveInteger(
  target: object,
  key: string,
  value: unknown,
  label: string,
): void {
  const parsed = readOptionalPositiveInteger(value, label);
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

function readMemoryUsage(value: unknown, label: string): DiagnosticMemoryUsage {
  const memory = readObject(value, label);
  return {
    rssBytes: readNumber(memory.rssBytes, `${label}.rssBytes`),
    heapTotalBytes: readNumber(memory.heapTotalBytes, `${label}.heapTotalBytes`),
    heapUsedBytes: readNumber(memory.heapUsedBytes, `${label}.heapUsedBytes`),
    externalBytes: readNumber(memory.externalBytes, `${label}.externalBytes`),
    arrayBuffersBytes: readNumber(memory.arrayBuffersBytes, `${label}.arrayBuffersBytes`),
  };
}

function readHeapStatistics(value: unknown): DiagnosticHeapStatisticsSummary | undefined {
  if (value === undefined) {
    return undefined;
  }
  const source = readObject(value, "evidence.memoryPressure.heapStatistics");
  const result = {} as DiagnosticHeapStatisticsSummary;
  assignOptionalPositiveInteger(
    result,
    "totalHeapSizeBytes",
    source.totalHeapSizeBytes,
    "evidence.memoryPressure.heapStatistics.totalHeapSizeBytes",
  );
  assignOptionalPositiveInteger(
    result,
    "totalHeapSizeExecutableBytes",
    source.totalHeapSizeExecutableBytes,
    "evidence.memoryPressure.heapStatistics.totalHeapSizeExecutableBytes",
  );
  assignOptionalPositiveInteger(
    result,
    "totalPhysicalSizeBytes",
    source.totalPhysicalSizeBytes,
    "evidence.memoryPressure.heapStatistics.totalPhysicalSizeBytes",
  );
  assignOptionalPositiveInteger(
    result,
    "totalAvailableSizeBytes",
    source.totalAvailableSizeBytes,
    "evidence.memoryPressure.heapStatistics.totalAvailableSizeBytes",
  );
  assignOptionalPositiveInteger(
    result,
    "usedHeapSizeBytes",
    source.usedHeapSizeBytes,
    "evidence.memoryPressure.heapStatistics.usedHeapSizeBytes",
  );
  assignOptionalPositiveInteger(
    result,
    "heapSizeLimitBytes",
    source.heapSizeLimitBytes,
    "evidence.memoryPressure.heapStatistics.heapSizeLimitBytes",
  );
  assignOptionalPositiveInteger(
    result,
    "mallocedMemoryBytes",
    source.mallocedMemoryBytes,
    "evidence.memoryPressure.heapStatistics.mallocedMemoryBytes",
  );
  assignOptionalPositiveInteger(
    result,
    "externalMemoryBytes",
    source.externalMemoryBytes,
    "evidence.memoryPressure.heapStatistics.externalMemoryBytes",
  );
  return Object.keys(result).length > 0 ? result : undefined;
}

function readHeapSpaces(value: unknown): DiagnosticHeapSpaceSummary[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(
      "Invalid stability bundle: evidence.memoryPressure.heapSpaces must be an array",
    );
  }
  const spaces: DiagnosticHeapSpaceSummary[] = [];
  for (const [index, entry] of value.entries()) {
    const source = readObject(entry, `evidence.memoryPressure.heapSpaces[${index}]`);
    const spaceName = readOptionalCodeString(
      source.spaceName,
      `evidence.memoryPressure.heapSpaces[${index}].spaceName`,
    );
    if (!spaceName) {
      continue;
    }
    spaces.push({
      spaceName,
      spaceSizeBytes:
        readOptionalPositiveInteger(
          source.spaceSizeBytes,
          `evidence.memoryPressure.heapSpaces[${index}].spaceSizeBytes`,
        ) ?? 0,
      spaceUsedBytes:
        readOptionalPositiveInteger(
          source.spaceUsedBytes,
          `evidence.memoryPressure.heapSpaces[${index}].spaceUsedBytes`,
        ) ?? 0,
      spaceAvailableBytes:
        readOptionalPositiveInteger(
          source.spaceAvailableBytes,
          `evidence.memoryPressure.heapSpaces[${index}].spaceAvailableBytes`,
        ) ?? 0,
      physicalSpaceSizeBytes:
        readOptionalPositiveInteger(
          source.physicalSpaceSizeBytes,
          `evidence.memoryPressure.heapSpaces[${index}].physicalSpaceSizeBytes`,
        ) ?? 0,
    });
  }
  return spaces.length > 0 ? spaces : undefined;
}

function readCgroupMemorySummary(value: unknown): DiagnosticCgroupMemorySummary | undefined {
  if (value === undefined) {
    return undefined;
  }
  const source = readObject(value, "evidence.memoryPressure.cgroup");
  const version = readCodeString(
    source.version,
    "evidence.memoryPressure.cgroup.version",
  ) as DiagnosticCgroupMemorySummary["version"];
  if (version !== "v2") {
    return undefined;
  }
  const valuesSource = readObject(source.values, "evidence.memoryPressure.cgroup.values");
  const values: Record<string, number | "max"> = {};
  for (const [key, raw] of Object.entries(valuesSource)) {
    if (!SAFE_REASON_CODE.test(key)) {
      continue;
    }
    if (raw === "max") {
      values[key] = "max";
    } else {
      values[key] =
        readOptionalPositiveInteger(raw, `evidence.memoryPressure.cgroup.values.${key}`) ?? 0;
    }
  }
  return {
    version,
    values,
    events: readNumberMap(source.events, "evidence.memoryPressure.cgroup.events"),
  };
}

function readActiveResources(value: unknown): DiagnosticActiveResourceSummary | undefined {
  if (value === undefined) {
    return undefined;
  }
  const source = readObject(value, "evidence.memoryPressure.activeResources");
  return {
    total:
      readOptionalPositiveInteger(source.total, "evidence.memoryPressure.activeResources.total") ??
      0,
    byType: readNumberMap(source.byType, "evidence.memoryPressure.activeResources.byType"),
  };
}

function readSessionFiles(value: unknown): DiagnosticSessionFileSummary[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(
      "Invalid stability bundle: evidence.memoryPressure.topSessionFiles must be an array",
    );
  }
  const files: DiagnosticSessionFileSummary[] = [];
  for (const [index, entry] of value.entries()) {
    const source = readObject(entry, `evidence.memoryPressure.topSessionFiles[${index}]`);
    const relativePath = readString(
      source.relativePath,
      `evidence.memoryPressure.topSessionFiles[${index}].relativePath`,
    );
    if (
      path.isAbsolute(relativePath) ||
      relativePath.includes("..") ||
      relativePath.length > 300 ||
      /[\r\n]/u.test(relativePath)
    ) {
      continue;
    }
    files.push({
      relativePath: sanitizeSessionEvidencePath(relativePath),
      sizeBytes:
        readOptionalPositiveInteger(
          source.sizeBytes,
          `evidence.memoryPressure.topSessionFiles[${index}].sizeBytes`,
        ) ?? 0,
      mtimeMs:
        readOptionalPositiveInteger(
          source.mtimeMs,
          `evidence.memoryPressure.topSessionFiles[${index}].mtimeMs`,
        ) ?? 0,
    });
  }
  return files.length > 0 ? files : undefined;
}

function readMemoryPressureEvidence(
  value: unknown,
): DiagnosticMemoryPressureBundleEvidence | undefined {
  if (value === undefined) {
    return undefined;
  }
  const pressure = readObject(value, "evidence.memoryPressure");
  const level = readCodeString(
    pressure.level,
    "evidence.memoryPressure.level",
  ) as DiagnosticMemoryPressureEvent["level"];
  const reason = readCodeString(
    pressure.reason,
    "evidence.memoryPressure.reason",
  ) as DiagnosticMemoryPressureEvent["reason"];
  if ((level !== "warning" && level !== "critical") || !isMemoryPressureReason(reason)) {
    return undefined;
  }
  const heapStatistics = readHeapStatistics(pressure.heapStatistics);
  const heapSpaces = readHeapSpaces(pressure.heapSpaces);
  const cgroup = readCgroupMemorySummary(pressure.cgroup);
  const activeResources = readActiveResources(pressure.activeResources);
  const topSessionFiles = readSessionFiles(pressure.topSessionFiles);
  return {
    level,
    reason,
    memory: readMemoryUsage(pressure.memory, "evidence.memoryPressure.memory"),
    ...(pressure.thresholdBytes !== undefined
      ? {
          thresholdBytes: readNumber(
            pressure.thresholdBytes,
            "evidence.memoryPressure.thresholdBytes",
          ),
        }
      : {}),
    ...(pressure.rssGrowthBytes !== undefined
      ? {
          rssGrowthBytes: readNumber(
            pressure.rssGrowthBytes,
            "evidence.memoryPressure.rssGrowthBytes",
          ),
        }
      : {}),
    ...(pressure.windowMs !== undefined
      ? { windowMs: readNumber(pressure.windowMs, "evidence.memoryPressure.windowMs") }
      : {}),
    ...(heapStatistics ? { heapStatistics } : {}),
    ...(heapSpaces ? { heapSpaces } : {}),
    ...(cgroup ? { cgroup } : {}),
    ...(activeResources ? { activeResources } : {}),
    ...(topSessionFiles ? { topSessionFiles } : {}),
  };
}

function readBundleEvidence(value: unknown): DiagnosticStabilityBundleEvidence | undefined {
  if (value === undefined) {
    return undefined;
  }
  const source = readObject(value, "evidence");
  const memoryPressure = readMemoryPressureEvidence(source.memoryPressure);
  return memoryPressure ? { memoryPressure } : undefined;
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
  assignOptionalCodeString(sanitized, "phase", record.phase, `${label}.phase`);
  assignOptionalCodeString(sanitized, "detector", record.detector, `${label}.detector`);
  assignOptionalCodeString(sanitized, "toolName", record.toolName, `${label}.toolName`);
  assignOptionalCodeString(
    sanitized,
    "activeWorkKind",
    record.activeWorkKind,
    `${label}.activeWorkKind`,
  );
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
  const evidence = readBundleEvidence(bundle.evidence);
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
    ...(evidence ? { evidence } : {}),
    snapshot: readStabilitySnapshot(bundle.snapshot),
  };
}

function readPositiveMemoryFile(file: string): number | "max" | undefined {
  try {
    const raw = fs.readFileSync(file, "utf8").trim();
    if (raw === "max") {
      return "max";
    }
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function readCgroupEventFile(file: string): Record<string, number> {
  try {
    const events: Record<string, number> = {};
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/u)) {
      const [key, raw] = line.trim().split(/\s+/u);
      if (!key || !SAFE_REASON_CODE.test(key)) {
        continue;
      }
      const value = Number.parseInt(raw ?? "", 10);
      if (Number.isFinite(value) && value >= 0) {
        events[key] = value;
      }
    }
    return events;
  } catch {
    return {};
  }
}

function resolveCgroupV2MemoryDir(): string | undefined {
  if (process.platform !== "linux") {
    return undefined;
  }
  try {
    const line = fs
      .readFileSync("/proc/self/cgroup", "utf8")
      .split(/\r?\n/u)
      .find((entry) => entry.startsWith("0::"));
    if (!line) {
      return undefined;
    }
    const rawPath = line.slice("0::".length).trim();
    const relative = rawPath.replace(/^\/+/u, "");
    return path.join("/sys/fs/cgroup", relative);
  } catch {
    return undefined;
  }
}

function collectCgroupMemorySummary(): DiagnosticCgroupMemorySummary | undefined {
  const dir = resolveCgroupV2MemoryDir();
  if (!dir) {
    return undefined;
  }
  const values: Record<string, number | "max"> = {};
  for (const name of CGROUP_V2_MEMORY_FILES) {
    const value = readPositiveMemoryFile(path.join(dir, `memory.${name}`));
    if (value !== undefined) {
      values[name] = value;
    }
  }
  const events: Record<string, number> = {};
  for (const name of CGROUP_V2_MEMORY_EVENTS) {
    const parsed = readCgroupEventFile(path.join(dir, `memory.${name}`));
    for (const [key, value] of Object.entries(parsed)) {
      events[name === "events" ? key : `${name}.${key}`] = value;
    }
  }
  return Object.keys(values).length > 0 || Object.keys(events).length > 0
    ? { version: "v2", values, events }
    : undefined;
}

function collectHeapStatistics(): DiagnosticHeapStatisticsSummary | undefined {
  try {
    const stats = v8.getHeapStatistics();
    return {
      totalHeapSizeBytes: stats.total_heap_size,
      totalHeapSizeExecutableBytes: stats.total_heap_size_executable,
      totalPhysicalSizeBytes: stats.total_physical_size,
      totalAvailableSizeBytes: stats.total_available_size,
      usedHeapSizeBytes: stats.used_heap_size,
      heapSizeLimitBytes: stats.heap_size_limit,
      mallocedMemoryBytes: stats.malloced_memory,
      externalMemoryBytes: stats.external_memory,
    };
  } catch {
    return undefined;
  }
}

function collectHeapSpaces(): DiagnosticHeapSpaceSummary[] | undefined {
  try {
    const spaces = v8.getHeapSpaceStatistics().map((space) => ({
      spaceName: space.space_name,
      spaceSizeBytes: space.space_size,
      spaceUsedBytes: space.space_used_size,
      spaceAvailableBytes: space.space_available_size,
      physicalSpaceSizeBytes: space.physical_space_size,
    }));
    return spaces.length > 0 ? spaces : undefined;
  } catch {
    return undefined;
  }
}

function collectActiveResources(): DiagnosticActiveResourceSummary | undefined {
  try {
    if (typeof process.getActiveResourcesInfo !== "function") {
      return undefined;
    }
    const names = process.getActiveResourcesInfo();
    const byType: Record<string, number> = {};
    for (const name of names) {
      if (!SAFE_REASON_CODE.test(name)) {
        continue;
      }
      byType[name] = (byType[name] ?? 0) + 1;
    }
    const sorted = Object.entries(byType)
      .toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, MAX_ACTIVE_RESOURCE_TYPES);
    return { total: names.length, byType: Object.fromEntries(sorted) };
  } catch {
    return undefined;
  }
}

function sanitizeSessionEvidencePath(relativePath: string): string {
  const parts = relativePath.split("/");
  if (parts.length === 4 && parts[0] === "agents" && parts[2] === "sessions") {
    return `agents/<agent>/sessions/${sanitizeSessionEvidenceFileName(parts[3])}`;
  }
  if (parts.length === 2 && parts[0] === "sessions") {
    return `sessions/${sanitizeSessionEvidenceFileName(parts[1])}`;
  }
  return redactSensitiveText(relativePath, { mode: "tools" });
}

function sanitizeSessionEvidenceFileName(fileName: string): string {
  if (fileName === "sessions.json") {
    return "sessions.json";
  }
  if (fileName.endsWith(".jsonl")) {
    return "<session>.jsonl";
  }
  if (fileName.endsWith(".json")) {
    return "<session>.json";
  }
  return "<session>";
}

function visitDirentsBounded(
  dir: string,
  maxEntries: number,
  visitor: (entry: fs.Dirent) => boolean | void,
): void {
  if (maxEntries <= 0) {
    return;
  }
  let handle: fs.Dir | undefined;
  try {
    handle = fs.opendirSync(dir);
    for (let count = 0; count < maxEntries; count += 1) {
      const entry = handle.readSync();
      if (!entry || visitor(entry) === false) {
        return;
      }
    }
  } catch {
    // Best-effort diagnostic evidence only.
  } finally {
    try {
      handle?.closeSync();
    } catch {
      // Best-effort diagnostic evidence only.
    }
  }
}

function pushSessionFileSummary(
  results: DiagnosticSessionFileSummary[],
  stateDir: string,
  file: string,
  relativePathOverride?: string,
): void {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) {
      return;
    }
    const relativePath = (relativePathOverride ?? path.relative(stateDir, file)).replace(
      /\\/gu,
      "/",
    );
    if (relativePath.startsWith("../") || path.isAbsolute(relativePath)) {
      return;
    }
    results.push({
      relativePath: sanitizeSessionEvidencePath(relativePath),
      sizeBytes: stat.size,
      mtimeMs: stat.mtimeMs,
    });
  } catch {
    // Best-effort diagnostic evidence only.
  }
}

function scanSessionDirectory(params: {
  results: DiagnosticSessionFileSummary[];
  stateDir: string;
  sessionsDir: string;
  relativePrefix: string;
  seenDirs: Set<string>;
  scannedSessionEntries: { count: number };
}): void {
  const sessionsDir = path.resolve(params.sessionsDir);
  if (params.seenDirs.has(sessionsDir)) {
    return;
  }
  params.seenDirs.add(sessionsDir);
  visitDirentsBounded(
    sessionsDir,
    MAX_SESSION_SCAN_FILES - params.scannedSessionEntries.count,
    (sessionEntry) => {
      params.scannedSessionEntries.count += 1;
      if (!sessionEntry.isFile() || !/\.(?:jsonl|json)$/u.test(sessionEntry.name)) {
        return params.scannedSessionEntries.count < MAX_SESSION_SCAN_FILES;
      }
      pushSessionFileSummary(
        params.results,
        params.stateDir,
        path.join(sessionsDir, sessionEntry.name),
        path.posix.join(params.relativePrefix, sessionEntry.name),
      );
      return params.scannedSessionEntries.count < MAX_SESSION_SCAN_FILES;
    },
  );
}

function collectTopSessionFiles(
  stateDir: string,
  sessionStorePaths: string[] = [],
): DiagnosticSessionFileSummary[] | undefined {
  const results: DiagnosticSessionFileSummary[] = [];
  const seenDirs = new Set<string>();
  const scannedSessionEntries = { count: 0 };
  try {
    pushSessionFileSummary(results, stateDir, path.join(stateDir, "sessions.json"));
    const agentsDir = path.join(stateDir, "agents");
    visitDirentsBounded(agentsDir, MAX_SESSION_SCAN_AGENTS, (agentEntry) => {
      if (!agentEntry.isDirectory() || scannedSessionEntries.count >= MAX_SESSION_SCAN_FILES) {
        return;
      }
      scanSessionDirectory({
        results,
        stateDir,
        sessionsDir: path.join(agentsDir, agentEntry.name, "sessions"),
        relativePrefix: path.posix.join("agents", agentEntry.name, "sessions"),
        seenDirs,
        scannedSessionEntries,
      });
    });
    for (const storePath of sessionStorePaths) {
      if (scannedSessionEntries.count >= MAX_SESSION_SCAN_FILES) {
        break;
      }
      const sessionsDir = path.dirname(path.resolve(storePath));
      scanSessionDirectory({
        results,
        stateDir,
        sessionsDir,
        relativePrefix: "sessions",
        seenDirs,
        scannedSessionEntries,
      });
    }
  } catch {
    // Best-effort diagnostic evidence only.
  }
  const top = results
    .toSorted((a, b) => b.sizeBytes - a.sizeBytes || a.relativePath.localeCompare(b.relativePath))
    .slice(0, MAX_SESSION_FILE_RESULTS);
  return top.length > 0 ? top : undefined;
}

function buildMemoryPressureEvidence(
  options: WriteDiagnosticMemoryPressureBundleOptions,
): DiagnosticStabilityBundleEvidence {
  const stateDir = options.stateDir ?? resolveStateDir(options.env ?? process.env);
  const heapStatistics = collectHeapStatistics();
  const heapSpaces = collectHeapSpaces();
  const cgroup = collectCgroupMemorySummary();
  const activeResources = collectActiveResources();
  const topSessionFiles = collectTopSessionFiles(stateDir, options.sessionStorePaths);
  return {
    memoryPressure: {
      level: options.pressure.level,
      reason: options.pressure.reason,
      memory: options.pressure.memory,
      ...(options.pressure.thresholdBytes !== undefined
        ? { thresholdBytes: options.pressure.thresholdBytes }
        : {}),
      ...(options.pressure.rssGrowthBytes !== undefined
        ? { rssGrowthBytes: options.pressure.rssGrowthBytes }
        : {}),
      ...(options.pressure.windowMs !== undefined ? { windowMs: options.pressure.windowMs } : {}),
      ...(heapStatistics ? { heapStatistics } : {}),
      ...(heapSpaces ? { heapSpaces } : {}),
      ...(cgroup ? { cgroup } : {}),
      ...(activeResources ? { activeResources } : {}),
      ...(topSessionFiles ? { topSessionFiles } : {}),
    },
  };
}

function isMemoryPressureReason(reason: string): reason is DiagnosticMemoryPressureEvent["reason"] {
  return reason === "rss_threshold" || reason === "heap_threshold" || reason === "rss_growth";
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
      ...(options.evidence ? { evidence: options.evidence } : {}),
      snapshot,
    };

    const dir = resolveDiagnosticStabilityBundleDir(options);
    const file = buildBundlePath(dir, now, reason);
    replaceFileAtomicSync({
      filePath: file,
      content: `${JSON.stringify(bundle, null, 2)}\n`,
      dirMode: 0o700,
      mode: 0o600,
      tempPrefix: ".openclaw-stability",
    });
    pruneOldBundles(dir, options.retention ?? DEFAULT_DIAGNOSTIC_STABILITY_BUNDLE_RETENTION);
    return { status: "written", path: file, bundle };
  } catch (error) {
    return { status: "failed", error };
  }
}

export function writeDiagnosticMemoryPressureBundleSync(
  options: WriteDiagnosticMemoryPressureBundleOptions,
): WriteDiagnosticStabilityBundleResult {
  return writeDiagnosticStabilityBundleSync({
    ...options,
    reason: "diagnostic.memory.pressure.critical",
    includeEmpty: true,
    evidence: buildMemoryPressureEvidence(options),
  });
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
