/**
 * Generic versioned JSON-file provider for task lanes.
 *
 * Safety:
 *   - Path is resolved to its realpath; the resulting file must reside under
 *     a caller-supplied root directory (no symlink escape, no traversal).
 *   - File size is bounded by TASK_LANE_MAX_FILE_BYTES.
 *   - Failure messages never echo filesystem paths or file content: diagnostics are
 *     RPC-visible, so an unreadable file reports a node errno code (ENOENT/EISDIR/...)
 *     rather than the absolute path node embeds in its raw messages.
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
import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import {
  TASK_LANE_MAX_FILE_BYTES,
  TASK_LANE_MAX_ITEMS_PER_LANE,
  TASK_LANE_MAX_LANES,
  TASK_LANE_MAX_OUTCOME_CHARS,
  TASK_LANE_MAX_TITLE_CHARS,
  TASK_LANE_SCHEMA_VERSION,
  normalizeTaskLaneItemState,
  truncateTaskLaneText,
  type TaskLane,
  type TaskLaneItem,
  type TaskLaneItemState,
  type TaskLaneProvider,
} from "../types.js";

const ALLOWED_URL_SCHEMES = new Set(["http:", "https:"]);

/** Injectable file reader so tests can stub the filesystem. */
type JsonFileReader = (filePath: string) => Promise<Buffer>;

/** Distinguished so the loader rethrows it unwrapped by the generic read-error diagnostic. */
class TaskLaneFileTooLargeError extends Error {}

const defaultReader: JsonFileReader = async (filePath) => {
  const handle = await fs.open(filePath, "r");
  try {
    const stat = await handle.stat();
    if (stat.size > TASK_LANE_MAX_FILE_BYTES) {
      throw new TaskLaneFileTooLargeError(
        `task lane file too large: ${stat.size} > ${TASK_LANE_MAX_FILE_BYTES}`,
      );
    }
    // One spare byte detects a file that grew between stat and read; the
    // byte-length cap check below still backstops it.
    const buffer = Buffer.alloc(TASK_LANE_MAX_FILE_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, TASK_LANE_MAX_FILE_BYTES + 1, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
};

/** Returns true when `child` is the same path as `parent` or sits inside it. */
function isPathInside(parent: string, child: string): boolean {
  if (parent === child) {
    return true;
  }
  const rel = path.relative(parent, child);
  return rel.length > 0 && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** C0 controls plus DEL are unusable inside URLs and whitespace-bearing text. */
function hasControlChar(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

function sanitizeArtifactUrl(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || hasControlChar(trimmed)) {
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

// The taskLanes.list contract declares millisecond fields as non-negative
// integers; provider JSON is untrusted, so anything else is dropped here.
function asNonNegativeIntegerMs(value: unknown): number | undefined {
  const parsed = asFiniteNumber(value);
  return parsed !== undefined && Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function normalizeLaneItem(value: unknown): TaskLaneItem | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  // SAFETY: caller checked `value` is a non-null object before casting.
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id.length === 0) {
    return null;
  }
  if (typeof record.title !== "string" || record.title.length === 0) {
    return null;
  }
  const state: TaskLaneItemState = normalizeTaskLaneItemState(record.state);
  const startedAtMs = asNonNegativeIntegerMs(record.startedAtMs);
  const heartbeatAtMs = asNonNegativeIntegerMs(record.heartbeatAtMs);
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
  // SAFETY: caller checked `value` is a non-null object before casting.
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
 * Extracts a node errno code from a fs error. The raw message is never reused
 * because node embeds the absolute path it failed on.
 */
function fsErrorCode(error: unknown): string {
  // SAFETY: fs errors may be arbitrary throwables; optional chain + typeof guard tolerate that.
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" ? code : "read failed";
}

/**
 * Loads a versioned JSON file and converts it to a lane set, enforcing
 * realpath/size/bounds safety. Throws when the file cannot be trusted.
 */
async function loadJsonFileProviderLanes(options: JsonFileProviderOptions): Promise<{
  lanes: TaskLane[];
}> {
  let rootRealpath: string;
  try {
    rootRealpath = await (options.resolveRealpath ?? realpath)(path.resolve(options.rootDir));
  } catch (error) {
    throw new Error(`task lane root directory is unavailable (${fsErrorCode(error)})`, {
      cause: error,
    });
  }
  const candidate = path.isAbsolute(options.filePath)
    ? options.filePath
    : path.resolve(options.rootDir, options.filePath);
  let real: string;
  try {
    real = await (options.resolveRealpath ?? realpath)(candidate);
  } catch (error) {
    throw new Error(`task lane file is unavailable (${fsErrorCode(error)})`, { cause: error });
  }
  if (!isPathInside(rootRealpath, real)) {
    throw new Error("task lane file escapes root");
  }
  let buffer: Buffer;
  try {
    buffer = await (options.reader ?? defaultReader)(real);
  } catch (error) {
    if (error instanceof TaskLaneFileTooLargeError) {
      throw error;
    }
    throw new Error(`task lane file could not be read (${fsErrorCode(error)})`, { cause: error });
  }
  if (buffer.byteLength > TASK_LANE_MAX_FILE_BYTES) {
    throw new Error(`task lane file too large: ${buffer.byteLength} > ${TASK_LANE_MAX_FILE_BYTES}`);
  }
  const text = buffer.toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("task lane file is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("task lane file root is not an object");
  }
  // SAFETY: caller checked `parsed` is a non-null non-array object before casting.
  const root = parsed as Record<string, unknown>;
  if (root.schemaVersion !== TASK_LANE_SCHEMA_VERSION) {
    // Diagnostics are RPC-visible; the file's schemaVersion value is untrusted
    // and never echoed back.
    throw new Error(`unsupported task lane schemaVersion (expected ${TASK_LANE_SCHEMA_VERSION})`);
  }
  if (!Array.isArray(root.lanes)) {
    throw new Error("task lane file is missing the lanes array");
  }
  const lanes: TaskLane[] = [];
  const seenLaneIds = new Set<string>();
  for (const candidateLane of root.lanes) {
    if (lanes.length >= TASK_LANE_MAX_LANES) {
      break;
    }
    const lane = normalizeLane(candidateLane);
    if (lane) {
      // Duplicate ids would merge two lanes' items under one provider/lane key.
      // The id itself is file content and is never echoed in diagnostics.
      if (seenLaneIds.has(lane.id)) {
        throw new Error("task lane file has duplicate lane ids");
      }
      seenLaneIds.add(lane.id);
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
