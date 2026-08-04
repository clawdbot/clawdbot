// Loads global dotenv files into process environment when requested.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseDotEnv } from "dotenv";
import { parseEnvironmentFileLine } from "../daemon/systemd.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveConfigDir } from "../utils.js";
import { resolveRequiredHomeDir } from "./home-dir.js";
import { normalizeEnvVarKey } from "./host-env-security.js";
import { readRegularFileSync } from "./regular-file.js";

// Global dotenv loading imports operator-level gateway env files without
// overriding variables already present in the process environment.
const logger = createSubsystemLogger("infra:dotenv");

/** Maximum bytes to read from any dotenv file. */
const MAX_DOTENV_FILE_BYTES = 1024 * 1024;

type DotEnvEntry = {
  key: string;
  value: string;
};

type LoadedDotEnvFile = {
  filePath: string;
  entries: DotEnvEntry[];
};

type GlobalRuntimeDotEnvOptions = {
  additionalEnvPaths?: string[];
  entryFilter?: (key: string, value: string) => boolean;
  quiet?: boolean;
  stateEnvPath?: string;
};

export function readDotEnvFile(params: {
  entryFilter?: (key: string, value: string) => boolean;
  filePath: string;
  quiet?: boolean;
}): LoadedDotEnvFile | null {
  let content: Buffer;
  try {
    // Resolve symlinks so a symlinked .env file works while the bounded
    // read still rejects oversized targets.
    const resolved = fs.realpathSync(params.filePath);
    const { buffer } = readRegularFileSync({
      filePath: resolved,
      maxBytes: MAX_DOTENV_FILE_BYTES,
    });
    content = buffer;
  } catch (error) {
    if (!params.quiet) {
      const code =
        error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
      if (code !== "ENOENT") {
        logger.warn(`Failed to read ${params.filePath}: ${String(error)}`, { error });
      }
      // Surface oversized files so operators know a configured file was
      // skipped rather than leaving them silently ignored.
      if (error instanceof Error && error.message?.startsWith("File exceeds")) {
        logger.warn(
          `skipping oversized .env file (max ${MAX_DOTENV_FILE_BYTES} bytes): ${params.filePath}`,
        );
      }
    }
    return null;
  }

  const entries: DotEnvEntry[] = [];
  for (const [rawKey, value] of Object.entries(parseDotEnv(content))) {
    const key = normalizeEnvVarKey(rawKey, { portable: true });
    if (key && (params.entryFilter?.(key, value) ?? true)) {
      entries.push({ key, value });
    }
  }
  return { filePath: params.filePath, entries };
}

/**
 * Read a systemd EnvironmentFile using the canonical systemd grammar.
 *
 * Unlike dotenv files, systemd EnvironmentFiles use their own escaping rules:
 * double-quoted values unescape only \", \\, \`, and \$; single-quoted
 * values are literal except for the closing quote; backslash outside quotes
 * escapes the following character.
 */
export function readSystemdEnvironmentFile(params: {
  entryFilter?: (key: string, value: string) => boolean;
  filePath: string;
  quiet?: boolean;
}): LoadedDotEnvFile | null {
  let content: string;
  try {
    const resolved = fs.realpathSync(params.filePath);
    const { buffer } = readRegularFileSync({
      filePath: resolved,
      maxBytes: MAX_DOTENV_FILE_BYTES,
    });
    content = buffer.toString("utf8");
  } catch (error) {
    if (!params.quiet) {
      const code =
        error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
      if (code !== "ENOENT") {
        logger.warn(`Failed to read ${params.filePath}: ${String(error)}`, { error });
      }
      if (error instanceof Error && error.message?.startsWith("File exceeds")) {
        logger.warn(
          `skipping oversized systemd env file (max ${MAX_DOTENV_FILE_BYTES} bytes): ${params.filePath}`,
        );
      }
    }
    return null;
  }

  // Collect entries last-wins per key to match the service's runtime
  // semantics (environment[parsed.key] = parsed.value).  A repeated key
  // inside the same EnvironmentFile must resolve to the final assignment;
  // the cross-file merge that follows is first-wins, so per-file last-wins
  // avoids the CLI picking a stale token when the service uses a newer one.
  const entryMap = new Map<string, string>();
  for (const line of content.split(/\r?\n/)) {
    const parsed = parseEnvironmentFileLine(line);
    if (!parsed) {
      continue;
    }
    const key = normalizeEnvVarKey(parsed.key, { portable: true });
    if (key && (params.entryFilter?.(key, parsed.value) ?? true)) {
      entryMap.set(key, parsed.value);
    }
  }
  const entries: DotEnvEntry[] = [];
  for (const [key, value] of entryMap) {
    entries.push({ key, value });
  }
  return { filePath: params.filePath, entries };
}

function loadParsedDotEnvFiles(files: LoadedDotEnvFile[]): Map<string, string[]> {
  const preExistingKeys = new Set(Object.keys(process.env));
  const conflicts = new Map<string, { keptPath: string; ignoredPath: string; keys: Set<string> }>();
  const firstSeen = new Map<string, { value: string; filePath: string }>();
  const appliedKeysByFile = new Map<string, string[]>();

  for (const file of files) {
    for (const { key, value } of file.entries) {
      if (preExistingKeys.has(key)) {
        continue;
      }
      const previous = firstSeen.get(key);
      if (previous) {
        if (previous.value !== value) {
          // First file wins for deterministic startup; conflicts are logged once
          // after parsing so sensitive values are not printed.
          const conflictKey = `${previous.filePath}\u0000${file.filePath}`;
          const existing = conflicts.get(conflictKey);
          if (existing) {
            existing.keys.add(key);
          } else {
            conflicts.set(conflictKey, {
              keptPath: previous.filePath,
              ignoredPath: file.filePath,
              keys: new Set([key]),
            });
          }
        }
        continue;
      }
      firstSeen.set(key, { value, filePath: file.filePath });
      if (process.env[key] === undefined) {
        process.env[key] = value;
        const appliedKeys = appliedKeysByFile.get(file.filePath);
        if (appliedKeys) {
          appliedKeys.push(key);
        } else {
          appliedKeysByFile.set(file.filePath, [key]);
        }
      }
    }
  }

  for (const conflict of conflicts.values()) {
    const keys = [...conflict.keys].toSorted();
    if (keys.length === 0) {
      continue;
    }
    logger.warn(
      `Conflicting values in ${conflict.keptPath} and ${conflict.ignoredPath} for ${keys.join(", ")}; keeping ${conflict.keptPath}.`,
      { keptPath: conflict.keptPath, ignoredPath: conflict.ignoredPath, keys },
    );
  }
  return appliedKeysByFile;
}

/** Load global runtime dotenv files into `process.env` with first-wins precedence. */
export function loadGlobalRuntimeDotEnvFiles(opts?: GlobalRuntimeDotEnvOptions) {
  const quiet = opts?.quiet ?? true;
  const stateEnvPath = opts?.stateEnvPath ?? path.join(resolveConfigDir(process.env), ".env");
  const globalEnvPaths = [...new Set([stateEnvPath, ...(opts?.additionalEnvPaths ?? [])])];
  const defaultStateEnvPath = path.join(
    resolveRequiredHomeDir(process.env, os.homedir),
    ".openclaw",
    ".env",
  );
  const hasExplicitNonDefaultStateDir =
    process.env.OPENCLAW_STATE_DIR?.trim() !== undefined &&
    path.resolve(stateEnvPath) !== path.resolve(defaultStateEnvPath);
  const globalEnvs = globalEnvPaths.map((filePath) =>
    readDotEnvFile({ entryFilter: opts?.entryFilter, filePath, quiet }),
  );
  const parsedFiles = [...globalEnvs];
  let gatewayEnv: LoadedDotEnvFile | null = null;
  if (!hasExplicitNonDefaultStateDir) {
    gatewayEnv = readDotEnvFile({
      entryFilter: opts?.entryFilter,
      filePath: path.join(
        resolveRequiredHomeDir(process.env, os.homedir),
        ".config",
        "openclaw",
        "gateway.env",
      ),
      quiet,
    });
    parsedFiles.push(gatewayEnv);
  }

  // Also load systemd env files from the state directory so CLI commands (e.g. status)
  // can resolve env-based SecretRefs when the gateway is not reachable locally.
  // These use the canonical systemd EnvironmentFile grammar, not dotenv parsing,
  // because the service writer escapes $, \, `, and " using systemd-specific rules.
  const stateEnvDir = path.dirname(stateEnvPath);
  for (const filename of ["gateway.systemd.env", "node.systemd.env"]) {
    const systemdEnv = readSystemdEnvironmentFile({
      entryFilter: opts?.entryFilter,
      filePath: path.join(stateEnvDir, filename),
      quiet,
    });
    if (systemdEnv) {
      parsedFiles.push(systemdEnv);
    }
  }
  const parsed = parsedFiles.filter((file): file is LoadedDotEnvFile => file !== null);
  const appliedKeysByFile = loadParsedDotEnvFiles(parsed);
  return {
    stateEnvAppliedKeys: globalEnvs.flatMap((file) =>
      file ? (appliedKeysByFile.get(file.filePath) ?? []) : [],
    ),
    gatewayEnvAppliedKeys: gatewayEnv ? (appliedKeysByFile.get(gatewayEnv.filePath) ?? []) : [],
  };
}
