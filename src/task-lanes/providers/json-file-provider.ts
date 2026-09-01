/**
 * Generic versioned JSON-file provider for task lanes.
 *
 * Safety:
 *   - Path is resolved to its realpath; the resulting file must reside under
 *     a caller-supplied root directory (no symlink escape, no traversal).
 *   - File size is bounded by TASK_LANE_MAX_FILE_BYTES.
 *   - Lane and item counts are bounded by TASK_LANE_MAX_LANES and
 *     TASK_LANE_MAX_ITEMS_PER_LANE.
 *   - artifactUrl is normalized to a safe http(s) URL; any other scheme,
 *     absolute path, traversal segment, or whitespace/control character
 *     drops the field rather than rendering unsafe text.
 *
 * The schema is intentionally minimal so unrelated integrations can adopt it
 * without coupling to cron, secrets, or any other private module.
 */

import { promises as fs } from "node:fs";
import { realpath } from "node:fs/promises";
import path from "node:path";
import {
  TASK_LANE_MAX_FILE_BYTES,
  TASK_LANE_MAX_ITEMS_PER_LANE,
  TASK_LANE_MAX_LANES,
  TASK_LANE_MAX_OUTCOME_CHARS,
  TASK_LANE_MAX_TITLE_CHARS,
  TASK_LANE_SCHEMA_VERSION,
  type TaskLane,
  type TaskLaneItem,
  type TaskLaneItemState,
  type TaskLaneProvider,
} from "../types.js";
import { normalizeTaskLaneItemState, truncateTaskLaneText } from "../types.js";

const ALLOWED_URL_SCHEMES = new Set(["http:", "https:"]);

/** Public hook so tests can stub the file reader. */
export type JsonFileReader = (filePath: string) => Promise<Buffer>;

const defaultReader: JsonFileReader = (filePath) => fs.readFile(filePath);

/** Returns true when `child` is the same path as `parent` or sits inside it. */
function isPathInside(parent: string, child: string): boolean {
  if (parent === child) {
    return true;
  }
  const rel = path.relative(parent, child);
  return rel.length > 0 && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function sanitizeArtifactUrl(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || /[\s\u0000-\u001f]/.test(trimmed)) {
    return undefined;
  }
  if (trimmed.includes("..")) {
    return undefined;
  }
  try {
    const parsed = new URL(trimmed);
    if (!ALLOWED_URL_SCHEMES.has(parsed.protocol)) {
      return undefined;
    }
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function normalizeLaneItem(value: unknown): TaskLaneItem | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id.length === 0) {
    return null;
  }
  if (typeof record.title !== "string" || record.title.length === 0) {
    return null;
  }
  const state: TaskLaneItemState = normalizeTaskLaneItemState(record.state);
  const startedAtMs = asFiniteNumber(record.startedAtMs);
  const heartbeatAtMs = asFiniteNumber(record.heartbeatAtMs);
  const outcome =
    typeof record.outcome === "string" && record.outcome.length > 0
      ? truncateTaskLaneText(record.outcome, TASK_LANE_MAX_OUTCOME_CHARS)
      : undefined;
  const artifactUrl = sanitizeArtifactUrl(record.artifactUrl);
  return {
    id: record.id,
    title: truncateTaskLaneText(record.title, TASK_LANE_MAX_TITLE_CHARS),
    state,
    ...(startedAtMs !== undefined ? { startedAtMs } : {}),
    ...(heartbeatAtMs !== undefined ? { heartbeatAtMs } : {}),
    ...(outcome ? { outcome } : {}),
    ...(artifactUrl ? { artifactUrl } : {}),
  };
}

function normalizeLane(value: unknown): TaskLane | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id.length === 0) {
    return null;
  }
  if (typeof record.label !== "string" || record.label.length === 0) {
    return null;
  }
  if (!Array.isArray(record.items)) {
    return null;
  }
  const items: TaskLaneItem[] = [];
  for (const candidate of record.items) {
    if (items.length >= TASK_LANE_MAX_ITEMS_PER_LANE) {
      break;
    }
    const normalized = normalizeLaneItem(candidate);
    if (normalized) {
      items.push(normalized);
    }
  }
  return {
    id: record.id,
    label: truncateTaskLaneText(record.label, TASK_LANE_MAX_TITLE_CHARS),
    items,
  };
}

export type JsonFileProviderOptions = {
  /** Caller-supplied root; the resolved file must live under it. */
  rootDir: string;
  /** Absolute or root-relative file path. */
  filePath: string;
  /** Override for tests. */
  reader?: JsonFileReader;
  /** Override for tests; defaults to node:fs/promises realpath. */
  resolveRealpath?: (filePath: string) => Promise<string>;
};

/**
 * Loads a versioned JSON file and converts it to a lane set, enforcing
 * realpath/size/bounds safety. Throws when the file cannot be trusted.
 */
export async function loadJsonFileProviderLanes(options: JsonFileProviderOptions): Promise<{
  lanes: TaskLane[];
}> {
  const rootRealpath = await (options.resolveRealpath ?? realpath)(path.resolve(options.rootDir));
  const candidate = path.isAbsolute(options.filePath)
    ? options.filePath
    : path.resolve(options.rootDir, options.filePath);
  const real = await (options.resolveRealpath ?? realpath)(candidate);
  if (!isPathInside(rootRealpath, real)) {
    throw new Error(`task lane file escapes root: ${real}`);
  }
  const buffer = await (options.reader ?? defaultReader)(real);
  if (buffer.byteLength > TASK_LANE_MAX_FILE_BYTES) {
    throw new Error(`task lane file too large: ${buffer.byteLength} > ${TASK_LANE_MAX_FILE_BYTES}`);
  }
  const text = buffer.toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `task lane file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("task lane file root is not an object");
  }
  const root = parsed as Record<string, unknown>;
  if (root.schemaVersion !== TASK_LANE_SCHEMA_VERSION) {
    throw new Error(`unsupported task lane schemaVersion: ${String(root.schemaVersion)}`);
  }
  if (!Array.isArray(root.lanes)) {
    throw new Error("task lane file is missing the lanes array");
  }
  const lanes: TaskLane[] = [];
  for (const candidateLane of root.lanes) {
    if (lanes.length >= TASK_LANE_MAX_LANES) {
      break;
    }
    const lane = normalizeLane(candidateLane);
    if (lane) {
      lanes.push(lane);
    }
  }
  return { lanes };
}

/** Builds a provider id-stable wrapper that resolves the file each call. */
export function createJsonFileProvider(
  id: string,
  options: JsonFileProviderOptions,
): TaskLaneProvider {
  return {
    id,
    label: `JSON file (${path.basename(options.filePath)})`,
    load: () => loadJsonFileProviderLanes(options),
  };
}
