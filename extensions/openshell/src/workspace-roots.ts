// OpenShell plugin module owns remote workspace-root precedence.
import path from "node:path";

export type OpenShellWorkspaceRoot<T = unknown> = {
  remote: string;
  owner: "workspace" | "agent";
  value: T;
};

function remotePathDepth(remote: string): number {
  return remote.split("/").filter(Boolean).length;
}

function workspaceRootOwnerOrder(owner: OpenShellWorkspaceRoot["owner"]): number {
  return owner === "workspace" ? 0 : 1;
}

export function isOpenShellRemotePathInside(root: string, candidate: string): boolean {
  const relative = path.posix.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith("../") && !path.posix.isAbsolute(relative))
  );
}

export function orderOpenShellWorkspaceRoots<T>(
  roots: readonly OpenShellWorkspaceRoot<T>[],
): OpenShellWorkspaceRoot<T>[] {
  // Outer roots publish first so a nested root can replace its full subtree.
  // Equal roots preserve the historical agent-root-last precedence.
  return roots.toSorted(
    (a, b) =>
      remotePathDepth(a.remote) - remotePathDepth(b.remote) ||
      workspaceRootOwnerOrder(a.owner) - workspaceRootOwnerOrder(b.owner),
  );
}

export function resolveOpenShellWorkspaceRoot<T>(
  roots: readonly OpenShellWorkspaceRoot<T>[],
  candidate: string,
): OpenShellWorkspaceRoot<T> | undefined {
  // The most-specific root owns nested paths. Exact ties retain the primary
  // workspace mapping used before agent roots became independently writable.
  return roots
    .toSorted(
      (a, b) =>
        remotePathDepth(b.remote) - remotePathDepth(a.remote) ||
        workspaceRootOwnerOrder(a.owner) - workspaceRootOwnerOrder(b.owner),
    )
    .find((root) => isOpenShellRemotePathInside(root.remote, candidate));
}
