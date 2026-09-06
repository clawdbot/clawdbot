import fs from "node:fs";
import path from "node:path";
import { resolveOAuthDir } from "../../config/paths.js";
import { resolveUserPath } from "../../utils.js";
import { resolveSharedMainAuthAgentDir } from "./shared-main-dir.js";

export type LegacyAuthProfileSourceKind =
  | "auth-profiles"
  | "auth-state"
  | "legacy-auth"
  | "legacy-oauth";

export type LegacyAuthProfileSource = {
  kind: LegacyAuthProfileSourceKind;
  path: string;
};

export function resolveLegacyOAuthPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveOAuthDir(env), "oauth.json");
}

function resolveLegacySourceAgentDir(
  agentDir: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return agentDir ? resolveUserPath(agentDir) : resolveSharedMainAuthAgentDir(env);
}

/** Capture the fixed legacy candidates before the producer's environment can change. */
export function resolveLegacyAuthProfileSourceCandidates(params: {
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
  return candidates;
}

/** Detects retired auth files by name only; runtime code must never read their contents. */
export function listLegacyAuthProfileSources(params: {
  agentDir?: string;
  env?: NodeJS.ProcessEnv;
}): LegacyAuthProfileSource[] {
  return resolveLegacyAuthProfileSourceCandidates(params).filter((candidate) =>
    fs.existsSync(candidate.path),
  );
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
