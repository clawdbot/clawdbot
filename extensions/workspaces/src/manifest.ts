// Custom-widget `widget.json` manifest load + validation (schema per 00 §2).
//
// The manifest is the sole source of truth for what a sandboxed widget is allowed
// to do: which static binding ids it may request, which capabilities it holds, and
// its entrypoint. The parent bridge (UI side) re-checks every child request against
// the manifest the operator approved and never resolves RPC/file bindings for custom
// code. Hand-written guards mirror `schema.ts` (no zod).

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { FsSafeError, root as fsRoot } from "openclaw/plugin-sdk/security-runtime";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { normalizeWorkspaceDataLogicalPath } from "./binding-contract.js";

export const CUSTOM_WIDGET_NAME_PATTERN = /^(?!__proto__$)[A-Za-z0-9._-]{1,64}$/;

/**
 * Content types the widget route will serve, keyed by lowercase extension. Owned
 * here because approval hashes exactly the set of files the route can hand to a
 * browser — the two must never drift.
 */
export const WIDGET_CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
};

/** Max servable files one widget may have; keeps the approval digest bounded. */
const MAX_WIDGET_FILES = 64;
const MAX_WIDGET_TREE_ENTRIES = 256;
/**
 * Byte caps on the assets approval hashes. Pending widget files are agent-authored
 * and untrusted: without a cap, dropping one huge file into the scaffold directory
 * would make approval read it into memory and stall or OOM the gateway.
 */
export const MAX_WIDGET_FILE_BYTES = 2 * 1024 * 1024;
const MAX_WIDGET_TOTAL_BYTES = 8 * 1024 * 1024;

/** sha256 of one file's bytes, lowercase hex. */
function hashBytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

type ApprovedWidgetSnapshot = {
  /** sha256 of every servable file, keyed by the logical path the route serves. */
  files: Record<string, string>;
  /** Parsed from the exact `widget.json` bytes that were hashed. */
  manifest: WidgetManifest;
};

type WidgetRoot = Awaited<ReturnType<typeof fsRoot>>;

async function listServableWidgetFiles(
  stateRoot: WidgetRoot,
  widgetRelativeDir: string,
): Promise<string[]> {
  const files: string[] = [];
  let entriesSeen = 0;
  async function visit(relativeDir: string, logicalDir: string): Promise<void> {
    const entries = await stateRoot.list(relativeDir, { withFileTypes: true });
    for (const entry of entries) {
      entriesSeen += 1;
      if (entriesSeen > MAX_WIDGET_TREE_ENTRIES) {
        throw new Error(`widget has more than ${MAX_WIDGET_TREE_ENTRIES} filesystem entries`);
      }
      const relative = path.posix.join(relativeDir, entry.name);
      const logical = path.posix.join(logicalDir, entry.name);
      if (entry.isDirectory) {
        await visit(relative, logical);
      } else if (entry.isFile && path.extname(logical).toLowerCase() in WIDGET_CONTENT_TYPES) {
        files.push(logical);
      }
    }
  }
  await visit(widgetRelativeDir, "");
  return files;
}

/**
 * Reads a widget's directory once and returns both the digests of every servable
 * file and the manifest parsed from the very bytes that were hashed.
 *
 * This is what an operator approves. Hashing matters because "approved" must name
 * the code, not the directory: otherwise an agent could win approval on an
 * innocuous tree and write the real payload afterwards. Parsing the manifest from
 * the hashed bytes matters for the same reason one level up — reading `widget.json`
 * twice would let it change between the read that validates the entrypoint and the
 * read that freezes the digest, so the operator would approve one manifest while a
 * different one got served.
 */
export async function snapshotApprovedWidget(
  name: string,
  options: { stateDir?: string } = {},
): Promise<ApprovedWidgetSnapshot> {
  const stateDir = path.resolve(options.stateDir ?? resolveStateDir());
  const widgetDir = resolveWidgetDir(name, stateDir);
  const widgetRelativeDir = path.posix.join("workspaces", "widgets", name);
  let widgetRoot: WidgetRoot;
  let widgetReal: string;
  let logicalFiles: string[];
  try {
    widgetRoot = await fsRoot(stateDir, {
      hardlinks: "reject",
      maxBytes: MAX_WIDGET_FILE_BYTES,
      nonBlockingRead: true,
      symlinks: "reject",
    });
    const widgetStat = await fs.lstat(widgetDir);
    widgetReal = await fs.realpath(widgetDir);
    const expectedWidgetReal = path.join(widgetRoot.rootReal, "workspaces", "widgets", name);
    if (
      widgetStat.isSymbolicLink() ||
      !widgetStat.isDirectory() ||
      widgetReal !== expectedWidgetReal
    ) {
      throw new Error("widget directory is unsafe");
    }
    logicalFiles = await listServableWidgetFiles(widgetRoot, widgetRelativeDir);
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === "ENOENT" ||
      (error instanceof FsSafeError && error.code === "not-found")
    ) {
      throw new Error(`workspace widget not found: ${name}`, { cause: error });
    }
    throw error;
  }
  const files: Record<string, string> = {};
  let manifestBytes: Buffer | undefined;
  let totalBytes = 0;
  for (const logical of logicalFiles) {
    if (Object.keys(files).length >= MAX_WIDGET_FILES) {
      throw new Error(`widget has more than ${MAX_WIDGET_FILES} servable files`);
    }
    let bytes: Buffer;
    try {
      // Pin and validate the opened file before reading. A same-user agent can
      // create hardlinks, so path containment alone cannot define approval.
      const read = await widgetRoot.read(path.posix.join(widgetRelativeDir, logical), {
        hardlinks: "reject",
        maxBytes: MAX_WIDGET_FILE_BYTES,
        nonBlockingRead: true,
        symlinks: "reject",
      });
      // The state-root reader blocks escapes, while this identity check also
      // blocks a widget-directory swap to another location inside stateDir.
      if (read.realPath !== widgetReal && !read.realPath.startsWith(`${widgetReal}${path.sep}`)) {
        throw new Error("widget directory changed during approval");
      }
      bytes = read.buffer;
    } catch (error) {
      if (error instanceof FsSafeError && error.code === "too-large") {
        throw new Error(`widget file is too large: ${logical}`, { cause: error });
      }
      throw new Error(`widget file is unsafe: ${logical}`, { cause: error });
    }
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_WIDGET_TOTAL_BYTES) {
      throw new Error("widget assets exceed the approval size limit");
    }
    files[logical] = hashBytes(bytes);
    if (logical === "widget.json") {
      manifestBytes = bytes;
    }
  }
  if (!manifestBytes || manifestBytes.byteLength > MANIFEST_MAX_BYTES) {
    throw new Error(`workspace widget not found: ${name}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestBytes.toString("utf8"));
  } catch (error) {
    throw new Error("widget.json is not valid JSON", { cause: error });
  }
  const manifest = validateWidgetManifest(parsed, name);
  if (!files[manifest.entrypoint]) {
    throw new Error(`workspace widget entrypoint is missing: ${manifest.entrypoint}`);
  }
  return { files, manifest };
}

/** True when `bytes` are exactly what was approved for `logicalPath`. */
export function matchesApprovedFile(
  approvedFiles: Record<string, string> | undefined,
  logicalPath: string,
  bytes: Buffer,
): boolean {
  const expected = approvedFiles?.[logicalPath];
  return expected !== undefined && expected === hashBytes(bytes);
}
const BINDING_ID_PATTERN = /^(?!__proto__$)[A-Za-z0-9._-]{1,64}$/;
const WIDGET_CAPABILITIES = ["data:read", "prompt:send"] as const;

type WidgetCapability = (typeof WIDGET_CAPABILITIES)[number];

type WidgetManifestBinding = { id: string; source: "static"; value: unknown };

type WidgetManifest = {
  schemaVersion: 1;
  name: string;
  title: string;
  entrypoint: string;
  bindings: WidgetManifestBinding[];
  capabilities: WidgetCapability[];
  preferredSize?: { w: number; h: number };
};

const MANIFEST_MAX_BYTES = 32 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertRecord(value: unknown, at: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${at} must be an object`);
  }
  return value;
}

function assertKnownKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  at: string,
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      throw new Error(`${at}.${key} is not allowed`);
    }
  }
}

function requireString(record: Record<string, unknown>, key: string, at: string): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new Error(`${at}.${key} must be a string`);
  }
  return value;
}

function assertIntegerRange(value: unknown, at: string, min: number, max: number): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Error(`${at} must be an integer from ${min} to ${max}`);
  }
  return value as number;
}

function validateBinding(value: unknown, at: string): WidgetManifestBinding {
  const record = assertRecord(value, at);
  const id = requireString(record, "id", at);
  if (!BINDING_ID_PATTERN.test(id)) {
    throw new Error(`${at}.id is invalid`);
  }
  const source = requireString(record, "source", at);
  if (source === "static") {
    assertKnownKeys(record, ["id", "source", "value"], at);
    return { id, source, value: record.value };
  }
  throw new Error(`${at}.source must be static`);
}

function validateCapabilities(value: unknown): WidgetCapability[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error("capabilities must be an array");
  }
  const seen = new Set<WidgetCapability>();
  for (const entry of value) {
    if (typeof entry !== "string" || !WIDGET_CAPABILITIES.includes(entry as WidgetCapability)) {
      throw new Error(`capability is invalid: ${String(entry)}`);
    }
    seen.add(entry as WidgetCapability);
  }
  return [...seen];
}

/** Validates a parsed `widget.json` object against the schema (00 §2). */
export function validateWidgetManifest(value: unknown, expectedName?: string): WidgetManifest {
  const record = assertRecord(value, "widget.json");
  assertKnownKeys(
    record,
    ["schemaVersion", "name", "title", "entrypoint", "bindings", "capabilities", "preferredSize"],
    "widget.json",
  );
  if (record.schemaVersion !== 1) {
    throw new Error("widget.json schemaVersion must be 1");
  }
  const name = requireString(record, "name", "widget.json");
  if (!CUSTOM_WIDGET_NAME_PATTERN.test(name)) {
    throw new Error("widget.json name is invalid");
  }
  if (expectedName !== undefined && name !== expectedName) {
    throw new Error("widget.json name does not match its directory");
  }
  const title = requireString(record, "title", "widget.json");
  if (title.length < 1 || title.length > 80) {
    throw new Error("widget.json title must be 1-80 characters");
  }
  const entrypoint = requireString(record, "entrypoint", "widget.json");
  // The entrypoint is a logical path served through the jail; normalize it the
  // same way the serving route does so a manifest cannot name an out-of-dir file.
  normalizeWorkspaceDataLogicalPath(entrypoint);
  const rawBindings = record.bindings;
  if (!Array.isArray(rawBindings)) {
    throw new Error("widget.json bindings must be an array");
  }
  if (rawBindings.length > 32) {
    throw new Error("widget.json bindings must contain at most 32 entries");
  }
  const bindings = rawBindings.map((binding, index) =>
    validateBinding(binding, `widget.json.bindings[${index}]`),
  );
  const ids = new Set<string>();
  for (const binding of bindings) {
    if (ids.has(binding.id)) {
      throw new Error(`widget.json duplicate binding id: ${binding.id}`);
    }
    ids.add(binding.id);
  }
  const capabilities = validateCapabilities(record.capabilities);
  const preferredSize =
    record.preferredSize === undefined
      ? undefined
      : (() => {
          const size = assertRecord(record.preferredSize, "widget.json.preferredSize");
          assertKnownKeys(size, ["w", "h"], "widget.json.preferredSize");
          return {
            w: assertIntegerRange(size.w, "widget.json.preferredSize.w", 1, 12),
            h: assertIntegerRange(size.h, "widget.json.preferredSize.h", 1, 20),
          };
        })();
  return {
    schemaVersion: 1,
    name,
    title,
    entrypoint,
    bindings,
    capabilities,
    ...(preferredSize !== undefined ? { preferredSize } : {}),
  };
}

/** Resolves the on-disk directory for one custom widget by name. */
export function resolveWidgetDir(name: string, stateDir = resolveStateDir()): string {
  if (!CUSTOM_WIDGET_NAME_PATTERN.test(name)) {
    throw new Error("widget name is invalid");
  }
  const widgetsRoot = path.resolve(stateDir, "workspaces", "widgets");
  const widgetDir = path.resolve(widgetsRoot, name);
  // Belt-and-braces: the charset check already forbids separators, but confirm
  // containment so the resolved directory can never escape the widgets root.
  if (widgetDir !== widgetsRoot && !widgetDir.startsWith(`${widgetsRoot}${path.sep}`)) {
    throw new Error("widget name is invalid");
  }
  return widgetDir;
}

/** Loads and validates the `widget.json` for a named custom widget, or null if absent. */
export async function loadWidgetManifest(
  name: string,
  options: { stateDir?: string } = {},
): Promise<WidgetManifest | null> {
  const widgetDir = resolveWidgetDir(name, options.stateDir);
  const manifestPath = path.join(widgetDir, "widget.json");
  let raw: string;
  try {
    const stat = await fs.stat(manifestPath);
    if (!stat.isFile() || stat.size > MANIFEST_MAX_BYTES) {
      return null;
    }
    raw = await fs.readFile(manifestPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error("widget.json is not valid JSON", { cause: error });
  }
  return validateWidgetManifest(parsed, name);
}
