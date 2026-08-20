import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveOAuthDir } from "../../config/paths.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { shortenHomePath } from "../../utils.js";
import { resolveSharedAuthStorePath } from "./path-resolve.js";
import { resolveSharedMainAuthAgentDir } from "./shared-main-dir.js";
import { inspectPersistedAuthProfileStoreRaw, resolveAuthProfileDatabasePath } from "./sqlite.js";

const AUTH_PROFILE_MIGRATION_REQUIRED_CODE = "AUTH_PROFILE_MIGRATION_REQUIRED" as const;
const AUTH_PROFILE_MIGRATION_COMMAND = "openclaw doctor --fix" as const;
const log = createSubsystemLogger("auth-profiles/persistence");

type LegacyAuthProfileSourceKind = "auth-profiles" | "auth-state" | "legacy-auth" | "legacy-oauth";

type LegacyAuthProfileSource = {
  kind: LegacyAuthProfileSourceKind;
  path: string;
};

function isCredentialSource(source: LegacyAuthProfileSource): boolean {
  return source.kind !== "auth-state";
}

export function resolveLegacyOAuthPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveOAuthDir(env), "oauth.json");
}

function resolveAuthProfileOwnerPath(agentDir?: string): string {
  return agentDir ? resolveAuthProfileDatabasePath(agentDir) : resolveSharedAuthStorePath();
}

function resolveLegacySourceAgentDir(
  agentDir: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return agentDir
    ? path.dirname(resolveAuthProfileOwnerPath(agentDir))
    : resolveSharedMainAuthAgentDir(env);
}

/** Detects retired auth files by name only; runtime code must never read their contents. */
export function listLegacyAuthProfileSources(params: {
  agentDir?: string;
  env?: NodeJS.ProcessEnv;
}): LegacyAuthProfileSource[] {
  const agentDir = resolveLegacySourceAgentDir(params.agentDir, params.env);
  const candidates: LegacyAuthProfileSource[] = [
    { kind: "auth-profiles", path: path.join(agentDir, "auth-profiles.json") },
    { kind: "auth-state", path: path.join(agentDir, "auth-state.json") },
    { kind: "legacy-auth", path: path.join(agentDir, "auth.json") },
  ];
  const sharedMainDir = resolveSharedMainAuthAgentDir(params.env);
  if (path.resolve(agentDir) === path.resolve(sharedMainDir)) {
    candidates.push({ kind: "legacy-oauth", path: resolveLegacyOAuthPath(params.env) });
  }
  return candidates.filter((candidate) => fs.existsSync(candidate.path));
}

export function listLegacyAuthProfileArchives(params: {
  agentDirs: readonly string[];
  env?: NodeJS.ProcessEnv;
}): LegacyAuthProfileSource[] {
  const candidates = new Map<string, LegacyAuthProfileSourceKind>();
  for (const agentDir of params.agentDirs) {
    candidates.set(path.join(agentDir, "auth-profiles.json"), "auth-profiles");
    candidates.set(path.join(agentDir, "auth-state.json"), "auth-state");
    candidates.set(path.join(agentDir, "auth.json"), "legacy-auth");
  }
  candidates.set(resolveLegacyOAuthPath(params.env), "legacy-oauth");
  const archives: LegacyAuthProfileSource[] = [];
  for (const [sourcePath, kind] of candidates) {
    const directory = path.dirname(sourcePath);
    const baseName = path.basename(sourcePath);
    const migratedPrefix = `${baseName}.migrated-`;
    const priorImportPrefix = `${baseName}.sqlite-import.`;
    let entries: string[];
    try {
      entries = fs.readdirSync(directory);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (
        entry.startsWith(migratedPrefix) ||
        (entry.startsWith(priorImportPrefix) && entry.endsWith(".bak"))
      ) {
        archives.push({ kind, path: path.join(directory, entry) });
      }
    }
  }
  return archives;
}

export function hasLegacyAuthProfileCredentialSource(agentDir?: string): boolean {
  return listLegacyAuthProfileSources({ agentDir }).some(isCredentialSource);
}

/**
 * True when the canonical SQLite store already holds credentials for this owner.
 * A retired JSON file sitting next to a populated store is leftover bytes Doctor
 * has not archived yet, not unmigrated credentials: failing runtime closed there
 * would strand a working store over a file nothing reads.
 */
function hasMigratedAuthProfileCredentials(agentDir?: string): boolean {
  let inspection: ReturnType<typeof inspectPersistedAuthProfileStoreRaw>;
  try {
    inspection = inspectPersistedAuthProfileStoreRaw(agentDir);
  } catch {
    // An unreadable store is handled by its own canonical error; treat it as
    // "cannot serve credentials" so the legacy source stays fail-closed.
    return false;
  }
  if (inspection.status !== "readable") {
    return false;
  }
  const profiles = isRecord(inspection.raw) ? inspection.raw.profiles : undefined;
  return isRecord(profiles) && Object.keys(profiles).length > 0;
}

function listStartupLegacyAuthProfileSources(params: {
  agentDirs: readonly string[];
  env?: NodeJS.ProcessEnv;
}): Array<{
  agentDir: string;
  sources: LegacyAuthProfileSource[];
  /** Credential files that are not yet represented by the canonical store. */
  unmigratedCredentialSources: LegacyAuthProfileSource[];
}> {
  const sharedMainDir = resolveSharedMainAuthAgentDir(params.env);
  return [...new Set([...params.agentDirs, sharedMainDir])].map((agentDir) => {
    const sources = listLegacyAuthProfileSources({ agentDir, env: params.env });
    const credentialSources = sources.filter(isCredentialSource);
    return {
      agentDir,
      sources,
      unmigratedCredentialSources:
        credentialSources.length > 0 && hasMigratedAuthProfileCredentials(agentDir)
          ? []
          : credentialSources,
    };
  });
}

export function hasLegacyAuthProfileSourcesForStartup(params: {
  agentDirs: readonly string[];
  env?: NodeJS.ProcessEnv;
}): boolean {
  let detected = false;
  for (const {
    agentDir,
    sources,
    unmigratedCredentialSources,
  } of listStartupLegacyAuthProfileSources(params)) {
    detected ||= sources.length > 0;
    if (unmigratedCredentialSources.length > 0) {
      markAuthProfileMigrationRequired(
        agentDir,
        new AuthProfileMigrationRequiredError({ agentDir, sources: unmigratedCredentialSources }),
      );
    }
  }
  return detected;
}

export class AuthProfileMigrationRequiredError extends Error {
  readonly code = AUTH_PROFILE_MIGRATION_REQUIRED_CODE;
  readonly action = AUTH_PROFILE_MIGRATION_COMMAND;
  readonly ownerId: string;
  readonly sourceKinds: LegacyAuthProfileSourceKind[];

  constructor(params: { agentDir?: string; sources: readonly LegacyAuthProfileSource[] }) {
    const ownerId = shortenHomePath(resolveAuthProfileOwnerPath(params.agentDir));
    const sourceKinds = [...new Set(params.sources.map((source) => source.kind))].toSorted();
    super(
      `Auth profile store ${ownerId} requires legacy credential migration; run ${AUTH_PROFILE_MIGRATION_COMMAND}.`,
    );
    this.name = "AuthProfileMigrationRequiredError";
    this.ownerId = ownerId;
    this.sourceKinds = sourceKinds;
  }
}

export class AuthProfileStoreUnreadableError extends Error {
  readonly code = "AUTH_PROFILE_STORE_UNREADABLE" as const;
  readonly action = AUTH_PROFILE_MIGRATION_COMMAND;

  constructor(agentDir?: string) {
    super(
      `Auth profile store ${shortenHomePath(resolveAuthProfileOwnerPath(agentDir))} is unreadable; run ${AUTH_PROFILE_MIGRATION_COMMAND}.`,
    );
    this.name = "AuthProfileStoreUnreadableError";
  }
}

const migrationRequiredByDatabase = new Map<string, AuthProfileMigrationRequiredError>();
const warnedLegacySourceDatabases = new Set<string>();

export function warnLegacyAuthProfileSourcesIgnored(params: {
  agentDir?: string;
  sources: readonly LegacyAuthProfileSource[];
}): void {
  if (params.sources.length === 0) {
    return;
  }
  const databasePath = resolveAuthProfileOwnerPath(params.agentDir);
  if (warnedLegacySourceDatabases.has(databasePath)) {
    return;
  }
  warnedLegacySourceDatabases.add(databasePath);
  log.warn("retired auth profile files are ignored by runtime; run Doctor to archive them", {
    code: AUTH_PROFILE_MIGRATION_REQUIRED_CODE,
    ownerId: shortenHomePath(databasePath),
    sourceKinds: [...new Set(params.sources.map((source) => source.kind))].toSorted(),
    action: AUTH_PROFILE_MIGRATION_COMMAND,
  });
}

export function markAuthProfileMigrationRequired(
  agentDir: string | undefined,
  error: AuthProfileMigrationRequiredError,
): void {
  const databasePath = resolveAuthProfileOwnerPath(agentDir);
  migrationRequiredByDatabase.set(databasePath, error);
}

export function clearAuthProfileMigrationRequired(agentDir?: string): void {
  const databasePath = resolveAuthProfileOwnerPath(agentDir);
  migrationRequiredByDatabase.delete(databasePath);
}

export function assertAuthProfileMigrationReady(agentDir?: string): void {
  const databasePath = resolveAuthProfileOwnerPath(agentDir);
  const error = migrationRequiredByDatabase.get(databasePath);
  if (error) {
    // The activated secrets snapshot for this owner is empty. Only an explicit
    // lifecycle clear/reload may remove the error and publish migrated SQLite rows.
    throw error;
  }
  // Older shipped processes and restores can recreate these three fixed files
  // after startup, so this credential boundary deliberately rechecks their names.
  const sources = listLegacyAuthProfileSources({ agentDir }).filter(isCredentialSource);
  if (sources.length === 0) {
    return;
  }
  // The store read only happens once a retired file actually exists, so the
  // healthy majority keeps the plain name check on this hot path.
  if (hasMigratedAuthProfileCredentials(agentDir)) {
    warnLegacyAuthProfileSourcesIgnored({ agentDir, sources });
    return;
  }
  const migrationError = new AuthProfileMigrationRequiredError({ agentDir, sources });
  markAuthProfileMigrationRequired(agentDir, migrationError);
  throw migrationError;
}

export function clearAuthProfileMigrationDiagnostics(): void {
  migrationRequiredByDatabase.clear();
  warnedLegacySourceDatabases.clear();
}
