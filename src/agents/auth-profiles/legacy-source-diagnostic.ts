import { createSubsystemLogger } from "../../logging/subsystem.js";
import { shortenHomePath } from "../../utils.js";
import {
  listLegacyAuthProfileSources,
  type LegacyAuthProfileSource,
  type LegacyAuthProfileSourceKind,
} from "./legacy-source-files.js";
import { resolveSharedAuthStorePath } from "./path-resolve.js";
import { resolveSharedMainAuthAgentDir } from "./shared-main-dir.js";
import { resolveAuthProfileDatabasePath } from "./sqlite.js";

export {
  listLegacyAuthProfileArchives,
  listLegacyAuthProfileSources,
  resolveLegacyOAuthPath,
} from "./legacy-source-files.js";

const AUTH_PROFILE_MIGRATION_REQUIRED_CODE = "AUTH_PROFILE_MIGRATION_REQUIRED" as const;
export const AUTH_PROFILE_MIGRATION_COMMAND = "openclaw doctor --fix" as const;
const log = createSubsystemLogger("auth-profiles/persistence");

function isCredentialSource(source: LegacyAuthProfileSource): boolean {
  return source.kind !== "auth-state";
}

function resolveAuthProfileOwnerPath(agentDir?: string): string {
  return agentDir ? resolveAuthProfileDatabasePath(agentDir) : resolveSharedAuthStorePath();
}

export function hasLegacyAuthProfileCredentialSource(agentDir?: string): boolean {
  return listLegacyAuthProfileSources({ agentDir }).some(isCredentialSource);
}

function listStartupLegacyAuthProfileSources(params: {
  agentDirs: readonly string[];
  env?: NodeJS.ProcessEnv;
}): Array<{
  agentDir: string;
  sources: LegacyAuthProfileSource[];
  credentialSources: LegacyAuthProfileSource[];
}> {
  const sharedMainDir = resolveSharedMainAuthAgentDir(params.env);
  return [...new Set([...params.agentDirs, sharedMainDir])].map((agentDir) => {
    const sources = listLegacyAuthProfileSources({ agentDir, env: params.env });
    return { agentDir, sources, credentialSources: sources.filter(isCredentialSource) };
  });
}

export function hasLegacyAuthProfileSourcesForStartup(params: {
  agentDirs: readonly string[];
  env?: NodeJS.ProcessEnv;
}): boolean {
  let detected = false;
  for (const { agentDir, sources, credentialSources } of listStartupLegacyAuthProfileSources(
    params,
  )) {
    detected ||= sources.length > 0;
    if (credentialSources.length > 0) {
      markAuthProfileMigrationRequired(
        agentDir,
        new AuthProfileMigrationRequiredError({ agentDir, sources: credentialSources }),
      );
    }
  }
  return detected;
}

/** Agent auth stores whose retired credential files make gateway startup fail until Doctor migrates them. */
export function listAuthProfileStoresRequiringMigration(params: {
  agentDirs: readonly string[];
  env?: NodeJS.ProcessEnv;
}): string[] {
  const owners = listStartupLegacyAuthProfileSources(params)
    .filter(({ credentialSources }) => credentialSources.length > 0)
    .map(({ agentDir }) => shortenHomePath(resolveAuthProfileDatabasePath(agentDir)));
  return [...new Set(owners)].toSorted();
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
  if (sources.length > 0) {
    const migrationError = new AuthProfileMigrationRequiredError({ agentDir, sources });
    markAuthProfileMigrationRequired(agentDir, migrationError);
    throw migrationError;
  }
}

export function clearAuthProfileMigrationDiagnostics(): void {
  migrationRequiredByDatabase.clear();
  warnedLegacySourceDatabases.clear();
}
