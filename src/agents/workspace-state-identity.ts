// Pure workspace path-identity helpers shared by the workspace state store and
// non-store readers (memory-host-sdk, onboarding). Keep this module free of
// SQLite/kysely imports: plugin doctor-contract closures reach it statically.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveUserPath } from "../utils.js";

export type WorkspaceStateIdentity = {
  workspaceKey: string;
  workspacePath: string;
};

const MAX_WORKSPACE_IDENTITY_SYMLINKS = 40;

function normalizeWorkspaceIdentityPath(value: string): string {
  const normalized = path.normalize(value).normalize("NFC");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function canonicalizeWorkspacePath(
  workspaceDir: string,
  normalizePath: (value: string) => string,
): string {
  const fallback = normalizePath(path.resolve(resolveUserPath(workspaceDir)));
  let candidate = fallback;
  const followedSymlinks = new Set<string>();

  for (let redirectCount = 0; redirectCount < MAX_WORKSPACE_IDENTITY_SYMLINKS; redirectCount += 1) {
    const missingSegments: string[] = [];
    let current = candidate;
    while (true) {
      try {
        return normalizePath(
          path.join(fs.realpathSync.native(current), ...missingSegments.toReversed()),
        );
      } catch {
        // A dangling symlink still carries the stable target identity. Resolve
        // it lexically so vanished-workspace protection cannot be bypassed.
      }
      try {
        if (fs.lstatSync(current).isSymbolicLink()) {
          const normalizedLink = normalizePath(current);
          if (followedSymlinks.has(normalizedLink)) {
            return fallback;
          }
          followedSymlinks.add(normalizedLink);
          candidate = path.resolve(
            path.dirname(current),
            fs.readlinkSync(current),
            ...missingSegments.toReversed(),
          );
          break;
        }
      } catch {
        // Keep walking to a real existing ancestor.
      }
      const parent = path.dirname(current);
      if (parent === current) {
        return fallback;
      }
      missingSegments.push(path.basename(current));
      current = parent;
    }
  }
  return fallback;
}

// Filesystem ownership preserves path bytes; NFC state keys are a separate stored
// contract and can identify distinct directories as equal on Linux.
export function resolveCanonicalWorkspacePath(workspaceDir: string): string {
  return canonicalizeWorkspacePath(workspaceDir, path.normalize);
}

export function createWorkspaceStateIdentity(workspacePath: string): WorkspaceStateIdentity {
  return {
    workspacePath,
    workspaceKey: createHash("sha256").update(workspacePath).digest("hex"),
  };
}

export function resolveWorkspaceStateAliases(workspaceDir: string): WorkspaceStateIdentity[] {
  const lexicalPath = normalizeWorkspaceIdentityPath(path.resolve(resolveUserPath(workspaceDir)));
  const canonicalPath = canonicalizeWorkspacePath(workspaceDir, normalizeWorkspaceIdentityPath);
  return [...new Set([lexicalPath, canonicalPath])].map(createWorkspaceStateIdentity);
}

export function resolveWorkspaceStateIdentity(workspaceDir: string): WorkspaceStateIdentity {
  return createWorkspaceStateIdentity(
    canonicalizeWorkspacePath(workspaceDir, normalizeWorkspaceIdentityPath),
  );
}

const WORKSPACE_ALIAS_REPOINTED_ERROR_CODE = "WORKSPACE_ALIAS_REPOINTED";

export class WorkspaceAliasRepointedError extends Error {
  readonly code = WORKSPACE_ALIAS_REPOINTED_ERROR_CODE;
  readonly aliasPath: string;
  readonly storedWorkspacePath: string;
  readonly currentWorkspacePath: string;

  constructor(params: {
    aliasPath: string;
    storedWorkspacePath: string;
    currentWorkspacePath: string;
  }) {
    super(
      `workspace path alias points to a different current target: ${params.aliasPath} now resolves to ${params.currentWorkspacePath}, but its stored workspace state belongs to ${params.storedWorkspacePath}. ` +
        "Run `openclaw doctor` and confirm the rebind, or use `openclaw doctor --fix --force`.",
    );
    this.name = "WorkspaceAliasRepointedError";
    this.aliasPath = params.aliasPath;
    this.storedWorkspacePath = params.storedWorkspacePath;
    this.currentWorkspacePath = params.currentWorkspacePath;
  }
}

export const WORKSPACE_VANISHED_ERROR_CODE = "WORKSPACE_VANISHED";

export class WorkspaceVanishedError extends Error {
  readonly code = WORKSPACE_VANISHED_ERROR_CODE;
  readonly workspaceDir: string;

  constructor(params: { workspaceDir: string }) {
    super(
      `OpenClaw workspace appears to have disappeared after a recent initialization: ${params.workspaceDir}. ` +
        `Refusing to reseed BOOTSTRAP.md over a recently attested workspace. ` +
        "Restore the workspace or run a full OpenClaw reset if this reset was intentional.",
    );
    this.name = "WorkspaceVanishedError";
    this.workspaceDir = params.workspaceDir;
  }
}
