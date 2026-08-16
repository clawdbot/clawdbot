/** Canonical path resolution for remote shell-backed sandbox mounts. */
import path from "node:path";
import type {
  SandboxBackendCommandParams,
  SandboxBackendCommandResult,
} from "./backend-handle.types.js";
import { relativePathEscapesContainerRoot } from "./path-utils.js";
import { normalizeContainerPath } from "./remote-fs-bridge-paths.js";

export type RemoteCanonicalPath = {
  canonicalPath: string;
  canonicalMountRoot: string;
  logicalPath: string;
};

export async function resolveRemoteCanonicalPath(params: {
  containerPath: string;
  mountRootPath: string;
  action: string;
  allowFinalSymlinkForUnlink?: boolean;
  signal?: AbortSignal;
  runRemoteShellScript(command: SandboxBackendCommandParams): Promise<SandboxBackendCommandResult>;
}): Promise<RemoteCanonicalPath> {
  // Canonicalize the nearest existing ancestor and append the missing suffix.
  // This lets create/write operations validate paths that do not exist yet.
  const script = [
    "set -eu",
    'target="$1"',
    'allow_final="$2"',
    'suffix=""',
    'probe="$target"',
    'if [ "$allow_final" = "1" ] && [ -L "$target" ]; then probe=$(dirname -- "$target"); fi',
    'cursor="$probe"',
    'while [ ! -e "$cursor" ] && [ ! -L "$cursor" ]; do',
    '  parent=$(dirname -- "$cursor")',
    '  if [ "$parent" = "$cursor" ]; then break; fi',
    '  base=$(basename -- "$cursor")',
    '  suffix="/$base$suffix"',
    '  cursor="$parent"',
    "done",
    'canonical=$(readlink -f -- "$cursor")',
    'canonical_root=$(readlink -f -- "$3")',
    'printf "%s%s\\n%s\\n" "$canonical" "$suffix" "$canonical_root"',
  ].join("\n");
  const result = await params.runRemoteShellScript({
    script,
    args: [
      params.containerPath,
      params.allowFinalSymlinkForUnlink ? "1" : "0",
      params.mountRootPath,
    ],
    signal: params.signal,
  });
  const [canonicalRaw = "", canonicalRootRaw = ""] = result.stdout
    .toString("utf8")
    .trim()
    .split("\n");
  if (!canonicalRaw || !canonicalRootRaw) {
    throw new Error(
      `Sandbox path canonicalization failed; cannot ${params.action}: ${params.containerPath}`,
    );
  }
  const canonicalPath = normalizeContainerPath(canonicalRaw);
  const canonicalMountRoot = normalizeContainerPath(canonicalRootRaw);
  const relative = path.posix.relative(canonicalMountRoot, canonicalPath);
  if (relativePathEscapesContainerRoot(relative)) {
    throw new Error(
      `Sandbox path escapes allowed mounts; cannot ${params.action}: ${params.containerPath}`,
    );
  }
  return {
    canonicalPath,
    canonicalMountRoot,
    logicalPath:
      relative === "."
        ? params.mountRootPath
        : normalizeContainerPath(path.posix.join(params.mountRootPath, relative)),
  };
}
