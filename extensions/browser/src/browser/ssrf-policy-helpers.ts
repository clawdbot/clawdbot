/**
 * SSRF policy helpers for Browser routes that need one-off hostname grants.
 */
import type { SsrFPolicy } from "../infra/net/ssrf.js";

/** Returns an SSRF policy restricted to one exact control-plane hostname. */
export function withExactHostnamePolicy(
  ssrfPolicy: SsrFPolicy | undefined,
  hostname: string,
): SsrFPolicy {
  const { allowedOrigins: _allowedOrigins, ...basePolicy } = ssrfPolicy ?? {};
  return {
    ...basePolicy,
    allowedHostnames: [hostname],
  };
}
