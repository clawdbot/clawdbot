import path from "node:path";

type CodexRemoteWorkspacePathParams = {
  value: string;
  localWorkspaceRoot: string;
  remoteWorkspaceRoot?: string;
};

/** Projects a gateway workspace path into the remote Codex execution workspace. */
export function mapCodexAppServerRemoteWorkspacePath(
  params: CodexRemoteWorkspacePathParams,
): string {
  if (!params.remoteWorkspaceRoot) {
    return params.value;
  }
  const localRoot = normalizeWorkspaceMatchPath(params.localWorkspaceRoot);
  const remoteRoot = normalizeWorkspaceMatchPath(params.remoteWorkspaceRoot);
  const normalizedValue = normalizeWorkspaceMatchPath(params.value);
  if (!localRoot || !remoteRoot) {
    throw new Error("Codex remoteWorkspaceRoot requires non-empty workspace roots.");
  }
  if (normalizedValue === localRoot) {
    return remoteRoot;
  }
  const prefix = `${localRoot}/`;
  if (!normalizedValue.startsWith(prefix)) {
    throw new Error(
      `Codex remoteWorkspaceRoot is configured but cwd ${params.value} is outside OpenClaw workspace root ${params.localWorkspaceRoot}; refusing to send a gateway-local cwd to the remote Codex app-server.`,
    );
  }
  return joinRemoteWorkspacePath(remoteRoot, normalizedValue.slice(prefix.length));
}

/** Maps a remote workspace artifact back into the corresponding gateway workspace. */
export function mapCodexAppServerLocalWorkspacePath(
  params: CodexRemoteWorkspacePathParams,
): string {
  if (!params.remoteWorkspaceRoot) {
    return params.value;
  }
  const localRoot = normalizeWorkspaceMatchPath(params.localWorkspaceRoot);
  const remoteRoot = normalizeWorkspaceMatchPath(params.remoteWorkspaceRoot);
  if (!localRoot || !remoteRoot) {
    throw new Error("Codex remoteWorkspaceRoot requires non-empty workspace roots.");
  }
  const normalizedValue = normalizeWorkspaceMatchPath(params.value);
  if (!normalizedValue || isCodexPassThroughMediaSource(normalizedValue)) {
    return params.value;
  }
  const usesWindowsPaths = /^[a-z]:\//iu.test(remoteRoot) || remoteRoot.startsWith("//");
  const matchValue = usesWindowsPaths ? normalizedValue.toLowerCase() : normalizedValue;
  const matchRoot = usesWindowsPaths ? remoteRoot.toLowerCase() : remoteRoot;
  if (matchValue === matchRoot) {
    return params.localWorkspaceRoot;
  }
  const prefix = matchRoot.endsWith("/") ? matchRoot : `${matchRoot}/`;
  const isRemoteWorkspacePath = matchValue.startsWith(prefix);
  if (!isRemoteWorkspacePath && isAbsoluteWorkspacePath(normalizedValue)) {
    throw new Error(
      `Codex remote workspace artifact ${params.value} is outside ${params.remoteWorkspaceRoot}.`,
    );
  }
  const suffix = isRemoteWorkspacePath ? normalizedValue.slice(prefix.length) : normalizedValue;
  const suffixSegments = suffix.split("/");
  if (suffixSegments.some((segment) => segment === "..")) {
    throw new Error(
      `Codex remote workspace artifact ${params.value} must stay inside ${params.remoteWorkspaceRoot}.`,
    );
  }
  return path.join(
    params.localWorkspaceRoot,
    ...suffixSegments.filter((segment) => segment !== "."),
  );
}

function normalizeWorkspaceMatchPath(value: string): string {
  const normalized = value.replace(/\\/gu, "/");
  if (/^[a-z]:\/$/iu.test(normalized)) {
    return normalized;
  }
  return normalized.length > 1 ? normalized.replace(/[\\/]+$/u, "") : normalized;
}

/** Keeps remote URLs and opaque managed media references out of workspace path mapping. */
export function isCodexPassThroughMediaSource(value: string): boolean {
  return /^(?:https?|mxc|buffer|media):\/\//iu.test(value) || /^data:/iu.test(value);
}

function isAbsoluteWorkspacePath(value: string): boolean {
  return value.startsWith("/") || /^[a-z]:\//iu.test(value) || /^[a-z][a-z0-9+.-]*:/iu.test(value);
}

function joinRemoteWorkspacePath(remoteRoot: string, suffix: string): string {
  return remoteRoot.endsWith("/") ? `${remoteRoot}${suffix}` : `${remoteRoot}/${suffix}`;
}
