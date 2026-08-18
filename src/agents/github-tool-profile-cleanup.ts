import fs from "node:fs/promises";
import path from "node:path";
import { isManagedGitHubProfileId } from "../config/github-identity-profile-id.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { hasErrnoCode } from "../infra/errno.js";
import { listAgentIds, resolveAgentConfig } from "./agent-scope.js";
import {
  resolveManagedGitHubAgentKey,
  resolveManagedGitHubProfileRoot,
} from "./github-tool-identity.js";

const MAX_CLEANUP_WARNINGS = 20;
const STAGING_PROFILE_PREFIX = ".github-profile.staging-";
const MANAGED_AGENT_KEY_PATTERN = /^[a-f0-9]{64}$/u;

type GitHubProfileCleanupResult = { removed: number; warnings: string[] };

async function cleanupProfileRoot(params: {
  root: string;
  currentProfileId?: string;
  warnings: string[];
}): Promise<number> {
  let rootStat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    rootStat = await fs.lstat(params.root);
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return 0;
    }
    throw error;
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    params.warnings.push(`refused non-directory managed GitHub profile root: ${params.root}`);
    return 0;
  }
  const root = path.resolve(params.root);
  if ((await fs.realpath(root)) !== root) {
    params.warnings.push(`refused symlinked managed GitHub profile root: ${params.root}`);
    return 0;
  }
  let removed = 0;
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name);
    const isProfile = isManagedGitHubProfileId(entry.name);
    const isStaging = entry.name.startsWith(STAGING_PROFILE_PREFIX);
    if (!isProfile && !isStaging) {
      params.warnings.push(`ignored unexpected managed GitHub profile entry: ${candidate}`);
      continue;
    }
    let stat: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      stat = await fs.lstat(candidate);
    } catch (error) {
      if (hasErrnoCode(error, "ENOENT")) {
        continue;
      }
      throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      params.warnings.push(`refused unsafe managed GitHub profile cleanup candidate: ${candidate}`);
      continue;
    }
    if (isProfile && entry.name === params.currentProfileId) {
      continue;
    }
    const resolved = await fs.realpath(candidate);
    if (path.dirname(resolved) !== root || path.basename(resolved) !== entry.name) {
      params.warnings.push(
        `refused escaped managed GitHub profile cleanup candidate: ${candidate}`,
      );
      continue;
    }
    // Gateway startup cannot overlap a valid setup transaction; staging trees here are orphans.
    await fs.rm(candidate, { recursive: true });
    removed += 1;
  }
  return removed;
}

async function validateDirectDirectory(params: {
  candidate: string;
  parent: string;
  warnings: string[];
  label: string;
}): Promise<boolean> {
  let stat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    stat = await fs.lstat(params.candidate);
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    params.warnings.push(`refused unsafe ${params.label}: ${params.candidate}`);
    return false;
  }
  const resolved = await fs.realpath(params.candidate);
  if (
    path.dirname(resolved) !== params.parent ||
    path.basename(resolved) !== path.basename(params.candidate)
  ) {
    params.warnings.push(`refused escaped ${params.label}: ${params.candidate}`);
    return false;
  }
  return true;
}

async function removeOrphanAgentRoot(params: {
  root: string;
  registryRoot: string;
  warnings: string[];
}): Promise<number> {
  if (
    !(await validateDirectDirectory({
      candidate: params.root,
      parent: params.registryRoot,
      warnings: params.warnings,
      label: "managed GitHub agent profile root",
    }))
  ) {
    return 0;
  }
  for (const entry of await fs.readdir(params.root, { withFileTypes: true })) {
    if (!isManagedGitHubProfileId(entry.name) && !entry.name.startsWith(STAGING_PROFILE_PREFIX)) {
      params.warnings.push(
        `ignored unexpected managed GitHub agent profile entry: ${path.join(params.root, entry.name)}`,
      );
      return 0;
    }
    if (
      !(await validateDirectDirectory({
        candidate: path.join(params.root, entry.name),
        parent: params.root,
        warnings: params.warnings,
        label: "managed GitHub agent profile cleanup candidate",
      }))
    ) {
      return 0;
    }
  }
  await fs.rm(params.root, { recursive: true });
  return 1;
}

async function cleanupAgentProfileRegistry(params: {
  root: string;
  currentProfiles: ReadonlyMap<string, string | undefined>;
  warnings: string[];
}): Promise<number> {
  let rootStat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    rootStat = await fs.lstat(params.root);
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return 0;
    }
    throw error;
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    params.warnings.push(`refused non-directory managed GitHub agent registry: ${params.root}`);
    return 0;
  }
  const registryRoot = path.resolve(params.root);
  if ((await fs.realpath(registryRoot)) !== registryRoot) {
    params.warnings.push(`refused symlinked managed GitHub agent registry: ${params.root}`);
    return 0;
  }
  let removed = 0;
  for (const entry of await fs.readdir(registryRoot, { withFileTypes: true })) {
    const candidate = path.join(registryRoot, entry.name);
    if (!MANAGED_AGENT_KEY_PATTERN.test(entry.name)) {
      params.warnings.push(`ignored unexpected managed GitHub agent entry: ${candidate}`);
      continue;
    }
    if (params.currentProfiles.has(entry.name)) {
      removed += await cleanupProfileRoot({
        root: candidate,
        currentProfileId: params.currentProfiles.get(entry.name),
        warnings: params.warnings,
      });
      continue;
    }
    removed += await removeOrphanAgentRoot({
      root: candidate,
      registryRoot,
      warnings: params.warnings,
    });
  }
  return removed;
}

/** Retires only generations unreferenced by the immutable startup config snapshot. */
export async function cleanupRetiredManagedGitHubProfiles(params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<GitHubProfileCleanupResult> {
  const warnings: string[] = [];
  const systemRoot = resolveManagedGitHubProfileRoot({
    agentId: "system",
    scope: "system",
    env: params.env,
  });
  let removed = await cleanupProfileRoot({
    root: systemRoot,
    currentProfileId: params.config.tools?.github?.profileId,
    warnings,
  });
  const currentProfiles = new Map(
    listAgentIds(params.config).map((agentId) => [
      resolveManagedGitHubAgentKey(agentId),
      resolveAgentConfig(params.config, agentId)?.tools?.github?.profileId,
    ]),
  );
  removed += await cleanupAgentProfileRegistry({
    root: path.join(path.dirname(systemRoot), "agents"),
    currentProfiles,
    warnings,
  });
  if (warnings.length <= MAX_CLEANUP_WARNINGS) {
    return { removed, warnings };
  }
  const omitted = warnings.length - MAX_CLEANUP_WARNINGS;
  return {
    removed,
    warnings: [
      ...warnings.slice(0, MAX_CLEANUP_WARNINGS),
      `omitted ${omitted} additional managed GitHub profile cleanup warnings`,
    ],
  };
}
