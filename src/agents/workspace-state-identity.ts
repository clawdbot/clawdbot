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

function canonicalizeWorkspaceIdentityPath(workspaceDir: string): string {
  const fallback = normalizeWorkspaceIdentityPath(path.resolve(resolveUserPath(workspaceDir)));
  let candidate = fallback;
  const followedSymlinks = new Set<string>();

  for (let redirectCount = 0; redirectCount < MAX_WORKSPACE_IDENTITY_SYMLINKS; redirectCount += 1) {
    const missingSegments: string[] = [];
    let current = candidate;
    while (true) {
      try {
        return normalizeWorkspaceIdentityPath(
          path.join(fs.realpathSync.native(current), ...missingSegments.toReversed()),
        );
      } catch {
        // A dangling symlink still carries the stable target identity. Resolve
        // it lexically so vanished-workspace protection cannot be bypassed.
      }
      try {
        if (fs.lstatSync(current).isSymbolicLink()) {
          const normalizedLink = normalizeWorkspaceIdentityPath(current);
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

export function createWorkspaceStateIdentity(workspacePath: string): WorkspaceStateIdentity {
  return {
    workspacePath,
    workspaceKey: createHash("sha256").update(workspacePath).digest("hex"),
  };
}

export function resolveWorkspaceStateAliases(workspaceDir: string): WorkspaceStateIdentity[] {
  const lexicalPath = normalizeWorkspaceIdentityPath(path.resolve(resolveUserPath(workspaceDir)));
  const canonicalPath = canonicalizeWorkspaceIdentityPath(workspaceDir);
  return [...new Set([lexicalPath, canonicalPath])].map(createWorkspaceStateIdentity);
}

export function resolveWorkspaceStateIdentity(workspaceDir: string): WorkspaceStateIdentity {
  return createWorkspaceStateIdentity(canonicalizeWorkspaceIdentityPath(workspaceDir));
}
