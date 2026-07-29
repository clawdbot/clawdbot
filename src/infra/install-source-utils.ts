// Resolves and packages install sources for plugin installs.
import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import {
  gt as gtSemver,
  satisfies as satisfiesSemver,
  validRange as validSemverRange,
} from "semver";
import { runCommandWithTimeout } from "../process/exec.js";
import { resolveUserPath } from "../utils.js";
import { resolveArchiveKind } from "./archive.js";
import { pathExists } from "./fs-safe.js";
import { applyNpmFreshnessBypassEnv, type NpmProjectInstallEnvOptions } from "./npm-install-env.js";
import { resolveNpmJsonEntries } from "./npm-registry-spec.js";
import { withTempWorkspace } from "./private-temp-workspace.js";
import { resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir.js";

/** Metadata npm reports when resolving a registry spec or packed archive. */
export type NpmSpecResolution = {
  name?: string;
  version?: string;
  resolvedSpec?: string;
  integrity?: string;
  shasum?: string;
  resolvedAt?: string;
  packageOpenClaw?: Record<string, unknown>;
};

/** Flattened npm resolution fields stored on install results and diagnostics. */
type NpmResolutionFields = {
  resolvedName?: string;
  resolvedVersion?: string;
  resolvedSpec?: string;
  integrity?: string;
  shasum?: string;
  resolvedAt?: string;
};

/** Converts npm resolution metadata into stable result field names. */
export function buildNpmResolutionFields(resolution?: NpmSpecResolution): NpmResolutionFields {
  return {
    resolvedName: resolution?.name,
    resolvedVersion: resolution?.version,
    resolvedSpec: resolution?.resolvedSpec,
    integrity: resolution?.integrity,
    shasum: resolution?.shasum,
    resolvedAt: resolution?.resolvedAt,
  };
}

/** Creates a script-free npm environment for metadata and pack commands. */
export function createNpmMetadataEnv(
  scope: Pick<NpmProjectInstallEnvOptions, "npmConfigCwd"> = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
    NPM_CONFIG_IGNORE_SCRIPTS: "true",
  };
  applyNpmFreshnessBypassEnv(env, new Date(), scope);
  return env;
}

function resolveNpmSpecVersionSelector(spec: string): string | undefined {
  const separator = spec.lastIndexOf("@");
  return separator > 0 ? normalizeOptionalString(spec.slice(separator + 1)) : undefined;
}

function selectNpmViewMetadataEntry(value: unknown, spec: string): unknown {
  if (!Array.isArray(value)) {
    return value;
  }
  const entries = value.filter((entry) => isRecord(entry) && !Array.isArray(entry));
  const selector = resolveNpmSpecVersionSelector(spec);
  const range = selector ? validSemverRange(selector) : null;
  if (range) {
    // npm view output order tracks publication, not SemVer (a backport can be
    // published after a higher release), so pick the max satisfying version.
    let best: { entry: unknown; version: string } | undefined;
    for (const entry of entries) {
      const version = normalizeOptionalString(entry.version);
      if (!version || !satisfiesSemver(version, range)) {
        continue;
      }
      if (!best || gtSemver(version, best.version)) {
        best = { entry, version };
      }
    }
    // A recognized range with no satisfying entry must fail the metadata read
    // rather than silently resolve outside the requested constraint.
    return best?.entry;
  }
  return entries.at(-1);
}

function normalizeNpmViewMetadata(value: unknown, spec: string): NpmSpecResolution | null {
  // npm output varies by version, selector, and field projection. npm orders
  // view arrays ascending, so non-semver selectors intentionally use the last entry.
  const entry = selectNpmViewMetadataEntry(value, spec);
  if (!isRecord(entry) || Array.isArray(entry)) {
    return null;
  }
  const rec = entry;
  const name = normalizeOptionalString(rec.name);
  const version = normalizeOptionalString(rec.version);
  const resolvedSpec = name && version ? `${name}@${version}` : undefined;
  const dist =
    rec.dist && typeof rec.dist === "object" ? (rec.dist as Record<string, unknown>) : {};
  return {
    name,
    version,
    resolvedSpec,
    integrity:
      normalizeOptionalString(rec["dist.integrity"]) ?? normalizeOptionalString(dist.integrity),
    shasum: normalizeOptionalString(rec["dist.shasum"]) ?? normalizeOptionalString(dist.shasum),
    ...(isRecord(rec.openclaw) ? { packageOpenClaw: rec.openclaw } : {}),
  };
}

/** Reads npm registry metadata for a package spec without running package scripts. */
type NpmMetadataFailureCategory = "metadata-env";

export async function resolveNpmSpecMetadata(params: { spec: string; timeoutMs?: number }): Promise<
  | {
      ok: true;
      metadata: NpmSpecResolution;
    }
  | {
      ok: false;
      error: string;
      category?: NpmMetadataFailureCategory;
    }
> {
  const res = await runCommandWithTimeout(
    [
      "npm",
      "view",
      params.spec,
      "name",
      "version",
      "dist.integrity",
      "dist.shasum",
      "openclaw",
      "--json",
    ],
    {
      timeoutMs: Math.max(params.timeoutMs ?? 60_000, 60_000),
      env: createNpmMetadataEnv(),
    },
  );
  if (res.code !== 0) {
    const raw = res.stderr.trim() || res.stdout.trim();
    if (/E404|is not in this registry/i.test(raw)) {
      return {
        ok: false,
        error: `Package not found on npm: ${params.spec}. See https://docs.openclaw.ai/tools/plugin for installable plugins.`,
      };
    }
    return { ok: false, error: `npm view failed: ${raw}`, category: "metadata-env" };
  }

  try {
    const parsed = JSON.parse(res.stdout.trim()) as unknown;
    const metadata = normalizeNpmViewMetadata(parsed, params.spec);
    if (!metadata?.name || !metadata.version) {
      const missingFields = [!metadata?.name ? "name" : null, !metadata?.version ? "version" : null]
        .filter((field): field is string => field !== null)
        .join(", ");
      return {
        ok: false,
        error: `npm view produced incomplete package metadata (missing: ${missingFields})`,
        category: "metadata-env",
      };
    }
    return { ok: true, metadata };
  } catch (err) {
    return {
      ok: false,
      error: `npm view produced invalid JSON: ${String(err)}`,
      category: "metadata-env",
    };
  }
}

/** Captures expected and actual npm integrity values when an install source drifts. */
export type NpmIntegrityDrift = {
  expectedIntegrity: string;
  actualIntegrity: string;
};

/** Runs a callback in a private temp directory and removes it afterward. */
export async function withTempDir<T>(
  prefix: string,
  fn: (tmpDir: string) => Promise<T>,
  options?: { rootDir?: string },
): Promise<T> {
  const rootDir = options?.rootDir ?? resolvePreferredOpenClawTmpDir();
  return await withTempWorkspace({ rootDir, prefix }, async (tmp) => fn(tmp.dir));
}

/** Resolves and validates a user-supplied archive path before extraction. */
export async function resolveArchiveSourcePath(archivePath: string): Promise<
  | {
      ok: true;
      path: string;
    }
  | {
      ok: false;
      error: string;
    }
> {
  const resolved = resolveUserPath(archivePath);
  if (!(await pathExists(resolved))) {
    return { ok: false, error: `archive not found: ${resolved}` };
  }

  if (!resolveArchiveKind(resolved)) {
    return { ok: false, error: `unsupported archive: ${resolved}` };
  }

  return { ok: true, path: resolved };
}

function parseResolvedSpecFromId(id: string): string | undefined {
  const at = id.lastIndexOf("@");
  if (at <= 0 || at >= id.length - 1) {
    return undefined;
  }
  const name = id.slice(0, at).trim();
  const version = id.slice(at + 1).trim();
  if (!name || !version) {
    return undefined;
  }
  return `${name}@${version}`;
}

function normalizeNpmPackEntry(
  entry: unknown,
): { filename?: string; metadata: NpmSpecResolution } | null {
  if (!entry || typeof entry !== "object") {
    return null;
  }
  const rec = entry as Record<string, unknown>;
  const name = normalizeOptionalString(rec.name);
  const version = normalizeOptionalString(rec.version);
  const id = normalizeOptionalString(rec.id);
  const resolvedSpec =
    (name && version ? `${name}@${version}` : undefined) ??
    (id ? parseResolvedSpecFromId(id) : undefined);

  return {
    filename: normalizeOptionalString(rec.filename),
    metadata: {
      name,
      version,
      resolvedSpec,
      integrity: normalizeOptionalString(rec.integrity),
      shasum: normalizeOptionalString(rec.shasum),
    },
  };
}

function parseNpmPackJsonOutput(
  raw: string,
): { filename?: string; metadata: NpmSpecResolution } | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  const candidates = [trimmed];
  const arrayStart = trimmed.indexOf("[");
  if (arrayStart > 0) {
    candidates.push(trimmed.slice(arrayStart));
  }

  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }

    const entries = resolveNpmJsonEntries(parsed);
    let fallback: { filename?: string; metadata: NpmSpecResolution } | null = null;
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const normalized = normalizeNpmPackEntry(entries[i]);
      if (!normalized) {
        continue;
      }
      if (!fallback) {
        fallback = normalized;
      }
      if (normalized.filename) {
        return normalized;
      }
    }
    if (fallback) {
      return fallback;
    }
  }

  return null;
}

function parsePackedArchiveFromStdout(stdout: string): string | undefined {
  const lines = normalizeStringEntries(stdout.split(/\r?\n/));

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    const match = line?.match(/([^\s"']+\.tgz)/);
    if (match?.[1]) {
      return match[1];
    }
  }
  return undefined;
}

async function findPackedArchiveInDir(cwd: string): Promise<string | undefined> {
  const entries = await fs.readdir(cwd, { withFileTypes: true }).catch(() => []);
  const archives = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".tgz"));
  if (archives.length === 0) {
    return undefined;
  }
  if (archives.length === 1) {
    return archives[0]?.name;
  }

  const sortedByMtime = await Promise.all(
    archives.map(async (entry) => ({
      name: entry.name,
      mtimeMs: (await fs.stat(path.join(cwd, entry.name))).mtimeMs,
    })),
  );
  sortedByMtime.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return sortedByMtime[0]?.name;
}

/** Packs an npm spec into a tarball in `cwd` and returns archive metadata. */
export async function packNpmSpecToArchive(params: {
  spec: string;
  timeoutMs: number;
  cwd: string;
}): Promise<
  | {
      ok: true;
      archivePath: string;
      metadata: NpmSpecResolution;
    }
  | {
      ok: false;
      error: string;
    }
> {
  const res = await runCommandWithTimeout(
    ["npm", "pack", params.spec, "--ignore-scripts", "--json"],
    {
      timeoutMs: Math.max(params.timeoutMs, 300_000),
      cwd: params.cwd,
      env: createNpmMetadataEnv({ npmConfigCwd: params.cwd }),
    },
  );
  if (res.code !== 0) {
    const raw = res.stderr.trim() || res.stdout.trim();
    if (/E404|is not in this registry/i.test(raw)) {
      return {
        ok: false,
        error: `Package not found on npm: ${params.spec}. See https://docs.openclaw.ai/tools/plugin for installable plugins.`,
      };
    }
    return { ok: false, error: `npm pack failed: ${raw}` };
  }

  const parsedJson = parseNpmPackJsonOutput(res.stdout || "");

  let packed = parsedJson?.filename ?? parsePackedArchiveFromStdout(res.stdout || "");
  if (!packed) {
    packed = await findPackedArchiveInDir(params.cwd);
  }
  if (!packed) {
    return { ok: false, error: "npm pack produced no archive" };
  }

  let archivePath = path.isAbsolute(packed) ? packed : path.join(params.cwd, packed);
  if (!(await pathExists(archivePath))) {
    const fallbackPacked = await findPackedArchiveInDir(params.cwd);
    if (!fallbackPacked) {
      return { ok: false, error: "npm pack produced no archive" };
    }
    archivePath = path.join(params.cwd, fallbackPacked);
  }

  return {
    ok: true,
    archivePath,
    metadata: parsedJson?.metadata ?? {},
  };
}

/**
 * Reads package metadata from an existing npm archive using `npm pack --dry-run`.
 * The archive path is validated first so callers get path errors before npm errors.
 */
export async function resolveNpmPackArchiveMetadata(params: {
  archivePath: string;
  timeoutMs?: number;
}): Promise<
  | {
      ok: true;
      archivePath: string;
      tarballName: string;
      metadata: NpmSpecResolution;
    }
  | {
      ok: false;
      error: string;
    }
> {
  const archivePathResult = await resolveArchiveSourcePath(params.archivePath);
  if (!archivePathResult.ok) {
    return archivePathResult;
  }
  const archivePath = archivePathResult.path;
  const archiveStat = await fs.stat(archivePath).catch(() => null);
  const archiveMetadataTimeoutMs =
    archiveStat && archiveStat.size > 100 * 1024 * 1024 ? 300_000 : 60_000;
  const res = await runCommandWithTimeout(
    ["npm", "pack", archivePath, "--ignore-scripts", "--dry-run", "--json"],
    {
      timeoutMs: Math.max(params.timeoutMs ?? archiveMetadataTimeoutMs, archiveMetadataTimeoutMs),
      env: createNpmMetadataEnv(),
    },
  );
  if (res.code !== 0) {
    return {
      ok: false,
      error: `npm pack metadata read failed: ${res.stderr.trim() || res.stdout.trim()}`,
    };
  }

  const parsedJson = parseNpmPackJsonOutput(res.stdout || "");
  if (!parsedJson?.metadata.name || !parsedJson.metadata.version) {
    return { ok: false, error: "npm pack metadata read produced incomplete package metadata" };
  }
  return {
    ok: true,
    archivePath,
    tarballName: parsedJson.filename ?? path.basename(archivePath),
    metadata: parsedJson.metadata,
  };
}
