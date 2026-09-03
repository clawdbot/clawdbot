export function isWildcardBindHost(rawHost: string): boolean {
  const trimmed = rawHost.trim();
  if (!trimmed) {
    return false;
  }
  const host = trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;

  // Wildcard listen hosts are valid bind addresses but are not routable callback
  // destinations. Never expose them in callback URLs derived from gateway.customBindHost.
  return host === "0.0.0.0" || host === "::" || host === "0:0:0:0:0:0:0:0" || host === "::0";
}
