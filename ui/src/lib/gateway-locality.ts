export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.trim().toLowerCase();
  return (
    host === "localhost" ||
    host === "::1" ||
    host === "[::1]" ||
    (/^127(?:\.\d{1,3}){3}$/.test(host) && host.split(".").every((octet) => Number(octet) <= 255))
  );
}

export function isLoopbackGatewayUrl(gatewayUrl: string | null | undefined): boolean {
  try {
    // The UI origin can differ; rejecting LAN aliases avoids a false-local editor handoff.
    return Boolean(
      gatewayUrl && isLoopbackHostname(new URL(gatewayUrl, window.location.href).hostname),
    );
  } catch {
    return false;
  }
}

/**
 * Absolute path only when an editor on this machine could actually open it.
 * Null for a remote gateway or exec node even though the path itself is known,
 * so callers must not reuse this for display or copy affordances. Lives here
 * rather than beside either caller: the file view and the diff panel both need
 * it, and importing across those two modules closes a dependency cycle.
 */
export function localEditorFilePath(
  content: { path: string; root?: string | null },
  gatewayUrl: string | null | undefined,
  execNode: string | null | undefined,
): string | null {
  if (execNode || !isLoopbackGatewayUrl(gatewayUrl)) {
    return null;
  }
  if (/^(?:\/|[a-z]:[\\/]|\\\\)/i.test(content.path)) {
    return content.path;
  }
  return content.root
    ? `${content.root.replace(/[\\/]+$/, "")}/${content.path.replace(/^[\\/]+/, "")}`
    : null;
}
