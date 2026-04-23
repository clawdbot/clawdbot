import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { parseConfigJson5 } from "../config/io.js";
import { resolveConfigPath, resolveStateDir } from "../config/paths.js";
import { redactConfigObject } from "../config/redact-snapshot.js";
import { resolveHomeRelativePath } from "../infra/home-dir.js";
import { VERSION } from "../version.js";
import {
  readDiagnosticStabilityBundleFileSync,
  readLatestDiagnosticStabilityBundleSync,
  type ReadDiagnosticStabilityBundleResult,
} from "./diagnostic-stability-bundle.js";
import {
  jsonSupportBundleFile,
  jsonlSupportBundleFile,
  supportBundleContents,
  textSupportBundleFile,
  writeSupportBundleZip,
  type DiagnosticSupportBundleContent,
  type DiagnosticSupportBundleFile,
} from "./diagnostic-support-bundle.js";
import { sanitizeSupportLogRecord } from "./diagnostic-support-log-redaction.js";
import {
  redactPathForSupport,
  redactSupportString,
  redactTextForSupport,
  sanitizeSupportConfigValue,
  sanitizeSupportSnapshotValue,
  type SupportRedactionContext,
} from "./diagnostic-support-redaction.js";
import { readConfiguredLogTail, type LogTailPayload } from "./log-tail.js";

export const DIAGNOSTIC_SUPPORT_EXPORT_VERSION = 1;

const DEFAULT_LOG_LIMIT = 5000;
const DEFAULT_LOG_MAX_BYTES = 1_000_000;
const SUPPORT_EXPORT_PREFIX = "openclaw-diagnostics-";
const SUPPORT_EXPORT_SUFFIX = ".zip";
type Awaitable<T> = T | Promise<T>;
type SupportSnapshotReader = () => Awaitable<unknown>;

export type DiagnosticSupportExportOptions = {
  outputPath?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
  now?: Date;
  logLimit?: number;
  logMaxBytes?: number;
  stabilityBundle?: string | false;
  readLogTail?: typeof readConfiguredLogTail;
  readStatusSnapshot?: SupportSnapshotReader;
  readHealthSnapshot?: SupportSnapshotReader;
};

export type DiagnosticSupportExportManifest = {
  version: typeof DIAGNOSTIC_SUPPORT_EXPORT_VERSION;
  generatedAt: string;
  openclawVersion: string;
  platform: NodeJS.Platform;
  arch: string;
  node: string;
  stateDir: string;
  contents: DiagnosticSupportBundleContent[];
  privacy: {
    payloadFree: true;
    rawLogsIncluded: false;
    notes: string[];
  };
};

export type DiagnosticSupportExportFile = DiagnosticSupportBundleFile;

export type DiagnosticSupportExportArtifact = {
  manifest: DiagnosticSupportExportManifest;
  files: DiagnosticSupportExportFile[];
};

export type WriteDiagnosticSupportExportResult = {
  path: string;
  bytes: number;
  manifest: DiagnosticSupportExportManifest;
};

type ConfigShape = {
  path: string;
  exists: boolean;
  parseOk: boolean;
  bytes?: number;
  mtime?: string;
  error?: string;
  topLevelKeys: string[];
  gateway?: {
    mode?: unknown;
    bind?: unknown;
    port?: unknown;
    authMode?: unknown;
    tailscale?: unknown;
  };
  channels?: {
    count: number;
    ids: string[];
  };
  plugins?: {
    count: number;
    ids: string[];
  };
  agents?: {
    count: number;
  };
};

type ConfigExport = {
  shape: ConfigShape;
  sanitized?: unknown;
};

type IncludedSanitizedLogTail = {
  status: "included";
  file: string;
  cursor: number;
  size: number;
  lineCount: number;
  truncated: boolean;
  reset: boolean;
  lines: Array<Record<string, unknown>>;
};

type FailedSanitizedLogTail = Omit<IncludedSanitizedLogTail, "status"> & {
  status: "failed";
  error: string;
};

type SanitizedLogTail = IncludedSanitizedLogTail | FailedSanitizedLogTail;

type SupportSnapshotStatus =
  | {
      status: "included";
      path: string;
    }
  | {
      status: "failed";
      path: string;
      error: string;
    }
  | {
      status: "skipped";
    };

type CollectedSupportSnapshot = {
  summary: SupportSnapshotStatus;
  file?: DiagnosticSupportExportFile;
};

function formatExportTimestamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

function normalizePositiveInteger(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }
  return Math.floor(parsed);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function safeScalar(value: unknown): unknown {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const redacted = redactTextForSupport(value);
    return redacted === value && /^[A-Za-z0-9_.:-]{1,120}$/u.test(value) ? value : "<redacted>";
  }
  return undefined;
}

function sortedObjectKeys(value: unknown): string[] {
  return Object.keys(asRecord(value) ?? {}).toSorted((a, b) => a.localeCompare(b));
}

function sanitizeConfigShape(parsed: unknown, configPath: string, stat: fs.Stats): ConfigShape {
  const root = asRecord(parsed) ?? {};
  const gateway = asRecord(root.gateway);
  const auth = asRecord(gateway?.auth);
  const channels = asRecord(root.channels);
  const plugins = asRecord(root.plugins);
  const agents = Array.isArray(root.agents) ? root.agents : undefined;

  const shape: ConfigShape = {
    path: configPath,
    exists: true,
    parseOk: true,
    bytes: stat.size,
    mtime: stat.mtime.toISOString(),
    topLevelKeys: sortedObjectKeys(root),
  };

  if (gateway) {
    shape.gateway = {
      mode: safeScalar(gateway.mode),
      bind: safeScalar(gateway.bind),
      port: safeScalar(gateway.port),
      authMode: safeScalar(auth?.mode),
      tailscale: safeScalar(gateway.tailscale),
    };
  }

  if (channels) {
    shape.channels = {
      count: Object.keys(channels).length,
      ids: sortedObjectKeys(channels),
    };
  }

  if (plugins) {
    shape.plugins = {
      count: Object.keys(plugins).length,
      ids: sortedObjectKeys(plugins),
    };
  }

  if (agents) {
    shape.agents = { count: agents.length };
  }

  return shape;
}

function sanitizeConfigDetails(parsed: unknown, redaction: SupportRedactionContext): unknown {
  return sanitizeSupportConfigValue(redactConfigObject(parsed), redaction);
}

function configShapeReadFailure(params: {
  configPath: string;
  redaction: SupportRedactionContext;
  stat?: fs.Stats;
  error?: string;
}): ConfigShape {
  const shape: ConfigShape = {
    path: params.configPath,
    exists: Boolean(params.stat),
    parseOk: false,
    topLevelKeys: [],
  };
  if (params.stat) {
    shape.bytes = params.stat.size;
    shape.mtime = params.stat.mtime.toISOString();
  }
  if (params.error) {
    shape.error = redactSupportString(params.error, params.redaction);
  }
  return shape;
}

function isMissingPathError(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) {
    return false;
  }
  return error.code === "ENOENT" || error.code === "ENOTDIR";
}

function configReadErrorMessage(error: unknown, stat?: fs.Stats): string | undefined {
  if (!stat && isMissingPathError(error)) {
    return undefined;
  }
  return error instanceof Error ? error.message : String(error);
}

function readConfigExport(options: {
  configPath: string;
  env: NodeJS.ProcessEnv;
  stateDir: string;
}): ConfigExport {
  const redactedConfigPath = redactPathForSupport(options.configPath, options);
  let stat: fs.Stats | undefined;
  try {
    stat = fs.statSync(options.configPath);
    const parsed = parseConfigJson5(fs.readFileSync(options.configPath, "utf8"));
    if (!parsed.ok) {
      return {
        shape: configShapeReadFailure({
          configPath: redactedConfigPath,
          redaction: options,
          stat,
          error: parsed.error,
        }),
      };
    }
    return {
      shape: sanitizeConfigShape(parsed.parsed, redactedConfigPath, stat),
      sanitized: sanitizeConfigDetails(parsed.parsed, options),
    };
  } catch (error) {
    return {
      shape: configShapeReadFailure({
        configPath: redactedConfigPath,
        redaction: options,
        stat,
        error: configReadErrorMessage(error, stat),
      }),
    };
  }
}

function redactErrorForSupport(error: unknown, redaction: SupportRedactionContext): string {
  return redactSupportString(error instanceof Error ? error.message : String(error), redaction);
}

async function collectSupportSnapshot(params: {
  path: string;
  reader?: SupportSnapshotReader;
  generatedAt: string;
  redaction: SupportRedactionContext;
}): Promise<CollectedSupportSnapshot> {
  if (!params.reader) {
    return { summary: { status: "skipped" } };
  }
  try {
    const data = await params.reader();
    return {
      summary: {
        status: "included",
        path: params.path,
      },
      file: jsonSupportBundleFile(params.path, {
        status: "ok",
        capturedAt: params.generatedAt,
        data: sanitizeSupportSnapshotValue(data, params.redaction),
      }),
    };
  } catch (error) {
    const redactedError = redactErrorForSupport(error, params.redaction);
    return {
      summary: {
        status: "failed",
        path: params.path,
        error: redactedError,
      },
      file: jsonSupportBundleFile(params.path, {
        status: "failed",
        capturedAt: params.generatedAt,
        error: redactedError,
      }),
    };
  }
}

function readStabilityBundle(
  target: DiagnosticSupportExportOptions["stabilityBundle"],
  stateDir: string,
): ReadDiagnosticStabilityBundleResult {
  if (target === false) {
    return { status: "missing", dir: "$OPENCLAW_STATE_DIR/logs/stability" };
  }
  if (target === undefined || target === "latest") {
    return readLatestDiagnosticStabilityBundleSync({ stateDir });
  }
  return readDiagnosticStabilityBundleFileSync(target);
}

function sanitizeLogTail(tail: LogTailPayload, options: SupportRedactionContext): SanitizedLogTail {
  return {
    status: "included",
    file: redactPathForSupport(tail.file, options),
    cursor: tail.cursor,
    size: tail.size,
    lineCount: tail.lines.length,
    truncated: tail.truncated,
    reset: tail.reset,
    lines: tail.lines.map((line) => sanitizeSupportLogRecord(line, options)),
  };
}

function failedLogTail(error: unknown, redaction: SupportRedactionContext): SanitizedLogTail {
  const redactedError = redactErrorForSupport(error, redaction);
  return {
    status: "failed",
    file: "unavailable",
    cursor: 0,
    size: 0,
    lineCount: 0,
    truncated: false,
    reset: false,
    error: redactedError,
    lines: [
      {
        omitted: "log-tail-read-failed",
        error: redactedError,
      },
    ],
  };
}

async function collectSupportLogTail(params: {
  readLogTail: typeof readConfiguredLogTail;
  limit: number;
  maxBytes: number;
  redaction: SupportRedactionContext;
}): Promise<SanitizedLogTail> {
  try {
    const tail = await params.readLogTail({
      limit: params.limit,
      maxBytes: params.maxBytes,
    });
    return sanitizeLogTail(tail, params.redaction);
  } catch (error) {
    return failedLogTail(error, params.redaction);
  }
}

function describeStabilityForDiagnostics(
  stability: ReadDiagnosticStabilityBundleResult,
  redaction: SupportRedactionContext,
) {
  if (stability.status === "found") {
    return {
      status: "found" as const,
      path: redactPathForSupport(stability.path, redaction),
      mtimeMs: stability.mtimeMs,
      eventCount: stability.bundle.snapshot.count,
      reason: stability.bundle.reason,
      generatedAt: stability.bundle.generatedAt,
    };
  }

  if (stability.status === "missing") {
    return {
      status: "missing" as const,
      dir: redactPathForSupport(stability.dir, redaction),
    };
  }

  return {
    status: "failed" as const,
    path: stability.path ? redactPathForSupport(stability.path, redaction) : undefined,
    error: redactErrorForSupport(stability.error, redaction),
  };
}

function renderSummary(params: {
  generatedAt: string;
  stability: ReadDiagnosticStabilityBundleResult;
  logTail: SanitizedLogTail;
  config: ConfigShape;
  status: SupportSnapshotStatus;
  health: SupportSnapshotStatus;
}): string {
  const stabilityLine =
    params.stability.status === "found"
      ? `included latest stability bundle (${params.stability.bundle.snapshot.count} event(s))`
      : `no stability bundle included (${params.stability.status})`;
  const configLine = params.config.exists
    ? `config shape included (${params.config.parseOk ? "parsed" : "parse failed"})`
    : "config file not found";
  const logTailLine =
    params.logTail.status === "failed"
      ? `sanitized log tail unavailable (${params.logTail.error})`
      : `sanitized log tail (${params.logTail.lineCount} line(s), inspected ${params.logTail.size} byte(s), raw messages omitted)`;
  const supportSnapshotLine = (label: string, snapshot: SupportSnapshotStatus) => {
    if (snapshot.status === "included") {
      return `${label} snapshot included (${snapshot.path})`;
    }
    if (snapshot.status === "failed") {
      return `${label} snapshot failed (${snapshot.error})`;
    }
    return `${label} snapshot skipped`;
  };
  return [
    "# OpenClaw Diagnostics Export",
    "",
    "Attach this zip to the bug report. It is designed for maintainers to inspect without asking for raw logs first.",
    "",
    "## Generated",
    "",
    `Generated: ${params.generatedAt}`,
    `OpenClaw: ${VERSION}`,
    "",
    "## Contents",
    "",
    `- ${stabilityLine}`,
    `- ${logTailLine}`,
    `- ${configLine}`,
    `- ${supportSnapshotLine("gateway status", params.status)}`,
    `- ${supportSnapshotLine("gateway health", params.health)}`,
    "",
    "## Maintainer Quick Read",
    "",
    "- `manifest.json`: file inventory and privacy notes",
    "- `diagnostics.json`: top-level summary of config, logs, stability, status, and health",
    "- `config/sanitized.json`: config values with credentials, private identifiers, and prompt text redacted",
    "- `status/gateway-status.json`: sanitized service/connectivity snapshot",
    "- `health/gateway-health.json`: sanitized Gateway health snapshot",
    "- `logs/openclaw-sanitized.jsonl`: sanitized log summaries and metadata",
    "- `stability/latest.json`: newest payload-free stability bundle, when available",
    "",
    "## Privacy",
    "",
    "- raw chat text, webhook bodies, tool outputs, tokens, cookies, and secrets are not included intentionally",
    "- log records keep operational summaries and safe metadata fields",
    "- status and health snapshots redact secret fields, payload-like fields, and account/message identifiers",
    "- config output keeps useful settings but redacts secrets, private identifiers, and prompt text",
  ].join("\n");
}

function defaultOutputPath(options: { now: Date; stateDir: string }): string {
  return path.join(
    options.stateDir,
    "logs",
    "support",
    `${SUPPORT_EXPORT_PREFIX}${formatExportTimestamp(options.now)}-${process.pid}${SUPPORT_EXPORT_SUFFIX}`,
  );
}

function resolveOutputPath(options: {
  outputPath?: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  stateDir: string;
  now: Date;
}): string {
  const raw = options.outputPath?.trim();
  if (!raw) {
    return defaultOutputPath(options);
  }
  const resolved =
    path.isAbsolute(raw) || raw.startsWith("~")
      ? resolveHomeRelativePath(raw, { env: options.env })
      : path.resolve(options.cwd, raw);
  try {
    if (fs.statSync(resolved).isDirectory()) {
      return path.join(
        resolved,
        `${SUPPORT_EXPORT_PREFIX}${formatExportTimestamp(options.now)}-${process.pid}${SUPPORT_EXPORT_SUFFIX}`,
      );
    }
  } catch {
    // Non-existing output paths are treated as files.
  }
  return resolved;
}

export async function buildDiagnosticSupportExport(
  options: DiagnosticSupportExportOptions = {},
): Promise<DiagnosticSupportExportArtifact> {
  const env = options.env ?? process.env;
  const stateDir = options.stateDir ?? resolveStateDir(env);
  const now = options.now ?? new Date();
  const generatedAt = now.toISOString();
  const configPath = resolveConfigPath(env, stateDir);
  const stability = readStabilityBundle(options.stabilityBundle, stateDir);
  const redaction = { env, stateDir };
  const logTail = await collectSupportLogTail({
    readLogTail: options.readLogTail ?? readConfiguredLogTail,
    limit: normalizePositiveInteger(options.logLimit, DEFAULT_LOG_LIMIT),
    maxBytes: normalizePositiveInteger(options.logMaxBytes, DEFAULT_LOG_MAX_BYTES),
    redaction,
  });
  const config = readConfigExport({ configPath, env, stateDir });
  const [statusSnapshot, healthSnapshot] = await Promise.all([
    collectSupportSnapshot({
      path: "status/gateway-status.json",
      reader: options.readStatusSnapshot,
      generatedAt,
      redaction,
    }),
    collectSupportSnapshot({
      path: "health/gateway-health.json",
      reader: options.readHealthSnapshot,
      generatedAt,
      redaction,
    }),
  ]);
  const diagnostics = {
    generatedAt,
    openclawVersion: VERSION,
    process: {
      platform: process.platform,
      arch: process.arch,
      node: process.versions.node,
      pid: process.pid,
    },
    stateDir: redactPathForSupport(stateDir, redaction),
    config: config.shape,
    logs: {
      file: logTail.file,
      cursor: logTail.cursor,
      size: logTail.size,
      lineCount: logTail.lineCount,
      truncated: logTail.truncated,
      reset: logTail.reset,
    },
    stability: describeStabilityForDiagnostics(stability, redaction),
    status: statusSnapshot.summary,
    health: healthSnapshot.summary,
  };
  const files: DiagnosticSupportExportFile[] = [
    jsonSupportBundleFile("diagnostics.json", diagnostics),
    jsonSupportBundleFile("config/shape.json", config.shape),
    jsonSupportBundleFile("config/sanitized.json", config.sanitized ?? null),
    jsonlSupportBundleFile(
      "logs/openclaw-sanitized.jsonl",
      logTail.lines.map((line) => JSON.stringify(line)),
    ),
  ];
  for (const snapshot of [statusSnapshot, healthSnapshot]) {
    if (snapshot.file) {
      files.push(snapshot.file);
    }
  }

  if (stability.status === "found") {
    files.push(jsonSupportBundleFile("stability/latest.json", stability.bundle));
  }

  files.push(
    textSupportBundleFile(
      "summary.md",
      renderSummary({
        generatedAt,
        stability,
        logTail,
        config: config.shape,
        status: statusSnapshot.summary,
        health: healthSnapshot.summary,
      }),
    ),
  );

  const manifest: DiagnosticSupportExportManifest = {
    version: DIAGNOSTIC_SUPPORT_EXPORT_VERSION,
    generatedAt,
    openclawVersion: VERSION,
    platform: process.platform,
    arch: process.arch,
    node: process.versions.node,
    stateDir: redactPathForSupport(stateDir, redaction),
    contents: supportBundleContents(files),
    privacy: {
      payloadFree: true,
      rawLogsIncluded: false,
      notes: [
        "Stability bundles are payload-free diagnostic snapshots.",
        "Logs keep operational summaries and safe metadata fields; payload-like fields are omitted.",
        "Status and health snapshots redact secrets, payload-like fields, and account/message identifiers.",
        "Config output includes useful settings with credentials, private identifiers, and prompt text redacted.",
      ],
    },
  };

  return {
    manifest,
    files: [jsonSupportBundleFile("manifest.json", manifest), ...files],
  };
}

export async function writeDiagnosticSupportExport(
  options: DiagnosticSupportExportOptions = {},
): Promise<WriteDiagnosticSupportExportResult> {
  const env = options.env ?? process.env;
  const stateDir = options.stateDir ?? resolveStateDir(env);
  const now = options.now ?? new Date();
  const outputPath = resolveOutputPath({
    outputPath: options.outputPath,
    cwd: options.cwd ?? process.cwd(),
    env,
    stateDir,
    now,
  });
  const artifact = await buildDiagnosticSupportExport({ ...options, env, stateDir, now });
  const bytes = await writeSupportBundleZip({
    outputPath,
    files: artifact.files,
    compressionLevel: 6,
  });
  return {
    path: outputPath,
    bytes,
    manifest: artifact.manifest,
  };
}
