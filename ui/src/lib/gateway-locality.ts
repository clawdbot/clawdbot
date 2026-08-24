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
