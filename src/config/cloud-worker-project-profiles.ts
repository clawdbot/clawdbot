// Normalizes repository remotes for cloud-worker project profile selection.

import { parseGitUrl } from "../agents/utils/git.js";

/** Normalize a Git origin URL to a lowercase host/path repository identity. */
export function normalizeCloudRepo(originUrl: string): string | undefined {
  const value = originUrl.trim();
  if (!value) {
    return undefined;
  }
  // The canonical parser owns remote-form handling: scp-vs-scheme detection, userinfo,
  // ports, and `.git`/traversal rules. A local regex mis-parses `ssh://git@host:22/o/r`
  // into the path and silently drops the operator's mapping.
  const source = parseGitUrl(`git:${value}`);
  if (!source) {
    return undefined;
  }
  const segments = source.path.split("/").filter(Boolean);
  if (!source.host || segments.length < 2) {
    return undefined;
  }
  // Unlike project memory scope, the whole key folds to lowercase: these are
  // operator-typed config keys selecting a machine profile, so a casing variant must
  // not silently miss its mapping. A case-only collision still selects one profile.
  return `${source.host}/${segments.join("/")}`.toLowerCase();
}
