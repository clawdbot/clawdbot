// Legacy workspace state paths remain here solely for Doctor discovery and a
// presence-only runtime upgrade gate. Runtime state never parses these files.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { formatCliCommand } from "../cli/command-format.js";
import { resolveLegacyStateDirs, resolveStateDir } from "../config/paths.js";
import { root } from "../infra/fs-safe.js";
import { pathMayExistSync } from "../infra/path-existence.js";
import { resolveUserPath } from "../utils.js";
import { resolveWorkspaceStateIdentity } from "./workspace-state-identity.js";

export const LEGACY_WORKSPACE_STATE_DIRNAME = ".openclaw";
const LEGACY_WORKSPACE_STATE_FILENAME = "workspace-state.json";
export const LEGACY_WORKSPACE_STATE_CURRENT_FILENAME = "openclaw-workspace-state.json";
export const LEGACY_WORKSPACE_ATTESTATION_DIRNAME = "workspace-attestations";
const LEGACY_WORKSPACE_ATTESTATION_SUFFIX = ".attested";
export const LEGACY_WORKSPACE_ATTESTATION_HEADER = "openclaw-workspace-attestation:v1";
export const LEGACY_WORKSPACE_ATTESTATION_MAX_BYTES = 2048;
export const WORKSPACE_DOCTOR_CLAIM_SUFFIX = ".doctor-importing";

// Legacy files are upgrade-time inputs. Cache only verified absence so every
// agent turn does not poll retired paths; Doctor/restart owns later changes.
const checkedWorkspaceSourceSets = new Set<string>();

type LegacyWorkspaceSourcePaths = {
  workspacePath: string;
  setupStatePaths: string[];
  stateDirAttestationPaths: string[];
  siblingAttestationPaths: string[];
};

type LegacyWorkspaceResetCleanup = {
  removedPaths: string[];
  warnings: string[];
};

type LegacyWorkspaceResetCandidate = {
  rootDir: string;
  sourcePath: string;
  requireAttestationHeader: boolean;
};

type LegacyWorkspaceResetPlan = {
  candidates: LegacyWorkspaceResetCandidate[];
};

function uniqueSiblingPaths(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  return paths.filter((candidate) => {
    let key = path.resolve(candidate);
    try {
      key = path.join(fs.realpathSync.native(path.dirname(candidate)), path.basename(candidate));
    } catch {
      // Missing parents stay distinct lexical migration inputs.
    }
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export function resolveLegacyWorkspaceSourcePaths(
  workspaceDir: string,
  options?: { env?: NodeJS.ProcessEnv; homedir?: () => string },
): LegacyWorkspaceSourcePaths {
  // Hashed and sibling legacy filenames used the lexical configured path.
  // Setup files live inside the workspace, so bind them to the canonical root
  // while it still exists; destructive cleanup may remove the alias first.
  const workspacePath = path.resolve(resolveUserPath(workspaceDir));
  const canonicalIdentity = resolveWorkspaceStateIdentity(workspaceDir);
  const workspaceKeys = [
    createHash("sha256").update(workspacePath).digest("hex"),
    canonicalIdentity.workspaceKey,
  ];
  const workspacePaths = [workspacePath, canonicalIdentity.workspacePath];
  const env = options?.env ?? process.env;
  const stateDirs = [
    resolveStateDir(env, options?.homedir),
    ...resolveLegacyStateDirs(options?.homedir),
  ];
  return {
    workspacePath,
    setupStatePaths: [
      path.join(canonicalIdentity.workspacePath, LEGACY_WORKSPACE_STATE_CURRENT_FILENAME),
      path.join(
        canonicalIdentity.workspacePath,
        LEGACY_WORKSPACE_STATE_DIRNAME,
        LEGACY_WORKSPACE_STATE_FILENAME,
      ),
    ],
    stateDirAttestationPaths: [...new Set(stateDirs)].flatMap((stateDir) =>
      [...new Set(workspaceKeys)].map((workspaceKey) =>
        path.join(
          stateDir,
          LEGACY_WORKSPACE_ATTESTATION_DIRNAME,
          `${workspaceKey}${LEGACY_WORKSPACE_ATTESTATION_SUFFIX}`,
        ),
      ),
    ),
    siblingAttestationPaths: uniqueSiblingPaths(
      [...new Set(workspacePaths)].map(
        (candidate) => `${candidate}${LEGACY_WORKSPACE_ATTESTATION_SUFFIX}`,
      ),
    ),
  };
}

function pathOrClaimExists(filePath: string): boolean {
  return (
    pathMayExistSync(filePath) || pathMayExistSync(`${filePath}${WORKSPACE_DOCTOR_CLAIM_SUFFIX}`)
  );
}

/** Share presence-only sibling ownership checks between runtime and Doctor. */
export function legacyWorkspaceSiblingAttestationMayExist(filePath: string): boolean {
  try {
    const before = fs.lstatSync(filePath);
    if (!before.isFile()) {
      return false;
    }
    const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
    let fd: number;
    try {
      fd = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
    } catch {
      // An unreadable regular file could be an owned marker. Doctor must surface it.
      return true;
    }
    try {
      const opened = fs.fstatSync(fd);
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
        return true;
      }
      const expected = Buffer.from(`${LEGACY_WORKSPACE_ATTESTATION_HEADER}\n`, "utf8");
      const bytes = Buffer.alloc(expected.length);
      const read = fs.readSync(fd, bytes, 0, bytes.length, 0);
      return read === expected.length && bytes.equals(expected);
    } catch {
      return true;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

function hasUnmigratedWorkspaceSources(sources: LegacyWorkspaceSourcePaths): boolean {
  return (
    sources.setupStatePaths.some(pathOrClaimExists) ||
    sources.stateDirAttestationPaths.some(pathOrClaimExists) ||
    sources.siblingAttestationPaths.some(
      (sourcePath) =>
        legacyWorkspaceSiblingAttestationMayExist(
          `${sourcePath}${WORKSPACE_DOCTOR_CLAIM_SUFFIX}`,
        ) || legacyWorkspaceSiblingAttestationMayExist(sourcePath),
    )
  );
}

function workspaceMigrationError(workspaceDirs: string[], env?: NodeJS.ProcessEnv): Error {
  // Recovery must survive bounded RPC errors even when workspace paths are long.
  return new Error(
    `Legacy workspace setup state requires migration; run ${formatCliCommand("openclaw doctor --fix", env)}. Workspaces: ${workspaceDirs.join(", ")}.`,
  );
}

/** Recheck lifecycle readiness without reusing a running turn's verified-absence cache. */
export function assertWorkspaceStateMigrationReady(params: {
  workspaceDirs: readonly string[];
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
}): void {
  const blocked = params.workspaceDirs.filter((workspaceDir) =>
    hasUnmigratedWorkspaceSources(resolveLegacyWorkspaceSourcePaths(workspaceDir, params)),
  );
  if (blocked.length > 0) {
    throw workspaceMigrationError(blocked, params.env);
  }
}

/** Fail closed on unmigrated owned state without reading it as runtime data. */
export function assertNoUnmigratedWorkspaceState(params: { workspaceDir: string }): void {
  const identity = resolveWorkspaceStateIdentity(params.workspaceDir);
  const sources = resolveLegacyWorkspaceSourcePaths(params.workspaceDir);
  const sourceSetKey = JSON.stringify([
    identity.workspaceKey,
    ...sources.setupStatePaths,
    ...sources.stateDirAttestationPaths,
    ...sources.siblingAttestationPaths,
  ]);
  if (checkedWorkspaceSourceSets.has(sourceSetKey)) {
    return;
  }
  if (hasUnmigratedWorkspaceSources(sources)) {
    throw workspaceMigrationError([identity.workspacePath]);
  }
  checkedWorkspaceSourceSets.add(sourceSetKey);
}

function resetLegacyWorkspaceStateCheckForTest(): void {
  checkedWorkspaceSourceSets.clear();
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.workspaceLegacyStateTestApi")] =
    { resetLegacyWorkspaceStateCheckForTest };
}

function isOwnedAttestationBuffer(buffer: Buffer): boolean {
  return (
    buffer.subarray(0, LEGACY_WORKSPACE_ATTESTATION_HEADER.length + 1).toString("utf8") ===
    `${LEGACY_WORKSPACE_ATTESTATION_HEADER}\n`
  );
}

/** Capture canonical legacy paths before a destructive workspace removal. */
export function prepareLegacyWorkspaceStateReset(
  workspaceDir: string,
  options?: { env?: NodeJS.ProcessEnv; homedir?: () => string },
): LegacyWorkspaceResetPlan {
  const sources = resolveLegacyWorkspaceSourcePaths(workspaceDir, options);
  const candidates = [
    ...sources.setupStatePaths.map((sourcePath) => ({
      rootDir: sourcePath.endsWith(LEGACY_WORKSPACE_STATE_CURRENT_FILENAME)
        ? path.dirname(sourcePath)
        : path.dirname(path.dirname(sourcePath)),
      sourcePath,
      requireAttestationHeader: false,
    })),
    ...sources.stateDirAttestationPaths.map((sourcePath) => ({
      rootDir: path.dirname(path.dirname(sourcePath)),
      sourcePath,
      // Hashed paths inside OpenClaw-owned attestation directories are
      // reserved state. Explicit reset must remove malformed blockers too.
      requireAttestationHeader: false,
    })),
    ...sources.siblingAttestationPaths.map((sourcePath) => ({
      rootDir: path.dirname(sourcePath),
      sourcePath,
      requireAttestationHeader: true,
    })),
  ].flatMap((candidate) => [
    candidate,
    {
      ...candidate,
      sourcePath: `${candidate.sourcePath}${WORKSPACE_DOCTOR_CLAIM_SUFFIX}`,
      // Sibling claims remain outside OpenClaw-owned roots. Renaming a claimed
      // marker preserves its header, so require that ownership proof there too.
      requireAttestationHeader: candidate.requireAttestationHeader,
    },
  ]);
  return { candidates };
}

/** Discard retired workspace files from a pre-removal reset plan. */
export async function removeLegacyWorkspaceStateForReset(
  plan: LegacyWorkspaceResetPlan,
  options?: { dryRun?: boolean },
): Promise<LegacyWorkspaceResetCleanup> {
  const removedPaths: string[] = [];
  const warnings: string[] = [];
  for (const candidate of plan.candidates) {
    const rootDir = path.resolve(candidate.rootDir);
    const sourcePath = path.resolve(candidate.sourcePath);
    const relativePath = path.relative(rootDir, sourcePath);
    try {
      fs.lstatSync(rootDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      warnings.push(`Could not inspect retired workspace state at ${sourcePath}: ${String(error)}`);
      continue;
    }
    try {
      const sourceRoot = await root(rootDir, {
        hardlinks: "reject",
        maxBytes: LEGACY_WORKSPACE_ATTESTATION_MAX_BYTES,
        symlinks: "reject",
      });
      if (!(await sourceRoot.exists(relativePath))) {
        continue;
      }
      if (candidate.requireAttestationHeader) {
        const snapshot = await sourceRoot.read(relativePath);
        if (!isOwnedAttestationBuffer(snapshot.buffer)) {
          continue;
        }
      }
      if (!options?.dryRun) {
        await sourceRoot.remove(relativePath);
      }
      removedPaths.push(sourcePath);
    } catch (error) {
      warnings.push(`Could not remove retired workspace state at ${sourcePath}: ${String(error)}`);
    }
  }
  return { removedPaths, warnings };
}
