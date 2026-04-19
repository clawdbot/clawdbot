import type { SsrFPolicy } from "../infra/net/ssrf.js";

export function withAllowedHostname(
  ssrfPolicy: SsrFPolicy | undefined,
  hostname: string,
): SsrFPolicy {
  return {
    ...ssrfPolicy,
    allowedHostnames: Array.from(new Set([...(ssrfPolicy?.allowedHostnames ?? []), hostname])),
  };
}
