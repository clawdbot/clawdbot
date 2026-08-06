// Legacy workspace state paths remain here solely for Doctor discovery and a
// presence-only runtime upgrade gate. Runtime state never parses these files.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveLegacyStateDirs, resolveStateDir } from "../config/paths.js";
import { root } from "../infra/fs-safe.js";
import { resolveUserPath } from "../utils.js";
import { resolveWorkspaceStateIdentity } from "./workspace-state-store.js";

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
  for (const candidate of [filePath, `${filePath}${WORKSPACE_DOCTOR_CLAIM_SUFFIX}`]) {
    try {
      fs.lstatSync(candidate);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        return true;
      }
    }
  }
  return false;
}

function siblingPathIsOwnedMarker(filePath: string): boolean {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(filePath);
  } catch {
    return false;
  }
  if (!stat.isFile()) {
    return false;
  }
  try {
    const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
    const fd = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
    try {
      const buffer = Buffer.alloc(
        Math.min(stat.size, LEGACY_WORKSPACE_ATTESTATION_HEADER.length + 1),
      );
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
      return (
        buffer.subarray(0, bytesRead).toString("utf8") ===
        `${LEGACY_WORKSPACE_ATTESTATION_HEADER}\n`
      );
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // A regular file at the exact retired path is ambiguous when it cannot be
    // inspected. Doctor owns the safe decision; runtime must not assume absence.
    return true;
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
  const hasLegacy =
    sources.setupStatePaths.some(pathOrClaimExists) ||
    sources.stateDirAttestationPaths.some(pathOrClaimExists) ||
    sources.siblingAttestationPaths.some(
      (sourcePath) =>
        siblingPathIsOwnedMarker(`${sourcePath}${WORKSPACE_DOCTOR_CLAIM_SUFFIX}`) ||
        siblingPathIsOwnedMarker(sourcePath),
    );
  if (hasLegacy) {
    throw new Error(
      `Legacy workspace setup state requires migration for ${identity.workspacePath}; run openclaw doctor --fix.`,
    );
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
